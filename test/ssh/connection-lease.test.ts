import { describe, expect, it } from 'vitest';
import type { ClientChannel } from 'ssh2';
import type { ConnectionLease, TunnelHandle } from '../../src/ssh/connectionLease';
import { wrapDirectConnection } from '../../src/ssh/directConnectionProvider';
import type SSHConnection from '../../src/ssh/sshConnection';
import type { SSHTunnelConfig } from '../../src/ssh/sshConnection';

function createFakeTransport() {
    const tunnels = new Set<string>();
    let closed = false;

    const transport = {
        exec: async () => ({ stdout: 'ok', stderr: '' }),
        execPartial: async () => ({ stdout: 'ok', stderr: '' }),
        execChannel: async () => {
            return { close() {} } as unknown as ClientChannel;
        },
        forwardOut: async () => ({} as ClientChannel),
        addTunnel: async (config: SSHTunnelConfig): Promise<TunnelHandle> => {
            const name = config.name || 'tunnel';
            tunnels.add(name);
            return { ...config, name, server: {} as TunnelHandle['server'] };
        },
        closeTunnel: async (name?: string) => {
            if (name) {
                tunnels.delete(name);
            } else {
                tunnels.clear();
            }
        },
        close: async () => {
            closed = true;
            tunnels.clear();
        },
    };

    return {
        transport: transport as unknown as SSHConnection,
        isClosed: () => closed,
        tunnelCount: () => tunnels.size,
    };
}

describe('wrapDirectConnection', () => {
    it('releases lease-owned tunnels and the transport on close', async () => {
        const fake = createFakeTransport();
        const lease: ConnectionLease = wrapDirectConnection(fake.transport);

        await lease.addTunnel({ name: 'socks', socks: true, localPort: 1 });
        expect(fake.tunnelCount()).toBe(1);

        await lease.close();

        expect(fake.isClosed()).toBe(true);
        expect(fake.tunnelCount()).toBe(0);
    });

    it('runs onRelease after the transport is closed', async () => {
        const fake = createFakeTransport();
        let released = false;
        const lease = wrapDirectConnection(fake.transport, () => {
            released = true;
        });

        await lease.close();

        expect(fake.isClosed()).toBe(true);
        expect(released).toBe(true);
    });
});
