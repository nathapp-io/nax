<!-- spec-writing: completed-through-phase-6 -->
# SPEC: Category-Based fixTarget Triage for the Non-Blocking Fix

## Summary

Add `scope: "triage"` to `review.adversarial.nonBlockingFix`: an opt-in mode that routes advisory adversarial findings to the implementer (source fix) or the test-writer (test fix) **by finding `category`**, instead of sending every adversarial finding to the test-writer. The category→fixTarget decision reuses the existing `BLOCKING_CATEGORIES` SSOT. The routing change is isolated to the non-blocking strategy set via default-preserving factory options; the blocking rectification cycle, `scope: "source"`, and `scope: "both"` are byte-identical. A minimal `sourceDiffCap` bounds the un-reviewed source edits that triage newly enables, and the review-audit is extended to record each finding's `fixTarget`. Default stays `both`; `triage` is opt-in.

## Motivation

ADR-024's `scope: "both"` builds the non-blocking strategy set so the **test-writer owns every adversarial finding** (`build-plan-for-strategy.ts:246-253`, implementer `includeAdversarialReview: false`), because the test-writer's `appliesTo` claims any `source === "adversarial-review"` finding unconditionally (`autofix-test-writer-strategy.ts:18`). The per-finding `fixTarget` never governs routing.

A pass over 147 adversarial review-audits (rs-stock + nathapp-nestjs-platform, 2026-06-13 → 06-17) shows the advisory stream that `nonBlockingFix` consumes is **~47% source-defect categories** (`input`/`error-path`/`abandonment`/`assumption`) and only ~25% `test-gap` — the inverse of the blocking stream (68% `test-gap`), for which the "test-writer owns adversarial" default was implicitly tuned. Observed effect: real source defects the reviewer flagged (`SqliteCache.stats()` hardcoding zero counts, a lock-free `get_info()` read race, empty-string primary keys accepted unvalidated, data-losing `quarantine_fundamentals()`) were never fixed — the test-writer tightened assertions *around* the buggy behavior and the source bugs merged.

The fix is to route by category. nax already maintains the source/advisory taxonomy (`BLOCKING_CATEGORIES = {input, error-path, abandonment, assumption}`, `ac-structural-counterfactual.ts:25`), and `FixStrategy.appliesTo` is documented to discriminate "by source, category, fixTarget, or file pattern" (`cycle-types.ts:120`). The signal exists; it is simply not populated for adversarial findings (only `test-gap → "test"` today, `adversarial-helpers.ts:108`) and is overridden by the test-writer's blanket clause.

Full rationale, evidence table, and alternatives: `docs/adr/ADR-024-followup-category-triage.md`.

### Non-Goals

- **No change to the blocking rectification cycle.** Blocking routing stays session-mode based and byte-identical. Blocking inherits accurate `fixTarget` tags but continues to ignore them.
- **No change to `scope: "source"` or `scope: "both"` semantics.** They remain as conservative overrides.
- **No default flip.** `triage` ships opt-in; default stays `both` (ADR-024 Open Question 1 ramp).
- **No per-finding `fixTarget` config knob.** `fixTarget` is the reviewer's classification; the category→fixTarget map is a code SSOT, not user config.
- **No `convention` sub-splitting.** `convention` routes to the test-writer (current behavior); a future source/test sub-split is out of scope.

## Design

### Approach

`categoryToFixTarget(category)` is a pure, deterministic map (not an LLM call), backed by `BLOCKING_CATEGORIES`:

| category | fixTarget | rationale |
|:--|:--|:--|
| `input`, `error-path`, `abandonment`, `assumption` | `"source"` | the `BLOCKING_CATEGORIES` source-defect set |
| `test-gap` | `"test"` | test quality — the test-writer's lane |
| `convention` | `"test"` | conservative: stays on the test-writer (ambiguous bucket, never routed to un-reviewed source) |
| unrecognized | `"test"` | safe default — never route an unknown category to source editing |

Routing under `scope: "triage"`: the implementer claims `fixTarget === "source"` adversarial findings; the test-writer claims `fixTarget === "test"` adversarial findings; `full-suite-rectify` recovers regressions — exactly one strategy claims each finding.

### Integration

Verified symbols and signatures (extension touchpoints):

