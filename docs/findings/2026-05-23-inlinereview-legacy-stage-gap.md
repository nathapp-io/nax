# `inlineReview` flag: scope gap between specs, implementation, and legacy pipeline stages

**Date:** 2026-05-23
**Discovered while:** investigating an rs-stock run where test-writer modified `src/` (isolation violated) and the full-suite-gate halted the plan before the verifier got to judge.
**Status:** **Resolved by ADR-023 / SPEC-execution-unification.** Two TDD fixes landed in commit `c2a5ca3e`. The `inlineReview` default flip was attempted (`8092cad3`) and reverted (`0671518f`) after this gap was identified. See Resolution section below.

---

## Resolution (2026-05-23)

Deeper analysis surfaced two related issues beyond the original framing:

1. **Builder rectification with `inlineReview=true` is partially dead.** The builder gathers semantic/adversarial findings but `makeFullSuiteRectifyStrategy.appliesTo` only matches `source: "test-runner"`. Review findings are collected and silently dropped — flipping the flag would not have fixed semantic/adversarial issues.

2. **US-006a's gate rectification is unreachable in production.** [src/operations/full-suite-gate.ts:28](../../src/operations/full-suite-gate.ts#L28) claims "Rectification is now handled externally by the general runFixCycle phase", but `inputs.rectification` is also gated on `inlineReview`. With the default `false`, gate failures fall through to the legacy `runRectificationLoop` path — US-006a's promised consolidation never activated in production.

The right resolution is not a flag flip, a partial-skip, or a demote. It is **full execution unification**:

- One sequencer (`StoryOrchestratorBuilder`).
- One fix framework (`runFixCycle`).
- One glue layer (`applyPostRunInspection`).
- Five pipeline stages and the `inlineReview` flag deleted.

See:
- [ADR-023-execution-unification.md](../adr/ADR-023-execution-unification.md) — the architectural decision and alternatives weighed.
- [SPEC-execution-unification.md](../specs/SPEC-execution-unification.md) — the five-phase implementation plan (A through E) with acceptance criteria and behavior preservation matrix.

The four recommendations originally listed at the bottom of this finding are subsumed:
- Recommendations 1, 2, 4 → captured in SPEC-execution-unification Phase A and Phase E.
- Recommendation 3 (fix SPEC-rectification-unification.md line 484) → addressed via supersession banner on that spec.

This findings doc is preserved as the investigation log that surfaced the work.

---

## TL;DR

The `execution.inlineReview` config flag was added during the US-005 story-orchestrator-consolidation rollout as a temporary opt-in. It moves **LLM-based review (semantic + adversarial) and rectification** into the per-story `ExecutionPlan`. It does **not** move lint, typecheck, format, or autofix. None of the three governing specs cover that gap. Flipping the default to `true` therefore turned off `reviewStage`/`rectifyStage` correctly for the LLM checks but would have also turned off the only path that runs lint/typecheck/format/autofix.

We chose to keep the default at `false` until a follow-up spec defines how the legacy quality-check surface migrates (or is preserved alongside) the orchestrator-internal review.

---

## How the flag came to exist

| Commit | Date | What it did |
|:---|:---|:---|
| `1792b391` | 2026-05-20 | Wired `semanticReview` / `adversarialReview` / `rectification` inputs into `assemblePlanInputsFromCtx`. Added `execution.inlineReview` (default `false`) as the gate. Commit message says: *"Gated behind `execution.inlineReview` (default false) — opt-in until the legacy `pipeline/stages/review.ts` and `rectify.ts` paths are deprecated."* |

This was implementation-side fallout from the consolidation, not a flag the specs anticipated. SPEC-story-orchestrator-consolidation.md explicitly lists *"No new config keys."* under Non-Goals (line 366) — the flag exists despite that line.

---

## What each spec says (and doesn't say)

### SPEC-story-orchestrator.md

Defines builder review phases as `semanticReview` and `adversarialReview` only (lines 327-328, 351-352, 398-399). Both are **LLM-based code-review** operations.

- **Zero mentions** of `lint`, `typecheck`, `format`, `quality.commands`, or `autofix` as orchestrator concerns.
- The 4 `autofix*` references in the spec point to `src/operations/autofix-implementer.ts` purely as a coding-style reference for *test patterns*, not for inclusion.

### SPEC-story-orchestrator-consolidation.md (US-005)

The consolidation that produced the orchestrator.

- Non-Goals: *"No new config keys."* (line 366) — `inlineReview` was added anyway.
- Review-slot gating spec'd in terms of `review.enabled` + `review.checks` membership, where `checks` is restricted to LLM check names (`semantic`, `adversarial`). Lint/typecheck are not in the registry.
- Migration of `pipeline/stages/review.ts` and `rectify.ts` is **not specified**.

### SPEC-rectification-unification.md (US-006)

Adds gate-derived test failures into a unified rectification phase. One telling line (484):

> *"If a single rectification iteration sees both test failures (from gate) **and lint findings (from semantic)**, which fix-op runs?"*

That parenthetical is **wrong against the code**: `semanticReviewOp` is an LLM code-reviewer, not a lint executor. Lint findings come from `quality.commands.lint` via the legacy `reviewStage`. The spec author appears to have assumed semantic-review would absorb lint findings — but the implementation never did that.

Non-Goals reinforce the gap: *"No new builder phases."*

---

## What the pipeline actually looks like

Order of stages in `defaultPipeline` ([src/pipeline/stages/index.ts](../../src/pipeline/stages/index.ts)):

