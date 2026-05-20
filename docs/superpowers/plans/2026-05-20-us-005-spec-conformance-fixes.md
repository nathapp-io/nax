# US-005 Spec-Conformance Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the `refactor/story-orchestrator-consolidation` branch into conformance with `docs/specs/SPEC-story-orchestrator-consolidation.md` by completing the deletions, rewriting `buildPlanForStrategy` to return a real `ExecutionPlan`, wiring review + rectification slots, and converting the two new gates from LLM round-trips into deterministic operations.

**Architecture:** The current branch added scaffolding (builder slots, validators, tests) but failed the spec's deletion ACs (#6, #7, #9) and reshaped `buildPlanForStrategy` into a boolean-bag instead of an `ExecutionPlan` builder. This plan finishes the work in seven slices: (1) rewrite `buildPlanForStrategy` shape; (2) wire review + rectification slots; (3) convert gate ops to deterministic execution; (4) delete `runThreeSessionTdd` + migrate tests; (5) delete `runFullSuiteGate` + `rectification-gate.ts`; (6) rename `ThreeSessionTddResult` → `StoryRunResult`; (7) add AC#10 extensibility test + final grep gate.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, `bun:test`, Biome. All changes live in `src/execution/`, `src/operations/`, `src/pipeline/stages/`, `src/tdd/`, `test/unit/`, `test/integration/`.

**Pre-flight context (read first):**
- `docs/specs/SPEC-story-orchestrator-consolidation.md` — the spec
- `docs/findings/US-005-orchestration-drift.md` — why the first attempt drifted (avoid the same traps)
- `.claude/rules/adapter-wiring.md` — how to dispatch ops; do not bypass `callOp`
- `.claude/rules/retry-strategy.md` — for any retry decisions on gate ops
- `src/execution/story-orchestrator.ts` — `StoryOrchestratorBuilder`, `ExecutionPlan`, `CANONICAL_ORDER`
- `src/context/greenfield.ts:99` — `isGreenfieldStory()` — the deterministic detector the greenfield gate must call
- `src/tdd/rectification-gate.ts` — the legacy full-suite gate to extract from

**Verification command after every slice:** `bun run typecheck && bun run lint && timeout 60 bun test test/unit/execution/ test/unit/operations/ test/unit/tdd/ test/unit/pipeline/stages/execution-unified.test.ts --timeout=10000`

---

## Task 1: Rewrite `buildPlanForStrategy` to return `ExecutionPlan`

**Why:** Spec AC#4 requires `buildPlanForStrategy(ctx, story, config, testStrategy, inputs): ExecutionPlan`. Current implementation returns a `PlanForStrategy` boolean-bag — this re-introduces the "two sequencing wrappers" anti-pattern by forcing a second helper (`buildAndRunPlan` in `execution.ts`) to consume the bag.

**Files:**
- Modify: `src/execution/build-plan-for-strategy.ts` (rewrite — currently 70 lines)
- Modify: `src/execution/plan-inputs.ts` (export `PlanInputs` interface — verify shape matches spec §2)
- Modify: `src/execution/index.ts` (barrel — re-export shape changes)
- Test: `test/unit/execution/build-plan-for-strategy.test.ts` (rewrite assertions against `ExecutionPlan` shape, not boolean bag)

### Step 1.1 — Write failing tests for new `ExecutionPlan` return shape

- [ ] **Step:** Replace `test/unit/execution/build-plan-for-strategy.test.ts` body with table-driven tests asserting the `ExecutionPlan` returned has the correct ordered phases for each `(testStrategy, review.enabled, review.checks, rectification.enabled, isRetry)` permutation.

```typescript
// test/unit/execution/build-plan-for-strategy.test.ts (top of file, after existing imports)
import { describe, expect, test } from "bun:test";
import { buildPlanForStrategy } from "../../../src/execution/build-plan-for-strategy";
import { makeMockCallContext } from "../../helpers/call-context";
import { makeMockStory } from "../../helpers/story";
import { makeMockConfig } from "../../helpers/config";
import { makeMockPlanInputs } from "../../helpers/plan-inputs";

describe("buildPlanForStrategy — returns ExecutionPlan", () => {
  test("TDD fresh run includes test-writer, greenfield-gate, implementer, full-suite-gate, verifier", () => {
    const plan = buildPlanForStrategy(
      makeMockCallContext(),
      makeMockStory({ attempts: 0, priorFailures: [] }),
      makeMockConfig({ review: { enabled: false }, execution: { rectification: { enabled: false } } }),
      "three-session-tdd",
      makeMockPlanInputs(),
    );
    expect(plan.phaseNames()).toEqual([
      "test-writer", "greenfield-gate", "implementer", "full-suite-gate", "verifier",
    ]);
  });

  test("TDD retry (attempts > 0) omits test-writer and greenfield-gate", () => {
    const plan = buildPlanForStrategy(
      makeMockCallContext(),
      makeMockStory({ attempts: 1 }),
      makeMockConfig({ review: { enabled: false }, execution: { rectification: { enabled: false } } }),
      "three-session-tdd",
      makeMockPlanInputs(),
    );
    expect(plan.phaseNames()).toEqual([
      "implementer", "full-suite-gate", "verifier",
    ]);
  });

  test("non-TDD strategy includes only implementer (+ review/rectification if enabled)", () => {
    const plan = buildPlanForStrategy(
      makeMockCallContext(),
      makeMockStory(),
      makeMockConfig({ review: { enabled: false }, execution: { rectification: { enabled: false } } }),
      "single-session",
      makeMockPlanInputs(),
    );
    expect(plan.phaseNames()).toEqual(["implementer"]);
  });

  test("review.checks=['semantic','adversarial'] adds both review phases", () => {
    const plan = buildPlanForStrategy(
      makeMockCallContext(),
      makeMockStory(),
      makeMockConfig({ review: { enabled: true, checks: ["semantic", "adversarial"] }, execution: { rectification: { enabled: false } } }),
      "three-session-tdd",
      makeMockPlanInputs(),
    );
    expect(plan.phaseNames()).toContain("semantic-review");
    expect(plan.phaseNames()).toContain("adversarial-review");
  });

  test("rectification.enabled=true adds rectification phase last", () => {
    const plan = buildPlanForStrategy(
      makeMockCallContext(),
      makeMockStory(),
      makeMockConfig({ review: { enabled: false }, execution: { rectification: { enabled: true } } }),
      "three-session-tdd",
      makeMockPlanInputs(),
    );
    expect(plan.phaseNames().at(-1)).toBe("rectification");
  });
});
```

