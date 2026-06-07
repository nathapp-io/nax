# ADR-024: Non-Blocking Adversarial Fix

**Status:** Proposed
**Date:** 2026-06-07
**Author:** William Khoo, Claude
**Builds on:** ADR-021 (Finding Type SSOT), ADR-022 (Fix Strategy + Cycle), ADR-023 (Execution Unification)
**Related:** #1146 (deferred review inert path)
**Implementation:** SPEC-non-blocking-adversarial-fix.md (to be written)

---

## Context

Per-story adversarial review **detects** sub-threshold issues and then **discards** them.

A forensic audit of the `finance-data-adapters` run (review-audit + prompt-audit, 2026-06-07) found that a post-implementation manual review surfaced 2 HIGH + 3 MEDIUM issues *after* nax reported all stories green with acceptance passing. Tracing the per-story reviewer I/O showed the issues were not missed for lack of detection:

- The adversarial reviewer **flagged** the tz-naive/tz-aware `TypeError` (rated `warning`) and the out-of-spec `from_date/to_date` signature drift (rated `info`).
- It **flagged** the inline-vs-module-constant duplication (`info`).
- Only the `None`→`"None"` coercion was a true detection miss (stubbed seam ACs + missing data-convention in the reviewer prompt).

The leak is **retention and severity, not detection.** `adversarial-review.ts:482-489` keeps `accepted` (blocking + non-blocking) but only converts the **blocking** subset to canonical `Finding[]` (`normalizedFindings = toAdversarialReviewFindings(blocking)`). With `blockingThreshold: "error"` (default), every `warning`/`info` finding the reviewer already produced is computed, then dropped on the floor. They sit in the review-audit JSON, unconsumed.

The obvious fix — promote warnings to blocking so the existing rectification cycle fixes them — is unsafe:

1. **Goalpost drift.** Making the subjective reviewer able to block on anything turns "done" into "the reviewer is satisfied" — non-deterministic and unbounded; runs may never converge.
2. **Green→red flips from reviewer nondeterminism.** The existing rectification revalidation re-runs the LLM reviews (`STRATEGY_TO_REVALIDATION_PHASES`, `story-orchestrator.ts:484,488`). Re-running a nondeterministic critic on near-identical code can surface a *new* `error` finding, demoting a passing story to failing for no real regression. `phasesToRevalidate` even **falls back to all phases (incl. reviews) for any unregistered strategy** (`:519-522`) — a latent trap.

nax's goal is full automation, so "surface the findings to a human report" is a non-answer — it reintroduces the manual step we are trying to delete.

## Decision

**Introduce `nonBlockingFix`: a bounded, best-effort, non-blocking auto-fix pass over sub-threshold adversarial findings, gated by deterministic re-validation only, that restores to the adversarial-passed state on exhaustion. The blocking gate is unchanged; the run's definition of "done" does not move.**

### 1. Decouple "block" from "fix"

`block` (does the run fail?) and `fix` (do we attempt a change?) become independent. The gate stays `error + ACs + tests`. Sub-threshold findings, previously dropped, get a best-effort fix attempt that **can never fail the story**.

### 2. Adversarial-only

The feature acts only on adversarial findings. Semantic review is AC-grounded by design; off-AC best-effort fixing does not fit it. Config lives under `review.adversarial`.

### 3. Deterministic-only re-validation — never re-run the LLM reviews

After a best-effort fix, re-validate with `lint` + `typecheck` + `full-suite-gate` (and `verifier` per §7), **never** `semantic-review` / `adversarial-review`. A deterministic red is trustworthy (real regression → revert); a review red may be a phantom (reviewer variance) and is unrevertable. This eliminates the green→red flip and the non-termination risk in one stroke.

### 4. Bounded, transactional

One best-effort fix plus `regressionAttempts` (default 1) source/test fix attempts to clear any regression the fix introduced. The whole pass is a single transaction.

### 5. Restore to adversarial-passed; floor = adversarial-passed

Take **one snapshot at pass entry** (= the adversarial-passed working tree). On exhaustion, **restore files and `phaseOutputs`** to that snapshot and let the story pass. The adversarial-passed state already cleared tests, lint, typecheck, **and** both reviews, so the worst case of the whole feature is "nothing changed" — identical to today. Restore must roll back `phaseOutputs`, not just files (`story-orchestrator.ts:967` confirms validate writes gate/verifier results into `phaseOutputs`, which feed final success).

### 6. Reuse, don't rebuild

The fix loop already exists. `runRectification` (`story-orchestrator.ts:941`) is parameterized into the best-effort pass: same `runFixCycle`, same `autofix-implementer` / `autofix-test-writer` strategies, same `phasesToRevalidate` / `classifyOutcome`, same `toAdversarialReviewFindings` adapter. The review-strip is achieved purely by passing a `validationPhases` set that excludes the review phases (the intersection in `phasesToRevalidate` drops them — no new logic). The only genuinely new code is the entry-snapshot/restore and the config.

