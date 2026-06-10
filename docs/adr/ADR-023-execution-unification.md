# ADR-023: Execution Unification — One Builder Per Story

**Status:** Implemented (see Implementation Status below)
**Date:** 2026-05-23
**Author:** William Khoo, Claude
**Supersedes:** SPEC-story-orchestrator-consolidation §1 (review-as-builder-phase portion), SPEC-rectification-unification (US-006a/b/c rectification plan)
**Related:** ADR-021 (Finding type SSOT), ADR-022 (Fix Strategy + Cycle), ADR-017 (Incremental Consolidation)
**Implementation:** [SPEC-execution-unification.md](../specs/SPEC-execution-unification.md)

---

## Implementation Status (2026-05-29)

The core decision is **implemented**. Verified against the live tree:

- ✅ `defaultPipeline` shrunk to the 8 stages in §5 (`src/pipeline/stages/index.ts:32-41`).
- ✅ `verifyStage`, `rectifyStage`, `reviewStage`, `autofixStage`, `regressionStage` all deleted (no live references).
- ✅ `inlineReview` flag and `runRectificationLoop` deleted; rectification flows through `runFixCycle` + FixStrategies.
- ✅ All five fix strategies wired (`src/execution/build-plan-for-strategy.ts`): `mechanical-lintfix`, `mechanical-formatfix`, `full-suite-rectify`, `autofix-implementer`, `autofix-test-writer`.
- ✅ Per-story verification owned by `verifyScopedOp` / `fullSuiteGateOp`; `applyPostRunInspection` (`src/execution/post-run.ts`) is the sole builder→pipeline bridge.

**Residual gaps** (see `docs/reports/2026-05-29-execution-unification-gap-audit.md`):

- **`IReviewPlugin` per-story `plugin-reviews` phase (§1) was never wired.** Per ADR-023/#1146, the accepted design is **deferred-only**: plugin reviewers run as a post-run step in `run-completion.ts`, not as a per-story builder phase. The `anyFailed` flag from `runDeferredReview()` is intentionally not gate-wired today; the CANONICAL_ORDER listing in §1 is aspirational. No action is needed unless per-story plugin-review gating is explicitly adopted in a future ADR.
- **`format-check` phase (§1) was never built.** The accepted design is **reactive-only formatting**: `mechanical-formatfix` fires as a FixStrategy when lint findings trigger rectification (`src/execution/build-plan-for-strategy.ts:156-159`). A standalone proactive `format-check` gate was descoped after audit (2026-06-10 ADR behavior review). Impact is low because lint usually catches format errors; projects that need a hard format gate should add a lint rule. The CANONICAL_ORDER listing in §1 is updated accordingly — see below.
- ✅ **D4 (`ReviewerSession` dialogue removal) completed (2026-05-29).** A verification pass found that no production code ever constructed a `ReviewerSession` — the debate subsystem referenced the type but never produced one, so D4's original premise ("debate consumers genuinely use it") was incorrect. The interface, factory, the `dialogue-verdict` selector, and all `resolverSession`/`reviewerSession` plumbing were removed in full. The `config.review.dialogue` deprecation shim in `src/config/loader.ts` is retained as the migration guard.

> **SPEC reconciliation:** [SPEC-execution-unification.md](../specs/SPEC-execution-unification.md) Decision D1 ("retain `regressionStage`") and its AC-005c.3 were **overridden by issue #1116**, which deleted `regressionStage` (8-stage pipeline, not 9). The SPEC's D1/AC-005c.3 are superseded by #1116; this ADR's §5 + Open Question 3 reflect the as-built state.

---

## Context

Per-story execution today runs through **three overlapping sequencing abstractions**, each with its own retry mechanics, state-passing rules, and notion of "what failed":

| Abstraction | Lives in | Sequences | Retries via | State passed via |
|:---|:---|:---|:---|:---|
| Pipeline stages | `src/pipeline/stages/` | `defaultPipeline` array | `StageResult.action: retry / escalate` | `PipelineContext` mutation |
| Builder phases | `src/execution/story-orchestrator.ts` | `CANONICAL_ORDER` | (no native retry — depends on rectification phase) | `phaseOutputs` map |
| Fix strategies | `src/findings/cycle.ts` | `FixCycle.strategies` array | `FixStrategy.maxAttempts` + `bailWhen` | `Finding[]` flow |

Three primitives doing roughly the same kind of work — pick a thing to do, do it, decide what to do next based on the outcome. The split is historical, not architectural:

