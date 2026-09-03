import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { bindControlSocket, prepareRuntimeDir } from '../../src/broker/runtime';

const dirs: string[] = [];

afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })));
});

describe('prepareRuntimeDir', () => {
    it('creates a current-user-owned 0700 runtime directory', async () => {
        const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'orss-broker-'));
        dirs.push(dir);
        const runtimeDir = path.join(dir, 'run');

        await prepareRuntimeDir(runtimeDir, { uid: process.getuid() });

        const stat = await fs.promises.lstat(runtimeDir);
        expect(stat.isDirectory()).toBe(true);
        expect(stat.uid).toBe(process.getuid());
        expect(stat.mode & 0o777).toBe(0o700);
    });

    it('rejects a runtime path that is a symlink', async () => {
        const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'orss-broker-'));
        dirs.push(dir);
        const target = path.join(dir, 'target');
        const runtimeDir = path.join(dir, 'run');
        await fs.promises.mkdir(target, { mode: 0o700 });
        await fs.promises.symlink(target, runtimeDir);

        await expect(prepareRuntimeDir(runtimeDir, { uid: process.getuid() }))
            .rejects.toThrow(/symlink/i);
    });

    it('rejects a runtime directory with a permissive mode', async () => {
        const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'orss-broker-'));
        dirs.push(dir);
        const runtimeDir = path.join(dir, 'run');
        await fs.promises.mkdir(runtimeDir, { mode: 0o777 });
        await fs.promises.chmod(runtimeDir, 0o777);

        await expect(prepareRuntimeDir(runtimeDir, { uid: process.getuid() }))
            .rejects.toThrow(/0700/);
    });

    it('rejects a runtime directory owned by a different user', async () => {
        const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'orss-broker-'));
        dirs.push(dir);
        const runtimeDir = path.join(dir, 'run');
        await fs.promises.mkdir(runtimeDir, { mode: 0o700 });
        await fs.promises.chmod(runtimeDir, 0o700);

        await expect(prepareRuntimeDir(runtimeDir, { uid: process.getuid() + 1 }))
            .rejects.toThrow(/owned by the current user/);
    });
});

describe('bindControlSocket', () => {
    it('listens on a 0600 unix socket after removing a stale endpoint', async () => {
        const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'orss-broker-'));
        dirs.push(dir);
        await prepareRuntimeDir(dir, { uid: process.getuid() });
        const socketPath = path.join(dir, 'control.sock');

        const stale = net.createServer();
        await new Promise<void>((resolve, reject) => {
            stale.listen(socketPath, () => resolve());
            stale.on('error', reject);
        });
        await new Promise<void>((resolve) => stale.close(() => resolve()));

        const server = await bindControlSocket(socketPath);
        try {
            const stat = await fs.promises.lstat(socketPath);
            expect(stat.isSocket()).toBe(true);
            expect(stat.mode & 0o777).toBe(0o600);
        } finally {
            server.close();
        }
    });

    it('does not unlink a live control socket', async () => {
        const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'orss-broker-'));
        dirs.push(dir);
        await prepareRuntimeDir(dir, { uid: process.getuid() });
        const socketPath = path.join(dir, 'control.sock');

        const live = await bindControlSocket(socketPath);
        try {
            await expect(bindControlSocket(socketPath)).rejects.toThrow(/already/i);
            expect((await fs.promises.lstat(socketPath)).isSocket()).toBe(true);
        } finally {
            live.close();
        }
    });
});