Note: `plan.phaseNames()` is a new helper on `ExecutionPlan` — add in Step 1.3 if not already present. If `ExecutionPlan` only exposes `phases: ReadonlyArray<{ name: string }>`, use `plan.phases.map(p => p.name)` instead. Read `src/execution/story-orchestrator.ts` first to confirm the surface.

- [ ] **Step:** Run the tests, confirm they fail compilation (`buildPlanForStrategy` returns `PlanForStrategy`, not `ExecutionPlan`).

```bash
timeout 30 bun test test/unit/execution/build-plan-for-strategy.test.ts --timeout=5000
```

Expected: FAIL — type errors on `plan.phaseNames()` / `plan.phases`.

### Step 1.2 — Rewrite `buildPlanForStrategy` source

- [ ] **Step:** Replace the entire contents of `src/execution/build-plan-for-strategy.ts`:

```typescript
/**
 * Build Plan for Strategy
 *
 * Strategy-driven plan builder. Returns a fully-configured ExecutionPlan that
 * the wrapper can execute via plan.run() — no further sequencing decisions live
 * in the wrapper.
 *
 * Spec: docs/specs/SPEC-story-orchestrator-consolidation.md §2.
 */

import type { CallContext } from "../operations/types";
import { shouldRunRectification, shouldRunReview } from "../operations/execution-gates";
import { StoryOrchestratorBuilder, type ExecutionPlan } from "./story-orchestrator";
import type { PlanInputs } from "./plan-inputs";
import type { NaxConfig } from "../config";
import type { TestStrategy } from "../config/schema-types";
import type { ReviewCheckName } from "../review/types";
import type { UserStory } from "../prd/types";

const TDD_STRATEGIES: ReadonlySet<TestStrategy> = new Set([
  "three-session-tdd",
  "three-session-tdd-lite",
]);

function isTddStrategy(s: TestStrategy): boolean {
  return TDD_STRATEGIES.has(s);
}

function isRetryRun(story: UserStory): boolean {
  if ((story.attempts ?? 0) > 0) return true;
  return (story.priorFailures ?? []).some((f) => f.stage === "review");
}

export function buildPlanForStrategy(
  ctx: CallContext,
  story: UserStory,
  config: NaxConfig,
  testStrategy: TestStrategy,
  inputs: PlanInputs,
): ExecutionPlan {
  const b = new StoryOrchestratorBuilder();
  const isTdd = isTddStrategy(testStrategy);
  const isRetry = isRetryRun(story);

  if (isTdd && !isRetry) {
    b.addTestWriter(inputs.testWriter);
    b.addGreenfieldGate(inputs.greenfieldGate);
  }
  b.addImplementer(inputs.implementer);
  if (isTdd) {
    b.addFullSuiteGate(inputs.fullSuiteGate);
    b.addVerifier(inputs.verifier);
  }
  if (shouldRunReview(config)) {
    const checks: readonly ReviewCheckName[] = config.review?.checks ?? [];
    if (checks.includes("semantic")) b.addSemanticReview(inputs.semanticReview);
    if (checks.includes("adversarial")) b.addAdversarialReview(inputs.adversarialReview);
  }
  if (shouldRunRectification(config)) {
    b.addRectification(inputs.rectification);
  }
  return b.build(ctx);
}
```

- [ ] **Step:** If `ExecutionPlan` lacks a `phaseNames()` accessor, add one. Open `src/execution/story-orchestrator.ts` and add to the `ExecutionPlan` class/interface:

```typescript
// inside ExecutionPlan
phaseNames(): readonly string[] {
  return this.phases.map((p) => p.name);
}
```

Note: if the existing `phases` array is private, expose a read-only getter instead. Match the existing access pattern.

- [ ] **Step:** Add the missing test helpers if they don't exist. Check first:

```bash
ls test/helpers/call-context.ts test/helpers/plan-inputs.ts test/helpers/story.ts test/helpers/config.ts 2>&1
```

For any missing helper, create a minimal stub:

```typescript
// test/helpers/plan-inputs.ts (only if missing)
import type { PlanInputs } from "../../src/execution/plan-inputs";

export function makeMockPlanInputs(overrides: Partial<PlanInputs> = {}): PlanInputs {
  return {
    testWriter: { story: {} as any, /* ... fill minimal valid inputs */ },
    greenfieldGate: { story: {} as any, workdir: "/tmp", resolvedTestPatterns: { globs: [], pathspec: [], regex: [], testDirs: [] } },
    implementer: { story: {} as any },
    fullSuiteGate: { story: {} as any },
    verifier: { story: {} as any },
    semanticReview: { story: {} as any },
    adversarialReview: { story: {} as any },
    rectification: {},
    ...overrides,
  } as PlanInputs;
}
```

Reuse existing helpers wherever they exist; do not duplicate.

### Step 1.3 — Run tests, confirm green

- [ ] **Step:** Run targeted tests:

```bash
timeout 30 bun test test/unit/execution/build-plan-for-strategy.test.ts --timeout=5000
```

Expected: PASS (all 5 cases).

- [ ] **Step:** Confirm `PlanForStrategy` interface is gone (no remaining importers):

```bash
grep -rn "PlanForStrategy" src/ test/
```

Expected: zero matches. If any test or src file still imports it, update or delete.

### Step 1.4 — Commit

- [ ] **Step:**

```bash
git add src/execution/build-plan-for-strategy.ts src/execution/story-orchestrator.ts test/unit/execution/build-plan-for-strategy.test.ts test/helpers/
git commit -m "refactor(US-005): buildPlanForStrategy returns ExecutionPlan (AC#4)"
```

---

## Task 2: Collapse `execution.ts` to wrapper-only inspection

**Why:** Spec §2 mandates `execution.ts` collapses to ~5 lines: `assemblePlanInputs → buildPlanForStrategy → plan.run → applyPostRunInspection → decideStageAction`. Spec AC#5 forbids `if (isTddStrategy)` branching. Current file is 502 lines and still does in-line plan slot wiring via `buildAndRunPlan()`.

