import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import { getRemoteAuthority } from './authResolver';
import SSHConfiguration, { getSSHConfigPath } from './ssh/sshConfig';
import { exists as fileExists } from './common/files';
import SSHDestination from './ssh/sshDestination';
import { BrokerClient } from './broker/client';
import type { MasterSummary } from './broker/registry';
import { resolveSharingPolicy, sharingIdentityKey, type PersistPolicy } from './ssh/sharingPolicy';
import { defaultBrokerRuntimeDir } from './ssh/brokerConnectionProvider';

export type SharedConnectionInfo = MasterSummary;

export type SharedConnectionListEntry =
    | { kind: 'active'; connection: SharedConnectionInfo }
    | { kind: 'configured'; host: string; destination: string };

export type SharedConnectionPickItem = {
    label: string;
    description?: string;
    detail?: string;
    entry: SharedConnectionListEntry;
};

export type ManageSharedConnectionsDeps = {
    list(): Promise<SharedConnectionListEntry[]>;
    close(identity: string, options: { whenIdle: boolean }): Promise<void>;
    openHostInNewWindow(host: string): Promise<void> | void;
    showQuickPick(items: SharedConnectionPickItem[]): Promise<SharedConnectionPickItem | undefined> | Thenable<SharedConnectionPickItem | undefined>;
    showWarningMessage(message: string, ...actions: string[]): Promise<string | undefined> | Thenable<string | undefined>;
    showInformationMessage(message: string): Promise<string | undefined> | Thenable<string | undefined>;
};

