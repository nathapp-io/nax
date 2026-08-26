# SPEC: Give the story-metrics back-fill a domain that covers every story that ran

## Summary

The story-metrics back-fill in `src/execution/lifecycle/run-completion.ts:367` iterates the **cost
aggregator's** keys and skips any story whose total is not greater than zero. Two classes of story are
therefore absent from `metrics.json` entirely — not a row missing a field, no row at all: a story that
failed having spent nothing, and a sibling of a failed batch, whose spend was attributed to the batch's
lead and which consequently has no aggregator key of its own.

This spec replaces the loop's domain with the union of every signal that evidences execution, and skips
only when all of them are empty.

## Motivation

Issue #1721, which subsumes issue #1714 — both are the same two lines, and fixing #1714's guard without
#1721's domain would leave batch siblings row-less and require rewriting the same loop twice.

Cost is being used as a proxy for "something happened worth recording", and for the fields the back-fill
exists to carry, that proxy fails. A swap hop and a crash retry are both evidence of something that can
cost nothing. The case that bites is the one #1709 set out to make reachable: `deriveRunFallbackAggregates`'
exhausted rule (`src/metrics/aggregator.ts:243`) requires `!story.success`, so a fallback chain that
exhausts because every candidate fails auth instantly records its hops in `runtime.agentFallbacks`, fails
the story, and spends $0 — and the guard drops it, leaving that rule as unreachable as it was before.

The batch hole is wider. A batch is one agent session over N stories: `promptStage` builds one prompt from
`ctx.stories` and `callOp` runs once with `ctx.storyId` set to the lead, so `CostAggregator.byStory()`
files all of the batch's spend under the lead's key. On the success path that is harmless —
`collectBatchMetrics` (`src/metrics/tracker.ts:362`) emits a row per story regardless of the key. On the
failure path `handlePipelineFailure` pushes no `StoryMetrics` at all, so failed stories depend on this
back-fill, and a sibling that has no aggregator key is never visited. Batching is on by default, so this
is a live path.

Evidence for the zero-cost case is a real `nax run` on the `fallback-probe` fixture: a run report with
`storiesFailed: 1` and an empty `stories` array. The batch case was traced by reading rather than by a
live run, and its blast radius is bounded somewhere between "every failed batch" and "only batches whose
siblings exhaust retries or whose run stops first"; the retry path can give a lead its own key, and
`selectNextStories` can re-pick a sibling. This spec does not depend on which end of that range is true —
the row should exist either way.

## Design

### Widening the domain, not relaxing the guard

The guard's real purpose — do not synthesize metrics for stories that genuinely did nothing — is worth
keeping. What is wrong is that the loop can only ever consider stories the aggregator knows about. The
domain becomes the union of four sources:

- the cost aggregator's keys, as today;
- the keys of `runtime.agentFallbacks` (`src/runtime/index.ts:151`);
- the keys of `runtime.runtimeCrashRetries` (`src/runtime/index.ts:165`);
- the PRD's own stories that terminated as an execution failure.

and a story is skipped only when its cost is not positive **and** it has no hops **and** it has no crash
retries **and** it did not terminate as an execution failure. A story that was never selected — `pending`
when a cost limit or iteration cap stopped the run — matches none of the four and is still skipped, which
is why the domain is a union of signals rather than simply `prd.userStories`.

Cost for a newly visited story comes from the aggregator when it has a key and is zero otherwise. The
existing merge branch, which raises an already-present entry's cost to the aggregator's value, is unchanged.

### The predicate the domain needs

`isExecutionFailure` in `src/execution/lifecycle/backfill-story-metrics.ts:50` is the existing definition of
"this story ran and terminated as a failure", but it is module-private and requires `attempts > 0` in
addition to a `failed` / `regression-failed` status. A story that died at session creation carries that
status with zero attempts, so the predicate excludes exactly the case #1714 reports. The `attempts > 0`
requirement is also redundant against the branch it guards, which already computes
`Math.max(1, story.attempts ?? 1)`.

Dropping that requirement and exporting the predicate is the whole of US-001. It moves affected stories
from the completion-phase placeholder — `attempts: 0`, `modelUsed` set to the agent name, no `fallback`
key — onto the execution-failed branch, which reads the story's real routing, escalations and evidence.

`synthesizeBackfillMetric`'s `totalCostUsd` is documented as "already known to be > 0 by the caller"; that
becomes untrue and the contract must say so. No behaviour inside the function depends on the value being
positive.

