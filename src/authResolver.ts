import * as fs from 'fs';
import * as net from 'net';
import { SocksClient, SocksClientOptions } from 'socks';
import * as vscode from 'vscode';
import * as ssh2 from 'ssh2';
import type { ParsedKey } from 'ssh2-streams';
import { Log } from './common/logger';
import SSHDestination from './ssh/sshDestination';
import { SSHTunnelConfig } from './ssh/sshConnection';
import SSHConfiguration from './ssh/sshConfig';
import { SSHKey } from './ssh/identityFiles';
import { untildify, exists as fileExists } from './common/files';
import { findRandomPort } from './common/ports';
import { disposeAll } from './common/disposable';
import { installCodeServer, ServerInstallError, findServerInstallPath } from './serverSetup';
import { isWindows } from './common/platform';
import * as os from 'os';
import { ServerVersion } from './serverConfig';
import type { ConnectionLease, ConnectionProvider } from './ssh/connectionLease';
import { DirectConnectionProvider } from './ssh/directConnectionProvider';

const PASSWORD_RETRY_COUNT = 3;
const PASSPHRASE_RETRY_COUNT = 3;

export const REMOTE_SSH_AUTHORITY = 'ssh-remote';

export function getRemoteAuthority(host: string) {
    return `${REMOTE_SSH_AUTHORITY}+${host}`;
}

class TunnelInfo implements vscode.Disposable {
    constructor(
        readonly localPort: number,
        readonly remotePortOrSocketPath: number | string,
        private disposables: vscode.Disposable[]
    ) {
    }

    dispose() {
        disposeAll(this.disposables);
    }
}

export class RemoteSSHResolver implements vscode.RemoteAuthorityResolver, vscode.Disposable {

    private lease: ConnectionLease | undefined;
    private sshAgentSock: string | undefined;
    private agentForwardSession: ssh2.ClientChannel | undefined;

    private socksTunnel: SSHTunnelConfig | undefined;
    private tunnels: TunnelInfo[] = [];

    private labelFormatterDisposable: vscode.Disposable | undefined;

    constructor(
        readonly context: vscode.ExtensionContext,
        readonly logger: Log,
        private readonly connectionProvider: ConnectionProvider = new DirectConnectionProvider(),
    ) {
    }

