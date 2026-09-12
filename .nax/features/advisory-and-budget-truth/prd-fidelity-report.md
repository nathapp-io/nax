# Spec Review — Phase 9 (PRD Fidelity)

**Spec:** `docs/specs/SPEC-advisory-and-budget-truth.md`
**PRD:** `.nax/features/advisory-and-budget-truth/prd.json` (`nax plan` run 3, 2026-09-12T03:07:46Z, `--profile native`, plus one surgical AC patch)
**Reviewed against:** nax @ `a35c52875`
**Date:** 2026-09-12
**Phases run:** 9 only (1–8 ran during the drafting handoff)
**Verdict:** ✅ ready — 0 blockers, 0 majors, 2 minors

## Summary

| check | result |
|:---|:---|
| 1. Spec AC → PRD AC mapping | ✅ 31/31, 1:1 and in order (10 / 15 / 6) |
| 2. Behavioural fidelity + signature reality | ✅ no degradation, no grep-style rewrite, no hallucinated arity |
| 3. Orphan PRD ACs | ✅ none — run 3 mapped 1:1 with no planner additions |
| 4. File-role delta | ✅ 13/13 spec `Context Files` present, 1/1 `expectedFiles`, no self-`Creates` misplacement |
| 5. Meta-AC + correction survival | ✅ all 3 corrections reached `description`, none stranded in `analysis` |
| 5c. PRD-AC satisfiability (Class B) | ✅ all 4 invocation ACs establish the real guard chain |
| 6. Out-of-scope preservation | ✅ 7/7 present, none inverted, no story contradiction |
| 7. Terminal-cleanup story | n/a — spec declares none |
| 8. `Modifies` → `modifiedFiles` by path | ✅ 6 paths → 6 entries, `path` + `reason` populated |
| minors | 2, both cosmetic — see below |

## Resolution log — two majors, both closed

**Major 1 — the semantic-only state was specified in prose and pinned by no AC.**
The availability gate is `const advCfg = this.state.adversarialReview ? this.state.nonBlockingFix : undefined;` (`execution-plan.ts:396`), and `state.adversarialReview` is populated only when `review.enabled === true && review.checks.includes("adversarial") && !!review.adversarial` (`plan-inputs.ts:389-392`). Under a semantic-only config, `advCfg` is `undefined` and nbf never runs **whatever `sources` says**. The original 12 US-002 ACs varied `sources`, the buckets and the green precondition but never the reviewer *slots*, so an implementation that unioned the buckets correctly and left the gate in place would pass all of them with semantic-only still dead — two of the four required operator states shipping broken behind a green run. The requirement existed only as `description` prose, which is the unpinned-design-mandate shape: quotable by semantic review, reachable by no test.

Closed by spec AC-13 / AC-14 (US-002), which run 3 carried through verbatim — including AC-14's discriminating clause, *"confirming the pass is gated by `sources` rather than by which reviewer slots the config happens to declare."* AC-13 alone would admit an "either slot" widening; the pair forces `sources` to be the only gate.

**Major 2 — an unpinned Failure Handling row, opened at the run-3 re-check.**
The row *"`sources` is empty, or no named source produced actionable findings | nbf does not run"* had no covering AC. Run 2 had backfilled two ACs for it on the planner's own initiative; run 3, receiving 14 ACs, mapped 1:1 and backfilled nothing. Planner backfill is therefore not a contract — it varied between two runs of the same profile over near-identical specs, and treating run 2's generosity as coverage was a mistake in the first Phase 9 pass. The nearest remaining cover was US-002 AC-2 (`sources: ["adversarial"]` with only semantic findings → empty list, nbf should not run), which exercises "no named source produced findings" incidentally but never the empty-`sources` array.

Closed by spec AC-15 (US-002).

## Patch provenance — AC-15 was hand-applied, not re-planned

At the user's instruction AC-15 was patched into both artefacts rather than driven through a fourth plan run.

- **Spec:** `## Acceptance Criteria` § US-002, item 15, tagged `[unit]`.
- **PRD:** `userStories[US-002].acceptanceCriteria[14]`, in the planner's Given/When/Then voice.

Verification performed:

- diff against a snapshot taken immediately before the edit shows **exactly one added array element and no other change** — no reformatting, no key reordering, no timestamp churn;
- `validatePlanOutput(raw, "advisory-and-budget-truth", "feat/advisory-and-budget-truth")` accepts the result: 3 stories, 10 / 15 / 6 ACs, 7 `outOfScope`, 6 `modifiedFiles` on US-001;
- the spec and PRD wordings were re-read side by side to confirm the same symbol, input class and asserted outcome.

