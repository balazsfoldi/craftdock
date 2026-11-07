# CraftDock

Self-hosted Minecraft Java Edition server management for a Raspberry Pi control plane and one Windows Docker Desktop worker. See the [Technical Specification](docs/CraftDock_SPECIFICATION_EN.md), [Architecture Decisions](docs/ARCHITECTURE_DECISIONS.md), and [accepted Docker access ADR](docs/adr/0003-agent-docker-access.md).

## M1 and M2 scope

M1 provides one administrator account and a basic dashboard for Vanilla servers. It stores desired state, observed state, and operations in PostgreSQL; the Agent creates and manages Minecraft containers on the Windows worker. Worlds remain in one Docker named volume per server. Manager availability and saved configuration do not depend on the worker being online.

The Agent supports fixed create, start, stop, delete, console-input, inspect, and log-stream operations. It downloads official Mojang server artifacts over HTTPS and verifies the published SHA-1 before installation. Server ports are allocated from `25565` through `60000`. If Docker reports a host-port collision, the Manager retries with a new free CraftDock port up to five times; the Agent may remove only the validated CraftDock container for that server, retaining its named world volume during recreation.

M1 supports Vanilla only. Server deletion removes the CraftDock container and releases its port. World data is kept by default; a separate confirmation can permanently delete the server's named volume. M2 adds user accounts, per-server Owner/Operator/Viewer roles, membership management, audit history, and the Minecraft console. Console input is sent as one validated line to the managed Java process; it never opens an OS shell or a generic Docker command endpoint. The live log stream redacts IP addresses. See [ADR 0002](docs/adr/0002-m0-docker-scope.md) for the M0 boundary and [ADR 0004](docs/adr/0004-minecraft-console-channel.md) for console transport and delivery behavior.

## Prerequisites

- Node.js 22.13 or later and Yarn 1.22.22 for local builds and tests.
- Docker Desktop with Linux containers for local Compose or the Windows Agent.
- Docker Compose v2.
- For remote deployments, a TLS reverse proxy that supports WebSocket upgrades and exposes the Manager over `wss://`. Keep the Manager's plain HTTP port on a trusted local interface.

## Run the local M1/M2 stack

From the repository root, create a private environment file. Set fresh values for `WORKER_TOKEN`, `POSTGRES_PASSWORD`, and `ADMIN_PASSWORD`; `openssl rand -hex 32` is a convenient generator. Do not commit `.env`.

```bash
cp .env.example .env
openssl rand -hex 32  # set WORKER_TOKEN in .env
openssl rand -hex 32  # set POSTGRES_PASSWORD in .env
openssl rand -hex 32  # set ADMIN_PASSWORD in .env
```

Keep the example values for `WORKER_ID`, `ADMIN_EMAIL`, `PUBLIC_ORIGIN`, and `MANAGER_PORT` for a local run. Start the Manager, PostgreSQL, and Agent:

```bash
MSYS_NO_PATHCONV=1 docker compose --env-file .env -f docker/compose.local.yml up --build -d
MSYS_NO_PATHCONV=1 docker compose --env-file .env -f docker/compose.local.yml ps
```

Open `http://localhost:4000` and sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD`. These values bootstrap the first active Platform Admin only; later restarts do not reset that account's password. Use User management to create accounts. The first server creator becomes its Owner; Owners can add existing accounts as Owners, Operators, or Viewers. Operators can start/stop servers and send Minecraft console commands such as `gamemode creative PlayerName`. A command's server response appears in the live logs.

If a server was created by an earlier M1 Agent, stop it and start it once after updating: the Agent recreates the container with stdin enabled while preserving the named world volume. Admin sessions are held in Manager memory for eight hours and are invalidated when Manager restarts. Keep `.env` private.

To check offline handling, stop the Agent and wait longer than `WORKER_TIMEOUT_MS` (45 seconds by default). Saved servers remain visible and observed state becomes unknown while the worker is offline. Start the Agent again to reconnect and reconcile Docker state:

```bash
MSYS_NO_PATHCONV=1 docker compose --env-file .env -f docker/compose.local.yml stop agent
# Wait at least 45 seconds, then refresh the dashboard.
MSYS_NO_PATHCONV=1 docker compose --env-file .env -f docker/compose.local.yml start agent
```

Stop the stack while retaining database data and worlds with `MSYS_NO_PATHCONV=1 docker compose --env-file .env -f docker/compose.local.yml down`. Avoid `down -v` if you want to preserve named volumes.

## Environment variables

| Variable                                            | Used by           | Purpose                                                                 |
| --------------------------------------------------- | ----------------- | ----------------------------------------------------------------------- |
| `WORKER_ID`                                         | Manager and Agent | Stable configured worker identity                                       |
| `WORKER_TOKEN`                                      | Manager and Agent | Shared secret, at least 32 characters                                   |
| `MANAGER_PORT`                                      | Compose           | Host port for local Manager access                                      |
| `MANAGER_HOST`, `MANAGER_PORT`                      | Manager           | Listen address and port                                                 |
| `MANAGER_WS_URL`                                    | Agent             | WebSocket endpoint ending in `/api/v1/agent`                            |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | Compose           | PostgreSQL database and credentials                                     |
| `DATABASE_URL`                                      | Manager           | PostgreSQL connection string                                            |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`                     | Manager           | Bootstrap the first active Platform Admin when the database is empty   |
| `PUBLIC_ORIGIN`                                     | Manager           | Dashboard origin; HTTPS is required in production                       |
| `DOCKER_SOCKET_PATH`                                | Agent             | Local Unix socket path; defaults to `/var/run/docker.sock`              |
| `HEARTBEAT_INTERVAL_MS`                             | Manager           | Interval requested by the Manager; defaults to 10 seconds               |
| `WORKER_TIMEOUT_MS`                                 | Manager           | Time without a heartbeat before marking offline; defaults to 45 seconds |
| `HEARTBEAT_SWEEP_INTERVAL_MS`                       | Manager           | Offline detection polling interval; defaults to 5 seconds               |
| `RECONNECT_BASE_DELAY_MS`                           | Agent             | First retry delay; defaults to 1 second                                 |
| `RECONNECT_MAX_DELAY_MS`                            | Agent             | Retry delay cap; defaults to 30 seconds                                 |

