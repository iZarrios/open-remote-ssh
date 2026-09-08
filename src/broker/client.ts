import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import * as net from 'net';
import type { ClientChannel, ExecOptions } from 'ssh2';
import type { PersistPolicy, SharingAction } from '../ssh/sharingPolicy';
import { attachFrameReader, encodeFrame, PROTOCOL_VERSION, type BrokerMessage, type BrokerMethod } from './protocol';
import { controlSocketPath } from './runtime';
import type { AuthPrompt, AuthResponse, FrozenRoute } from './transport';

export class ProtocolMismatchError extends Error {
    constructor(readonly serverVersion: number, clientVersion = PROTOCOL_VERSION) {
        super(`Broker protocol mismatch: client ${clientVersion}, server ${serverVersion}`);
        this.name = 'ProtocolMismatchError';
    }
}

export class BrokerAuthError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BrokerAuthError';
    }
}

export class BrokerInfrastructureError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BrokerInfrastructureError';
    }
}

export class BrokerRequestError extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
        this.name = 'BrokerRequestError';
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

export type AcquireOptions = {
    identity: string;
    route: FrozenRoute;
    persist?: PersistPolicy;
    action?: SharingAction;
    onAuthPrompt: (prompt: AuthPrompt) => Promise<AuthResponse>;
};

export type AcquireLease = {
    leaseId: string;
    identity: string;
    state: string;
};

type PendingRequest = {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    onAuthPrompt?: (prompt: AuthPrompt) => Promise<AuthResponse>;
};

type ExecResult = { stdout: string; stderr: string };
type DataSocketResult = { socketPath: string };

export class BrokerClient {
    private nextId = 1;
    private readonly pending = new Map<number, PendingRequest>();
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
            const child = launchBroker(options);
            socket = await Promise.race([
                waitForConnect(socketPath, timeoutMs),
                new Promise<never>((_resolve, reject) => child.once('error', reject)),
            ]);
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

    static async connectExisting(options: Pick<ConnectBrokerOptions, 'runtimeDir' | 'helloVersion'>): Promise<BrokerClient | undefined> {
        const socket = await tryConnect(controlSocketPath(options.runtimeDir));
        if (!socket) {
            return undefined;
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

    request<T = unknown>(method: BrokerMethod, params: unknown = {}): Promise<T> {
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
            this.socket.write(encodeFrame({ type: 'req', id, method, params }));
        });
    }