**Files:**
- Modify: `src/pipeline/stages/execution.ts` (502 → ~120 lines, removing `buildAndRunPlan` and all sequencing branches)
- Create: `src/execution/post-run.ts` (extract `applyPostRunInspection` + `decideStageAction`)
- Test: `test/unit/pipeline/stages/execution-unified.test.ts` (existing — update assertions for collapsed shape)
- Test: `test/unit/execution/post-run-inspection.test.ts` (existing — verify still passes against the extracted module)

### Step 2.1 — Read the current execution.ts

- [ ] **Step:**

```bash
wc -l src/pipeline/stages/execution.ts
```

Confirm size. Read it in full before editing.

### Step 2.2 — Extract post-run logic to `src/execution/post-run.ts`

- [ ] **Step:** Create `src/execution/post-run.ts`. Move the following symbols from `execution.ts`:
  - `extractPauseReason`
  - `deriveTddFailureCategory`
  - `applyPostRunInspection` (if not already there — if currently inline in `execute()`, factor out)
  - `decideStageAction` (if not already there — factor out the final return-shape logic)

Suggested signature:

```typescript
// src/execution/post-run.ts
import type { PipelineContext, StageResult } from "../pipeline/types";
import type { StoryOrchestratorResult } from "./story-orchestrator";

export interface PostRunInspectionResult {
  readonly failureCategory?: string;
  readonly needsHumanReview: boolean;
  readonly pauseReason?: string;
  readonly verdict?: unknown;
}

export function applyPostRunInspection(
  ctx: PipelineContext,
  result: StoryOrchestratorResult,
): PostRunInspectionResult { /* extracted body */ }

export function decideStageAction(
  ctx: PipelineContext,
  result: StoryOrchestratorResult,
  inspection: PostRunInspectionResult,
): StageResult { /* extracted body */ }
```

- [ ] **Step:** Re-export from `src/execution/index.ts`:

```typescript
export { applyPostRunInspection, decideStageAction } from "./post-run";
export type { PostRunInspectionResult } from "./post-run";
```

### Step 2.3 — Collapse the `execute()` function

- [ ] **Step:** Replace the body of the exported pipeline stage `execute()` function in `src/pipeline/stages/execution.ts` with the spec's pseudocode:

```typescript
// src/pipeline/stages/execution.ts (the stage's execute function)
import { assemblePlanInputs } from "../../execution/plan-inputs";
import { buildPlanForStrategy } from "../../execution/build-plan-for-strategy";
import { applyPostRunInspection, decideStageAction } from "../../execution/post-run";
// ... existing imports retained for validation/logging/rollback ...

export async function execute(ctx: PipelineContext): Promise<StageResult> {
  logger.info("execute", "Starting execution stage", { storyId: ctx.story.id });

  // Boundary validation — agent + permission resolution stays in the wrapper.
  validateAgentManager(ctx);

  const callCtx = buildCallContext(ctx);
  const inputs = assemblePlanInputs(ctx);
  const plan = buildPlanForStrategy(callCtx, ctx.story, ctx.config, ctx.routing.testStrategy, inputs);
  const result = await plan.run();
  const inspection = applyPostRunInspection(ctx, result);

  // Rollback is a wrapper side effect listed in spec §3 table.
  if (!result.success && ctx.config.tdd?.rollbackOnFailure) {
    await rollbackToInitialRef(ctx);
  }

  return decideStageAction(ctx, result, inspection);
}
```

- [ ] **Step:** Delete `buildAndRunPlan` from `execution.ts` outright. Delete `isTddStrategy` branching. Delete any `PlanForStrategy` consumption. Delete unused imports.

- [ ] **Step:** Verify the file is now under 150 lines:

```bash
wc -l src/pipeline/stages/execution.ts
```

Expected: < 150 lines. If not, more extraction is needed — push helpers into `src/execution/`.

### Step 2.4 — Update tests + run

- [ ] **Step:** Update `test/unit/pipeline/stages/execution-unified.test.ts` to assert the new contract:
  - `execute()` calls `assemblePlanInputs`, `buildPlanForStrategy`, `plan.run()`, `applyPostRunInspection`, `decideStageAction` in that order
  - No `if (isTddStrategy)` branch is observable — verify by checking the same code path runs for `single-session` strategy and `three-session-tdd` strategy with different plan compositions

- [ ] **Step:**

```bash
timeout 30 bun test test/unit/pipeline/stages/execution-unified.test.ts test/unit/execution/post-run-inspection.test.ts --timeout=10000
```

Expected: PASS.

### Step 2.5 — Commit

- [ ] **Step:**

```bash
git add src/pipeline/stages/execution.ts src/execution/post-run.ts src/execution/index.ts test/unit/pipeline/stages/execution-unified.test.ts
git commit -m "refactor(US-005): collapse execution.ts to wrapper-only inspection (AC#5, AC#8)"
```

---

## Task 3: Convert `greenfieldGateOp` to deterministic filesystem op

**Why:** Spec §1B is explicit: greenfield detection must call `isGreenfieldStory(story, workdir, patterns)` from `src/context/greenfield.ts:99`, NOT open an LLM session. Current `kind: "run"` with `session: { role: "main", lifetime: "fresh" }` is wrong; the op spends an LLM round-trip to ask the model what `fs.readdir` could answer.

**Files:**
- Modify: `src/operations/greenfield-gate.ts` (rewrite)
- Modify: `src/operations/index.ts` (no change to exports; just verify)
- Test: `test/unit/operations/greenfield-gate.test.ts` (rewrite — assert disk scan, not parse())

### Step 3.1 — Write failing tests for deterministic behavior

- [ ] **Step:** Replace `test/unit/operations/greenfield-gate.test.ts` with tests that exercise the disk scan via a temp dir:

