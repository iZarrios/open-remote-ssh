import * as cp from 'child_process';
import * as stream from 'stream';
import * as ssh2 from 'ssh2';
import type { Logger } from '../common/logger';
import { isWindows } from '../common/platform';
import { gatherIdentityFiles, SSHKey } from './identityFiles';
import { HostConfiguration } from './sshConfig';
import SSHConnection, { SSHConnectConfig } from './sshConnection';
import SSHDestination from './sshDestination';

export type SshAuthHandler = (
    methodsLeft: string[] | null,
    partialSuccess: boolean | null,
    callback: (nextAuth: ssh2.AuthHandlerResult) => void,
) => void | Promise<void>;

export type AuthHandlerFactory = (
    user: string,
    host: string,
    identityKeys: SSHKey[],
    preferredAuthentications: string[],
) => SshAuthHandler;

export type HostConfigLookup = {
    getHostConfiguration(host: string): HostConfiguration;
};

export type OpenSshRouteRequest = {
    sshConfig: HostConfigLookup;
    hostConfig: HostConfiguration;
    originalHostname: string;
    host: string;
    port: number;
    user: string;
    connectTimeoutMs: number;
    enableAgentForwarding: boolean;
    sshAgentSock?: string;
    preferredAuthentications: string[];
    createAuthHandler: AuthHandlerFactory;
    logger: Logger;
};

export type OpenedSshRoute = {
    host?: string;
    port?: number;
    sock?: ssh2.ClientChannel | stream.Duplex;
    username: string;
    agentForward: boolean;
    agent?: SSHConnectConfig['agent'];
    dispose(): void;
};

/**
 * Split a ProxyCommand value into argv tokens.
 *
 * ssh-config v5.0.0 reassembles ProxyCommand's value into a single string (to
 * preserve quoting across the param boundary), but the spawn code expects
 * individual argv tokens. Calling `[].concat(someString)` does NOT split the
 * string — it wraps it, so `spawn()` ends up receiving the whole command
 * line as the executable path and fails with ENOENT. See
 * https://github.com/jeanp413/open-remote-ssh/issues/271 and
 * https://github.com/jeanp413/open-remote-ssh/issues/273.
 *
 * This helper mirrors OpenSSH's own ProxyCommand tokenization:
 * - whitespace separates tokens (outside quotes)
 * - double quotes group a single token
 * - backslash escapes the next character
 *
 * Array inputs are passed through for defensive compatibility with older
 * ssh-config versions.
 */
export function splitProxyCommand(value: string | string[]): string[] {
    if (Array.isArray(value)) {return value.slice();}
    const out: string[] = [];
    let cur = '';
    let i = 0;
    let quoted = false;
    let hasToken = false;
    while (i < value.length) {
        const ch = value[i];
        if (ch === '\\' && i + 1 < value.length) {
            cur += value[i + 1];
            i += 2;
            hasToken = true;
            continue;
        }
        if (ch === '"') {
            quoted = !quoted;
            hasToken = true;
            i += 1;
            continue;
        }
        if (!quoted && /\s/.test(ch)) {
            if (hasToken) { out.push(cur); cur = ''; hasToken = false; }
            i += 1;
            continue;
        }
        cur += ch;
        hasToken = true;
        i += 1;
    }
    if (hasToken) {out.push(cur);}
    return out;
}

