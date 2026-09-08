import * as net from 'net';
import { randomUUID } from 'crypto';
import { attachFrameReader, encodeFrame, PROTOCOL_VERSION, type BrokerMessage } from './protocol';
import { AuthExchange, authDelegateForExchange, type AcquireParams } from './authExchange';
import {
    attachLease,
    closeMaster,
    createMaster,
    detachLease,
    markCloseWhenIdle,
    scheduleIdleExpiry,
    type SharedMaster,
} from './master';
import { MasterRegistry, SharingIdentityOccupiedError, defaultPersist } from './registry';
import { bindControlSocket, bindDataSocket, controlSocketPath, prepareRuntimeDir, RuntimeSecurityError } from './runtime';
import type { AuthResponse, TransportConnector } from './transport';
import { connectSshTransport } from './sshTransport';

export type BrokerServer = {
    runtimeDir: string;
    closed: Promise<void>;
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
    schedule?: (delayMs: number, fn: () => void) => ReturnType<typeof setTimeout>;
};

export async function startBroker(options: StartBrokerOptions): Promise<BrokerServer> {
    await prepareRuntimeDir(options.runtimeDir, { uid: options.uid });
    const socketPath = controlSocketPath(options.runtimeDir);
    const registry = new MasterRegistry();
    const version = options.protocolVersion ?? PROTOCOL_VERSION;
    const server = await bindControlSocket(socketPath);
    let activeClients = 0;
    let closing = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
    });
    server.once('close', resolveClosed);

    const closeServer = () => {
        if (closing || !server.listening) {
            return;
        }
        closing = true;
        server.close();
    };
    const stopWhenUnused = () => {
        if (activeClients === 0 && registry.size === 0) {
            closeServer();
        }
    };

    server.on('connection', (socket) => {
        activeClients += 1;
        handleClient(socket, {
            version,
            runtimeDir: options.runtimeDir,
            registry,
            connectTransport: options.connectTransport ?? connectSshTransport,
            schedule: options.schedule ?? ((delayMs, fn) => setTimeout(fn, delayMs)),
            onRegistryChange: stopWhenUnused,
            onClientClose: () => {
                activeClients = Math.max(0, activeClients - 1);
                stopWhenUnused();
            },
        });
    });

    return {
        runtimeDir: options.runtimeDir,
        closed,
        close() {
            closeServer();
            return closed;
        },
    };
}