```
executionStage  → verifyStage → rectifyStage → reviewStage → autofixStage → regressionStage → completionStage
```

### `inlineReview = false` (today's default)

| Stage | Behavior |
|:---|:---|
| `executionStage` | Runs `test-writer → greenfield-gate → implementer → full-suite-gate → verifier`. No review or rectification phase added. |
| `verifyStage` | Runs scoped tests (skipped if `fullSuiteGatePassed`). |
| `rectifyStage` | Runs `runRectificationLoop` if verify failed. |
| `reviewStage` | Runs lint + typecheck + format + semantic + adversarial. |
| `autofixStage` | Runs `lintFix`/`formatFix` + agent rectification if review failed. |
| `regressionStage` | Per `regressionGate.mode`. |

Legacy path handles everything. No double-fire.

### `inlineReview = true` (attempted default — reverted)

| Stage | Behavior |
|:---|:---|
| `executionStage` | Runs `test-writer → … → verifier → semantic-review → adversarial-review → rectification`. |
| `verifyStage` | Same — skipped on gate-pass. |
| `rectifyStage` | **Double-fires** with the orchestrator's rectification unless skip-on-inline added (we added it in `8092cad3`). |
| `reviewStage` | **Runs lint + typecheck + format + semantic + adversarial** — double-fires semantic+adversarial unless skip-on-inline added. |
| `autofixStage` | Triggers off `ctx.reviewResult` which is never set when reviewStage is skipped → **never runs**. |
| `regressionStage` | Same. |

So a naive flip double-fires the LLM checks. A flip with `inlineReview`-aware skips on the legacy stages eliminates the double-fire but **drops lint/typecheck/format/autofix entirely** — that path has no home in the orchestrator.

---

## The actual gap

`reviewStage` runs **5 distinct check types** today:

1. `lint` — `quality.commands.lint`
2. `typecheck` — `quality.commands.typecheck`
3. `format` — `quality.commands.format` (typically read-only)
4. `semantic` — LLM op `semanticReviewOp`
5. `adversarial` — LLM op `adversarialReviewOp`

The orchestrator's `ExecutionPlan` knows how to run **only checks 4 and 5**. There is no `lintCheckOp`, `typecheckOp`, or `formatCheckOp` exposed to the builder. Likewise the orchestrator's rectification phase (`makeFullSuiteRectifyStrategy` + an empty base strategy list) only consumes test-failure findings — there is no autofix strategy.

So the legacy `reviewStage` + `autofixStage` chain is the **only path** that:

- Executes the lint/typecheck/format shell commands.
- Wires their findings into `ctx.reviewResult`.
- Triggers `autofixStage`'s Phase 1 (mechanical `lintFix`/`formatFix`) and Phase 2 (agent rectification of remaining findings).

The `inlineReview` flag, despite its name, is really *"inlineLLMReviewOnly"*. Flipping it to `true` doesn't make the orchestrator a complete replacement.

---

## Why this matters for `c2a5ca3e`

Commit `c2a5ca3e` fixes two real issues:

1. **Lite-mode test-writer isolation** — stub-sized src/ writes (≤20 added lines) become soft violations.
2. **Verifier always runs after gate failure** — the gate's "tests failed" signal is no longer a short-circuit; verifier (LLM judge) gets to interpret it. `deriveTddFailureCategory` learns to read the gate output so the failure routes through `escalate` instead of the generic pause.

Both changes are independent of `inlineReview`. They live in `story-orchestrator.ts`, `post-run.ts`, `isolation.ts`, and `write-test.ts`. The fixes work whether the flag is on or off.

The original analysis suggested flipping `inlineReview` to `true` as a third change to "complete the US-005 cutover." That extrapolation was premature — the cutover requires either (a) moving lint/typecheck/autofix into the orchestrator or (b) keeping the legacy stages for them while skipping the LLM duplicates. Neither has been spec'd.

---

## Recommended next steps

1. **Keep `inlineReview` default `false` for now.** Ship `c2a5ca3e` as the TDD fix; defer the cutover.
2. **Write a spec for the cutover.** Options:
   - **A — Promote quality-check phases into the orchestrator.** Add `lintCheckOp`, `typecheckOp`, `formatCheckOp` to the builder. Add a lint/typecheck autofix strategy to the rectification base list. Then `inlineReview` can become a true global toggle.
   - **B — Make `inlineReview` partial-skip aware.** `reviewStage` skips the LLM checks when `inlineReview=true` but keeps running lint/typecheck/format. `autofixStage` keeps working off the residual. Cheaper, but the partial-overlap config is ugly.
   - **C — Keep `inlineReview` as opt-in indefinitely.** Treat the in-orchestrator review path as a power-user option. Document the trade-off explicitly.
3. **Fix SPEC-rectification-unification.md line 484.** The "(from semantic)" parenthetical is incorrect and could mislead future implementers. Replace with "(from lint/typecheck via the autofix path)" or similar.
4. **Rename the flag.** If A or B lands, `inlineReview` is misleading. Candidates: `execution.inlineRectification`, `execution.inlineLlmReview`, `execution.useStoryOrchestratorReview`.

---

## Artifacts on this branch

- `c2a5ca3e` — TDD lite isolation + verifier-after-gate fixes. **Keep.**
- `8092cad3` — Flipped `inlineReview` default to `true` and added skip-on-inline to legacy stages. **Reverted by `0671518f` after this gap was identified.**
- `0671518f` — Revert of `8092cad3`.

The two flip commits cancel functionally but were kept in history as an audit trail of the investigation.
