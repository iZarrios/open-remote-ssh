import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { attachFrameReader, encodeFrame, PROTOCOL_VERSION, type BrokerMessage } from './protocol';
import { MasterRegistry } from './registry';
import { bindControlSocket, controlSocketPath, prepareRuntimeDir, RuntimeSecurityError } from './runtime';

export type BrokerServer = {
    runtimeDir: string;
    close(): Promise<void>;
};

export type StartBrokerOptions = {
    runtimeDir: string;
    uid: number;
    protocolVersion?: number;
    onStream?: (socket: net.Socket) => void;
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
            onStream: options.onStream ?? echoStream,
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
        onStream: (socket: net.Socket) => void;
    },
): void {
    let helloDone = false;

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
            const result = await dispatch(message.method, message.params);
            send({ type: 'res', id: message.id, result });
        } catch (err) {
            const code = err instanceof RuntimeSecurityError ? 'runtime' : 'request';
            send({
                type: 'res',
                id: message.id,
                error: { code, message: err instanceof Error ? err.message : String(err) },
            });
        }
    }

    async function dispatch(method: string, params: unknown): Promise<unknown> {
        switch (method) {
            case 'list':
                return { masters: context.registry.list() };
            case 'acquire': {
                const identity = String((params as { identity?: string })?.identity || '');
                const record = await context.registry.getOrCreate(identity, async () => ({
                    identity,
                    state: 'ready',
                    leaseCount: 0,
                }));
                record.leaseCount += 1;
                record.state = 'ready';
                return { identity: record.identity, state: record.state, leaseCount: record.leaseCount };
            }
            case 'close': {
                const identity = String((params as { identity?: string })?.identity || '');
                context.registry.delete(identity);
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

function runFromEnv(): void {
    const runtimeDir = process.env.OPEN_REMOTE_SSH_BROKER_RUNTIME;
    if (!runtimeDir) {
        process.stderr.write('OPEN_REMOTE_SSH_BROKER_RUNTIME is required\n');
        process.exit(1);
    }

    startBroker({
        runtimeDir,
        uid: process.getuid!(),
    }).catch((err) => {
        process.stderr.write(`${err instanceof Error ? err.stack || err.message : String(err)}\n`);
        process.exit(1);
    });
}

if (typeof require !== 'undefined' && require.main === module) {
    runFromEnv();
}
