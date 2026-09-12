# Spec Review — Phase 9 (PRD Fidelity)

**Spec:** `docs/specs/SPEC-advisory-and-budget-truth.md`
**PRD:** `.nax/features/advisory-and-budget-truth/prd.json`
**Reviewed against:** nax @ `3fd96053e`
**Date:** 2026-09-12
**Phases run:** 9 only (1–8 ran during the drafting handoff)
**Verdict:** ✅ ready — 0 blockers, 0 majors, 1 minor (re-checked after re-plan + surgical patch)

## Summary

| check | result |
|:---|:---|
| 1. Spec AC → PRD AC mapping | ✅ 31/31 mapped, 1:1 and in order (10/15/6) |
| 2. Behavioural fidelity + signature reality | ✅ no degradation, no grep-style rewrite, no hallucinated arity |
| 3. Orphan PRD ACs | ✅ 2 additions, both traceable to a Failure Handling row |
| 4. File-role delta | ✅ 13/13 `contextFiles`, 1/1 `expectedFiles`, no self-`Creates` misplacement |
| 5. Meta-AC + correction survival | ✅ all corrections reached `description`, none stranded in `analysis` |
| 5c. PRD-AC satisfiability (Class B) | ✅ both invocation ACs establish the real guards |
| 6. Out-of-scope preservation | ✅ 6/6 present, none inverted, no story contradiction |
| 7. Terminal-cleanup story | n/a — spec declares none |
| 8. `Modifies` → `modifiedFiles` by path | ✅ 6 paths → 6 entries, `path` + `reason` populated |
| — | ✅ both majors closed — see Resolution log |

## RESOLVED (was major) — the semantic-only state is specified in prose but pinned by no AC

**PRD reference:** US-002 `description`, `**Scope** — In:` … *"read canonical nbf config and construct nbf strategies whenever either review slot is present rather than requiring the adversarial slot"*.

**Spec reference:** `## Design` § Approach states the four operator states (adversarial-only, semantic-only, both, neither). No AC in US-002 covers the third and fourth.

**Codebase reality:** the availability gate is `const advCfg = this.state.adversarialReview ? this.state.nonBlockingFix : undefined;` (`src/execution/story-orchestrator/execution-plan.ts:396`). `state.adversarialReview` is only populated when `adversarialEnabled` holds — `review.enabled === true && review.checks.includes("adversarial") && !!review.adversarial` (`src/execution/plan-inputs.ts:389-392`). So under a semantic-only config (`checks: ["semantic"]`), `advCfg` is `undefined` and nbf never runs **whatever `sources` says**.

**Why it matters:** all 14 US-002 ACs presuppose nbf is reachable — they vary `sources`, the buckets, and the green precondition, never the reviewer *slots*. An implementation that unions the buckets correctly and leaves the `adversarialReview` gate in place passes every one of the 14, and semantic-only stays dead. The PRD states the requirement only as `description` prose, which is the unpinned-design-mandate shape: semantic review can quote it verbatim while no test reaches it, so the story goes green on tests and then blocks in rectification.

**Recommended fix:** add one AC to US-002 — *"Given a config that enables only semantic review (`review.checks` containing `semantic` and not `adversarial`), with nbf enabled and `sources` naming `semantic`, when a story completes green with one actionable semantic advisory, then the nbf runner is invoked once with that finding."* Re-plan after the spec edit; do not hand-patch `prd.json`, since `acceptanceCriteria` is planner-authored.

## Resolution log

**Major 1 — semantic-only gate unpinned.** Closed by spec AC-13/AC-14 (US-002), added 2026-09-12 and carried through `nax plan` run 3 verbatim, including AC-14's discriminating clause ("gated by `sources` rather than by which reviewer slots the config happens to declare"). AC-13 alone would admit an "either slot" widening; the pair forces `sources` to be the only gate.

**Major 2 — unpinned Failure Handling row (opened at the run-3 re-check).** The row "`sources` is empty, or no named source produced actionable findings | nbf does not run" had no covering AC. Run 2 had backfilled two ACs for it on the planner's own initiative; run 3, receiving 14 ACs, mapped 1:1 and backfilled nothing — proving planner backfill is not a contract and varies between identical invocations of the same spec. Closed by spec AC-15 (US-002).

