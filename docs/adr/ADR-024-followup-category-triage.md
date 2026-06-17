# ADR-024 Follow-up: Category-Based fixTarget Triage for the Non-Blocking Fix

**Status:** Accepted
**Date:** 2026-06-17
**Author:** William Khoo, Claude
**Builds on:** ADR-024 (Non-Blocking Adversarial Fix)
**Related:** #986 (structural-counterfactual / `BLOCKING_CATEGORIES` telemetry), ADR-021 (Finding Type SSOT), ADR-022 (Fix Strategy + Cycle)
**Implementation:** `SPEC-nonblocking-fix-category-triage.md`

---

## Context

ADR-024 shipped `review.adversarial.nonBlockingFix` with `scope: "source" | "both"` (default `both`). In `both`, the strategy set is built so that the **test-writer owns every adversarial finding** and the implementer handles only revalidation regressions (`build-plan-for-strategy.ts:246-253`, `includeAdversarialReview: false`). The test-writer's `appliesTo` claims any finding with `source === "adversarial-review"` unconditionally (`autofix-test-writer-strategy.ts:18`), so the per-finding `fixTarget` signal never governs routing.

This was a deliberate choice (the ADR-024 implementation plan, `2026-06-07-non-blocking-adversarial-fix.md:478`: *"test-writer owns adversarial; implementer owns regressions"*), inherited from nax's pre-existing convention that in three-session TDD adversarial findings are addressed as test edits. **The blocking rectification cycle routes the same way** — there is no category triage anywhere; routing is by session mode.

### The assumption that broke

The "test-writer owns adversarial" default was implicitly tuned for the **blocking** finding stream, which is test-gap-dominated. A forensic pass over 147 adversarial review-audits (rs-stock + nathapp-nestjs-platform, 2026-06-13 → 06-17) shows the blocking and advisory streams have **opposite category mixes**:

| category | BLOCKING (`error`) | ADVISORY (`warning`/`info`) |
|:--|--:|--:|
| test-gap | 49 (68%) | 126 (25%) |
| input / error-path / abandonment / assumption | 16 (22%) | 234 (47%) |
| convention | 7 (10%) | 143 (28%) |

The advisory stream that `nonBlockingFix` consumes is **~47% source-defect categories** (the four `BLOCKING_CATEGORIES`), only ~25% test-gap. Yet `scope: "both"` routes all of them to the test-writer. Observed effect on real runs: genuine source defects the reviewer flagged — `SqliteCache.stats()` hardcoding `info_tickers=0`, a lock-free `get_info()` read race, empty-string primary keys accepted without validation, data-losing `quarantine_fundamentals()` — were never fixed; the test-writer tightened test assertions *around* the buggy behavior and the source bugs merged.

So the design is correct-by-construction but mis-assumed: it works for the blocking stream and misfires for the advisory stream.

### Why this is the right lever

nax already maintains an authoritative source/advisory category taxonomy: `BLOCKING_CATEGORIES = {input, error-path, abandonment, assumption}` (`ac-structural-counterfactual.ts:25`), with the adversarial prompt emitting `convention`/`test-gap` as advisory by design. The category→fixTarget map is therefore not a guess — it reuses an existing SSOT.

`fixTarget` is also already a sanctioned routing discriminator: `FixStrategy.appliesTo` is documented to discriminate "by source, category, fixTarget, or file pattern" (`cycle-types.ts:120`), and `Finding.fixTarget` exists (`types.ts:161`). The signal is simply not populated for adversarial findings (only `test-gap → "test"` today, `adversarial-helpers.ts:108`) and is overridden by the test-writer's blanket clause.

## Decision

**Introduce `scope: "triage"` (opt-in): route advisory adversarial findings to the implementer or the test-writer by finding `category`, reusing the `BLOCKING_CATEGORIES` SSOT, isolated to the non-blocking strategy set. The blocking cycle, `scope: "source"`, and `scope: "both"` are unchanged. The blocking gate and the restore-to-adversarial-passed floor are unchanged.**

### 1. Category → fixTarget SSOT

A single `categoryToFixTarget(category)` helper, backed by `BLOCKING_CATEGORIES`:

- `input`, `error-path`, `abandonment`, `assumption` → `"source"`
- `test-gap` → `"test"`
- `convention` → `"test"` (conservative: stays on the test-writer, exactly as today — the ambiguous bucket is never routed to the implementer)
- unknown / unmapped → `"test"` (safe default: never route an unrecognized category to un-reviewed source editing)

