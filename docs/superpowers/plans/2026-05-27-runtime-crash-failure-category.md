# runtime-crash FailureCategory Wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the `"runtime-crash"` FailureCategory so it is correctly set on `ctx.tddFailureCategory` when `plan.run()` throws an infra error, and returned by `deriveTddFailureCategory` when rectification's validator crashes.

**Architecture:** Three focused source changes — one new catch block in `executionStage`, one new union arm in `routeTddFailure`, one new branch in `deriveTddFailureCategory` — plus cleanup of stale test annotations. Each change is independently testable. TDD order: derivation first (most isolated), routing second, catch block third, cleanup last.

**Tech Stack:** Bun 1.3.7+ runtime, TypeScript strict, `bun:test` test framework. Tests run as `AGENT=1 timeout 30 bun test <path> --timeout=5000`.

---

## File Map

| Action | File | Change |
|--------|------|--------|
| Modify | `src/execution/post-run.ts` | Add `validator-error` branch to `deriveTddFailureCategory` |
| Modify | `src/pipeline/stages/execution-helpers.ts` | Add `"runtime-crash"` to `routeTddFailure` escalate branch |
| Modify | `src/pipeline/stages/execution.ts` | Add `catch` block with `RUNTIME_CRASH_CODES` guard around `plan.run()` |
| Modify (test) | `test/unit/execution/post-run-inspection.test.ts` | Add two new tests for `validator-error` derivation |
| Modify (test) | `test/unit/execution/execution-stage.test.ts` | Add four new tests: NO_OUTPUT, MAX_RETRIES set category; ABORTED does not; runtime-crash in routeTddFailure |
| Modify (test) | `test/unit/execution/escalation/tier-escalation.test.ts` | Remove stale `@ts-expect-error` directives and RED comments |

---

## Task 1: `deriveTddFailureCategory` — validator-error branch

**Files:**
- Modify: `src/execution/post-run.ts` (around line 147, after the `full-suite-gate-exhausted` block)
- Test: `test/unit/execution/post-run-inspection.test.ts` (append to the existing `deriveTddFailureCategory` describe block)

### Step 1.1 — Write the two failing tests

Open `test/unit/execution/post-run-inspection.test.ts`. The existing `deriveTddFailureCategory` describe block ends around line 225. Append these two tests **inside** that describe block, before its closing `}`:

```typescript
  test("returns runtime-crash when rectification exitReason is validator-error", () => {
    // AC-2: mid-rectification crash → runtime-crash category
    const result = deriveTddFailureCategory({
      rectification: { exitReason: "validator-error", success: false },
    });
    expect(result).toBe("runtime-crash");
  });

  test("does NOT return runtime-crash for validator-error when verifier passed", () => {
    // validator-error is suppressed when verifier already confirmed success
    const result = deriveTddFailureCategory({
      rectification: { exitReason: "validator-error", success: false },
      // verifierOp.name success=true makes verifierPassed=true
    });
    // verifierPassed=false here (no verifier output), so runtime-crash fires
    // This test confirms verifier-passed guard works in the opposite direction:
    // add verifier success to show it short-circuits before reaching validator-error
    const resultWithVerifierPass = deriveTddFailureCategory({
      [verifierOp.name]: { success: true },
      rectification: { exitReason: "validator-error", success: false },
    });
    expect(resultWithVerifierPass).toBeUndefined();
  });
```

> **Note on imports:** `verifierOp` is already imported in this test file — check line ~20 for the existing import block. If not present, add: `import { verifierOp } from "../../../src/execution/story-orchestrator";`

- [ ] **Step 1.2 — Run tests to verify they fail**

```bash
AGENT=1 timeout 30 bun test test/unit/execution/post-run-inspection.test.ts --timeout=5000
```

Expected: the two new tests FAIL with something like `expected undefined to be "runtime-crash"`.

- [ ] **Step 1.3 — Implement the branch in `deriveTddFailureCategory`**

Open `src/execution/post-run.ts`. Find the `full-suite-gate-exhausted` block (around line 135–147). Add the new branch **immediately after** the closing `}` of that block and **before** the `// Full-suite gate failure without an overriding verifier verdict → tests-failing.` comment:

