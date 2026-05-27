# runtime-crash FailureCategory Wiring — Design Spec

**Issue:** #1132 — Wire `runtime-crash` FailureCategory at the error path

---

## Problem

`runtime-crash` exists in `FailureCategory` and `resolveMaxAttemptsOutcome` handles it (`→ "pause"`), but it is never set on `ctx.tddFailureCategory`. Two paths are broken:

### Path A — Thrown error (CALL_OP_NO_OUTPUT / CALL_OP_MAX_RETRIES)

1. `callOp` throws `NaxError` with code `CALL_OP_NO_OUTPUT` or `CALL_OP_MAX_RETRIES`
2. `executionStage.execute()` has `try { planResult = await plan.run() } finally { unsubscribe() }` — **no catch**
3. Error propagates to `pipeline/runner.ts` catch → returns `{ finalAction: "fail", context }` with `context.tddFailureCategory === undefined`
4. `pipeline-result-handler.ts` → `case "fail"` → `markStoryFailed(..., undefined)` — category is lost

**Result:** Story fails with no `failureCategory`; the `"runtime-crash"` category in `resolveMaxAttemptsOutcome` is never reached.

### Path B — Mid-rectification crash (validator-error)

1. Rectification's `runPhase` throws during re-validation
2. `runFixCycle` demotes it to `exitReason: "validator-error"` (logged as warning, not rethrown)
3. `plan.run()` **completes** — `phaseOutputs.rectification.exitReason === "validator-error"` is set
4. `deriveTddFailureCategory` has **no branch** for `"validator-error"` → returns `undefined`
5. `routeTddFailure(undefined, ...) → { action: "pause" }` — story paused, crash invisible

---

## Solution Design

### Change 1 — `deriveTddFailureCategory` in `src/execution/post-run.ts`

Add a new branch **after** `full-suite-gate-exhausted` and **before** the plain `tests-failing` check:

```typescript
// Mid-rectification crash: validator infrastructure threw during re-validation.
// exitReason "validator-error" is set by runFixCycle when runPhase throws.
if (!verifierPassed) {
  const rectOutputCrash = phaseOutputs.rectification as { exitReason?: string } | undefined;
  if (rectOutputCrash?.exitReason === "validator-error") {
    return "runtime-crash";
  }
}
```

**Priority rationale:** `full-suite-gate-exhausted` requires both an exhausted retry budget AND unfixed test-runner findings — semantically distinct from a validator crash. `validator-error` and `EXHAUSTED_EXIT_REASONS` are mutually exclusive exit reasons, so the order is safe either way, but checking exhausted-budget first is more conservative.

### Change 2 — `routeTddFailure` in `src/pipeline/stages/execution-helpers.ts`

Add `"runtime-crash"` to the escalate branch (alongside `"session-failure"`, `"tests-failing"`, etc.):

```typescript
if (
  failureCategory === "session-failure" ||
  failureCategory === "tests-failing" ||
  failureCategory === "full-suite-gate-exhausted" ||
  failureCategory === "verifier-rejected" ||
  failureCategory === "runtime-crash"
) {
  return { action: "escalate", reason: buildReason(failureCategory) };
}
```

**Effect:** When path B produces `"runtime-crash"`, `decideStageAction` returns `{ action: "escalate" }`. The pipeline handler calls `handleTierEscalation`. When all tiers are exhausted, `resolveMaxAttemptsOutcome("runtime-crash") → "pause"` — the `tier-escalation.ts` case becomes live.

### Change 3 — catch block in `executionStage.execute()` — `src/pipeline/stages/execution.ts`

Wrap `plan.run()` in a `try/catch/finally` to enrich `ctx.tddFailureCategory` before rethrowing:

```typescript
import { NaxError } from "../../errors";

/** Error codes that indicate agent/infra failure, not user intent. */
const RUNTIME_CRASH_CODES = new Set(["CALL_OP_NO_OUTPUT", "CALL_OP_MAX_RETRIES"]);

// In execute():
let planResult: StoryOrchestratorResult;
try {
  planResult = await plan.run();
} catch (err) {
  if (err instanceof NaxError && RUNTIME_CRASH_CODES.has(err.code)) {
    ctx.tddFailureCategory = "runtime-crash";
  }
  throw err;
} finally {
  unsubscribe();
}
```

**Note:** `CALL_OP_ABORTED` is intentionally excluded — it's user-initiated (Ctrl+C), not a crash. `CALL_OP_INVALID_FALLBACK` and `CALL_OP_INVALID_TIMEOUT` are programmer errors, also excluded. `CALL_OP_NO_RUNTIME` does not exist in the codebase.

**Behavioral impact of path A:** The pipeline runner still returns `finalAction: "fail"` (not `"escalate"`) — the story fails immediately. The enrichment sets `context.tddFailureCategory = "runtime-crash"` so `markStoryFailed` records the category on the PRD story for observability and debugging.

### Change 4 — Clean up stale test annotations in `test/unit/execution/escalation/tier-escalation.test.ts`

`"runtime-crash"` is already in `FailureCategory`, `shouldRetrySameTier` and `_tierEscalationDeps` are already exported. The `@ts-expect-error` directives are stale RED markers from before the partial BUG-070 implementation. Remove them and update the misleading "RED" / "returns fail currently" comments.

---

## Error Code Inclusion List

| Code | Maps to `runtime-crash`? | Rationale |
|------|--------------------------|-----------|
| `CALL_OP_NO_OUTPUT` | ✓ | Agent returned nothing → infra failure |
| `CALL_OP_MAX_RETRIES` | ✓ | Retry budget exhausted → infra failure |
| `CALL_OP_ABORTED` | ✗ | User-initiated (Ctrl+C) — intentional |
| `CALL_OP_INVALID_FALLBACK` | ✗ | Programmer error, not a crash |
| `CALL_OP_INVALID_TIMEOUT` | ✗ | Programmer error, not a crash |

---

## Acceptance Criteria

1. `ctx.tddFailureCategory === "runtime-crash"` when `plan.run()` throws a `NaxError` with code `CALL_OP_NO_OUTPUT` or `CALL_OP_MAX_RETRIES`.
2. `deriveTddFailureCategory` returns `"runtime-crash"` when `phaseOutputs.rectification.exitReason === "validator-error"`.
3. `CALL_OP_ABORTED` does **not** set `"runtime-crash"` — `ctx.tddFailureCategory` remains `undefined`.
4. `resolveMaxAttemptsOutcome("runtime-crash")` returns `"pause"` (already implemented; confirmed live via path B after this fix).
5. Unit tests cover: `CALL_OP_NO_OUTPUT` sets category, `CALL_OP_MAX_RETRIES` sets category, `CALL_OP_ABORTED` does not set category, `validator-error` derivation.
6. Stale `@ts-expect-error` and RED comments in `tier-escalation.test.ts` are cleaned up.
7. `bun run test` passes with no regressions.

---

## Out of Scope

- Re-architecting `callOp` to embed `adapterFailure` in parsed phase output
- Distinguishing `runtime-crash` sub-categories (timeout vs unparseable vs adapter-died)
- Making the **throw path** trigger tier escalation (currently produces `finalAction: "fail"` via pipeline runner catch — would require restructuring the pipeline runner, out of scope)
