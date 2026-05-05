# Patch Plan — Bug 1 (`totalCost: 0` despite ~$6 spent on completion-phase work)

> Single PR that makes the run-completion reporting consult the existing `runtime.costAggregator` and back-fill `storyMetrics` for stories whose only spend is in the completion phase (acceptance / hardening / diagnosis / fix-cycle).
>
> **Surprise finding during investigation**: the cost-aggregation infrastructure is already fully built and wired — `CostAggregator` exists, `attachCostSubscriber` is wired in `createRuntime`, and the dispatch bus already carries `estimatedCostUsd` / `exactCostUsd` for every agent call. The completion-phase reporting just never reads from it. The fix is "consume what we already accumulate", not "build a new pipeline".

**Linked**: [2026-05-05-context-curator-v0-dogfood-findings.md](./2026-05-05-context-curator-v0-dogfood-findings.md) → Bug 1

---

## What's already in place (good news)

| Component | Location | Status |
|:---|:---|:---|
| `DispatchEvent.estimatedCostUsd` / `.exactCostUsd` | [`src/runtime/dispatch-events.ts:27`](../../src/runtime/dispatch-events.ts) | ✅ populated by both `runAsSession` ([`manager.ts:614`](../../src/agents/manager.ts)) and `completeAs` ([`manager.ts:619`](../../src/agents/manager.ts)) for every agent call |
| `CostAggregator` (full accumulator with stage/story/agent breakdowns) | [`src/runtime/cost-aggregator.ts:124`](../../src/runtime/cost-aggregator.ts) | ✅ implements `record/snapshot/byAgent/byStage/byStory` |
| `attachCostSubscriber` (wires bus → aggregator) | [`src/runtime/middleware/cost.ts:4`](../../src/runtime/middleware/cost.ts) | ✅ subscribes to `bus.onDispatch` and `bus.onDispatchError` |
| `createRuntime` wires both at run start | [`src/runtime/index.ts:141,198,218`](../../src/runtime/index.ts) | ✅ `runtime.costAggregator` is exposed on the public NaxRuntime API |
| `costAggregator.drain()` flushes to disk at run end | [`src/runtime/index.ts:236`](../../src/runtime/index.ts) | ✅ already drained on cleanup |

## What's broken

Nobody at the reporting layer reads `costAggregator.snapshot()`. The chain that produces `totalCost` for the run-complete log line:

```
unifiedExecutor.totalCost ─→ runnerExecution.totalCost ─→ options.totalCost ─→ handleRunCompletion(totalCost)
```

This chain only counts what the **execution phase** added (story-level TDD/test-after/rectification/review). It misses:

- Acceptance refinement (per-story `complete` calls)
- Acceptance test_fix / source_fix cycles (the giant turns — `cycleResult.costUsd` is always 0; explicit TODO at [`acceptance-loop.ts:453-456`](../../src/execution/lifecycle/acceptance-loop.ts))
- Acceptance diagnosis (slow LLM path)
- Hardening pass (no cost field on `runHardeningPass` return; no `cost?:` populated in `acceptanceStage.execute`)

But the cost aggregator already saw all of these — every one of them dispatched through `agentManager.completeAs` / `runAsSession`, which emits `DispatchEvent` with cost. The aggregator recorded them. We just don't ask.

---

## Scope

### In