```typescript
  // Mid-rectification crash: validator infrastructure threw during re-validation.
  // runFixCycle sets exitReason "validator-error" when runPhase throws (story-orchestrator.ts:932).
  // This is distinct from EXHAUSTED_EXIT_REASONS — the crash, not budget exhaustion, is the cause.
  if (!verifierPassed) {
    const rectOutputCrash = phaseOutputs.rectification as { exitReason?: string } | undefined;
    if (rectOutputCrash?.exitReason === "validator-error") {
      return "runtime-crash";
    }
  }
```

The surrounding context should look like this after the edit:

```typescript
  if (!verifierPassed && unfixedFindings && unfixedFindings.length > 0) {
    const rectOutput = phaseOutputs.rectification as { exitReason?: string } | undefined;
    if (
      rectOutput?.exitReason &&
      EXHAUSTED_EXIT_REASONS.has(rectOutput.exitReason) &&
      unfixedFindings.some((f) => f.source === "test-runner")
    ) {
      return "full-suite-gate-exhausted";
    }
  }

  // Mid-rectification crash: validator infrastructure threw during re-validation.
  // runFixCycle sets exitReason "validator-error" when runPhase throws (story-orchestrator.ts:932).
  // This is distinct from EXHAUSTED_EXIT_REASONS — the crash, not budget exhaustion, is the cause.
  if (!verifierPassed) {
    const rectOutputCrash = phaseOutputs.rectification as { exitReason?: string } | undefined;
    if (rectOutputCrash?.exitReason === "validator-error") {
      return "runtime-crash";
    }
  }

  // Full-suite gate failure without an overriding verifier verdict → tests-failing.
```

- [ ] **Step 1.4 — Run tests to verify they pass**

```bash
AGENT=1 timeout 30 bun test test/unit/execution/post-run-inspection.test.ts --timeout=5000
```

Expected: all tests pass including the two new ones.

- [ ] **Step 1.5 — Commit**

```bash
git add src/execution/post-run.ts test/unit/execution/post-run-inspection.test.ts
git commit -m "fix(execution): derive runtime-crash from validator-error rectification exit (#1132)"
```

---

## Task 2: `routeTddFailure` — add `runtime-crash` to escalate branch

**Files:**
- Modify: `src/pipeline/stages/execution-helpers.ts` (the compound `if` in `routeTddFailure`)
- Test: `test/unit/execution/execution-stage.test.ts` (append to the `routeTddFailure` describe block)

- [ ] **Step 2.1 — Write the failing test**

Open `test/unit/execution/execution-stage.test.ts`. The `routeTddFailure` describe block ends around line 158. Append inside that describe block:

```typescript
  it("escalates on runtime-crash with category in reason", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("runtime-crash", false, ctx);

    expect(result.action).toBe("escalate");
    if (result.action === "escalate") expect(result.reason).toBe("TDD runtime-crash");
    expect(ctx.retryAsLite).toBeUndefined();
  });
```

- [ ] **Step 2.2 — Run test to verify it fails**

```bash
AGENT=1 timeout 30 bun test test/unit/execution/execution-stage.test.ts --timeout=5000
```

Expected: new test FAILS with `expected "pause" to be "escalate"` (currently falls through to the pause branch).

- [ ] **Step 2.3 — Implement: add `"runtime-crash"` to the escalate condition**

Open `src/pipeline/stages/execution-helpers.ts`. Find the compound `if` block that checks `failureCategory === "session-failure" || ...`. Add `failureCategory === "runtime-crash"` to that union:

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

- [ ] **Step 2.4 — Run tests to verify they pass**

```bash
AGENT=1 timeout 30 bun test test/unit/execution/execution-stage.test.ts --timeout=5000
```

Expected: all tests pass.

- [ ] **Step 2.5 — Commit**

```bash
git add src/pipeline/stages/execution-helpers.ts test/unit/execution/execution-stage.test.ts
git commit -m "fix(execution): escalate on runtime-crash failure category in routeTddFailure (#1132)"
```

---

## Task 3: `executionStage` catch block — set category on thrown infra errors