function handleClient(
    socket: net.Socket,
    context: {
        version: number;
        runtimeDir: string;
        registry: MasterRegistry;
        connectTransport: TransportConnector;
        schedule: (delayMs: number, fn: () => void) => ReturnType<typeof setTimeout>;
        onRegistryChange: () => void;
        onClientClose: () => void;
    },
): void {
    let helloDone = false;
    let clientClosed = false;
    const authExchange = new AuthExchange();
    const ownedLeases = new Map<string, { identity: string; leaseId: string }>();

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

    socket.on('close', () => {
        if (clientClosed) {
            return;
        }
        clientClosed = true;
        authExchange.cancelAll(new Error('Client disconnected'));
        void Promise.all([...ownedLeases.values()].map(({ identity, leaseId }) => releaseLease(identity, leaseId)))
            .finally(context.onClientClose);
    });

    async function releaseLease(identity: string, leaseId: string): Promise<void> {
        ownedLeases.delete(leaseId);
        const master = context.registry.get(identity);
        if (!master) {
            return;
        }
        const lease = detachLease(master, leaseId);
        if (!lease) {
            return;
        }
        await Promise.allSettled(lease.tunnelNames.map((tunnelName) => master.connection.closeTunnel(tunnelName)));
        await Promise.allSettled(lease.resources.map((close) => close()));
        scheduleIdleExpiry(master, () => {
            void closeMaster(master).finally(() => {
                context.registry.delete(identity, master);
                context.onRegistryChange();
            });
        }, context.schedule);
    }

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
                const create = async () => {
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
                    connection.on('ssh:disconnect', () => {
                        if (created.state === 'closing' || created.state === 'failed') {
                            return;
                        }
                        void closeMaster(created).finally(() => {
                            context.registry.delete(acquire.identity, created);
                            context.onRegistryChange();
                        });
                    });
                    return created;
                };
                const master = acquire.action === 'create'
                    ? await context.registry.createExclusive(acquire.identity, create)
                    : await context.registry.getOrCreate(acquire.identity, create);
                if (clientClosed) {
                    scheduleIdleExpiry(master, () => {
                        void closeMaster(master).finally(() => {
                            context.registry.delete(acquire.identity, master);
                            context.onRegistryChange();
                        });
                    }, context.schedule);
                    throw new BrokerDispatchError('client', 'Client disconnected during acquire');
                }
                const leaseId = randomUUID();
                attachLease(master, leaseId);
                ownedLeases.set(leaseId, { identity: master.identity, leaseId });
                return { leaseId, identity: master.identity, state: master.state };
            }
            case 'exec':
            case 'exec-partial': {
                const { identity, leaseId, cmd, params: execParams, options } = params as {
                    identity: string;
                    leaseId: string;
                    cmd: string;
                    params?: Array<string>;
                    options?: Parameters<SharedMaster['connection']['exec']>[2];
                };
                const master = requireActiveLease(context.registry, identity, leaseId);
                return master.connection.exec(cmd, execParams, options);
            }
            case 'exec-channel': {
                const { identity, leaseId, cmd, options } = params as {
                    identity: string;
                    leaseId: string;
                    cmd: string;
                    options?: Parameters<SharedMaster['connection']['execChannel']>[1];
                };
                const master = requireActiveLease(context.registry, identity, leaseId);
                const channel = await master.connection.execChannel(cmd, options);
                const token = randomUUID();
                const dataEndpoint = await bindDataSocket(context.runtimeDir, `channel-${token}.sock`);
                const stderrEndpoint = await bindDataSocket(context.runtimeDir, `channel-${token}-stderr.sock`);
                const close = async () => {
                    channel.close();
                    await Promise.all([dataEndpoint.close(), stderrEndpoint.close()]);
                };
                master.leases.get(leaseId)?.resources.push(close);
                void dataEndpoint.connected.then((dataSocket) => {
                    dataSocket.pipe(channel);
                    channel.pipe(dataSocket);
                    dataSocket.once('close', () => channel.close());
                    channel.once('close', () => dataSocket.destroy());
                });
                void stderrEndpoint.connected.then((stderrSocket) => {
                    channel.stderr.pipe(stderrSocket);
                    channel.once('close', () => stderrSocket.destroy());
                });
                return {
                    socketPath: dataEndpoint.socketPath,
                    stderrSocketPath: stderrEndpoint.socketPath,
                };
            }
            case 'forward-out': {
                const { identity, leaseId, srcIP, srcPort, destIP, destPort } = params as {
                    identity: string;
                    leaseId: string;
                    srcIP: string;
                    srcPort: number;
                    destIP: string;
                    destPort: number;
                };
                const master = requireActiveLease(context.registry, identity, leaseId);
                const channel = await master.connection.forwardOut(srcIP, srcPort, destIP, destPort);
                const endpoint = await bindDataSocket(context.runtimeDir, `forward-${randomUUID()}.sock`);
                const close = async () => {
                    channel.close();
                    await endpoint.close();
                };
                master.leases.get(leaseId)?.resources.push(close);
                void endpoint.connected.then((dataSocket) => {
                    dataSocket.pipe(channel);
                    channel.pipe(dataSocket);
                    dataSocket.once('close', () => channel.close());
                    channel.once('close', () => dataSocket.destroy());
                });
                return { socketPath: endpoint.socketPath };
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
                await releaseLease(identity, leaseId);
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
                        void closeMaster(master).finally(() => {
                            context.registry.delete(masterIdentity, master);
                            context.onRegistryChange();
                        });
                    }, context.schedule);
                    return { closed: false, whenIdle: true };
                }
                await closeMaster(master);
                context.registry.delete(masterIdentity, master);
                context.onRegistryChange();
                return { closed: true };
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
    if (err instanceof SharingIdentityOccupiedError) {
        return 'occupied';
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
