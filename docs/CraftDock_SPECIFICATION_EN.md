# CraftDock — Technical Specification

**Version:** 1.2 (M1/M2 implementation scope)
**Date:** November 5, 2026
**Status:** Approved design baseline with accepted M0/M1/M2 decisions.

## 1. Purpose and Scope

CraftDock is a self-hosted, multi-user Minecraft Java Edition hosting platform. A Raspberry Pi 5 provides an always-available control plane, while a Windows PC runs the actual Minecraft servers using Docker Desktop. Users create, configure, start, stop, and monitor servers through a web browser. The project is intended to be open source and deployed using Docker.

**Out of scope for the initial release:** multiple workers, Kubernetes, commercial hosting and billing, Bedrock Edition, automatic PC wake-up, arbitrary user-supplied code execution on the control plane, and guaranteed fully automated compatibility with every third-party modpack.

## 2. Approved Product Decisions

- Multiple users with role-based access control (RBAC).
- Exactly one Windows PC worker in the first release.
- Minecraft Java Edition: Vanilla, Paper, Fabric, Forge, and NeoForge.
- Modpack sources: Modrinth, CurseForge, and custom ZIP archives, subject to external licensing and API restrictions.
- Connectivity: LAN, port forwarding with dynamic DNS, and tunneling without inbound port forwarding.
- Active worlds and server files stored on the Windows PC's SSD; optional backups transferred to the Raspberry Pi.
- Manual PC power-on; Wake-on-LAN is excluded from the MVP.
- All CraftDock components run in containers, including the Windows worker agent.
- M0 Agent authentication uses a high-entropy, per-worker shared token; production connections use WSS, and rotation requires coordinated Manager and Agent restarts (ADR 0001).
- M0 is limited to Manager–Agent connectivity and status. Docker access and container launch are deferred beyond M0 (ADR 0002).

## 3. Logical Architecture

The **Control Plane** on the Raspberry Pi manages the web interface, API, authentication, configuration, database, command queue, and worker status. The **Worker Plane** on the Windows PC consists of the CraftDock Agent and the Minecraft containers it manages. The Agent accesses only its local Docker Engine; the Raspberry Pi is never given direct Docker socket access.

The Agent establishes an **outbound, authenticated TLS/WebSocket connection** to the Raspberry Pi API over the LAN or a VPN. Production connections use WSS; local M0 Compose may use `ws://` on its private network. Commands carry a unique command ID, deadline, and idempotency key. The Agent reports status and events back to the manager. Execution results are stored durably by the manager.

**Limitation:** The Raspberry Pi cannot use the CPU or memory of a powered-off PC. The dashboard and previously stored information remain available, but the Minecraft servers do not run.

## 4. Deployment Model and Windows Considerations

### 4.1 Raspberry Pi 5

- Docker Compose stack: `craftdock-api`, `craftdock-web`, `craftdock-db`, and optional `craftdock-backup-receiver`.
- ARM64-compatible, multi-architecture images; persistent database volume and securely stored configuration/secrets.
- The administration interface is served over HTTPS, preferably behind a VPN or reverse proxy.

### 4.2 Windows PC

- Windows 10/11 with Docker Desktop using the WSL2 backend in **Linux containers** mode.
- `craftdock-agent` runs as a Linux container in Docker Desktop. Docker management is deferred beyond M0.
- M1 gives only the trusted Agent container a local `/var/run/docker.sock` bind mount (ADR 0003). **Docker socket access effectively grants host-level control**; the Manager and Minecraft containers receive no socket, and the Engine API is never published on a network. The Agent may perform only validated, allowlisted CraftDock server operations. Verify socket permissions and the complete operation allowlist on the Windows Docker Desktop worker before deployment.
- Primary Minecraft data storage uses Docker named volumes within Docker Desktop's Linux VM, or a tested WSL2-backed storage solution. Windows bind mounts are allowed only with explicit consideration of performance and permission trade-offs.
- The dependency between Docker Desktop startup and Windows user login must be documented: **fully unattended startup after boot is not guaranteed**. Worker availability must be detected explicitly.
- Docker restart policies may restart the Agent and servers when the Docker Engine becomes available.