- **Pipeline stages** predate everything; they were the original execution model (ADR-005).
- **Builder phases** were introduced for TDD orchestration (SPEC-story-orchestrator, US-001 through US-004), then extended in US-005 to consolidate single-session execution.
- **Fix strategies** were introduced by ADR-021/ADR-022 as the unified rectification primitive, then adopted incrementally by autofix, acceptance, and (partially) the full-suite gate.

Each migration was sound. The composite result is not. Today's `inlineReview` flag is the clearest symptom: SPEC-story-orchestrator-consolidation US-005 wired `semanticReview` / `adversarialReview` / `rectification` slots into the builder, but `pipeline/stages/review.ts` and `pipeline/stages/rectify.ts` were not retired in the same story. The flag exists purely to prevent double-firing of phases that exist in both abstractions. SPEC-rectification-unification US-006a's gate-internal rectification has the same problem in reverse — the code is wired but unreachable in production because `inputs.rectification` is gated on `inlineReview = true`.

Beyond the flag, the cross-cutting cost is real:

1. **Behavior is split across abstractions.** Test-failure rectification: builder for gate failures (when enabled), pipeline stage for verify failures, lifecycle helper for regression failures. Three implementations of "fix failing tests".
2. **Adding a new check or fix strategy means choosing where it lives.** No principled answer. New mechanical-check ops (lint-as-finding, typecheck-as-finding) have no obvious home.
3. **Session continuity relies on `SessionManager.nameFor` role-keyed naming.** That works, but combined with three sequencing layers it makes the call graph hard to follow — `shouldKeepSessionOpen` predicates exist precisely because the layers don't agree on session lifetime.
4. **`runFixCycle` already exists and works.** Acceptance fix, autofix, gate-internal rectification (when wired), and the builder's rectification phase all use it. The framework is proven; only the wiring is partial.

The `inlineReview` findings doc ([docs/findings/2026-05-23-inlinereview-legacy-stage-gap.md](../findings/2026-05-23-inlinereview-legacy-stage-gap.md)) surfaced the immediate symptom. This ADR is the architectural commitment to fix the underlying split.

## Decision

**Collapse per-story execution into a single abstraction stack: builder phases for ordering + FixStrategies for finding-driven fixes, with a thin post-builder inspection wrapper in `executionStage` for stage-level routing decisions.**

### 1. Builder owns all per-story execution

`StoryOrchestratorBuilder` becomes the sole sequencer for per-story work:

```
CANONICAL_ORDER (as-built, 2026-06-10):

[TDD fresh]   test-writer → greenfield-gate
[always]      implementer
[TDD]         full-suite-gate → verifier
[non-TDD]     verify-scoped
[always]      lint-check → typecheck-check
[always]      semantic-review → adversarial-review
[always]      rectification
```