**Files:**
- Modify: `src/pipeline/stages/execution.ts` (two changes: add `buildPlanForStrategy` to `_executionDeps`; change try/finally to try/catch/finally around `plan.run()`)
- Test: `test/unit/execution/execution-stage.test.ts` (add new describe block for the catch behavior)

> **Why `buildPlanForStrategy` must be added to `_executionDeps`:** The catch block wraps only `plan.run()`, not the earlier setup steps. To exercise it in tests without `mock.module()` (forbidden by `forbidden-patterns.md`), the plan factory must be injectable via `_executionDeps`. This is consistent with how `assemblePlanInputsFromCtx`, `applyPostRunInspection`, and `decideStageAction` are already wired.

- [ ] **Step 3.1 — Write three failing tests**

Add these imports at the top of `test/unit/execution/execution-stage.test.ts` (after existing imports):

```typescript
import { executionStage, _executionDeps } from "../../../src/pipeline/stages/execution";
import { NaxError } from "@/errors";
import type { PipelineContext } from "../../../src/pipeline/types";
import { DEFAULT_CONFIG } from "../../../src/config";
```

Then append this new describe block **after** the closing `});` of the existing `routeTddFailure` describe:

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// executionStage.execute — runtime-crash category on plan.run() throw
// ─────────────────────────────────────────────────────────────────────────────

describe("executionStage.execute — runtime-crash on thrown infra errors", () => {
  // Shared minimal context factory
  function makeCtx(): PipelineContext {
    return {
      story: {
        id: "US-crash-01",
        title: "Crash test",
        status: "pending",
        attempts: 0,
        workdir: "",
        escalations: [],
        priorErrors: [],
        priorFailures: [],
      },
      prd: { feature: "feat", userStories: [] } as any,
      config: DEFAULT_CONFIG,
      workdir: "/tmp/nax-crash-test",
      routing: { modelTier: "fast", testStrategy: "three-session-tdd", agent: "claude" },
      packageView: { select: () => DEFAULT_CONFIG } as any,
      runtime: {
        dispatchEvents: { onDispatch: () => () => {} } as any,
        signal: undefined,
        packages: undefined,
        onPidSpawned: undefined,
      } as any,
    } as unknown as PipelineContext;
  }

  // Helper: stub _executionDeps so plan.run() is the only thing that can throw
  function stubDeps(planRun: () => Promise<never>): () => void {
    const saved = { ..._executionDeps };
    _executionDeps.getAgent = () =>
      ({ name: "claude", capabilities: { supportedTiers: ["fast"] } } as any);
    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.captureGitRef = async () => "HEAD";
    _executionDeps.assemblePlanInputsFromCtx = async () => ({} as any);
    // buildPlanForStrategy is added to _executionDeps in Step 3.3
    (_executionDeps as any).buildPlanForStrategy = async () => ({ run: planRun });
    return () => Object.assign(_executionDeps, saved);
  }

  it("sets tddFailureCategory to runtime-crash when plan.run() throws CALL_OP_NO_OUTPUT", async () => {
    // AC-1: CALL_OP_NO_OUTPUT → runtime-crash
    const ctx = makeCtx();
    const restore = stubDeps(async () => {
      throw new NaxError("agent returned no output", "CALL_OP_NO_OUTPUT", {
        stage: "execution",
        storyId: "US-crash-01",
      });
    });

    let threw = false;
    try {
      await executionStage.execute(ctx);
    } catch (err) {
      threw = true;
      expect((err as NaxError).code).toBe("CALL_OP_NO_OUTPUT");
    } finally {
      restore();
    }

    expect(threw).toBe(true);
    expect(ctx.tddFailureCategory).toBe("runtime-crash");
  });

  it("sets tddFailureCategory to runtime-crash when plan.run() throws CALL_OP_MAX_RETRIES", async () => {
    // AC-1: CALL_OP_MAX_RETRIES → runtime-crash
    const ctx = makeCtx();
    const restore = stubDeps(async () => {
      throw new NaxError("retry budget exhausted", "CALL_OP_MAX_RETRIES", {
        stage: "execution",
        storyId: "US-crash-01",
      });
    });

    let threw = false;
    try {
      await executionStage.execute(ctx);
    } catch (err) {
      threw = true;
      expect((err as NaxError).code).toBe("CALL_OP_MAX_RETRIES");
    } finally {
      restore();
    }

    expect(threw).toBe(true);
    expect(ctx.tddFailureCategory).toBe("runtime-crash");
  });

  it("does NOT set tddFailureCategory when plan.run() throws CALL_OP_ABORTED", async () => {
    // AC-3: user-initiated abort must not be classified as runtime-crash
    const ctx = makeCtx();
    const restore = stubDeps(async () => {
      throw new NaxError("aborted", "CALL_OP_ABORTED", {
        stage: "execution",
        storyId: "US-crash-01",
      });
    });

    let threw = false;
    try {
      await executionStage.execute(ctx);
    } catch (err) {
      threw = true;
      expect((err as NaxError).code).toBe("CALL_OP_ABORTED");
    } finally {
      restore();
    }

    expect(threw).toBe(true);
    expect(ctx.tddFailureCategory).toBeUndefined(); // must NOT be set
  });
});
```

- [ ] **Step 3.2 — Run tests to verify they fail**

```bash
AGENT=1 timeout 30 bun test test/unit/execution/execution-stage.test.ts --timeout=5000
```

Expected: three new tests fail. The NO_OUTPUT and MAX_RETRIES tests fail with `expected undefined to be "runtime-crash"` (catch block not implemented yet, and `buildPlanForStrategy` not yet in `_executionDeps`). The ABORTED test may fail with a different error. All three will fail cleanly once Step 3.3 is done.

- [ ] **Step 3.3 — Implement the source changes in `executionStage`**

Open `src/pipeline/stages/execution.ts`. Make three changes:

**Change A — Add `NaxError` import** (after the `getLogger` import):

```typescript
import { NaxError } from "../../errors";
```

**Change B — Add `RUNTIME_CRASH_CODES` constant** (immediately before the `executionStage` export):

```typescript
/**
 * NaxError codes that indicate agent/infrastructure failure rather than user intent.
 * CALL_OP_ABORTED is intentionally excluded — user-initiated (Ctrl+C).
 * CALL_OP_INVALID_FALLBACK / CALL_OP_INVALID_TIMEOUT are programmer errors, not crashes.
 */
