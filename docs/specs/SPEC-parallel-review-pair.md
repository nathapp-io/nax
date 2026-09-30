# SPEC: Concurrent semantic + adversarial review (`review.adversarial.parallel`)

## Summary

Re-enable `review.adversarial.parallel`. When it is `true` and `review.adversarial.maxConcurrentSessions` is at least 2, the `semantic-review` and `adversarial-review` phases run concurrently instead of one after the other, both in the first-pass canonical loop and in the post-rectification revalidation sweep. Behaviour with `parallel: false` (the default) is unchanged. This closes nathapp-io/nax#2302 by re-porting the concurrency that #1084 deleted, adapted to the builder-phase architecture.

## Motivation

`review.adversarial.parallel` and `maxConcurrentSessions` are declared in `src/config/schemas-review.ts` and `src/review/types.ts` and documented in `docs/specs/SPEC-adversarial-review.md`, but nothing in `src/` reads them. The consumer (`canParallelize` in `src/review/orchestrator.ts`) was deleted by f38aedf21 (#1084) and never ported to `runCanonicalLoop`. Setting `parallel: true` is accepted and silently has no effect, so operators expecting wall-clock savings per review round get none.

Running the two reviews concurrently is now safe to the fix cycle: `runRectification` already gathers findings from both reviewers into one grouped fix cycle that starts only after both have finished, so in the first-pass canonical loop concurrency changes when the findings arrive, not what the fixer receives. In the revalidation sweep it does change what the fixer receives: today a `semantic-review` failure breaks the sweep before `adversarial-review` is dispatched, so the next fix iteration sees semantic findings only. Under `parallel: true` both reviews run, so the next iteration sees both sets of findings (likely fewer fix rounds) at the price of an adversarial session, and its spend, in rounds where sequential mode would have skipped it. That trade-off is accepted by opting into `parallel: true`. Stories that enter rectification pay the sequential review cost again on every fix round, so the revalidation sweep is in scope alongside the first pass.

## Design

### Approach

A new small module, `src/execution/story-orchestrator/review-pair.ts`, runs the two review phases of one story concurrently by calling the existing `runPhase` for each. `runPhase` is unchanged, so per-phase logging, audit, cost tracking and `phaseOutputs` writes are untouched. The pair waits for both reviews to settle before returning, and it never cancels one review because its sibling failed. Both call sites, `runCanonicalLoop` and the revalidation sweep in `runRectification`, use the same helper.

Concurrent dispatch happens only when all of these hold (composition of the two config axes: a review runs concurrently iff the flag is on AND the cap allows two sessions AND both review phases are among the phases the caller is about to run):

- `review.adversarial.parallel` is `true`;
- `review.adversarial.maxConcurrentSessions` is 2 or more (semantic review is always one session and adversarial review is one session, since the debate feature was removed, so the cap check reduces to a `>= 2` test);
- both `semantic-review` and `adversarial-review` are among the phases the caller is about to run (in the canonical loop, a review that already passed on resume is not among them; in the revalidation sweep, every selected review phase is).

In every other case the existing sequential behaviour is unchanged, including the #1666 rule that a `semantic-review` failure continues to `adversarial-review` in the canonical loop.

Reviewer sessions are assumed not to write to the working tree (they only read the diff and the tree). This is a prompt-level contract, not a permission-level one: under the default `unrestricted` permission profile an ACP reviewer is not sandboxed. Concurrency adds no new write path, because sequential mode has the same exposure; enforcing read-only review sessions is out of scope.

### Integration

Symbols this feature **changes** (baselines locate the code and are never the interface to implement):

**`runCanonicalLoop`** — `src/execution/story-orchestrator/execution-plan-phases.ts`
- Baseline: `runCanonicalLoop(plan: PlanParams, tracking: PhaseTracking, orderedPhases: readonly InternalPhase[]): Promise<{ shortCircuitPhase: string | undefined }>` runs every phase strictly in order.
- Target: the same signature and return shape. When `shouldRunReviewsConcurrently` is true at the point the loop reaches `semantic-review`, the loop dispatches both review phases through `runReviewPair`, skips the separate iteration for `adversarial-review`, and then applies the exact per-phase evaluation the sequential loop applies (see Failure Handling for the parity rules).

**The revalidation `validate` closure in `runRectification`** — `src/execution/story-orchestrator/rectification.ts`
- Baseline: iterates the selected revalidation phases one at a time, pushing each phase's findings and breaking at the first failed phase.
- Target: when `semantic-review` and `adversarial-review` are both in the selected phases and `shouldRunReviewsConcurrently` is true, the two are dispatched through `runReviewPair`; findings from both are pushed before the sweep breaks on a failure. `rectification.ts` is 597 lines against the 600-line hard limit, so this change must not push it over 600: extract the review-dispatch step of the sweep into the new sibling module `src/execution/story-orchestrator/revalidation-reviews.ts`.

**`review.adversarial.parallel` / `review.adversarial.maxConcurrentSessions` declarations** — `src/config/schemas-review.ts` and `src/review/types.ts`
- Baseline: the schema comment says "run semantic and adversarial reviewers concurrently via Promise.all ... Only activates when session count is within cap"; the `types.ts` comment says "Maximum combined reviewer sessions before falling back to sequential".
- Target: keys, types and defaults unchanged (`parallel` defaults to `false`, `maxConcurrentSessions` to `2`, range 1 to 4). The comments describe what the code now does: concurrent review when `parallel` is `true` and `maxConcurrentSessions >= 2`, sequential otherwise.

New symbols (target shape), all in `src/execution/story-orchestrator/review-pair.ts`:

```typescript
export function shouldRunReviewsConcurrently(
  reviewConfig: { adversarial?: { parallel?: boolean; maxConcurrentSessions?: number } } | undefined,
  phases: readonly InternalPhase[], // the review phases the CALLER is about to run
): boolean;

export async function runReviewPair(
  ctx: CallContext,
  pair: readonly [InternalPhase, InternalPhase], // [semantic-review, adversarial-review]
  tracking: PhaseTracking,
  isThreeSession?: boolean,
  progress?: { indices: readonly [number, number]; total: number },
): Promise<void>; // results land in tracking.phaseOutputs / tracking.phaseCosts via runPhase

export const _reviewPairDeps: { runPhase: typeof runPhase }; // test seam, mirrors _storyOrchestratorDeps
```

New symbol in `src/execution/story-orchestrator/revalidation-reviews.ts` (US-002):

```typescript
export async function dispatchRevalidationPhase(
  ctx: CallContext,
  phase: InternalPhase,          // the sweep's current phase
  phases: readonly InternalPhase[], // every phase selected for this sweep, in order
  tracking: PhaseTracking,
  isThreeSession?: boolean,
): Promise<readonly PhaseKind[]>; // the phase kinds this call dispatched
```

It dispatches `phase` on its own through `runPhase`, except when `phase` is `semantic-review` and `shouldRunReviewsConcurrently` is true for `phases`, in which case it dispatches the pair through `runReviewPair` and returns `["semantic-review", "adversarial-review"]`. The sweep in `rectification.ts` keeps the kinds already dispatched in this sweep, does not dispatch them again, and when the pair ran it evaluates both reviewers' outputs (pushing findings from both) before it applies its short-circuit break.

`phases` (for `shouldRunReviewsConcurrently`) is the set of phases the caller is about to dispatch. The caller decides the set: `runCanonicalLoop` passes only phases with no passing entry in `phaseOutputs` (the resume skip guard, which the loop already applies), while the revalidation sweep passes every selected review phase unfiltered, because the sweep has no skip guard and re-runs each selected phase. `shouldRunReviewsConcurrently` returns `true` only when `phases` contains both review phases. The review config is read as `ctx.config?.review ?? ctx.packageView.config.review`, the same resolution `nbf-deps.ts` uses.

Symbols this feature reads but does **not** change:

- `runPhase(ctx, slot, phaseCosts, phaseOutputs, isThreeSession, progress?, inRectification?)` — `src/execution/story-orchestrator/run-phase.ts`
- `phasePassed(opName, output, storyId?)` — `src/execution/story-orchestrator/phase-eval.ts`
- `recordGreenCheckpoint` (module-private in `execution-plan-phases.ts`) and `_storyOrchestratorDeps.recordGreen`
- `STRATEGY_TO_REVALIDATION_PHASES` — `src/execution/story-orchestrator/types.ts`
- `gatherRectificationFindings` consumption of both reviewers' findings in `rectification.ts`

### Failure Handling

- **One review throws while its sibling is in flight:** `runReviewPair` waits for the sibling to settle (no orphaned session writing into `phaseOutputs` after the story moved on), then rethrows. If both throw, the `semantic-review` error is rethrown. The existing "Phase threw unexpected error" error log fires once per throwing phase.
- **Cap or flag blocks concurrency:** sequential behaviour, unchanged; no error.
- **Both reviews fail:** `runCanonicalLoop` returns the same `shortCircuitPhase` the sequential loop would (the last failing phase in canonical order, `adversarial-review`). The revalidation sweep collects findings from both reviewers and then short-circuits.
- **Semantic fails, adversarial passes:** `shortCircuitPhase` is `semantic-review`; only `adversarial-review` gets a green checkpoint.
- **Story aborted during the fix op:** the existing `ctx.runtime.signal?.aborted` guard at the top of `validate` still returns empty findings before either review is dispatched. (An already-aborted signal is handled earlier, by the early return at the top of `runRectification`.)
- **A review throws in the canonical loop:** before the error propagates, `runCanonicalLoop` records green checkpoints, in canonical order, for whichever of the two reviews has a passing entry in `phaseOutputs`, so a throw does not lose the sibling's checkpoint (sequential mode records `semantic-review` before `adversarial-review` even starts).
- **Non-blocking-fix (ADR-024) revalidation:** the sweep's `validate` closure is shared with that path, so when both review kinds are selected there and `parallel` is `true`, the pair runs there too; this is accepted and needs no separate handling.
- **Semantic passes, adversarial fails:** `shortCircuitPhase` is `adversarial-review`, the loop breaks, and only `semantic-review` gets a green checkpoint, as in sequential mode.
- **Logging on a throw:** `runReviewPair` owns the "Phase threw unexpected error" log for the pair; `runCanonicalLoop` does not log it a second time.

Concurrency and atomicity: `phaseOutputs` and `phaseCosts` are keyed by phase name, and the two reviews use separate iteration maps (`semanticIterations`, `adversarialIterations`), so the two concurrent writers never share a cell. The skip-guard read (`name in phaseOutputs && phasePassed(...)`) happens before dispatch, single-threaded. Green checkpoints are recorded after both reviews settle, sequentially, in canonical order.

## Out of Scope

- Concurrent review inside `runPostRectificationResume`; that loop halts on the first failure and grants one extra rectification pass, and both contracts assume sequential phases.
- Cancelling one review session because its sibling failed or finished first.
- Changing the default of `review.adversarial.parallel` (it stays `false`).
- Removing the `parallel` or `maxConcurrentSessions` keys, or adding deprecation warnings for them.
- Running any phase concurrently other than `semantic-review` with `adversarial-review`.
- Enforcing read-only tool permissions for review sessions under the `unrestricted` permission profile.
- Counting debate debaters toward `maxConcurrentSessions`; the debate feature was removed.
- Any change to how `gatherRectificationFindings` merges or de-duplicates findings from the two reviewers.
- US-001 only: regrouping or renumbering the interleaved `phaseIndex`/`totalPhases` phase-start log lines that the two concurrent reviews emit.

## Stories

1. **US-001: Review-pair helper and canonical-loop wiring** — no dependencies
2. **US-002: Revalidation sweep uses the review pair** — depends on US-001

### Context Files

**US-001**

- `src/execution/story-orchestrator/execution-plan-phases.ts` — `runCanonicalLoop` and `recordGreenCheckpoint`, the integration point
- `src/execution/story-orchestrator/run-phase.ts` — `runPhase` and `_storyOrchestratorDeps`, the pattern for the `_reviewPairDeps` seam
- `src/execution/story-orchestrator/nbf-deps.ts` — review-config resolution pattern (`ctx.config?.review ?? ctx.packageView.config.review`)
- `src/config/schemas-review.ts` — `parallel` and `maxConcurrentSessions` declarations and comments
- `src/review/types.ts` — the duplicate `parallel` / `maxConcurrentSessions` declaration and comment

**US-002**

- `src/execution/story-orchestrator/rectification.ts` — the revalidation `validate` closure
- `src/execution/story-orchestrator/review-pair.ts` — created by US-001, integrated here
- `src/execution/story-orchestrator/types.ts` — `STRATEGY_TO_REVALIDATION_PHASES` and phase kinds
- `src/execution/story-orchestrator/phase-eval.ts` — `phasePassed` and `extractPhaseFindings` used by the sweep

### Creates

**US-001**

- `src/execution/story-orchestrator/review-pair.ts` — `shouldRunReviewsConcurrently`, `runReviewPair`, `_reviewPairDeps`

**US-002**

- `src/execution/story-orchestrator/revalidation-reviews.ts` — the review-dispatch step of the revalidation sweep, extracted from `rectification.ts`

### Modifies

None. This feature edits only source files (`execution-plan-phases.ts`, `rectification.ts`, `schemas-review.ts`, `review/types.ts`); with `review.adversarial.parallel` at its default `false`, both loops run byte-for-byte as before, so no existing test pins a closed-world shape this feature changes; the two config keys keep their types, defaults and ranges.

### Seams

- [integration] US-001: trigger `ExecutionPlan.run()` with `parallel: true` and both review phases configured; replace `_storyOrchestratorDeps.callOp` with deferred promises and assert `callOp` is invoked for both `semantic-review` and `adversarial-review` before either promise resolves (the loop reaches the reviews through `runReviewPair`, whose `runPhase` reaches `callOp`).
- [integration] US-002: trigger `ExecutionPlan.run()` with `parallel: true` and a failing `semantic-review` so rectification runs the `autofix-implementer` strategy; replace `_storyOrchestratorDeps.callOp` with deferred promises and assert that during the revalidation sweep `callOp` is invoked for both review ops before either promise resolves.
- US-002 tests observe `validate` by capturing the `FixCycle` that `_storyOrchestratorDeps.runFixCycle` receives from `runRectification` and calling `cycle.validate(...)`; review dispatch is observed through `_storyOrchestratorDeps.callOp`.
- Verification note for US-002: `bun run check:file-sizes` confirms `src/execution/story-orchestrator/rectification.ts` and the new `revalidation-reviews.ts` stay within the 600-line source limit.
- Verification note for US-001: `bun run typecheck` and `bun run lint` cover the comment-only edits to `src/config/schemas-review.ts` and `src/review/types.ts`; the comments must state that concurrency applies when `parallel` is `true` and `maxConcurrentSessions >= 2`.

## Acceptance Criteria

### US-001: Review-pair helper and canonical-loop wiring

- [unit] `shouldRunReviewsConcurrently` returns `true` when `review.adversarial.parallel` is `true`, `maxConcurrentSessions` is `2`, and the `phases` argument contains both `semantic-review` and `adversarial-review`.
- [unit] `shouldRunReviewsConcurrently` returns `false` when `review.adversarial.parallel` is `false`, for any `maxConcurrentSessions` value.
- [unit] `shouldRunReviewsConcurrently` returns `false` when `review.adversarial.parallel` is `true` and `maxConcurrentSessions` is `1`.
- [unit] `shouldRunReviewsConcurrently` returns `false` when `reviewConfig` is `undefined`, and when `reviewConfig.adversarial` is absent.
- [unit] `shouldRunReviewsConcurrently` returns `true` when `parallel` is `true` and `maxConcurrentSessions` is `undefined` with both review phases in `phases` (an unset cap resolves to the schema default of `2`).
- [unit] `shouldRunReviewsConcurrently` returns `false` when the `phases` argument contains `semantic-review` but not `adversarial-review`, even with `parallel` `true` and `maxConcurrentSessions` `2`.
- [unit] `shouldRunReviewsConcurrently` returns `false` when the `phases` argument contains `adversarial-review` but not `semantic-review`, even with `parallel` `true` and `maxConcurrentSessions` `2`.
- [unit] `runReviewPair` calls `_reviewPairDeps.runPhase` for both `semantic-review` and `adversarial-review` before either call's promise resolves.
- [unit] After `runReviewPair` resolves, `tracking.phaseOutputs` holds an entry for both `semantic-review` and `adversarial-review`, and `tracking.phaseCosts` holds each phase's own cost without one overwriting the other.
- [unit] When `_reviewPairDeps.runPhase` rejects for `semantic-review` while the `adversarial-review` call is still pending, `runReviewPair` does not settle until the `adversarial-review` call has settled, then rejects with the `semantic-review` error.
- [unit] When `_reviewPairDeps.runPhase` rejects for both phases, `runReviewPair` rejects with the `semantic-review` error.
- [unit] When `_reviewPairDeps.runPhase` rejects for a phase, `runReviewPair` logs one error, "Phase threw unexpected error", with `storyId` as the first key and the throwing `phase` name, per throwing phase, and `runCanonicalLoop` does not log it again.
- [unit] `runReviewPair` logs one info line under the `story-orchestrator` stage, "Running semantic-review and adversarial-review concurrently", with `storyId` as the first key.
- [integration] `ExecutionPlan.run()` with `review.adversarial.parallel` `true` invokes `_storyOrchestratorDeps.callOp` exactly once for `semantic-review` and exactly once for `adversarial-review`, with both calls started before either resolves.
- [integration] `ExecutionPlan.run()` with `review.adversarial.parallel` `true` and `semantic-review` seeded as already passing (resume) invokes `_storyOrchestratorDeps.callOp` once for `adversarial-review` and does not invoke it for `semantic-review`.
- [integration] `ExecutionPlan.run()` with `review.adversarial.parallel` `false` dispatches `adversarial-review` only after the `semantic-review` dispatch has resolved.
- [integration] `ExecutionPlan.run()` with `review.adversarial.parallel` `true` and `maxConcurrentSessions` `1` dispatches `adversarial-review` only after the `semantic-review` dispatch has resolved.
- [integration] `runCanonicalLoop` with `parallel` `true`, `semantic-review` failing and `adversarial-review` passing returns `{ shortCircuitPhase: "semantic-review" }` and logs the warning "semantic-review failed — continuing to adversarial-review for a second opinion" (logged for parity even though `adversarial-review` has already run).
- [integration] `runCanonicalLoop` with `parallel` `true` and both reviews failing returns `{ shortCircuitPhase: "adversarial-review" }`, the same value the sequential loop returns.
- [integration] `runCanonicalLoop` with `parallel` `true`, `semantic-review` failing and `adversarial-review` passing calls `_storyOrchestratorDeps.recordGreen` for `adversarial-review` only.
- [integration] `runCanonicalLoop` with `parallel` `true` and both reviews passing calls `_storyOrchestratorDeps.recordGreen` for `semantic-review` first and `adversarial-review` second.
- [integration] `runCanonicalLoop` with `parallel` `true`, `semantic-review` passing and `adversarial-review` failing returns `{ shortCircuitPhase: "adversarial-review" }` and calls `_storyOrchestratorDeps.recordGreen` for `semantic-review` only.
- [integration] `runCanonicalLoop` with `parallel` `true`, the `semantic-review` `callOp` rejecting and `adversarial-review` passing calls `_storyOrchestratorDeps.recordGreen` for `adversarial-review` only, before the rejection propagates.
- [integration] `runCanonicalLoop` with `parallel` `true`, `semantic-review` passing and the `adversarial-review` `callOp` rejecting calls `_storyOrchestratorDeps.recordGreen` for `semantic-review` before the rejection propagates.

**Out of scope:**

- Cancelling one review session because its sibling failed or finished first.
- Read-only permission enforcement for review sessions.

### US-002: Revalidation sweep uses the review pair

- [integration] `ExecutionPlan.run()` with `parallel` `true`, a failing `semantic-review` and the `autofix-implementer` strategy: the revalidation sweep dispatches `semantic-review` and `adversarial-review` with both calls started before either resolves.
- [integration] `ExecutionPlan.run()` with `parallel` `false` and the `autofix-implementer` strategy: the revalidation sweep dispatches `adversarial-review` only after `semantic-review` has resolved, and skips it when `semantic-review` fails (existing behaviour).
- [integration] `ExecutionPlan.run()` with `parallel` `true`, both reviews failing during revalidation: the findings passed to the next fix iteration include findings from `semantic-review` and from `adversarial-review`.
- [integration] `ExecutionPlan.run()` with `parallel` `true`, `semantic-review` failing and `adversarial-review` passing during revalidation: `validate` returns `shortCircuited: true` and only the `semantic-review` findings.
- [integration] `ExecutionPlan.run()` for a three-session plan (`isThreeSession` true, the only configuration that registers `autofix-test-writer`) with `parallel` `true` and an `adversarial-review` finding whose `fixTarget` is `test`, so rectification runs the `autofix-test-writer` strategy (revalidation set contains `adversarial-review` but not `semantic-review`): `_storyOrchestratorDeps.callOp` is invoked for `adversarial-review` alone during revalidation.
- [integration] `ExecutionPlan.run()` with `parallel` `true` and `lint-check` failing during revalidation: neither `semantic-review` nor `adversarial-review` is dispatched.
- [integration] `ExecutionPlan.run()` with `parallel` `true` where `ctx.runtime.signal` aborts while the fix op runs: revalidation dispatches neither `semantic-review` nor `adversarial-review`.
- [integration] `ExecutionPlan.run()` in lite revalidation mode with `parallel` `true`: `full-suite-gate` is dispatched after both reviews have resolved.

**Out of scope:**

- US-002 only: concurrent review in `runPostRectificationResume`.
