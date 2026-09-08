import { describe, expect, it } from 'vitest';
import SSHConfig from 'ssh-config';
import SSHConfiguration from '../../src/ssh/sshConfig';
import { resolveSharingPolicy } from '../../src/ssh/sharingPolicy';

const destination = {
    host: 'example.com',
    port: 22,
    user: 'alice',
};

const linux = { platform: 'linux' as const, localHostname: 'testhost.local', homedir: '/home/alice' };

describe('resolveSharingPolicy', () => {
    it('connects directly when control directives are absent', () => {
        const policy = resolveSharingPolicy({}, destination);

        expect(policy).toEqual({
            sharing: false,
            reason: 'absent',
        });
    });

    it('attaches or creates a master when ControlMaster is auto and ControlPath is set', () => {
        const policy = resolveSharingPolicy({
            ControlMaster: 'auto',
            ControlPath: '/tmp/ssh-%r@%h:%p',
        }, destination, linux);

        expect(policy).toEqual({
            sharing: true,
            action: 'attach-or-create',
            persist: { kind: 'immediate' },
            identity: {
                controlPath: '/tmp/ssh-alice@example.com:22',
                host: 'example.com',
                port: 22,
                user: 'alice',
            },
        });
    });

    it('attaches to an existing master but does not create one when ControlMaster is no', () => {
        const policy = resolveSharingPolicy({
            ControlMaster: 'no',
            ControlPath: '/tmp/ssh-%h',
        }, destination, linux);

        expect(policy).toMatchObject({
            sharing: true,
            action: 'attach',
            identity: { controlPath: '/tmp/ssh-example.com' },
        });
    });

    it('creates a new master without attaching first when ControlMaster is yes', () => {
        const policy = resolveSharingPolicy({
            ControlMaster: 'yes',
            ControlPath: '/tmp/ssh-%h',
        }, destination, linux);

        expect(policy).toMatchObject({
            sharing: true,
            action: 'create',
            identity: { controlPath: '/tmp/ssh-example.com' },
        });
    });

    it.each([
        ['ask'],
        ['autoask'],
    ])('warns and connects directly when ControlMaster is %s', (controlMaster) => {
        const policy = resolveSharingPolicy({
            ControlMaster: controlMaster,
            ControlPath: '/tmp/ssh-%h',
        }, destination, linux);

        expect(policy.sharing).toBe(false);
        if (policy.sharing) {
            return;
        }
        expect(policy.reason).toBe('unsupported-master');
        expect(policy.warning).toMatch(/interactive mux approval is unsupported/i);
    });

    it('attaches without creating when only ControlPath is set', () => {
        const policy = resolveSharingPolicy({
            ControlPath: '/tmp/ssh-%h',
        }, destination, linux);

        expect(policy).toMatchObject({
            sharing: true,
            action: 'attach',
            identity: { controlPath: '/tmp/ssh-example.com' },
        });
    });

    it('connects directly when ControlPath is none', () => {
        const policy = resolveSharingPolicy({
            ControlMaster: 'auto',
            ControlPath: 'none',
        }, destination, linux);

        expect(policy).toEqual({
            sharing: false,
            reason: 'none-path',
        });
    });

    it.each([
        ['no', { kind: 'immediate' }],
        ['yes', { kind: 'indefinite' }],
        ['0', { kind: 'indefinite' }],
        ['90', { kind: 'timed', idleSeconds: 90 }],
        ['10m', { kind: 'timed', idleSeconds: 600 }],
        ['1h30m', { kind: 'timed', idleSeconds: 5400 }],
        ['1m30s', { kind: 'timed', idleSeconds: 90 }],
        ['2d', { kind: 'timed', idleSeconds: 172800 }],
        ['1w', { kind: 'timed', idleSeconds: 604800 }],
    ] as const)('parses ControlPersist %s', (value, persist) => {
        const policy = resolveSharingPolicy({
            ControlMaster: 'auto',
            ControlPath: '/tmp/ssh-%h',
            ControlPersist: value,
        }, destination, linux);

        expect(policy).toMatchObject({ sharing: true, persist });
    });

    it('warns and connects directly when ControlPersist is invalid', () => {
        const policy = resolveSharingPolicy({
            ControlMaster: 'auto',
            ControlPath: '/tmp/ssh-%h',
            ControlPersist: 'forever',
        }, destination, linux);

        expect(policy.sharing).toBe(false);
        if (policy.sharing) {
            return;
        }
        expect(policy.reason).toBe('invalid-persist');
        expect(policy.warning).toMatch(/ControlPersist/i);
    });

    it('expands ~, %%, %h, %p, and %r in ControlPath', () => {
        const policy = resolveSharingPolicy({
            ControlMaster: 'auto',
            ControlPath: '~/.ssh/%%cm-%r@%h:%p',
        }, destination, linux);

        expect(policy).toMatchObject({
            sharing: true,
            identity: {
                controlPath: '/home/alice/.ssh/%cm-alice@example.com:22',
            },
        });
    });

    it('expands %C as the SHA1 of local host, remote host, port, and user', () => {
        const policy = resolveSharingPolicy({
            ControlMaster: 'auto',
            ControlPath: '~/.ssh/%C',
        }, destination, linux);

        expect(policy).toMatchObject({
            sharing: true,
            identity: {
                // sha1("testhost.local" + "example.com" + "22" + "alice")
                controlPath: '/home/alice/.ssh/75ee3cf9ec7301d2f55141c94f451dba0ed0ae8d',
            },
        });
    });

    it('includes ProxyJump in the %C hash like OpenSSH', () => {
        const policy = resolveSharingPolicy({
            ControlMaster: 'auto',
            ControlPath: '~/.ssh/%C',
            ProxyJump: 'jump.example:2222',
        }, destination, linux);

        expect(policy).toMatchObject({
            sharing: true,
            identity: {
                // sha1("testhost.local" + "example.com" + "22" + "alice" + "jump.example:2222")
                controlPath: '/home/alice/.ssh/b0761cf353bd9efd652bc25fb40fbd59557dafd3',
            },
        });
    });

    it('warns and connects directly when ControlPath contains an unsupported token', () => {
        const policy = resolveSharingPolicy({
            ControlMaster: 'auto',
            ControlPath: '/tmp/ssh-%u@%h',
        }, destination, linux);

        expect(policy.sharing).toBe(false);
        if (policy.sharing) {
            return;
        }
        expect(policy.reason).toBe('unsupported-token');
        expect(policy.warning).toMatch(/%u/);
    });

    it('retains a direct connection on Windows and warns that sharing is unsupported', () => {
        const policy = resolveSharingPolicy({
            ControlMaster: 'auto',
            ControlPath: '/tmp/ssh-%h',
        }, destination, { ...linux, platform: 'win32' });

        expect(policy.sharing).toBe(false);
        if (policy.sharing) {
            return;
        }
        expect(policy.reason).toBe('unsupported-platform');
        expect(policy.warning).toMatch(/Windows/i);
    });
});

describe('SSHConfiguration control directive normalization', () => {
    it('canonicalizes ControlMaster, ControlPath, and ControlPersist', () => {
        const config = new SSHConfiguration(SSHConfig.parse(`
Host example.com
  controlmaster auto
  controlpath ~/.ssh/%C
  controlpersist 10m
`));
        const host = config.getHostConfiguration('example.com');

        expect(host.ControlMaster).toBe('auto');
        expect(host.ControlPath).toBe('~/.ssh/%C');
        expect(host.ControlPersist).toBe('10m');
    });
});
