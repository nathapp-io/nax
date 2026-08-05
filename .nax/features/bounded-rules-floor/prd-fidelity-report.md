# Spec Review — Phase 9 (PRD Fidelity)

**Spec:** `docs/specs/SPEC-bounded-rules-floor.md`
**PRD:** `.nax/features/bounded-rules-floor/prd.json`
**Reviewed against:** nax repo at `d053acb7` (branch `feat/bounded-floor-rule-scoping`)
**Planner:** `nax plan --profile cross-agent`, agent `codex`, nax binary **v0.76.0**
**Date:** 2026-08-05
**Phases run:** 9 only (phases 1-8 ran during spec authoring; see commit `d053acb7`)
**Verdict:** revisions needed — all applied, PRD now re-validated

## Summary

| Check | Result |
|:---|:---|
| 1. Spec AC → PRD AC mapping | 38/38 mapped, 0 dropped |
| 2. Behavioural fidelity + signature reality | clean |
| 3. Orphan PRD ACs | 2 found, 1 removed, 1 retained (minor) |
| 4. File-role delta | 1 major (dropped read), fixed |
| 5b. Correction survival | **1 blocker-grade finding**, fixed |
| 5c. PRD-AC satisfiability | clean (all Class A) |
| 6. Out-of-scope preservation | 9/9, no inversion |
| 7. Terminal-cleanup integrity | 1 blocker removed, 1 minor retained |

## Check 1 — Spec AC → PRD AC mapping

All 38 spec ACs map to at least one PRD AC. Count rises to 41 via legitimate
compound splitting, not scope bleed.

| Story | Spec ACs | PRD ACs | Mapping |
|:---|---:|---:|:---|
| US-001 | 10 | 11 | S1 split into P1 (importable) + P2 (returns three sections); S2-S10 map 1:1 |
| US-002 | 9 | 10 | S1 split into P1 + P2; S2-S9 map 1:1 |
| US-003 | 8 | 8 | 1:1 |
| US-004 | 11 | 11 | 1:1 |
| US-005 | 0 | 1 | planner-authored (see check 3) |

No AC was degraded into a file-content or grep assertion. No AC lost its asserted
arguments. Locus tokens survived intact, including `0.4`, `1600`, `8192`,
`10800`, `priority 45`, `prompt-builder-convention`, and the seam symbols
`_staticRulesDeps.splitRuleIntoSections` / `_staticRulesDeps.applySectionBudget`.

**Signature reality check.** PRD ACs asserting against the existing
`StaticRulesProvider.fetch` name `request.budgetTokens` and `request.stage`, both
real fields on `ContextRequest` (`src/context/engine/types.ts`). Arity and
parameter shapes agree with the real single-argument signature. No hallucinated
call shapes.

## Check 3 — Orphan PRD ACs

`nax plan` authored two ACs for US-005, where the spec deliberately declared none
(terminal-cleanup stories verify through the build/static gate).

- **Removed (blocker).** *"…then `.nax/rules/forbidden-patterns.md` does not
  exist."* A removal/absence assertion encoded as an AC — the exact form check 7
  forbids. Deletion is verified by the story's build/static-gate note
  (`bun run dev rules lint`, `bun run lint`), not by a runtime criterion.
- **Retained (minor).** *"…`forbidden-patterns-source.md` and
  `forbidden-patterns-tests.md` are separately discoverable canonical rules."*
  Genuinely behavioural — loads the corpus and asserts both rules are returned.
  Formally additive on a deletion-only story, but this story is a *rename*
  (delete one, create two), so asserting the renamed halves load is a reasonable
  post-condition and strictly better than the spec's zero-AC version.

## Check 4 — File-role delta

- **a. `Creates` → `expectedFiles`:** clean. No self-created file appears in its
  own story's `contextFiles`.