## 5. System Components

| Component | Responsibility | Proposed technology |
|---|---|---|
| Web UI | Dashboard, installation, console, user management | React + TypeScript |
| API / Manager | REST API, authentication, RBAC, orchestration, auditing | Node.js + TypeScript + Fastify |
| Database | Users, servers, operations, events | PostgreSQL |
| Agent | Worker status, Docker operations, log streaming | Node.js + TypeScript |
| Installer | Java, modloader, and modpack downloads and validation | Versioned adapters and containerized jobs |
| Minecraft runtime | Dedicated Java process per server | Java runtime with loader-specific image/entrypoint |
| Tunnel adapter | Public TCP endpoint through a provider | e.g., playit.gg integration |
| Backup receiver | Receive and retain snapshots | Raspberry Pi volume + checksums |

The per-server runtime images may be custom-built. CraftDock **does not depend on** `itzg/docker-minecraft-server`. Separate adapters manage installation and runtime requirements for each supported server type.

## 6. Server Lifecycle and State Machine

Planned states: `DRAFT`, `PROVISIONING`, `STOPPED`, `STARTING`, `RUNNING`, `STOPPING`, `UPDATING`, `BACKING_UP`, `ERROR`, and `UNKNOWN`.

- **Desired state** (`desiredState`) is the target persisted in the database (`RUNNING` or `STOPPED`); **observed state** (`observedState`) is reported by the worker.
- After a manager restart, containers are not blindly recreated. The Agent discovers existing containers using the `craftdock.serverId` Docker label.
- At most one mutating operation may execute for a server at a time; commands are idempotent.
- When the worker becomes unavailable, the server state is `UNKNOWN`; the system must not incorrectly claim that the server stopped.
- World data survives container recreation. Deleting a server removes its managed container and releases its port. Keep the named volume by default; permanently deleting world data requires a separate explicit confirmation and a label-validated Agent operation.

## 7. Minecraft Installation and Compatibility

Users select a Minecraft version, server type, and loader version, or choose a modpack. The manager resolves required dependencies and the appropriate Java runtime, validates package metadata, and instructs the Agent to download and install server-side artifacts in an isolated staging directory.

- **Vanilla:** official server JAR from a verified source.
- **Paper:** compatible Paper build and Minecraft version.
- **Fabric:** Fabric installer/loader and the required Java runtime.
- **Forge / NeoForge:** installer-specific server setup and version-dependent launch commands.
- **Modrinth:** API-powered discovery, `.mrpack` manifest processing, exclusion of client-only mods, and hash verification.
- **CurseForge:** installation subject to API access and licensing restrictions; not every file can necessarily be downloaded automatically. Manual acquisition steps may be required.
- **Custom ZIP:** only a documented server-pack format is supported. Protection against path traversal, malicious symlinks, ZIP bombs, oversized archives, and permission violations is mandatory.

Modpack installation is transactional in principle: **stage → validate → atomically activate or roll back**. Acceptance of the Minecraft EULA is an explicit user action. Minecraft and modpack redistribution terms must be respected.

## 8. Networking and Port Management

- **LAN:** worker IP address plus a published host TCP port; the default Minecraft Java Edition port is `25565/tcp`.
- **Port forwarding / DDNS:** router TCP forwarding targets the worker. DuckDNS provides DNS resolution only; **it does not replace port forwarding**. Direct public connectivity may be unavailable behind CGNAT.
- **Tunnel:** an agent running on, or routing to, the worker provides a public TCP endpoint. Provider uptime, quotas, and endpoint allocation are external dependencies.
- **Port allocation:** the manager reserves a unique host TCP port per server, and the worker checks for conflicts before startup. Docker `EXPOSE` alone does not publish a host port.
- **Windows Firewall:** LAN and forwarded access may require host firewall rules. CraftDock may validate or document these rules but does not promise automatic router configuration.
- **Separation of concerns:** the administration interface and Minecraft TCP tunnel are distinct channels; players never gain access to the admin API merely by joining a server.