| Symbol / file | Current shape | Change |
|:--|:--|:--|
| `BLOCKING_CATEGORIES` — `src/review/ac-structural-counterfactual.ts:25` | `ReadonlySet<string>` = `{input, error-path, abandonment, assumption}` | **read** — SSOT source-category set, reused by `categoryToFixTarget` |
| `FixTarget` / `Finding.fixTarget` — `src/findings/types.ts:161` | `fixTarget?: FixTarget` (`"source" \| "test"`) | **read** — target type |
| `toAdversarialReviewFindings` — `src/review/adversarial-helpers.ts:94` | sets `fixTarget: f.category === "test-gap" ? "test" : undefined` | **modify** — replace with `categoryToFixTarget(f.category)` |
| `llmFindingsToReviewFindings` / `llmFindingToReviewFinding` — `src/review/finding-projection.ts:104,121` | builds `ReviewFinding`, does **not** set `fixTarget` | **modify** — set `fixTarget` via the same map (feeds the audit) |
| `ReviewFinding` — `src/plugins/extensions.ts:20` | `{ ruleId, severity, file, line, message, category?, source?, meta? }` — **no `fixTarget`** | **modify** — add optional `fixTarget?: FixTarget` (additive; plugin-facing) |
| `ReviewAuditEntry.result.findings` — `src/review/review-audit.ts:58` | `{ passed: boolean; findings: unknown[] } \| null` | **read** — no schema change; `fixTarget` rides through `unknown[]` once `ReviewFinding` carries it |
| `nonBlockingFix` schema — `src/config/schemas-review.ts:129` | `scope: z.enum(["source","both"]).default("both")` | **modify** — add `"triage"`; add `sourceDiffCap` |
| `NonBlockingFixConfig` — `src/config/selectors.ts:143` | derived from schema | **read** — type updates automatically |
| `nonBlockingExtraPhases` — `src/execution/non-blocking-fix.ts` | `cfg.scope === "both" && cfg.verifierGuard ? ["verifier"] : []` | **modify** — apply verifier guard under `"triage"` too |
| nbf strategy build — `src/execution/build-plan-for-strategy.ts:234-258` | `source`/`both` branches | **modify** — add `triage` branch |
| `makeAutofixTestWriterStrategy` — `src/operations/autofix-test-writer-strategy.ts:11` | `(story, config, sink)`, `appliesTo` claims all adversarial | **modify** — add default-preserving options object; option to disable the blanket adversarial clause |
| `makeAutofixImplementerStrategy` — `src/operations/autofix-implementer-strategy.ts:27` | `(story, config, sink, { includeAdversarialReview? })` | **modify** — option to claim `fixTarget === "source"` adversarial findings |
| `runNonBlockingFix` / `NonBlockingFixDeps` — `src/execution/non-blocking-fix.ts:62` | `_deps = { captureSnapshotRef, rollbackToRef }` | **modify** — add `measureSourceDiff` dep; enforce `sourceDiffCap` before keep |

Pattern to mirror: the existing `source`/`both` branches in `build-plan-for-strategy.ts:234-258` already build scope-specific strategy sets with a private `nbSink` and `nbPostValidate` — the `triage` branch follows the same shape. Default-preserving factory options follow `makeAutofixImplementerStrategy`'s existing `AutofixImplementerStrategyOptions` pattern (`autofix-implementer-strategy.ts:13-25`).

### Worked skeleton — `categoryToFixTarget` (novel SSOT helper)

```typescript
// src/review/category-fix-target.ts
import { BLOCKING_CATEGORIES } from "./ac-structural-counterfactual";
import type { FixTarget } from "../findings/types";

/**
 * Maps an adversarial finding category to the fix lane that owns it.
 * SSOT: the "source" set IS `BLOCKING_CATEGORIES` — never a hand-copied list.
 * `convention` and any unrecognized category default to "test" (conservative:
 * the implementer never receives an ambiguous/unknown finding for un-reviewed
 * source editing).
 */
export function categoryToFixTarget(category: string | undefined): FixTarget {
  return category != null && BLOCKING_CATEGORIES.has(category) ? "source" : "test";
}
```

### Failure Handling

