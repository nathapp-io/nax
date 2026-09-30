# SPEC: Concurrent semantic + adversarial review (`review.adversarial.parallel`)

## Summary

Re-enable `review.adversarial.parallel`. When it is `true` and `review.adversarial.maxConcurrentSessions` is at least 2, the `semantic-review` and `adversarial-review` phases run concurrently instead of one after the other, in the first-pass canonical loop and in the post-rectification revalidation sweep. Behaviour with `parallel: false` (the default) is unchanged. This closes nathapp-io/nax#2302 by re-porting the concurrency that #1084 deleted, adapted to the builder-phase architecture.

## Motivation

`review.adversarial.parallel` and `maxConcurrentSessions` are declared in `src/config/schemas-review.ts` and `src/review/types.ts`, but nothing in `src/` reads them. The consumer (`canParallelize` in `src/review/orchestrator.ts`) was deleted by f38aedf21 (#1084) and never ported to `runCanonicalLoop`. Setting `parallel: true` is accepted and silently has no effect, so operators expecting wall-clock savings per review round get none.

Concurrency is now safe for the fix cycle: `runRectification` already gathers findings from both reviewers into one grouped fix cycle that starts only after both finish. In the canonical loop, concurrency changes when findings arrive, not what the fixer receives. In the revalidation sweep it does change what the fixer receives: today a `semantic-review` failure breaks the sweep before `adversarial-review` is dispatched, so the next fix iteration sees semantic findings only. Under `parallel: true` both reviews run, so the next iteration sees both sets of findings (likely fewer fix rounds) at the price of an adversarial session, and its spend, in rounds where sequential mode would have skipped it. Opting into `parallel: true` accepts that trade-off. Stories in rectification pay the sequential review cost on every fix round, so the sweep is in scope alongside the first pass.

## Design

### Approach

A new module, `src/execution/story-orchestrator/review-pair.ts`, runs the two review phases of one story concurrently by calling the existing `runPhase` for each; `runPhase` is unchanged. The pair waits for both reviews to settle and never cancels one review because its sibling failed. A review runs concurrently only when all three hold: `review.adversarial.parallel` is `true`; `review.adversarial.maxConcurrentSessions` is 2 or more (each review is one session, the debate feature having been removed); and both `semantic-review` and `adversarial-review` are among the phases the caller is about to run. Otherwise sequential behaviour is unchanged, including the #1666 rule that a `semantic-review` failure continues to `adversarial-review` in the canonical loop.

The caller decides which phases it is about to run. `runCanonicalLoop` passes only phases with no passing entry in `phaseOutputs` (its existing resume skip guard). The revalidation sweep has no skip guard and passes every selected review phase. The ADR-024 non-blocking-fix sweep already excludes both reviews (`nonBlockingExcludePhases()`), so it never pairs.

Reviewer sessions are assumed not to write to the working tree. That is a prompt-level contract, not a permission-level one: under the default `unrestricted` profile an ACP reviewer is not sandboxed. Concurrency adds no write path that sequential mode lacks.

### Integration

Symbols this feature **changes** (baselines locate the code and are never the interface to implement):

**`runCanonicalLoop`** — `src/execution/story-orchestrator/execution-plan-phases.ts`
- Baseline: `runCanonicalLoop(plan: PlanParams, tracking: PhaseTracking, orderedPhases: readonly InternalPhase[]): Promise<{ shortCircuitPhase: string | undefined }>` runs every phase strictly in order.
- Target: the same signature and return shape. When `shouldRunReviewsConcurrently` is true at `semantic-review`, the loop dispatches both reviews through `runReviewPair`, skips the separate `adversarial-review` iteration, then applies the per-phase evaluation the sequential loop applies (see Failure Handling).

**The revalidation `validate` closure in `runRectification`** — `src/execution/story-orchestrator/rectification.ts`
- Baseline: iterates the selected phases one at a time and breaks at the first failed phase.
- Target: for each phase it calls `dispatchRevalidationPhase`, skips kinds already dispatched in the sweep, and when the pair ran it pushes findings from both reviewers before it applies its short-circuit break. `rectification.ts` is 597 lines against the 600-line limit, so the review-dispatch step lives in the new sibling module `revalidation-reviews.ts`.

**`review.adversarial.parallel` / `maxConcurrentSessions` comments** — `src/config/schemas-review.ts` and `src/review/types.ts`
- Baseline: the comments say concurrency uses `Promise.all` and is "within cap".
- Target: keys, types and defaults unchanged (`false`, `2`, range 1 to 4). The comments state that reviews run concurrently when `parallel` is `true` and `maxConcurrentSessions >= 2`, and sequentially otherwise.

New symbols (target shape):

```typescript
// src/execution/story-orchestrator/review-pair.ts
export function shouldRunReviewsConcurrently(
  reviewConfig: { adversarial?: { parallel?: boolean; maxConcurrentSessions?: number } } | undefined,
  phases: readonly InternalPhase[], // the phases the CALLER is about to run
): boolean;

export async function runReviewPair(
  ctx: CallContext,
  pair: readonly [InternalPhase, InternalPhase], // [semantic-review, adversarial-review]
  tracking: PhaseTracking,
  isThreeSession?: boolean,
  progress?: { indices: readonly [number, number]; total: number },
): Promise<void>; // results land in tracking.phaseOutputs / phaseCosts via runPhase

export const _reviewPairDeps: { runPhase: typeof runPhase }; // test seam

// src/execution/story-orchestrator/revalidation-reviews.ts
export async function dispatchRevalidationPhase(
  ctx: CallContext,
  phase: InternalPhase,             // the sweep's current phase
  phases: readonly InternalPhase[], // every phase selected for this sweep, in order
  tracking: PhaseTracking,
  isThreeSession?: boolean,
): Promise<readonly PhaseKind[]>;   // the kinds this call dispatched
```

`shouldRunReviewsConcurrently` returns `true` only when `phases` contains both review phases. An unset `maxConcurrentSessions` resolves to the schema default of `2`. The review config is read as `ctx.config?.review ?? ctx.packageView.config.review` (as `nbf-deps.ts` does). `dispatchRevalidationPhase` dispatches `phase` through `runPhase`, except when `phase` is `semantic-review` and `shouldRunReviewsConcurrently` is true for `phases`: then it dispatches the pair through `runReviewPair` and returns `["semantic-review", "adversarial-review"]`.

Symbols this feature reads but does **not** change: `runPhase` (`run-phase.ts`), `phasePassed` (`phase-eval.ts`), `_storyOrchestratorDeps.recordGreen`, `_storyOrchestratorDeps.callOp`, `_storyOrchestratorDeps.runFixCycle`, `STRATEGY_TO_REVALIDATION_PHASES` (`types.ts`), and `gatherRectificationFindings` in `rectification.ts`.

### Failure Handling

- **One review throws while its sibling is in flight:** `runReviewPair` waits for the sibling to settle, then rethrows; if both throw, the `semantic-review` error wins. `runReviewPair` logs "Phase threw unexpected error" once per throwing phase, and `runCanonicalLoop` does not log it again.
- **Flag or cap blocks concurrency:** sequential behaviour, no error.
- **Both reviews fail:** `runCanonicalLoop` returns the `shortCircuitPhase` the sequential loop returns, `adversarial-review`. The sweep collects findings from both reviewers, then short-circuits.
- **Semantic fails, adversarial passes:** `shortCircuitPhase` is `semantic-review`; only `adversarial-review` is recorded green.
- **Semantic passes, adversarial fails:** `shortCircuitPhase` is `adversarial-review`; only `semantic-review` is recorded green.
- **A review throws in the canonical loop:** before the error propagates, `runCanonicalLoop` records green, in canonical order, each review that has a passing entry in `phaseOutputs`, so a throw does not lose the sibling's checkpoint.
- **Story aborted during the fix op:** the existing `ctx.runtime.signal?.aborted` guard at the top of `validate` returns empty findings before either review is dispatched. An already-aborted signal is handled earlier, by the early return in `runRectification`.

Concurrency and atomicity: `phaseOutputs` and `phaseCosts` are keyed by phase name and the reviews use separate iteration maps, so the concurrent writers never share a cell. The skip-guard read happens before dispatch, single-threaded. Green checkpoints are recorded after both reviews settle, sequentially, in canonical order.

## Out of Scope

- Concurrent review inside `runPostRectificationResume`; that loop halts on the first failure and grants one extra rectification pass, and both contracts assume sequential phases.
- Cancelling one review session because its sibling failed or finished first.
- Changing the default of `review.adversarial.parallel` (it stays `false`).
- Removing the `parallel` or `maxConcurrentSessions` keys, or adding deprecation warnings for them.
- Running any phase concurrently other than `semantic-review` with `adversarial-review`.
- Enforcing read-only tool permissions for review sessions under the `unrestricted` permission profile.
- Counting debate debaters toward `maxConcurrentSessions`; the debate feature was removed.
- Any change to how `gatherRectificationFindings` merges or de-duplicates findings from the two reviewers.
- Regrouping or renumbering the interleaved `phaseIndex`/`totalPhases` phase-start log lines that the two concurrent reviews emit.

## Stories

1. **US-001: Review-pair helper and config comments** — no dependencies. Adds `review-pair.ts` and corrects the two config comments to state that reviews run concurrently when `parallel` is `true` and `maxConcurrentSessions >= 2`.
2. **US-002: Canonical loop runs the review pair** — depends on US-001
3. **US-003: Revalidation sweep runs the review pair** — depends on US-001

### Context Files

**US-001**

- `src/execution/story-orchestrator/run-phase.ts` — `runPhase` and `_storyOrchestratorDeps`, the pattern for the `_reviewPairDeps` seam
- `src/execution/story-orchestrator/nbf-deps.ts` — review-config resolution pattern (`ctx.config?.review ?? ctx.packageView.config.review`)
- `src/config/schemas-review.ts` — `parallel` and `maxConcurrentSessions` declarations and comments
- `src/review/types.ts` — the duplicate declaration and comment

**US-002**

- `src/execution/story-orchestrator/execution-plan-phases.ts` — `runCanonicalLoop` and `recordGreenCheckpoint`, the integration point
- `src/execution/story-orchestrator/review-pair.ts` — created by US-001, integrated here
- `src/execution/story-orchestrator/phase-eval.ts` — `phasePassed`

**US-003**

- `src/execution/story-orchestrator/rectification.ts` — the revalidation `validate` closure
- `src/execution/story-orchestrator/review-pair.ts` — created by US-001, integrated here
- `src/execution/story-orchestrator/types.ts` — `STRATEGY_TO_REVALIDATION_PHASES` and phase kinds
- `src/execution/story-orchestrator/phase-eval.ts` — `phasePassed` and `extractPhaseFindings`

### Creates

**US-001**

- `src/execution/story-orchestrator/review-pair.ts` — `shouldRunReviewsConcurrently`, `runReviewPair`, `_reviewPairDeps`

**US-003**

- `src/execution/story-orchestrator/revalidation-reviews.ts` — `dispatchRevalidationPhase`, the review-dispatch step of the sweep extracted from `rectification.ts`

### Modifies

None. This feature edits only source files (`execution-plan-phases.ts`, `rectification.ts`, `schemas-review.ts`, `review/types.ts`); with `review.adversarial.parallel` at its default `false`, both loops run as before, so no existing test pins a closed-world shape this feature changes, and the two config keys keep their types, defaults and ranges.

### Seams

- [integration] US-002: trigger `ExecutionPlan.run()` with `parallel: true` and both review phases configured; replace `_storyOrchestratorDeps.callOp` with deferred promises and assert `callOp` is invoked for both reviews before either promise resolves (the loop reaches the reviews through `runReviewPair`).
- [integration] US-003: trigger `ExecutionPlan.run()` with `parallel: true` and a failing `semantic-review` so rectification runs the `autofix-implementer` strategy; assert during the revalidation sweep that `callOp` is invoked for both review ops before either promise resolves (the sweep reaches them through `dispatchRevalidationPhase`).
- US-003 tests observe `validate` by capturing the `FixCycle` that `_storyOrchestratorDeps.runFixCycle` receives from `runRectification` and calling `cycle.validate(...)`.
- Verification note for US-003: `bun run check:file-sizes` confirms `rectification.ts` and `revalidation-reviews.ts` stay within the 600-line source limit.
- Verification note for US-001: `bun run typecheck` and `bun run lint` cover the comment-only edits to `schemas-review.ts` and `review/types.ts`.

## Acceptance Criteria

### US-001: Review-pair helper and config comments

- [unit] `shouldRunReviewsConcurrently` returns `true` when `review.adversarial.parallel` is `true`, `maxConcurrentSessions` is `2`, and the `phases` argument contains both `semantic-review` and `adversarial-review`.
- [unit] `shouldRunReviewsConcurrently` returns `false` when `review.adversarial.parallel` is `false`, for any `maxConcurrentSessions` value.
- [unit] `shouldRunReviewsConcurrently` returns `false` when `review.adversarial.parallel` is `true` and `maxConcurrentSessions` is `1`.
- [unit] `shouldRunReviewsConcurrently` returns `false` when `reviewConfig` is `undefined`.
- [unit] `shouldRunReviewsConcurrently` returns `false` when `reviewConfig.adversarial` is absent.
- [unit] `shouldRunReviewsConcurrently` returns `true` when `parallel` is `true`, `maxConcurrentSessions` is `undefined` and `phases` contains both review phases (an unset cap resolves to the schema default of `2`).
- [unit] `shouldRunReviewsConcurrently` returns `false` when `phases` contains `semantic-review` but not `adversarial-review`, with `parallel` `true` and `maxConcurrentSessions` `2`.
- [unit] `shouldRunReviewsConcurrently` returns `false` when `phases` contains `adversarial-review` but not `semantic-review`, with `parallel` `true` and `maxConcurrentSessions` `2`.
- [unit] `runReviewPair` calls `_reviewPairDeps.runPhase` for both `semantic-review` and `adversarial-review` before either call's promise resolves.
- [unit] After `runReviewPair` resolves, `tracking.phaseOutputs` holds an entry for `semantic-review` and an entry for `adversarial-review`.
- [unit] After `runReviewPair` resolves, `tracking.phaseCosts` holds each phase's own cost, with neither phase's cost overwriting the other's.
- [unit] When `_reviewPairDeps.runPhase` rejects for `semantic-review` while the `adversarial-review` call is still pending, `runReviewPair` does not settle until the `adversarial-review` call has settled.
- [unit] When `_reviewPairDeps.runPhase` rejects for `semantic-review` and `adversarial-review` succeeds, `runReviewPair` rejects with the `semantic-review` error.
- [unit] When `_reviewPairDeps.runPhase` rejects for both phases, `runReviewPair` rejects with the `semantic-review` error.
- [unit] When `_reviewPairDeps.runPhase` rejects for a phase, `runReviewPair` logs one error "Phase threw unexpected error" with `storyId` as the first key and the throwing `phase` name, once per throwing phase.
- [unit] `runReviewPair` logs one info line "Running semantic-review and adversarial-review concurrently" under the `story-orchestrator` stage, with `storyId` as the first key.

### US-002: Canonical loop runs the review pair

- [integration] `ExecutionPlan.run()` with `review.adversarial.parallel` `true` invokes `_storyOrchestratorDeps.callOp` once for `semantic-review` and once for `adversarial-review`.
- [integration] `ExecutionPlan.run()` with `review.adversarial.parallel` `true` starts the `semantic-review` and `adversarial-review` `callOp` calls before either resolves.
- [integration] `ExecutionPlan.run()` with `review.adversarial.parallel` `true` and `semantic-review` seeded as already passing (resume) invokes `_storyOrchestratorDeps.callOp` once for `adversarial-review`.
- [integration] `ExecutionPlan.run()` with `review.adversarial.parallel` `true` and `semantic-review` seeded as already passing (resume) does not invoke `_storyOrchestratorDeps.callOp` for `semantic-review`.
- [integration] `ExecutionPlan.run()` with `review.adversarial.parallel` `false` dispatches `adversarial-review` only after the `semantic-review` dispatch has resolved.
- [integration] `ExecutionPlan.run()` with `review.adversarial.parallel` `true` and `maxConcurrentSessions` `1` dispatches `adversarial-review` only after the `semantic-review` dispatch has resolved.
- [integration] `runCanonicalLoop` with `parallel` `true`, `semantic-review` failing and `adversarial-review` passing returns `{ shortCircuitPhase: "semantic-review" }`.
- [integration] `runCanonicalLoop` with `parallel` `true`, `semantic-review` failing and `adversarial-review` passing logs the warning "semantic-review failed — continuing to adversarial-review for a second opinion", for parity with sequential mode.
- [integration] `runCanonicalLoop` with `parallel` `true` and both reviews failing returns `{ shortCircuitPhase: "adversarial-review" }`, the value the sequential loop returns.
- [integration] `runCanonicalLoop` with `parallel` `true`, `semantic-review` failing and `adversarial-review` passing calls `_storyOrchestratorDeps.recordGreen` for `adversarial-review` only.
- [integration] `runCanonicalLoop` with `parallel` `true` and both reviews passing calls `_storyOrchestratorDeps.recordGreen` for `semantic-review` first and `adversarial-review` second.
- [integration] `runCanonicalLoop` with `parallel` `true`, `semantic-review` passing and `adversarial-review` failing returns `{ shortCircuitPhase: "adversarial-review" }`.
- [integration] `runCanonicalLoop` with `parallel` `true`, `semantic-review` passing and `adversarial-review` failing calls `_storyOrchestratorDeps.recordGreen` for `semantic-review` only.
- [integration] `runCanonicalLoop` with `parallel` `true`, the `semantic-review` `callOp` rejecting and `adversarial-review` passing calls `_storyOrchestratorDeps.recordGreen` for `adversarial-review` before the rejection propagates.
- [integration] `runCanonicalLoop` with `parallel` `true`, `semantic-review` passing and the `adversarial-review` `callOp` rejecting calls `_storyOrchestratorDeps.recordGreen` for `semantic-review` before the rejection propagates.
- [integration] `runCanonicalLoop` with `parallel` `true` and a rejecting review `callOp` does not log "Phase threw unexpected error" a second time after `runReviewPair` has logged it.

### US-003: Revalidation sweep runs the review pair

- [integration] `ExecutionPlan.run()` with `parallel` `true`, a failing `semantic-review` and the `autofix-implementer` strategy starts the `semantic-review` and `adversarial-review` `callOp` calls during revalidation before either resolves.
- [integration] `ExecutionPlan.run()` with `parallel` `false` and the `autofix-implementer` strategy dispatches `adversarial-review` during revalidation only after `semantic-review` has resolved.
- [integration] `ExecutionPlan.run()` with `parallel` `false`, the `autofix-implementer` strategy and `semantic-review` failing during revalidation does not dispatch `adversarial-review` (existing behaviour).
- [integration] With `parallel` `true` and both reviews failing during revalidation, calling `cycle.validate(...)` on the `FixCycle` captured from `_storyOrchestratorDeps.runFixCycle` returns findings from `semantic-review`.
- [integration] With `parallel` `true` and both reviews failing during revalidation, calling `cycle.validate(...)` on the captured `FixCycle` returns findings from `adversarial-review`.
- [integration] With `parallel` `true`, `semantic-review` failing and `adversarial-review` passing during revalidation, `cycle.validate(...)` on the captured `FixCycle` returns `shortCircuited: true`.
- [integration] With `parallel` `true`, `semantic-review` failing and `adversarial-review` passing during revalidation, `cycle.validate(...)` on the captured `FixCycle` returns only `semantic-review` findings.
- [integration] `ExecutionPlan.run()` for a three-session plan (`isThreeSession` true, the only configuration that registers `autofix-test-writer`) with `parallel` `true` and an `adversarial-review` finding whose `fixTarget` is `test` invokes `_storyOrchestratorDeps.callOp` for `adversarial-review` alone during revalidation.
- [integration] `ExecutionPlan.run()` with `parallel` `true` and `lint-check` failing during revalidation dispatches neither `semantic-review` nor `adversarial-review`.
- [integration] `ExecutionPlan.run()` with `parallel` `true` where `ctx.runtime.signal` aborts while the fix op runs dispatches neither `semantic-review` nor `adversarial-review` during revalidation.
- [integration] `ExecutionPlan.run()` in lite revalidation mode with `parallel` `true` dispatches `full-suite-gate` after both reviews have resolved.
- [unit] `dispatchRevalidationPhase` for `semantic-review` with `shouldRunReviewsConcurrently` true returns `["semantic-review", "adversarial-review"]`.
- [unit] `dispatchRevalidationPhase` for any phase with `shouldRunReviewsConcurrently` false returns only that phase's own kind.
