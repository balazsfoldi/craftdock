# CraftDock

Self-hosted Minecraft server management platform powered by Docker, with remote workers, modpack support, and a modern web dashboard.

For detailed architecture, technical requirements, and the development roadmap, see the [Technical Specification](docs/CraftDock_SPECIFICATION_EN.md).

## M0 architecture

M0 proves authenticated outbound connectivity between a Fastify Manager and a containerized Agent. The Agent opens a versioned WebSocket connection to the Manager, authenticates with its configured worker credential, and sends periodic heartbeats. The Manager exposes worker status at `GET /api/v1/workers` and `GET /api/v1/workers/{workerId}`. A configured worker appears as `OFFLINE` until it connects; status and heartbeat timestamps are in memory and reset when the Manager restarts.

The Manager supports one preconfigured worker in M0. It does not access Docker, launch containers, or execute remote commands. The accepted scope defers the specification's `hello-world` container check and all Docker control beyond M0; a later milestone needs a separate Docker-access threat model and an explicit operation allowlist. See [ADR 0002](docs/adr/0002-m0-docker-scope.md).

## Prerequisites

- Node.js 22.13 or later and Yarn 1.22.22 for local builds and tests.
- Docker Desktop with Linux containers for local Compose or the Windows Agent.
- Docker Compose v2.
- For remote deployments, a TLS reverse proxy that supports WebSocket upgrades and exposes the Manager over `wss://`. Keep the Manager's plain HTTP port on a trusted local interface.

## Local development

Copy `.env.example` to `.env`, then replace `WORKER_TOKEN` with a randomly generated value of at least 32 characters. The same worker ID and token configure both services.

```powershell
Copy-Item .env.example .env
docker compose up --build
```

The Manager listens on `http://localhost:4000` and the Agent connects over the private Compose network. Check worker status:

```powershell
Invoke-RestMethod http://localhost:4000/api/v1/workers
```

To see offline detection and recovery, stop and start the Agent:

```powershell
docker compose stop agent
# After the configured timeout (45 seconds by default), check that status is OFFLINE.
Invoke-RestMethod http://localhost:4000/api/v1/workers
docker compose start agent
```

Restarting only the Manager also exercises Agent recovery. The Manager reports the worker offline during its restart; the Agent reconnects with exponential backoff and restores `ONLINE` without a manual Agent restart.

For local development without containers, install dependencies with `yarn install`, then run `yarn dev` from `apps/manager` and `apps/agent` in separate terminals. Configure the Agent URL as `ws://localhost:4000/api/v1/agent` and use `NODE_ENV=development`.

## Environment variables

| Variable                       | Used by           | Purpose                                                                 |
| ------------------------------ | ----------------- | ----------------------------------------------------------------------- |
| `WORKER_ID`                    | Manager and Agent | Stable configured worker identity                                       |
| `WORKER_TOKEN`                 | Manager and Agent | Shared secret, at least 32 characters                                   |
| `MANAGER_PORT`                 | Compose           | Host port for local Manager access                                      |
| `MANAGER_HOST`, `MANAGER_PORT` | Manager           | Listen address and port                                                 |
| `MANAGER_WS_URL`               | Agent             | WebSocket endpoint ending in `/api/v1/agent`                            |
| `HEARTBEAT_INTERVAL_MS`        | Manager           | Interval requested by the Manager; defaults to 10 seconds               |
| `WORKER_TIMEOUT_MS`            | Manager           | Time without a heartbeat before marking offline; defaults to 45 seconds |
| `HEARTBEAT_SWEEP_INTERVAL_MS`  | Manager           | Offline detection polling interval; defaults to 5 seconds               |
| `RECONNECT_BASE_DELAY_MS`      | Agent             | First retry delay; defaults to 1 second                                 |
| `RECONNECT_MAX_DELAY_MS`       | Agent             | Retry delay cap; defaults to 30 seconds                                 |

See `apps/manager/.env.example` and `apps/agent/.env.example` for standalone service examples. Remote production Agents require `MANAGER_WS_URL` to use `wss://`; provide the credential through a secret store or a protected, untracked environment file. Rotate the shared token by updating the Manager and Agent configuration together and restarting both services. Never paste it into logs, source control, or a URL.

## Deployment examples

- Raspberry Pi Manager: prepare the root `.env` file and run `docker compose -f docker/compose.pi.yml up --build -d`. The Manager binds to loopback so a host TLS reverse proxy can forward HTTPS and WebSocket traffic to it.
- Windows Docker Desktop Agent: copy `apps/agent/.env.example` to `apps/agent/.env`, set the Manager's public `wss://` URL and matching worker credential, then run `docker compose -f docker/compose.agent.windows.yml up --build -d`.
- The Pi example targets `linux/arm64`; the Windows Agent example targets `linux/amd64`. Neither service mounts the Docker socket.

## Checks

```powershell
yarn lint
yarn typecheck
yarn test
yarn build
docker compose config
```

## Known limitations

- Worker registration and status are in memory; the Agent reauthenticates after a Manager restart.
- M0 supports one preconfigured Agent and does not provide user authentication or RBAC.
- Capabilities describe the Agent container runtime (for example, Linux under Docker Desktop), not detailed Windows host inventory.
- Docker control, Minecraft lifecycle management, database persistence, and the web dashboard are later work.
- The status endpoint has no authentication in M0 and should only be exposed on a trusted network or behind an appropriately configured reverse proxy.
