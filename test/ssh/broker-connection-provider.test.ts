import { describe, expect, it, vi } from 'vitest';
import {
    BrokerAuthError,
    BrokerInfrastructureError,
    BrokerClient,
} from '../../src/broker/client';
import {
    BrokerConnectionProvider,
    classifyBrokerFailure,
    selectConnectionProvider,
} from '../../src/ssh/brokerConnectionProvider';
import type { ConnectionLease } from '../../src/ssh/connectionLease';
import { DirectConnectionProvider } from '../../src/ssh/directConnectionProvider';

describe('classifyBrokerFailure', () => {
    it('treats infrastructure failures as fallback candidates', () => {
        expect(classifyBrokerFailure(new BrokerInfrastructureError('socket gone'))).toBe('fallback');
    });

    it('treats authentication failures as terminal', () => {
        expect(classifyBrokerFailure(new BrokerAuthError('bad password'))).toBe('terminal');
    });
});

describe('BrokerConnectionProvider', () => {
    it('falls back to a direct connection when broker attachment fails', async () => {
        const directLease = { close: vi.fn(async () => undefined) } as unknown as ConnectionLease;
        const direct = { acquire: vi.fn(async () => directLease) };
        const provider = new BrokerConnectionProvider({
            connectBroker: async () => { throw new BrokerInfrastructureError('broker unavailable'); },
            directProvider: direct as unknown as DirectConnectionProvider,
            runtimeDir: '/tmp/broker',
            execPath: '/bin/node',
            brokerScript: '/broker.js',
            identity: 'shared',
            persist: { kind: 'immediate' },
            createAuthPromptHandler: () => async () => ({ kind: 'password', password: 'x' }),
            logger: { trace: vi.fn(), info: vi.fn(), error: vi.fn() } as never,
        });

        const request = {
            host: 'example.com',
            logger: { trace: vi.fn(), info: vi.fn(), error: vi.fn() },
        } as never;
        const lease = await provider.acquire(request);

        expect(direct.acquire).toHaveBeenCalledWith(request);
        expect(lease).toBe(directLease);
    });

    it('uses the broker when attachment succeeds', async () => {
        const broker = {
            acquire: vi.fn(async () => ({ leaseId: 'l1', identity: 'shared', state: 'ready' })),
            release: vi.fn(async () => undefined),
            close: vi.fn(async () => undefined),
        } as unknown as BrokerClient;
        const provider = new BrokerConnectionProvider({
            connectBroker: async () => broker,
            directProvider: { acquire: vi.fn() } as unknown as DirectConnectionProvider,
            runtimeDir: '/tmp/broker',
            execPath: '/bin/node',
            brokerScript: '/broker.js',
            logger: { trace: vi.fn(), info: vi.fn(), error: vi.fn() } as never,
            identity: 'shared',
            persist: { kind: 'immediate' },
            createAuthPromptHandler: () => async () => ({ kind: 'password', password: 'x' }),
        });

        const lease = await provider.acquire({
            host: 'example.com',
            port: 22,
            user: 'alice',
            logger: { trace: vi.fn(), info: vi.fn(), error: vi.fn() },
        } as never);

        expect(broker.acquire).toHaveBeenCalled();
        await lease.close();
        expect(broker.release).toHaveBeenCalledWith('l1', 'shared');
    });
});

describe('selectConnectionProvider', () => {
    it('uses a direct provider when sharing is disabled', () => {
        const provider = selectConnectionProvider({ sharing: false, reason: 'absent' }, {
            runtimeDir: '/tmp/broker',
            execPath: '/bin/node',
            brokerScript: '/broker.js',
            logger: { trace: vi.fn(), info: vi.fn(), error: vi.fn() } as never,
            createAuthPromptHandler: () => async () => ({ kind: 'password', password: 'x' }),
        });
        expect(provider).toBeInstanceOf(DirectConnectionProvider);
    });

    it('uses a broker provider when sharing is enabled', () => {
        const provider = selectConnectionProvider({
            sharing: true,
            action: 'attach-or-create',
            persist: { kind: 'immediate' },
            identity: { controlPath: '/tmp/ssh', host: 'example.com', port: 22, user: 'alice' },
        }, {
            runtimeDir: '/tmp/broker',
            execPath: '/bin/node',
            brokerScript: '/broker.js',
            logger: { trace: vi.fn(), info: vi.fn(), error: vi.fn() } as never,
            createAuthPromptHandler: () => async () => ({ kind: 'password', password: 'x' }),
        });
        expect(provider).toBeInstanceOf(BrokerConnectionProvider);
    });
});
