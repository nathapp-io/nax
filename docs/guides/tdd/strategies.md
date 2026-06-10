# TDD Strategies

nax resolves each story to one of five test strategies (`no-test`, `test-after`, `tdd-simple`, `three-session-tdd`, `three-session-tdd-lite`) — driven by `config.tdd.strategy` or a per-story override. The three multi-session/single-session TDD modes below are the most common.

## Strategy Comparison

| Aspect | `three-session-tdd` | `three-session-tdd-lite` | `test-after` |
|---|---|---|---|
| **Sessions** | 3 separate sessions | 3 separate sessions | 1 session |
| **Session 1 (Test Writer)** | Strict isolation — tests only, NO src/ reads, NO stubs | Relaxed — can read src/, create stubs in src/ | ❌ No dedicated test writer |
| **Session 2 (Implementer)** | Implements against pre-written tests | Same | Implements + writes tests |
| **Session 3 (Verifier)** | Verifies isolation wasn't violated | Same | ❌ No verifier |
| **Isolation check** | ✅ Full isolation enforcement | ✅ Full isolation enforcement | ❌ None |
| **Isolation-violation fallback** | Triggers lite-mode retry | N/A (already lite) | N/A |
| **Rectification gate** | Checks implementer isolation | ⚡ Skips `verifyImplementerIsolation` | Standard |

---

## When Each Strategy Is Used

Controlled by `config.tdd.strategy`:

| Config value | Behaviour |
|---|---|
| `"auto"` | LLM/keyword router decides (see routing rules below) |
| `"strict"` | Always `three-session-tdd` |
| `"lite"` | Always `three-session-tdd-lite` |
| `"off"` | Always `test-after` |

> The `config.tdd.strategy` schema enum accepts `"auto"`, `"strict"`, `"lite"`, and `"off"` (default `"auto"`). The router (`src/routing/classify.ts`) additionally recognises `"simple"` → `tdd-simple`, but that value is not yet in the config schema enum — use a per-story `testStrategy: "tdd-simple"` override to pin single-session TDD for a specific story.

### Auto-Routing Rules (FEAT-013)

When `tdd.strategy: "auto"`, the routing stage classifies each story and selects a test strategy. `test-after` is **deprecated** from auto mode — default fallback is `three-session-tdd-lite`.

| Condition | Strategy |
|---|---|
| Security / auth logic | `three-session-tdd` |
| Public API / complex / expert | `three-session-tdd` |
| UI / layout / CLI / integration / polyglot tags | `three-session-tdd-lite` |
| Simple / medium (default) | `three-session-tdd-lite` |

**Routing priority** (ROUTE-001):

1. **PRD wins** — `story.routing.testStrategy` in `prd.json` is always honoured, never overwritten by classification
2. **Plugin routers** — plugins registered via `nax.plugins[]` can override routing
3. **LLM classifier** — if `routing.strategy: "llm"` and an agent adapter is available
4. **Keyword classifier** — default; fast and free (no API calls)

---

## Session Detail

### `three-session-tdd` — Full Mode

1. **Test Writer** — writes failing tests only. Cannot read src/ files or create any source stubs. Strict isolation enforced by post-session diff check.
2. **Implementer** — makes all failing tests pass. Works against the test-writer's output.
3. **Verifier** — confirms isolation: tests were written before implementation, no cheating.

If the test writer violates isolation (touches src/), the orchestrator flags it as `isolation-violation` and schedules a lite-mode retry on the next attempt.

Full-suite gate note:
- The full-suite rectification gate runs after implementer and before verifier.
- If attributable full-suite failures persist until rectification is exhausted, TDD stops before verifier with `failureCategory: "full-suite-gate-exhausted"`.

### `three-session-tdd-lite` — Lite Mode

Same 3-session flow, but the test writer prompt is relaxed:
- **Can read** existing src/ files (needed when importing existing types/interfaces).
- **Can create minimal stubs** in src/ (empty exports, no logic) to make imports resolve.
- Implementer isolation check (`verifyImplementerIsolation`) is **skipped** in the rectification gate.

Best for: existing codebases where greenfield isolation is impractical, or stories that modify existing modules.

### `test-after` — Single Session

One Claude Code session writes tests and implements the feature together. No structured TDD flow.

- Higher failure rate observed in practice — Claude tends to write tests that are trivially passing or implementation-first.
- Use only when `tdd.strategy: "off"` or explicitly set per-story.

---

## Per-Story Override

Add `testStrategy` to a story in `prd.json` to override routing:

```json
{
  "userStories": [
    {
      "id": "US-001",
      "testStrategy": "three-session-tdd-lite",
      ...
    }
  ]
}
```

Supported values (`VALID_TEST_STRATEGIES` in `src/config/test-strategy.ts`): `"no-test"`, `"test-after"`, `"tdd-simple"`, `"three-session-tdd"`, `"three-session-tdd-lite"`.

---

---

*Last updated: 2026-06-10*
