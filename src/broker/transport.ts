export type AuthPrompt =
    | { kind: 'password'; user: string; host: string }
    | { kind: 'passphrase'; filename: string }
    | {
        kind: 'keyboard-interactive';
        user: string;
        host: string;
        instructions: string;
        prompts: Array<{ prompt: string; echo: boolean }>;
    }
    | { kind: 'hostkey'; host: string; fingerprint: string; isNew: boolean };

export type AuthResponse =
    | { kind: 'password'; password: string }
    | { kind: 'passphrase'; passphrase: string }
    | { kind: 'keyboard-interactive'; answers: string[] }
    | { kind: 'hostkey'; accept: boolean };

export type AuthDelegate = {
    requestPassword(user: string, host: string): Promise<string>;
    requestPassphrase(filename: string): Promise<string>;
    requestKeyboardInteractive(
        user: string,
        host: string,
        instructions: string,
        prompts: Array<{ prompt: string; echo: boolean }>,
    ): Promise<string[]>;
    requestHostKey(host: string, fingerprint: string, isNew: boolean): Promise<boolean>;
};

export type FrozenRoute = {
    host: string;
    port: number;
    user: string;
    originalHostname?: string;
    hostConfig?: import('../ssh/sshConfig').HostConfiguration;
    jumpHostConfigs?: Record<string, import('../ssh/sshConfig').HostConfiguration>;
    connectTimeoutMs?: number;
    enableAgentForwarding?: boolean;
    sshAgentSock?: string;
    preferredAuthentications?: string[];
};

export type TransportConnector = (
    identity: string,
    route: FrozenRoute,
    auth: AuthDelegate,
) => Promise<import('../ssh/sshConnection').default>;
