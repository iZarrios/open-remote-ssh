import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrokerClient } from '../../src/broker/client';
import { startBroker, type BrokerServer } from '../../src/broker/main';
import type { AuthPrompt, AuthResponse, FrozenRoute } from '../../src/broker/transport';
import { runDocker } from '../utils/run-docker';
import { getMappedPort } from '../utils/get-mapped-port';
import { waitForSSHReady } from '../utils/wait-for-ssh-ready';
import { waitForKeyboardInteractiveSSHReady } from '../utils/wait-for-keyboard-interactive-ssh-ready';
import { sleep } from '../utils/sleep';

const USER = 'openremotessh';
const PASSWORD = 'openremotessh';
const JUMP_IMAGE = 'local-ubuntu-bash';
const MFA_IMAGE = 'local-ubuntu-mfa';

const networkName = `orss-e2e-${randomUUID()}`;
const jumpName = `orss-jump-${randomUUID()}`;
const mfaName = `orss-mfa-${randomUUID()}`;

let jumpPort = 0;
let mfaPort = 0;
let runtimeDir = '';
let broker: BrokerServer | undefined;

/** Independent successful-auth counter from sshd (not the broker). */
function dockerAuthCount(): number {
    const result = spawnSync('docker', ['logs', mfaName], { encoding: 'utf8' });
    const logs = `${result.stdout || ''}${result.stderr || ''}`;
    const matches = logs.match(/Accepted keyboard-interactive/g);
    return matches?.length ?? 0;
}

function authHandler(prompts: { count: number; kinds: string[] }) {
    return async (prompt: AuthPrompt): Promise<AuthResponse> => {
        prompts.count += 1;
        prompts.kinds.push(prompt.kind);
        if (prompt.kind === 'password') {
            return { kind: 'password', password: PASSWORD };
        }
        if (prompt.kind === 'keyboard-interactive') {
            return { kind: 'keyboard-interactive', answers: prompt.prompts.map(() => PASSWORD) };
        }
        if (prompt.kind === 'hostkey') {
            return { kind: 'hostkey', accept: true };
        }
        throw new Error(`unexpected prompt ${prompt.kind}`);
    };
}

async function connectClient() {
    return BrokerClient.connect({
        runtimeDir,
        execPath: process.execPath,
        brokerScript: '',
        spawn: () => { throw new Error('broker already running'); },
    });
}

function jumpRoute(): FrozenRoute {
    return {
        host: 'target',
        port: 2222,
        user: USER,
        originalHostname: 'target',
        preferredAuthentications: ['password', 'keyboard-interactive'],
        connectTimeoutMs: 60_000,
        hostConfig: {
            ProxyJump: 'jump',
            PreferredAuthentications: 'password,keyboard-interactive',
            IdentitiesOnly: 'yes',
        },
        jumpHostConfigs: {
            jump: {
                HostName: '127.0.0.1',
                Port: String(jumpPort),
                User: USER,
                PreferredAuthentications: 'password',
                IdentitiesOnly: 'yes',
            },
        },
    };
}

function proxyCommandRoute(): FrozenRoute {
    return {
        host: '127.0.0.1',
        port: mfaPort,
        user: USER,
        originalHostname: 'mfa',
        preferredAuthentications: ['keyboard-interactive'],
        connectTimeoutMs: 60_000,
        hostConfig: {
            ProxyCommand: `nc %h %p`,
            PreferredAuthentications: 'keyboard-interactive',
            IdentitiesOnly: 'yes',
        },
    };
}

function directMfaRoute(): FrozenRoute {
    return {
        host: '127.0.0.1',
        port: mfaPort,
        user: USER,
        originalHostname: 'mfa',
        preferredAuthentications: ['keyboard-interactive'],
        connectTimeoutMs: 60_000,
        hostConfig: {
            PreferredAuthentications: 'keyboard-interactive',
            IdentitiesOnly: 'yes',
        },
    };
}

beforeAll(async () => {
    runDocker(['network', 'create', networkName], true);
    runDocker(['rm', '-f', jumpName, mfaName], true);

    runDocker([
        'run', '--detach', '--rm',
        '--name', jumpName,
        '--network', networkName,
        '--network-alias', 'jump',
        '--publish', '2222',
        '--env', `USER_NAME=${USER}`,
        '--env', `USER_PASSWORD=${PASSWORD}`,
        '--env', 'PASSWORD_ACCESS=true',
        '--env', 'SUDO_ACCESS=false',
        '--env', 'LOG_STDOUT=true',
        JUMP_IMAGE,
    ]);

    runDocker([
        'run', '--detach', '--rm',
        '--name', mfaName,
        '--network', networkName,
        '--network-alias', 'target',
        '--publish', '2222',
        '--env', `USER_NAME=${USER}`,
        '--env', `USER_PASSWORD=${PASSWORD}`,
        '--env', 'LOG_STDOUT=true',
        MFA_IMAGE,
    ]);

    jumpPort = getMappedPort(jumpName);
    mfaPort = getMappedPort(mfaName);

    await waitForSSHReady(USER, PASSWORD, jumpPort, 60_000);
    await waitForKeyboardInteractiveSSHReady(USER, PASSWORD, mfaPort, 60_000);

    runtimeDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'orss-e2e-'));
    broker = await startBroker({
        runtimeDir,
        uid: process.getuid(),
    });
}, 180_000);

afterAll(async () => {
    try {
        await Promise.race([
            broker?.close() ?? Promise.resolve(),
            sleep(2_000),
        ]);
    } catch {
        // ignore teardown races while docker containers are removed
    }
    if (runtimeDir) {
        await fs.promises.rm(runtimeDir, { recursive: true, force: true });
    }
    runDocker(['rm', '-f', jumpName, mfaName], true);
    runDocker(['network', 'rm', networkName], true);
}, 60_000);

