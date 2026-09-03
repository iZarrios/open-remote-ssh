import { describe, expect, it, vi } from 'vitest';
import {
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

describe('manageSharedConnections', () => {
    it('lists shared connections and closes an idle master immediately', async () => {
        const close = vi.fn(async () => undefined);
        const deps: ManageSharedConnectionsDeps = {
            list: async () => [idleMaster, activeMaster],
            close,
            showQuickPick: async (items) => {
                expect(items.map((item) => item.label)).toEqual([
                    'alice@example.com:22',
                    'bob@jump.example:2222',
                ]);
                return items[0];
            },
            showWarningMessage: vi.fn(async () => undefined),
            showInformationMessage: vi.fn(async () => undefined),
        };

        await manageSharedConnections(deps);

        expect(close).toHaveBeenCalledWith('idle-id', { whenIdle: false });
        expect(deps.showWarningMessage).not.toHaveBeenCalled();
    });

    it('requires confirmation before closing an active master', async () => {
        const close = vi.fn(async () => undefined);
        const deps: ManageSharedConnectionsDeps = {
            list: async () => [activeMaster],
            close,
            showQuickPick: async (items) => items[0],
            showWarningMessage: async (message, ...actions) => {
                expect(message).toMatch(/2 lease/);
                expect(actions).toEqual(['Close Now', 'Close When Idle']);
                return 'Close Now';
            },
            showInformationMessage: vi.fn(async () => undefined),
        };

        await manageSharedConnections(deps);

        expect(close).toHaveBeenCalledWith('active-id', { whenIdle: false });
    });

    it('cancels an active close when the user dismisses confirmation', async () => {
        const close = vi.fn(async () => undefined);
        const deps: ManageSharedConnectionsDeps = {
            list: async () => [activeMaster],
            close,
            showQuickPick: async (items) => items[0],
            showWarningMessage: async () => undefined,
            showInformationMessage: vi.fn(async () => undefined),
        };

        await manageSharedConnections(deps);

        expect(close).not.toHaveBeenCalled();
    });

    it('schedules close-when-idle for an active master', async () => {
        const close = vi.fn(async () => undefined);
        const deps: ManageSharedConnectionsDeps = {
            list: async () => [activeMaster],
            close,
            showQuickPick: async (items) => items[0],
            showWarningMessage: async () => 'Close When Idle',
            showInformationMessage: vi.fn(async () => undefined),
        };

        await manageSharedConnections(deps);

        expect(close).toHaveBeenCalledWith('active-id', { whenIdle: true });
    });

    it('shows an info message when there are no shared connections', async () => {
        const deps: ManageSharedConnectionsDeps = {
            list: async () => [],
            close: vi.fn(async () => undefined),
            showQuickPick: vi.fn(async () => undefined),
            showWarningMessage: vi.fn(async () => undefined),
            showInformationMessage: vi.fn(async () => undefined),
        };

        await manageSharedConnections(deps);

        expect(deps.showInformationMessage).toHaveBeenCalledWith('No shared SSH connections.');
        expect(deps.showQuickPick).not.toHaveBeenCalled();
    });
});
