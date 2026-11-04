# ADR 0002: Docker Control in M0

- Status: Accepted
- Date: 2026-11-04

## Context

The technical specification's M0 roadmap says to launch a `hello-world` container from the Pi. The implementation kickoff limits M0 to Manager–Agent connectivity and says not to mount the Docker socket. Repository instructions make this a non-negotiable M0 constraint and also prohibit arbitrary remote command execution. Launching a container requires an Agent-side Docker control path, which is outside the currently permitted M0 scope.

## Decision

**Accepted:** keep M0 limited to authentication, registration, heartbeats, timeout detection, status reporting, and reconnection. Defer container creation to a later milestone with a separate Docker-access threat model and an explicit allowlist. Do not mount or expose a Docker socket in M0.

The current implementation follows this decision. It does not launch containers. The specification now defers the `hello-world` check beyond M0.

## Alternatives

1. **Defer Docker control.** Complete the connectivity proof without granting the Agent Docker access. This aligns with the kickoff and repository security constraint; the specification now defers the container-launch check to a later milestone.
2. **Add a narrowly allowlisted container operation in M0.** This could avoid arbitrary shell commands, but it still requires Docker API access from the Agent and conflicts with the no-socket M0 constraint. It needs a separate threat model and approval before implementation.
3. **Run `hello-world` manually on the worker.** This verifies Docker Desktop independently, but it does not demonstrate Manager-to-Agent container control and therefore does not meet the specification's stated purpose for that step.

## Consequences

- M0 demonstrates connectivity and worker status only; it does not demonstrate Docker Desktop readiness or remote container launch.
- The Manager remains usable while the Agent is offline, and no service receives Docker host privileges.
- Before Docker control is introduced, evaluate the Windows Docker Desktop socket path or a restricted local proxy, the Agent's privilege boundary, and the exact allowlisted operations.
- The specification and decision log record this accepted deferral.

## Validation

- Verify Compose starts the independent Manager and Agent services when Docker Desktop is available.
- Verify authentication, heartbeat, offline timeout, and Manager-restart reconnection without a Docker socket.
- Before later Docker control, run a separate Windows Docker Desktop proof-of-concept and security review for the restricted API surface.
