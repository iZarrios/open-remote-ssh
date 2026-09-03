import * as crypto from 'crypto';
import * as os from 'os';
import type { HostConfiguration } from './sshConfig';

export type SharingDestination = {
    host: string;
    port: number;
    user: string;
};

export type PersistPolicy =
    | { kind: 'immediate' }
    | { kind: 'timed'; idleSeconds: number }
    | { kind: 'indefinite' };

export type SharingIdentity = {
    controlPath: string;
    host: string;
    port: number;
    user: string;
};

export type DirectSharingReason =
    | 'absent'
    | 'none-path'
    | 'unsupported-platform'
    | 'unsupported-master'
    | 'unsupported-token'
    | 'invalid-persist';

export type DirectSharingPolicy = {
    sharing: false;
    reason: DirectSharingReason;
    warning?: string;
};

export type SharingAction = 'attach' | 'attach-or-create' | 'create';

export type SharedSharingPolicy = {
    sharing: true;
    action: SharingAction;
    persist: PersistPolicy;
    identity: SharingIdentity;
};

export type SharingPolicy = DirectSharingPolicy | SharedSharingPolicy;

export type ResolveSharingPolicyOptions = {
    platform?: NodeJS.Platform;
    localHostname?: string;
    homedir?: string;
};

const SUPPORTED_CONTROL_PATH_TOKENS = new Set(['%', 'h', 'p', 'r', 'C']);

export function resolveSharingPolicy(
    config: HostConfiguration,
    destination: SharingDestination,
    options: ResolveSharingPolicyOptions = {},
): SharingPolicy {
    const platform = options.platform ?? process.platform;
    const controlMaster = (config.ControlMaster || 'no').toLowerCase();
    const controlPath = config.ControlPath;
    const action = sharingAction(controlMaster);

    if (!controlPath && controlMaster === 'no') {
        return { sharing: false, reason: 'absent' };
    }

    if (controlPath && controlPath.toLowerCase() === 'none') {
        return { sharing: false, reason: 'none-path' };
    }

    if (!action) {
        if (controlMaster === 'ask' || controlMaster === 'autoask') {
            return {
                sharing: false,
                reason: 'unsupported-master',
                warning: `ControlMaster ${controlMaster} is ignored because interactive mux approval is unsupported; connecting directly.`,
            };
        }
        return { sharing: false, reason: 'absent' };
    }

    if (!controlPath) {
        return { sharing: false, reason: 'absent' };
    }

    if (platform === 'win32') {
        return {
            sharing: false,
            reason: 'unsupported-platform',
            warning: 'Extension-managed connection sharing is unsupported on Windows; connecting directly.',
        };
    }

    const persist = parseControlPersist(config.ControlPersist);
    if (!persist) {
        return {
            sharing: false,
            reason: 'invalid-persist',
            warning: `ControlPersist '${config.ControlPersist}' is not a valid OpenSSH duration; connecting directly.`,
        };
    }

    const expanded = expandControlPath(controlPath, destination, options);
    if (!expanded.ok) {
        return {
            sharing: false,
            reason: 'unsupported-token',
            warning: `ControlPath token ${expanded.token} is unsupported; connecting directly.`,
        };
    }

    return {
        sharing: true,
        action,
        persist,
        identity: {
            controlPath: expanded.value,
            host: destination.host,
            port: destination.port,
            user: destination.user,
        },
    };
}

function sharingAction(controlMaster: string): SharingAction | undefined {
    switch (controlMaster) {
        case 'no':
            return 'attach';
        case 'auto':
            return 'attach-or-create';
        case 'yes':
            return 'create';
        default:
            return undefined;
    }
}

function parseControlPersist(value: string | undefined): PersistPolicy | undefined {
    if (value === undefined || value.toLowerCase() === 'no') {
        return { kind: 'immediate' };
    }
    if (value.toLowerCase() === 'yes' || value === '0') {
        return { kind: 'indefinite' };
    }
    const idleSeconds = parseOpenSSHTime(value);
    if (idleSeconds === undefined) {
        return undefined;
    }
    return { kind: 'timed', idleSeconds };
}

/**
 * OpenSSH convtime(3)-compatible duration parser: integer seconds, or a
 * concatenation of values with s/m/h/d/w suffixes.
 */
function parseOpenSSHTime(value: string): number | undefined {
    let total = 0;
    let i = 0;
    while (i < value.length) {
        let digits = '';
        while (i < value.length && value[i] >= '0' && value[i] <= '9') {
            digits += value[i];
            i += 1;
        }
        if (!digits) {
            return undefined;
        }
        const amount = Number(digits);
        let multiplier = 1;
        if (i < value.length) {
            const unit = value[i].toLowerCase();
            i += 1;
            switch (unit) {
                case 's':
                    multiplier = 1;
                    break;
                case 'm':
                    multiplier = 60;
                    break;
                case 'h':
                    multiplier = 60 * 60;
                    break;
                case 'd':
                    multiplier = 24 * 60 * 60;
                    break;
                case 'w':
                    multiplier = 7 * 24 * 60 * 60;
                    break;
                default:
                    return undefined;
            }
        }
        total += amount * multiplier;
    }
    return total;
}

function expandControlPath(
    controlPath: string,
    destination: SharingDestination,
    options: ResolveSharingPolicyOptions,
): { ok: true; value: string } | { ok: false; token: string } {
    const homedir = options.homedir ?? os.homedir();
    const path = controlPath.replace(/^~(?=$|\/|\\)/, homedir);

    let result = '';
    for (let i = 0; i < path.length; i++) {
        const ch = path[i];
        if (ch !== '%') {
            result += ch;
            continue;
        }
        const token = path[i + 1];
        if (!token) {
            return { ok: false, token: '%' };
        }
        if (!SUPPORTED_CONTROL_PATH_TOKENS.has(token)) {
            return { ok: false, token: `%${token}` };
        }
        i += 1;
        result += expandToken(token, destination, options);
    }
    return { ok: true, value: result };
}

function expandToken(
    token: string,
    destination: SharingDestination,
    options: ResolveSharingPolicyOptions,
): string {
    switch (token) {
        case '%':
            return '%';
        case 'h':
            return destination.host;
        case 'p':
            return String(destination.port);
        case 'r':
            return destination.user;
        case 'C': {
            const localHostname = options.localHostname ?? os.hostname();
            return crypto
                .createHash('sha1')
                .update(`${localHostname}${destination.host}${destination.port}${destination.user}`)
                .digest('hex');
        }
        default:
            return '';
    }
}
