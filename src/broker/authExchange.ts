import { randomUUID } from 'crypto';
import type { PersistPolicy, SharingAction } from '../ssh/sharingPolicy';
import type { FrozenRoute, AuthPrompt, AuthResponse } from './transport';

export type AcquireParams = {
    identity: string;
    route: FrozenRoute;
    persist?: PersistPolicy;
    action?: SharingAction;
};

export type AuthPromptEvent = {
    acquireId: number;
    promptId: string;
    prompt: AuthPrompt;
};

export class AuthExchange {
    private readonly waiters = new Map<string, {
        resolve: (response: AuthResponse) => void;
        reject: (err: Error) => void;
    }>();

    request(
        acquireId: number,
        prompt: AuthPrompt,
        emit: (event: AuthPromptEvent) => void,
    ): Promise<AuthResponse> {
        const event = {
            acquireId,
            promptId: randomUUID(),
            prompt,
        };
        return new Promise<AuthResponse>((resolve, reject) => {
            this.waiters.set(event.promptId, { resolve, reject });
            try {
                emit(event);
            } catch (err) {
                this.waiters.delete(event.promptId);
                reject(err);
            }
        });
    }

    respond(promptId: string, response: AuthResponse): boolean {
        const waiter = this.waiters.get(promptId);
        if (!waiter) {
            return false;
        }
        this.waiters.delete(promptId);
        waiter.resolve(response);
        return true;
    }

    cancelAll(err: Error): void {
        for (const waiter of this.waiters.values()) {
            waiter.reject(err);
        }
        this.waiters.clear();
    }
}

export function authDelegateForExchange(
    acquireId: number,
    exchange: AuthExchange,
    emit: (event: AuthPromptEvent) => void,
) {
    async function prompt(prompt: AuthPrompt): Promise<AuthResponse> {
        return exchange.request(acquireId, prompt, emit);
    }

    return {
        async requestPassword(user: string, host: string) {
            const response = await prompt({ kind: 'password', user, host });
            if (response.kind !== 'password') {
                throw new Error('Expected password response');
            }
            return response.password;
        },
        async requestPassphrase(filename: string) {
            const response = await prompt({ kind: 'passphrase', filename });
            if (response.kind !== 'passphrase') {
                throw new Error('Expected passphrase response');
            }
            return response.passphrase;
        },
        async requestKeyboardInteractive(
            user: string,
            host: string,
            instructions: string,
            prompts: Array<{ prompt: string; echo: boolean }>,
        ) {
            const response = await prompt({ kind: 'keyboard-interactive', user, host, instructions, prompts });
            if (response.kind !== 'keyboard-interactive') {
                throw new Error('Expected keyboard-interactive response');
            }
            return response.answers;
        },
        async requestHostKey(host: string, fingerprint: string, isNew: boolean) {
            const response = await prompt({ kind: 'hostkey', host, fingerprint, isNew });
            if (response.kind !== 'hostkey') {
                throw new Error('Expected hostkey response');
            }
            return response.accept;
        },
    };
}
