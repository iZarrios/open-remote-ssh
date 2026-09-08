import { describe, expect, it } from 'vitest';
import { AuthExchange } from '../../src/broker/authExchange';

describe('AuthExchange', () => {
    it('registers a prompt before emitting it', async () => {
        const exchange = new AuthExchange();
        const response = exchange.request(
            1,
            { kind: 'password', user: 'alice', host: 'example.com' },
            ({ promptId }) => {
                expect(exchange.respond(promptId, { kind: 'password', password: 'secret' })).toBe(true);
            },
        );

        await expect(response).resolves.toEqual({ kind: 'password', password: 'secret' });
    });

    it('removes the prompt if emitting it fails', async () => {
        const exchange = new AuthExchange();
        let promptId = '';
        const response = exchange.request(
            1,
            { kind: 'password', user: 'alice', host: 'example.com' },
            (event) => {
                promptId = event.promptId;
                throw new Error('control socket closed');
            },
        );

        await expect(response).rejects.toThrow('control socket closed');
        expect(exchange.respond(promptId, { kind: 'password', password: 'late' })).toBe(false);
    });
});