> **Design note — `format-check` and `plugin-reviews`:** The illustrative order above originally listed `format-check` and `plugin-reviews` between `typecheck-check` and `semantic-review`. Neither phase was built:
>
> - *Formatting* is handled **reactively** — `mechanical-formatfix` fires as a FixStrategy when any lint finding triggers rectification. A standalone proactive gate was descoped (2026-06-10 audit). If a project needs a hard format gate, add a lint rule.
> - *Plugin reviews* run **deferred** as a post-run step in `run-completion.ts` (per #1146), not per-story. The deferred path is intentional; per-story plugin-review gating is deferred to a future ADR.

Every phase produces `Finding[]` in its parsed output (ADR-021 contract). The rectification phase consumes the union of unfixed findings and dispatches to `FixStrategy[]` via `runFixCycle` (ADR-022).

### 2. All checks are operations

Lint, typecheck, format become `DeterministicOperation`s (same pattern as `fullSuiteGateOp`). Semantic/adversarial review are already `RunOperation`s. Plugin reviewers (if retained) are wrapped as a single deterministic op that iterates the registry. Verify-scoped (smart-runner) becomes a deterministic op for non-TDD strategies.

There is no separate `reviewOrchestrator`; the builder's CANONICAL_ORDER is the orchestrator.

### 3. All fixes are FixStrategies

The rectification phase's `strategies` array carries the full fix matrix:

| Strategy | Applies to (predicate on `Finding`) | Fix op |
|:---|:---|:---|
| `full-suite-rectify` | `source: "test-runner"`, `category: "failed-test"` | `implementerOp` |
| `autofix-implementer` | `fixTarget: "source"`, source ∈ { lint, typecheck, semantic-review } | `implementerRectifyOp` |
| `autofix-test-writer` | `fixTarget: "test"`, source: "adversarial-review" | `testWriterRectifyOp` |
| `mechanical-lintfix` | `source: "lint"`, mechanical-fixable | shell-command op (new) |
| `mechanical-formatfix` | `source: "format"` | shell-command op (new) |

Strategy ordering in the array expresses priority — mechanical strategies first (cheap, often sufficient), agent strategies after. `runFixCycle`'s existing `coRun` and `bailWhen` semantics carry behavior preservation.

### 4. Thin post-builder wrapper for stage-level routing

`applyPostRunInspection` ([src/execution/post-run.ts](../../src/execution/post-run.ts)) remains the sole bridge between the builder's `phaseOutputs` and the pipeline's `StageResult`. It owns:

- Verdict reading (verifier passed/failed → `failureCategory`)
- Rollback decisions (`git reset --hard initialRef` on failure when configured)
- Pause-reason extraction (any phase emitting `pauseReason` → pipeline-level pause)
- Cross-finding stage-level rules (e.g. "mechanical-only failure with LLM review passing → continue, do not escalate")

This is the only place pipeline-level decisions touch builder outputs. Everything else stays inside the builder.

### 5. Pipeline shrinks

Post-migration `defaultPipeline`:

```
queueCheck → routing → constitution → context → prompt → optimizer → execution → completion
```

`verifyStage`, `rectifyStage`, `reviewStage`, `autofixStage`, `regressionStage` are deleted. `acceptanceStage` (post-run pipeline) is unchanged — it already uses `runFixCycle`.

> **Implementation note (updated 2026-05-29):** All five stages are now deleted. `regressionStage` was removed first via issue #1116 (PR #1124, PR #1125), retiring `VerificationOrchestrator`, `ScopedStrategy`, `RegressionStrategy`, and `AcceptanceStrategy`; per-story verification is now owned by `verifyScopedOp` and `fullSuiteGateOp` dispatched via `callOp`, and post-run regression continues via `src/execution/lifecycle/run-regression.ts`. The remaining four stages (`verifyStage`, `rectifyStage`, `reviewStage`, `autofixStage`) have since been deleted as well — `defaultPipeline` is now the 8 stages listed in §5 (`src/pipeline/stages/index.ts:32-41`), `inlineReview` and `runRectificationLoop` are gone, and the `StoryOrchestratorBuilder` owns the unified per-story phases. See the Implementation Status section below for the residual gaps that remain.

### 6. Out of scope

The following are explicitly **not** consolidated by this ADR:

- **Acceptance test execution and rectification** — `acceptance-loop.ts` already uses `runFixCycle`. Keeping it as a post-run pipeline stage is correct; it runs once per run, not per story.
- **Debate subsystem** (`src/debate/`) — separate concern, separate track. If retained, debate runners continue to call `semanticReviewOp` / `adversarialReviewOp` via `callOp`. If retired, separate ADR.
- **Plugin reviewer extension point** (`IReviewPlugin`) — retention decision deferred to the implementation spec; if removed, deprecation cycle runs in parallel.
- **`ReviewerSession` dialogue** — internal API, drops out naturally when `reviewStage` is deleted.

## Consequences

### Positive

- **One sequencing abstraction.** Builder phases for ordering, FixStrategies for fixes. No more "where does this belong?"
- **`runFixCycle` becomes the sole rectification framework.** Legacy `runRectificationLoop` deleted.
- **`inlineReview` flag deleted.** No more dormant code paths.
- **~2,400 LOC removed.** Five pipeline stages (~1,500 lines) plus autofix-cycle's bespoke loop (~600 lines) plus legacy rectification (~700 lines) minus ~600 LOC of new check ops and strategy adapters.
- **New check or strategy = one place to add it.** Future extension points (e.g. a custom mechanical check, a third-party fix strategy) have an obvious home.
- **Session continuity becomes a non-issue.** With one sequencer, role-keyed `SessionManager` does its job cleanly; no `shouldKeepSessionOpen` predicate needed (the implementer phase + rectification phase are the only consumers, both in one builder).
- **Specs converge.** SPEC-story-orchestrator-consolidation's review intent + SPEC-rectification-unification's rectification intent become one coherent design.

### Negative

- **High blast-radius cutover.** Phase E of the implementation spec switches every per-story execution path simultaneously. Phases A–D de-risk by landing additive changes first, but the cutover is still the riskiest single PR in nax's history.
- **Behavior preservation matrix is non-trivial.** Today's autofix has rich nuances (test-no-test scope handling, REVIEW-003 unresolved contradictions, mechanical-only suppression). Mapping each to `appliesTo` / `bailWhen` / `applyPostRunInspection` requires care; missing one regresses production silently.
- **Spec churn.** Three existing specs require superseding banners. Engineers reading commit messages referencing US-005 / US-006a / US-006b will need to chase the spec chain. Documentation cost is real but bounded.
- **Plugin compatibility risk if `IReviewPlugin` is retained.** A plugin reviewer wrapped as a builder phase observes the world differently than one called by `reviewOrchestrator`. The adapter needs to preserve the plugin's input contract precisely; otherwise external plugins break.

### Neutral

- **Performance.** No measurable change expected. Same ops invoked, same agent calls, same shell commands. The migration is a refactor, not an optimization.
- **`SessionManager` and the role registry are unaffected.** Session names continue to be `nax-<hash8>-<feature>-<storyId>-<sessionRole>`; lifetime semantics unchanged. The unification removes a consumer (`shouldKeepSessionOpen`'s predicate becomes trivial — but the function and its consumers stay).

## Alternatives Considered

### A. Status quo + documentation

Leave `inlineReview = false`, leave the three sequencing abstractions, document the gap. Cost: zero. Benefit: zero. The tech debt compounds — every new check has to choose a home, every new finding source has to be wired into both abstractions or risk being dropped (as semantic/adversarial findings are dropped today when `inlineReview = true`). Rejected: trades a 2-week investment for indefinite recurring tax.

### B. Demote review out of the builder

Delete `addSemanticReview` / `addAdversarialReview` from the builder; keep `addRectification` for test-failure fixing; leave `reviewStage` and `autofixStage` as the SSOT for review. Removes `inlineReview`, keeps three abstractions. Cost: low (~3-5 days). Benefit: flag deleted, US-006a still unreachable in production, two of three sequencing abstractions remain.

Rejected: addresses the symptom (the flag) without the cause (the split). Leaves SPEC-rectification-unification's US-006a code permanently dormant. Future engineers ask "why is there a rectification phase in the builder that never runs?"

### C. Promote review into builder, keep stages as backups

Wire `inputs.semanticReview` / `inputs.adversarialReview` / `inputs.rectification` unconditionally; teach `reviewStage` / `autofixStage` / `rectifyStage` to skip when builder ran the work. Cost: medium (~1 week). Benefit: builder owns review, stages still cover edge cases. Rejected: doubles the surface area instead of halving it. "Skip when builder ran" predicates proliferate. Two paths to test for every behavior.

### D. Full execution unification (chosen)

Collapse three sequencing abstractions to two (builder phases + FixStrategies) by deleting the pipeline stages they overlap. Cost: high (~12-17 days across 5 phases). Benefit: ~2,400 LOC removed, one home for new behavior, dormant code paths eliminated, specs converge.

Selected because it is the only option that resolves the underlying split. Higher up-front investment; lower recurring tax. The phased delivery in [SPEC-execution-unification.md](../specs/SPEC-execution-unification.md) keeps each individual PR reviewable.

## Implementation

See [SPEC-execution-unification.md](../specs/SPEC-execution-unification.md) for:

- Phase-by-phase delivery plan (A through E)
- Acceptance criteria with `[verbatim]` / `[file]` / `[grep]` tags
- Behavior preservation matrix (today's stage logic → new home)
- Deletion checklist (files, exports, types, tests)
- Risk callouts per phase

## Open Questions

1. **`IReviewPlugin` retention.** If kept, requires a plugin-reviewer op adapter. If removed, requires a deprecation release first. Decision deferred to spec-level after pre-flight audit of internal/external consumers.
2. **Plugin reviewer phase ordering.** If retained, do plugin reviews run before or after LLM reviews? Today's `reviewOrchestrator` runs them after built-in checks but before semantic/adversarial. Preserving that order is straightforward; deviating would surprise existing plugins.
3. ~~**`regressionStage` future.**~~ **Resolved (2026-05-26, issue #1116).** `regressionStage` is deleted. The resolution: per-story scoped verification is owned by `verifyScopedOp`; per-story full-suite verification is owned by `fullSuiteGateOp` (wired into the builder for TDD strategies and `regressionGate.mode === "per-story"`). Deferred post-run regression (the historical `regressionStage` concern) remains in `src/execution/lifecycle/run-regression.ts` as a lifecycle helper — not a pipeline stage — which keeps post-run semantics intact without requiring a builder phase. No further decision needed.
