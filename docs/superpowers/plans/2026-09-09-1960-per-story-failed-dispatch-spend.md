# Per-Story and Per-Phase Failed-Dispatch Spend (#1960) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make per-story and per-phase cost mean total spend (successful + failed-dispatch), with the failed half carried beside it, so `sum(stories[].cost) == RunMetrics.totalCost` stays exact once failed dispatches start carrying usage.

**Architecture:** PR #1959 did this at run level: `RunMetrics.totalCost = totalSpendUsd(snap)` with a sibling `errorCostUsd` spread only when `> 0`. This plan applies the identical shape one level down — to `StoryMetrics`, the `story:*` events, `phaseCosts`, the debate scope totals and `FixApplied` — via a single new reader, `storySpendUsd`, so the eight near-identical `byStory()[id]?.totalCostUsd ?? ctx.totalCost` expressions collapse to one seam instead of being edited eight times.

**Tech Stack:** TypeScript, Bun (test runner + build), nax internal `CostAggregator` / `pipelineEventBus`.

**Spec:** https://github.com/nathapp-io/nax/issues/1960 (revised 2026-09-09; the "Sites still on `totalCostUsd`", "The exclusion is concentrated on failure paths" and "The `?? ctx.totalCost` fallback is dead" sections are the requirements this plan implements).

