import * as fs from 'fs';
import * as ssh2 from 'ssh2';
import { gatherIdentityFiles } from '../ssh/identityFiles';
import SSHConnection from '../ssh/sshConnection';
import { openSshRoute, type HostConfigLookup, type SshAuthHandler } from '../ssh/sshRoute';
import type { AuthDelegate, FrozenRoute, TransportConnector } from './transport';

const logger = {
    trace(message: string, data?: unknown) {
        process.stderr.write(`[trace] ${message}${data ? ` ${String(data)}` : ''}\n`);
    },
    info(message: string, data?: unknown) {
        process.stderr.write(`[info] ${message}${data ? ` ${String(data)}` : ''}\n`);
    },
    error(message: string, data?: unknown) {
        process.stderr.write(`[error] ${message}${data ? ` ${String(data)}` : ''}\n`);
    },
};

export function frozenHostConfigLookup(route: FrozenRoute): HostConfigLookup {
    return {
        getHostConfiguration(host: string) {
            if (route.jumpHostConfigs?.[host]) {
                return route.jumpHostConfigs[host];
            }
            return route.hostConfig || {};
        },
    };
}

export const connectSshTransport: TransportConnector = async (_identity, route, auth) => {
    const hostConfig = route.hostConfig || {};
    const identityFiles: string[] = (hostConfig['IdentityFile'] as unknown as string[]) || [];
    const identitiesOnly = (hostConfig['IdentitiesOnly'] || 'no').toLowerCase() === 'yes';
    const identityKeys = await gatherIdentityFiles(identityFiles, route.sshAgentSock, identitiesOnly, logger as never);
    const preferred = route.preferredAuthentications || ['publickey', 'password', 'keyboard-interactive'];

    const request = {
        sshConfig: frozenHostConfigLookup(route),
        hostConfig,
        originalHostname: route.originalHostname || route.host,
        host: route.host,
        port: route.port,
        user: route.user,
        connectTimeoutMs: route.connectTimeoutMs || 60_000,
        enableAgentForwarding: route.enableAgentForwarding || false,
        sshAgentSock: route.sshAgentSock,
        preferredAuthentications: preferred,
        createAuthHandler: (user: string, host: string, keys: typeof identityKeys, authentications: string[]) =>
            authHandlerFromDelegate(auth, user, host, keys, authentications),
        logger: logger as never,
    };

    const opened = await openSshRoute(request);
    try {
        const connection = new SSHConnection({
            host: opened.host,
            port: opened.port,
            sock: opened.sock,
            username: opened.username,
            readyTimeout: request.connectTimeoutMs,
            strictVendor: false,
            agentForward: opened.agentForward,
            agent: opened.agent,
            hostVerifier: (hashedKey: string, callback: (verified: boolean) => void) => {
                void auth.requestHostKey(route.host, hashedKey, true).then(
                    (accept) => callback(accept),
                    () => callback(false),
                );
            },
            authHandler: (arg0, arg1, arg2) => {
                const handler = request.createAuthHandler(route.user, route.host, identityKeys, preferred);
                void handler(arg0, arg1, arg2);
                return undefined;
            },
        });
        await connection.connect();
        const close = connection.close.bind(connection);
        connection.close = async () => {
            await close();
            opened.dispose();
        };
        return connection;
    } catch (err) {
        opened.dispose();
        throw err;
    }
};

function authHandlerFromDelegate(
    auth: AuthDelegate,
    user: string,
    host: string,
    identityKeys: Awaited<ReturnType<typeof gatherIdentityFiles>>,
    preferredAuthentications: string[],
): SshAuthHandler {
    let passwordRetryCount = 3;
    const keys = identityKeys.slice();
    return async (methodsLeft, _partialSuccess, callback) => {
        if (methodsLeft === null) {
            return callback({ type: 'none', username: user });
        }
        if (methodsLeft.includes('publickey') && keys.length && preferredAuthentications.includes('publickey')) {
            const identityKey = keys.shift()!;
            if (identityKey.parsedKey && identityKey.isPrivate) {
                return callback({ type: 'publickey', username: user, key: identityKey.parsedKey });
            }
            try {
                const keyBuffer = await fs.promises.readFile(identityKey.filename);
                let result = ssh2.utils.parseKey(keyBuffer);
                if (result instanceof Error && result.message.includes('but no passphrase given')) {
                    const passphrase = await auth.requestPassphrase(identityKey.filename);
                    result = ssh2.utils.parseKey(keyBuffer, passphrase);
                }
                if (!result || result instanceof Error) {
                    return callback(null as never);
                }
                const key = Array.isArray(result) ? result[0] : result;
                return callback({ type: 'publickey', username: user, key });
            } catch {
                return callback(null as never);
            }
        }
        if (methodsLeft.includes('password') && passwordRetryCount > 0 && preferredAuthentications.includes('password')) {
            const password = await auth.requestPassword(user, host);
            passwordRetryCount -= 1;
            return callback({ type: 'password', username: user, password });
        }
        if (methodsLeft.includes('keyboard-interactive') && preferredAuthentications.includes('keyboard-interactive')) {
            return callback({
                type: 'keyboard-interactive',
                username: user,
                prompt: async (_name, instructions, _lang, prompts, finish) => {
                    const answers = await auth.requestKeyboardInteractive(
                        user,
                        host,
                        instructions,
                        prompts.map((prompt) => ({ prompt: prompt.prompt, echo: !!prompt.echo })),
                    );
                    finish(answers);
                },
            });
        }
        callback(false);
    };
}