function formatAge(ageMs: number): string {
    const seconds = Math.floor(ageMs / 1000);
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m`;
    }
    return `${Math.floor(minutes / 60)}h`;
}

function formatPersist(persist: PersistPolicy): string {
    if (persist.kind === 'immediate') {
        return 'persist immediate';
    }
    if (persist.kind === 'indefinite') {
        return 'persist indefinite';
    }
    return `persist ${persist.idleSeconds}s`;
}

export function toSharedConnectionPickItem(connection: SharedConnectionInfo): SharedConnectionPickItem {
    return {
        label: connection.destination,
        description: `${connection.state} · ${connection.leaseCount} lease${connection.leaseCount === 1 ? '' : 's'}`,
        detail: `age ${formatAge(connection.ageMs)} · ${formatPersist(connection.persist)}`,
        entry: { kind: 'active', connection },
    };
}

function toPickItem(entry: SharedConnectionListEntry): SharedConnectionPickItem {
    if (entry.kind === 'active') {
        return toSharedConnectionPickItem(entry.connection);
    }
    return {
        label: entry.host,
        description: 'Start shared connection',
        detail: entry.destination,
        entry,
    };
}

export function configuredSharedHosts(
    config: Pick<SSHConfiguration, 'getAllConfiguredHosts' | 'getHostConfiguration'>,
    activeIdentities: ReadonlySet<string>,
    username: string = os.userInfo().username,
): SharedConnectionListEntry[] {
    const configured: SharedConnectionListEntry[] = [];
    for (const host of config.getAllConfiguredHosts()) {
        const hostConfig = config.getHostConfiguration(host);
        const destination = {
            host: hostConfig.HostName?.replace('%h', host) ?? host,
            port: hostConfig.Port ? parseInt(hostConfig.Port, 10) : 22,
            user: hostConfig.User || username || '',
        };
        const policy = resolveSharingPolicy(hostConfig, destination);
        if (policy.sharing && policy.action !== 'attach' && !activeIdentities.has(sharingIdentityKey(policy.identity))) {
            configured.push({
                kind: 'configured',
                host,
                destination: `${destination.user}@${destination.host}:${destination.port}`,
            });
        }
    }
    return configured;
}

export async function manageSharedConnections(deps: ManageSharedConnectionsDeps): Promise<void> {
    const entries = await deps.list();
    if (!entries.length) {
        await deps.showInformationMessage('No active or configured shared SSH connections.');
        return;
    }

    const selected = await deps.showQuickPick(entries.map(toPickItem));
    if (!selected) {
        return;
    }

    if (selected.entry.kind === 'configured') {
        await deps.openHostInNewWindow(selected.entry.host);
        return;
    }

    const { connection } = selected.entry;
    if (connection.leaseCount === 0) {
        await deps.close(connection.identity, { whenIdle: false });
        return;
    }

    const action = await deps.showWarningMessage(
        `Close shared connection to ${connection.destination}? This will disconnect ${connection.leaseCount} lease${connection.leaseCount === 1 ? '' : 's'}.`,
        'Close Now',
        'Close When Idle',
    );
    if (action === 'Close Now') {
        await deps.close(connection.identity, { whenIdle: false });
        return;
    }
    if (action === 'Close When Idle') {
        await deps.close(connection.identity, { whenIdle: true });
    }
}

export function createManageSharedConnectionsDeps(options: {
    connectBroker?: () => Promise<BrokerClient | undefined>;
} = {}): ManageSharedConnectionsDeps {
    const connect = options.connectBroker ?? (() => BrokerClient.connectExisting({
        runtimeDir: defaultBrokerRuntimeDir(),
    }));

    return {
        async list() {
            const config = await SSHConfiguration.loadFromFS();
            const client = await connect();
            let masters: SharedConnectionInfo[];
            try {
                const result = await client?.list();
                masters = result?.masters ?? [];
            } finally {
                await client?.close();
            }
            const activeIdentities = new Set(masters.map((master) => master.identity));
            const configured = configuredSharedHosts(config, activeIdentities);
            return [
                ...masters.map((connection): SharedConnectionListEntry => ({ kind: 'active', connection })),
                ...configured,
            ];
        },
        async close(identity, closeOptions) {
            const client = await connect();
            if (!client) {
                return;
            }
            try {
                await client.closeMaster(identity, closeOptions);
            } finally {
                await client.close();
            }
        },
        showQuickPick(items) {
            return vscode.window.showQuickPick(items, {
                title: 'Manage Shared Connections',
                placeHolder: 'Select a connection to start or close',
            });
        },
        openHostInNewWindow(host) {
            const destination = new SSHDestination(host);
            openRemoteSSHWindow(destination.toEncodedString(), false);
        },
        showWarningMessage(message, ...actions) {
            return vscode.window.showWarningMessage(message, { modal: true }, ...actions);
        },
        showInformationMessage(message) {
            return vscode.window.showInformationMessage(message);
        },
    };
}

export async function promptOpenRemoteSSHWindow(reuseWindow: boolean) {
    const host = await promptForHost();

    if (!host) {
        return;
    }

    const sshDest = new SSHDestination(host);
    openRemoteSSHWindow(sshDest.toEncodedString(), reuseWindow);
}

/**
 * Lists the hosts from the SSH config while still accepting an arbitrary
 * [user@]hostname[:port]. Whatever is typed is offered as the first item, so
 * typing a host and pressing enter keeps working exactly as it did before.
 */
async function promptForHost(): Promise<string | undefined> {
    let configuredHosts: string[] = [];
    try {
        configuredHosts = (await SSHConfiguration.loadFromFS()).getAllConfiguredHosts();
    } catch {
        // Ignore and fall back to the plain input box below.
    }

    if (!configuredHosts.length) {
        return vscode.window.showInputBox({
            title: 'Enter [user@]hostname[:port]'
        });
    }

    const hostItems: vscode.QuickPickItem[] = configuredHosts.map(label => ({ label }));

    return new Promise<string | undefined>(resolve => {
        const quickPick = vscode.window.createQuickPick();
        quickPick.title = 'Connect to Host';
        quickPick.placeholder = 'Select a configured host, or enter [user@]hostname[:port]';
        quickPick.items = hostItems;

        quickPick.onDidChangeValue(value => {
            const typed = value.trim();
            quickPick.items = typed && !configuredHosts.includes(typed)
                ? [{ label: typed, description: 'Connect to this host' }, ...hostItems]
                : hostItems;
        });

        quickPick.onDidAccept(() => {
            const picked = quickPick.selectedItems[0]?.label ?? quickPick.value.trim();
            resolve(picked || undefined);
            quickPick.hide();
        });

        quickPick.onDidHide(() => {
            resolve(undefined);
            quickPick.dispose();
        });

        quickPick.show();
    });
}

export function openRemoteSSHWindow(host: string, reuseWindow: boolean) {
    vscode.commands.executeCommand('vscode.newWindow', { remoteAuthority: getRemoteAuthority(host), reuseWindow });
}

export function openRemoteSSHLocationWindow(host: string, path: string, reuseWindow: boolean) {
    vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.from({ scheme: 'vscode-remote', authority: getRemoteAuthority(host), path }), { forceNewWindow: !reuseWindow });
}

export async function addNewHost() {
    const sshConfigPath = getSSHConfigPath();
    if (!await fileExists(sshConfigPath)) {
        await fs.promises.appendFile(sshConfigPath, '');
    }

    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(sshConfigPath), { preview: false });

    const textEditor = vscode.window.activeTextEditor;
    if (textEditor?.document.uri.fsPath !== sshConfigPath) {
        return;
    }

    const textDocument = textEditor.document;
    const lastLine = textDocument.lineAt(textDocument.lineCount - 1);

    if (!lastLine.isEmptyOrWhitespace) {
        await textEditor.edit((editBuilder: vscode.TextEditorEdit) => {
            editBuilder.insert(lastLine.range.end, '\n');
        });
    }

    const snippet = '\nHost ${1:dev}\n\tHostName ${2:dev.example.com}\n\tUser ${3:john}';

    await textEditor.insertSnippet(
        new vscode.SnippetString(snippet),
        new vscode.Position(textDocument.lineCount, 0)
    );
}

export async function openSSHConfigFile() {
    const sshConfigPath = getSSHConfigPath();
    if (!await fileExists(sshConfigPath)) {
        await fs.promises.appendFile(sshConfigPath, '');
    }
    vscode.commands.executeCommand('vscode.open', vscode.Uri.file(sshConfigPath));
}
