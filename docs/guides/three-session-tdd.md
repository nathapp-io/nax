---
title: Three-Session TDD
description: Strict role separation for complex stories
---

## Three-Session TDD

For complex or security-critical stories, nax enforces strict role separation:

| Session | Role | Allowed Files |
|:--------|:-----|:--------------|
| 1 | Test Writer | Test files only — no source code (except paths in `tdd.testWriterAllowedPaths`, default `src/index.ts`, `src/**/index.ts`) |
| 2 | Implementer | Source files only — no test changes |
| 3 | Verifier | Read-only TDD-integrity review; writes a verdict file and approves or rejects |

Between the implementer and verifier, the story orchestrator runs the test-presence and full-suite gates (and the mutation check, when enabled).

Isolation is checked via `git diff` after each session (`src/tdd/isolation.ts`), but the mechanical check is **advisory**: a violation is logged, never fails the session on its own, because it cannot tell a legitimate change (e.g. a required stub) from a bad one. Legitimacy is judged by the verifier, which fails the story with `verifier-rejected` for illegitimate test modifications.

When the test writer's session succeeds, nax commits the files it changed (`chore(<story>): auto-commit after test-writer session (RED)`), so the implementer's isolation check starts from a committed boundary. That commit skips the repository's git hooks by default: the RED tests may not typecheck until the implementer adds the fields and exports they reference, and nax's own quality commands, review checks and regression gate still run afterwards. Set `tdd.testWriterCommitHooks: "run"` to run the hooks on that commit too (a hook that rejects it leaves the files uncommitted and the run continues).

The `three-session-tdd-lite` variant relaxes the rules: the test writer may read `src/` and create minimal stubs, and the implementer may add tests for uncovered acceptance criteria. See [TDD Strategies](tdd/strategies.md).

---

[Back to README](../../README.md)
