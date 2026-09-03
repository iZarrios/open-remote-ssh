import type { Server } from 'net';
import type { ClientChannel, ExecOptions } from 'ssh2';
import type { SSHTunnelConfig } from './sshConnection';
import type { OpenSshRouteRequest } from './sshRoute';

export type ExecResult = { stdout: string; stderr: string };

export type TunnelHandle = SSHTunnelConfig & { server: Server };

/**
 * Temporary right to use an SSH transport. Releasing the lease closes channels,
 * listeners, and tunnels opened through it; the underlying transport may remain
 * according to sharing policy.
 */
export interface ConnectionLease {
    exec(cmd: string, params?: Array<string>, options?: ExecOptions): Promise<ExecResult>;
    execPartial(
        cmd: string,
        tester: (stdout: string, stderr: string) => boolean,
        params?: Array<string>,
        options?: ExecOptions,
    ): Promise<ExecResult>;
    execChannel(cmd: string, options?: ExecOptions): Promise<ClientChannel>;
    forwardOut(srcIP: string, srcPort: number, destIP: string, destPort: number): Promise<ClientChannel>;
    addTunnel(config: SSHTunnelConfig): Promise<TunnelHandle>;
    closeTunnel(name?: string): Promise<void>;
    close(): Promise<void>;
}

export interface ConnectionProvider {
    acquire(request: OpenSshRouteRequest): Promise<ConnectionLease>;
}