```typescript
import { describe, expect, test } from "bun:test";
import { greenfieldGateOp } from "../../../src/operations/greenfield-gate";
import { makeTempDir, cleanupTempDir } from "../../helpers/temp";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

describe("greenfieldGateOp — deterministic filesystem detection", () => {
  test("returns hasPreExistingTests=true when test files exist on disk", async () => {
    const dir = await makeTempDir();
    try {
      await mkdir(join(dir, "test/unit"), { recursive: true });
      await writeFile(join(dir, "test/unit/example.test.ts"), "");

      const out = await greenfieldGateOp.execute!({
        story: { id: "s1" } as any,
        workdir: dir,
        resolvedTestPatterns: {
          globs: ["test/**/*.test.ts"],
          regex: [/\.test\.ts$/],
          pathspec: [":test/**/*.test.ts"],
          testDirs: ["test"],
        },
      } as any, {} as any);

      expect(out.success).toBe(true);
      expect(out.hasPreExistingTests).toBe(true);
      expect(out.pauseReason).toBeUndefined();
    } finally {
      await cleanupTempDir(dir);
    }
  });

  test("returns success=false with pauseReason='greenfield-no-tests' when no tests exist", async () => {
    const dir = await makeTempDir();
    try {
      const out = await greenfieldGateOp.execute!({
        story: { id: "s2" } as any,
        workdir: dir,
        resolvedTestPatterns: {
          globs: ["test/**/*.test.ts"],
          regex: [/\.test\.ts$/],
          pathspec: [":test/**/*.test.ts"],
          testDirs: ["test"],
        },
      } as any, {} as any);

      expect(out.success).toBe(false);
      expect(out.hasPreExistingTests).toBe(false);
      expect(out.pauseReason).toBe("greenfield-no-tests");
    } finally {
      await cleanupTempDir(dir);
    }
  });
});
```

Note on op shape: the spec says `kind: "run"`. If the existing `RunOperation` contract requires `build()` + `parse()` (LLM dispatch shape), then either: (a) the op needs a new "deterministic" variant added to the union, or (b) wrap the disk scan inside a synthetic `build()` that returns no prompt and a `parse()` that derives output. **Check `src/operations/types.ts` for `RunOperation` shape first.** If a deterministic kind doesn't exist, add it in a sub-step — coordinate with the agent before introducing a new kind. Discuss with the team if uncertain; for this plan, assume `op.execute(input, ctx)` is the simplest path and add it as an alternative to `build/parse` for deterministic ops, OR if that breaks the contract, declare a new `kind: "deterministic"` with an `execute()` method.

### Step 3.2 — Decide on op kind + implement

- [ ] **Step:** Read `src/operations/types.ts` and `src/operations/call-op.ts`. Confirm one of these options:
  - Option A: `RunOperation` permits `execute()` as an alternative to `build()`/`parse()` for non-LLM ops.
  - Option B: Add `kind: "deterministic"` to the operation union with a single `execute(input, ctx): Promise<O>` method, and update `callOp` to dispatch it.

If Option B is required, this Task gets a sub-task to extend the op type + `callOp` dispatch. **Stop and ask the user** before adding a new kind — this exceeds the spec.

- [ ] **Step:** Rewrite `src/operations/greenfield-gate.ts`:

```typescript
/**
 * Greenfield Gate Op
 *
 * Deterministic detection of pre-existing tests. Calls isGreenfieldStory()
 * on the package filesystem — no LLM round-trip.
 *
 * Spec: docs/specs/SPEC-story-orchestrator-consolidation.md §1B.
 */

import { isGreenfieldStory } from "../context/greenfield";
import type { UserStory } from "../prd/types";
import type { ResolvedTestPatterns } from "../test-runners/types";
import { pickSelector } from "../config/selectors";

export interface GreenfieldGateInput {
  readonly story: UserStory;
  readonly workdir: string;
  readonly resolvedTestPatterns: ResolvedTestPatterns;
}

export interface GreenfieldGateOutput {
  readonly success: boolean;
  readonly hasPreExistingTests: boolean;
  readonly pauseReason?: string;
}

const greenfieldGateConfigSelector = pickSelector("greenfield-gate", "tdd");

export const greenfieldGateOp = {
  kind: "deterministic" as const,
  name: "greenfield-gate",
  stage: "verify" as const,
  config: greenfieldGateConfigSelector,
  async execute(input: GreenfieldGateInput): Promise<GreenfieldGateOutput> {
    try {
      const isGreenfield = await isGreenfieldStory(
        input.story,
        input.workdir,
        input.resolvedTestPatterns,
      );
      if (isGreenfield) {
        return {
          success: false,
          hasPreExistingTests: false,
          pauseReason: "greenfield-no-tests",
        };
      }
      return { success: true, hasPreExistingTests: true };
    } catch (_err) {
      // Per spec Failure Handling: filesystem read failure → safe-fallback to pause.
      return {
        success: false,
        hasPreExistingTests: false,
        pauseReason: "greenfield-no-tests",
      };
    }
  },
};
```

- [ ] **Step:** Run tests:

```bash
timeout 30 bun test test/unit/operations/greenfield-gate.test.ts --timeout=10000
```

Expected: PASS.

### Step 3.3 — Commit

- [ ] **Step:**

```bash
git add src/operations/greenfield-gate.ts test/unit/operations/greenfield-gate.test.ts src/operations/types.ts src/operations/call-op.ts
git commit -m "refactor(US-005): greenfieldGateOp uses isGreenfieldStory (deterministic, AC#2)"
```

---

## Task 4: Convert `fullSuiteGateOp` to deterministic test-runner op

**Why:** Spec §1A says the full-suite gate's logic moves from `runFullSuiteGate` into `fullSuiteGateOp`'s `build/parse/recover` triad. Reading the spec carefully: the gate runs the test suite (a real process), interprets the result, and optionally fires the internal rectification loop. Current implementation opens an LLM session and asks the model — wrong on both counts.

The full-suite gate keeps its **internal rectification loop** (gate-owned in US-005, spec §1A — folding to general rectification is deferred to US-006). So this op orchestrates: (1) run tests; (2) if pass, return `success: true`; (3) if fail and rectification enabled, invoke `runRectificationLoop`; (4) if rectification exhausts, return `success: false, status: "rectification-exhausted"`.

**Files:**
- Modify: `src/operations/full-suite-gate.ts` (rewrite — extract logic from `src/tdd/rectification-gate.ts`)
- Test: `test/unit/operations/full-suite-gate.test.ts` (rewrite for deterministic behavior)

### Step 4.1 — Read the existing `runFullSuiteGate`

