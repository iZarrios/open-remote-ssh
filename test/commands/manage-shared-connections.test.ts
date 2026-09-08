import { describe, expect, it, vi } from 'vitest';
import { resolveSharingPolicy, sharingIdentityKey } from '../../src/ssh/sharingPolicy';
import {
    configuredSharedHosts,
    manageSharedConnections,
    type ManageSharedConnectionsDeps,
    type SharedConnectionInfo,
} from '../../src/commands';

const idleMaster: SharedConnectionInfo = {
    identity: 'idle-id',
    destination: 'alice@example.com:22',
    state: 'idle',
    leaseCount: 0,
    ageMs: 120_000,
    persist: { kind: 'indefinite' },
};

const activeMaster: SharedConnectionInfo = {
    identity: 'active-id',
    destination: 'bob@jump.example:2222',
    state: 'ready',
    leaseCount: 2,
    ageMs: 45_000,
    persist: { kind: 'timed', idleSeconds: 90 },
};

function depsFor(overrides: Partial<ManageSharedConnectionsDeps> = {}): ManageSharedConnectionsDeps {
    return {
        list: async () => [
            { kind: 'active', connection: idleMaster },
            { kind: 'active', connection: activeMaster },
        ],
        close: vi.fn(async () => undefined),
        openHostInNewWindow: vi.fn(async () => undefined),
        showQuickPick: async (items) => items[0],
        showWarningMessage: vi.fn(async () => undefined),
        showInformationMessage: vi.fn(async () => undefined),
        ...overrides,
    };
}

describe('manageSharedConnections', () => {
    it('lists shared connections and closes an idle master immediately', async () => {
        const close = vi.fn(async () => undefined);
        const deps = depsFor({
            close,
            showQuickPick: async (items) => {
                expect(items.map((item) => item.label)).toEqual([
                    'alice@example.com:22',
                    'bob@jump.example:2222',
                ]);
                return items[0];
            },
        });

        await manageSharedConnections(deps);

        expect(close).toHaveBeenCalledWith('idle-id', { whenIdle: false });
        expect(deps.showWarningMessage).not.toHaveBeenCalled();
    });

    it('requires confirmation before closing an active master', async () => {
        const close = vi.fn(async () => undefined);
        const deps = depsFor({
            list: async () => [{ kind: 'active', connection: activeMaster }],
            close,
            showQuickPick: async (items) => items[0],
            showWarningMessage: async (message, ...actions) => {
                expect(message).toMatch(/2 lease/);
                expect(actions).toEqual(['Close Now', 'Close When Idle']);
                return 'Close Now';
            },
        });

        await manageSharedConnections(deps);

        expect(close).toHaveBeenCalledWith('active-id', { whenIdle: false });
    });

    it('cancels an active close when the user dismisses confirmation', async () => {
        const close = vi.fn(async () => undefined);
        const deps = depsFor({
            list: async () => [{ kind: 'active', connection: activeMaster }],
            close,
            showQuickPick: async (items) => items[0],
            showWarningMessage: async () => undefined,
        });

        await manageSharedConnections(deps);

        expect(close).not.toHaveBeenCalled();
    });

    it('schedules close-when-idle for an active master', async () => {
        const close = vi.fn(async () => undefined);
        const deps = depsFor({
            list: async () => [{ kind: 'active', connection: activeMaster }],
            close,
            showQuickPick: async (items) => items[0],
            showWarningMessage: async () => 'Close When Idle',
        });

        await manageSharedConnections(deps);

        expect(close).toHaveBeenCalledWith('active-id', { whenIdle: true });
    });

    it('shows an info message when there are no shared connections', async () => {
        const deps = depsFor({
            list: async () => [],
            showQuickPick: vi.fn(async () => undefined),
        });

        await manageSharedConnections(deps);

        expect(deps.showInformationMessage).toHaveBeenCalledWith('No active or configured shared SSH connections.');
        expect(deps.showQuickPick).not.toHaveBeenCalled();
    });

    it('offers eligible configured hosts that do not have an active master', async () => {
        const openHostInNewWindow = vi.fn(async () => undefined);
        const deps = depsFor({
            list: async () => [
                { kind: 'active', connection: activeMaster },
                { kind: 'configured', host: 'devbox', destination: 'alice@devbox.example:22' },
            ],
            openHostInNewWindow,
            showQuickPick: async (items) => {
                expect(items.map((item) => item.label)).toEqual([
                    'bob@jump.example:2222',
                    'devbox',
                ]);
                expect(items[1].description).toBe('Start shared connection');
                return items[1];
            },
        });

        await manageSharedConnections(deps);

        expect(openHostInNewWindow).toHaveBeenCalledWith('devbox');
        expect(deps.close).not.toHaveBeenCalled();
    });
});

describe('configuredSharedHosts', () => {
    it('offers only hosts that can create a currently inactive master', () => {
        const configs = {
            auto: { HostName: 'auto.example', User: 'alice', ControlMaster: 'auto', ControlPath: '~/.ssh/%C' },
            attachOnly: { ControlMaster: 'no', ControlPath: '~/.ssh/%C' },
            active: { ControlMaster: 'yes', ControlPath: '~/.ssh/%C' },
            direct: {},
        };
        const activePolicy = resolvePolicy(configs.active, 'active', 'local-user');
        const config = {
            getAllConfiguredHosts: () => Object.keys(configs),
            getHostConfiguration: (host: string) => configs[host as keyof typeof configs],
        };

        expect(configuredSharedHosts(config, new Set([activePolicy]), 'local-user')).toEqual([{
            kind: 'configured',
            host: 'auto',
            destination: 'alice@auto.example:22',
        }]);
    });
});

function resolvePolicy(config: Record<string, string>, host: string, user: string): string {
    const policy = resolveSharingPolicy(config, { host, port: 22, user });
    if (!policy.sharing) {
        throw new Error('expected sharing policy');
    }
    return sharingIdentityKey(policy.identity);
}