const RUNTIME_CRASH_CODES = new Set(["CALL_OP_NO_OUTPUT", "CALL_OP_MAX_RETRIES"]);
```

**Change C — Add `buildPlanForStrategy` to `_executionDeps` AND update the call site + try block**

In `execute()`, change the direct call to `buildPlanForStrategy`:

Replace:
```typescript
    const plan = await buildPlanForStrategy(callCtx, ctx.story, ctx.config, ctx.routing.testStrategy, inputs);

    let planResult: StoryOrchestratorResult;
    try {
      planResult = await plan.run();
    } finally {
      unsubscribe();
    }
```

With:
```typescript
    const plan = await _executionDeps.buildPlanForStrategy(callCtx, ctx.story, ctx.config, ctx.routing.testStrategy, inputs);

    let planResult: StoryOrchestratorResult;
    try {
      planResult = await plan.run();
    } catch (err) {
      // Enrich ctx before rethrowing so pipeline/runner.ts passes
      // tddFailureCategory to markStoryFailed. CALL_OP_ABORTED excluded
      // (user-initiated — not a crash).
      if (err instanceof NaxError && RUNTIME_CRASH_CODES.has(err.code)) {
        ctx.tddFailureCategory = "runtime-crash";
      }
      throw err;
    } finally {
      unsubscribe();
    }
