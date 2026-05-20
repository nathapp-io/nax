# SPEC: Story Orchestrator Consolidation — One Builder Per Story

**Parent spec:** [SPEC-story-orchestrator.md](./SPEC-story-orchestrator.md) (Phase 1 + Phase 2 / US-001–US-004). Parent forward-references this spec from US-004 AC#9 (post-impl amendment, commit `3b35b5e9`).
**Story ID:** US-005
**Branch:** `refactor/story-orchestrator-consolidation`
**Status:** Draft (revision 4 — see §Revision History)

---

## Summary

The parent spec introduced `StoryOrchestratorBuilder` to consolidate the TDD and single-session
execution paths into a single phase-dispatch surface. The Phase 2 implementation landed the
builder but did not finish the consolidation:

- `pipeline/stages/execution.ts` retains `if (isTddStrategy)` and routes to a separate TDD wrapper.
- `tdd/orchestrator.ts` constructs a single-slot builder **three times in sequence** (once per
  TDD role) — the wrapper, not the builder, owns phase ordering, the mid-story full-suite gate,
  and greenfield-no-tests detection.
- Adding a new phase still requires editing two sequencing sites, recreating the duplication the
  parent spec was meant to eliminate (just relocated from "two rectification loops" to
  "two sequencing wrappers").

This spec completes the consolidation: **one execution entry point, one builder per story, one
sequencing implementation.** Mid-story decision points (full-suite gate, greenfield gate) are
promoted to first-class builder phases so the canonical run order lives in `CANONICAL_ORDER`,
not in wrapper code.

---

## Motivation

The parent spec's §Summary explicitly stated the goal: *both paths share the same conceptual
slots — implementer, test-writer, verifier, semantic/adversarial review, rectification.* The
current implementation does not honor that:

| Concern | Current location | Should be |
|:---|:---|:---|
| Phase ordering | `tdd/orchestrator.ts` + `pipeline/stages/execution.ts` | `StoryOrchestratorBuilder.CANONICAL_ORDER` |
| Full-suite gate placement | Inline call between sessions in `tdd/orchestrator.ts:430` | Builder phase |
| Greenfield-no-tests pause | Inline check in `tdd/orchestrator.ts:316-378` | Builder phase with short-circuit |
| Strategy → slot selection | Two separate wrappers | One `buildPlanForStrategy()` helper |
| Cost / phase output aggregation | Three single-slot `plan.run()` calls in TDD | One per-story `plan.run()` |

The "add a new phase" smell test: today, adding an acceptance-refinement phase requires
changes in `pipeline/stages/execution.ts`, `tdd/orchestrator.ts`, and the builder. After
US-005, it requires only `builder.addX()` and one line in `buildPlanForStrategy()`.

---

## Design

### 1. Promote mid-story gates to builder phases

#### 1A. `addFullSuiteGate(input: FullSuiteGateInput)`

The full-suite gate currently sits between implementer and verifier as a wrapper-level call
(`runFullSuiteGate` in `src/tdd/rectification-gate.ts`). Promote to a `RunOperation` and add
to `StoryOrchestratorBuilder`.

- New op: `fullSuiteGateOp: RunOperation<FullSuiteGateInput, FullSuiteGateOutput, AutofixConfig>`
  in `src/operations/full-suite-gate.ts`.
- `FullSuiteGateOutput` carries `{ success, status: "passed" | "rectification-exhausted",
  attempts, estimatedCostUsd, durationMs }`.
- Builder slot position in `CANONICAL_ORDER`: **after implementer, before verifier**.
  ```
  test-writer → implementer → full-suite-gate → verifier → semantic → adversarial → rectification
  ```
- Short-circuit semantics: when `fullSuiteGateOp` returns `success: false`, `ExecutionPlan.run()`
  skips subsequent phases (verifier, review, rectification) — same rule as any phase returning
  `{ success: false }` under §2C/AC#5 of the parent spec.
- **Internal rectification:** `fullSuiteGateOp` owns its own rectification loop in US-005
  (preserved from current `runFullSuiteGate` behavior — the `runRectificationLoop` call site
  in `src/tdd/rectification-gate.ts`). Folding this loop into the general post-implementer
  rectification phase (so `runFixCycle` becomes the single rectification SSOT) is deferred
  to US-006 — see [SPEC-rectification-unification.md](./SPEC-rectification-unification.md).
  Rationale for the deferral: US-006 requires extending `addRectification`'s `cycle.validate`
  to re-run the gate, a short-circuit carve-out, a `testFailure → Finding` adapter, and a
  home for the gate's triage logic (defer-unattributable, counter-mismatch). Bundling that
  into US-005 raises blast radius beyond "one builder per story."