export async function openSshRoute(request: OpenSshRouteRequest): Promise<OpenedSshRoute> {
    const proxyConnections: SSHConnection[] = [];
    let proxyCommandProcess: cp.ChildProcessWithoutNullStreams | undefined;
    let proxyStream: ssh2.ClientChannel | stream.Duplex | undefined;

    const agentForward = request.enableAgentForwarding && (request.hostConfig['ForwardAgent'] || 'no').toLowerCase() === 'yes';
    const agent = agentForward && request.sshAgentSock ? new ssh2.OpenSSHAgent(request.sshAgentSock) : undefined;

    try {
        if (request.hostConfig['ProxyJump']) {
            const proxyJumps = request.hostConfig['ProxyJump'].split(',').filter(i => !!i.trim())
                .map(i => {
                    const proxy = SSHDestination.parse(i);
                    const proxyHostConfig = request.sshConfig.getHostConfiguration(proxy.hostname);
                    return [proxy, proxyHostConfig] as [SSHDestination, Record<string, string>];
                });
            for (let i = 0; i < proxyJumps.length; i++) {
                const [proxy, proxyHostConfig] = proxyJumps[i];
                const proxyHostName = proxyHostConfig['HostName'] || proxy.hostname;
                const proxyUser = proxyHostConfig['User'] || proxy.user || request.user;
                const proxyPort = proxyHostConfig['Port'] ? parseInt(proxyHostConfig['Port'], 10) : (proxy.port || request.port);

                const proxyAgentForward = request.enableAgentForwarding && (proxyHostConfig['ForwardAgent'] || 'no').toLowerCase() === 'yes';
                const proxyAgent = proxyAgentForward && request.sshAgentSock ? new ssh2.OpenSSHAgent(request.sshAgentSock) : undefined;

                const proxyIdentityFiles: string[] = (proxyHostConfig['IdentityFile'] as unknown as string[]) || [];
                const proxyIdentitiesOnly = (proxyHostConfig['IdentitiesOnly'] || 'no').toLowerCase() === 'yes';
                const proxyIdentityKeys = await gatherIdentityFiles(proxyIdentityFiles, request.sshAgentSock, proxyIdentitiesOnly, request.logger);

                const proxyAuthHandler = request.createAuthHandler(proxyUser, proxyHostName, proxyIdentityKeys, request.preferredAuthentications);
                const proxyConnection = new SSHConnection({
                    host: !proxyStream ? proxyHostName : undefined,
                    port: !proxyStream ? proxyPort : undefined,
                    sock: proxyStream,
                    username: proxyUser,
                    readyTimeout: request.connectTimeoutMs,
                    strictVendor: false,
                    agentForward: proxyAgentForward,
                    agent: proxyAgent,
                    authHandler: (arg0, arg1, arg2) => (proxyAuthHandler?.(arg0, arg1, arg2), undefined)
                });
                proxyConnections.push(proxyConnection);

                const nextProxyJump = i < proxyJumps.length - 1 ? proxyJumps[i + 1] : undefined;
                const destIP = nextProxyJump ? (nextProxyJump[1]['HostName'] || nextProxyJump[0].hostname) : request.host;
                const destPort = nextProxyJump ? ((nextProxyJump[1]['Port'] && parseInt(nextProxyJump[1]['Port'], 10)) || nextProxyJump[0].port || 22) : request.port;
                proxyStream = await proxyConnection.forwardOut('127.0.0.1', 0, destIP, destPort);
            }
        } else if (request.hostConfig['ProxyCommand']) {
            let proxyArgs = splitProxyCommand(request.hostConfig['ProxyCommand'] as unknown as string | string[])
                .map((arg) => arg.replace('%h', request.host).replace('%n', request.originalHostname).replace('%p', request.port.toString()).replace('%r', request.user));
            let proxyCommand = proxyArgs.shift()!;

            let options = {};
            if (isWindows && /\.(bat|cmd)$/.test(proxyCommand)) {
                proxyCommand = `"${proxyCommand}"`;
                proxyArgs = proxyArgs.map((arg) => arg.includes(' ') ? `"${arg}"` : arg);
                options = { shell: true, windowsHide: true, windowsVerbatimArguments: true };
            }

            request.logger.trace(`Spawning ProxyCommand: ${proxyCommand} ${proxyArgs.join(' ')}`);

            const child = cp.spawn(proxyCommand, proxyArgs, options);
            proxyStream = stream.Duplex.from({ readable: child.stdout, writable: child.stdin });
            proxyCommandProcess = child;
        }
    } catch (err) {
        disposeRoute(proxyConnections, proxyCommandProcess);
        throw err;
    }

    return {
        host: !proxyStream ? request.host : undefined,
        port: !proxyStream ? request.port : undefined,
        sock: proxyStream,
        username: request.user,
        agentForward,
        agent,
        dispose() {
            disposeRoute(proxyConnections, proxyCommandProcess);
        },
    };
}

function disposeRoute(proxyConnections: SSHConnection[], proxyCommandProcess?: cp.ChildProcessWithoutNullStreams) {
    if (proxyConnections.length) {
        proxyConnections[0].close();
    }
    proxyCommandProcess?.kill();
}