- `src/execution/lifecycle/run-completion.ts` — read `runtime.costAggregator.snapshot()` as the source of truth for `totalCost`; back-fill `allStoryMetrics` from `costAggregator.byStory()` for stories whose only spend is in the completion phase
- `src/execution/runner.ts` (and/or `runner-completion.ts`) — pass `runtime` into `handleRunCompletion` (already passes; verify access to `costAggregator`)
- `src/execution/lifecycle/acceptance-loop.ts` — remove the obsolete TODO comment at lines 453-456 (the gap is closed by the aggregator); leave the `+= cycleResult.costUsd ?? 0` line for compatibility, but it's now redundant
- `src/execution/unified-executor.ts` — cost-budget enforcement (`if (totalCost >= costLimit)`) consults aggregator snapshot at decision points so it can't be silently bypassed
- Tests: see [Test plan](#test-plan)

### Out (separate PRs / not needed)

- **Surface cost from `callOp`** (the original "Quaternary" option in dogfood-findings.md) — not needed once the aggregator is the SSOT. Filed as F1 if a future cost-aware op needs explicit per-call cost.
- **Per-strategy cost extraction in `acceptance/fix-cycle.ts`** — same: not needed; the aggregator already sees this. Filed as F2 if granular cost-per-strategy reporting is wanted later.
- **Hardening pass cost return** — same: not needed at the function boundary. The aggregator captures it.
- **Plugin/external-API surface for `costAggregator.snapshot()`** — useful but a separate enhancement.

---

## Change set

### 1. `src/execution/lifecycle/run-completion.ts` — consult the aggregator

#### 1a. Compute the dispatch-bus total alongside the legacy `totalCost`

```diff
   // … existing regression-gate back-fill block …

+  // Bug 1 fix — consult the cost aggregator for the authoritative spend total.
+  // Every agent call dispatched through AgentManager emits a DispatchEvent with
+  // estimatedCostUsd/exactCostUsd, captured by attachCostSubscriber into runtime.costAggregator.
+  // The legacy `totalCost` only counts execution-phase work and silently drops
+  // acceptance/hardening/diagnosis/fix-cycle spend.
+  const aggSnap = options.runtime.costAggregator.snapshot();
+  const aggregatorTotal = aggSnap.totalCostUsd;
+  const reportedTotal = Math.max(totalCost, aggregatorTotal);
+
+  if (aggregatorTotal > totalCost + 0.01) {
+    // > 1¢ gap means a known/unknown sub-system isn't bubbling cost up.
+    // Log so we can find new gaps as they appear.
+    logger?.debug("run.complete", "Cost aggregator total exceeds accumulated totalCost", {
+      totalCost,
+      aggregatorTotal,
+      gap: aggregatorTotal - totalCost,
+    });
+  }
+
+  const aggByStage = options.runtime.costAggregator.byStage();
+  const aggByStory = options.runtime.costAggregator.byStory();
```

#### 1b. Use `reportedTotal` everywhere `totalCost` is reported / persisted

Replace `totalCost` with `reportedTotal` in:
- `pipelineEventBus.emit({ type: "run:completed", … totalCost: reportedTotal })` (line ~280)
- `runMetrics.totalCost = reportedTotal` (line ~301)
- `logger.info("run.complete", "Feature execution completed", { … totalCost: reportedTotal, costByStage: aggByStage, costByStory: aggByStory })` (line ~359)
- `statusWriter.update(reportedTotal, iterations)` (line ~378)

Add `costByStage` and `costByStory` to the run-complete log so the breakdown is observable in the JSONL without re-reading the audit dir.

#### 1c. Back-fill `storyMetrics` for completion-phase-only stories

Same pattern as the existing `regressionStoryCosts` back-fill at [`run-completion.ts:208-269`](../../src/execution/lifecycle/run-completion.ts), but driven by the aggregator's per-story snapshot:

```ts
// After existing regression back-fill block:
const existingIndex = new Map(allStoryMetrics.map((m, i) => [m.storyId, i]));
const completionPhaseOnly = Object.entries(aggByStory).filter(
  ([storyId]) => !existingIndex.has(storyId),
);

const defaultAgent = options.agentManager?.getDefault() ?? resolveDefaultAgent(config);
const rectCompletedAt = new Date().toISOString();

for (const [storyId, snap] of completionPhaseOnly) {
  if (snap.totalCostUsd <= 0) continue;
  const story = prd.userStories.find((s) => s.id === storyId);
  allStoryMetrics.push({
    storyId,
    complexity: story?.routing?.complexity ?? "medium",
    modelTier: "balanced",
    modelUsed: defaultAgent,
    attempts: 0,                               // execution-phase had nothing to do
    finalTier: "balanced",
    success: story?.passes ?? true,
    cost: snap.totalCostUsd,
    durationMs: 0,                             // aggregator doesn't track per-story duration today
    firstPassSuccess: story?.passes ?? true,
    completedAt: rectCompletedAt,
    source: "completion-phase",                // new field, optional, helps diagnose
  } as StoryMetrics);
}

// Also fold in completion-phase spend for stories that DO have an existing entry
// (e.g. regenerated suggestedCriteria for a story that already passed execution).
for (const [storyId, snap] of Object.entries(aggByStory)) {
  const idx = existingIndex.get(storyId);
  if (idx === undefined) continue;
  // Subtract execution-phase cost we already counted to avoid double-add.
  const existingCost = allStoryMetrics[idx].cost ?? 0;
  if (snap.totalCostUsd > existingCost) {
    allStoryMetrics[idx] = {
      ...allStoryMetrics[idx],
      cost: snap.totalCostUsd,                 // aggregator is authoritative
    };
  }
}
```

**Subtraction caveat**: The aggregator's `byStory` total is the TRUE total for that story across all phases. So we **replace** the existing per-story cost rather than adding. If `aggByStory[storyId] < existingCost`, that means execution-phase reported more than the aggregator saw — keep the larger value (existing path).

### 2. `src/execution/unified-executor.ts` — cost-limit checks consult the aggregator

Four call sites today (`unified-executor.ts:367,387,473,530`) use the local `totalCost` for limit enforcement. They become silently unenforceable for completion-phase work because the local counter undercounts. Tighten:

```diff
+  const enforcedTotal = (() => {
+    const local = totalCost;
+    const fromBus = ctx.runtime.costAggregator.snapshot().totalCostUsd;
+    return Math.max(local, fromBus);
+  })();
-  if (totalCost >= costLimit) {
+  if (enforcedTotal >= costLimit) {
```

Apply at all four sites. The `enforcedTotal` is computed at decision time so it always reflects the latest dispatch events. Keep `totalCost` for emitted-event payloads (so existing consumers keep working) but switch the comparison.

### 3. `src/execution/lifecycle/acceptance-loop.ts` — clean up the now-obsolete TODO

```diff
     // ── 5. Run acceptance fix cycle ────────────────────────────────────
     const cycleResult = await runAcceptanceFixCycle(ctx, prd, failures, diagnosis, testFileContent, acceptanceTestPath);
-    // @design Cost telemetry gap: FixApplied.costUsd is not yet populated by strategies
-    // because callOp does not surface agent cost in its return type. The plumbing
-    // (FixCycleResult.costUsd + acceptance-loop accumulation) is in place; once
-    // strategies extract cost from op output, the totalCost will reflect fix cycle spend.
+    // Cost is captured at the dispatch-bus layer (runtime.costAggregator); the local
+    // accumulation here is best-effort and may undercount. The authoritative total
+    // is reconciled in handleRunCompletion via Math.max(local, aggregator).
     totalCost += cycleResult.costUsd ?? 0;
```

The local `+= cycleResult.costUsd` line stays — for forward compatibility if strategies eventually populate it, and to keep `runAcceptanceLoop`'s internal `totalCost` reasonably close to truth for log lines emitted before run-completion. The comment update reflects current architectural reality.

---

## Test plan

### Unit — `handleRunCompletion` reads the aggregator

`test/unit/execution/lifecycle/run-completion.test.ts` *(extend)*:

```ts
test("handleRunCompletion reports max(legacyTotalCost, aggregatorTotal) (Bug 1 regression)", async () => {
  const mockAggregator = makeMockCostAggregator({
    snapshot: () => ({ totalCostUsd: 6.21, totalEstimatedCostUsd: 6.21, /* … */ }),
    byStory: () => ({ "US-001": { totalCostUsd: 2.71, /* … */ } }),
    byStage: () => ({ acceptance: { totalCostUsd: 5.42, /* … */ } }),
  });
  const runtime = makeMockRuntime({ costAggregator: mockAggregator });
  const logCalls = captureLogger();
  await handleRunCompletion({ /* … */ totalCost: 0, runtime });

  const completeEvent = logCalls.find((c) => c.message === "Feature execution completed");
  expect(completeEvent?.data?.totalCost).toBeCloseTo(6.21, 2);
  expect(completeEvent?.data?.costByStage).toEqual({ acceptance: expect.objectContaining({ totalCostUsd: 5.42 }) });
});

test("handleRunCompletion logs gap when aggregator > legacyTotalCost (telemetry hint)", async () => {
  // … assert debug log "Cost aggregator total exceeds accumulated totalCost" with gap > 0.01
});

test("handleRunCompletion back-fills storyMetrics for completion-phase-only stories", async () => {
  const mockAggregator = makeMockCostAggregator({
    byStory: () => ({
      "US-001": { totalCostUsd: 2.71, /* … */ },
      "US-007": { totalCostUsd: 0.10, /* … */ },
    }),
    snapshot: () => ({ totalCostUsd: 2.81, /* … */ }),
  });
  const runtime = makeMockRuntime({ costAggregator: mockAggregator });
  const allStoryMetrics: StoryMetrics[] = [];   // execution phase had nothing for these stories
  await handleRunCompletion({ /* … */ totalCost: 0, allStoryMetrics, runtime, prd });

  expect(allStoryMetrics).toHaveLength(2);
  expect(allStoryMetrics.find((m) => m.storyId === "US-001")?.cost).toBeCloseTo(2.71, 2);
  expect(allStoryMetrics.find((m) => m.storyId === "US-007")?.cost).toBeCloseTo(0.10, 2);
});

test("handleRunCompletion does not double-count when execution-phase already reported cost", async () => {
  const mockAggregator = makeMockCostAggregator({
    byStory: () => ({ "US-001": { totalCostUsd: 3.50, /* … */ } }),
    snapshot: () => ({ totalCostUsd: 3.50 /* … */ }),
  });
  const runtime = makeMockRuntime({ costAggregator: mockAggregator });
  // Execution phase already reported $1.00 for US-001
  const existingMetrics: StoryMetrics[] = [{ storyId: "US-001", cost: 1.00, /* … */ }];
  await handleRunCompletion({ /* … */ totalCost: 1.00, allStoryMetrics: existingMetrics, runtime, prd });

  // Aggregator says US-001 actually spent $3.50 total — replace, don't sum
  expect(existingMetrics[0].cost).toBeCloseTo(3.50, 2);
});
```

### Unit — cost-limit enforcement uses aggregator

`test/unit/execution/unified-executor.test.ts` *(extend)*:

```ts
test("cost-limit enforcement consults aggregator (Bug 1)", async () => {
  // Simulate: local totalCost stuck at $0 (e.g. acceptance not bubbling), aggregator at $5
  const mockAggregator = makeMockCostAggregator({
    snapshot: () => ({ totalCostUsd: 5.00, /* … */ }),
  });
  const ctx = makeExecutorCtx({
    config: makeNaxConfig({ execution: { costLimit: 4.50 } }),
    runtime: makeMockRuntime({ costAggregator: mockAggregator }),
  });
  // … run executeUnified with localTotalCost = 0
  // Assert the loop terminates with reason "Cost limit reached" — not silently continues
});
```

### Integration — re-run scenario (the original symptom)

`test/integration/execution/rerun-cost-reporting.test.ts` *(new)*:

```ts
test("re-run with all stories complete still reports total cost from completion-phase work", async () => {
  // Setup a fixture where:
  //   - prd.userStories all status=passed
  //   - acceptance loop runs, fires N mock LLM calls totalling $0.50
  // Run the runner end-to-end
  // Assert run.complete log line has totalCost ≈ 0.50, not 0
  // Assert runMetrics.json on disk has totalCost ≈ 0.50
  // Assert allStoryMetrics has entries for stories that only had completion-phase activity
});
```

### Manual verification

Re-run a feature with `status: "completed"` and at least one acceptance retry (e.g. delete one AC's test from `.nax-acceptance.test.ts` to force a test-fix turn). Confirm:

- `runs/<latest>.jsonl` final `run.complete` entry has `totalCost > 0`
- The reported `totalCost` matches the sum of `complete() cost` log entries within ±$0.05
- `costByStage` breakdown includes `acceptance` with the expected magnitude
- `storyMetrics` has entries for stories that only had completion-phase activity

---

## Risk assessment

| Change | Risk | Mitigation |
|---|---|---|
| Use `Math.max(local, aggregator)` for reported total | Aggregator over-counts due to a buggy event in the future | Log the gap when > 1¢ so we can find ingestion bugs; aggregator already has audit trail in `cost/` dir |
| Replace per-story cost with aggregator value | Edge case where execution-phase legitimately had cost the aggregator missed | Use `Math.max` per-story too, not raw replacement |
| Back-fill `storyMetrics` for completion-phase-only stories | Adds entries downstream consumers don't expect | New `source: "completion-phase"` discriminator field; consumers filtering by `attempts > 0` already exclude these correctly |
| Cost-limit enforcement uses aggregator | Aggregator-reported cost stops a run earlier than today | This is the intended fix — today's enforcement is silently bypassed. Document in CHANGELOG. |
| Reading `runtime.costAggregator` everywhere | Test mocks must provide a working aggregator | Existing `createNoOpCostAggregator()` already does this; update test helpers to use it by default |

---

## Backward compatibility

- **No public API changes.** `NaxRuntime.costAggregator` is already public per [`src/runtime/index.ts:93`](../../src/runtime/index.ts).
- **`StoryMetrics` gains optional `source?: "execution" | "completion-phase" | "regression"` field** — opt-in metadata; consumers ignoring it are unaffected.
- **Reported `totalCost` increases on re-runs that had completion-phase spend.** Document in CHANGELOG: "Cost reporting now includes acceptance / hardening / diagnosis spend that was previously dropped." Users who set `costLimit` against the old undercount may see runs hit the limit sooner — intended.
- **No config schema changes.**
- **No plugin contract changes.**

---

## Acceptance checklist

- [ ] `bun run typecheck` clean
- [ ] `bun run lint` clean
- [ ] `bun run test` clean (full suite)
- [ ] New unit tests for `handleRunCompletion` aggregator consultation (4 cases: max-of-two, gap-log, back-fill, no-double-count)
- [ ] New unit test for `unified-executor` cost-limit using aggregator
- [ ] New integration test for re-run with completion-phase-only spend
- [ ] Removed obsolete TODO comment in `acceptance-loop.ts`
- [ ] CHANGELOG entry: "fix(runtime): completion-phase agent calls (acceptance / hardening / diagnosis / fix-cycle) now correctly counted in run totalCost"
- [ ] Manual verification on a re-run: `totalCost > 0`, breakdown visible, storyMetrics back-filled

---

## Commit plan

1. `fix(run-completion): consult costAggregator.snapshot for authoritative totalCost`
2. `feat(run-completion): emit costByStage and costByStory in run.complete log`
3. `feat(run-completion): back-fill storyMetrics for completion-phase-only stories from costAggregator.byStory`
4. `fix(unified-executor): cost-limit enforcement consults aggregator at decision points`
5. `chore(acceptance-loop): update obsolete cost-telemetry TODO comment`
6. `test(execution): regression coverage for Bug 1 (aggregator-driven cost reporting)`

PR title: `fix(runtime): include completion-phase agent calls in run totalCost reporting`

---

## Follow-ups (separate PRs)

- **F1** — Surface cost from `callOp` return type (the original "Quaternary" option). Useful for explicit cost-aware code paths (e.g. budget-aware op chaining inside a single stage). Not needed for Bug 1; aggregator covers it.
- **F2** — Per-strategy cost extraction in `acceptance/fix-cycle.ts` so per-iteration log lines have meaningful `cycleResult.costUsd`. Currently always 0.
- **F3** — Surface aggregator data in TUI / metrics dashboard (`src/tui/components/CostOverlay.tsx` already has the field — wire it to `runtime.costAggregator.snapshot()` rather than reconstructing from `storyMetrics`).
- **F4** — Plugin API `IPostRunAction` could expose `costAggregator.snapshot()` so plugins like the curator can use cost as an H-heuristic signal.