### What deliberately does not change

The completion-phase branch keeps dropping `fallbackHops` and `runtimeCrashes`. That is a stated invariant
— completion-phase-only spend means nothing executed — and it is pinned by an existing test. Only stories
that terminated as an execution failure move branches, and a `passed` story carrying hops keeps the
placeholder shape it has today.

### Integration

`handleRunCompletion`'s regression back-fill at `src/execution/lifecycle/run-completion.ts:277` is a
separate loop driven by `regressionResult.storyCosts`; it covers only stories the regression gate touched
and is not in scope. Its `existingIndex` map and the one this spec's loop builds are constructed
independently, so widening one does not disturb the other — but the later loop must continue to see
entries the earlier one pushed, which it does because `existingIndex` is rebuilt from `allStoryMetrics`
after the regression block runs.

## Out of Scope

- Re-attributing a batch's cost across its siblings is not addressed. A sibling visited by the widened
  domain records cost `0`, and the batch's full spend stays folded into the lead's row, exactly as today.
  Splitting it would change what `ctx.storyId` means for a batch call and would touch far more than
  metrics; the run total and the per-pair swap-cost aggregates are unaffected by leaving it alone.
- Batch siblings under-counting agent-swap hops is intended behaviour, not a defect, and is not addressed:
  one batch is one session and one swap event, so recording it against each sibling would multiply a single
  event in `totalHops`, `perPair` and `totalWastedCostUsd`, which are the only consumers of the field.
- Having `handlePipelineFailure` push its own `StoryMetrics` rather than deferring to the back-fill is not
  addressed.
- The regression-gate back-fill loop at `src/execution/lifecycle/run-completion.ts:277` and its
  `regressionResult.storyCosts` domain are not addressed.
- The completion-phase branch's dropping of `fallbackHops` and `runtimeCrashes` is not addressed; it stays.
- The `complete()`-path swap records that never reach `runtime.agentFallbacks` at all, and the silent
  `shouldSwap` decline, are issues #1712 and #1713 and have their own spec. This spec improves what happens
  to hops **once recorded**; it does not change what gets recorded.

## Stories

**US-001 — Let a zero-cost failed story reach the execution-failed branch** *(no dependencies)*

Drop the `attempts > 0` requirement from `isExecutionFailure` so a story that terminated as a failure
without recording an attempt is treated as having executed, and export the predicate so the back-fill loop
can use the same definition its synthesis uses. Correct the `totalCostUsd` contract, which currently
asserts the caller has already proved the value positive.

- Context Files: `src/execution/lifecycle/backfill-story-metrics.ts`, `src/metrics/types.ts`, `src/prd/types.ts`, `test/unit/execution/lifecycle/backfill-story-metrics.test.ts`
- The fixture for this story's central criterion is a story with status `failed` and **`attempts: 0`**, which no existing case in that suite uses — every current execution-failure case sets `attempts` to 2 or higher, and the completion-phase invariant case uses a `passed` story. Without the zero-attempts fixture the criterion cannot distinguish the fixed predicate from the current one.

**US-002 — Widen the back-fill loop to every story with evidence of execution** *(depends on US-001)*

Replace the loop's aggregator-keyed domain with the union of the aggregator's keys, the two run-scoped
stores' keys, and the PRD stories that terminated as an execution failure. Skip a story only when its cost
is not positive and it has no hops, no crash retries, and no execution-failure status. Take cost from the
aggregator where a key exists and zero otherwise. Leave the merge branch for already-present entries as is.

- Context Files: `src/execution/lifecycle/run-completion.ts`, `src/execution/lifecycle/backfill-story-metrics.ts`, `src/runtime/index.ts`, `src/metrics/aggregator.ts`, `test/unit/execution/lifecycle/run-completion-backfill-seam.test.ts`
- This story's fixtures configure stories that are **absent from the cost aggregator**, unlike US-001's, which exercise the synthesis function directly with an explicit cost argument.

### Seams

- **US-001 produces the exported execution-failure predicate that US-002's skip rule consumes.** US-002 must
  use that single definition rather than re-testing `status` inline, so the loop's domain and the synthesis
  function's branch selection cannot drift apart — a story admitted by the loop but rejected by the
  predicate would get the completion-phase placeholder it was admitted to avoid. Pinned by US-002 AC-4.
