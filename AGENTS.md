# CraftDock — Agent Instructions

## Mission
Build CraftDock incrementally: a self-hosted, multi-user Minecraft Java Edition hosting platform. The Raspberry Pi 5 (ARM64) runs the always-on control plane; one Windows PC (AMD64) running Docker Desktop hosts Minecraft containers. All CraftDock services, including the worker agent, run in containers.

## Source of truth
1. `docs/SPECIFICATION.md` — approved product requirements and architecture.
2. `docs/ARCHITECTURE_DECISIONS.md` — accepted technical decisions (ADRs).
3. `docs/CODING_CONVENTIONS.md` — implementation conventions.
4. Existing code, tests, and configuration — verify before assuming.
If documents disagree, flag the conflict and request a decision before changing approved product behavior.

## Working agreement
- Inspect relevant files and identify the current milestone before editing.
- Propose a short plan for changes crossing package boundaries or introducing dependencies.
- Implement only the requested milestone; avoid speculative features and large refactors.
- Preserve unrelated user changes; never discard or overwrite work without permission.
- Do not commit, push, merge, change GitHub settings, or deploy without explicit approval.
- Use feature branches and pull requests; never push directly to `main`.
- After edits, run relevant checks. Report exact commands and results; never claim unrun tests passed.
- Update tests and documentation alongside behavior changes.
- Keep all repository documentation, code comments, API contracts, and PR text in English.

## Non-negotiable constraints
- Agent initiates outbound authenticated communication with Manager; no inbound Docker Engine API exposure.
- Never expose a Docker socket over an unauthenticated network. Docker socket access is effectively host-level privilege; assess and minimize it before enabling in M1.
- M0 must not mount the Docker socket or implement remote arbitrary command execution.
- Manager remains usable while worker is offline. Distinguish desired from observed state.
- Validate every trust boundary, including protocol messages, file paths, archives, API inputs, and third-party metadata.
- Do not log secrets, access tokens, or unredacted credentials.
- Treat modpacks and uploaded ZIPs as untrusted content; protect against path traversal, decompression bombs, and resource exhaustion.
- Keep world data on worker volumes; backup to Pi is optional and must be restorable.
- Avoid Kubernetes, message brokers, and multiple-worker scheduling in initial scope.

## Repository navigation
- `apps/manager`: Fastify API, control-plane logic, authentication, RBAC.
- `apps/agent`: worker connectivity and Docker integration (after M0).
- `apps/web`: React dashboard (later milestone).
- `packages/protocol`: wire schemas, versions, and message contracts.
- `packages/shared`: shared domain types and utilities (no application dependencies).
- `docs/`: requirements, conventions, ADRs, operations.
- `.agents/skills/`: opt-in, task-specific workflows.

## Verification
Use scripts defined in `package.json` when present. Typical checks: `yarn lint`, `yarn typecheck`, `yarn test`, `yarn build`. Do not invent scripts if they are absent. For Docker changes, validate Compose configuration and test the affected deployment when the runtime is available.

## Completion report
Summarize changed files, architectural choices, security implications, tests actually run, and remaining work. Highlight anything blocked by missing hardware, Docker Desktop, credentials, or network access.