## 9. Users and Permissions

CraftDock uses multi-user, per-server role-based access control.

| Role | Permissions |
|---|---|
| Platform Admin | Manage users, worker, global settings, and all servers |
| Server Owner | Full lifecycle control of owned servers and membership management |
| Server Operator | Start/stop, console access, configuration, initiate backups |
| Viewer | Read status, logs, and metrics, with sensitive information redacted |

Passwords are hashed with Argon2id. Authentication uses secure sessions or short-lived access tokens; session-based mutations require CSRF protection. Login rate limiting and audit logging are mandatory. Agent authentication is separate and uses the accepted per-worker shared-token design over TLS/WSS in production (ADR 0001).

The Agent **must not accept arbitrary shell commands** from web users. Minecraft console commands use a separate, audited channel.

## 10. Data Model

- `users(id, email, passwordHash, status, createdAt)`
- `servers(id, name, ownerId, mcVersion, serverType, loaderVersion, javaVersion, desiredState, observedState, workerId, hostPort, memoryMb, cpuLimit, volumeId, createdAt)`
- `server_members(serverId, userId, role)`
- `workers(id, name, platform, lastSeenAt, agentVersion, status, capacitySnapshot)`
- `operations(id, serverId, type, idempotencyKey, status, requestedBy, createdAt, startedAt, finishedAt, errorCode)`
- `modpack_installations(id, serverId, source, projectId, versionId, manifestHash, status)`
- `backups(id, serverId, location, checksum, sizeBytes, createdAt, status)`
- `tunnels(id, serverId, provider, externalAddress, status, secretRef)`
- `audit_events(id, actorId, action, targetType, targetId, timestamp, metadata)`

Required unique indexes: `servers(workerId, hostPort)` for active allocations; `operations(idempotencyKey)`; and `server_members(serverId, userId)`.

## 11. REST API and Agent Protocol

### 11.1 REST API (examples)

```http
POST   /api/v1/auth/login
GET    /api/v1/me
GET    /api/v1/workers
GET    /api/v1/servers
POST   /api/v1/servers
GET    /api/v1/servers/:id
PATCH  /api/v1/servers/:id
POST   /api/v1/servers/:id/start
POST   /api/v1/servers/:id/stop
DELETE /api/v1/servers/:id
POST   /api/v1/servers/:id/commands
POST   /api/v1/servers/:id/backups
GET    /api/v1/servers/:id/operations
GET    /api/v1/servers/:id/logs
GET    /api/v1/servers/:id/members
POST   /api/v1/servers/:id/members
GET    /api/v1/users
POST   /api/v1/users
PATCH  /api/v1/users/:userId
GET    /api/v1/audit-events
GET    /api/v1/modpacks/search
```

Mutating operations return `202 Accepted` with an `operationId`. Clients observe progress through polling or an SSE/WebSocket stream. The API enforces object-level authorization for every server identifier.

### 11.2 Agent Messages

```json
{"type":"agent.hello","workerId":"worker-01","agentVersion":"1.0"}
{"type":"command.execute","commandId":"uuid","operationId":"uuid","action":"server.start","serverId":"uuid"}
{"type":"command.ack","commandId":"uuid"}
{"type":"command.result","commandId":"uuid","status":"SUCCEEDED"}
{"type":"worker.heartbeat","workerId":"worker-01","runningServers":2}
```

Commands use versioned schemas. After reconnecting, the manager and Agent reconcile operations and observed Docker state using container labels. Heartbeats do not replace actual container inspection.