**Base:** branch `worktree-fix-1960-per-story-error-spend`, worktree `.claude/worktrees/fix-1960-per-story-error-spend`, cut from `origin/main` `d11c2b0b6` (the #1959 merge). Baseline suite green before any change: 1153 pass / 36 skip / 0 fail (integration) plus 98 pass / 0 fail (ui), all phases passed.

## Global Constraints

- **Doctrine (from #1959 and `cost-aggregator.ts:190-199`): fold AND keep the sibling.** Every migrated number becomes `totalSpendUsd(snap)`; every migrated carrier gains an `errorCostUsd` sibling spread **only when `> 0`**, so its presence always means a dispatch actually threw. A sum cannot be un-summed — never drop the split.
- **Fallback semantics must not change.** `?? ctx.totalCost` currently fires only when `byStory()` has **no entry at all** for the story. Preserve exactly that: fall back when the snapshot is `undefined`, never when it exists with `totalCostUsd === 0`.
- **File-size gate: 600 lines for `src/`, 800 for `test/`, ratcheted by `bun run check:file-sizes` (part of `bun run lint`).** Headroom on files this plan touches: `execution-plan.ts` **600 — ZERO headroom, Task 6 must extract before it adds**; `tracker.ts` 598 (2 lines); `tier-escalation.ts` 595 (5); `cost-aggregator.ts` 542 (58); `run-phase.ts` 501; `pipeline-result-handler.ts` 479; `completion.ts` 414; `event-bus.ts` 392; `debate/runner.ts` 383; `metrics/types.ts` 381; `backfill-story-metrics.ts` 254; `tier-outcome.ts` 150; `cycle-cost.ts` 78.
- **Do not add tests to these grandfathered test files — they may not grow:** `test/unit/execution/story-orchestrator.test.ts` (1998), `test/unit/execution/escalation/tier-escalation.test.ts` (1025), `test/unit/findings/cycle.test.ts` (933), `test/unit/debate/runner-plan.test.ts` (1038). Create new focused test files instead.
- **`bun run test:coverage` is NOT part of `bun run test` or `check:all`.** Run it once at the end (Task 9) — this plan adds one new `src/` file (`run-summary.ts`, Task 6).
- Quality commands (from `.nax/config.json`): `bun run test`, `bun run typecheck`, `bun run lint`, `bun run build`. Scoped: `CI=1 AGENT=1 bun test --timeout=60000 <files>`.
- **Out of scope, do not touch:** `costDelta` in `pipeline-result-handler.ts:180` (`agentResult.estimatedCostUsd + stageCost`) — an independent executor accumulator feeding a log line and `ctx.totalCost`, not the metrics identity. Folding error spend there too would double-count.
- No emojis in code, comments or commit messages. Conventional commits (`fix:`, `feat:`, `refactor:`, `test:`, `docs:`).
- **Test-fixture completeness:** Tasks 1, 3, 4, 8 and 9 carry complete, runnable test bodies. Tasks 2, 5, 6 and 7 give complete **assertions** but require you to build the surrounding context/harness by reading the named existing test file first (`tracker-provider-cost.test.ts`, `story-orchestrator.test.ts`, `runner.test.ts`). Those harnesses are large and repo-specific; copy their real shape rather than inventing fields — a fabricated context is the most likely way to waste a cycle here.

---

### Task 1: The `storySpendUsd` seam

The one reader all eight failure/pause sites and the two tracker sites will use. It fixes the dead-fallback bug in the same stroke: today an error-only story has a snapshot whose `totalCostUsd` is `0`, so `??` never fires and the site reports `cost: 0`.

**Files:**
- Modify: `src/runtime/cost-aggregator.ts` (add beside `totalSpendUsd`, currently ending at `:202`)
- Modify: `src/runtime/index.ts:32` (export it)
- Test: `test/unit/runtime/story-spend.test.ts` (new)

**Interfaces:**
- Consumes: `ICostAggregator.byStory()`, `totalSpendUsd`, `CostSnapshot` — all existing.
- Produces: `storySpendUsd(costAggregator: ICostAggregator | undefined, storyId: string, fallbackUsd: number): StorySpend` where `interface StorySpend { cost: number; errorCostUsd: number }`. Tasks 2, 3 and 4 all call this.

- [ ] **Step 1: Write the failing test**

Create `test/unit/runtime/story-spend.test.ts`:

```ts
/**
 * #1960 — per-story spend reader.
 *
 * `storySpendUsd` is the single seam the story:failed / story:paused /
 * story:completed emitters and the metrics tracker read through, so the
 * fallback rule and the fold live in exactly one place.
 */

import { describe, expect, test } from "bun:test";
import { CostAggregator, type CostErrorEvent, type CostEvent, storySpendUsd } from "@/runtime/cost-aggregator";

function makeCostEvent(overrides: Partial<CostEvent> = {}): CostEvent {
  return {
    ts: Date.now(),
    runId: "r-001",
    agentName: "claude",
    model: "claude-sonnet-4-6",
    tokens: { input: 100, output: 50 },
    estimatedCostUsd: 0.001,
    exactCostUsd: 0.001,
    costUsd: 0.001,
    confidence: "estimated",
    durationMs: 500,
    ...overrides,
  };
}

function makeErrorEvent(overrides: Partial<CostErrorEvent> = {}): CostErrorEvent {
  return {
    kind: "error",
    ts: Date.now(),
    runId: "r-001",
    agentName: "claude",
    errorCode: "DISPATCH_ERROR",
    durationMs: 50,
    ...overrides,
  };
}

describe("storySpendUsd", () => {
  test("folds failed-dispatch spend into cost and carries it beside", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    agg.record(makeCostEvent({ storyId: "US-001", costUsd: 0.02 }));
    agg.recordError(makeErrorEvent({ storyId: "US-001", costUsd: 0.005 }));

    expect(storySpendUsd(agg, "US-001", 99)).toEqual({ cost: 0.025, errorCostUsd: 0.005 });
  });

  test("an error-only story reports its failed spend, not zero and not the fallback", () => {
    // The regression #1960 exists to close: the error row creates the byStory
    // key, so `?.totalCostUsd ?? fallback` yielded 0 -- worse than the fallback
    // the same story got before failed dispatches were priced.
    const agg = new CostAggregator("r-001", "/tmp/drain");
    agg.recordError(makeErrorEvent({ storyId: "US-002", costUsd: 0.007 }));

    expect(storySpendUsd(agg, "US-002", 42)).toEqual({ cost: 0.007, errorCostUsd: 0.007 });
  });

  test("falls back only when the story has no rows at all", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    agg.record(makeCostEvent({ storyId: "US-001", costUsd: 0.02 }));

    expect(storySpendUsd(agg, "US-404", 1.5)).toEqual({ cost: 1.5, errorCostUsd: 0 });
  });

  test("an unpriced error row leaves cost at the successful spend", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    agg.record(makeCostEvent({ storyId: "US-003", costUsd: 0.01 }));
    agg.recordError(makeErrorEvent({ storyId: "US-003" }));

    expect(storySpendUsd(agg, "US-003", 7)).toEqual({ cost: 0.01, errorCostUsd: 0 });
  });

  test("tolerates an absent aggregator", () => {
    expect(storySpendUsd(undefined, "US-001", 3.25)).toEqual({ cost: 3.25, errorCostUsd: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/runtime/story-spend.test.ts`
Expected: FAIL — `storySpendUsd` is not exported from `@/runtime/cost-aggregator`.

- [ ] **Step 3: Implement**

In `src/runtime/cost-aggregator.ts`, immediately after the `totalSpendUsd` function:

```ts
/** Both halves of one story's spend. Mirrors `RunMetrics.totalCost` / `errorCostUsd`. */
export interface StorySpend {
  /** Every dollar the story accounted for — successful spend plus failed-dispatch spend. */
  cost: number;
  /** The failed half of `cost`. Zero when nothing threw; callers omit the field at zero. */
  errorCostUsd: number;
}

/**
 * Read one story's spend out of the aggregator, folding failed-dispatch spend in.
 *
 * `fallbackUsd` is returned ONLY when the story has no rows at all. This is the
 * distinction #1960 turns on: an error row creates the `byStory()` key, so the
 * pre-#1960 `?.totalCostUsd ?? fallback` saw a snapshot whose successful total
 * was 0, never fired the fallback, and reported `cost: 0` for a story that had
 * burned real money. Pricing failed dispatches made that number strictly worse;
 * reading through here is what fixes it.
 */
export function storySpendUsd(
  costAggregator: ICostAggregator | undefined,
  storyId: string,
  fallbackUsd: number,
): StorySpend {
  const snap = costAggregator?.byStory()[storyId];
  if (snap === undefined) return { cost: fallbackUsd, errorCostUsd: 0 };
  return { cost: totalSpendUsd(snap), errorCostUsd: snap.totalErrorCostUsd };
}
```

In `src/runtime/index.ts:32`, extend the existing export:

```ts
export {
  _costAggDeps,
  CostAggregator,
  createNoOpCostAggregator,
  type StorySpend,
  storySpendUsd,
  totalSpendUsd,
} from "./cost-aggregator";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/runtime/story-spend.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/cost-aggregator.ts src/runtime/index.ts test/unit/runtime/story-spend.test.ts
git commit -m "feat(cost): add storySpendUsd, the per-story spend seam (#1960)"
```

---

### Task 2: `StoryMetrics` carries total spend

**Files:**
- Modify: `src/metrics/types.ts:153-154` (the `cost` doc plus a new sibling field)
- Modify: `src/metrics/tracker.ts:314, 327` (`collectStoryMetrics`) and `:374` (`collectBatchMetrics`)
- Test: `test/unit/metrics/tracker-story-spend.test.ts` (new — `tracker-provider-cost.test.ts` exists but covers a different concern)

**Interfaces:**
- Consumes: `storySpendUsd` from Task 1.
- Produces: `StoryMetrics.errorCostUsd?: number`. Tasks 4 and 9 rely on this field name.

> Headroom warning: `tracker.ts` is at 598/600. The edits below are line-neutral at `:327` and add at most 1 line at `:374`, landing at 599. Do not add anything else to this file.

- [ ] **Step 1: Write the failing test**

Create `test/unit/metrics/tracker-story-spend.test.ts`. Build the `PipelineContext` the same way `test/unit/metrics/tracker-provider-cost.test.ts` does, injecting a real `CostAggregator` via `makeMockRuntime({ costAggregator })`:

```ts
/**
 * #1960 — StoryMetrics.cost is total spend, with the failed half beside it.
 */

import { describe, expect, test } from "bun:test";
import { makeMockRuntime } from "@test/helpers";
import { CostAggregator } from "@/runtime/cost-aggregator";
import { collectStoryMetrics } from "@/metrics/tracker";

function seedAggregator(): CostAggregator {
  const agg = new CostAggregator("r-001", "/tmp/drain");
  agg.record({
    ts: Date.now(),
    runId: "r-001",
    agentName: "claude",
    model: "m",
    tokens: { input: 10, output: 5 },
    estimatedCostUsd: 0.02,
    exactCostUsd: 0.02,
    costUsd: 0.02,
    confidence: "estimated",
    durationMs: 10,
    storyId: "US-001",
  });
  agg.recordError({
    kind: "error",
    ts: Date.now(),
    runId: "r-001",
    agentName: "claude",
    errorCode: "DISPATCH_ERROR",
    durationMs: 5,
    storyId: "US-001",
    costUsd: 0.005,
  });
  return agg;
}

describe("StoryMetrics spend shape (#1960)", () => {
  test("cost folds failed-dispatch spend and errorCostUsd carries the failed half", async () => {
    const agg = seedAggregator();
    const runtime = makeMockRuntime({ costAggregator: agg });

    // Guard the seam the tracker reads through, so this fails loudly if
    // byStory stops keying error rows.
    expect(agg.byStory()["US-001"]?.totalCostUsd).toBe(0.02);
    expect(agg.byStory()["US-001"]?.totalErrorCostUsd).toBe(0.005);

    const metric = await collectStoryMetrics(makeCtx({ runtime }), new Date().toISOString());

    expect(metric.cost).toBe(0.025);
    expect(metric.errorCostUsd).toBe(0.005);
  });

  test("errorCostUsd is absent when nothing threw", async () => {
    const agg = new CostAggregator("r-002", "/tmp/drain");
    agg.record({
      ts: Date.now(), runId: "r-002", agentName: "claude", model: "m",
      tokens: { input: 10, output: 5 }, estimatedCostUsd: 0.02, exactCostUsd: 0.02,
      costUsd: 0.02, confidence: "estimated", durationMs: 10, storyId: "US-001",
    });

    const metric = await collectStoryMetrics(
      makeCtx({ runtime: makeMockRuntime({ costAggregator: agg }) }),
      new Date().toISOString(),
    );

    expect(metric.cost).toBe(0.02);
    expect("errorCostUsd" in metric).toBe(false);
  });
});
```

Write the local `makeCtx` helper by copying the context shape `tracker-provider-cost.test.ts` already builds — do not invent fields.

- [ ] **Step 2: Run the test to verify it fails**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/metrics/tracker-story-spend.test.ts`
Expected: FAIL — `metric.cost` is `0.02`, `errorCostUsd` undefined.

- [ ] **Step 3: Implement**

`src/metrics/types.ts` — replace lines 153-154:

```ts
  /** Total spend for this story (all attempts) — successful plus failed-dispatch spend. */
  cost: number;
  /**
   * The failed-dispatch half of `cost` (#1960). Absent when nothing threw, so
   * its presence always means real money went to work that produced nothing.
   */
  errorCostUsd?: number;
```

`src/metrics/tracker.ts` — add `storySpendUsd` to the existing `@/runtime` import, then at `:314`:

```ts
  const costSnapshot = ctx.runtime.costAggregator.byStory()[story.id];
  const spend = storySpendUsd(ctx.runtime.costAggregator, story.id, 0);
```

(`costSnapshot` stays — `tokensFromSnapshot(costSnapshot)` on the next line still needs it.)

In the returned object, replace `:327`:

```ts
    cost: spend.cost,
```

and add, beside the existing conditional spreads at the end of that object:

```ts
    ...(spend.errorCostUsd > 0 ? { errorCostUsd: spend.errorCostUsd } : {}),
```

`collectBatchMetrics` at `:374` — replace:

```ts
  const batchSpend = storySpendUsd(ctx.runtime.costAggregator, ctx.story.id, 0);
  const batchTotal = batchSpend.cost;
  const errorCostPerStory = batchSpend.errorCostUsd / stories.length;
```

and on each produced batch metric, beside `cost: costPerStory`:

```ts
    ...(errorCostPerStory > 0 ? { errorCostUsd: errorCostPerStory } : {}),
```

Leave `tokensFromSnapshot(batchSnapshot, stories.length)` reading `batchSnapshot` unchanged — tokens are separate accounting and error rows carry none.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/metrics/` then `bun run lint`
Expected: PASS; `check:file-sizes` clean (`tracker.ts` at 599 or under).

- [ ] **Step 5: Commit**

```bash
git add src/metrics/types.ts src/metrics/tracker.ts test/unit/metrics/tracker-story-spend.test.ts
git commit -m "fix(metrics): StoryMetrics.cost is total spend, errorCostUsd beside it (#1960)"
```

---

### Task 3: The eight failure and pause emitters

The concentration finding: `story:failed` and `story:paused` are where failed spend lands, and all eight sites currently report successful spend only.

**Files:**
- Modify: `src/pipeline/event-bus.ts` — `StoryFailedEvent` (`:62-73`), `StoryPausedEvent` (`:128-133`)
- Modify: `src/execution/pipeline-result-handler.ts:128, 360, 408`
- Modify: `src/execution/escalation/tier-outcome.ts:54, 79, 120, 146`
- Modify: `src/execution/escalation/tier-escalation.ts:310`
- Test: `test/unit/execution/story-failure-spend.test.ts` (new — do NOT add to `tier-escalation.test.ts`, grandfathered at 1025)

**Interfaces:**
- Consumes: `storySpendUsd` (Task 1).
- Produces: `StoryFailedEvent.errorCostUsd?: number`, `StoryPausedEvent.errorCostUsd?: number`. Task 9 forwards these.

> Headroom warning: `tier-escalation.ts` is at 595/600. Its single site adds 1 line (596). Do not add anything else there.

- [ ] **Step 1: Write the failing test**

Create `test/unit/execution/story-failure-spend.test.ts`:

```ts
/**
 * #1960 — story:failed and story:paused report total spend.
 *
 * These eight sites are the concentration finding: they fire exactly where
 * failed-dispatch spend lands, and pre-#1960 they reported successful spend
 * only -- reporting 0 for a story whose every dispatch threw, because the
 * error row created the byStory key and killed the `?? ctx.totalCost` fallback.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeMockRuntime, makePRD, makeStory, makeTempDir } from "@test/helpers";
import type { EscalationHandlerContext } from "@/execution/escalation";
import { handleMaxAttemptsReached, handleNoTierAvailable } from "@/execution/escalation";
import { pipelineEventBus } from "@/pipeline/event-bus";
import { CostAggregator } from "@/runtime/cost-aggregator";

function errorOnlyAggregator(): CostAggregator {
  const agg = new CostAggregator("r-001", "/tmp/drain");
  agg.recordError({
    kind: "error",
    ts: Date.now(),
    runId: "r-001",
    agentName: "claude",
    errorCode: "DISPATCH_ERROR",
    durationMs: 5,
    storyId: "US-001",
    costUsd: 0.004,
  });
  return agg;
}

function successOnlyAggregator(): CostAggregator {
  const agg = new CostAggregator("r-002", "/tmp/drain");
  agg.record({
    ts: Date.now(),
    runId: "r-002",
    agentName: "claude",
    model: "m",
    tokens: { input: 10, output: 5 },
    estimatedCostUsd: 0.02,
    exactCostUsd: 0.02,
    costUsd: 0.02,
    confidence: "estimated",
    durationMs: 10,
    storyId: "US-001",
  });
  return agg;
}

/** Mirrors makeCtx in test/unit/execution/escalation/tier-outcome.test.ts. */
function makeCtx(agg: CostAggregator, prdPath: string): EscalationHandlerContext {
  const story = makeStory({ id: "US-001", status: "in-progress" });
  const prd = makePRD({ userStories: [story] });
  return {
    story,
    storiesToExecute: [story],
    isBatchExecution: false,
    routing: { modelTier: "fast", testStrategy: "test-after" },
    pipelineResult: { reason: "Rectification exhausted", context: {} },
    config: {} as EscalationHandlerContext["config"],
    prd,
    prdPath,
    featureDir: undefined,
    hooks: { hooks: {} } as EscalationHandlerContext["hooks"],
    feature: "f",
    // 99 is a sentinel: if the fallback fires when it must not, the assertion
    // below reports 99 instead of the story's real failed spend.
    totalCost: 99,
    workdir: "/tmp",
    runtime: makeMockRuntime({ costAggregator: agg }),
  } as EscalationHandlerContext;
}

function capture(type: "story:failed" | "story:paused") {
  const seen: Array<{ cost?: number; errorCostUsd?: number }> = [];
  const unsub = pipelineEventBus.on(type, (ev) => {
    seen.push({ cost: ev.cost, errorCostUsd: ev.errorCostUsd });
  });
  return { seen, unsub };
}

describe("failure-path spend (#1960)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-story-failure-spend-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("story:failed reports failed-dispatch spend for a story that only threw", async () => {
    const { seen, unsub } = capture("story:failed");
    await handleMaxAttemptsReached(makeCtx(errorOnlyAggregator(), join(tempDir, "prd.json")), "verifier-rejected");
    unsub();

    expect(seen[0]?.cost).toBe(0.004);
    expect(seen[0]?.errorCostUsd).toBe(0.004);
  });

  test("story:failed omits errorCostUsd when nothing threw", async () => {
    const { seen, unsub } = capture("story:failed");
    await handleMaxAttemptsReached(makeCtx(successOnlyAggregator(), join(tempDir, "prd.json")), "verifier-rejected");
    unsub();

    expect(seen[0]?.cost).toBe(0.02);
    expect(seen[0]?.errorCostUsd).toBeUndefined();
  });

  test("story:paused reports total spend too", async () => {
    const { seen, unsub } = capture("story:paused");
    await handleNoTierAvailable(makeCtx(errorOnlyAggregator(), join(tempDir, "prd.json")), "verifier-rejected");
    unsub();

    expect(seen[0]?.cost).toBe(0.004);
    expect(seen[0]?.errorCostUsd).toBe(0.004);
  });
});
```

If `handleMaxAttemptsReached` / `handleNoTierAvailable` take the pause branch rather than the fail branch for `"verifier-rejected"` in this repo's current `resolveMaxAttemptsOutcome`, swap which handler each test calls — assert on the event the handler actually emits. `tier-outcome.test.ts` shows which is which for the current ruleset.

- [ ] **Step 2: Run the test to verify it fails**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/execution/story-failure-spend.test.ts`
Expected: FAIL — `cost` is `0` (the dead-fallback bug) and `errorCostUsd` is undefined.

- [ ] **Step 3: Implement**

`src/pipeline/event-bus.ts` — in `StoryFailedEvent`, replace the `cost` doc block:

```ts
  /** Total spend across all attempts for this story — successful plus failed-dispatch spend. */
  cost?: number;
  /** The failed-dispatch half of `cost` (#1960). Absent when nothing threw. */
  errorCostUsd?: number;
```

and in `StoryPausedEvent`:

```ts
  /** Total spend for this story — successful plus failed-dispatch spend. */
  cost: number;
  /** The failed-dispatch half of `cost` (#1960). Absent when nothing threw. */
  errorCostUsd?: number;
```

At each of the eight sites, replace the inline expression. In `pipeline-result-handler.ts` (`ctx.runtime` is non-optional there):

```ts
  const spend = storySpendUsd(ctx.runtime.costAggregator, ctx.story.id, ctx.totalCost);
  pipelineEventBus.emit({
    type: "story:failed",
    // ... unchanged fields ...
    cost: spend.cost,
    ...(spend.errorCostUsd > 0 ? { errorCostUsd: spend.errorCostUsd } : {}),
  });
```

In `tier-outcome.ts` (`ctx.runtime` is optional — the helper accepts `undefined`):

```ts
  const spend = storySpendUsd(ctx.runtime?.costAggregator, ctx.story.id, ctx.totalCost);
```

In `tier-escalation.ts:310` the identifiers are bare:

```ts
  const spend = storySpendUsd(runtime?.costAggregator, story.id, totalCost);
```

Declare `spend` immediately above each `pipelineEventBus.emit` call, never once at function top — two `tier-outcome.ts` functions emit on both a pause and a fail branch, and a shared binding would read the aggregator at the wrong moment.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/execution/` then `bun run lint`
Expected: PASS; file sizes clean.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/event-bus.ts src/execution/pipeline-result-handler.ts src/execution/escalation/tier-outcome.ts src/execution/escalation/tier-escalation.ts test/unit/execution/story-failure-spend.test.ts
git commit -m "fix(execution): story:failed and story:paused report total spend (#1960)"
```

---

### Task 4: The success path and the back-fill

**Files:**
- Modify: `src/pipeline/event-bus.ts` — `StoryCompletedEvent` (`:51-61`)
- Modify: `src/pipeline/stages/completion.ts:68, 143, 177`
- Modify: `src/execution/lifecycle/backfill-story-metrics.ts:28-45, 78, 103, 123, 196, 218, 236, 250-251`
- Test: `test/unit/execution/lifecycle/backfill-story-spend.test.ts` (new)

**Interfaces:**
- Consumes: `StoryMetrics.errorCostUsd` (Task 2), `storySpendUsd` (Task 1).
- Produces: `BackfillMetricArgs.errorCostUsd: number`; `applyBackfill`'s `aggByStory` widened to `Record<string, { totalCostUsd: number; totalErrorCostUsd: number }>`.

**Ruling implemented here (user, 2026-09-09):** error-only spend **does** count as back-fill evidence — a story whose every dispatch threw gets a synthesized metric rather than vanishing. This only ever adds rows: `backfillDomain` already contains these story ids (their key exists in `aggByStory`); the evidence gate was the only thing dropping them.

- [ ] **Step 1: Write the failing test**

Create `test/unit/execution/lifecycle/backfill-story-spend.test.ts`:

```ts
/**
 * #1960 — the back-fill sees total spend, so a story that burned only
 * failed-dispatch money still gets a metric row.
 */

import { describe, expect, test } from "bun:test";
import { applyBackfill, hasBackfillEvidence } from "@/execution/lifecycle/backfill-story-metrics";

type BackfillInput = Parameters<typeof applyBackfill>[0];

function baseInput(overrides: Partial<BackfillInput>): BackfillInput {
  return {
    allStoryMetrics: [],
    aggByStory: {},
    stories: [],
    agentFallbacks: new Map(),
    runtimeCrashRetries: new Map(),
    config: { models: {} } as BackfillInput["config"],
    defaultAgent: "claude",
    ...overrides,
  } as BackfillInput;
}

describe("back-fill evidence includes failed-dispatch spend (#1960)", () => {
  test("a story whose only spend threw now has evidence", () => {
    expect(hasBackfillEvidence({ costUsd: 0.004, hopCount: 0, crashCount: 0, story: undefined })).toBe(true);
  });

  test("applyBackfill synthesizes a row for an error-only story", () => {
    const allStoryMetrics: BackfillInput["allStoryMetrics"] = [];
    applyBackfill(
      baseInput({ allStoryMetrics, aggByStory: { "US-009": { totalCostUsd: 0, totalErrorCostUsd: 0.004 } } }),
    );

    expect(allStoryMetrics).toHaveLength(1);
    expect(allStoryMetrics[0].storyId).toBe("US-009");
    expect(allStoryMetrics[0].cost).toBe(0.004);
    expect(allStoryMetrics[0].errorCostUsd).toBe(0.004);
  });

  test("the replacement rule compares total spend, not successful spend", () => {
    const allStoryMetrics = [{ storyId: "US-001", cost: 0.01 } as BackfillInput["allStoryMetrics"][number]];
    applyBackfill(
      baseInput({ allStoryMetrics, aggByStory: { "US-001": { totalCostUsd: 0.008, totalErrorCostUsd: 0.005 } } }),
    );

    // 0.013 total spend beats the recorded 0.01, even though successful spend alone (0.008) does not.
    expect(allStoryMetrics[0].cost).toBeCloseTo(0.013, 10);
    expect(allStoryMetrics[0].errorCostUsd).toBe(0.005);
  });

  test("a clean story's metric carries no errorCostUsd field", () => {
    const allStoryMetrics: BackfillInput["allStoryMetrics"] = [];
    applyBackfill(
      baseInput({ allStoryMetrics, aggByStory: { "US-002": { totalCostUsd: 0.02, totalErrorCostUsd: 0 } } }),
    );

    expect("errorCostUsd" in allStoryMetrics[0]).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/execution/lifecycle/backfill-story-spend.test.ts`
Expected: FAIL — no row synthesized for `US-009`, and the replacement rule does not fire.

- [ ] **Step 3: Implement**

`src/execution/lifecycle/backfill-story-metrics.ts`:

- `BackfillMetricArgs` — change the `totalCostUsd` doc to say **total spend for this story (successful plus failed-dispatch)**, keeping the existing "may be 0" note, and add:

```ts
  /** The failed-dispatch half of `totalCostUsd` (#1960). Omitted from the metric when zero. */
  errorCostUsd: number;
```

- `synthesizeBackfillMetric` — destructure `errorCostUsd` from `args` and, in **both** returned objects (the execution-failure branch at `:103` and the completion-phase branch at `:123`), add beside `cost: totalCostUsd`:

```ts
      ...(errorCostUsd > 0 ? { errorCostUsd } : {}),
```

- `applyBackfill` input type at `:196`:

```ts
  aggByStory: Record<string, { totalCostUsd: number; totalErrorCostUsd: number }>;
```

- the loop body at `:218`:

```ts
    const snap = aggByStory[storyId];
    const errorCostUsd = snap?.totalErrorCostUsd ?? 0;
    const totalCostUsd = (snap?.totalCostUsd ?? 0) + errorCostUsd;
```

`totalCostUsd` keeps its name so the rest of the function and `BackfillMetricArgs` stay untouched; its meaning is now total spend, which the renamed doc states.

- pass `errorCostUsd` into the `synthesizeBackfillMetric({ ... })` call at `:236`.

- the replacement rule at `:250-251`:

```ts
    if (totalCostUsd > (existing.cost ?? 0)) {
      allStoryMetrics[existingIdx] = {
        ...existing,
        cost: totalCostUsd,
        ...(errorCostUsd > 0 ? { errorCostUsd } : {}),
      };
    }
```

`src/pipeline/event-bus.ts` — `StoryCompletedEvent` gains, beside `cost?: number`:

```ts
  /** The failed-dispatch half of `cost` (#1960). Absent when nothing threw. */
  errorCostUsd?: number;
```

`src/pipeline/stages/completion.ts:68`:

```ts
    const sessionSpend = storySpendUsd(ctx.runtime.costAggregator, ctx.story.id, 0);
    const sessionCost = sessionSpend.cost;
```

at `:143`, beside `costPerStory`:

```ts
      const errorCostPerStory = sessionSpend.errorCostUsd / ctx.stories.length;
```

and on the `story:completed` emit at `:177`:

```ts
          cost: costPerStory,
          ...(errorCostPerStory > 0 ? { errorCostUsd: errorCostPerStory } : {}),
```

Leave the `progress.txt` line at `:157` reading `costPerStory` — it now prints total spend, which is the intended meaning.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/execution/lifecycle/ test/unit/pipeline/` then `bun run typecheck`
Expected: PASS. `run-completion.ts` needs no change — it already passes the raw `byStory()` snapshot map into `applyBackfill`, which satisfies the widened type.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/event-bus.ts src/pipeline/stages/completion.ts src/execution/lifecycle/backfill-story-metrics.ts test/unit/execution/lifecycle/backfill-story-spend.test.ts
git commit -m "fix(execution): story:completed and the back-fill read total spend (#1960)"
```

---

### Task 5: Phase costs

`run-phase.ts:336` is the number `cycle-cost.ts` cites; Task 8 moves that rationale with it.

**Files:**
- Modify: `src/pipeline/event-bus.ts` — `StoryPhaseCompletedEvent` (`:167-178`)
- Modify: `src/execution/story-orchestrator/run-phase.ts:334-354`
- Test: `test/unit/execution/story-orchestrator/phase-spend.test.ts` (new — do NOT add to `story-orchestrator.test.ts`, grandfathered at 1998)

**Interfaces:**
- Consumes: `totalSpendUsd` (existing). Verified: `CostScopeHandle.snapshot()` runs scope-matching error rows through `accumulateError` (`cost-aggregator.ts:471-477`) and `CostErrorEvent` carries `scopeId`, so a scope snapshot's `totalErrorCostUsd` is meaningful — this task is not a no-op.
- Produces: `StoryPhaseCompletedEvent.errorCostUsd?: number`; a `phaseErrorCosts: Record<string, number>` accumulator threaded alongside `phaseCosts`, consumed by Task 6.

- [ ] **Step 1: Write the failing test**

Create `test/unit/execution/story-orchestrator/phase-spend.test.ts`. Drive the orchestrator through the same entry point `story-orchestrator.test.ts` uses, with an injected `CostAggregator`, and assert:

```ts
    // A phase whose scope recorded a priced error row folds it into costUsd
    // and names it beside.
    expect(phaseEvent.costUsd).toBe(0.025);
    expect(phaseEvent.errorCostUsd).toBe(0.005);
```

plus a clean-phase case asserting `errorCostUsd` is undefined.

- [ ] **Step 2: Run the test to verify it fails**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/execution/story-orchestrator/phase-spend.test.ts`
Expected: FAIL — `costUsd` excludes the error row; `errorCostUsd` undefined.

- [ ] **Step 3: Implement**

`src/pipeline/event-bus.ts` — in `StoryPhaseCompletedEvent`:

```ts
  /** Total spend for this phase — successful plus failed-dispatch spend. */
  costUsd: number;
  /** The failed-dispatch half of `costUsd` (#1960). Absent when nothing threw. */
  errorCostUsd?: number;
```

`src/execution/story-orchestrator/run-phase.ts` — in the `finally` block at `:334`:

```ts
    const snapshot = scope.snapshot();
    const phaseSpend = totalSpendUsd(snapshot);
    phaseCosts[opName] = (phaseCosts[opName] ?? 0) + phaseSpend;
    phaseErrorCosts[opName] = (phaseErrorCosts[opName] ?? 0) + snapshot.totalErrorCostUsd;
```

and in the emitted event at `:353`:

```ts
        costUsd: phaseSpend,
        ...(snapshot.totalErrorCostUsd > 0 ? { errorCostUsd: snapshot.totalErrorCostUsd } : {}),
```

Thread `phaseErrorCosts` in alongside the existing `phaseCosts` parameter — same shape, same lifetime, same owner. Import `totalSpendUsd` from `@/runtime`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/execution/story-orchestrator/` then `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/event-bus.ts src/execution/story-orchestrator/run-phase.ts test/unit/execution/story-orchestrator/phase-spend.test.ts
git commit -m "fix(orchestrator): phaseCosts and story:phase:completed report total spend (#1960)"
```

---

### Task 6: The derived orchestrator rollup (extraction first)

`execution-plan.ts` is at **exactly 600 lines with zero headroom**. Steps 1-3 extract before Step 6 adds — do them in that order or `bun run lint` fails on the ratchet.

**Files:**
- Create: `src/execution/story-orchestrator/run-summary.ts`
- Modify: `src/execution/story-orchestrator/execution-plan.ts:536-570`
- Modify: `src/execution/story-orchestrator/types.ts:53-60` (`StoryOrchestratorResult`)
- Test: `test/unit/execution/story-orchestrator/run-summary.test.ts` (new)

**Interfaces:**
- Consumes: `phaseCosts`, `phaseErrorCosts` (Task 5).
- Produces: `buildOrchestratorSummary(input): Record<string, unknown>` in `run-summary.ts`; `StoryOrchestratorResult.phaseErrorCosts` and `.errorCostUsd?`.

- [ ] **Step 1: Extract the summary builder (pure refactor, no behavior change)**

Move the `summary` construction — from `const failedPhases = [` through the `missingRequiredReviewPhases` block, stopping just before the `if (success)` logger call — into `src/execution/story-orchestrator/run-summary.ts`:

```ts
export function buildOrchestratorSummary(input: {
  storyId: string;
  success: boolean;
  totalCostUsd: number;
  errorCostUsd: number;
  durationMs: number;
  phaseOutputs: Record<string, unknown>;
  failedPhaseEntries: string[];
  verifierPassedSsot: boolean;
  gateName: string;
  phasePassed: (name: string, output: unknown, storyId: string) => boolean;
  rectResult: {
    rectificationExhausted?: boolean;
    repoScopedFixes?: Array<{ triggeringTests: string[]; filesChanged: string[]; findingsCleared: number }>;
    unfixedFindings?: unknown[];
  };
  missingRequiredReviewPhases: string[];
  upstreamShortCircuited: boolean;
  shortCircuitPhase: string | undefined;
}): Record<string, unknown>;
```

Call it from `execution-plan.ts`, keeping the `logger?.info` / `logger?.warn` branch in place. Do not add `errorCostUsd` to the summary yet — that is Step 6.

- [ ] **Step 2: Run the full suite and the size gate to verify the extraction changed nothing**

Run: `bun run test` then `bun run lint`
Expected: PASS, and `check:file-sizes` reports `execution-plan.ts` comfortably under 600.

- [ ] **Step 3: Commit the extraction on its own**

```bash
git add src/execution/story-orchestrator/run-summary.ts src/execution/story-orchestrator/execution-plan.ts
git commit -m "refactor(orchestrator): extract buildOrchestratorSummary to make room under the size gate"
```

- [ ] **Step 4: Write the failing test**

Create `test/unit/execution/story-orchestrator/run-summary.test.ts` asserting that `StoryOrchestratorResult.totalCostUsd` equals `sum(phaseCosts)` (now spend), that `errorCostUsd` equals `sum(phaseErrorCosts)`, and that `errorCostUsd` is absent when every phase was clean.

- [ ] **Step 5: Run the test to verify it fails**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/execution/story-orchestrator/run-summary.test.ts`
Expected: FAIL — no `errorCostUsd` on the result.

- [ ] **Step 6: Implement**

`src/execution/story-orchestrator/types.ts`, in `StoryOrchestratorResult`:

```ts
  readonly phaseCosts: Record<string, number>;
  /** Per-phase failed-dispatch spend (#1960). Same keys as `phaseCosts`. */
  readonly phaseErrorCosts: Record<string, number>;
  /** Total spend across phases — successful plus failed-dispatch spend. */
  readonly totalCostUsd: number;
  /** The failed-dispatch half of `totalCostUsd` (#1960). Absent when nothing threw. */
  readonly errorCostUsd?: number;
```

`src/execution/story-orchestrator/execution-plan.ts:536`:

```ts
    const totalCostUsd = Object.values(phaseCosts).reduce((sum, cost) => sum + cost, 0);
    const errorCostUsd = Object.values(phaseErrorCosts).reduce((sum, cost) => sum + cost, 0);
```

pass `errorCostUsd` into `buildOrchestratorSummary`, have that function spread `...(errorCostUsd > 0 ? { errorCostUsd } : {})` into the summary object, and add to the returned result:

```ts
      phaseErrorCosts,
      ...(errorCostUsd > 0 ? { errorCostUsd } : {}),
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun run test` then `bun run lint` then `bun run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/execution/story-orchestrator/types.ts src/execution/story-orchestrator/execution-plan.ts src/execution/story-orchestrator/run-summary.ts test/unit/execution/story-orchestrator/run-summary.test.ts
git commit -m "fix(orchestrator): StoryOrchestratorResult carries failed-dispatch spend (#1960)"
```

---

### Task 7: Debate scope totals

The site-list correction: `debate/runner.ts` reads scope snapshots, unlike its siblings in `src/debate/`, which are local accumulators.

**Files:**
- Modify: `src/debate/runner.ts:91, 147-150`
- Modify: `src/debate/types.ts:172` (doc only)
- Test: `test/unit/debate/runner-spend.test.ts` (new)

**Interfaces:**
- Consumes: `totalSpendUsd` (existing).
- Produces: no new fields — `DebateResult.totalCostUsd` changes meaning to total spend.

- [ ] **Step 1: Write the failing test**

Create `test/unit/debate/runner-spend.test.ts`, modelled on the harness in `test/unit/debate/runner.test.ts`, asserting that a debate whose debater scope recorded a priced error row reports it in `totalCostUsd`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/debate/runner-spend.test.ts`
Expected: FAIL — the error row's spend is dropped.

- [ ] **Step 3: Implement**

`src/debate/runner.ts:91`:

```ts
      return {
        ...result,
        totalCostUsd: totalSpendUsd(debaterScope.snapshot()) + totalSpendUsd(resolverScope.snapshot()),
      };
```

and `:147-150`:

```ts
      const scopeTotal = (): number =>
        totalSpendUsd(prePhaseScope.snapshot()) +
        totalSpendUsd(debaterScope.snapshot()) +
        totalSpendUsd(resolverScope.snapshot()) +
        totalSpendUsd(verifierScope.snapshot());
```

Import `totalSpendUsd` from `@/runtime`. In `src/debate/types.ts:172`, update the field doc to: "Total spend across the debate's scopes — successful plus failed-dispatch spend (#1960)."

- [ ] **Step 4: Run the tests to verify they pass**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/debate/` then `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/debate/runner.ts src/debate/types.ts test/unit/debate/runner-spend.test.ts
git commit -m "fix(debate): scope totals report total spend (#1960)"
```

---

### Task 8: Re-read the #1948 fix-cycle ruling

`cycle-cost.ts:41-45` justifies excluding failed spend from `FixApplied.costUsd` **by pointing at `phaseCosts`**. Task 5 moved `phaseCosts`, so the rationale must move with it or the two numbers beside each other mean different things again — the exact failure that comment exists to prevent.

**Files:**
- Modify: `src/findings/cycle-cost.ts:35-60` (the doc block) and `:67`
- Modify: `src/findings/cycle-types.ts:34-57` (the `costUsd` / `errorCostUsd` docs)
- Modify: `src/findings/cycle-dispatch.ts:102-104`
- Test: `test/unit/findings/cycle-cost.test.ts` (existing, not grandfathered — extend it)

**Interfaces:**
- Consumes: `totalSpendUsd`, `ICostAggregator.byCall()` (both existing). `ledgerSpendFor`'s signature is unchanged.
- Produces: `FixApplied.costUsd` now means total spend; `FixApplied.errorCostUsd` stays the sibling added by #1958, unchanged.

- [ ] **Step 1: Write the failing test**

Extend `test/unit/findings/cycle-cost.test.ts` using its existing context helper:

```ts
  test("#1960: costUsd folds failed-dispatch spend, mirroring phaseCosts", () => {
    // cycle-cost.ts pins its meaning to runPhase's phaseCosts. #1960 folded
    // phaseCosts, so this folds too -- the fix-cycle number must never mean
    // something different from the phase number beside it.
    const spend = ledgerSpendFor(ctxWithLedger({ costUsd: 0.02, errorCostUsd: 0.005 }), "call-1");

    expect(spend.costUsd).toBe(0.025);
    expect(spend.errorCostUsd).toBe(0.005);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/findings/cycle-cost.test.ts`
Expected: FAIL — `costUsd` is `0.02`.

- [ ] **Step 3: Implement**

`src/findings/cycle-cost.ts:67`:

```ts
    const snap = ctx.runtime.costAggregator.byCall()[callId];
    if (snap === undefined) return { costUsd: 0, errorCostUsd: 0 };
    return { costUsd: totalSpendUsd(snap), errorCostUsd: snap.totalErrorCostUsd };
```

Replace the first bullet of the doc block at `:41-45` with:

```
 * - `costUsd` is total spend -- successful plus failed-dispatch -- mirroring
 *   `runPhase`'s `phaseCosts`, so the fix-cycle number never means something
 *   different from the phase number beside it. #1960 folded `phaseCosts`, and
 *   this moved with it deliberately, reversing #1948's original
 *   split-at-the-fix-cycle reading. Every run total that consumes it
 *   (`acceptance-loop`, `run-regression`) is re-based by exactly the failed
 *   spend, which was zero on every run recorded before this change.
```

Update `src/findings/cycle-types.ts:34-45` (`costUsd`) to say total spend and cite #1960, and trim the `errorCostUsd` doc at `:47-57` so it no longer gives "folding would re-base every run total" as a reason not to fold — it now describes a sibling that survives the fold, exactly like `RunMetrics.errorCostUsd`.

`src/findings/cycle-dispatch.ts:102-104` — the `extractApplied.costUsd` override must not lose the failed half:

```ts
    // A strategy that reports its own cost knows what its successful call
    // billed, not what the attempts that threw before it burned -- so the
    // ledger's failed half is added on top of an override rather than replaced.
    // `spend.costUsd` already includes that half, so the non-override branch
    // needs no addition.
    costUsd: extracted.costUsd !== undefined ? extracted.costUsd + spend.errorCostUsd : spend.costUsd,
    ...(spend.errorCostUsd > 0 ? { errorCostUsd: spend.errorCostUsd } : {}),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/findings/` then `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/findings/cycle-cost.ts src/findings/cycle-types.ts src/findings/cycle-dispatch.ts test/unit/findings/cycle-cost.test.ts
git commit -m "fix(findings): fix-cycle costUsd folds failed spend, tracking phaseCosts (#1960)"
```

---

### Task 9: Consumers, and the reconciliation guard

The regression test that would have caught this whole class, plus the two surfaces that drop the line item.

**Files:**
- Modify: `src/pipeline/subscribers/reporters.ts:160, 259`
- Modify: `src/plugins/types.ts` (`onRunEnd` / `onStoryComplete` payload types)
- Modify: `src/cli/status-cost.ts:93`
- Test: `test/unit/execution/lifecycle/run-metrics-reconcile.test.ts` (new)

**Interfaces:**
- Consumes: everything above.
- Produces: the invariant `sum(stories[].cost) === RunMetrics.totalCost`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/execution/lifecycle/run-metrics-reconcile.test.ts`:

```ts
/**
 * #1960 — the invariant this issue exists to protect.
 *
 * Measured on 2026-09-09: the last 93 consecutive recorded runs satisfy
 * `totalCost == sum(stories[].cost)` to the cent. This test is what keeps
 * that true once failed dispatches carry usage.
 */

import { describe, expect, test } from "bun:test";
import { applyBackfill } from "@/execution/lifecycle/backfill-story-metrics";
import { CostAggregator, totalSpendUsd } from "@/runtime/cost-aggregator";

describe("run metrics reconcile (#1960)", () => {
  test("sum(stories[].cost) equals the run total when dispatches threw with billed usage", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    // US-001 succeeded; US-002 burned only failed spend.
    agg.record({
      ts: Date.now(), runId: "r-001", agentName: "claude", model: "m",
      tokens: { input: 10, output: 5 }, estimatedCostUsd: 0.02, exactCostUsd: 0.02,
      costUsd: 0.02, confidence: "estimated", durationMs: 10, storyId: "US-001",
    });
    agg.recordError({
      kind: "error", ts: Date.now(), runId: "r-001", agentName: "claude",
      errorCode: "DISPATCH_ERROR", durationMs: 5, storyId: "US-002", costUsd: 0.004,
    });

    type BackfillInput = Parameters<typeof applyBackfill>[0];
    const allStoryMetrics: BackfillInput["allStoryMetrics"] = [];
    applyBackfill({
      allStoryMetrics,
      aggByStory: agg.byStory(),
      stories: [],
      agentFallbacks: new Map(),
      runtimeCrashRetries: new Map(),
      config: { models: {} } as BackfillInput["config"],
      defaultAgent: "claude",
    } as BackfillInput);

    const runTotal = totalSpendUsd(agg.snapshot());
    const storySum = allStoryMetrics.reduce((sum, m) => sum + m.cost, 0);

    expect(runTotal).toBeCloseTo(0.024, 10);
    expect(storySum).toBeCloseTo(runTotal, 10);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/execution/lifecycle/run-metrics-reconcile.test.ts`
Expected: PASS if Tasks 1-4 landed correctly. If it fails, the residual it reports is the bug — fix the code, never weaken the test.

- [ ] **Step 3: Implement the consumer forwarding**

`src/pipeline/subscribers/reporters.ts:259` — the `run:completed` event already carries `errorCostUsd` (`event-bus.ts:97`); stop dropping it:

```ts
                totalCost: ev.totalCost ?? 0,
                ...(ev.errorCostUsd !== undefined ? { errorCostUsd: ev.errorCostUsd } : {}),
```

and at `:160` for `onStoryComplete`:

```ts
                cost: ev.cost ?? 0,
                ...(ev.errorCostUsd !== undefined ? { errorCostUsd: ev.errorCostUsd } : {}),
```

Add the matching optional `errorCostUsd?: number` to both payload types in `src/plugins/types.ts`.

`src/cli/status-cost.ts:93` — beside `totalCost: lastRun.totalCost`:

```ts
    ...(lastRun.errorCostUsd !== undefined ? { errorCostUsd: lastRun.errorCostUsd } : {}),
```

so `nax status --cost` names the failed half instead of leaving it inside an unexplained total.

- [ ] **Step 4: Run the full gate**

```bash
bun run test && bun run typecheck && bun run lint && bun run build && bun run test:coverage
```

Expected: all green. `test:coverage` runs here because Task 6 added `src/execution/story-orchestrator/run-summary.ts` and coverage is not part of `bun run test` or `check:all`.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/subscribers/reporters.ts src/plugins/types.ts src/cli/status-cost.ts test/unit/execution/lifecycle/run-metrics-reconcile.test.ts
git commit -m "fix(reporters): forward errorCostUsd and guard the story/run reconciliation (#1960)"
```

---

## Manual verification before opening the PR

The unit suite cannot observe the real symptom, because `totalErrorCostUsd` is 0 on every run recorded so far (938 ledgers, 18,002 rows, 104 error rows, 0 priced). Do this instead:

1. Re-run the issue's reproduction script and confirm the counts are unchanged — this change must not create priced error rows on its own.
2. Reconcile the recorded history: for the last run in `~/.nax/nax/metrics.json`, confirm `totalCost == sum(stories[].cost)` still holds exactly. With `totalErrorCostUsd == 0` everywhere, this change must be a no-op on all historical data.
3. Confirm no `errorCostUsd` field appears anywhere in a fresh run's `metrics.json`. At zero failed spend every new field is omitted, so a clean run's artifacts must be shape-identical to a pre-change run.

## PR notes to write

- State plainly that Task 8 **reverses part of #1948's stated rationale**: `FixApplied.costUsd` now folds failed spend because `phaseCosts` does. The re-base is exactly $0 across all recorded history, but the reasoning changed, and reviewers of #1948 should see that called out rather than discover it in a diff.
- Note the back-fill behavior change: stories whose only spend threw now get a synthesized metric row. This adds rows, never removes them.
- Link the issue's Verification section for the measurements the reconciliation test encodes.
