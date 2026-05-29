# Execution Unification — Gap Audit Report

**Date:** 2026-05-29
**Scope:** Post-refactor analysis of the story-orchestrator / unified-execution consolidation (ADR-023, issue #1116, ADR-021/022).
**Method:** Compared the documented intent in `docs/adr/` and `docs/architecture/subsystems.md` against the actual `src/` code, using five parallel subsystem audits (orchestrator, verification, review/rectification, dead-code/build-health, doc-drift). High-impact claims independently re-verified against source.

---

## TL;DR

**The refactor landed cleanly. The code is healthier than the docs claim.**

- **Build / typecheck / lint: all GREEN.** Zero type errors, zero dangling live references to the five deleted pipeline stages or the deleted verification classes. The deletion was surgical.
- **The pipeline is now 8 stages** (`queueCheck → routing → constitution → context → prompt → optimizer → execution → completion`). Per-story work moved into `StoryOrchestratorBuilder.CANONICAL_ORDER` + `runFixCycle` FixStrategies, exactly as ADR-023 intended.
- **ADR-023's end-state is essentially implemented** even though it is still labelled "Partially Implemented" and its SPEC is still "Draft".

**Two genuine functional regressions were found**, both around the `IReviewPlugin` extension point. Everything else is documentation drift or dead code. No CRITICAL build/runtime breakage.

---

## Severity Legend

| Severity | Meaning |
|:---|:---|
| **HIGH** | Real functional regression — a feature that worked before no longer works / no longer has teeth |
| **MEDIUM** | Real gap but low blast radius, OR misleading core-architecture documentation that feeds agent runs |
| **LOW** | Cosmetic: stale comments, stale doc references, dead-but-unreachable code |

---

## 1. Functional Regressions (act on these)

### G1 — `IReviewPlugin` reviewers lost their per-story gating teeth — **HIGH**

**What:** The deleted `reviewStage` used to run plugin reviewers (`IReviewPlugin`, a documented public extension point) **per story**, and a failing reviewer could `escalate` or `fail` the story. After unification:

- `CANONICAL_ORDER` (`src/execution/story-orchestrator.ts:261-271`) has **no plugin-review phase**. ADR-023 §1 lists `plugin-reviews` as an `[always]` phase; it was never wired into the builder.
- `PluginRegistry.getReviewers()` has exactly **one** caller — `src/execution/deferred-review.ts:68` — which runs **once at end-of-run**, not per story.

**Impact:** Plugin reviewers no longer gate individual stories, and per-story plugin findings no longer feed rectification. A third-party / built-in `IReviewPlugin` that previously blocked a bad story is now demoted to an end-of-run informational pass.

**Evidence:** `src/execution/story-orchestrator.ts:261-271`; `grep getReviewers src/` → 1 live caller (`deferred-review.ts:68`).

### G2 — The demoted end-of-run plugin review is itself inert — `anyFailed` is never consumed — **HIGH**

**What:** `runDeferredReview()` correctly computes `anyFailed` (`src/execution/deferred-review.ts:78,90,100,104`) and it is stored on the result envelope (`src/execution/executor-types.ts:60`, `unified-executor.ts:107`). But **nothing ever reads it.** `grep "deferredReview\|anyFailed" src/execution/ src/pipeline/` shows it is only assigned and stored — never branched on. `runner-completion.ts` / lifecycle never inspect it.

**Impact:** A plugin reviewer can hard-fail at end-of-run and the run still exits "completed". Combined with **G1**, the `IReviewPlugin` extension point currently has **zero effect on run outcome** — it is observational only.

**Evidence:** `src/execution/deferred-review.ts:104` (returns `anyFailed`); no reader anywhere in `src/execution/lifecycle/` or `runner-completion.ts`.

> **G1 + G2 together** are the headline finding: the `IReviewPlugin` contract is wired but toothless end-to-end. If plugin-based review gating is a feature you rely on (or advertise), it is currently broken. If plugin reviewers were never actually used in practice, this is low real-world impact but still a contract violation.

---

## 2. Gaps & Divergences from Intended Design

### G3 — `format-check` phase never existed — **MEDIUM**

**What:** ADR-023 §1's CANONICAL_ORDER lists `format-check` between `typecheck-check` and reviews. There is **no `format-check` op, no `PhaseKind`, no builder method** (`grep "format-check|formatCheck" src/` → 0 op/phase hits; `src/operations/` has `lint-check.ts`, `typecheck-check.ts`, but no `format-check.ts`).

**Mitigation:** `mechanical-formatfix-strategy.ts` exists as a *fix* strategy, but its `appliesTo: (f) => f.source === "lint"` (`mechanical-formatfix-strategy.ts:111`) only fires in reaction to a **lint** finding. With no format gate emitting `source: "format"` findings, formatting is never independently verified — it only piggybacks on lint failures.

**Impact:** MEDIUM, partly cosmetic. The *old* pipeline also had no standalone format gate (review.ts bundled format into lint), so this is a divergence from the ADR's illustrative order rather than a regression of shipped behavior. If your Biome/Prettier lint config already covers formatting, impact is negligible.

### G4 — ADR-023 D4 (`ReviewerSession` dialogue) only half-executed — dead code — **MEDIUM**

**What:** ADR-023 D4 says "ReviewerSession dialogue removed." The **config key** `review.dialogue` is correctly stripped+warned (`src/config/loader.ts:234`), but the **implementation was never deleted**:

- `src/review/dialogue.ts` (~480 lines) still exports `ReviewerSession` + `createReviewerSession()`.
- `createReviewerSession` has **zero value-level callers** in `src/`. The `resolverSession?` parameter threads through `runner.ts:266 → semantic.ts:256 → semantic-debate.ts:126` but **no producer ever populates it**, and `semanticReviewOp` (the actual builder phase) never touches the dialogue path.

**Impact:** Unreachable dead code (~480 lines + plumbing). Not a runtime regression — it can't fire — but it is live-looking infrastructure that inflates the review module and invites accidental re-wiring.

**Recommendation:** Delete `src/review/dialogue.ts`, the `resolverSession`/`reviewerSession?` parameter chain in `runner.ts`/`semantic.ts`/`semantic-debate.ts`/debate runners, and `ReviewDialogueConfig` (`review/types.ts:171`).

### G5 — Non-TDD full-suite gate unreachable under default config — **LOW (by design)**

For non-TDD strategies, `fullSuiteGateOp` + `full-suite-rectify` are only added when `regressionGate.mode === "per-story"` (`build-plan-for-strategy.ts:124-128,171-173`); the schema default is `"deferred"`. This is **intentional** per issue #1116 — non-TDD stories verify via `verify-scoped`, and full-suite regression runs deferred at end-of-run (`run-regression.ts:105` ← `run-completion.ts:115`, confirmed functional). Flagged only because the condition reads as "always-false-under-default." **No action needed.**

---

## 3. Test & Hygiene Gaps

### G6 — Stale throwaway parity test still present and asserting nothing — **MEDIUM**

`test/integration/verification/strategy-vs-op-parity.test.ts` is a self-described "THROWAWAY MIGRATION SAFETY NET … DELETED in Phase 5" whose 8/8 test bodies are `expect(true).toBe(true)` with an un-actioned `TODO(Phase 3 / Task 12)`. The strategy classes it was meant to compare are now deleted, so it can never be filled. It passes CI, giving **false-green coverage** for verify-scoped/full-suite parity (real coverage lives in `test/unit/operations/verify-scoped.test.ts` (18 cases) + `full-suite-gate.test.ts` (16 cases)).

**Recommendation:** Delete the file.

### G7 — File-size hard-limit (600 lines) violations concentrated by the refactor — **MEDIUM**

| File | Lines | Note |
|:---|:---|:---|
| `src/execution/story-orchestrator.ts` | **1293** | 2.15× the limit; largest file in `src/`. The refactor concentrated unified logic here. Candidate split: fix-cycle dispatch, gate dispatch, finding synthesis. |
| `src/prompts/builders/rectifier-builder.ts` | 888 | pre-existing |
| `src/agents/manager.ts` | 802 | pre-existing |
| `src/execution/unified-executor.ts` | 615 | just over |
| (5 more between 622–730) | | pre-existing |

`src/execution/post-run.ts` is **586 lines — within limit**.

---

## 4. Documentation Drift (the largest category)

The docs describe a **13–15 stage pipeline with five live stages and a verification orchestrator that no longer exist.** Because the project `CLAUDE.md` is auto-generated from `.nax/context.md`, **every agent run currently ingests the wrong architecture.**

### D1 — Project `CLAUDE.md` / `.nax/context.md` — wrong stage counts — **HIGH leverage**

- `.nax/context.md:44`: `→ Pipeline stages 1–13 (defaultPipeline)` → should be **8**.
- `.nax/context.md:58`: `| src/pipeline/stages/ | 15 pipeline stages (13 default + pre-run + post-run) |` → reality is **8 default + 1 pre-run (`acceptanceSetup`) + 1 post-run (`acceptance`) = 10 total**.

**Fix:** edit `.nax/context.md`, then `nax generate` to refresh `CLAUDE.md`. *Highest-leverage fix — it feeds every agent run.*

### D2 — `subsystems.md` §17 + §21 + §25 describe the deleted architecture as current — **HIGH**

- **§17 (lines 19, 26-44):** "Pipeline Stages (15 total)", "13 stages", and a table listing `verify.ts / rectify.ts / review.ts / autofix.ts / regression.ts` as live stages. All five files are deleted.
- **§17 (line 82):** lists deleted helpers `reviewFromContext`, `runThreeSessionTddFromCtx`, `runRectificationLoopFromCtx` as current.
- **§21 (lines 256-309):** describes `src/verification/orchestrator.ts`, `strategies/scoped.ts|regression.ts|acceptance.ts`, `rectification-loop.ts`, `parser.ts`, and a `VerifyResult` interface — **all deleted**. Most out-of-date section. Reality: `verifyScopedOp` / `fullSuiteGateOp` via `callOp` inside the builder (the §21 lines 311-333 op-envelope mapping IS accurate).
- **§25 (lines 517, 530-532, 545-560):** references deleted `src/review/orchestrator.ts` and `autofix.ts` stage; attributes the mechanical-vs-LLM split to a deleted orchestrator.

### D3 — `ARCHITECTURE.md` index mirrors the stale sections — **MEDIUM**

- Line 52: "§17 Pipeline Architecture — 15 stages" → 8.
- Line 56: "§21 … Orchestrator, strategies (scoped/regression/acceptance)" → deleted.

### D4 — `design-patterns.md:192-194` uses deleted strategy classes as the Strategy-pattern exemplar — **LOW**

`ScopedStrategy / RegressionStrategy / AcceptanceStrategy implements IVerificationStrategy` — all deleted.

### D5 — ADR-023 + SPEC are stale in the *conservative* direction — **MEDIUM**

- **ADR-023:3** "Partially Implemented" and **:102** "the remaining four stages (verify/rectify/review/autofix) await Phase B-E" — but **all four are already deleted**, `inlineReview` is gone, `runRectificationLoop` is gone, the builder owns the unified phases. The Decision section (§1-§5) is essentially shipped. → flip Status to "Implemented" (note the G1/G3 caveats), update line 102.
- **SPEC-execution-unification.md:4** "Draft" while ~fully shipped. Worse: its keystone decision **D1 "regressionStage is retained"** and **AC-005c.3** (require `defaultPipeline` to contain `regressionStage`, 9 stages) were **overridden by issue #1116** (which deleted `regressionStage`, leaving 8 stages). The SPEC now contradicts both the code and ADR-023 Open Question #3. → mark SPEC superseded by #1116, or reconcile D1/AC-005c.3.

### D6 — Minor stale references — **LOW**

- `docs/reports/COVERAGE-GAPS.md:17` → TODO test for deleted `VerificationOrchestrator` entry point.
- `docs/specs/2026-05-25-rectification-semantic-finding-routing.md` header says "Pre-implementation" but shipped; `docs/specs/2026-05-26-rectifier-handoff-restoration.md` has no Status line.
- Stale `runRectificationLoop` comments in `src/session/session-keeper.ts:5`, `src/prompts/builders/rectifier-builder.ts:737`.
- `test/unit/pipeline/effective-config.test.ts:145` stale comment.

---

## 5. Confirmed Healthy (no action — for confidence)

These were checked and are **working correctly** — the refactor did not break them:

- **Build/typecheck/lint:** all green. `bun run typecheck` exits 0; `bun run build` bundles 776 modules; Biome clean over 644 files. Custom checks (`alias-internals`, `deep-relatives` ↓224, `no-real-global-nax`, `logger-storyid` ↓) all pass.
- **No live dangling references** to any deleted stage/class. Every grep hit is a comment, a ported-test name, or a negative regression-guard assertion (`expect(...runRectificationLoop).toBeUndefined()`).
- **`inlineReview` flag** genuinely deleted (only a loader deprecation shim remains). Runtime gate is now `shouldRunRectification(config)`.
- **`runRectificationLoop`** genuinely deleted from runtime.
- **All 5 fix strategies implemented and wired** (`build-plan-for-strategy.ts:163-182`): `mechanical-lintfix`, `mechanical-formatfix`, `full-suite-rectify`, `autofix-implementer`, `autofix-test-writer`. Semantic-review findings correctly route to the implementer (`IMPLEMENTER_SOURCES` includes `semantic-review`), closing the earlier "dropped semantic findings" gap.
- **Both verification ops wired:** `verifyScopedOp` unconditional for non-TDD; `fullSuiteGateOp` always for TDD. Deferred post-run regression functional via `run-regression.ts` with BUG-026 `acceptOnTimeout` preserved. `AcceptanceStrategy` behavior moved to `runAcceptanceLoop`. `smart-runner` still live via `scoped-selection.ts`.
- **ADR-023 §Negative nuances survived:** mechanical-only suppression (`post-run.ts:419-427`), REVIEW-003 unresolved-contradiction handling (`autofix-implementer.ts:21,50`), test/no-test scope (mirrored gate condition).
- **Recent fix churn (#1108-#1145) all landed in source:** verifier `normalizedFindings`, `EXHAUSTED_EXIT_REASONS`, execution-failed synth finding (`full-suite-gate.ts:274-283`), adversarial flip-to-pass on dropped blocking findings, implementer→test-writer handoff (`makeDeclarationSink` + `postValidate`).
- **`post-run.ts` routing bridge intact:** pause-reason extraction, `failureCategory` derivation, rollback, `decideStageAction` escalation all present. The only routing loss is that plugin-review findings never reach it (consequence of G1/G2).

---

## 6. Recommended Action Plan (priority order)

| # | Action | Severity | Effort |
|:--|:---|:---|:---|
| 1 | **Decide `IReviewPlugin` fate (G1+G2):** either re-wire plugin reviews as a builder phase that feeds rectification + run outcome, OR formally deprecate the extension point. Currently it's silently inert. | HIGH | M |
| 2 | **Fix `.nax/context.md` lines 44+58 → 8 stages, then `nax generate`** (D1). Highest leverage — corrects what every agent run ingests. | HIGH | S |
| 3 | **Rewrite `subsystems.md` §17/§21/§25** to the 8-stage + builder-owned-verification reality (D2); fix `ARCHITECTURE.md` index (D3). | HIGH/MED | M |
| 4 | **Delete dead `ReviewerSession` dialogue** (`src/review/dialogue.ts` + `resolverSession` chain) per ADR-023 D4 (G4). | MED | M |
| 5 | **Delete the throwaway parity test** `strategy-vs-op-parity.test.ts` (G6). | MED | S |
| 6 | **Reconcile ADR-023 status + SPEC D1/AC-005c.3 with #1116** (D5); flip ADR-023 to "Implemented". | MED | S |
| 7 | **Split `story-orchestrator.ts` (1293 lines)** to satisfy the 600-line hard limit (G7). | MED | M |
| 8 | **Add a `format-check` op** if independent format verification is desired (G3); otherwise document that lint covers it. | LOW | S |
| 9 | Scrub stale comments/spec statuses (D4 LOW, D6). | LOW | S |

---

*Generated from a five-agent parallel audit of ADR-005 through ADR-023, `subsystems.md`, and the live `src/` tree. All HIGH findings re-verified against source line-by-line.*