**Patch provenance.** AC-15 was applied surgically to both artefacts rather than by a fourth plan run, at the user's instruction. The spec carries it as `[unit]` AC-15; `prd.json` carries the matching Given/When/Then entry as `userStories[US-002].acceptanceCriteria[14]`. Verified: diff against a pre-patch snapshot shows exactly one added array element and no other change; `validatePlanOutput` accepts the result (3 stories, 10/15/6 ACs, 7 outOfScope, 6 modifiedFiles on US-001).

**Caveat on the hand-patch.** `acceptanceCriteria` is a planner-authored field. Any future `nax plan -f advisory-and-budget-truth` regenerates it and will drop AC-15 from `prd.json` unless the planner re-derives it from the spec — which it should, since the spec is the source and now carries AC-15. Spec↔PRD equivalence for this one AC rests on the hand edit being faithful rather than on the planner's own mapping; the wording pair is recorded above so it can be re-checked.

## Minor — US-002's `**Interface**` block foregrounds unchanged signatures

The block leads with `actionableAdvisoryFindings` and `shouldRunNonBlockingFix` — existing signatures this story does not alter, carried over from the spec's *read-only* Integration listing — while the story's actual new export (the `nbf-seed.ts` derivation) appears only in the trailing prose. Both signatures are accurate and contradict no AC, so this is not the baseline-without-target failure; the emphasis is simply inverted. No action required before `nax run`.

## Minor — a feature-level sentence is copied into two story descriptions

US-002 and US-003 both open an `**Approach**` bullet with *"Two independent changes, no shared module. The nbf work is a config move plus one extracted seam; the static-rules work is a log-wording change with no behavioural effect."* That is a feature-level framing sentence; inside a single story's description it describes work the implementer cannot see. Harmless, worth trimming if the spec is revised for the major above.

## Detail — checks that passed non-trivially

**AC mapping (check 1).** US-001 10→10, US-002 12→14, US-003 6→6, each in document order. The planner rewrote every AC into Given/When/Then form while preserving the symbol, the input class and the asserted outcome — e.g. spec US-001 AC-2 (*"`sources` equal to a single-element list containing `"adversarial"`"*) → PRD *"then `sources` equals `["adversarial"]`"*.

**Orphans (check 3).** US-002 gained P13 (`sources` empty → no findings, nbf does not run) and P14 (every selected source empty → nbf does not run). Both are the two clauses of the spec's Failure Handling row *"`sources` is empty, or no named source produced actionable findings | nbf does not run"* split into separate assertions. Traceable, not scope bleed. All five Failure Handling rows now carry a covering AC.

**Correction survival (check 5b).** The three corrections from the drafting round all reached run-time-visible fields, verbatim:
- the `.default()`-makes-`sources`-required cascade and the rejected `.optional()` alternative → US-001 `description`;
- the 600-line `SRC_LIMIT` extraction mandate → US-002 `description`;
- the `droppedCount` soft-mode documentation target → US-003 `description` and `**Interface**`.

None appears only in `analysis`.

**Class B satisfiability (check 5c).** US-002 P9/P10 are the only invocation-shaped ACs, and both endpoints already exist (the nbf runner; the story-orchestrator phase-completion path). P9 establishes rectification enabled, a story id set, and nbf enabled — matching the real guard chain at `execution-plan.ts:405-408`. P13/P14 assert the seed's return value, not an invocation, so the trace does not apply.

**Out of scope (check 6).** All 6 spec bullets present in `prd.outOfScope`, wording intact. No exclusion surfaced as an AC — note US-003 P4 asserts `budgetPressure.droppedCount` is *unchanged*, which enforces exclusion 2 rather than inverting it. Story-level `outOfScope` arrays (2/3/3) and the planner's `**Scope** — Out:` bullets are all consistent with the feature list; none claims deferred work is in scope. No spec-side per-story deferrals exist, so the `US-00N only:` prefix rule does not apply.

**Modifies (check 8).** Six distinct paths in the spec block → six `modifiedFiles` entries on US-001, one per path, each with `path` and `reason`. No `reason` opens mid-sentence, so no path was swallowed by a multi-path bullet. Reasons carry the spec's full text including the replacement invariant.
