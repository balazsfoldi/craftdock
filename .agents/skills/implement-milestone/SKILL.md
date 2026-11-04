---
name: implement-milestone
description: Implement a specifically requested CraftDock roadmap milestone or bounded feature, with planning, tests, and scope control. Use for M0/M1 tasks or feature implementation; not for reviews alone.
---

1. Read `AGENTS.md`, `docs/SPECIFICATION.md`, and `docs/CODING_CONVENTIONS.md`; inspect existing implementation.
2. Identify the milestone, dependencies, and acceptance criteria. If unclear, request the missing decision.
3. Write a short plan naming files, interfaces, security risks, and tests. For large changes, seek approval before implementation.
4. Implement the smallest vertical slice that proves behavior end to end. Avoid unrelated changes.
5. Add unit/integration tests for success, failure, retries, and authorization as relevant.
6. Run available lint/typecheck/test/build commands. Report failures and environment limitations truthfully.
7. Update README/spec/ADR only when behavior or decisions change.
8. Finish with changed paths, acceptance criteria met/unmet, commands run, and next milestone recommendation.

For M0 specifically: implement authenticated outbound Agent connection, worker registration, heartbeat, offline detection, reconnection, and status API. Do not mount Docker socket or launch Minecraft containers.