See `apps/manager/.env.example` and `apps/agent/.env.example` for standalone service examples. Remote production Agents require `MANAGER_WS_URL` to use `wss://`; provide the credential through a secret store or a protected, untracked environment file. Rotate the shared token by updating the Manager and Agent configuration together and restarting both services. Never paste it into logs, source control, or a URL.

## Deploy the control plane and worker separately

### Raspberry Pi control plane

Set the root `.env` values, including `PUBLIC_ORIGIN=https://your-domain.example`, then configure a TLS reverse proxy to forward HTTP and WebSocket traffic to the Manager's loopback listener. Expose HTTPS/WSS only; do not publish a Docker Engine API endpoint.

```bash
docker compose --env-file .env -f docker/compose.pi.yml up --build -d
docker compose --env-file .env -f docker/compose.pi.yml ps
```

### Windows Docker Desktop worker

Copy `apps/agent/.env.example` to `apps/agent/.env`; set `MANAGER_WS_URL=wss://your-domain.example/api/v1/agent`, the same `WORKER_ID`, and the same high-entropy `WORKER_TOKEN` as the Manager. From the repository root:

```bash
MSYS_NO_PATHCONV=1 docker compose --env-file apps/agent/.env -f docker/compose.agent.windows.yml up --build -d
MSYS_NO_PATHCONV=1 docker compose --env-file apps/agent/.env -f docker/compose.agent.windows.yml logs -f agent
```

Only the Agent container receives the local `/var/run/docker.sock` mount. The Manager and Minecraft containers do not receive it, and the Docker Engine API is not published over TCP. Docker socket access is effectively host-level privilege; keep the Agent trusted and updated. The Agent uses a fixed operation allowlist, rejects arbitrary Docker configuration and shell commands, and permits only the separately authorized Minecraft console line. Docker Desktop must be running and its local socket available; automatic startup before Windows user login is not guaranteed. Upgrade the Manager and Agent together because M2 uses protocol version 3. See [ADR 0003](docs/adr/0003-agent-docker-access.md) and [ADR 0004](docs/adr/0004-minecraft-console-channel.md).

## Checks

```bash
yarn lint
yarn typecheck
yarn test
yarn build
yarn format:check
MSYS_NO_PATHCONV=1 docker compose --env-file .env -f docker/compose.local.yml config
MSYS_NO_PATHCONV=1 docker compose --env-file .env -f docker/compose.pi.yml config
MSYS_NO_PATHCONV=1 docker compose --env-file apps/agent/.env -f docker/compose.agent.windows.yml config
```

## Known limitations

- Exactly one worker is supported. Platform Admins can create additional user accounts.
- Only Vanilla Minecraft Java servers are supported in M1.
- Console operations are not replayed after an uncertain Agent disconnect, to avoid repeating non-idempotent commands.
- Deleting a server while keeping its world leaves the labeled Docker volume on the worker for manual recovery; the UI does not yet provide an undelete or world reattachment flow.
- Docker socket access grants substantial control of the worker host; the Agent is the only CraftDock component that receives it.
- The worker must be online to perform lifecycle operations. Desired state and last observed state are stored separately.
- Admin sessions are in memory and are cleared on Manager restart.
- Capabilities describe the Agent container runtime (for example, Linux under Docker Desktop), not detailed Windows host inventory.
- Docker Desktop startup depends on Windows and user-session behavior; confirm it is available before relying on the worker.
- The protocol is version 3; update the Manager and Agent together.
- Runtime validation is still required on the target Windows Docker Desktop worker for console input, one-time recreation of existing M1 containers, safe server deletion, multi-user permissions, and the M1 lifecycle flows.
