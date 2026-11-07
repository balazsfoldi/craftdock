# ADR 0003: Agent Docker Engine Access

- Status: Accepted
- Date: 2026-11-04

## Context

M1 must create, start, stop, inspect, and stream logs for Vanilla server containers on the single Windows Docker Desktop worker. The Manager runs on a separate Raspberry Pi and must not receive Docker host access. The Agent is a Linux container in Docker Desktop's Linux-container environment. The Manager–Agent connection remains outbound and authenticated; the Docker Engine endpoint must not be published on a network interface.

Docker documents a local Unix socket for Windows Docker Desktop clients using the WSL 2 backend. Docker also warns that daemon access is highly privileged. The current development worker reports Docker Desktop 4.40.0 and Engine 28.0.4, but access from the containerized Agent and its socket permissions still require a local proof-of-concept.

## Decision

**Accepted:** bind-mount the worker's local `/var/run/docker.sock` into the `craftdock-agent` container only. Do not mount it into the Manager, web UI, or any Minecraft server; do not publish a Docker API TCP port. Keep the Manager-to-Agent protocol as the only remote command path.

The Agent must expose a fixed, validated operation set for CraftDock servers: create from a CraftDock-controlled Vanilla runtime image, start, stop, delete, inspect, enumerate by CraftDock labels, stream logs, and submit a dedicated Minecraft console line as described in [ADR 0004](0004-minecraft-console-channel.md). It must not expose a generic Docker API or accept user-provided image names, shell commands, entrypoints, host paths, devices, privileged mode, host namespaces, or arbitrary container configuration. Server data uses an Agent-created named volume mounted only at the runtime's fixed data directory. The Agent validates IDs, ports, resource limits, labels, deadlines, and idempotency before making Docker calls.

The user approved this decision on 2026-11-04. Implementation and local socket proof-of-concept validation are in progress; acceptance does not claim those checks have already passed.

## Alternatives

1. **Mount the local Unix socket into the Agent only (recommended).** This matches Docker Desktop's documented local socket for Windows WSL 2 clients and keeps the daemon endpoint off the network. It has the smallest operational footprint. A compromised Agent can still control the Docker host, so the Agent must remain a small, reviewed, trusted component with a strict operation allowlist.
2. **Run a local Docker API proxy in front of the socket.** This can reject API routes and request fields before they reach Docker. It adds another privileged component and deployment dependency; safe container creation requires validating nested request bodies, and log/stream endpoints need careful handling. The proxy itself still owns the socket and must not be reachable from outside the worker's private Compose network.
3. **Defer Docker access and keep M1 mocked.** This avoids granting host privileges but cannot satisfy M1's real server lifecycle or minimum MVP acceptance criteria.

Docker's documented TCP/TLS daemon access is not selected: a remote Engine API endpoint conflicts with the repository constraint against inbound Docker Engine API exposure. See [Protect the Docker daemon socket](https://docs.docker.com/engine/security/protect-access/), [Docker Desktop general FAQs](https://docs.docker.com/desktop/troubleshoot-and-support/faqs/general/), and [Docker Engine security](https://docs.docker.com/engine/security/).

## Consequences

- Only the trusted Windows Agent receives the local Docker socket; the Pi Manager remains unprivileged with respect to Docker.
- The Agent is a host-security boundary. A compromise of its process can become a Docker host compromise; dependency review, minimal code, strict message validation, and no arbitrary command/configuration forwarding are mandatory.
- The Manager-Agent protocol exposes only named server operations. It does not proxy Docker endpoints or provide shell execution.
- Docker Desktop startup and socket availability remain runtime dependencies; the Manager must stay usable and server observations must become `UNKNOWN` while the Agent is offline.
- The named-volume data path and the assigned host-port behavior must be verified on the actual Windows Docker Desktop worker.

## Validation

- From the Agent container, verify access to the local Unix socket and record the negotiated Engine API version. Do not create or expose a TCP listener for the Engine API.
- Inspect resolved Compose configuration: only the Agent has the socket mount, and the Manager and Minecraft containers do not.
- Exercise malformed, unauthorized, duplicate, and expired protocol commands against a mocked Engine and prove they cannot invoke Docker operations.
- With Docker Desktop available, create two Vanilla server containers on distinct reserved ports with distinct named volumes, stream logs, stop/start them, and verify labels and volume contents survive Agent and Manager restarts without duplicate containers.
- Confirm the Agent rejects unsupported image/configuration fields and never accepts arbitrary process commands or host paths.
