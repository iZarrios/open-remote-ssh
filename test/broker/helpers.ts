import { EventEmitter } from 'events';
import type { AuthDelegate } from '../../src/broker/transport';
import type SSHConnection from '../../src/ssh/sshConnection';

export type FakeTransport = SSHConnection & {
    fail(): void;
};

export function fakeConnection(): FakeTransport {
    const emitter = new EventEmitter();
    let failed = false;
    const connection = Object.assign(emitter, {
        exec: async () => {
            if (failed) {
                throw new Error('transport failed');
            }
            return { stdout: 'ok', stderr: '' };
        },
        execPartial: async () => {
            if (failed) {
                throw new Error('transport failed');
            }
            return { stdout: 'ok', stderr: '' };
        },
        execChannel: async () => ({ close() {} }),
        forwardOut: async () => ({}),
        addTunnel: async (config: { name?: string }) => ({ ...config, server: {} }),
        closeTunnel: async () => undefined,
        close: async () => undefined,
        fail() {
            failed = true;
            emitter.emit('ssh:disconnect', connection, { err: new Error('transport failed') });
        },
    });
    return connection as unknown as FakeTransport;
}

export function fakeConnectTransport(authCalls?: { count: number }, created?: { connection?: FakeTransport }) {
    return async (_identity: string, _route: { host: string; port: number; user: string }, auth: AuthDelegate) => {
        if (authCalls) {
            authCalls.count += 1;
        }
        await auth.requestPassword('alice', 'example.com');
        const connection = fakeConnection();
        if (created) {
            created.connection = connection;
        }
        return connection;
    };
}
