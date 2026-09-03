# Remote SSH Connections

This context describes how authenticated SSH connections are owned and shared by the extension.

## Language

**SSH transport**:
The component that establishes an authenticated SSH connection and carries its logical channels. The extension's transport remains the `ssh2` library.

**Extension-managed connection sharing**:
Reuse of an authenticated `ssh2` connection coordinated by extension-owned code. It is distinct from OpenSSH ControlMaster compatibility.
_Avoid_: ControlMaster support

**Connection broker**:
An on-demand, per-user background process that owns shared SSH transports for multiple extension processes.
_Avoid_: Daemon, system service

**Connection lease**:
A consumer's temporary right to use a broker-owned SSH transport. Releasing a lease detaches that consumer without necessarily closing the transport.
_Avoid_: Connection, session

**Sharing identity**:
The logical key derived from `ControlPath` and the resolved host, port, and user that selects a broker-owned connection. Unlike OpenSSH, attachment rejects destination mismatches; it is not the path of the broker's private IPC endpoint.
_Avoid_: Control socket

**Sharing policy**:
The effective `ControlMaster` and `ControlPersist` values that determine whether a connection may be shared and how long it survives without consumers.
_Avoid_: Control options

**OpenSSH ControlMaster**:
OpenSSH's cross-process connection-sharing facility, coordinated through the mux protocol at `ControlPath` and governed by `ControlPersist`.
_Avoid_: SSH multiplexing