### 7. Configurable scope and verifier-guard

`scope: "source" | "both"` (default `both`): `source` runs `autofix-implementer` only; `both` adds `autofix-test-writer`. Because §3 strips the adversarial re-run that today polices test edits in the blocking cycle, `both` needs a deterministic substitute: `verifierGuard: boolean` (default `true`) adds the `verifier` to revalidation when a test edit occurs and a verifier exists (three-session / lite TDD). In single-session there is no verifier, so the guard degrades to `full-suite-gate` + a diff cap.

### 8. Config

```ts
review.adversarial.nonBlockingFix?: {
  enabled: boolean;             // default false (opt-in; ramp to true after validation)
  scope: "source" | "both";     // default "both"
  regressionAttempts: number;   // default 1
  verifierGuard: boolean;       // default true
}
```
Per-package overridable (ADR-009 layering).

## Consequences

### Positive

- **Recovers findings nax already generates** at near-zero detection cost — they exist in `accepted` today and are discarded.
- **Goalpost does not move.** The blocking gate is byte-identical; only the previously-dropped findings get a best-effort, non-blocking pass.
- **Floor = adversarial-passed.** The feature can only move a story up or sideways, never down. On any doubt, it reverts to fully-reviewed code.
- **~90% reuse.** Parameterized `runRectification` + existing strategies; new code is snapshot/restore + config.

### Negative

- **Kept fixes ship un-reviewed.** Because §3 never re-runs the review, a fix that lands green was not re-seen by the critic. Mitigated by minimal-edit scoping, a diff cap, and `verifierGuard` for test edits — but the residual is real.
- **`both` weakens the test-edit guard in single-session.** No verifier exists there; the guard is `full-suite-gate` + diff-cap, which does not catch test-gutting as strongly. Recommend `source` default or a warning for single-session.
- **Cost.** One extra fix call + one extra gate run per story with sub-threshold findings; doubled when a regression attempt fires. Bounded; no tier escalation.
- **Snapshot/restore correctness is load-bearing.** Restore must cover new files (`git clean`, scoped) and `phaseOutputs` (desync guard), and must run before verdict-finalize / worktree merge. A partial restore fails a green story.

### Neutral

- **Blocking rectification cycle is untouched.** It keeps its review-inclusive revalidation; only the new best-effort pass strips reviews.
- **Deterministic-rules layer is complementary, tracked separately** (see Open Questions) — lint rules for mechanical conventions, a spec-conformance gate for signature drift. Those handle a different slice (e.g. bare-except, out-of-spec signatures) deterministically and reduce what reaches `nonBlockingFix`.

## Alternatives Considered

### A. Status quo — keep dropping sub-threshold findings
Zero cost, zero benefit. Real bugs continue to escape green runs. Rejected.

### B. Promote warnings to blocking
Reuses the existing cycle directly but moves the goalpost, risks non-termination, and (via review re-run) flips green stories red on reviewer variance. Rejected — this is the failure mode §3 exists to prevent.

### C. Surface sub-threshold findings to an end-of-run report
Cheapest, zero flow risk — but reintroduces the manual review step. Contradicts the full-automation goal. Rejected.

### D. Repro-test execution-substantiation pipeline
Reviewer (or a repro-writer) emits a failing test per finding; execute-substantiate (fail on HEAD = real, pass = hallucination → discard); materialize and drive to green. Highest assurance — proof before fix. Rejected for now: executes LLM-authored code during review, low repro yield on fixture/cassette-heavy repos, large new surface area. It is a strict superset of the chosen design (it adds a proof-gate on *which* findings to fix) and can be layered on later if telemetry shows the best-effort pass making bad changes.

### E. Non-blocking best-effort fix (chosen)
Decouple block from fix; best-effort, deterministic-gated, transactional, restore-to-adversarial-passed. Lowest blast radius (floor = today), highest reuse. Selected.

## Open Questions

1. **`enabled` default.** Ship opt-in (`false`) and ramp to `true` after validating signal quality on real runs, or default on? Leaning opt-in.
2. **Deterministic-rules-first layer.** Lint rules (bare-except, etc.) and a post-implementation spec-conformance gate (signature drift) handle a complementary slice deterministically. Same-PR or separate track? Leaning separate.
3. **Diff cap value.** The minimal-edit cap (files/lines) that triggers restore-over-keep — needs a default; tune from real runs.
4. **Single-session `both`.** Default to `source` there, or keep `both` with diff-cap-only and a warning?

## Implementation

See SPEC-non-blocking-adversarial-fix.md for the phased plan, ACs, the `runRectification` parameterization, the `:482-489` advisory-findings change, snapshot/restore invariants, and the `review.adversarial.nonBlockingFix` schema.
