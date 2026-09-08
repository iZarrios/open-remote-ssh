import { describe, expect, it, vi } from 'vitest';
import type { AuthHandlerResult } from 'ssh2';
import type { ParsedKey } from 'ssh2-streams';
import { createBrokerAuthHandler } from '../../src/broker/sshTransport';
import type { AuthDelegate } from '../../src/broker/transport';

function authDelegate(): AuthDelegate {
    return {
        requestPassword: vi.fn(async () => 'secret'),
        requestPassphrase: vi.fn(async () => 'passphrase'),
        requestKeyboardInteractive: vi.fn(async () => ['answer']),
        requestHostKey: vi.fn(async () => true),
    };
}

async function nextAuth(
    handler: ReturnType<typeof createBrokerAuthHandler>,
    methods: string[],
): Promise<AuthHandlerResult | false | null> {
    return new Promise((resolve) => {
        void handler(methods, false, resolve);
    });
}

describe('createBrokerAuthHandler', () => {
    it('retains password retry state for the lifetime of one SSH connection', async () => {
        const auth = authDelegate();
        const handler = createBrokerAuthHandler(auth, 'alice', 'example.com', [], ['password']);

        expect(await nextAuth(handler, ['password'])).toMatchObject({ type: 'password' });
        expect(await nextAuth(handler, ['password'])).toMatchObject({ type: 'password' });
        expect(await nextAuth(handler, ['password'])).toMatchObject({ type: 'password' });
        expect(await nextAuth(handler, ['password'])).toBe(false);
        expect(auth.requestPassword).toHaveBeenCalledTimes(3);
    });

    it('uses the configured SSH agent for an agent-backed identity', async () => {
        const parsedKey = { comment: 'agent-key' } as ParsedKey;
        const handler = createBrokerAuthHandler(authDelegate(), 'alice', 'example.com', [{
            filename: 'agent-key',
            parsedKey,
            agentSupport: true,
        }], ['publickey'], '/tmp/test-agent.sock');

        const result = await nextAuth(handler, ['publickey']);
        expect(result).toMatchObject({ type: 'agent', username: 'alice' });
        if (!result || result.type !== 'agent') {
            throw new Error('expected agent authentication');
        }
        await expect(new Promise<ParsedKey[]>((resolve, reject) => {
            result.agent.getIdentities((err, keys) => err ? reject(err) : resolve(keys || []));
        })).resolves.toEqual([parsedKey]);
    });
});