- **b. `Context Files` → `contextFiles`:** one **major**, fixed.
  US-001 dropped `src/context/engine/providers/static-rules.ts` (the spec's
  "existing chunk id construction to mirror"), leaving 4 of 5 entries. This is the
  known 5-file-cap eviction (issue #1466), not paraphrase drift. Restored.
- **c. Cross-story produced files:** correct, not a finding. US-002 and US-004
  carry `rule-sections.ts` / `rule-budget.ts` in `contextFiles`; both are in an
  upstream dependency's `expectedFiles`, so they exist at the consumer's runtime.
- **d. Helpful additions:** none.

## Check 5b — Correction survival (the significant finding)

Three corrections were made during the pre-plan spec-review round. Their fate:

| Correction | Channel | Status |
|:---|:---|:---|
| Barrel → `@/` alias import | US-001 P1, US-002 P1 (`acceptanceCriteria`) | survived |
| Constructor default stays `false` | US-003 AC-8 (`acceptanceCriteria`) | survived |
| `test/unit/config/schemas.test.ts` edit authority | — | **dropped** |

**Root cause: the installed binary predates the feature.** The spec's
`### Modifies` block is carried into `prd.json` and the implementer prompt by
`#1467` (`3d518bb3`). The installed `nax` is `v0.76.0`, and that commit landed
*after* the tag — 17 commits separate them. `git show v0.76.0:src/prompts/sections/modified-files.ts`
does not resolve, and `v0.76.0`'s `story.ts` contains zero `modifiedFiles`
references. The repo source has the feature; the binary running the plan does not.

**Why the first remediation was insufficient.** Writing the authority into
`story.modifiedFiles` reproduces this check's own warning in a new form: under
`v0.76.0` that field is rendered into no prompt, making it exactly as inert as
`analysis`. Schema validation passing is not evidence of delivery.

**Applied fix.** The authority now also lives in US-003's `description`, which
every nax version renders, stating explicitly that
`test/unit/config/schemas.test.ts` lines 531 and 539 must flip from `false` to
`true` and that the implementation must not be reverted to satisfy them.
`modifiedFiles` is retained so a rebuilt binary uses the structured channel.

**Why this mattered.** US-003 AC-2 requires `enforceBudget` to resolve to `true`.
Two existing tests assert `false`. Without authorisation, the implementer's only
route to green is reverting the change — the precise failure `#1467` exists to
prevent.

## Check 5c — PRD-AC satisfiability

All invocation-shaped ACs (US-004 P1, P2, P11) stub `splitRuleIntoSections` and
`applySectionBudget`, both **created by this spec** (US-001, US-002). These are
Class A, so the Class B seam-path trace does not apply — there is no pre-existing
call path to falsify. Entry point is `StaticRulesProvider.fetch`, the provider's
outermost production entry point.

## Check 6 — Out-of-scope preservation

- **a.** 9/9 spec exclusions present in `prd.outOfScope`, verbatim. Well under the
  25-item cap.
- **b.** Field present and populated.
- **c.** No exclusion inverted into an AC. Swept every story's
  `acceptanceCriteria` for `roles:`, `packChunks`, effectiveness classifier,
  `query_scratch`, `rules-setup`, and barrel — zero hits.
- **d.** No story-scoped deferrals in the spec, so the `US-00N only:` prefix rule
  does not apply. No story's scope declaration contradicts a feature-level
  exclusion.
- **e.** No orphan exclusions.

## Check 7 — Terminal-cleanup integrity

US-005 is last in the dependency chain (`US-001 → US-002 → US-003 → US-004 → US-005`),
retains its build/static-gate verification note, and no longer carries the
"does not exist" file-content AC. One additive-but-justified AC retained (check 3).

## Recommendations

1. **Rebuild or reinstall `nax` from `main` before `nax run`.** The installed
   `v0.76.0` is 17 commits behind and will silently drop `### Modifies` on every
   future plan — invisible unless specifically audited. Alternatively run
   `bun run dev` in this repo.
2. Re-run this phase if the PRD is regenerated; the hand-patches do not survive a
   re-plan.
3. Consider whether the 5-file `Context Files` cap (#1466) warrants raising, given
   it silently evicted a spec-declared read here.

## Post-fix state

PRD re-validated through `validatePlanOutput`. Final shape:

| Story | ACs | contextFiles | expectedFiles | modifiedFiles |
|:---|---:|---:|---:|---:|
| US-001 | 11 | 5 | 2 | 0 |
| US-002 | 10 | 3 | 2 | 0 |
| US-003 | 8 | 5 | 1 | 5 |
| US-004 | 11 | 5 | 1 | 0 |
| US-005 | 1 | 5 | 2 | 5 |

Original planner output preserved at `prd.json.bak`.
