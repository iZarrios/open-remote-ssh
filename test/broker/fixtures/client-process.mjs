/* global process */
import { BrokerClient } from '../../../out/broker/client.js';

let client;
let promptKinds = [];

function authResponse(prompt) {
    promptKinds.push(prompt.kind);
    if (prompt.kind === 'password') {
        return { kind: 'password', password: process.env.ORSS_TEST_PASSWORD };
    }
    if (prompt.kind === 'keyboard-interactive') {
        return {
            kind: 'keyboard-interactive',
            answers: prompt.prompts.map(() => process.env.ORSS_TEST_PASSWORD),
        };
    }
    if (prompt.kind === 'hostkey') {
        return { kind: 'hostkey', accept: true };
    }
    throw new Error(`Unexpected prompt: ${prompt.kind}`);
}

process.on('message', async (message) => {
    try {
        let result;
        if (message.method === 'connect') {
            client = await BrokerClient.connect({
                runtimeDir: message.runtimeDir,
                execPath: process.execPath,
                brokerScript: '',
                spawn: () => { throw new Error('broker already running'); },
            });
            result = { connected: true };
        } else if (message.method === 'acquire') {
            promptKinds = [];
            const lease = await client.acquire({
                ...message.options,
                onAuthPrompt: authResponse,
            });
            result = { lease, promptKinds };
        } else if (message.method === 'exec') {
            result = await client.exec(message.leaseId, message.identity, message.command, message.params);
        } else if (message.method === 'release') {
            await client.release(message.leaseId, message.identity);
            result = { released: true };
        } else if (message.method === 'close') {
            await client.close();
            result = { closed: true };
        } else {
            throw new Error(`Unknown method: ${message.method}`);
        }
        process.send({ id: message.id, result });
    } catch (error) {
        process.send({ id: message.id, error: error instanceof Error ? error.message : String(error) });
    }
});