**Caveat.** `acceptanceCriteria` is a planner-authored field. Any future `nax plan -f advisory-and-budget-truth` regenerates it, and AC-15 survives only if the planner re-derives it from the spec — which it should, since the spec is the source and now carries it. Until then, equivalence for this one AC rests on the hand edit rather than on the planner's mapping. `modifiedFiles` is the only PRD field this phase's checklist sanctions patching in place; this went further, deliberately and on request.

## Minor — US-002's `**Interface**` block foregrounds unchanged signatures

The block leads with `actionableAdvisoryFindings` and `shouldRunNonBlockingFix` — existing signatures this story does not alter, carried over from the spec's *read-only* Integration listing — while the story's actual new export (the `nbf-seed.ts` derivation) appears only in trailing prose. Both signatures are accurate and contradict no AC, so this is not the baseline-without-target failure; the emphasis is simply inverted. No action needed before `nax run`.

## Minor — a feature-level sentence is copied into two story descriptions

US-002 and US-003 each open an `**Approach**` bullet with *"Two independent changes, no shared module. The nbf work is a config move plus one extracted seam; the static-rules work is a log-wording change with no behavioural effect."* Inside a single story's description that describes work its implementer cannot see. Harmless; worth trimming only if the spec is revised again.

## Detail — checks that passed non-trivially

**AC mapping (check 1).** 10→10, 15→15, 6→6, each in document order, with no planner additions or merges. Every AC was rewritten into Given/When/Then form with the symbol, input class and asserted outcome preserved — e.g. spec US-001 AC-2 (*"`sources` equal to a single-element list containing `"adversarial"`"*) → PRD *"then its `sources` is `["adversarial"]`"*.

**Failure Handling coverage (check 2 / Phase 4 carry-over).** All five rows of the spec's `### Failure Handling` table now trace to an AC: disabled/absent source → US-002 AC-7; empty `sources` / no actionable findings → US-002 AC-15; both config locations set → US-001 AC-7; same defect in both buckets → US-002 AC-4; retired semantic advisory → US-002 AC-5.

**Correction survival (check 5b).** All three drafting-round corrections reached run-time-visible fields verbatim: the `.default()`-makes-`sources`-required cascade and the rejected `.optional()` alternative → US-001 `description`; the 600-line `SRC_LIMIT` extraction mandate → US-002 `description`; the `droppedCount` soft-mode documentation target → US-003 `description` and `**Interface**`. None appears only in `analysis`.

**Class B satisfiability (check 5c).** Four invocation-shaped ACs, all with both endpoints already existing (the nbf runner; the story-orchestrator phase-completion path): US-002 AC-9, AC-10, AC-13, AC-14. Each establishes the real guard chain from `execution-plan.ts:405-408` — rectification enabled, a story id set, nbf enabled — and AC-13/AC-14 additionally pin the `review.checks` membership that decides the reviewer slots. AC-15 asserts the seed's return value rather than an invocation, so the trace does not apply to it.

**Out of scope (check 6).** All 7 spec bullets present, wording intact, including the 7th (category filtering deferred to #1359, citing the `acDropped`/#1801 precedent at `non-blocking-fix.ts:66-71`). No exclusion surfaced as an AC — a targeted scan for category-filter and out-of-scope ACs came back empty, and US-003 AC-4 asserts `budgetPressure.droppedCount` is *unchanged*, which enforces exclusion 2 rather than inverting it. Story-level `outOfScope` arrays and the planner's `**Scope** — Out:` bullets are consistent with the feature list; none claims deferred work is in scope. The spec declares no per-story deferrals, so the `US-00N only:` prefix rule does not apply.

**File roles (check 4).** Every spec `Context Files` entry reached the matching story's `contextFiles`. US-003 gained two the spec did not list — `test/unit/context/engine/providers/static-rules.test.ts` and `test/unit/log-format/run-summary.test.ts` — both existing and both genuinely the right reading for that story (the first holds the soft-mode `droppedCount` assertion, the second the message-text fixture); per check 4d that is a helpful addition, not a finding. Neither appears in a `Modifies` entry, which is correct: US-003 changes log wording only, and `run-summary.test.ts` builds its own log record rather than calling the provider, so nothing there needs editing.

**Modifies (check 8).** Six distinct spec paths → six `modifiedFiles` entries on US-001, one per path, each with `path` and `reason`. No `reason` opens mid-sentence, so no path was swallowed by a multi-path bullet. Reasons carry the spec's full text including each replacement invariant.
