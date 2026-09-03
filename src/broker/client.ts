import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import * as net from 'net';
import { attachFrameReader, encodeFrame, PROTOCOL_VERSION, type BrokerMessage } from './protocol';
import { controlSocketPath } from './runtime';

export class ProtocolMismatchError extends Error {
    constructor(readonly serverVersion: number, clientVersion = PROTOCOL_VERSION) {
        super(`Broker protocol mismatch: client ${clientVersion}, server ${serverVersion}`);
        this.name = 'ProtocolMismatchError';
    }
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export type ConnectBrokerOptions = {
    runtimeDir: string;
    execPath: string;
    brokerScript: string;
    spawn?: SpawnFn;
    detached?: boolean;
    helloVersion?: number;
    connectTimeoutMs?: number;
};

export class BrokerClient {
    private nextId = 1;
    private readonly pending = new Map<number, {
        resolve: (value: unknown) => void;
        reject: (err: Error) => void;
    }>();
    private helloWaiter: {
        resolve: () => void;
        reject: (err: Error) => void;
        version: number;
    } | undefined;

    private constructor(private readonly socket: net.Socket) {
        attachFrameReader(socket, (message) => this.onMessage(message));
        socket.on('error', (err) => this.rejectAll(err));
        socket.on('close', () => this.rejectAll(new Error('Broker control connection closed')));
    }

    static async connect(options: ConnectBrokerOptions): Promise<BrokerClient> {
        const socketPath = controlSocketPath(options.runtimeDir);
        const timeoutMs = options.connectTimeoutMs ?? 5000;
        let socket = await tryConnect(socketPath);

        if (!socket) {
            launchBroker(options);
            socket = await waitForConnect(socketPath, timeoutMs);
        }

        const client = new BrokerClient(socket);
        try {
            await client.handshake(options.helloVersion ?? PROTOCOL_VERSION);
            return client;
        } catch (err) {
            await client.close();
            throw err;
        }
    }

    request(method: string, params: unknown = {}): Promise<unknown> {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.socket.write(encodeFrame({ type: 'req', id, method, params }));
        });
    }

    close(): Promise<void> {
        this.rejectAll(new Error('Broker client closed'));
        return new Promise((resolve) => {
            this.socket.end(() => resolve());
        });
    }

    private handshake(version: number): Promise<void> {
        return new Promise((resolve, reject) => {
            this.helloWaiter = { resolve, reject, version };
            this.socket.write(encodeFrame({ type: 'hello', version }));
        });
    }

    private onMessage(message: BrokerMessage): void {
        if (message.type === 'hello-ok') {
            this.helloWaiter?.resolve();
            this.helloWaiter = undefined;
            return;
        }
        if (message.type === 'hello-mismatch') {
            const waiter = this.helloWaiter;
            this.helloWaiter = undefined;
            waiter?.reject(new ProtocolMismatchError(message.version, waiter.version));
            return;
        }
        if (message.type !== 'res') {
            return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) {
            return;
        }
        this.pending.delete(message.id);
        if (message.error) {
            pending.reject(new Error(message.error.message));
            return;
        }
        pending.resolve(message.result);
    }

    private rejectAll(err: Error): void {
        if (this.helloWaiter) {
            this.helloWaiter.reject(err);
            this.helloWaiter = undefined;
        }
        for (const pending of this.pending.values()) {
            pending.reject(err);
        }
        this.pending.clear();
    }
}

function launchBroker(options: ConnectBrokerOptions): void {
    const spawnFn = options.spawn ?? spawn;
    const child = spawnFn(options.execPath, [options.brokerScript], {
        detached: options.detached ?? true,
        stdio: 'ignore',
        env: {
            ...process.env,
            OPEN_REMOTE_SSH_BROKER_RUNTIME: options.runtimeDir,
        },
    });
    if (options.detached ?? true) {
        child.unref();
    }
}

function tryConnect(socketPath: string): Promise<net.Socket | undefined> {
    return new Promise((resolve) => {
        const socket = net.connect(socketPath);
        const fail = () => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(undefined);
        };
        socket.once('connect', () => {
            socket.removeListener('error', fail);
            resolve(socket);
        });
        socket.once('error', fail);
    });
}

async function waitForConnect(socketPath: string, timeoutMs: number): Promise<net.Socket> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const socket = await tryConnect(socketPath);
        if (socket) {
            return socket;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for broker at ${socketPath}`);
}