- [ ] **Step:** Read `src/tdd/rectification-gate.ts:81-end`. Catalog:
  - What functions does `runFullSuiteGate` call to actually run tests?
  - How does it invoke `runRectificationLoop`?
  - What is the `attempts` counter, `estimatedCostUsd`, `durationMs` derived from?

### Step 4.2 — Write failing tests for the deterministic full-suite gate

- [ ] **Step:** Replace `test/unit/operations/full-suite-gate.test.ts` with tests that mock the test-runner + rectification-loop deps (using `_deps` injection per project convention):

```typescript
import { describe, expect, test } from "bun:test";
import { fullSuiteGateOp } from "../../../src/operations/full-suite-gate";

describe("fullSuiteGateOp — deterministic test execution + internal rectification", () => {
  test("returns success=true, status='passed' when tests pass on first run", async () => {
    const ctx = makeMockCallCtx();
    const out = await fullSuiteGateOp.execute!(
      { story: {} as any } as any,
      ctx,
      { _runTests: async () => ({ passed: true, failed: 0 }), _runRectificationLoop: async () => ({ exhausted: false, attempts: 0 }) },
    );
    expect(out.success).toBe(true);
    expect(out.status).toBe("passed");
    expect(out.attempts).toBe(0);
  });

  test("invokes rectification when tests fail and rectification enabled", async () => {
    let rectCalled = false;
    const out = await fullSuiteGateOp.execute!(
      { story: {} as any, rectificationEnabled: true } as any,
      makeMockCallCtx(),
      {
        _runTests: async () => ({ passed: false, failed: 2 }),
        _runRectificationLoop: async () => {
          rectCalled = true;
          return { exhausted: false, attempts: 1, fixedAll: true };
        },
      },
    );
    expect(rectCalled).toBe(true);
    expect(out.success).toBe(true);
    expect(out.status).toBe("passed");
    expect(out.attempts).toBe(1);
  });

  test("returns success=false, status='rectification-exhausted' when rectification gives up", async () => {
    const out = await fullSuiteGateOp.execute!(
      { story: {} as any, rectificationEnabled: true } as any,
      makeMockCallCtx(),
      {
        _runTests: async () => ({ passed: false, failed: 5 }),
        _runRectificationLoop: async () => ({ exhausted: true, attempts: 3, fixedAll: false }),
      },
    );
    expect(out.success).toBe(false);
    expect(out.status).toBe("rectification-exhausted");
    expect(out.attempts).toBe(3);
  });

  test("when rectification.enabled=false and tests pass, returns success=true", async () => {
    const out = await fullSuiteGateOp.execute!(
      { story: {} as any, rectificationEnabled: false } as any,
      makeMockCallCtx(),
      {
        _runTests: async () => ({ passed: true, failed: 0 }),
        _runRectificationLoop: async () => { throw new Error("should not be called"); },
      },
    );
    expect(out.success).toBe(true);
    expect(out.status).toBe("passed");
  });

  test("when rectification.enabled=false and tests fail, returns success=false WITHOUT halting on disabled status (regression check)", async () => {
    // BUG REGRESSION GUARD: previously returned status='disabled' which caused phasePassed
    // to halt every non-rectification TDD plan before the verifier ran.
    const out = await fullSuiteGateOp.execute!(
      { story: {} as any, rectificationEnabled: false } as any,
      makeMockCallCtx(),
      {
        _runTests: async () => ({ passed: false, failed: 1 }),
        _runRectificationLoop: async () => { throw new Error("should not be called"); },
      },
    );
    expect(out.success).toBe(false);
    expect(out.status).toBe("failed-no-rectification"); // not "disabled"
  });
});
```

### Step 4.3 — Implement the new op

- [ ] **Step:** Rewrite `src/operations/full-suite-gate.ts`. The op should:
  - Use `_deps` injection for `runTests` (current production call site lives in `src/verification/`) and `runRectificationLoop` (lives in `src/findings/cycle.ts` or wherever the legacy `rectification-gate.ts` imported from)
  - Return `{ success, status, attempts, estimatedCostUsd, durationMs }`
  - `status` values: `"passed" | "failed-no-rectification" | "rectification-exhausted"`
  - **Critical:** when `rectificationEnabled === false` and tests fail, return `success: false, status: "failed-no-rectification"`. Never return `status: "disabled"` — that caused the regression where TDD halted before the verifier.

```typescript
/**
 * Full Suite Gate Op
 *
 * Runs the full test suite after the implementer phase; optionally invokes
 * gate-internal rectification (US-005 keeps gate-internal rectification per
 * spec §1A; folding to general rectification is deferred to US-006).
 *
 * Spec: docs/specs/SPEC-story-orchestrator-consolidation.md §1A.
 */

import { runRectificationLoop } from "../findings/cycle"; // verify import path
import { runFullSuite } from "../verification/runner";   // verify import path
import type { UserStory } from "../prd/types";
import { pickSelector } from "../config/selectors";

export interface FullSuiteGateInput {
  readonly story: UserStory;
  readonly rectificationEnabled: boolean;
  // ...add other fields lifted from current FullSuiteGateInput
}

export interface FullSuiteGateOutput {
  readonly success: boolean;
  readonly status: "passed" | "failed-no-rectification" | "rectification-exhausted";
  readonly attempts: number;
  readonly estimatedCostUsd: number;
  readonly durationMs: number;
}

interface FullSuiteGateDeps {
  readonly _runTests?: (input: FullSuiteGateInput, ctx: any) => Promise<{ passed: boolean; failed: number }>;
  readonly _runRectificationLoop?: (input: FullSuiteGateInput, ctx: any) => Promise<{ exhausted: boolean; attempts: number; fixedAll?: boolean }>;
}

const fullSuiteGateConfigSelector = pickSelector("full-suite-gate", "tdd", "execution");

export const fullSuiteGateOp = {
  kind: "deterministic" as const,
  name: "full-suite-gate",
  stage: "verify" as const,
  config: fullSuiteGateConfigSelector,
  async execute(
    input: FullSuiteGateInput,
    ctx: any,
    deps: FullSuiteGateDeps = {},
  ): Promise<FullSuiteGateOutput> {
    const start = Date.now();
    const runTests = deps._runTests ?? runFullSuite;
    const runRect = deps._runRectificationLoop ?? runRectificationLoop;

    const first = await runTests(input, ctx);
    if (first.passed) {
      return { success: true, status: "passed", attempts: 0, estimatedCostUsd: 0, durationMs: Date.now() - start };
    }
    if (!input.rectificationEnabled) {
      return { success: false, status: "failed-no-rectification", attempts: 0, estimatedCostUsd: 0, durationMs: Date.now() - start };
    }
    const rect = await runRect(input, ctx);
    if (rect.exhausted) {
      return { success: false, status: "rectification-exhausted", attempts: rect.attempts, estimatedCostUsd: 0, durationMs: Date.now() - start };
    }
    return { success: true, status: "passed", attempts: rect.attempts, estimatedCostUsd: 0, durationMs: Date.now() - start };
  },
};
```