The version 2 Agent protocol adds the fixed `server.delete` action. M2 adds `server.console` in protocol version 3. Console commands are single-line Minecraft input, limited to 512 characters, and are authorized by server role and recorded in the audit log. The Agent writes the command only to the stdin of the validated CraftDock Java server process; it never invokes a shell or accepts arbitrary Docker options. Existing M1 server containers are recreated on a later start to enable stdin while retaining their named world volume. A console operation with an uncertain result after a Manager or Agent disconnect is marked `COMMAND_RESULT_UNKNOWN` and is not replayed, because Minecraft console commands may not be idempotent.

## 12. Backup and Restore

Before a backup, the system attempts to make the world consistent through Minecraft RCON commands: `save-off` and `save-all flush`, where supported. It then creates a snapshot and issues `save-on`. If a step fails, it still attempts to re-enable automatic saving. Archives contain checksums, a manifest, the server version, and the modpack identifier.

The worker creates a local backup and can optionally **transfer it to the Raspberry Pi over an encrypted connection**. Raspberry Pi disk usage and network transfer are subject to quotas. Before restoration, the current state is backed up, the server is stopped, and data is replaced atomically. Backup and restore operations require authorization.

## 13. Security and Operations Requirements

- Never expose the Docker socket over TCP. The Agent uses narrowly defined, allowlisted operations and the least privileges practical for its design.
- Compromise of an Agent with Docker socket access may compromise the entire worker Docker host; this is a primary threat-model concern.
- Minecraft containers are unprivileged, resource-limited, subject to PID limits, and run as non-root where feasible. Volumes are isolated per server.
- Downloads use TLS and hash validation. ZIP extraction must be safe. Configuration and secrets are kept separate.
- Audit access management, installation, console, and backup operations.
- Health checks cover the Pi API, database, Agent connection, Docker Engine, Minecraft containers, and tunnel status.
- Redact passwords and tokens from logs; enforce retention periods and storage quotas.
- Use versioned database migrations, pinned container image versions, and a documented security update strategy.

## 14. Nonfunctional Requirements and SLO Targets

- The admin UI loads even when the PC is offline; server status is shown as `UNKNOWN` or `WORKER_OFFLINE`.
- Target worker-disconnection detection time: 30–60 seconds, configurable and not a hard availability guarantee.
- Server startup is asynchronous, time-bounded, and cancellable; large modpacks may take several minutes to install.
- Long-running Docker and download operations must not block API requests.
- No individual server may reserve all worker RAM; administrators can configure a global resource budget.
- The system must be tested on Raspberry Pi 5 ARM64 and Windows x86-64 with Docker Desktop.

## 15. Failure Handling and Recovery

| Event | Expected behavior |
|---|---|
| PC powers off | UI stays available; worker marked offline; no false `STOPPED` state |
| Docker Desktop is not running | Agent unavailable; UI shows diagnostics and manual startup guidance |
| Agent restarts | Rediscover containers by Docker labels; do not create duplicates |
| Raspberry Pi restarts | Restore persisted operations; Agent reconnects |
| Installation is interrupted | Clean up or resume staging; preserve the working world |
| Host port is occupied | Report conflict and select another port; no silent overwrites |
| Tunnel disconnects | Minecraft server keeps running locally; external access marked unavailable |
| Backup fails | Original world remains intact; attempt to restore `save-on` |

## 16. Development Milestones

### M0 — Infrastructure Proof of Concept

Run the API on the Pi and a containerized Agent on the Windows PC. Establish authenticated outbound TLS/WebSocket communication and heartbeats. Verify worker status, offline detection, and automatic reconnection after Agent and Manager restarts. M0 does not mount or access the Docker socket and does not launch containers; defer the `hello-world` check and Docker control to a later milestone with a separate threat model and explicit operation allowlist (ADR 0002).

### M1 — Core MVP

Create, start, stop, and delete Vanilla servers; persist worlds; allocate ports; stream logs; provide the first Platform Admin account and a basic dashboard. Deletion removes only the validated managed container and preserves its named world volume by default. Permanently deleting world data requires a distinct confirmation. Reconcile state after Pi and PC restarts.

