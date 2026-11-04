---
name: verify-change
description: Validate a CraftDock implementation, bug fix, or PR by running relevant checks and documenting observed evidence. Use when asked to test, verify, or prepare a change for review.
---

1. Inspect package scripts and CI workflow; never assume a command exists.
2. Select the smallest relevant checks, then broader lint/typecheck/unit/integration/build checks as appropriate.
3. For protocol changes, test invalid authentication, reconnect, duplicate messages, and timeout behavior.
4. For Docker changes, validate Compose and check ARM64/AMD64 build compatibility where possible.
5. For world/backup changes, verify persistence and restore without destructive test data.
6. Capture exact commands, exit codes, and significant output. Do not claim success when checks were skipped or unavailable.
7. Return a concise verification matrix: check, result, evidence, and remaining manual tests.