```

At the bottom of the file, update `_executionDeps` to include `buildPlanForStrategy`:

Replace the existing `export const _executionDeps` block:
```typescript
/** Swappable dependencies for testing (avoids mock.module() which leaks in Bun 1.x). */
export const _executionDeps = {
  getAgent: (_name: string): AgentAdapter | undefined => undefined,
  validateAgentForTier,
  captureGitRef,
  assemblePlanInputsFromCtx,
  applyPostRunInspection,
  decideStageAction,
};
```

With:
```typescript
/** Swappable dependencies for testing (avoids mock.module() which leaks in Bun 1.x). */
export const _executionDeps = {
  getAgent: (_name: string): AgentAdapter | undefined => undefined,
  validateAgentForTier,
  captureGitRef,
  assemblePlanInputsFromCtx,
  buildPlanForStrategy,
  applyPostRunInspection,
  decideStageAction,
};
```

> **Why `finally` still needed:** `finally` runs on both the error path (after catch+rethrow) and the success path. `unsubscribe()` must run in both.

- [ ] **Step 3.4 — Run tests to verify they pass**

```bash
AGENT=1 timeout 30 bun test test/unit/execution/execution-stage.test.ts --timeout=5000
```

Expected: all tests pass including the three new ones.

- [ ] **Step 3.5 — Commit**

```bash
git add src/pipeline/stages/execution.ts test/unit/execution/execution-stage.test.ts
git commit -m "fix(execution): set runtime-crash tddFailureCategory on CALL_OP_NO_OUTPUT/MAX_RETRIES throw (#1132)"
```

---

## Task 4: Clean up stale `@ts-expect-error` and RED comments in tier-escalation.test.ts

**Files:**
- Modify: `test/unit/execution/escalation/tier-escalation.test.ts`

Context: The BUG-070 implementation was partially merged before this issue was split out. `"runtime-crash"` is already in `FailureCategory`, and `shouldRetrySameTier` / `_tierEscalationDeps` are already exported. The `@ts-expect-error` directives in this file are stale — test files are excluded from typecheck (`tsconfig.json` `"exclude": ["test"]`), so they don't cause build failures, but they are misleading.

- [ ] **Step 4.1 — Remove stale directives and update comments**

Open `test/unit/execution/escalation/tier-escalation.test.ts`.

Make these changes:

**1. `shouldRetrySameTier` describe block (lines ~15–78):** Remove all six `// @ts-expect-error: shouldRetrySameTier does not exist until BUG-070 is implemented` comments and their adjacent lines. The `shouldRetrySameTier` destructuring already works without the suppress directive. Also remove `// @ts-expect-error: RUNTIME_CRASH not in VerifyStatus until BUG-070 is implemented`.

The describe block should look like this after cleanup:

```typescript
describe("shouldRetrySameTier", () => {
  test("returns true when verifyResult status is RUNTIME_CRASH", async () => {
    const { shouldRetrySameTier } = await import(
      "../../../../src/execution/escalation/tier-escalation"
    );

    expect(typeof shouldRetrySameTier).toBe("function");
    expect(shouldRetrySameTier({ status: "RUNTIME_CRASH", success: false })).toBe(true);
  });

  test("returns false when verifyResult status is TEST_FAILURE", async () => {
    const { shouldRetrySameTier } = await import(
      "../../../../src/execution/escalation/tier-escalation"
    );
    expect(typeof shouldRetrySameTier).toBe("function");
    expect(shouldRetrySameTier({ status: "TEST_FAILURE", success: false })).toBe(false);
  });

  test("returns false when verifyResult is undefined", async () => {
    const { shouldRetrySameTier } = await import(
      "../../../../src/execution/escalation/tier-escalation"
    );
    expect(typeof shouldRetrySameTier).toBe("function");
    expect(shouldRetrySameTier(undefined)).toBe(false);
  });

  test("returns false when verifyResult status is TIMEOUT", async () => {
    const { shouldRetrySameTier } = await import(
      "../../../../src/execution/escalation/tier-escalation"
    );
    expect(typeof shouldRetrySameTier).toBe("function");
    expect(shouldRetrySameTier({ status: "TIMEOUT", success: false })).toBe(false);
  });

  test("returns false when verifyResult status is PASS", async () => {
    const { shouldRetrySameTier } = await import(
      "../../../../src/execution/escalation/tier-escalation"
    );
    expect(typeof shouldRetrySameTier).toBe("function");
    expect(shouldRetrySameTier({ status: "PASS", success: true })).toBe(false);
  });
});
```