- **Floor unchanged.** Snapshot at pass entry → restore files + `phaseOutputs` on exhaustion (`non-blocking-fix.ts:73,93-98`). Worst case remains "nothing changed."
- **Source-diff over cap → restore-over-keep.** A best-effort pass whose **source** diff (test files excluded via `resolveTestFilePatterns`, never an inline regex) exceeds `sourceDiffCap` is treated as exhausted → restored. This is the only new failure path; it is fail-safe (defaults to restore).
- **Unknown category → `"test"`** (never routed to the implementer).
- **`measureSourceDiff` errors** are treated as "cap exceeded" → restore (fail-safe).

## Stories

Dependency chain: **US-001 → US-002 → US-004**; **US-003 → US-004**; **US-003 → US-005**. No removal keywords — no terminal-cleanup story.

- **US-001 — `categoryToFixTarget` SSOT helper.** New pure function reusing `BLOCKING_CATEGORIES`.
  - Context Files: `src/review/ac-structural-counterfactual.ts`, `src/findings/types.ts`
  - Creates: `src/review/category-fix-target.ts` (and export line in `src/review/index.ts`)
  - Depends on: none

- **US-002 — Tag adversarial findings + persist `fixTarget` in the audit.** Both LLM→Finding converters use `categoryToFixTarget`; the review-audit records `fixTarget`. This is also the post-hoc observability for triage.
  - Context Files: `src/review/category-fix-target.ts` (created by US-001, integrated here), `src/review/adversarial-helpers.ts`, `src/review/finding-projection.ts`, `src/plugins/extensions.ts`, `src/review/review-audit.ts`
  - Depends on: US-001

- **US-003 — `scope: "triage"` config + verifier guard.** Add the enum value and `sourceDiffCap`; extend `nonBlockingExtraPhases` to apply the verifier guard under `triage`.
  - Context Files: `src/config/schemas-review.ts`, `src/config/selectors.ts`, `src/execution/non-blocking-fix.ts`
  - Depends on: none

- **US-004 — Triage routing + default-preserving factory options.** Build the `triage` strategy set; add options so the test-writer can disable its blanket adversarial clause and the implementer can claim `fixTarget === "source"` adversarial findings. Defaults reproduce today's behavior (so `both`, `source`, and the blocking set are unchanged).
  - Context Files: `src/execution/build-plan-for-strategy.ts`, `src/operations/autofix-test-writer-strategy.ts`, `src/operations/autofix-implementer-strategy.ts`, `src/findings/cycle-types.ts`
  - Depends on: US-002 (findings must carry `fixTarget`), US-003 (`triage` enum value)

- **US-005 — Source-edit diff-cap.** Enforce `sourceDiffCap` in `runNonBlockingFix`: measure the best-effort pass's source diff; exceed → restore-over-keep.
  - Context Files: `src/execution/non-blocking-fix.ts`, `src/config/schemas-review.ts`, `src/test-runners/resolver.ts`
  - Depends on: US-003 (`sourceDiffCap` config field)

### Seams

- **`categoryToFixTarget` (US-001) → US-002.** US-002's converters must call US-001's helper. Seam invariant declared in US-002 AC2/AC3 (converter output for a source-category finding has `fixTarget === "source"`).
- **`fixTarget` on findings (US-002) → US-004 routing.** US-004's `appliesTo` tests consume findings tagged by US-002's map. Seam invariant declared in US-004 AC2/AC3.
- **`scope: "triage"` enum (US-003) → US-004 build branch.** Seam invariant declared in US-004 AC1 (triage scope produces an implementer+test-writer set).
- **Blocking-routing regression seam (US-004 AC6).** Proves the shared converter `fixTarget` change did **not** alter blocking routing.

## Acceptance Criteria

### US-001 — `categoryToFixTarget` SSOT helper

- `[unit]` `categoryToFixTarget` is importable from `@/review` and, called with `"abandonment"`, returns `"source"`.
- `[unit]` `categoryToFixTarget` returns `"source"` for each of `"input"`, `"error-path"`, and `"assumption"`.
- `[unit]` `categoryToFixTarget("test-gap")` returns `"test"`.
- `[unit]` `categoryToFixTarget("convention")` returns `"test"`.
- `[unit]` `categoryToFixTarget("some-unrecognized-category")` returns `"test"`.
- `[unit]` for every member of `BLOCKING_CATEGORIES`, `categoryToFixTarget(member)` returns `"source"`; for `"test-gap"` and `"convention"` it returns `"test"` (proves the source set is derived from the SSOT, not a hand-copied list).

### US-002 — Tag adversarial findings + persist `fixTarget` in the audit

