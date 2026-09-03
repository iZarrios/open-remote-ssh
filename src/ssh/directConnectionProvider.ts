import type { ExecOptions } from 'ssh2';
import type { ConnectionLease, ConnectionProvider, TunnelHandle } from './connectionLease';
import { gatherIdentityFiles } from './identityFiles';
import SSHConnection, { SSHTunnelConfig } from './sshConnection';
import { openSshRoute, OpenSshRouteRequest } from './sshRoute';

export type DirectConnectionRequest = OpenSshRouteRequest;

export function wrapDirectConnection(
    connection: SSHConnection,
    onRelease?: () => Promise<void> | void,
): ConnectionLease {
    return {
        exec(cmd: string, params?: Array<string>, options?: ExecOptions) {
            return connection.exec(cmd, params, options);
        },
        execPartial(
            cmd: string,
            tester: (stdout: string, stderr: string) => boolean,
            params?: Array<string>,
            options?: ExecOptions,
        ) {
            return connection.execPartial(cmd, tester, params, options);
        },
        execChannel(cmd: string, options?: ExecOptions) {
            return connection.execChannel(cmd, options);
        },
        forwardOut(srcIP: string, srcPort: number, destIP: string, destPort: number) {
            return connection.forwardOut(srcIP, srcPort, destIP, destPort);
        },
        addTunnel(config: SSHTunnelConfig): Promise<TunnelHandle> {
            return connection.addTunnel(config);
        },
        closeTunnel(name?: string) {
            return connection.closeTunnel(name);
        },
        async close() {
            await connection.close();
            await onRelease?.();
        },
    };
}

export class DirectConnectionProvider implements ConnectionProvider {
    async acquire(request: DirectConnectionRequest): Promise<ConnectionLease> {
        const identityFiles: string[] = (request.hostConfig['IdentityFile'] as unknown as string[]) || [];
        const identitiesOnly = (request.hostConfig['IdentitiesOnly'] || 'no').toLowerCase() === 'yes';
        const identityKeys = await gatherIdentityFiles(identityFiles, request.sshAgentSock, identitiesOnly, request.logger);

        const route = await openSshRoute(request);
        try {
            const authHandler = request.createAuthHandler(
                request.user,
                request.host,
                identityKeys,
                request.preferredAuthentications,
            );
            const connection = new SSHConnection({
                host: route.host,
                port: route.port,
                sock: route.sock,
                username: route.username,
                readyTimeout: request.connectTimeoutMs,
                strictVendor: false,
                agentForward: route.agentForward,
                agent: route.agent,
                authHandler: (arg0, arg1, arg2) => (authHandler?.(arg0, arg1, arg2), undefined),
            });
            await connection.connect();
            return wrapDirectConnection(connection, () => route.dispose());
        } catch (err) {
            route.dispose();
            throw err;
        }
    }
}
