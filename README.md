# CraftDock

Self-hosted Minecraft Java Edition server management for one Windows Docker Desktop worker, controlled by a Raspberry Pi Manager. See the [Technical Specification](docs/CraftDock_SPECIFICATION_EN.md), [Architecture Decisions](docs/ARCHITECTURE_DECISIONS.md), and [Docker access ADR](docs/adr/0003-agent-docker-access.md).

## M1 — Core MVP

M1 provides a first administrator account and a web dashboard for creating, starting, stopping, monitoring, and deleting Vanilla Minecraft servers. Server and operation state is stored in PostgreSQL. The Agent runs on the Windows worker and manages containers through its local Docker socket. The Manager and Minecraft containers receive no Docker socket.

World data is kept in one named Docker volume per server. Deleting a server removes its managed container and frees its port. The world volume is retained unless the user explicitly confirms permanent deletion. If a Docker port collision occurs, CraftDock may recreate only its own managed container and preserve that world volume.

## Prerequisites

- Node.js 22.13 or later and Yarn 1.22.22 for local builds.
- Docker Desktop with Linux containers.
- Docker Compose v2.
- For remote deployments, a TLS reverse proxy that supports WebSocket upgrades and exposes the Manager over `wss://`.

## Run the local M1 stack

From the repository root, create a private environment file and set fresh values for `WORKER_TOKEN`, `POSTGRES_PASSWORD`, and `ADMIN_PASSWORD`. Do not commit `.env`.

```bash
cp .env.example .env
openssl rand -hex 32  # set WORKER_TOKEN in .env
openssl rand -hex 32  # set POSTGRES_PASSWORD in .env
openssl rand -hex 32  # set ADMIN_PASSWORD in .env
```

Start PostgreSQL, the Manager, and the Agent:

```bash
MSYS_NO_PATHCONV=1 docker compose --env-file .env -f docker/compose.local.yml up --build -d
MSYS_NO_PATHCONV=1 docker compose --env-file .env -f docker/compose.local.yml ps
```

Open `http://localhost:4000` and sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD`. The values bootstrap the first administrator only; Manager restarts do not reset its password.

For the Windows worker deployment, copy `apps/agent/.env.example` to `apps/agent/.env`, set the Manager WebSocket URL, worker ID, and shared token, then run:

```bash
MSYS_NO_PATHCONV=1 docker compose --env-file apps/agent/.env -f docker/compose.agent.windows.yml up --build -d
```

Only the trusted Agent container receives `/var/run/docker.sock`; the Engine API is not published over TCP. Docker socket access is effectively host-level privilege. Keep the Agent trusted and updated. Docker Desktop startup depends on Windows user-session behavior and is not guaranteed before login.

## Checks

```bash
yarn lint
yarn typecheck
yarn build
yarn format:check
MSYS_NO_PATHCONV=1 docker compose --env-file .env -f docker/compose.local.yml config
MSYS_NO_PATHCONV=1 docker compose --env-file .env -f docker/compose.pi.yml config
```

## Current limitations

- M1 supports Vanilla Minecraft Java servers only.
- A retained world volume after deletion remains on the worker for manual recovery; the UI has no undelete flow.
- Lifecycle operations require the worker to be online. Desired and observed state are stored separately.
- Exactly one Windows worker is supported.
- Production WSS termination and worker-token rotation require deployment configuration.

M2 is planned to add user management, per-server roles, audit history, and Minecraft console commands.