import * as os from 'os';
import * as path from 'path';
import { Log } from '../common/logger';
import {
    BrokerAuthError,
    BrokerClient,
    BrokerInfrastructureError,
    BrokerRequestError,
    ProtocolMismatchError,
} from '../broker/client';
import type { PersistPolicy, SharingAction, SharingPolicy, SharedSharingPolicy } from './sharingPolicy';
import type { ConnectionLease, ConnectionProvider, TunnelHandle } from './connectionLease';
import { DirectConnectionProvider } from './directConnectionProvider';
import type { OpenSshRouteRequest } from './sshRoute';
import type { AuthPrompt, AuthResponse, FrozenRoute } from '../broker/transport';
import SSHDestination from './sshDestination';
import type { SSHTunnelConfig } from './sshConnection';

export type BrokerFailureKind = 'fallback' | 'terminal';

export function classifyBrokerFailure(err: unknown): BrokerFailureKind {
    if (err instanceof BrokerAuthError) {
        return 'terminal';
    }
    if (err instanceof BrokerInfrastructureError || err instanceof ProtocolMismatchError) {
        return 'fallback';
    }
    if (err instanceof BrokerRequestError && (err.code === 'occupied' || err.code === 'no-master' || err.code === 'mismatch' || err.code === 'runtime')) {
        return 'fallback';
    }
    if (err instanceof Error && /ECONNREFUSED|Timed out waiting for broker/i.test(err.message)) {
        return 'fallback';
    }
    return 'terminal';
}

export function freezeRoute(request: OpenSshRouteRequest): FrozenRoute {
    const jumpHostConfigs: FrozenRoute['jumpHostConfigs'] = {};
    if (request.hostConfig?.['ProxyJump']) {
        for (const hop of request.hostConfig['ProxyJump'].split(',').filter((item) => !!item.trim())) {
            const dest = SSHDestination.parse(hop.trim());
            jumpHostConfigs[dest.hostname] = request.sshConfig.getHostConfiguration(dest.hostname);
        }
    }
    return {
        host: request.host,
        port: request.port,
        user: request.user,
        originalHostname: request.originalHostname,
        hostConfig: request.hostConfig,
        jumpHostConfigs,
        connectTimeoutMs: request.connectTimeoutMs,
        enableAgentForwarding: request.enableAgentForwarding,
        sshAgentSock: request.sshAgentSock,
        preferredAuthentications: request.preferredAuthentications,
    };
}

export type BrokerConnectionProviderOptions = {
    runtimeDir: string;
    execPath: string;
    brokerScript: string;
    identity: string;
    persist: PersistPolicy;
    action?: SharingAction;
    logger: Log;
    directProvider?: ConnectionProvider;
    connectBroker?: (options: {
        runtimeDir: string;
        execPath: string;
        brokerScript: string;
    }) => Promise<BrokerClient>;
    createAuthPromptHandler: (request: OpenSshRouteRequest) => (prompt: AuthPrompt) => Promise<AuthResponse>;
};

export class BrokerConnectionProvider implements ConnectionProvider {
    private readonly directProvider: ConnectionProvider;

    constructor(private readonly options: BrokerConnectionProviderOptions) {
        this.directProvider = options.directProvider ?? new DirectConnectionProvider();
    }

    async acquire(request: OpenSshRouteRequest): Promise<ConnectionLease> {
        try {
            const connect = this.options.connectBroker ?? ((opts) => BrokerClient.connect({
                ...opts,
                detached: true,
            }));
            const client = await connect({
                runtimeDir: this.options.runtimeDir,
                execPath: this.options.execPath,
                brokerScript: this.options.brokerScript,
            });
            const lease = await client.acquire({
                identity: this.options.identity,
                route: freezeRoute(request),
                persist: this.options.persist,
                action: this.options.action,
                onAuthPrompt: this.options.createAuthPromptHandler(request),
            });
            return createBrokerLease(client, lease, request.logger);
        } catch (err) {
            const kind = classifyBrokerFailure(err);
            if (kind === 'fallback') {
                request.logger.error('Broker unavailable; connecting directly', err);
                return this.directProvider.acquire(request);
            }
            throw err;
        }
    }
}

function createBrokerLease(
    client: BrokerClient,
    lease: { leaseId: string; identity: string },
    logger: Log,
): ConnectionLease {
    return {
        exec(cmd, params) {
            return client.exec(lease.leaseId, lease.identity, cmd, params);
        },
        execPartial(cmd, _tester, params) {
            return client.execPartial(lease.leaseId, lease.identity, cmd, _tester, params);
        },
        async execChannel() {
            throw new Error('Broker lease execChannel is not implemented yet');
        },
        async forwardOut() {
            throw new Error('Broker lease forwardOut is not implemented yet');
        },
        async addTunnel(config: SSHTunnelConfig): Promise<TunnelHandle> {
            const handle = await client.addTunnel(lease.leaseId, lease.identity, config);
            return { ...config, name: handle.name, localPort: handle.localPort, server: {} as TunnelHandle['server'] };
        },
        closeTunnel(name?: string) {
            return client.closeTunnel(lease.leaseId, lease.identity, name);
        },
        async close() {
            try {
                await client.release(lease.leaseId, lease.identity);
            } catch (err) {
                logger.error('Failed to release broker lease', err);
            }
            await client.close();
        },
    };
}

export type BrokerProviderFactoryOptions = Omit<BrokerConnectionProviderOptions, 'identity' | 'persist' | 'action'> & {
    policy: SharedSharingPolicy;
};

export function brokerProviderForPolicy(options: BrokerProviderFactoryOptions): BrokerConnectionProvider {
    return new BrokerConnectionProvider({
        ...options,
        identity: `${options.policy.identity.controlPath}|${options.policy.identity.host}|${options.policy.identity.port}|${options.policy.identity.user}`,
        persist: options.policy.persist,
        action: options.policy.action,
    });
}

export function selectConnectionProvider(
    policy: SharingPolicy,
    options: Omit<BrokerProviderFactoryOptions, 'policy'>,
): ConnectionProvider {
    if (!policy.sharing) {
        if (policy.warning) {
            options.logger.info(policy.warning);
        }
        return options.directProvider ?? new DirectConnectionProvider();
    }
    return brokerProviderForPolicy({ ...options, policy });
}

export function defaultBrokerRuntimeDir(): string {
    return path.join(os.homedir(), '.open-remote-ssh', 'broker');
}

export function defaultBrokerScript(extensionPath: string): string {
    return path.join(extensionPath, 'lib', 'connectionBroker.js');
}
