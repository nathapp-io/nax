# TDD Strategies

nax resolves each story to one of five test strategies (`no-test`, `test-after`, `tdd-simple`, `three-session-tdd`, `three-session-tdd-lite`) — driven by `config.tdd.strategy` or a per-story override. This page compares the two three-session modes with single-session `test-after`; see [Test Strategies](../test-strategies.md) for the full table.

## Strategy Comparison

| Aspect | `three-session-tdd` | `three-session-tdd-lite` | `test-after` |
|---|---|---|---|
| **Sessions** | 3 separate sessions | 3 separate sessions | 1 session |
| **Session 1 (Test Writer)** | Strict — test files only; no `src/` writes outside `tdd.testWriterAllowedPaths` | Relaxed — may read `src/` and create minimal stubs | ❌ No dedicated test writer |
| **Session 2 (Implementer)** | Implements against pre-written tests; must not modify tests | Same, and may add tests for uncovered ACs (never weaken existing ones) | Implements + writes tests |
| **Session 3 (Verifier)** | Read-only TDD-integrity review, writes a verdict | Same | ❌ No verifier |
| **Isolation check** | Mechanical `git diff` check — advisory (logged) | Same, stub-sized `src/` writes treated as soft | ❌ None |
| **Isolation-violation fallback** | Escalation with lite-mode retry (dormant — see below) | N/A (already lite) | N/A |

---

## When Each Strategy Is Used

Controlled by `config.tdd.strategy`:

| Config value | Behaviour |
|---|---|
| `"auto"` | LLM/keyword router decides (see routing rules below) |
| `"strict"` | Always `three-session-tdd` |
| `"lite"` | Always `three-session-tdd-lite` |
| `"off"` | Always `test-after` |

> The `config.tdd.strategy` schema enum accepts `"auto"`, `"strict"`, `"lite"`, and `"off"` (default `"auto"`). `determineTestStrategy()` (`src/routing/classify.ts`) additionally recognises `"simple"` → `tdd-simple`, but that value is not in the config schema enum — set `routing.testStrategy: "tdd-simple"` (together with `routing.complexity`) on a story to pin single-session TDD.

### Auto-Routing Rules

When `tdd.strategy: "auto"`, `determineTestStrategy()` selects a strategy for any story without a PRD-assigned one:

| Condition | Strategy |
|---|---|
| Security or public-API keywords in title/tags | `three-session-tdd` |
| `expert` complexity | `three-session-tdd` |
| `complex` complexity | `three-session-tdd-lite` |
| `simple` / `medium` complexity | `tdd-simple` |

Greenfield override: with `tdd.greenfieldDetection` on (default), a three-session story whose workdir has no test files is downgraded to `tdd-simple` unless it is security-critical.

**Routing priority** (ROUTE-001):

1. **PRD wins** — when a story in `prd.json` carries both `routing.complexity` and `routing.testStrategy`, they are always honoured, never overwritten by classification
2. **Plugin routers** — plugins registered via `nax.plugins[]` can override routing
3. **LLM classifier** — if `routing.strategy: "llm"` and an agent is available
4. **Keyword classifier** — fallback; fast and free (no API calls)

---

## Session Detail

### `three-session-tdd` — Full Mode

1. **Test Writer** — writes failing tests only. Must not modify `src/` (except `tdd.testWriterAllowedPaths`, default `src/index.ts` and `src/**/index.ts`).
2. **Implementer** — makes all failing tests pass without modifying test files.
3. **Verifier** — read-only TDD-integrity review of the implementer's work; writes `.nax-verifier-verdict.json`. Illegitimate test modifications fail the story as `verifier-rejected`.

The post-session isolation check (`src/tdd/isolation.ts`) is **advisory**: a violation is logged but never fails the phase, because a mechanical diff cannot tell a required stub from a real violation. The `isolation-violation` failure category and its escalate → lite-mode-retry → pause routing are still wired, but no built-in producer emits it today (only a verifier extension or plugin could).

Gate order (`CANONICAL_ORDER`): test-writer → greenfield-gate → implementer → test-presence-gate → full-suite-gate → mutation-check → verifier → verify-scoped → lint/typecheck → semantic/adversarial review.
- If attributable full-suite failures persist until rectification is exhausted, TDD stops before verifier with `failureCategory: "full-suite-gate-exhausted"`.

### `three-session-tdd-lite` — Lite Mode

Same 3-session flow, but the test writer prompt is relaxed:
- **Can read** existing src/ files (needed when importing existing types/interfaces).
- **Can create minimal stubs** in src/ (empty exports, no logic) to make imports resolve; stub-sized src/ writes are treated as soft violations by the isolation check.
- The implementer may add tests for acceptance criteria the test writer left uncovered, but must not weaken, delete, or skip existing tests.

Best for: existing codebases where greenfield isolation is impractical, or stories that modify existing modules.

### `test-after` — Single Session

One Claude Code session writes tests and implements the feature together. No structured TDD flow.

- Higher failure rate observed in practice — Claude tends to write tests that are trivially passing or implementation-first.
- Used when `tdd.strategy: "off"`, when set per-story, or as the fallback for a missing/unrecognised strategy value.

---

## Per-Story Override

Set `routing.testStrategy` on a story in `prd.json` to override routing. `routing.complexity` must be set too — the PRD value wins only when both are present. (A top-level `testStrategy` is accepted as a legacy alias only in `nax plan` output, where it is normalized into `routing`; `nax run` does not read it from a hand-edited `prd.json`.)

```json
{
  "userStories": [
    {
      "id": "US-001",
      "routing": {
        "complexity": "complex",
        "testStrategy": "three-session-tdd-lite",
        "reasoning": "Touches an existing module"
      },
      ...
    }
  ]
}
```

Supported values (`VALID_TEST_STRATEGIES` in `src/config/test-strategy.ts`): `"no-test"`, `"test-after"`, `"tdd-simple"`, `"three-session-tdd"`, `"three-session-tdd-lite"`.

---

*Last updated: 2026-09-25*
