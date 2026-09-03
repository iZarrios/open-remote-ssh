import { describe, expect, it } from 'vitest';
import { MasterRegistry } from '../../src/broker/registry';

describe('MasterRegistry', () => {
    it('serializes creation for the same sharing identity', async () => {
        const registry = new MasterRegistry();
        let creates = 0;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        const create = async () => {
            creates += 1;
            await gate;
            return { identity: 'a', state: 'ready' as const, leaseCount: 0 };
        };

        const first = registry.getOrCreate('a', create);
        const second = registry.getOrCreate('a', create);
        release();

        const [one, two] = await Promise.all([first, second]);
        expect(creates).toBe(1);
        expect(one).toBe(two);
    });

    it('allows concurrent creation for different identities', async () => {
        const registry = new MasterRegistry();
        let inFlight = 0;
        let maxInFlight = 0;

        const create = async (identity: string) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await Promise.resolve();
            inFlight -= 1;
            return { identity, state: 'ready' as const, leaseCount: 0 };
        };

        await Promise.all([
            registry.getOrCreate('a', () => create('a')),
            registry.getOrCreate('b', () => create('b')),
        ]);

        expect(maxInFlight).toBe(2);
    });
});
