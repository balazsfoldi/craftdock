# CraftDock Coding Conventions

## Language and structure
- TypeScript with `strict: true`; avoid `any` and non-null assertions unless justified.
- Use ESM consistently with the repository's selected Node.js/Yarn versions.
- Prefer named exports; avoid default exports except where required by tooling.
- Use descriptive names, small functions, and explicit boundaries between domain, transport, and infrastructure.
- Prefer composition and dependency injection at external boundaries; do not build generic frameworks prematurely.
- Keep imports acyclic. `packages/protocol` and `packages/shared` must not import application code.
- Follow the installed ESLint and Prettier configuration; do not manually impose conflicting styles.

## Naming
- Files: `kebab-case.ts` (`worker-registry.ts`); React components: `PascalCase.tsx`.
- Variables/functions: `camelCase`; types/interfaces/classes: `PascalCase`.
- Environment variables: `UPPER_SNAKE_CASE`; constants: `UPPER_SNAKE_CASE` for fixed configuration values.
- Prefer domain vocabulary: `worker`, `serverInstance`, `desiredState`, `observedState`, `heartbeat`, `operationId`.

## API and protocol
- Version public routes under `/api/v1` and wire messages with an explicit protocol version.
- Validate inputs at runtime using Zod; derive TypeScript types from schemas where practical.
- Use stable machine-readable error codes and appropriate HTTP statuses; never return raw internal errors to clients.
- Every command crossing Manager–Agent boundary has a unique ID, correlation context, and documented timeout/retry semantics.
- Assume messages may be duplicated or delayed; make side-effecting operations idempotent or document why they cannot be.
- Use UTC ISO-8601 timestamps on the wire and monotonic time for local duration measurements when feasible.
- Define explicit heartbeat timeouts and reconnect backoff with jitter; no busy loops.
- Keep authentication, authorization, and audit logging distinct.

## Persistence and lifecycle
- Store desired state separately from last observed state; mark observations stale when worker disconnects.
- Model state transitions explicitly. Reject illegal transitions rather than silently coercing them.
- Never assume Docker container existence equals Minecraft server readiness.
- Ensure startup reconciliation and graceful shutdown paths are testable.
- Never delete world data during container recreation, version changes, or failed installs.

## Errors and observability
- Use structured Pino logs with `requestId`, `operationId`, `workerId`, and `serverId` where available.
- Do not log tokens, cookies, private keys, password hashes, or full environment dumps.
- Handle expected failures with typed domain errors; unexpected failures are logged and surfaced as safe generic errors.
- Metrics should avoid high-cardinality user-controlled labels.

## Security
- Use least privilege and explicit allowlists for supported container operations.
- Treat Docker socket access as highly privileged; do not casually mount it into web/API services.
- Validate archive entry paths and sizes before extraction. Do not follow untrusted symlinks.
- Use prepared/parameterized database access; avoid shell interpolation of user input.
- Never store secrets in source control. Provide `.env.example` with placeholders only.
- Avoid running game servers as root when compatible with their runtime.

## Tests
- Jest for unit/integration tests; deterministic clocks and injected transports instead of arbitrary sleeps.
- Unit-test state transitions, validation, retry policy, auth decisions, and failure paths.
- Integration-test API contracts, protocol handshake, disconnect/reconnect, and persistence boundaries.
- Add regression tests for each fixed bug.
- Do not mock the domain logic being tested; mock only external boundaries.

## Git and documentation
- Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`).
- PRs must describe motivation, scope, risks, tests run, and deployment impact.
- Document externally observable changes; write ADRs for consequential design choices.
