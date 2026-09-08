import type { PersistPolicy } from '../ssh/sharingPolicy';
import type SSHConnection from '../ssh/sshConnection';
import type { MasterState } from './registry';
import type { FrozenRoute } from './transport';

export type BrokerLease = {
    leaseId: string;
    tunnelNames: string[];
    resources: Array<() => Promise<void> | void>;
};

export type SharedMaster = {
    identity: string;
    state: MasterState;
    leaseCount: number;
    route: FrozenRoute;
    persist: PersistPolicy;
    connection: SSHConnection;
    leases: Map<string, BrokerLease>;
    createdAt: number;
    closeWhenIdle: boolean;
    idleTimer?: ReturnType<typeof setTimeout>;
};

export function createMaster(
    identity: string,
    route: FrozenRoute,
    persist: PersistPolicy,
    connection: SSHConnection,
    now: () => number = () => Date.now(),
): SharedMaster {
    return {
        identity,
        state: 'ready',
        leaseCount: 0,
        route,
        persist,
        connection,
        leases: new Map(),
        createdAt: now(),
        closeWhenIdle: false,
    };
}

export function attachLease(master: SharedMaster, leaseId: string): BrokerLease {
    const lease: BrokerLease = { leaseId, tunnelNames: [], resources: [] };
    master.leases.set(leaseId, lease);
    master.leaseCount += 1;
    master.state = 'ready';
    clearIdleTimer(master);
    return lease;
}

export function detachLease(master: SharedMaster, leaseId: string): BrokerLease | undefined {
    const lease = master.leases.get(leaseId);
    if (!lease) {
        return undefined;
    }
    master.leases.delete(leaseId);
    master.leaseCount = Math.max(0, master.leaseCount - 1);
    if (master.leaseCount === 0) {
        master.state = 'idle';
    }
    return lease;
}

export function scheduleIdleExpiry(
    master: SharedMaster,
    onExpire: () => void,
    schedule: (delayMs: number, fn: () => void) => ReturnType<typeof setTimeout> = (delayMs, fn) => setTimeout(fn, delayMs),
): void {
    clearIdleTimer(master);
    if (master.leaseCount > 0) {
        return;
    }
    if (master.closeWhenIdle || master.persist.kind === 'immediate') {
        onExpire();
        return;
    }
    if (master.persist.kind === 'indefinite') {
        return;
    }
    master.idleTimer = schedule(master.persist.idleSeconds * 1000, onExpire);
}

export function markCloseWhenIdle(master: SharedMaster): void {
    master.closeWhenIdle = true;
}

export function clearIdleTimer(master: SharedMaster): void {
    if (master.idleTimer) {
        clearTimeout(master.idleTimer);
        master.idleTimer = undefined;
    }
}

export async function closeMaster(master: SharedMaster): Promise<void> {
    clearIdleTimer(master);
    master.state = 'closing';
    const leases = [...master.leases.values()];
    try {
        await Promise.allSettled(leases.flatMap((lease) => [
            ...lease.tunnelNames.map((name) => master.connection.closeTunnel(name)),
            ...lease.resources.map((close) => close()),
        ]));
        await master.connection.close();
    } finally {
        master.leases.clear();
        master.leaseCount = 0;
        master.state = 'failed';
    }
}
