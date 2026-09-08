import type { PersistPolicy } from '../ssh/sharingPolicy';
import type { SharedMaster } from './master';

export type MasterState = 'creating' | 'authenticating' | 'ready' | 'idle' | 'closing' | 'failed';

export type MasterSummary = {
    identity: string;
    state: MasterState;
    leaseCount: number;
    destination: string;
    ageMs: number;
    persist: PersistPolicy;
};

export function formatMasterDestination(master: SharedMaster): string {
    const { user, host, port } = master.route;
    return `${user}@${host}:${port}`;
}

export function summarizeMaster(master: SharedMaster, now: number = Date.now()): MasterSummary {
    return {
        identity: master.identity,
        state: master.state,
        leaseCount: master.leaseCount,
        destination: formatMasterDestination(master),
        ageMs: Math.max(0, now - master.createdAt),
        persist: master.persist,
    };
}

export class SharingIdentityOccupiedError extends Error {
    constructor(readonly identity: string) {
        super(`Sharing identity is already occupied: ${identity}`);
        this.name = 'SharingIdentityOccupiedError';
    }
}

export class MasterRegistry {
    private readonly masters = new Map<string, SharedMaster>();
    private readonly creating = new Map<string, Promise<SharedMaster>>();

    getOrCreate(identity: string, create: () => Promise<SharedMaster>): Promise<SharedMaster> {
        const existing = this.masters.get(identity);
        if (existing && existing.state !== 'failed' && existing.state !== 'closing') {
            return Promise.resolve(existing);
        }

        const inflight = this.creating.get(identity);
        if (inflight) {
            return inflight;
        }

        const pending = create().then((record) => {
            this.masters.set(identity, record);
            this.creating.delete(identity);
            return record;
        }, (err) => {
            this.creating.delete(identity);
            throw err;
        });

        this.creating.set(identity, pending);
        return pending;
    }

    createExclusive(identity: string, create: () => Promise<SharedMaster>): Promise<SharedMaster> {
        const existing = this.masters.get(identity);
        if ((existing && existing.state !== 'failed' && existing.state !== 'closing') || this.creating.has(identity)) {
            return Promise.reject(new SharingIdentityOccupiedError(identity));
        }

        const pending = create().then((record) => {
            this.masters.set(identity, record);
            this.creating.delete(identity);
            return record;
        }, (err) => {
            this.creating.delete(identity);
            throw err;
        });
        this.creating.set(identity, pending);
        return pending;
    }

    list(now: number = Date.now()): MasterSummary[] {
        return [...this.masters.values()].map((master) => summarizeMaster(master, now));
    }

    get(identity: string): SharedMaster | undefined {
        return this.masters.get(identity);
    }

    delete(identity: string, expected?: SharedMaster): boolean {
        if (expected && this.masters.get(identity) !== expected) {
            return false;
        }
        return this.masters.delete(identity);
    }

    get size(): number {
        return this.masters.size;
    }
}

export function defaultPersist(): PersistPolicy {
    return { kind: 'immediate' };
}