#### 1B. `addGreenfieldGate(input: GreenfieldGateInput)`

The greenfield-no-tests detection currently inspects test-writer output and pauses for human
review when no tests exist (`tdd/orchestrator.ts:316-378`). Promote to a phase.

- New op: `greenfieldGateOp: RunOperation<GreenfieldGateInput, GreenfieldGateOutput, TddConfig>`
  in `src/operations/greenfield-gate.ts`.
- **Input is self-contained — does NOT read prior phase outputs.** The gate's canonical
  question is "do tests exist in the repo?" — answered by re-scanning the filesystem via
  `isGreenfieldStory(story, workdir, patterns)` (`src/context/greenfield.ts:99`), not by
  inspecting test-writer's `filesChanged`. The op runs after test-writer (positional), so
  test-writer's disk effects are visible — same contract the verifier and full-suite gate
  already rely on.
  ```typescript
  export interface GreenfieldGateInput {
    readonly story: UserStory;
    readonly workdir: string;
    readonly resolvedTestPatterns: ResolvedTestPatterns;
  }
  ```
- Output: `{ success: boolean, hasPreExistingTests: boolean, pauseReason?: string }`.
  `success: false` triggers the standard short-circuit; the wrapper inspects `pauseReason` to
  surface the human-review notification.
- Builder slot position: **after test-writer, before implementer**.
  ```
  test-writer → greenfield-gate → implementer → full-suite-gate → verifier → ...
  ```