**2. `resolveMaxAttemptsOutcome — runtime-crash category` describe block (lines ~79–100):** Remove:
- The `// RED: "runtime-crash" is not in FailureCategory yet — returns "fail" currently` comment
- The `// @ts-expect-error: runtime-crash not in FailureCategory until BUG-070 is implemented` line

The test should become:

```typescript
describe("resolveMaxAttemptsOutcome — runtime-crash category", () => {
  test("returns pause for runtime-crash failure category", async () => {
    const { resolveMaxAttemptsOutcome } = await import(
      "../../../../src/execution/escalation/tier-escalation"
    );

    expect(resolveMaxAttemptsOutcome("runtime-crash")).toBe("pause");
  });

  test("still returns fail for tests-failing (regression guard)", async () => {
    const { resolveMaxAttemptsOutcome } = await import(
      "../../../../src/execution/escalation/tier-escalation"
    );
    expect(resolveMaxAttemptsOutcome("tests-failing")).toBe("fail");
  });

  test("returns fail for full-suite-gate-exhausted (regression guard)", async () => {
    const { resolveMaxAttemptsOutcome } = await import(
      "../../../../src/execution/escalation/tier-escalation"
    );
    expect(resolveMaxAttemptsOutcome("full-suite-gate-exhausted")).toBe("fail");
  });

  test("still returns pause for verifier-rejected (regression guard)", async () => {
    const { resolveMaxAttemptsOutcome } = await import(
      "../../../../src/execution/escalation/tier-escalation"
    );
    expect(resolveMaxAttemptsOutcome("verifier-rejected")).toBe("pause");
  });
});
```

**3. `handleTierEscalation` describe block (line ~127):** Remove `// @ts-expect-error: _tierEscalationDeps does not exist until BUG-070 is implemented`.

- [ ] **Step 4.2 — Run the test file to verify all tests still pass**

```bash
AGENT=1 timeout 30 bun test test/unit/execution/escalation/tier-escalation.test.ts --timeout=5000
```

Expected: same pass count as before (13 tests), 0 fail.

- [ ] **Step 4.3 — Commit**

```bash
git add test/unit/execution/escalation/tier-escalation.test.ts
git commit -m "test(escalation): remove stale BUG-070 @ts-expect-error directives (#1132)"
```

---

## Task 5: Full suite verification

- [ ] **Step 5.1 — Run the full test suite**

```bash
AGENT=1 bun run test
```

Expected: all tests pass. If you see failures, check:
- `test/unit/execution/post-run-inspection.test.ts` — AC-2 derivation tests
- `test/unit/execution/execution-stage.test.ts` — AC-1, AC-3 catch tests
- `test/unit/execution/escalation/tier-escalation.test.ts` — regression guards
- Any test that imports `deriveTddFailureCategory` or `routeTddFailure`

- [ ] **Step 5.2 — Run typecheck**

```bash
bun run typecheck
```

Expected: clean output (typecheck covers `src/` only; test files are excluded).

- [ ] **Step 5.3 — Close with final commit (if any loose files)**

If all steps above were committed individually, no action needed. Otherwise:

```bash
git add -p  # stage only the relevant changes
git commit -m "fix(execution): wire runtime-crash FailureCategory at error path (#1132)"
```

---

## AC Verification Checklist

| AC | Covered by |
|----|-----------|
| AC-1: `ctx.tddFailureCategory === "runtime-crash"` on CALL_OP_NO_OUTPUT or CALL_OP_MAX_RETRIES throw | Task 3 tests |
| AC-2: `deriveTddFailureCategory` returns `"runtime-crash"` for `validator-error` | Task 1 tests |
| AC-3: CALL_OP_ABORTED does not set `"runtime-crash"` | Task 3 third test |
| AC-4: `resolveMaxAttemptsOutcome("runtime-crash")` returns `"pause"` (already implemented, now live via path B) | Task 4 existing test (now clean) |
| AC-5: Unit tests for each mapped code and validator-error derivation | Tasks 1 + 3 |
| AC-6: Stale `@ts-expect-error` cleaned up | Task 4 |
| AC-7: `bun run test` passes | Task 5 |