- `[unit]` `toAdversarialReviewFindings` applied to an adversarial LLM finding with `category: "abandonment"` returns a `Finding` whose `fixTarget` equals `"source"`.
- `[unit]` `toAdversarialReviewFindings` applied to a finding with `category: "test-gap"` returns a `Finding` whose `fixTarget` equals `"test"`.
- `[unit]` `llmFindingsToReviewFindings` applied to an adversarial finding with `category: "input"` returns a `ReviewFinding` whose `fixTarget` equals `"source"` (the audit-side converter now carries `fixTarget`).
- `[unit]` for the same adversarial LLM finding, the `fixTarget` produced by `toAdversarialReviewFindings` equals the `fixTarget` produced by `llmFindingsToReviewFindings` (the two converters agree — no divergence).
- `[integration]` recording an adversarial review-audit entry for a finding with `category: "abandonment"` produces a `ReviewAuditEntry` whose corresponding finding carries `fixTarget` equal to `"source"`.

### US-003 — `scope: "triage"` config + verifier guard

- `[unit]` `AdversarialReviewConfigSchema` parses `{ nonBlockingFix: { enabled: true, scope: "triage" } }` successfully and the resolved `nonBlockingFix.scope` equals `"triage"`.
- `[unit]` constructing the `nonBlockingFix` config with `scope` unset yields `scope === "both"` (default unchanged).
- `[unit]` `AdversarialReviewConfigSchema` rejects `{ nonBlockingFix: { enabled: true, scope: "invalid" } }` (parse fails).
- `[unit]` `nonBlockingExtraPhases` called with `{ scope: "triage", verifierGuard: true, ... }` returns `["verifier"]`.
- `[unit]` `nonBlockingExtraPhases` called with `{ scope: "triage", verifierGuard: false, ... }` returns `[]`.

### US-004 — Triage routing + default-preserving factory options

- `[unit]` the non-blocking strategy set built for `scope: "triage"` contains a strategy named `"autofix-implementer"` and a strategy named `"autofix-test-writer"` (and `"full-suite-rectify"`).
- `[unit]` in the `triage` set, an advisory finding with `source: "adversarial-review"` and `fixTarget: "source"` satisfies the `autofix-implementer` strategy's `appliesTo` and does **not** satisfy the `autofix-test-writer` strategy's `appliesTo`.
- `[unit]` in the `triage` set, an advisory finding with `source: "adversarial-review"` and `fixTarget: "test"` satisfies the `autofix-test-writer` strategy's `appliesTo` and does **not** satisfy the `autofix-implementer` strategy's `appliesTo`.
- `[unit]` in the `triage` set, an advisory `convention` finding (`fixTarget: "test"`) satisfies the `autofix-test-writer` strategy's `appliesTo`.
- `[unit]` a test-writer strategy built with **default** options satisfies `appliesTo` for an adversarial finding with `fixTarget: "source"` (blanket adversarial claim preserved — `scope: "both"` and blocking unchanged).
- `[unit]` in the strategy set built for the **blocking** three-session cycle, an adversarial finding with `fixTarget: "source"` satisfies the `autofix-test-writer` strategy's `appliesTo` and does **not** satisfy the `autofix-implementer` strategy's `appliesTo` (blocking routing unchanged despite the new `fixTarget` tag).

### US-005 — Source-edit diff-cap

- `[unit]` constructing the `nonBlockingFix` config with `sourceDiffCap` unset yields the documented default (`maxFiles` and `maxLines` equal to their schema defaults).
- `[unit]` `runNonBlockingFix`, given a `measureSourceDiff` dep reporting a source change that exceeds `sourceDiffCap.maxLines` and a `runRectify` that did not exhaust, returns `{ ran: true, kept: false, restored: true }` and invokes the rollback dep.
- `[unit]` `runNonBlockingFix`, given a `measureSourceDiff` dep reporting a source change within `sourceDiffCap` and a non-exhausted `runRectify`, returns `{ ran: true, kept: true, restored: false }`.
- `[unit]` `runNonBlockingFix`, given a `measureSourceDiff` dep that throws, returns `{ ran: true, kept: false, restored: true }` (fail-safe: measurement failure restores).
- `[unit]` `runNonBlockingFix` with a diff whose changed files are all test files (zero source lines per `measureSourceDiff`) and a within-cap result returns `{ kept: true, restored: false }` (the cap counts source lines only).
