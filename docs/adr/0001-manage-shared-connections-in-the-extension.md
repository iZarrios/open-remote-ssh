---
status: proposed
---

# Manage shared SSH connections in the extension

Keep `ssh2` as the remote SSH transport and implement persistent connection sharing downstream in the extension. An on-demand, per-user background broker will own shared connections across VS Code processes and exit according to the configured persistence policy. Existing `ControlMaster`, `ControlPersist`, and `ControlPath` directives will provide sharing policy and identity, while private IPC remains in an extension-owned location and is not compatible with OpenSSH's mux protocol. This preserves the existing transport while addressing repeated authentication across extension consumers.

The first release targets Linux and macOS. It supports `ControlMaster` values `no`, `yes`, and `auto`; `ask` and `autoask` fail explicitly as unsupported. Their behavior follows OpenSSH: `no` reuses an existing master but does not create one, `auto` reuses or creates a master, and `yes` creates a new master without first reusing an existing one; if its sharing identity is already occupied, that connection continues unshared. It implements `ControlPersist` for immediate close, timed idle expiry, and indefinite persistence. `ControlPath` identity expansion supports `~`, `%%`, `%h`, `%p`, `%r`, and `%C`; other tokens fail explicitly.

Callers acquire a connection lease from a small provider interface. A direct adapter uses the existing in-process `ssh2` connection when sharing is disabled; a broker adapter uses private IPC when sharing is enabled. Authentication prompts for a new master are delegated to its requesting extension process, while consumers of a live master are never prompted again.

OpenSSH's implementation is the behavioral reference for directive and lifecycle semantics. Deviations must be explicit and justified; initially, broker attachment additionally validates the resolved host, port, and user instead of trusting `ControlPath` alone.

A single per-user broker owns the connection registry. If broker startup, attachment, or protocol negotiation fails, ordinary connection requests fall back to a direct unshared `ssh2` connection with a warning, following OpenSSH's normal-session behavior. Authentication rejection, cancellation, host verification, and remote network failures do not fall back. IPC handshakes require an exact protocol version; a mismatched broker remains until its active leases end, while the incompatible client uses a direct connection.

Channels, local listeners, and tunnels belong to the lease that opened them and close when that lease disconnects; the authenticated transport may remain according to `ControlPersist`. If a shared transport fails, the broker fails every attached lease and waits for a later explicit resolve to create and authenticate a replacement instead of prompting an arbitrary window or retaining credentials.

The broker protocol separates control from data. A versioned control connection carries requests, results, errors, authentication prompts, and lifecycle events. Each streaming SSH channel uses a temporary Unix data socket, while the broker owns forwarding listeners and returns their local addresses. This approximates OpenSSH's descriptor-passing design using Node's portable stream primitives.

The broker follows OpenSSH's same-user trust model. Its runtime directory must be owned by the current user with mode `0700`; startup rejects symlinks, unexpected ownership, or permissive modes and creates private socket endpoints without storing authentication secrets.

Sharing activates automatically when the effective SSH configuration contains a supported `ControlMaster` value and valid `ControlPath`; no additional extension setting is required. Connections persisted indefinitely can be inspected and closed through a single `Remote-SSH: Manage Shared Connections...` command, while immediate and timed cleanup remain automatic. Closing an active master follows OpenSSH's immediate termination behavior and disconnects its leases, but the command palette requires explicit confirmation that names the affected clients; it may also offer a non-OpenSSH convenience action to close after the final lease is released.

The required integration test uses two independent broker clients connecting through a jump host to an MFA-protected target. It must prove that both clients work through one remote transport and that only the first client receives authentication prompts.

The broker ships in the extension as a second bundled Node entry point and is launched on demand using the editor-provided runtime; it is not a separately installed package or system service. Broker-owned masters support the extension's existing direct, `ProxyJump`, and `ProxyCommand` routes, and freeze the complete route configuration when the master is created.
