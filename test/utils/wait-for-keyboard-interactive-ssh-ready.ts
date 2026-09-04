import SSHConnection from '../../src/ssh/sshConnection';
import { sleep } from './sleep';

/** Wait until a keyboard-interactive-only SSH server accepts the given password. */
export async function waitForKeyboardInteractiveSSHReady(
    username: string,
    password: string,
    port: number,
    timeoutMs: number,
): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        const conn = new SSHConnection({
            host: '127.0.0.1',
            port,
            username,
            reconnect: false,
            readyTimeout: 10_000,
            strictVendor: false,
            authHandler: (_methodsLeft, _partialSuccess, callback) => {
                if (_methodsLeft === null) {
                    return callback({ type: 'none', username });
                }
                if (_methodsLeft.includes('keyboard-interactive')) {
                    return callback({
                        type: 'keyboard-interactive',
                        username,
                        prompt: (_name, _instructions, _lang, prompts, finish) => {
                            finish(prompts.map(() => password));
                        },
                    });
                }
                return callback(false);
            },
        });

        try {
            await conn.connect();
            await conn.close();
            return;
        } catch {
            await sleep(1000);
        }
    }

    throw new Error('Timed out waiting for keyboard-interactive Docker SSH server to become ready');
}