- **US-001 produces the relaxed predicate that US-002's zero-attempt criterion depends on.** With the
  `attempts > 0` requirement still in place, a zero-cost failed story admitted by US-002's widened domain
  would land on the completion-phase branch and lose its hops — so US-002 cannot demonstrate its own fix
  without US-001, which is why it depends on it rather than running beside it.
- **US-002 consumes `runtime.agentFallbacks` and `runtime.runtimeCrashRetries` unchanged.** Both already
  exist and are already read at this call site for cost-bearing stories; US-002 additionally reads their
  key sets.

### Modifies

**US-001**

- `src/execution/lifecycle/backfill-story-metrics.ts` — `isExecutionFailure` must drop its `attempts > 0` requirement and be exported; the `totalCostUsd` contract must stop asserting the caller has proved it positive. The completion-phase branch's dropping of hops and crash retries is an invariant this spec preserves and must not be changed.
- `test/unit/execution/lifecycle/backfill-story-metrics.test.ts` — gains the zero-attempts execution-failure case. This authorisation covers adding cases only; the existing case asserting that completion-phase-only spend carries neither hops nor crash retries states an invariant this spec preserves and must not be weakened or deleted.

**US-002**

- `src/execution/lifecycle/run-completion.ts` — the back-fill loop at the aggregator-keyed `for` must iterate the widened union and skip only when every signal is empty; the regression back-fill loop earlier in the same function is out of scope and must not change.
- `test/unit/execution/lifecycle/run-completion-backfill-seam.test.ts` — gains the zero-cost and aggregator-absent cases. This authorisation covers adding cases only; its existing assertion that a story with no recorded swaps produces no fallback aggregate must not be weakened.

## Acceptance Criteria

### US-001 — Let a zero-cost failed story reach the execution-failed branch

1. `[unit]` `synthesizeBackfillMetric` for a story with status `failed` and `attempts: 0`, given a cost of `0` and one swap hop, returns a metric whose `source` is `execution-failed`, whose `success` is `false`, and whose `fallback.hops` contains that hop.

2. `[unit]` That same metric reports `attempts` of `1` — the branch's existing floor — rather than `0`.

3. `[unit]` `synthesizeBackfillMetric` for a story with status `passed` and `attempts: 0`, given one swap hop and a crash-retry tally of 2, still returns `source` `completion-phase` with no `fallback` key and `runtimeCrashes` of `0`.

4. `[unit]` The exported execution-failure predicate returns `true` for a story with status `failed` and `attempts: 0`, `true` for status `regression-failed`, `false` for status `passed`, `false` for status `pending`, and `false` for an undefined story.

### US-002 — Widen the back-fill loop to every story with evidence of execution

Fixtures for every criterion below build stories that the cost aggregator does not report, unlike US-001's, which pass cost directly to the synthesis function.

1. `[unit]` `handleRunCompletion` for a run whose PRD holds one story with status `failed`, no aggregator entry, and one recorded swap hop in `runtime.agentFallbacks`, produces a run report containing a `StoryMetrics` row for that story whose `fallback.hops` holds that hop.

2. `[unit]` For that same run, the run-level fallback aggregate lists the story in `exhaustedStories` when its last hop's category is `availability` — the rule that requires `!success` is reachable for a story that spent nothing.

3. `[unit]` `handleRunCompletion` for a run whose PRD holds one story with status `failed`, no aggregator entry, no hops and no crash retries — the batch-sibling shape — produces a `StoryMetrics` row for that story with `cost` of `0`.

4. `[unit]` The row produced in AC-3 reports `source` `execution-failed` and `success` `false`, not the completion-phase placeholder — the loop's admission rule and the synthesis function's branch selection agree.

5. `[unit]` `handleRunCompletion` for a run whose PRD holds one story with status `pending`, no aggregator entry, no hops and no crash retries produces **no** `StoryMetrics` row for that story.

6. `[unit]` `handleRunCompletion` for a run with one story present in the aggregator with a positive cost and already present in `allStoryMetrics` leaves exactly one row for that story, with the aggregator's cost — the merge branch is unchanged and the widened domain does not duplicate it.

7. `[unit]` `handleRunCompletion` for a run whose PRD holds one story with status `failed`, no aggregator entry, and a crash-retry tally of 2 in `runtime.runtimeCrashRetries` produces a row for that story reporting `runtimeCrashes` of `2`.