    resolve(authority: string, context: vscode.RemoteAuthorityResolverContext): Thenable<vscode.ResolverResult> {
        const [type, dest] = authority.split('+');
        if (type !== REMOTE_SSH_AUTHORITY) {
            throw new Error(`Invalid authority type for SSH resolver: ${type}`);
        }

        this.logger.info(`Resolving ssh remote authority '${authority}' (attempt #${context.resolveAttempt})`);

        const sshDest = SSHDestination.parseEncoded(dest);

        // It looks like default values are not loaded yet when resolving a remote,
        // so let's hardcode the default values here
        const remoteSSHconfig = vscode.workspace.getConfiguration('remote.SSH');
        const enableDynamicForwarding = remoteSSHconfig.get<boolean>('enableDynamicForwarding', true)!;
        const enableAgentForwarding = remoteSSHconfig.get<boolean>('enableAgentForwarding', true)!;
        const serverDownloadUrlTemplate = remoteSSHconfig.get<string>('serverDownloadUrlTemplate');
        const serverVersion = remoteSSHconfig.get<ServerVersion>('serverVersion', 'match');
        const defaultExtensions = remoteSSHconfig.get<string[]>('defaultExtensions', []);
        const remotePlatformMap = remoteSSHconfig.get<Record<string, string>>('remotePlatform', {});
        const remoteServerListenOnSocket = remoteSSHconfig.get<boolean>('remoteServerListenOnSocket', false)!;
        const connectTimeout = remoteSSHconfig.get<number>('connectTimeout', 60)!;
        const serverInstallPathMap = remoteSSHconfig.get<Record<string, string>>('serverInstallPath', {});

        return vscode.window.withProgress({
            title: `Setting up SSH Host ${sshDest.hostname}`,
            location: vscode.ProgressLocation.Notification,
            cancellable: false
        }, async () => {
            try {
                const sshconfig = await SSHConfiguration.loadFromFS();
                const sshHostConfig = sshconfig.getHostConfiguration(sshDest.hostname);
                const sshHostName = sshHostConfig['HostName'] ? sshHostConfig['HostName'].replace('%h', sshDest.hostname) : sshDest.hostname;
                const sshUser = sshHostConfig['User'] || sshDest.user || os.userInfo().username || ''; // https://github.com/openssh/openssh-portable/blob/5ec5504f1d328d5bfa64280cd617c3efec4f78f3/sshconnect.c#L1561-L1562
                const sshPort = sshHostConfig['Port'] ? parseInt(sshHostConfig['Port'], 10) : (sshDest.port || 22);

                this.sshAgentSock = sshHostConfig['IdentityAgent'] || process.env['SSH_AUTH_SOCK'] || (isWindows ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
                this.sshAgentSock = this.sshAgentSock ? untildify(this.sshAgentSock) : undefined;
                const agentForward = enableAgentForwarding && (sshHostConfig['ForwardAgent'] || 'no').toLowerCase() === 'yes';

                const preferredAuthentications = sshHostConfig['PreferredAuthentications'] ? sshHostConfig['PreferredAuthentications'].split(',').map(s => s.trim()) : ['publickey', 'password', 'keyboard-interactive'];

                const lease = await this.connectionProvider.acquire({
                    sshConfig: sshconfig,
                    hostConfig: sshHostConfig,
                    originalHostname: sshDest.hostname,
                    host: sshHostName,
                    port: sshPort,
                    user: sshUser,
                    connectTimeoutMs: connectTimeout * 1000,
                    enableAgentForwarding,
                    sshAgentSock: this.sshAgentSock,
                    preferredAuthentications,
                    createAuthHandler: (user, host, identityKeys, authentications) =>
                        this.getSSHAuthHandler(user, host, identityKeys, authentications),
                    logger: this.logger,
                });
                this.lease = lease;

                const envVariables: Record<string, string | null> = {};
                if (agentForward) {
                    // The agent-forwarding socket sshd creates is scoped to the ssh channel that
                    // requested it and is torn down as soon as that channel closes. The server
                    // install/start script runs on its own short-lived exec channel, so any
                    // SSH_AUTH_SOCK it reports is already stale by the time we get here. Keep a
                    // dedicated channel open for the lifetime of the connection instead, and use
                    // its socket path everywhere else (terminals, extension host). Agent
                    // forwarding is best-effort: a failure here must not prevent connecting.
                    try {
                        const remoteAgentSock = await this.openAgentForwardSession();
                        if (remoteAgentSock) {
                            envVariables['SSH_AUTH_SOCK'] = remoteAgentSock;
                        }
                    } catch (e) {
                        this.logger.error(`Failed to setup agent forwarding`, e);
                    }
                }

                // Find the custom install path for this hostname (supports wildcards)
                const customInstallPath = findServerInstallPath(sshDest.hostname, serverInstallPathMap);

                const installResult = await installCodeServer(
                    lease,
                    serverDownloadUrlTemplate,
                    serverVersion,
                    defaultExtensions,
                    [],
                    remotePlatformMap[sshDest.hostname],
                    remoteServerListenOnSocket,
                    customInstallPath,
                    this.logger,
                    this.context.extensionPath
                );

                // Update terminal env variables
                this.context.environmentVariableCollection.persistent = false;
                for (const [key, value] of Object.entries(envVariables)) {
                    if (value) {
                        this.context.environmentVariableCollection.replace(key, value);
                    }
                }

                if (enableDynamicForwarding) {
                    const socksPort = await findRandomPort();
                    this.socksTunnel = await this.lease!.addTunnel({
                        name: `ssh_tunnel_socks_${socksPort}`,
                        localPort: socksPort,
                        socks: true
                    });
                }

                const tunnelConfig = await this.openTunnel(0, installResult.listeningOn);
                this.tunnels.push(tunnelConfig);

                // Enable ports view
                vscode.commands.executeCommand('setContext', 'forwardedPortsViewEnabled', true);

                this.labelFormatterDisposable?.dispose();
                this.labelFormatterDisposable = vscode.workspace.registerResourceLabelFormatter({
                    scheme: 'vscode-remote',
                    authority: `${REMOTE_SSH_AUTHORITY}+*`,
                    formatting: {
                        label: '${path}',
                        separator: '/',
                        tildify: true,
                        workspaceSuffix: `SSH: ${sshDest.hostname}` + (sshDest.port && sshDest.port !== 22 ? `:${sshDest.port}` : '')
                    }
                });

                const resolvedResult: vscode.ResolverResult = new vscode.ResolvedAuthority('127.0.0.1', tunnelConfig.localPort, installResult.connectionToken);
                resolvedResult.extensionHostEnv = envVariables;
                return resolvedResult;
            } catch (e: unknown) {
                this.logger.error(`Error resolving authority`, e);

                // Initial connection
                if (context.resolveAttempt === 1) {
                    this.logger.show();

                    const closeRemote = 'Close Remote';
                    const retry = 'Retry';
                    const result = await vscode.window.showErrorMessage(`Could not establish connection to "${sshDest.hostname}"`, { modal: true }, closeRemote, retry);
                    if (result === closeRemote) {
                        await vscode.commands.executeCommand('workbench.action.remote.close');
                    } else if (result === retry) {
                        await vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                }

                if (e instanceof ServerInstallError || !(e instanceof Error)) {
                    throw vscode.RemoteAuthorityResolverError.NotAvailable(e instanceof Error ? e.message : String(e));
                } else {
                    throw vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable(e.message);
                }
            }
        });
    }

    private openAgentForwardSession(): Promise<string | undefined> {
        // No pty here on purpose: a pty echoes back whatever is written to the
        // channel before the remote shell executes it, which would otherwise be
        // mistaken for the command's actual output. `exec cat` keeps the process
        // (and therefore the channel's agent-forwarding socket) alive indefinitely
        // after printing the socket path once.
        return this.lease!.execChannel('echo "$SSH_AUTH_SOCK"; exec cat').then(channel => {
            this.agentForwardSession?.close();
            this.agentForwardSession = channel;

            return new Promise<string | undefined>(resolve => {
                let buffer = '';
                let resolved = false;

                const finish = (value: string | undefined) => {
                    if (!resolved) {
                        resolved = true;
                        channel.removeListener('data', onData);
                        channel.removeListener('close', onClose);
                        clearTimeout(timer);
                        resolve(value);
                    }
                };

                const onData = (data: Buffer) => {
                    buffer += data.toString();
                    const newlineIdx = buffer.indexOf('\n');
                    if (newlineIdx < 0) {
                        return;
                    }
                    // A forwarded SSH_AUTH_SOCK is always an absolute path. Anything else
                    // (e.g. a non-POSIX remote echoing the command back verbatim) is rejected
                    // rather than exported as a bogus value.
                    const value = buffer.slice(0, newlineIdx).trim();
                    finish(value.startsWith('/') ? value : undefined);
                };

                // On a non-POSIX remote the `echo`d line ends the command and the channel
                // closes without a usable path; resolve now instead of waiting for the timeout.
                const onClose = () => finish(undefined);

                const timer = setTimeout(() => {
                    this.logger.trace('Timed out waiting for remote SSH_AUTH_SOCK');
                    finish(undefined);
                }, 5000);

                channel.on('data', onData);
                channel.on('close', onClose);
            });
        });
    }

    private async openTunnel(localPort: number, remotePortOrSocketPath: number | string) {
        localPort = localPort > 0 ? localPort : await findRandomPort();

        const disposables: vscode.Disposable[] = [];
        const remotePort = typeof remotePortOrSocketPath === 'number' ? remotePortOrSocketPath : undefined;
        const remoteSocketPath = typeof remotePortOrSocketPath === 'string' ? remotePortOrSocketPath : undefined;
        if (this.socksTunnel && remotePort) {
            const forwardingServer = await new Promise<net.Server>((resolve, reject) => {
                this.logger.trace(`Creating forwarding server ${localPort}(local) => ${this.socksTunnel!.localPort!}(socks) => ${remotePort}(remote)`);
                const socksOptions: SocksClientOptions = {
                    proxy: {
                        host: '127.0.0.1',
                        port: this.socksTunnel!.localPort!,
                        type: 5
                    },
                    command: 'connect',
                    destination: {
                        host: '127.0.0.1',
                        port: remotePort
                    }
                };
                const server: net.Server = net.createServer()
                    .on('error', reject)
                    .on('connection', async (socket: net.Socket) => {
                        try {
                            const socksConn = await SocksClient.createConnection(socksOptions);
                            socket.pipe(socksConn.socket);
                            socksConn.socket.pipe(socket);
                        } catch (error) {
                            this.logger.error(`Error while creating SOCKS connection`, error);
                        }
                    })
                    .on('listening', () => resolve(server))
                    .listen(localPort);
            });
            disposables.push({
                dispose: () => forwardingServer.close(() => {
                    this.logger.trace(`SOCKS forwading server closed`);
                }),
            });
        } else {
            this.logger.trace(`Opening tunnel ${localPort}(local) => ${remotePortOrSocketPath}(remote)`);
            const tunnelConfig = await this.lease!.addTunnel({
                name: `ssh_tunnel_${localPort}_${remotePortOrSocketPath}`,
                remoteAddr: '127.0.0.1',
                remotePort,
                remoteSocketPath,
                localPort
            });
            disposables.push({
                dispose: () => {
                    this.lease?.closeTunnel(tunnelConfig.name);
                    this.logger.trace(`Tunnel ${tunnelConfig.name} closed`);
                }
            });
        }

        return new TunnelInfo(localPort, remotePortOrSocketPath, disposables);
    }

    private getSSHAuthHandler(sshUser: string, sshHostName: string, identityKeys: SSHKey[], preferredAuthentications: string[]) {
        let passwordRetryCount = PASSWORD_RETRY_COUNT;
        let keyboardRetryCount = PASSWORD_RETRY_COUNT;
        identityKeys = identityKeys.slice();
        return async (methodsLeft: string[] | null, _partialSuccess: boolean | null, callback: (nextAuth: ssh2.AuthHandlerResult) => void) => {
            if (methodsLeft === null) {
                this.logger.info(`Trying no-auth authentication`);

                return callback({
                    type: 'none',
                    username: sshUser,
                });
            }
            if (methodsLeft.includes('publickey') && identityKeys.length && preferredAuthentications.includes('publickey')) {
                const identityKey = identityKeys.shift()!;

                if (identityKey.parsedKey) {
                    this.logger.info(`Trying publickey authentication: ${identityKey.filename} ${identityKey.parsedKey.type} SHA256:${identityKey.fingerprint}`);

                    if (identityKey.agentSupport) {
                        const { parsedKey } = identityKey;

                        return callback({
                            type: 'agent',
                            username: sshUser,
                            agent: new class extends ssh2.OpenSSHAgent {
                                // Only return the current key
                                override getIdentities(callback: (err: Error | undefined, publicKeys?: ParsedKey[]) => void): void {
                                    callback(undefined, [parsedKey]);
                                }
                            }(this.sshAgentSock!)
                        });
                    }
                    if (identityKey.isPrivate) {
                        return callback({
                            type: 'publickey',
                            username: sshUser,
                            key: identityKey.parsedKey
                        });
                    }
                }

                if (!await fileExists(identityKey.filename)) {
                    // Try next identity file
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    return callback(null as any);
                }

                const keyBuffer = await fs.promises.readFile(identityKey.filename);
                let result = ssh2.utils.parseKey(keyBuffer); // First try without passphrase
                if (result instanceof Error && result.message.includes('but no passphrase given')) {
                    let passphraseRetryCount = PASSPHRASE_RETRY_COUNT;
                    while (result instanceof Error && passphraseRetryCount > 0) {
                        const passphrase = await vscode.window.showInputBox({
                            title: `Enter passphrase for ${identityKey.filename}`,
                            password: true,
                            ignoreFocusOut: true
                        });
                        if (!passphrase) {
                            break;
                        }
                        result = ssh2.utils.parseKey(keyBuffer, passphrase);
                        passphraseRetryCount--;
                    }
                }
                if (!result || result instanceof Error) {
                    // Try next identity file
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    return callback(null as any);
                }

                const key = Array.isArray(result) ? result[0] : result;
                return callback({
                    type: 'publickey',
                    username: sshUser,
                    key
                });
            }
            if (methodsLeft.includes('password') && passwordRetryCount > 0 && preferredAuthentications.includes('password')) {
                if (passwordRetryCount === PASSWORD_RETRY_COUNT) {
                    this.logger.info(`Trying password authentication`);
                }

                const password = await vscode.window.showInputBox({
                    title: `Enter password for ${sshUser}@${sshHostName}`,
                    password: true,
                    ignoreFocusOut: true
                });
                passwordRetryCount--;

                return callback(password
                    ? {
                        type: 'password',
                        username: sshUser,
                        password
                    }
                    : false);
            }
            if (methodsLeft.includes('keyboard-interactive') && keyboardRetryCount > 0 && preferredAuthentications.includes('keyboard-interactive')) {
                if (keyboardRetryCount === PASSWORD_RETRY_COUNT) {
                    this.logger.info(`Trying keyboard-interactive authentication`);
                }

                return callback({
                    type: 'keyboard-interactive',
                    username: sshUser,
                    prompt: async (_name, _instructions, _instructionsLang, prompts, finish) => {
                        const responses: string[] = [];
                        for (const prompt of prompts) {
                            const response = await vscode.window.showInputBox({
                                title: `(${sshUser}@${sshHostName}) ${prompt.prompt}`,
                                password: !prompt.echo,
                                ignoreFocusOut: true
                            });
                            if (response === undefined) {
                                keyboardRetryCount = 0;
                                break;
                            }
                            responses.push(response);
                        }
                        keyboardRetryCount--;
                        finish(responses);
                    }
                });
            }

            callback(false);
        };
    }

    dispose() {
        disposeAll(this.tunnels);
        this.agentForwardSession?.close();
        this.agentForwardSession = undefined;
        this.lease?.close();
        this.lease = undefined;
        this.labelFormatterDisposable?.dispose();
    }
}
