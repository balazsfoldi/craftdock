---
name: review-change
description: Review CraftDock changes or pull requests for correctness, security, regressions, and test gaps. Use when asked to review, audit, or assess a diff; do not modify code unless asked.
---

1. Read relevant specification, conventions, and the changed diff.
2. Prioritize findings: critical security/data loss, correctness, operational resilience, then maintainability.
3. Specifically inspect auth/RBAC, Manager–Agent trust, Docker privilege, world persistence, retries/idempotency, archive extraction, and secret handling where relevant.
4. Verify claims against concrete code paths and tests; do not report speculative bugs as facts.
5. Report findings first, each with severity, file/line reference, failure scenario, and actionable fix.
6. Note missing test coverage and residual risks. If no issues found, state that clearly without claiming proof of correctness.
7. Do not merge or push.
