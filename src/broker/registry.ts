export type MasterState = 'creating' | 'authenticating' | 'ready' | 'idle' | 'closing' | 'failed';

export type MasterRecord = {
    identity: string;
    state: MasterState;
    leaseCount: number;
};

export class MasterRegistry {
    private readonly masters = new Map<string, MasterRecord>();
    private readonly creating = new Map<string, Promise<MasterRecord>>();

    getOrCreate(identity: string, create: () => Promise<MasterRecord>): Promise<MasterRecord> {
        const existing = this.masters.get(identity);
        if (existing) {
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

    list(): MasterRecord[] {
        return [...this.masters.values()];
    }

    get(identity: string): MasterRecord | undefined {
        return this.masters.get(identity);
    }

    delete(identity: string): boolean {
        return this.masters.delete(identity);
    }
}