### M2 — Multi-user Support

Implement user login and password changes, Platform Admin user management, server membership, per-server Owner/Operator/Viewer permissions, and audit history in the UI. Add a Minecraft console input and live-log feedback for Platform Admins, Owners, and Operators. Console commands must use a dedicated versioned Agent operation, never an OS shell; viewers remain read-only.

### M3 — Runtime and Modpack Catalog

Add Paper, Fabric, Forge, and NeoForge; resolve Java versions; support Modrinth and custom ZIP packages; then add CurseForge to the extent permitted by actual API and licensing terms.

### M4 — Public Networking and Backups

Add LAN diagnostics, port forwarding/DDNS guidance, a tunnel adapter, Raspberry Pi backup receiver, restore workflows, and retention policies.

### M5 — v1.0 Stabilization

Complete deployment documentation, security review, integration/E2E testing, load testing, upgrades/migrations, and recovery scenarios.

## 17. Test Strategy and Acceptance Criteria

- **Unit:** state machine, RBAC matrix, port allocator, version resolver, command idempotency.
- **Integration:** PostgreSQL migrations, Agent–Manager protocol, mocked Docker Engine and real test containers.
- **End-to-end:** create servers in the UI; start/stop/delete; verify world retention and explicitly confirmed world deletion; submit Minecraft console commands; check user permissions and audit events.
- **Fault injection:** kill Agent, restart Pi, make Docker Engine unavailable, interrupt downloads, occupy ports, fill disk.
- **Security:** IDOR/RBAC, ZIP path traversal, oversized archives, token rotation, audit integrity.

**Minimum M1/M2 acceptance criteria:** (1) Manager and UI run on the Pi; (2) containerized Agent runs on Windows Docker Desktop; (3) authenticated remote container startup; (4) at least two Vanilla servers on separate ports; (5) worlds survive restarts and deletion retains data unless explicitly asked to remove it; (6) PC-offline status is accurate; (7) Agent reconnect does not duplicate containers or replay uncertain console commands; (8) Docker API is not exposed publicly; (9) a non-admin user can only see and operate servers permitted by membership; (10) audit events identify the actor and action without recording passwords or console arguments.

**Minimum v1.0 acceptance criteria:** all five server types work with at least one documented compatible version; Modrinth and custom ZIP installation work; CurseForge integration supports legally permitted download workflows; multi-user RBAC works; LAN and at least one tunnel provider work; backup and restore work; automated recovery tests pass.

## 18. Open Implementation Decisions

1. Exact Windows Docker Desktop version, licensing context, and measured startup behavior.
2. Agent access to the Docker socket and its detailed threat model.
3. Validate production TLS/WSS termination and the operational shared-token rotation procedure (ADR 0001).
4. Maintenance strategy for Minecraft runtime images and the Java compatibility matrix.
5. CurseForge API key, terms of use, and UX for files that cannot be downloaded automatically.
6. Choice of tunnel provider and its service limits.
7. Raspberry Pi backup storage capacity and retention settings.
8. Public admin access model: VPN, reverse proxy, and HTTPS; the admin API must not be internet-exposed by default.

## 19. Risks and Decision Record

- **High:** Docker socket compromise; Docker Desktop's user-session-dependent startup behavior; modpack dependencies and licensing.
- **Medium:** ARM64 control-plane image compatibility; transfer of large backups to the Pi; tunnel-provider dependency; Windows volume I/O.
- **Low to medium:** host-port collisions; Java runtime version mismatches when handled through adapters.

**Final architecture decision:** one Raspberry Pi Control Plane and one Windows Docker Desktop Worker, connected by an outbound-initiated containerized Agent; Minecraft servers run in separate isolated containers; desired state is declarative and reconciled against observed state; external tunneling and Raspberry Pi backups are optional.

**Accepted M0 decisions:** Agent authentication uses a per-worker shared token over WSS in production (ADR 0001); Docker access and container launch are deferred beyond M0 (ADR 0002).
