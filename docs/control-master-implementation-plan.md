# Extension-managed connection sharing plan

Status: ready for maintainer review. Scope: issue [#206](https://github.com/jeanp413/open-remote-ssh/issues/206).

## Before coding

Post the proposed architecture on #206 and obtain maintainer approval. `CONTRIBUTING.md` requires an accepted issue for non-trivial work; do not use a WIP PR for design discussion.

Keep `ssh2` as the SSH transport. OpenSSH is the behavioral reference, not a runtime dependency and not an IPC compatibility target:

- [`ssh_config(5)` control directives](https://man.openbsd.org/ssh_config#ControlMaster)
- [OpenSSH mux protocol](https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.mux)
- [OpenSSH mux implementation](https://github.com/openssh/openssh-portable/blob/master/mux.c)
- [OpenSSH client lifecycle](https://github.com/openssh/openssh-portable/blob/master/ssh.c)

## Public seams

Tests and callers use these seams; broker internals stay hidden:

1. `resolveSharingPolicy(config, destination)` returns the OpenSSH-derived policy and sharing identity.
2. `ConnectionProvider.acquire(request)` returns a `ConnectionLease` exposing the SSH operations currently used by the resolver: exec, streaming exec, forwarding/tunnels, and close.
3. `BrokerClient` exposes acquire/list/close operations over a versioned local protocol.

`RemoteSSHResolver` depends only on `ConnectionProvider`; it must not know whether a lease is direct or brokered.

## Vertical implementation slices

Each slice is test-first: add one failing behavior test, implement the smallest passing behavior, then continue.

### 1. Parse and resolve sharing policy

- Add `ControlMaster`, `ControlPath`, and `ControlPersist` normalization to `src/ssh/sshConfig.ts`.
- Add a focused sharing-policy module under `src/ssh/`.
- Implement `ControlMaster` exactly:
  - `no`: attach to an existing master, otherwise connect directly and create none.
  - `auto`: attach to an existing master or create one.
  - `yes`: do not attach first; create a new master, but continue unshared if the identity is occupied.
  - `ask` and `autoask`: warn and connect directly because interactive mux approval is unsupported.
- Parse `ControlPersist no`, durations, and `yes`/`0`.
- Expand `ControlPath` tokens `~`, `%%`, `%h`, `%p`, `%r`, and `%C`. Reject unsupported tokens and use a direct connection with a warning.
- Key the broker registry by expanded `ControlPath` plus resolved host, port, and user. Freeze route/auth/agent configuration when creating the master.
- On Windows, retain current direct behavior and log that sharing is unsupported.

Tests: table-driven policy, duration, expansion, invalid-token, platform, and exact `no`/`auto`/`yes` behavior tests in `test/ssh/connection-sharing.test.ts`.

### 2. Introduce the lease without changing behavior

- Define the small `ConnectionLease`/`ConnectionProvider` interfaces in `src/ssh/`.
- Wrap the existing `SSHConnection` with a direct provider.
- Move direct/`ProxyJump`/`ProxyCommand` route construction out of `authResolver.ts` into one route factory so direct and broker paths cannot drift.
- Change `authResolver.ts`, server setup, agent-forward session, SOCKS forwarding, and tunnel creation to consume a lease.

Tests: run existing fixtures through the direct provider and prove resolver disposal releases lease-owned channels/listeners. Existing behavior must remain unchanged when control directives are absent.

### 3. Add the secure broker protocol and launcher

- Add `src/broker/main.ts`, `client.ts`, `protocol.ts`, `runtime.ts`, and `registry.ts`.
- Bundle `main.ts` as `lib/connectionBroker.js` via a second webpack entry and include it in `.vscodeignore` packaging rules.
- Launch it on demand with the editor-provided Node/Electron runtime, detached from the requesting window.
- Use one per-user broker with a registry of many masters. Serialize creation per sharing identity so concurrent first clients cannot both authenticate.
- Use an exact protocol-version hello. On mismatch, leave the old broker alive for current leases and let the new client connect directly.
- Place IPC below a private, current-user-owned `0700` runtime directory. Reject symlinks, wrong ownership, or permissive modes. Create restrictive Unix sockets and safely distinguish a live endpoint from a stale one before unlinking.
- Put requests, responses, authentication prompts, errors, and lifecycle events on the control connection. Use a new temporary Unix data socket for each byte stream; the broker owns forwarding listeners and returns their local addresses.

Tests: start real broker child processes against a fake transport boundary; test startup races, stale sockets, ownership/mode rejection, protocol mismatch, request correlation, and stream backpressure. Mock only process/OS/transport boundaries, not broker modules.

### 4. Own authenticated `ssh2` transports in the broker

- Have the first requester supply route material and service host-key, password, passphrase, keyboard-interactive/MFA, and agent requests over the control protocol.
- Keep secrets only in memory for the active authentication exchange; never write credentials or passphrases to disk.
- After authentication, later leases attach without authentication callbacks or prompts.
- Support direct, `ProxyJump`, and `ProxyCommand` routes from the first release; the broker owns the entire route and its child processes/connections.
- Track states explicitly: creating, authenticating, ready, idle, closing, failed.
- Scope channels, data sockets, SOCKS/local listeners, and tunnels to their creating lease. Releasing a lease closes those resources, then applies `ControlPersist`: immediate, timed idle expiry, or indefinite.
- A remote transport failure fails all leases. Reauthentication occurs only on a later explicit resolve; never select an arbitrary attached window to prompt.
- Broker infrastructure failure falls back to a warned direct connection. Authentication, cancellation, host-key, and remote network failures remain terminal to avoid duplicate prompts.

Tests: two broker clients share one fake authenticated transport; the second gets no prompt; lease cleanup, persist timers with a fake clock, route freezing, failure fan-out, and fallback classification are observable through the provider/client APIs.

### 5. Management command

- Add `Remote-SSH: Manage Shared Connections...` to `package.json`, `src/commands.ts`, and `src/extension.ts`.
- List destination, state, lease count, age, and persistence policy without exposing secrets.
- Closing an idle master is immediate. Closing an active master requires confirmation naming the affected lease count, then disconnects those leases like OpenSSH `ssh -O exit`. Optionally offer “close when idle” as a convenience.

Tests: command-level tests for listing, idle close, cancellation, and confirmed active close.

### 6. Reproduce issue #206 end to end

- Add Docker fixtures for a jump host and a target requiring keyboard-interactive MFA. Instrument the target authentication path with an independent counter.
- Spawn two independent broker clients/processes using `ProxyJump` and the same sharing identity.
- Assert both can execute a remote command, exactly one target SSH transport/authentication completes, and the second client receives zero authentication prompts.
- Add a parallel `ProxyCommand` case and lifecycle cases for `ControlPersist no`, a short duration, and `yes`/`0`.

This is the merge gate; unit tests alone do not demonstrate that the reported MFA problem is fixed.

## Verification

Run on Linux CI and manually smoke-test macOS:

```sh
npm run compile:src
npm run compile:test
npm run lint
npm run test:images
npm test
npm run package
```

Inspect the produced VSIX to confirm both bundles are present. Verify no version bump or changelog entry is included, per `CONTRIBUTING.md`.

## PR boundaries

Keep the final PR focused on issue #206. Avoid unrelated `SSHConnection` cleanup. If review size becomes a concern, land slice 2 as a behavior-preserving preparatory PR only after the maintainer agrees; the user-visible sharing feature and its end-to-end MFA test should otherwise land together.
