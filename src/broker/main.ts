import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { attachFrameReader, encodeFrame, PROTOCOL_VERSION, type BrokerMessage } from './protocol';
import { AuthExchange, authDelegateForExchange, type AcquireParams } from './authExchange';
import {
    attachLease,
    closeMaster,
    createMaster,
    detachLease,
    failMaster,
    markCloseWhenIdle,
    scheduleIdleExpiry,
    type SharedMaster,
} from './master';
import { MasterRegistry, defaultPersist } from './registry';
import { bindControlSocket, controlSocketPath, prepareRuntimeDir, RuntimeSecurityError } from './runtime';
import type { AuthResponse, TransportConnector } from './transport';
import { connectSshTransport } from './sshTransport';

export type BrokerServer = {
    runtimeDir: string;
    close(): Promise<void>;
};

export class BrokerDispatchError extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
        this.name = 'BrokerDispatchError';
    }
}

export type StartBrokerOptions = {
    runtimeDir: string;
    uid: number;
    protocolVersion?: number;
    connectTransport?: TransportConnector;
    onStream?: (socket: net.Socket) => void;
    schedule?: (delayMs: number, fn: () => void) => ReturnType<typeof setTimeout>;
};

export async function startBroker(options: StartBrokerOptions): Promise<BrokerServer> {
    await prepareRuntimeDir(options.runtimeDir, { uid: options.uid });
    const socketPath = controlSocketPath(options.runtimeDir);
    const registry = new MasterRegistry();
    const version = options.protocolVersion ?? PROTOCOL_VERSION;
    const server = await bindControlSocket(socketPath);

    server.on('connection', (socket) => {
        handleClient(socket, {
            version,
            runtimeDir: options.runtimeDir,
            registry,
            connectTransport: options.connectTransport ?? connectSshTransport,
            onStream: options.onStream ?? echoStream,
            schedule: options.schedule ?? ((delayMs, fn) => setTimeout(fn, delayMs)),
        });
    });

    return {
        runtimeDir: options.runtimeDir,
        close() {
            return new Promise((resolve) => {
                server.close(() => resolve());
            });
        },
    };
}

function echoStream(socket: net.Socket): void {
    socket.pipe(socket);
}