Note: `estimatedCostUsd` must be threaded from the actual test/rectification subsystems if they track it. If they don't yet, leave at 0 with a `// TODO: thread cost from rectification middleware` comment removed — instead, file an issue and link in the spec.

- [ ] **Step:** Confirm `extractPauseReason` (now in `src/execution/post-run.ts`) handles `pauseReason` from `greenfieldGateOp` output. Update if needed.

- [ ] **Step:** Run tests:

```bash
timeout 30 bun test test/unit/operations/full-suite-gate.test.ts --timeout=10000
```

Expected: PASS (all 5 tests including the regression guard).

### Step 4.4 — Commit

- [ ] **Step:**

```bash
git add src/operations/full-suite-gate.ts test/unit/operations/full-suite-gate.test.ts src/execution/post-run.ts
git commit -m "refactor(US-005): fullSuiteGateOp runs tests deterministically (AC#1, fix non-rectification halt regression)"
```

---

## Task 5: Delete `runThreeSessionTdd` + migrate test files

**Why:** Spec AC#6: `grep -rn "runThreeSessionTdd" src/ test/` must return zero matches. Spec §4 enumerates 9 test files to migrate (rewrite behavior tests against `buildPlanForStrategy`, retire path-specific shape tests).

**Files:**
- Delete: `src/tdd/orchestrator.ts`
- Delete: `src/tdd/orchestrator-ctx.ts`
- Modify: `src/tdd/index.ts` (remove `runThreeSessionTdd` export)
- Modify: `src/tdd/session-op.ts` (delete `runTddSessionViaBuilder` shim per spec §4 last bullet)
- Modify (port): `test/integration/tdd/tdd-orchestrator-core.test.ts`
- Modify (port): `test/integration/tdd/tdd-orchestrator-verdict.test.ts`
- Modify (port): `test/integration/tdd/tdd-orchestrator-lite.test.ts`
- Modify (port): `test/integration/tdd/tdd-orchestrator-failureCategory.test.ts`
- Modify (port): `test/integration/tdd/tdd-orchestrator-fallback.test.ts`
- Modify (port): `test/unit/tdd/orchestrator-totals.test.ts`
- Modify (port): `test/unit/pipeline/storyid-events.test.ts`
- Delete: `test/integration/tdd/rectification-gate-orchestrator.test.ts` (path-specific shape — retire outright per spec)
- Modify: `test/helpers/runtime.ts` (docstring/example update)

### Step 5.1 — Verify no production caller remains

- [ ] **Step:**

```bash
grep -rn "runThreeSessionTdd\|runTddSessionViaBuilder\|runThreeSessionTddFromCtx" src/ | grep -v "^src/tdd/orchestrator.ts\|^src/tdd/orchestrator-ctx.ts\|^src/tdd/index.ts\|^src/tdd/session-op.ts"
```

Expected: zero matches. If anything else still imports these, fix before deleting.

### Step 5.2 — Port behavior tests one at a time

For each of the 6 test files (excluding `rectification-gate-orchestrator.test.ts` which is deleted), the migration pattern is:

**Before (calls `runThreeSessionTdd` directly):**
```typescript
const result = await runThreeSessionTdd({ /* options */ });
expect(result.verdict).toBe("passed");
```

**After (uses `buildPlanForStrategy` + `plan.run()`):**
```typescript
const plan = buildPlanForStrategy(callCtx, story, config, "three-session-tdd", inputs);
const result = await plan.run();
const inspection = applyPostRunInspection(ctx, result);
expect(inspection.verdict).toBe("passed");
```

- [ ] **Step:** Port `test/integration/tdd/tdd-orchestrator-core.test.ts`. Run after porting:

```bash
timeout 60 bun test test/integration/tdd/tdd-orchestrator-core.test.ts --timeout=20000
```

- [ ] **Step:** Port `test/integration/tdd/tdd-orchestrator-verdict.test.ts`. Run.
- [ ] **Step:** Port `test/integration/tdd/tdd-orchestrator-lite.test.ts`. Run.
- [ ] **Step:** Port `test/integration/tdd/tdd-orchestrator-failureCategory.test.ts`. Run.
- [ ] **Step:** Port `test/integration/tdd/tdd-orchestrator-fallback.test.ts`. Run.
- [ ] **Step:** Port `test/unit/tdd/orchestrator-totals.test.ts`. Run.
- [ ] **Step:** Port `test/unit/pipeline/storyid-events.test.ts`. Run.

For each: if a behavior cannot be expressed through `buildPlanForStrategy`, that's a bug in either `buildPlanForStrategy` or the test — investigate, do not skip the test.

### Step 5.3 — Delete the legacy files

- [ ] **Step:**

```bash
git rm src/tdd/orchestrator.ts src/tdd/orchestrator-ctx.ts test/integration/tdd/rectification-gate-orchestrator.test.ts
```

- [ ] **Step:** Edit `src/tdd/index.ts` — remove the `runThreeSessionTdd` re-export. Remove any other now-dead re-exports.

- [ ] **Step:** Edit `src/tdd/session-op.ts` — delete `runTddSessionViaBuilder` if it still exists; update docstring on line 55 that mentions it.

- [ ] **Step:** Edit `test/helpers/runtime.ts` — update any docstring/example mentioning `runThreeSessionTdd`.

### Step 5.4 — Verify deletion is complete

- [ ] **Step:**

```bash
grep -rn "runThreeSessionTdd\|runTddSessionViaBuilder\|runThreeSessionTddFromCtx" src/ test/
```