describe('issue #206 end-to-end connection sharing', () => {
    it('shares one ProxyJump MFA transport across two broker clients', async () => {
        const identity = `proxyjump-mfa-${randomUUID()}`;
        const firstPrompts = { count: 0, kinds: [] as string[] };
        const secondPrompts = { count: 0, kinds: [] as string[] };
        const before = dockerAuthCount();

        const firstClient = await connectClient();
        let secondClient: BrokerClient | undefined;
        try {
            const firstLease = await firstClient.acquire({
                identity,
                route: jumpRoute(),
                persist: { kind: 'indefinite' },
                onAuthPrompt: authHandler(firstPrompts),
            });

            expect(firstPrompts.kinds).toContain('password');
            expect(firstPrompts.kinds).toContain('keyboard-interactive');
            expect(dockerAuthCount()).toBe(before + 1);

            secondClient = await connectClient();
            const secondLease = await secondClient.acquire({
                identity,
                route: jumpRoute(),
                persist: { kind: 'indefinite' },
                onAuthPrompt: authHandler(secondPrompts),
            });

            expect(secondPrompts.count).toBe(0);
            expect(dockerAuthCount()).toBe(before + 1);

            await expect(firstClient.exec(firstLease.leaseId, identity, 'echo', ['jump-share'])).resolves.toEqual({
                stdout: 'jump-share\n',
                stderr: '',
            });
            await expect(secondClient.exec(secondLease.leaseId, identity, 'echo', ['jump-share-2'])).resolves.toEqual({
                stdout: 'jump-share-2\n',
                stderr: '',
            });
            expect(dockerAuthCount()).toBe(before + 1);

            await firstClient.release(firstLease.leaseId, identity);
            await secondClient.release(secondLease.leaseId, identity);
        } finally {
            await firstClient.close().catch(() => undefined);
            await secondClient?.close().catch(() => undefined);
        }
    }, 120_000);

    it('shares one ProxyCommand MFA transport across two broker clients', async () => {
        const identity = `proxycommand-mfa-${randomUUID()}`;
        const firstPrompts = { count: 0, kinds: [] as string[] };
        const secondPrompts = { count: 0, kinds: [] as string[] };
        const before = dockerAuthCount();

        const firstClient = await connectClient();
        let secondClient: BrokerClient | undefined;
        try {
            const firstLease = await firstClient.acquire({
                identity,
                route: proxyCommandRoute(),
                persist: { kind: 'indefinite' },
                onAuthPrompt: authHandler(firstPrompts),
            });

            expect(firstPrompts.kinds).toContain('keyboard-interactive');
            expect(dockerAuthCount()).toBe(before + 1);

            secondClient = await connectClient();
            const secondLease = await secondClient.acquire({
                identity,
                route: proxyCommandRoute(),
                persist: { kind: 'indefinite' },
                onAuthPrompt: authHandler(secondPrompts),
            });

            expect(secondPrompts.count).toBe(0);
            expect(dockerAuthCount()).toBe(before + 1);

            await expect(firstClient.exec(firstLease.leaseId, identity, 'echo', ['pc-share'])).resolves.toEqual({
                stdout: 'pc-share\n',
                stderr: '',
            });
            await expect(secondClient.exec(secondLease.leaseId, identity, 'echo', ['pc-share-2'])).resolves.toEqual({
                stdout: 'pc-share-2\n',
                stderr: '',
            });

            await firstClient.release(firstLease.leaseId, identity);
            await secondClient.release(secondLease.leaseId, identity);
        } finally {
            await firstClient.close().catch(() => undefined);
            await secondClient?.close().catch(() => undefined);
        }
    }, 120_000);

    it('applies ControlPersist no, short duration, and indefinite', async () => {
        const client = await connectClient();
        try {
            const immediateId = `persist-no-${randomUUID()}`;
            const immediate = await client.acquire({
                identity: immediateId,
                route: directMfaRoute(),
                persist: { kind: 'immediate' },
                onAuthPrompt: authHandler({ count: 0, kinds: [] }),
            });
            await client.release(immediate.leaseId, immediateId);
            await expect(client.list()).resolves.toEqual({
                masters: expect.not.arrayContaining([expect.objectContaining({ identity: immediateId })]),
            });

            const timedId = `persist-timed-${randomUUID()}`;
            const timed = await client.acquire({
                identity: timedId,
                route: directMfaRoute(),
                persist: { kind: 'timed', idleSeconds: 2 },
                onAuthPrompt: authHandler({ count: 0, kinds: [] }),
            });
            await client.release(timed.leaseId, timedId);
            await expect(client.list()).resolves.toEqual({
                masters: expect.arrayContaining([expect.objectContaining({ identity: timedId, state: 'idle' })]),
            });
            await sleep(2_500);
            await expect(client.list()).resolves.toEqual({
                masters: expect.not.arrayContaining([expect.objectContaining({ identity: timedId })]),
            });

            const foreverId = `persist-yes-${randomUUID()}`;
            const forever = await client.acquire({
                identity: foreverId,
                route: directMfaRoute(),
                persist: { kind: 'indefinite' },
                onAuthPrompt: authHandler({ count: 0, kinds: [] }),
            });
            await client.release(forever.leaseId, foreverId);
            await expect(client.list()).resolves.toEqual({
                masters: expect.arrayContaining([expect.objectContaining({ identity: foreverId, state: 'idle' })]),
            });
            await client.closeMaster(foreverId);
            await expect(client.list()).resolves.toEqual({
                masters: expect.not.arrayContaining([expect.objectContaining({ identity: foreverId })]),
            });
        } finally {
            await client.close().catch(() => undefined);
        }
    }, 120_000);
});