function handleClient(
    socket: net.Socket,
    context: {
        version: number;
        runtimeDir: string;
        registry: MasterRegistry;
        connectTransport: TransportConnector;
        onStream: (socket: net.Socket) => void;
        schedule: (delayMs: number, fn: () => void) => ReturnType<typeof setTimeout>;
    },
): void {
    let helloDone = false;
    const authExchange = new AuthExchange();

    const send = (message: BrokerMessage) => {
        if (!socket.writable) {
            return;
        }
        socket.write(encodeFrame(message));
    };

    attachFrameReader(socket, (message) => {
        void handleMessage(message).catch((err) => {
            send({
                type: 'res',
                id: 'id' in message ? Number(message.id) : 0,
                error: { code: 'internal', message: err instanceof Error ? err.message : String(err) },
            });
        });
    });

    socket.on('close', () => authExchange.cancelAll(new Error('Client disconnected')));

    async function handleMessage(message: BrokerMessage): Promise<void> {
        if (message.type === 'hello') {
            if (message.version !== context.version) {
                send({ type: 'hello-mismatch', version: context.version });
                return;
            }
            helloDone = true;
            send({ type: 'hello-ok', version: context.version });
            return;
        }

        if (!helloDone || message.type !== 'req') {
            return;
        }

        try {
            const result = await dispatch(message.method, message.params, message.id);
            send({ type: 'res', id: message.id, result });
        } catch (err) {
            const code = classifyError(err);
            send({
                type: 'res',
                id: message.id,
                error: { code, message: err instanceof Error ? err.message : String(err) },
            });
        }
    }

    async function dispatch(method: string, params: unknown, requestId: number): Promise<unknown> {
        switch (method) {
            case 'list':
                return { masters: context.registry.list() };
            case 'auth-response': {
                const { promptId, response } = params as { promptId: string; response: AuthResponse };
                if (!authExchange.respond(promptId, response)) {
                    throw new Error(`Unknown auth prompt: ${promptId}`);
                }
                return { ok: true };
            }
            case 'acquire': {
                const acquire = params as AcquireParams;
                const persist = acquire.persist ?? defaultPersist();
                const route = acquire.route;
                const existing = context.registry.get(acquire.identity);
                if (existing && existing.state !== 'failed' && existing.state !== 'closing') {
                    if (route.host !== existing.route.host || route.port !== existing.route.port || route.user !== existing.route.user) {
                        throw new BrokerDispatchError('mismatch', 'Sharing identity destination mismatch');
                    }
                    if (acquire.action === 'create') {
                        throw new BrokerDispatchError('occupied', 'Sharing identity is already occupied');
                    }
                } else if (acquire.action === 'attach') {
                    throw new BrokerDispatchError('no-master', 'No existing master for sharing identity');
                }
                const master = await context.registry.getOrCreate(acquire.identity, async () => {
                    const auth = authDelegateForExchange(requestId, authExchange, (event) => {
                        send({
                            type: 'event',
                            id: event.acquireId,
                            name: 'auth-prompt',
                            payload: { promptId: event.promptId, prompt: event.prompt },
                        });
                    });
                    const connection = await context.connectTransport(acquire.identity, route, auth);
                    const created = createMaster(acquire.identity, route, persist, connection);
                    connection.on('ssh:disconnect', () => failMaster(created));
                    return created;
                });
                const leaseId = randomUUID();
                attachLease(master, leaseId);
                return { leaseId, identity: master.identity, state: master.state };
            }
            case 'exec':
            case 'exec-partial': {
                const { identity, leaseId, cmd, params: execParams } = params as {
                    identity: string;
                    leaseId: string;
                    cmd: string;
                    params?: Array<string>;
                };
                const master = requireActiveLease(context.registry, identity, leaseId);
                return master.connection.exec(cmd, execParams);
            }
            case 'add-tunnel': {
                const { identity, leaseId, config } = params as { identity: string; leaseId: string; config: Parameters<SharedMaster['connection']['addTunnel']>[0] };
                const master = requireActiveLease(context.registry, identity, leaseId);
                const handle = await master.connection.addTunnel(config);
                const lease = master.leases.get(leaseId);
                if (lease && handle.name) {
                    lease.tunnelNames.push(handle.name);
                }
                return { name: handle.name, localPort: handle.localPort };
            }
            case 'close-tunnel': {
                const { identity, leaseId, name } = params as { identity: string; leaseId: string; name?: string };
                const master = requireActiveLease(context.registry, identity, leaseId);
                await master.connection.closeTunnel(name);
                return { closed: true };
            }
            case 'release': {
                const { identity, leaseId } = params as { identity: string; leaseId: string };
                const master = context.registry.get(identity);
                if (!master) {
                    throw new Error(`Unknown master: ${identity}`);
                }
                const lease = detachLease(master, leaseId);
                if (lease) {
                    for (const tunnelName of lease.tunnelNames) {
                        await master.connection.closeTunnel(tunnelName);
                    }
                }
                scheduleIdleExpiry(master, () => {
                    void closeMaster(master).finally(() => context.registry.delete(identity));
                }, context.schedule);
                return { released: true };
            }
            case 'close': {
                const { identity, whenIdle } = params as { identity?: string; whenIdle?: boolean };
                const masterIdentity = String(identity || '');
                const master = context.registry.get(masterIdentity);
                if (!master) {
                    return { closed: false };
                }
                if (whenIdle) {
                    markCloseWhenIdle(master);
                    scheduleIdleExpiry(master, () => {
                        void closeMaster(master).finally(() => context.registry.delete(masterIdentity));
                    }, context.schedule);
                    return { closed: false, whenIdle: true };
                }
                await closeMaster(master);
                context.registry.delete(masterIdentity);
                return { closed: true };
            }
            case 'open-stream': {
                const streamPath = path.join(context.runtimeDir, `stream-${randomUUID()}.sock`);
                const streamServer = net.createServer();
                await new Promise<void>((resolve, reject) => {
                    streamServer.once('error', reject);
                    streamServer.listen({ path: streamPath, exclusive: true }, () => resolve());
                });
                await fs.promises.chmod(streamPath, 0o600);
                streamServer.once('connection', (streamSocket) => {
                    streamServer.close();
                    fs.promises.unlink(streamPath).catch(() => undefined);
                    context.onStream(streamSocket);
                });
                return { socketPath: streamPath };
            }
            default:
                throw new Error(`Unknown method ${method}`);
        }
    }
}

function requireActiveLease(registry: MasterRegistry, identity: string, leaseId: string) {
    const master = registry.get(identity);
    if (!master || master.state === 'failed' || master.state === 'closing') {
        throw new BrokerDispatchError('transport', 'transport failed');
    }
    if (!master.leases.has(leaseId)) {
        throw new BrokerDispatchError('lease', 'Unknown lease');
    }
    return master;
}

function classifyError(err: unknown): string {
    if (err instanceof BrokerDispatchError) {
        return err.code;
    }
    if (err instanceof RuntimeSecurityError) {
        return 'runtime';
    }
    if (err instanceof Error && /auth/i.test(err.message)) {
        return 'auth';
    }
    return 'request';
}

function runFromEnv(): void {
    const runtimeDir = process.env.OPEN_REMOTE_SSH_BROKER_RUNTIME;
    if (!runtimeDir) {
        process.stderr.write('OPEN_REMOTE_SSH_BROKER_RUNTIME is required\n');
        process.exit(1);
    }

    startBroker({
        runtimeDir,
        uid: process.getuid!(),
        connectTransport: connectSshTransport,
    }).catch((err) => {
        process.stderr.write(`${err instanceof Error ? err.stack || err.message : String(err)}\n`);
        process.exit(1);
    });
}

if (typeof require !== 'undefined' && require.main === module) {
    runFromEnv();
}