Expected: **zero matches**. This is the AC#6 grep test. If any match remains, fix it before proceeding — DO NOT commit with violations.

- [ ] **Step:** Run full test suite to catch any unported callers:

```bash
bun run test:bail
```

Expected: PASS.

### Step 5.5 — Commit

- [ ] **Step:**

```bash
git add -A
git commit -m "refactor(US-005): delete runThreeSessionTdd and migrate 7 test files (AC#6)"
```

---

## Task 6: Delete `rectification-gate.ts` and migrate its tests

**Why:** Spec AC#7: `src/tdd/rectification-gate.ts` deleted entirely. All call sites route through `fullSuiteGateOp`.

**Files:**
- Delete: `src/tdd/rectification-gate.ts`
- Migrate/delete: `test/unit/tdd/rectification-gate.test.ts`
- Migrate/delete: `test/unit/tdd/rectification-gate-session.test.ts`
- Update: `test/integration/agents/acp/tdd-flow-rectification.test.ts` (still references the legacy gate — route through op)

### Step 6.1 — Verify all `runFullSuiteGate` callers are gone

- [ ] **Step:**

```bash
grep -rn "runFullSuiteGate\|from.*rectification-gate" src/ test/
```

Expected: only the file being deleted + 3 test files. If any production caller remains, route through `fullSuiteGateOp` first.

### Step 6.2 — Decide test fate

- [ ] **Step:** For each of the 3 test files: is it testing the *behavior* (full-suite + rectification interaction) or the *shape* (`runFullSuiteGate` API existence)?
  - Behavior tests → port to use `fullSuiteGateOp` directly via `callOp`
  - Shape tests → delete (they verified an API that no longer exists)

The first two (`rectification-gate.test.ts`, `rectification-gate-session.test.ts`) are likely shape tests — verify, then delete. `tdd-flow-rectification.test.ts` is integration — port.

### Step 6.3 — Delete and verify

- [ ] **Step:**

```bash
git rm src/tdd/rectification-gate.ts test/unit/tdd/rectification-gate.test.ts test/unit/tdd/rectification-gate-session.test.ts
```

- [ ] **Step:** Update `test/integration/agents/acp/tdd-flow-rectification.test.ts` to dispatch via `callOp(ctx, fullSuiteGateOp, input)`.

- [ ] **Step:**

```bash
grep -rn "runFullSuiteGate" src/ test/
```

Expected: zero matches.

- [ ] **Step:**

```bash
bun run test:bail
```

Expected: PASS.

### Step 6.4 — Commit

- [ ] **Step:**

```bash
git add -A
git commit -m "refactor(US-005): delete src/tdd/rectification-gate.ts (AC#7)"
```

---

## Task 7: Rename `ThreeSessionTddResult` → `StoryRunResult`

**Why:** Spec AC#9: type renamed and moved to `src/execution/types.ts`. Current branch only added a type alias in `src/tdd/api-surface.ts` — a cosmetic re-export, not the rename.

**Files:**
- Modify: `src/execution/types.ts` (add `StoryRunResult` definition)
- Delete: `ThreeSessionTddResult` from `src/tdd/types.ts:157`
- Delete: `src/tdd/api-surface.ts` (no longer needed once the alias is real)
- Update: all importers (verify via grep)

### Step 7.1 — Move the type

- [ ] **Step:** Cut the `ThreeSessionTddResult` interface body out of `src/tdd/types.ts:157`. Paste into `src/execution/types.ts` renamed as `StoryRunResult`:

```typescript
// src/execution/types.ts
export interface StoryRunResult {
  // ... fields lifted verbatim from ThreeSessionTddResult ...
}
```

- [ ] **Step:** Re-export from `src/execution/index.ts`:

```typescript
export type { StoryRunResult } from "./types";
```

### Step 7.2 — Update all importers

- [ ] **Step:**

```bash
grep -rn "ThreeSessionTddResult" src/ test/
```

For each match, rewrite the import to:
```typescript
import type { StoryRunResult } from "../execution";
```

(Adjust relative path as needed.)

- [ ] **Step:** Delete `src/tdd/api-surface.ts` — the `_s = null` namespace trick is no longer needed:

```bash
git rm src/tdd/api-surface.ts
```

Verify no test references it:
```bash
grep -rn "api-surface" src/ test/
```

Expected: zero matches.

- [ ] **Step:**

```bash
grep -rn "ThreeSessionTddResult" src/ test/
```

Expected: **zero matches**. AC#9 verified.

### Step 7.3 — Run + commit

- [ ] **Step:**

```bash
bun run typecheck && timeout 60 bun test test/unit/ test/integration/ --timeout=10000
```

Expected: PASS.

- [ ] **Step:**

```bash
git add -A
git commit -m "refactor(US-005): rename ThreeSessionTddResult to StoryRunResult, move to src/execution/types.ts (AC#9)"
```

---

## Task 8: Add AC#10 extensibility test

**Why:** Spec AC#10 mandates `test/unit/execution/builder-extensibility.test.ts` — grep-based assertions that adding a new phase requires edits only in 3 places under `src/execution/` and `src/operations/`.

**Files:**
- Create: `test/unit/execution/builder-extensibility.test.ts`

### Step 8.1 — Write the grep-based test

- [ ] **Step:** Create the file:

```typescript
/**
 * Spec AC#10: Adding a new phase requires edits in exactly three places:
 *   (a) New op file: src/operations/<name>.ts
 *   (b) StoryOrchestratorBuilder: extends PhaseKind, CANONICAL_ORDER,
 *       collectOrderedPhases, addX overloads — single coordinated edit
 *   (c) buildPlanForStrategy: one b.addX(...) line
 *
 * This test fails if a new phase appears in src/tdd/orchestrator.ts (deleted in
 * US-005) or src/pipeline/stages/execution.ts (wrapper must stay phase-blind).
 */

import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

async function readAll(glob: string): Promise<string> {
  let combined = "";
  for await (const path of new Glob(glob).scan({ cwd: process.cwd(), absolute: true })) {
    combined += await Bun.file(path).text();
  }
  return combined;
}

describe("AC#10 — builder extensibility constraint", () => {
  test("execution.ts contains no phase-specific dispatch (no addTestWriter/addImplementer/addVerifier calls)", async () => {
    const src = await Bun.file("src/pipeline/stages/execution.ts").text();
    for (const sym of ["addTestWriter", "addImplementer", "addVerifier", "addGreenfieldGate", "addFullSuiteGate", "addSemanticReview", "addAdversarialReview", "addRectification"]) {
      expect(src.includes(sym), `execution.ts must not call ${sym} — phase dispatch belongs in buildPlanForStrategy`).toBe(false);
    }
  });

  test("buildPlanForStrategy.ts is the only file calling phase add* methods (excluding the builder definition itself)", async () => {
    const callers = new Set<string>();
    for await (const path of new Glob("src/**/*.ts").scan({ cwd: process.cwd(), absolute: false })) {
      if (path === "src/execution/story-orchestrator.ts") continue; // builder owns the methods
      if (path === "src/execution/build-plan-for-strategy.ts") { callers.add(path); continue; }
      const src = await Bun.file(path).text();
      if (/\bb\.add(TestWriter|Implementer|Verifier|GreenfieldGate|FullSuiteGate|SemanticReview|AdversarialReview|Rectification)\(/.test(src)) {
        callers.add(path);
      }
    }
    expect(callers).toEqual(new Set(["src/execution/build-plan-for-strategy.ts"]));
  });

  test("legacy entry points are gone", async () => {
    expect(await Bun.file("src/tdd/orchestrator.ts").exists()).toBe(false);
    expect(await Bun.file("src/tdd/rectification-gate.ts").exists()).toBe(false);
    expect(await Bun.file("src/tdd/orchestrator-ctx.ts").exists()).toBe(false);
  });

  test("grep for retired symbols returns zero matches", async () => {
    const combined = await readAll("src/**/*.ts") + await readAll("test/**/*.ts");
    expect(combined.includes("runThreeSessionTdd")).toBe(false);
    expect(combined.includes("runTddSessionViaBuilder")).toBe(false);
    expect(combined.includes("runFullSuiteGate")).toBe(false);
    expect(combined.includes("ThreeSessionTddResult")).toBe(false);
  });
});
```

### Step 8.2 — Run + commit

- [ ] **Step:**

```bash
timeout 30 bun test test/unit/execution/builder-extensibility.test.ts --timeout=10000
```

Expected: PASS (all 4 cases). If any fails, you missed a deletion in Task 5/6/7 — go back and fix.

- [ ] **Step:**

```bash
git add test/unit/execution/builder-extensibility.test.ts
git commit -m "test(US-005): add AC#10 builder extensibility grep test"
```

---

## Task 9: Final verification gate

### Step 9.1 — Full conformance check

- [ ] **Step:** Run all spec conformance greps:

```bash
echo "=== AC#6: no runThreeSessionTdd ==="
grep -rn "runThreeSessionTdd" src/ test/ && echo "FAIL" || echo "OK"

echo "=== AC#6: no runTddSessionViaBuilder ==="
grep -rn "runTddSessionViaBuilder" src/ test/ && echo "FAIL" || echo "OK"

echo "=== AC#7: no runFullSuiteGate ==="
grep -rn "runFullSuiteGate" src/ test/ && echo "FAIL" || echo "OK"

echo "=== AC#9: no ThreeSessionTddResult ==="
grep -rn "ThreeSessionTddResult" src/ test/ && echo "FAIL" || echo "OK"

echo "=== Legacy files gone ==="
ls src/tdd/orchestrator.ts src/tdd/rectification-gate.ts src/tdd/orchestrator-ctx.ts src/tdd/api-surface.ts 2>&1 | grep -v "No such file" && echo "FAIL" || echo "OK"

echo "=== execution.ts under 150 lines (AC#5 collapse) ==="
[ $(wc -l < src/pipeline/stages/execution.ts) -lt 150 ] && echo "OK" || echo "FAIL ($(wc -l < src/pipeline/stages/execution.ts) lines)"

echo "=== buildPlanForStrategy returns ExecutionPlan (AC#4) ==="
grep -q "export function buildPlanForStrategy" src/execution/build-plan-for-strategy.ts && grep -q ": ExecutionPlan {" src/execution/build-plan-for-strategy.ts && echo "OK" || echo "FAIL"
```

Expected: all "OK".

### Step 9.2 — Full build + test + lint

- [ ] **Step:**

```bash
bun run typecheck && bun run lint && bun run test:bail
```

Expected: PASS.

### Step 9.3 — Final commit + branch summary

- [ ] **Step:** Squash auto-commit-after-session chore commits if desired (optional cleanup):

```bash
git log --oneline 4576c6572966f987b570c14b0d0f96747d03d23c..HEAD | grep "chore.*auto-commit"
```

Decide with the user whether to interactive-rebase to squash chore commits before opening the PR.

- [ ] **Step:** Update the spec's Revision History with rev 4 noting the fix landed.

---

## Anti-Patterns to Avoid (read before starting)

These traps caused the first attempt to drift — see `docs/findings/US-005-orchestration-drift.md` for full analysis.

1. **Do not return a boolean-bag from `buildPlanForStrategy`.** It must return `ExecutionPlan`. If the return type is hard to test, write contract tests against `plan.run()`, not shape tests against boolean fields.
2. **Do not skip the deletions.** Tasks 5, 6, 7 are the load-bearing work. If type errors block a deletion, fix the consumer — never re-export the deleted symbol as a shim.
3. **Do not use `kind: "run"` for the gate ops.** `run` opens an LLM session. Gates are deterministic — they call filesystem / test-runner functions. If a deterministic op kind doesn't exist, ask the user before adding one.
4. **Do not return `status: "disabled"` from full-suite-gate.** That value caused the production regression where rectification-disabled TDD runs halted before the verifier. Use `status: "failed-no-rectification"` and let `phasePassed` continue.
5. **Do not migrate tests by weakening assertions.** If a behavior test fails after porting, the production code is wrong, not the test. Investigate.
6. **Do not add prompt-builder functions outside `src/prompts/builders/`.** Project convention — see `.claude/rules/forbidden-patterns.md`.
7. **Run the AC#6/AC#7/AC#9 greps frequently.** They're the definitive "is this done?" signal. Run after every deletion task.
