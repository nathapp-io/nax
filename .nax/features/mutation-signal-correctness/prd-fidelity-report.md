# Spec Review Phase 9 — PRD Fidelity

**Spec:** `docs/specs/SPEC-mutation-signal-correctness.md`
**PRD:** `.nax/features/mutation-signal-correctness/prd.json`
**Reviewed against:** nax @ `91c100b3`, branch `feat/mutation-signal-correctness`
**Date:** 2026-08-06
**Planner:** `nax plan --profile cross-agent-mm` (2nd attempt; 1st failed in `plan-refine`)
**Verdict:** ✅ ready — 0 blockers; 2 majors found and fixed; 3 minors accepted

---

## Summary

| Check | Result |
|:---|:---|
| 1. Spec AC → PRD AC mapping | ✅ 53/53 spec ACs present |
| 2. Behavioural fidelity + signature reality | ✅ no degradation, no signature contradictions |
| 3. Orphan PRD ACs | ⚠️ 1 minor — traceable to a Failure Handling row |
| 4. File-role delta | ⚠️ 2 majors — **fixed** |
| 5. Meta-AC / correction survival | ✅ n/a + ⚠️ 1 minor |
| 5c. PRD-AC satisfiability (Class B) | ✅ path verified |
| 6. Out-of-scope preservation | ✅ 12/12 verbatim |
| 7. Terminal-cleanup story | n/a — spec has none |

---

## Check 1 — Spec AC → PRD AC mapping

All 53 spec ACs survive into the PRD, 1:1 by story.

| Story | Spec ACs | PRD ACs | Mapping |
|:---|:---|:---|:---|
| US-001 | 13 | 13 | 1:1, order preserved |
| US-002 | 13 | 14 | 1:1 for 1-13, +1 planner-authored (see Check 3) |
| US-003 | 13 | 13 | 1:1, order preserved |
| US-004 | 14 | 14 | 1:1, order preserved |

No spec AC missing. No AC merged or split.

## Check 2 — Behavioural fidelity

Every PRD AC remains a runtime test case. The planner rewrote the leading clause
into `When <X>, it <Y>` / `Given <X>, when <Y>, <Z>` form but preserved every
symbol, input value, and expected output. No AC was degraded into a
file-content, grep, or shell assertion. No asserted arguments were dropped.

**Signature reality check** — PRD ACs name calls against these existing symbols;
all arities match the real definitions captured in Phase 2:

| Symbol | Real signature | PRD AC usage | Verdict |
|:---|:---|:---|:---|
| `generateMutants` | `(input: GenerateMutantsInput) => Mutant[]` | describes source/language inputs, not arity | ✅ |
| `classifyMutant` | `(result: VerificationResult) => MutantOutcome` | describes the result's fields | ✅ |
| `mutationCheckOp.execute` | `(input, ctx, deps) => Promise<MutationCheckOutput>` | "when `mutationCheckOp` executes" | ✅ |
| `runCompletionPhase` | `(options: RunnerCompletionOptions) => Promise<RunnerCompletionResult>` | "when `runCompletionPhase` executes" | ✅ |
| `selectEvenlySpaced` | new in US-002 | n/a — no existing signature to contradict | ✅ |
| `formatMutationSummary` | new in US-004 | n/a | ✅ |

## Check 3 — Orphan PRD ACs

### Minor — US-002 AC14 was authored by the planner

> `Given mutation checking with no candidates after selection, when mutationCheckOp executes, it returns success: true, empty survivors, all-zero outcomes, and runs no tests.`

**Not scope bleed.** It traces to a real spec source — the `### Failure Handling`
row *"No candidate mutants after selection | Return `success: true` with empty
survivors and all-zero outcomes; no test runs | US-002"*. The spec assigned that
row to US-002 but never wrote the covering AC, so the planner authored it in its
own words. This is precisely the behaviour the spec-writing guide's Rule 11
warns about; the authoring gap is mine, and the backfill is faithful.

Two consequences worth recording:

1. **It is compound** (four assertions) and overlaps AC13, which already asserts
   "never invokes regression" for the no-candidate case. Cosmetic at 14/16.
2. **It drove a dependency addition.** `outcomes` is US-003's contract, so the
   planner added `US-003` to US-002's `dependencies`. The spec declared only
   `US-001`. This is *correct* — the spec had a latent cross-story dependency it
   under-specified, and the planner resolved it. Graph re-verified as a valid
   DAG: `US-001, US-003 → US-002`; `US-003 → US-004`. No cycles.

## Check 4 — File-role delta

**4a — `Creates` → `expectedFiles`:** ✅ correct for both creating stories.
No self-created file appears in its own `contextFiles` (the blocker condition).

| Story | `expectedFiles` | Verdict |
|:---|:---|:---|
| US-002 | `src/verification/mutation/select.ts`, `test/unit/verification/mutation/select.test.ts` | ✅ |
| US-004 | `src/log-format/mutation-summary.ts`, `test/unit/log-format/mutation-summary.test.ts` | ✅ |

**4b — `Context Files` → `contextFiles`:** two existing files were dropped.

### Major (FIXED) — `src/verification/mutation/types.ts` dropped from US-003

**Spec reference:** US-003 § Context Files
**PRD reality:** absent from `userStories[US-003].contextFiles`; file exists on disk
**Impact:** US-003 changes `MutationCheckOutput` to add `outcomes`, and `MutantOutcome` is declared in this file. Without it the implementer works the type change blind.
**Fix applied:** restored to `contextFiles` (now 6 entries).

### Major (FIXED) — `src/log-format/index.ts` dropped from US-004