### 2. Tag findings; routing change is non-blocking-only

`fixTarget` is set accurately on adversarial findings via the shared converter (so the review-audit records it — see §4). **This is a data change, not a behavior change**: the blocking cycle ignores `fixTarget` (its test-writer claims via the unconditional `source === "adversarial-review"` clause, and its implementer is `includeAdversarialReview`-gated regardless of `fixTarget`). The **routing** change lives only in the non-blocking strategy set, via default-preserving options on the strategy factories:

- `scope: "triage"` → implementer claims `fixTarget === "source"` adversarial findings; test-writer claims `fixTarget === "test"` adversarial findings (blanket clause disabled for this instance only); plus `full-suite-rectify` for regressions.
- The factory option defaults reproduce today's behavior, so `scope: "both"`, `scope: "source"`, and the blocking set are byte-identical.

### 3. Default stays `both`; `triage` is opt-in

Per ADR-024 Open Question 1, ship `triage` opt-in and ramp the default only after validating signal quality on real runs. `scope: "source"` (implementer-led) and `scope: "both"` (test-writer-only, lowest source-edit risk) remain as conservative overrides.

### 4. Observability

- The review-audit's findings carry `fixTarget` (the two converters — `toAdversarialReviewFindings` and `llmFindingsToReviewFindings` — are unified so the audit reflects the same `fixTarget` the cycle routes on).
- `runNonBlockingFix` returns structured per-strategy routing counts, and the kept/restored log records finding category and the claiming strategy — so a post-hoc `/nax-diagnose` can confirm triage routed correctly.

### 5. Source-edit diff-cap (bounded blast radius)

Triage newly lets the implementer ship un-reviewed source changes on `warning`/`info` findings (ADR-024 §3 strips the review re-run; ADR-024 Negative #1). A minimal `sourceDiffCap` (max files/lines a kept best-effort source edit may touch) gates this: a best-effort pass whose source diff exceeds the cap is treated as exhausted → restore-over-keep. This resolves ADR-024 Open Question 3 for the source lane.

## Consequences

### Positive

- **Recovers the ~47% source-defect advisory findings** that `scope: "both"` currently converts into test edits.
- **Zero blocking-cycle risk** — routing change is non-blocking-only; blocking inherits accurate `fixTarget` tags but ignores them.
- **Reuses an existing SSOT** (`BLOCKING_CATEGORIES`) rather than inventing a category map; aligns with #986.
- **Floor unchanged** — snapshot/restore on exhaustion still bounds the worst case to "nothing changed."

### Negative

- **Un-reviewed source edits.** Triage routes source-category findings to the implementer, whose changes are not re-reviewed (ADR-024 §3). Mitigated by the `sourceDiffCap` (§5), the deterministic gate, and opt-in default.
- **Category-mapping accuracy.** The map is only as good as the LLM's `category`. `convention` (the largest, most ambiguous bucket) is deliberately kept on the test-writer to avoid misrouting it to source.
- **Cost.** Triage can run both strategies per pass (source batch → implementer, test batch → test-writer) instead of one.

### Neutral

- **TDD boundary.** Triage puts the implementer back in the loop for source adversarial findings in three-session; `verifierGuard` (extended to apply under `triage`) preserves the deterministic test-edit guard.

## Alternatives Considered

- **Flip default to `scope: "source"`.** Zero-code, recovers source defects — but disables the ~25–28% test-gap/convention recovery that the test-writer handles well, and ships un-reviewed source edits by default. Rejected as the default; remains available as an override.
- **Redefine `both` to mean triage.** Cleaner naming, but a silent behavior change for every default user; violates the config-migration "no silent behavior-changing redefinition" rule. Rejected — add a new value instead.
- **Per-finding `fixTarget` config knob.** Nonsensical — `fixTarget` is the reviewer's classification, not a user preference. The category→fixTarget map is a code SSOT, not config.

## Open Questions

1. **`convention` routing.** Kept on the test-writer for now (conservative). If telemetry shows the source-leaning `convention` findings (unclosed handles, missing barrel exports) are worth recovering, a sub-split could route those to the implementer later.
2. **Default ramp.** When does `triage` become the default? Gate on observed kept-source-edit quality from real runs.
3. **`sourceDiffCap` value.** Needs a default; tune from real runs (shares the open question with ADR-024 Open Question 3).
