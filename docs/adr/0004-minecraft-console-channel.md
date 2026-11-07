# ADR 0004: Minecraft Console Channel and Server Deletion

- Status: Accepted
- Date: 2026-11-05

## Context

M1 needs a safe way to remove a CraftDock server, and M2 needs web-based Minecraft console commands. The Agent is the only service with Docker socket access. Web users must not receive Docker or operating-system command execution. Minecraft console commands can mutate world and server state, may be non-idempotent, and must be restricted to authorized server members and audited.

## Decision

**Accepted:** keep the M1 `server.delete` action in protocol version 2 and add the M2 `server.console` action in protocol version 3.

- `server.delete` stops and removes only the container whose CraftDock labels and runtime configuration validate for that server. It retains the named world volume by default. Permanent volume deletion requires the explicit `deleteWorld: true` option and label validation on that volume. The Manager hides the server after successful Agent confirmation while retaining its operation and audit history.
- `server.console` accepts one trimmed, single-line Minecraft command of at most 512 characters. The Manager applies per-server RBAC, writes an audit event with the command name but not arguments, and queues a correlated operation. The Agent validates the managed container and writes the line only to its Java process stdin. No shell, Docker exec, arbitrary process, or arbitrary Docker configuration is exposed. The live Minecraft log stream is the feedback channel.
- The Agent never replays a running console operation after a disconnect. If the result is uncertain, the Manager reports `COMMAND_RESULT_UNKNOWN`; this avoids repeating non-idempotent commands. Other lifecycle operations remain idempotent or safely retryable.
- New server containers enable stdin without a TTY. Existing M1 containers are recreated on a later start when stdin is unavailable; their named world volume is retained.
- The Agent protocol version is raised to 3 for console support. Manager and Agent must be upgraded together.

## Alternatives

1. **Use the Minecraft process stdin.** It sends input directly to the already-running Java process, needs no additional RCON credential or port, and does not invoke a shell. Existing containers need a one-time recreation with the same world volume. This is the selected design.
2. **Enable Minecraft RCON.** RCON is a well-defined console protocol, but requires a generated password, persistent secret handling, configuration of each server, and careful private networking. It adds a credential and another listener without benefit for the current single-worker scope.
3. **Run Docker `exec` with a shell or generic command.** This is rejected because it expands the Agent's host-level Docker authority into an arbitrary process-execution interface and conflicts with the operation allowlist.

## Consequences

- A Platform Admin, Server Owner, or Server Operator may use the Minecraft console. A Viewer may read server state and logs but cannot submit commands.
- Console arguments are kept only in the pending operation payload until completion; the audit log records the actor, server, and command name. Server logs may contain responses emitted by Minecraft itself.
- Commands are delivered at most once from the Manager's perspective. A disconnect can leave the user uncertain whether a command took effect; the UI must show the unknown result and require the user to inspect the server before retrying.
- Deleting a server frees its port and removes its container. Kept world volumes remain labeled on the worker for manual recovery; the UI does not yet reattach them.
- Restarting an old M1 container during its first start after upgrade causes brief downtime but does not delete world data.

## Validation

- Typecheck and build the Manager, Agent, protocol, and web packages.
- On Windows Docker Desktop, confirm a Vanilla console command reaches the Java stdin and its response appears in the live logs.
- Confirm an existing M1 container is recreated once on start and the world volume contents remain unchanged.
- Verify delete preserves the volume by default, deletes only a label-matched volume when explicitly selected, releases the port, and never touches an unrelated container or volume.
- Check role enforcement and audit events for Platform Admin, Owner, Operator, and Viewer; disconnect the Agent during a console operation and confirm the command is not replayed.
