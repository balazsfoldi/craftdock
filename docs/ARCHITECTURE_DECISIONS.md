# Architecture Decision Log

Record consequential choices as ADRs in `docs/adr/NNNN-short-title.md`.

## Accepted product constraints
- Single Windows Docker Desktop worker, with an ARM64 Raspberry Pi 5 control plane.
- All CraftDock services are containerized.
- Worker powers on manually; no Wake-on-LAN in initial release.
- Multi-user RBAC; Java Edition Vanilla/Paper/Fabric/Forge/NeoForge.
- Modrinth, CurseForge, custom ZIP; LAN, DDNS/port forwarding, tunnel.
- Worker-local worlds; optional backup to Pi.

## Accepted architecture decisions
- Manager–Agent communication is outbound WebSocket; production Agent connections use TLS/WSS. Local M0 Compose may use `ws://` on its private network.
- M0 Agent authentication uses a high-entropy, per-worker shared token from protected environment configuration. Rotation updates both services and restarts them. See [ADR 0001](adr/0001-agent-authentication.md).
- M0 proves connectivity, heartbeat, offline detection, status reporting, and reconnection. It does not access Docker or launch containers; defer that work until a separately reviewed milestone. See [ADR 0002](adr/0002-m0-docker-scope.md).

## Decisions requiring validation
- Docker Desktop's supported, secure socket access from the Linux-containerized agent.
- Production reverse-proxy TLS/WSS termination and the operational token-rotation procedure.
- Storage engine and durable worker identity for control-plane restarts.
- Modpack acquisition and third-party API licensing/redistribution constraints.
- Tunnel provider, account requirements, port assignment, and restart behavior.

Do not describe these as implemented or fully settled until an ADR and working verification exist.