    acquire(options: AcquireOptions): Promise<AcquireLease> {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, {
                resolve: (value) => resolve(value as AcquireLease),
                reject,
                onAuthPrompt: options.onAuthPrompt,
            });
            this.socket.write(encodeFrame({
                type: 'req',
                id,
                method: 'acquire',
                params: {
                    identity: options.identity,
                    route: options.route,
                    persist: options.persist,
                    action: options.action,
                },
            }));
        });
    }

    release(leaseId: string, identity: string): Promise<void> {
        return this.request('release', { leaseId, identity }).then(() => undefined);
    }

    exec(leaseId: string, identity: string, cmd: string, params?: Array<string>, options?: ExecOptions): Promise<ExecResult> {
        return this.request<ExecResult>('exec', { leaseId, identity, cmd, params, options });
    }

    execPartial(
        leaseId: string,
        identity: string,
        cmd: string,
        tester: (stdout: string, stderr: string) => boolean,
        params?: Array<string>,
        options?: ExecOptions,
    ): Promise<ExecResult> {
        const command = cmd + (Array.isArray(params) ? ` ${params.join(' ')}` : '');
        return this.execChannel(leaseId, identity, command, options).then((channel) => new Promise((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            let resolved = false;
            const finish = () => {
                if (resolved) {
                    return;
                }
                resolved = true;
                resolve({ stdout, stderr });
            };
            const test = () => {
                if (tester(stdout, stderr)) {
                    finish();
                }
            };
            channel.on('data', (data: Buffer | string) => {
                stdout += data.toString();
                test();
            });
            channel.stderr.on('data', (data: Buffer | string) => {
                stderr += data.toString();
                test();
            });
            channel.once('close', finish);
            channel.once('error', reject);
        }));
    }

    async execChannel(
        leaseId: string,
        identity: string,
        cmd: string,
        options?: ExecOptions,
    ): Promise<ClientChannel> {
        const result = await this.request<{
            socketPath: string;
            stderrSocketPath: string;
        }>('exec-channel', { leaseId, identity, cmd, options });
        const [channelSocket, stderrSocket] = await Promise.all([
            connectDataSocket(result.socketPath),
            connectDataSocket(result.stderrSocketPath),
        ]);
        const close = () => {
            channelSocket.destroy();
            stderrSocket.destroy();
        };
        Object.defineProperties(channelSocket, {
            stderr: { value: stderrSocket, enumerable: true },
            close: { value: close },
            eof: { value: () => channelSocket.end() },
        });
        return channelSocket as unknown as ClientChannel;
    }

    async forwardOut(
        leaseId: string,
        identity: string,
        srcIP: string,
        srcPort: number,
        destIP: string,
        destPort: number,
    ): Promise<ClientChannel> {
        const result = await this.request<DataSocketResult>('forward-out', {
            leaseId,
            identity,
            srcIP,
            srcPort,
            destIP,
            destPort,
        });
        const socket = await connectDataSocket(result.socketPath);
        Object.defineProperties(socket, {
            close: { value: () => socket.destroy() },
            eof: { value: () => socket.end() },
        });
        return socket as unknown as ClientChannel;
    }

    addTunnel(leaseId: string, identity: string, config: unknown): Promise<{ name: string; localPort?: number }> {
        return this.request<{ name: string; localPort?: number }>('add-tunnel', { leaseId, identity, config });
    }

    closeTunnel(leaseId: string, identity: string, name?: string): Promise<void> {
        return this.request('close-tunnel', { leaseId, identity, name }).then(() => undefined);
    }

    list(): Promise<{ masters: import('./registry').MasterSummary[] }> {
        return this.request<{ masters: import('./registry').MasterSummary[] }>('list');
    }

    closeMaster(identity: string, options: { whenIdle?: boolean } = {}): Promise<{ closed: boolean; whenIdle?: boolean }> {
        return this.request<{ closed: boolean; whenIdle?: boolean }>('close', { identity, whenIdle: options.whenIdle });
    }

    close(): Promise<void> {
        this.rejectAll(new Error('Broker client closed'));
        if (this.socket.destroyed) {
            return Promise.resolve();
        }
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
        if (message.type === 'event' && message.name === 'auth-prompt') {
            void this.handleAuthPrompt(message);
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
            if (message.error.code === 'auth') {
                pending.reject(new BrokerAuthError(message.error.message));
                return;
            }
            if (message.error.code === 'runtime') {
                pending.reject(new BrokerInfrastructureError(message.error.message));
                return;
            }
            pending.reject(new BrokerRequestError(message.error.code, message.error.message));
            return;
        }
        pending.resolve(message.result);
    }

    private async handleAuthPrompt(message: BrokerMessage & { type: 'event' }): Promise<void> {
        const acquireId = message.id;
        if (acquireId === undefined) {
            return;
        }
        const pending = this.pending.get(acquireId);
        if (!pending?.onAuthPrompt) {
            return;
        }
        const payload = message.payload as { promptId: string; prompt: AuthPrompt };
        try {
            const response = await pending.onAuthPrompt(payload.prompt);
            await this.request('auth-response', { promptId: payload.promptId, response });
        } catch (err) {
            pending.reject(err instanceof Error ? err : new Error(String(err)));
            this.pending.delete(acquireId);
        }
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

function launchBroker(options: ConnectBrokerOptions): ChildProcess {
    const spawnFn = options.spawn ?? spawn;
    const child = spawnFn(options.execPath, [options.brokerScript], {
        detached: options.detached ?? true,
        stdio: 'ignore',
        env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            OPEN_REMOTE_SSH_BROKER_RUNTIME: options.runtimeDir,
        },
    });
    if (options.detached ?? true) {
        child.unref();
    }
    return child;
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

function connectDataSocket(socketPath: string): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(socketPath);
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
    });
}
