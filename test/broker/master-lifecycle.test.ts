import { describe, expect, it, vi } from 'vitest';
import { attachLease, closeMaster, createMaster } from '../../src/broker/master';
import { fakeConnection } from './helpers';

describe('shared master lifecycle', () => {
    it('closes every lease-owned tunnel and stream before closing the transport', async () => {
        const connection = fakeConnection();
        const closeTunnel = vi.spyOn(connection, 'closeTunnel');
        const closeTransport = vi.spyOn(connection, 'close');
        const closeResource = vi.fn(async () => undefined);
        const master = createMaster(
            'shared',
            { host: 'example.com', port: 22, user: 'alice' },
            { kind: 'indefinite' },
            connection,
        );
        const lease = attachLease(master, 'lease-1');
        lease.tunnelNames.push('socks');
        lease.resources.push(closeResource);

        await closeMaster(master);

        expect(closeTunnel).toHaveBeenCalledWith('socks');
        expect(closeResource).toHaveBeenCalledOnce();
        expect(closeTransport).toHaveBeenCalledOnce();
        expect(master).toMatchObject({ state: 'failed', leaseCount: 0 });
        expect(master.leases.size).toBe(0);
    });
});