**Forward-compat note.** If a future phase truly requires structured upstream output (e.g.
an acceptance-refinement phase consuming the implementer's exact diff), introduce an
input-resolver slot variant at that point (Option A from the spec-review discussion).
Until that need materialises, `OrchestratorSlot<I,O,C>` keeps its current shape — eager
inputs only — and ops self-derive from filesystem/system state.

After both gates land, `CANONICAL_ORDER` becomes the SSOT for canonical phase ordering — no
wrapper executes phases in any other order.

### 2. Unify the execution entry point

Replace the TDD branch in `pipeline/stages/execution.ts` with a strategy-driven builder
configuration. Both `runThreeSessionTdd` and the single-session inline plan disappear.

**Inputs envelope** — `buildPlanForStrategy` accepts a `PlanInputs` record. Each field is the
typed input that the corresponding `addX` method expects (matches the `addX(input: I)`
overload, not the `OrchestratorSlot` overload):

```typescript
export interface PlanInputs {
  readonly testWriter: TestWriterInput;
  readonly greenfieldGate: GreenfieldGateInput;
  readonly implementer: ImplementerInput;
  readonly fullSuiteGate: FullSuiteGateInput;
  readonly verifier: VerifierInput;
  readonly semanticReview: SemanticReviewInput;
  readonly adversarialReview: AdversarialReviewInput;
  readonly rectification: RectificationPhaseOptions;
}
```

`testStrategy` is **not** on `NaxConfig` — it lives on `PipelineContext.routing.testStrategy`
(`src/pipeline/types.ts:33`). The strategy is therefore passed in as a separate parameter,
not derived from `config`.

```typescript
// src/execution/build-plan-for-strategy.ts (new file)
import type { ReviewCheckName } from "../review/types";
import type { TestStrategy } from "../config/schema-types";
import { shouldRunReview, shouldRunRectification } from "../operations/execution-gates";

export function buildPlanForStrategy(
  ctx: CallContext,
  story: UserStory,
  config: NaxConfig,
  testStrategy: TestStrategy,
  inputs: PlanInputs,
): ExecutionPlan {
  const b = new StoryOrchestratorBuilder();
  const isTdd = testStrategy === "three-session-tdd" || testStrategy === "three-session-tdd-lite";
  const isRetry = (story.attempts ?? 0) > 0
              || (story.priorFailures ?? []).some((f) => f.stage === "review");

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
    // Review check membership — not nested `.enabled` flags. `ReviewCheckName` includes
    // "semantic" and "adversarial"; see src/review/types.ts:10.
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

`pipeline/stages/execution.ts` collapses to (pseudocode — the helpers `assemblePlanInputs`,
`applyPostRunInspection`, `decideStageAction` are introduced by US-005 in
`src/execution/post-run.ts` and `src/execution/inputs.ts`):

```typescript
// PSEUDOCODE — helpers below land in US-005, not pre-existing.
const inputs = assemblePlanInputs(ctx);
const plan = buildPlanForStrategy(callCtx, ctx.story, ctx.config, ctx.routing.testStrategy, inputs);
const result = await plan.run();
await applyPostRunInspection(ctx, result);
return decideStageAction(result);
```

No `if (isTddStrategy) { ... } else { ... }` branch for sequencing. The branch only configures
slots; it does not own a sequencing implementation.

### 3. Post-run inspection (what stays in the wrapper)

Wrapper responsibilities collapse to **read-only inspection of `phaseOutputs`** plus a small
fixed list of side effects:

| Concern | Trigger | Action |
|:---|:---|:---|
| Verdict reading | `phaseOutputs[verifierOp.name]` present | `readVerdict()`, `categorizeVerdict()`, surface via `ctx.tddFailureCategory` |
| Rollback | `result.success === false && config.tdd.rollbackOnFailure` | `git reset --hard initialRef` |
| Isolation surfacing | Any `IsolationCheck` on phase outputs | Aggregate into pipeline-context for runner reporting |
| Human-review pause | `pauseReason` on any gate output | Send `ctx.interaction.send({ type: "notify", ... })` and return `{ action: "pause" }` |

These are the only TDD-aware lines in the new wrapper. Everything else is strategy-neutral.

### 4. Delete sites

US-005 retires the following:

- `src/tdd/orchestrator.ts` — `runThreeSessionTdd` and `runTddSessionViaBuilder` are deleted
  outright; **no re-export shim**. Consumer surface audit (grep on 2026-05-19 at HEAD
  `a697ae07`):
  - **Zero external consumers** — no `src/plugins/` imports, no `nax-dogfood` imports.
  - **Internal production callers** (2 files) — `src/tdd/orchestrator-ctx.ts`,
    `src/tdd/index.ts`. Both retired or updated in this story.
  - **Internal test consumers** (9 files, ~68 references):
    - `test/helpers/runtime.ts` — comment + example only; update docstring.
    - `test/integration/tdd/tdd-orchestrator-core.test.ts`
    - `test/integration/tdd/tdd-orchestrator-verdict.test.ts`
    - `test/integration/tdd/tdd-orchestrator-lite.test.ts`
    - `test/integration/tdd/tdd-orchestrator-failureCategory.test.ts`
    - `test/integration/tdd/tdd-orchestrator-fallback.test.ts`
    - `test/integration/tdd/rectification-gate-orchestrator.test.ts` — path-specific shape
      assertion (`.toBeDefined()` on `runThreeSessionTdd`); **retire** outright.
    - `test/unit/tdd/orchestrator-totals.test.ts`
    - `test/unit/pipeline/storyid-events.test.ts`

    Behavior tests (verdict semantics, failure categories, totals, lite mode, fallback,
    story-id event emission) must be **ported** against `buildPlanForStrategy` — the same
    behaviors still exist, only the entry point changes. Path-specific shape tests
    (asserting the existence/signature of `runThreeSessionTdd` as an API) must be
    **retired** per the test-architecture rule (parallel to the US-004 cleanup that retired
    `execution-*.test.ts` files testing the removed dispatch path).

  Public API surface (`src/tdd/index.ts` barrel) loses the `runThreeSessionTdd` export in
  the same commit.
- `pipeline/stages/execution.ts` — the `if (isTddStrategy)` branch and the inline single-session
  plan construction are both replaced by the `buildPlanForStrategy` call.
- `src/tdd/rectification-gate.ts` — `runFullSuiteGate`'s **detect + triage** logic moves into
  `fullSuiteGateOp`'s `build` / `parse` / `recover` triad. The gate-internal **rectification
  loop** (the `runRectificationLoop` call site in `src/tdd/rectification-gate.ts`) is
  preserved inside `fullSuiteGateOp` for US-005 — folding it into the general post-implementer
  rectification phase is deferred to US-006 (see [SPEC-rectification-unification.md](./SPEC-rectification-unification.md)).
  The file is deleted after migration.
- `src/tdd/session-op.ts` `runTddSessionViaBuilder` legacy shim — already partially retired
  in US-003; finish removal.

### 5. Naming alignment

After consolidation, the type `ThreeSessionTddResult` is misleading (there's no longer a
TDD-specific result shape). Rename to **`StoryRunResult`** and move to
`src/execution/types.ts`. (`StoryRunResult` chosen over `StoryExecutionResult` to avoid
visual collision with the builder's existing `StoryOrchestratorResult`.) The wrapper
synthesises `StoryRunResult` from `StoryOrchestratorResult` + post-run inspection outputs.

| Type | Owner | Purpose |
|:---|:---|:---|
| `StoryOrchestratorResult` | builder (`src/execution/story-orchestrator.ts`) | Raw phase dispatch result — `phaseOutputs`, `phaseCosts`, `success`, `durationMs` |
| `StoryRunResult` | wrapper (`src/execution/types.ts`) | Wrapper-level result — adds `failureCategory`, `needsHumanReview`, `verdict`, `sessions`, etc. |

---

## Stories

This spec is a single user story (US-005) with sub-deliverables.

### US-005: One builder per story — finish the consolidation

**Depends on:** US-001, US-002, US-003, US-004 (all landed)

Implement Design §1–§5. Delete sites per §4.

#### Context Files

- `docs/specs/SPEC-story-orchestrator.md` — parent spec; §2B `CANONICAL_ORDER`, §2C dispatch
  contract, §2D rectification, §2F wrapper boundary
- `src/execution/story-orchestrator.ts` — `StoryOrchestratorBuilder`, `ExecutionPlan`,
  `CANONICAL_ORDER` to extend with new phases
- `src/pipeline/stages/execution.ts` — single-session branch to collapse
- `src/tdd/orchestrator.ts` — `runThreeSessionTdd` to delete
- `src/tdd/rectification-gate.ts` — `runFullSuiteGate` to convert into `fullSuiteGateOp`
- `src/operations/full-suite-gate.ts` — new file
- `src/operations/greenfield-gate.ts` — new file
- `src/execution/build-plan-for-strategy.ts` — new file
- `src/execution/inputs.ts` — new file (`assemblePlanInputs(ctx): PlanInputs`)
- `src/execution/post-run.ts` — new file (`applyPostRunInspection`, `decideStageAction`)
- `src/execution/types.ts` — `StoryRunResult` (renamed from `ThreeSessionTddResult`); also `PlanInputs`
- `src/operations/execution-gates.ts` — `shouldRunReview`, `shouldRunRectification` callers
- `src/operations/{semantic,adversarial}-review.ts` — slot inputs unchanged from US-004
- `src/findings/cycle.ts` — `runFixCycle` (consumed by §2D rectification; US-005 amendment 2
  swaps in this call site per the parent-spec follow-up)

---

## Acceptance Criteria

1. `fullSuiteGateOp` exists in `src/operations/full-suite-gate.ts` with `kind: "run"`,
   `stage: "verify"`, returns `FullSuiteGateOutput` with the fields listed in §1A, and is
   inserted into `CANONICAL_ORDER` between `implementer` and `verifier`.
2. `greenfieldGateOp` exists in `src/operations/greenfield-gate.ts`, returns
   `{ success, hasPreExistingTests, pauseReason? }`, and is inserted into `CANONICAL_ORDER`
   between `test-writer` and `implementer`.
3. `ExecutionPlan.run()` short-circuits subsequent phases when any gate phase returns
   `{ success: false }` — verified by a unit test that adds a failing gate and asserts the
   verifier slot does not dispatch.
4. `buildPlanForStrategy(ctx, story, config, testStrategy, inputs)` in
   `src/execution/build-plan-for-strategy.ts` returns an `ExecutionPlan` whose configured
   slots match the strategy/config combination per Design §2. Review-slot gating reads
   `config.review.checks: ReviewCheckName[]` membership (not nested `.enabled` flags).
   Verified by table-driven tests over `(testStrategy, review.enabled, review.checks,
   rectification.enabled, isRetry)` permutations.
5. `pipeline/stages/execution.ts` contains no `if (isTddStrategy)` branch that selects a
   sequencing implementation; the only strategy-dependent code is the input-construction +
   slot-add decisions inside `buildPlanForStrategy`.
6. `runThreeSessionTdd` and `runTddSessionViaBuilder` are deleted from `src/tdd/orchestrator.ts`
   (or the file is deleted entirely; no re-export shim). The `runThreeSessionTdd` barrel
   export is removed from `src/tdd/index.ts`. The 9 test files enumerated in §4 are
   migrated: behavior tests rewritten against `buildPlanForStrategy`, path-specific shape
   tests (e.g. `rectification-gate-orchestrator.test.ts`) retired. `grep -rn
   "runThreeSessionTdd" src/ test/` returns zero matches after the story lands.
7. `runFullSuiteGate` is deleted from `src/tdd/rectification-gate.ts`; the file is deleted
   after migration. All call sites route through `fullSuiteGateOp`.
8. Wrapper post-run inspection is read-only over `phaseOutputs` and limited to the four
   concerns in Design §3 — verified by a grep test: no `await callOp(...)`, no
   `agentManager.*`, no `new SessionKeeper(...)` outside `buildPlanForStrategy` and op
   implementations.
9. `ThreeSessionTddResult` is renamed to `StoryRunResult` and lives in
   `src/execution/types.ts`. All importers updated; no `ThreeSessionTddResult` references remain.
10. Adding a new phase requires edits in **three places**, all in `src/execution/`: (a) the new
    op file under `src/operations/<name>.ts`; (b) `StoryOrchestratorBuilder` — extend the
    `PhaseKind` union, `InternalBuildState`, `CANONICAL_ORDER`, `collectOrderedPhases`, and
    add the `addX` overload pair (single coordinated edit); (c) one `b.addX(...)` line in
    `buildPlanForStrategy`. Verified by `test/unit/execution/builder-extensibility.test.ts`
    that asserts these three sites are the only edit points (grep-based — fails if a new
    phase appears in `tdd/orchestrator.ts` or `pipeline/stages/execution.ts`). Reducing this
    to "two edits" via a registry-based builder is a separate follow-up (out of scope).

---

## Failure Handling

- **Gate phase returns `{ success: false }`** — `ExecutionPlan.run()` stops dispatch for
  subsequent phases, returns `result.success === false` with `phaseOutputs` populated up to
  and including the failing gate. Wrapper inspects `pauseReason` to decide pause vs. fail.
- **`fullSuiteGateOp.parse` cannot synthesise output** — graceful degradation
  (`{ success: false, status: "rectification-exhausted", attempts: 0 }`) per the parent
  spec's "Strict-parser interaction" rule.
- **`greenfieldGateOp` filesystem read fails** — return
  `{ success: false, hasPreExistingTests: false, pauseReason: "greenfield-no-tests" }`
  matching the current wrapper's safe-fallback semantics.

---

## Non-Goals

- **No changes to `RunOperation` shape.** US-005 only adds new ops and rewires the wrapper.
- **No changes to `SessionKeeper`, `callOp`, or middleware.** All retry / cost / session-reuse
  semantics inherit from US-002 / US-003.
- **No changes to acceptance, plan, or decompose ops.** Out of scope.
- **No new config keys.** Strategy resolution continues to read existing
  `routing.testStrategy` (from `PipelineContext`), `review.enabled`, `review.checks`, and
  `execution.rectification.enabled`.

---

## Open Questions

1. ~~**`addFullSuiteGate` strategy threading.**~~ **Resolved (rev 3):** US-005 keeps
   gate-internal rectification (Option α). Folding gate failures into the general
   `addRectification` phase (Option β — single `runFixCycle` SSOT) is deferred to US-006
   ([SPEC-rectification-unification.md](./SPEC-rectification-unification.md)). See §1A for
   the deferral rationale.
2. ~~**Re-export shim for `runThreeSessionTdd`.**~~ **Resolved (rev 3):** delete outright,
   no shim. Verified zero external consumers via grep (see §4 first bullet).
3. ~~**Naming: `StoryExecutionResult` vs `StoryOrchestratorResult`.**~~ **Resolved (rev 2):**
   wrapper-level result is `StoryRunResult` (see §5).

---

## Revision History

| Rev | Date | Change |
|:---|:---|:---|
| 1 | 2026-05-18 | Initial draft |
| 2 | 2026-05-19 | Spec-review pass: greenfield gate self-derives from disk (Option F, no `phaseOutputs` read at slot-build time); review-slot gating uses `config.review.checks` membership (Option G, dropped nonexistent `.enabled` flags); `testStrategy` threaded as parameter (not on `NaxConfig`); `PlanInputs` typed explicitly; `assemblePlanInputs` / `applyPostRunInspection` / `decideStageAction` labelled as pseudocode (US-005 new code); AC#10 rewritten to match builder reality (3 edits, not 2); OQ3 resolved to `StoryRunResult`. |
| 3 | 2026-05-19 | OQ1 resolved as α (US-005 keeps gate-internal rectification; β consolidation deferred to US-006 / SPEC-rectification-unification.md). OQ2 resolved as delete-no-shim (verified zero external consumers). |
| 4 | 2026-05-19 | Spec-review rev-3 fixes: §4 first bullet expanded with full consumer-surface audit (9 test files, ~68 references previously omitted — internal test consumers, not external; categorized into behavior tests to port vs path-specific shape tests to retire). AC#6 strengthened to require zero `runThreeSessionTdd` matches post-merge and to call out the test-file migration. Dropped brittle line-number cite in §1A (`src/tdd/rectification-gate.ts:138` → symbol cite). |
