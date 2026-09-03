import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

export const CONTROL_SOCKET_NAME = 'control.sock';

export function controlSocketPath(runtimeDir: string): string {
    return path.join(runtimeDir, CONTROL_SOCKET_NAME);
}

export class RuntimeSecurityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RuntimeSecurityError';
    }
}

export type PrepareRuntimeDirOptions = {
    uid: number;
};

export async function prepareRuntimeDir(dir: string, options: PrepareRuntimeDirOptions): Promise<void> {
    let stat: fs.Stats | undefined;
    try {
        stat = await fs.promises.lstat(dir);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw err;
        }
    }

    if (!stat) {
        await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
        await fs.promises.chmod(dir, 0o700);
        stat = await fs.promises.lstat(dir);
    }

    assertSecureRuntimeDir(dir, stat, options.uid);
}

export async function bindControlSocket(socketPath: string): Promise<net.Server> {
    await removeStaleSocket(socketPath);

    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ path: socketPath, exclusive: true }, () => resolve());
    });
    await fs.promises.chmod(socketPath, 0o600);
    return server;
}

async function removeStaleSocket(socketPath: string): Promise<void> {
    let stat: fs.Stats;
    try {
        stat = await fs.promises.lstat(socketPath);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return;
        }
        throw err;
    }

    if (stat.isSymbolicLink()) {
        throw new RuntimeSecurityError(`Broker control socket must not be a symlink: ${socketPath}`);
    }
    if (!stat.isSocket()) {
        throw new RuntimeSecurityError(`Broker control path is not a socket: ${socketPath}`);
    }

    if (await isLiveUnixSocket(socketPath)) {
        throw new RuntimeSecurityError(`Broker control socket is already in use: ${socketPath}`);
    }

    await fs.promises.unlink(socketPath);
}

function isLiveUnixSocket(socketPath: string): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect(socketPath);
        const finish = (live: boolean) => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(live);
        };
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
    });
}

function assertSecureRuntimeDir(dir: string, stat: fs.Stats, uid: number): void {
    if (stat.isSymbolicLink()) {
        throw new RuntimeSecurityError(`Broker runtime directory must not be a symlink: ${dir}`);
    }
    if (!stat.isDirectory()) {
        throw new RuntimeSecurityError(`Broker runtime path is not a directory: ${dir}`);
    }
    if (stat.uid !== uid) {
        throw new RuntimeSecurityError(`Broker runtime directory must be owned by the current user: ${dir}`);
    }
    if ((stat.mode & 0o777) !== 0o700) {
        throw new RuntimeSecurityError(`Broker runtime directory must have mode 0700: ${dir}`);
    }
}