**Spec reference:** US-004 § Context Files
**PRD reality:** absent from `userStories[US-004].contextFiles`; file exists on disk
**Impact:** US-004 must re-export `formatMutationSummary` from the log-format barrel. Without the barrel in context the export is likely to be missed.
**Fix applied:** restored to `contextFiles` (now 6 entries).

**4d — Helpful additions (minor, positive).** The planner *added*
`test/unit/verification/mutation/classify.test.ts` and
`test/unit/operations/mutation-check.test.ts` to US-003's `contextFiles`. These
are the two files the spec's `### Modifies` block authorises the implementer to
edit; having them as reads is useful. Not a finding.

## Check 5 — Meta-AC and correction survival

**5 — Meta-ACs:** the spec contains none. n/a.

**5b — Correction survival.** All three spec-review corrections reached a
`description` or `acceptanceCriteria` entry — none is stranded in `analysis`.

| Correction | Destination | Verdict |
|:---|:---|:---|
| `### Modifies` block authorising two test-file edits | US-003 `description` | ✅ (hand-patched — see below) |
| US-002 AC12 rewritten to assert on `survivors`, not the non-injectable `applyMutant` | US-003 → US-002 AC12 verbatim | ✅ |
| `formatMutationSummary` stays pure; stdout write lives in `headless-formatter.ts` | US-004 `description` § Interface | ⚠️ minor — see below |

> **`### Modifies` did not survive `nax plan`** — the known behaviour. The two
> test files landed only in `contextFiles` (as *reads*), with the authorisation
> reduced to a vague Scope line, *"update existing tests that encode old
> no-count kills"*. Without the explicit block, US-003 deadlocks: the
> implementer hits two `classify.test.ts` assertions expecting `killed`, cannot
> edit them under test-authorship isolation, and gives up with a correct
> implementation. **Hand-patched back into US-003's `description`**, naming both
> files, both breaking assertions, and the exact edit required.

### Minor — the stdout-location half of the console.log correction is implicit

US-004's Interface preserves the load-bearing half — *"`formatMutationSummary`
… remains pure, returning a string without stdout writes"*. It does not restate
that the stdout write must live in `headless-formatter.ts` (the established
exception to the `.nax/rules/forbidden-patterns-source.md` `console.log` ban).
Accepted, not patched: `headless-formatter.ts` is in US-004's `contextFiles` and
the Approach says to mirror `outputAdvisoryFindingsSummary`, so the location is
adequately conveyed.

**5c — PRD-AC satisfiability (Class B trace).** Only US-002 AC11 and AC13 are
invocation-shaped ACs where *both* endpoints already exist (`mutationCheckOp` →
`regression`).

- **Path exists:** `src/operations/mutation-check.ts:142` calls
  `deps.regression({...})`, and `regression` is a member of `_mutationCheckDeps`.
- **Guard is established by the fixture:** the path requires
  `cfg.enabled === true`; the ACs' own fixtures set it, following existing
  precedent in `test/unit/operations/mutation-check.test.ts`
  (`ctxWithConfig({ mutationCheck: { enabled: true, … } })`).
- **Named method matches.** ✅ No blocker.

All other invocation ACs assert against symbols this spec creates
(`selectEvenlySpaced`, `formatMutationSummary`, `runtime.mutationSummaries`),
so Class B does not apply.

## Check 6 — Out-of-scope preservation

**6a — ✅ 12/12 preserved verbatim.** Every bullet from the spec's
`## Out of Scope` appears in `prd.outOfScope`, in order, with no merging or
truncation. Well under the 25-item cap.

**6b — n/a.** Field present and populated.

**6c — ✅ no exclusion became an AC.** Swept all 54 PRD ACs for the deferred
topics (changed-diff-line restriction, `operators.test.ts`, `revertMutant`
verification, SIGINT handling, `configuration.md` docs, parallelism, dedup,
`Finding` conversion, review-audit routing). Zero hits.

**6d — ✅ no story contradicts a feature-level exclusion.** Each story's
planner-emitted `**Scope** — Out:` bullet defers to a sibling story
(e.g. US-003: *"parser changes are not part of this story; candidate selection
is US-002; runtime reporting is US-004"*), consistent with the feature list.
The spec declares no per-story `**Out of scope:**` blocks, so the
`US-00N only:` prefix rule does not apply.

**6e — ✅ no orphan exclusions.** 12 in, 12 out.

## Check 7 — Terminal-cleanup story

n/a. The spec contains no removal keywords driving a cleanup story; US-003
modifies two test files but deletes nothing.

---

## Fixes applied to `prd.json`

1. Restored `src/verification/mutation/types.ts` to US-003 `contextFiles`.
2. Restored `src/log-format/index.ts` to US-004 `contextFiles`.
3. Appended the `### Modifies` block to US-003 `description` (done before this
   audit; recorded here for traceability).

Post-patch integrity re-verified: 4 stories, ACs 13/14/13/14, 12 `outOfScope`
entries, no self-created file in any `contextFiles`.

## Recommendations

1. **Before `nax run`** — none blocking. The PRD is ready.
2. **Watch US-003 at run time.** Its `### Modifies` authorisation exists only
   because it was hand-patched. If the PRD is ever regenerated, re-apply it or
   US-003 will deadlock against the two `classify.test.ts` assertions.
3. **Spec-authoring follow-up (not blocking).** The US-002 orphan AC exists
   because the spec's `### Failure Handling` row for "no candidates after
   selection" was assigned to US-002 without a covering AC. Writing that AC in
   the spec would have avoided both the planner-authored wording and the
   implicit US-003 dependency.
