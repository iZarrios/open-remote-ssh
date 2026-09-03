import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BrokerClient, ProtocolMismatchError } from '../../src/broker/client';
import { startBroker, type BrokerServer } from '../../src/broker/main';
import { PROTOCOL_VERSION } from '../../src/broker/protocol';
import { fakeConnectTransport } from './helpers';

const route = { host: 'example.com', port: 22, user: 'alice' };

function brokerOptions(runtimeDir: string, extra: Record<string, unknown> = {}) {
    return {
        runtimeDir,
        uid: process.getuid(),
        connectTransport: fakeConnectTransport(),
        ...extra,
    };
}

function acquireOptions(identity: string) {
    return {
        identity,
        route,
        onAuthPrompt: async () => ({ kind: 'password' as const, password: 'secret' }),
    };
}

const dirs: string[] = [];
const brokers: BrokerServer[] = [];
const children: Array<{ kill: () => void }> = [];

afterEach(async () => {
    await Promise.all(brokers.splice(0).map((broker) => broker.close()));
    for (const child of children.splice(0)) {
        child.kill();
    }
    await Promise.all(dirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })));
});

async function tempRuntime(): Promise<string> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'orss-broker-'));
    dirs.push(dir);
    return dir;
}

function clientOptions(runtimeDir: string) {
    return {
        runtimeDir,
        execPath: process.execPath,
        brokerScript: path.join(__dirname, '../../out/broker/main.js'),
        detached: false,
        spawn: () => {
            throw new Error('spawn should not be called while a broker is already listening');
        },
    };
}

describe('BrokerClient', () => {
    it('correlates concurrent requests on the control connection', async () => {
        const runtimeDir = await tempRuntime();
        brokers.push(await startBroker(brokerOptions(runtimeDir)));
        const client = await BrokerClient.connect(clientOptions(runtimeDir));

        const [first, second] = await Promise.all([
            client.acquire(acquireOptions('one')),
            client.acquire(acquireOptions('two')),
        ]);

        expect(first).toMatchObject({ identity: 'one' });
        expect(second).toMatchObject({ identity: 'two' });

        const listed = await client.request('list') as { masters: Array<{ identity: string }> };
        expect(listed.masters.map((master) => master.identity).sort()).toEqual(['one', 'two']);
        await client.close();
    });

    it('leaves the running broker alive on protocol mismatch', async () => {
        const runtimeDir = await tempRuntime();
        brokers.push(await startBroker(brokerOptions(runtimeDir)));

        await expect(BrokerClient.connect({
            ...clientOptions(runtimeDir),
            helloVersion: PROTOCOL_VERSION + 1,
        })).rejects.toBeInstanceOf(ProtocolMismatchError);

        const client = await BrokerClient.connect(clientOptions(runtimeDir));
        await expect(client.request('list')).resolves.toEqual({ masters: [] });
        await client.close();
    });

    it('serializes acquire for the same identity across two clients', async () => {
        const runtimeDir = await tempRuntime();
        brokers.push(await startBroker(brokerOptions(runtimeDir)));
        const a = await BrokerClient.connect(clientOptions(runtimeDir));
        const b = await BrokerClient.connect(clientOptions(runtimeDir));

        const [first, second] = await Promise.all([
            a.acquire(acquireOptions('shared')),
            b.acquire(acquireOptions('shared')),
        ]);

        expect(first).toMatchObject({ identity: 'shared' });
        expect(second).toMatchObject({ identity: 'shared' });
        const listed = await a.request('list') as { masters: Array<{ identity: string; leaseCount: number }> };
        expect(listed.masters).toEqual([expect.objectContaining({ identity: 'shared', leaseCount: 2 })]);
        await a.close();
        await b.close();
    });

    it('applies backpressure on a broker-owned data socket', async () => {
        const runtimeDir = await tempRuntime();
        let pausedSocket: net.Socket | undefined;
        brokers.push(await startBroker({
            ...brokerOptions(runtimeDir),
            onStream: (socket) => {
                pausedSocket = socket;
                socket.pause();
            },
        }));
        const client = await BrokerClient.connect(clientOptions(runtimeDir));
        const { socketPath } = await client.request('open-stream') as { socketPath: string };

        const data = await new Promise<net.Socket>((resolve, reject) => {
            const socket = new net.Socket({ highWaterMark: 16 });
            socket.once('connect', () => resolve(socket));
            socket.once('error', reject);
            socket.connect(socketPath);
        });

        const payload = Buffer.alloc(256 * 1024, 7);
        const writeOk = data.write(payload);
        expect(writeOk).toBe(false);

        const received = new Promise<Buffer>((resolve) => {
            const chunks: Buffer[] = [];
            data.on('data', (chunk) => chunks.push(chunk));
            data.on('end', () => resolve(Buffer.concat(chunks)));
        });

        pausedSocket!.on('data', (chunk) => pausedSocket!.write(chunk));
        pausedSocket!.on('end', () => pausedSocket!.end());
        pausedSocket!.resume();
        data.end();

        const echoed = await received;
        expect(echoed.equals(payload)).toBe(true);
        await client.close();
    });
});

describe('broker child process', () => {
    beforeAll(() => {
        execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-b'], {
            cwd: path.join(__dirname, '../..'),
            stdio: 'pipe',
        });
    });

    it('launches a detached broker and serves a client', async () => {
        const runtimeDir = await tempRuntime();
        const { spawn } = await import('child_process');
        const client = await BrokerClient.connect({
            runtimeDir,
            execPath: process.execPath,
            brokerScript: path.join(__dirname, '../../out/broker/main.js'),
            detached: false,
            spawn: (command, args, options) => {
                const child = spawn(command, args, { ...options, stdio: 'ignore' });
                children.push(child);
                return child;
            },
        });

        await expect(client.request('list')).resolves.toEqual({ masters: [] });
        await client.close();
    });

    it('connects to a live broker instead of spawning a replacement', async () => {
        const runtimeDir = await tempRuntime();
        brokers.push(await startBroker(brokerOptions(runtimeDir)));
        let spawned = 0;
        const client = await BrokerClient.connect({
            runtimeDir,
            execPath: process.execPath,
            brokerScript: path.join(__dirname, '../../out/broker/main.js'),
            spawn: () => {
                spawned += 1;
                throw new Error('should not spawn over a live broker');
            },
        });

        expect(spawned).toBe(0);
        await expect(client.request('list')).resolves.toEqual({ masters: [] });
        await client.close();
    });

    it('lets two first clients race on spawn and still share one broker', async () => {
        const runtimeDir = await tempRuntime();
        const { spawn } = await import('child_process');
        const connect = () => BrokerClient.connect({
            runtimeDir,
            execPath: process.execPath,
            brokerScript: path.join(__dirname, '../../out/broker/main.js'),
            detached: false,
            spawn: (command, args, options) => {
                const child = spawn(command, args, { ...options, stdio: 'ignore' });
                children.push(child);
                return child;
            },
        });

        const [a, b] = await Promise.all([connect(), connect()]);
        await expect(a.request('list')).resolves.toEqual({ masters: [] });
        await expect(b.request('list')).resolves.toEqual({ masters: [] });
        await a.close();
        await b.close();
    });
});
