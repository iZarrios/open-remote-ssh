import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrokerClient } from '../../src/broker/client';
import { startBroker, type BrokerServer } from '../../src/broker/main';
import { fakeConnectTransport } from './helpers';

const dirs: string[] = [];
const brokers: BrokerServer[] = [];

afterEach(async () => {
    await Promise.all(brokers.splice(0).map((broker) => broker.close()));
    await Promise.all(dirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })));
});

async function tempRuntime(): Promise<string> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'orss-broker-'));
    dirs.push(dir);
    return dir;
}

describe('broker-owned transports', () => {
    it('shares one authenticated transport and prompts only the first client', async () => {
        const runtimeDir = await tempRuntime();
        const authCalls = { count: 0 };
        brokers.push(await startBroker({
            runtimeDir,
            uid: process.getuid(),
            connectTransport: fakeConnectTransport(authCalls),
        }));

        const connect = async () => {
            const client = await BrokerClient.connect({
                runtimeDir,
                execPath: process.execPath,
                brokerScript: '',
                spawn: () => { throw new Error('broker already running'); },
            });
            const lease = await client.acquire({
                identity: 'shared',
                route: { host: 'example.com', port: 22, user: 'alice' },
                onAuthPrompt: async (prompt) => {
                    if (prompt.kind === 'password') {
                        return { kind: 'password', password: 'secret' };
                    }
                    throw new Error(`unexpected prompt ${prompt.kind}`);
                },
            });
            return { client, lease };
        };

        const first = await connect();
        expect(authCalls.count).toBe(1);

        const second = await connect();
        expect(authCalls.count).toBe(1);
        expect(second.lease.leaseId).not.toBe(first.lease.leaseId);

        await first.client.release(first.lease.leaseId, first.lease.identity);
        await second.client.release(second.lease.leaseId, second.lease.identity);
        await first.client.close();
        await second.client.close();
    });

    it('closes the master immediately when the last lease is released and persist is immediate', async () => {
        const runtimeDir = await tempRuntime();
        brokers.push(await startBroker({
            runtimeDir,
            uid: process.getuid(),
            connectTransport: fakeConnectTransport(),
        }));
        const client = await BrokerClient.connect({
            runtimeDir,
            execPath: process.execPath,
            brokerScript: '',
            spawn: () => { throw new Error('broker already running'); },
        });
        const lease = await client.acquire({
            identity: 'ephemeral',
            route: { host: 'example.com', port: 22, user: 'alice' },
            persist: { kind: 'immediate' },
            onAuthPrompt: async () => ({ kind: 'password', password: 'secret' }),
        });

        await client.release(lease.leaseId, lease.identity);
        await expect(client.request('list')).resolves.toEqual({ masters: [] });
        await client.close();
    });

    it('keeps the master until a timed persist idle window expires', async () => {
        const runtimeDir = await tempRuntime();
        const timers: Array<{ delay: number; fn: () => void }> = [];
        brokers.push(await startBroker({
            runtimeDir,
            uid: process.getuid(),
            connectTransport: fakeConnectTransport(),
            schedule: (delayMs, fn) => {
                timers.push({ delay: delayMs, fn });
                return setTimeout(() => undefined, 0);
            },
        }));
        const client = await BrokerClient.connect({
            runtimeDir,
            execPath: process.execPath,
            brokerScript: '',
            spawn: () => { throw new Error('broker already running'); },
        });
        const lease = await client.acquire({
            identity: 'timed',
            route: { host: 'example.com', port: 22, user: 'alice' },
            persist: { kind: 'timed', idleSeconds: 90 },
            onAuthPrompt: async () => ({ kind: 'password', password: 'secret' }),
        });

        await client.release(lease.leaseId, lease.identity);
        expect(timers).toEqual([{ delay: 90_000, fn: expect.any(Function) }]);
        await expect(client.request('list')).resolves.toEqual({
            masters: [expect.objectContaining({ identity: 'timed', state: 'idle', leaseCount: 0 })],
        });

        timers[0].fn();
        await expect(client.request('list')).resolves.toEqual({ masters: [] });
        await client.close();
    });

    it('rejects attaching a master whose frozen destination does not match', async () => {
        const runtimeDir = await tempRuntime();
        brokers.push(await startBroker({
            runtimeDir,
            uid: process.getuid(),
            connectTransport: fakeConnectTransport(),
        }));
        const first = await BrokerClient.connect({
            runtimeDir,
            execPath: process.execPath,
            brokerScript: '',
            spawn: () => { throw new Error('broker already running'); },
        });
        await first.acquire({
            identity: 'shared',
            route: { host: 'example.com', port: 22, user: 'alice' },
            persist: { kind: 'indefinite' },
            onAuthPrompt: async () => ({ kind: 'password', password: 'secret' }),
        });

        const second = await BrokerClient.connect({
            runtimeDir,
            execPath: process.execPath,
            brokerScript: '',
            spawn: () => { throw new Error('broker already running'); },
        });
        await expect(second.acquire({
            identity: 'shared',
            route: { host: 'other.example', port: 22, user: 'alice' },
            onAuthPrompt: async () => ({ kind: 'password', password: 'secret' }),
        })).rejects.toThrow(/destination mismatch/i);

        await first.close();
        await second.close();
    });

    it('runs exec on the shared transport and fans a transport failure out to every lease', async () => {
        const runtimeDir = await tempRuntime();
        const created: { connection?: import('./helpers').FakeTransport } = {};
        brokers.push(await startBroker({
            runtimeDir,
            uid: process.getuid(),
            connectTransport: fakeConnectTransport(undefined, created),
        }));

        const connect = async () => {
            const client = await BrokerClient.connect({
                runtimeDir,
                execPath: process.execPath,
                brokerScript: '',
                spawn: () => { throw new Error('broker already running'); },
            });
            const lease = await client.acquire({
                identity: 'shared',
                route: { host: 'example.com', port: 22, user: 'alice' },
                persist: { kind: 'indefinite' },
                onAuthPrompt: async () => ({ kind: 'password', password: 'secret' }),
            });
            return { client, lease };
        };

        const first = await connect();
        const second = await connect();

        await expect(first.client.exec(first.lease.leaseId, first.lease.identity, 'uname')).resolves.toEqual({
            stdout: 'ok',
            stderr: '',
        });

        created.connection!.fail();

        await expect(first.client.exec(first.lease.leaseId, first.lease.identity, 'uname')).rejects.toThrow(/transport failed/i);
        await expect(second.client.exec(second.lease.leaseId, second.lease.identity, 'uname')).rejects.toThrow(/transport failed/i);
        await expect(first.client.request('list')).resolves.toEqual({
            masters: [expect.objectContaining({ identity: 'shared', state: 'failed' })],
        });

        await first.client.close();
        await second.client.close();
    });
});
