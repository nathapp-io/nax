# Spec Review — Phase 9 (PRD Fidelity)

**Spec:** `.nax/features/acp-catalog-pricing/spec.md`
**PRD:** `.nax/features/acp-catalog-pricing/prd.json`
**Reviewed against:** nax at `8a78e9d5d`
**Date:** 2026-09-08
**Planner:** `nax plan --profile native`, model `openai-codex/gpt-5.6-terra[medium]`
**Phases run:** 9 of 9 (1-8 completed pre-plan; this report covers Phase 9)
**Verdict:** ⚠️ revisions needed — 0 blockers, 2 majors, 3 minors

## Summary

| Check | Result |
|---|---|
| 1. Spec AC → PRD AC mapping | PASS — 27/27 spec ACs map |
| 2. Behavioural fidelity / signature reality | PASS — no degraded or grep-style ACs |
| 3. Orphan PRD ACs | MINOR — 4 orphans, none introducing material scope |
| 4a. `Creates` → `expectedFiles` | PASS — 6/6, no self-created file in `contextFiles` |
| 4b. `Context Files` → `contextFiles` | **MAJOR** — 1 existing file dropped |
| 4c. Cross-story produced files | PASS — upstream reads correctly kept |
| 4d. Helpful additions | MINOR — 6 extra existing files added |
| 5b. Correction survival | **MAJOR** — one correction reached neither channel |
| 5c. PRD-AC satisfiability (Class B) | N/A — no AC has both endpoints pre-existing |
| 6. Out-of-scope preservation | PASS — 11/11, none inverted, no unprefixed hoists |
| 7. Terminal-cleanup integrity | **MAJOR** — gate note dropped (see 5b); ACs acceptable |
| 8. `Modifies` → `modifiedFiles` by path | PASS — 14/14 |

## Major — US-002 `contextFiles` dropped `src/agents/types.ts`

**Check:** 4b. **Spec reference:** US-001 § Context Files (US-002 block).
**Planner log:** `Spec Context Files entries absent from the resulting story — not backfilled`,
`storyId: US-002, declaredCount: 4, presentCount: 5, droppedCount: 1, dropped: ["src/agents/types.ts"]`.
**Reality:** the file exists on disk and declares `CompleteResult.pricingSource` at
`types.ts:414`, which US-002 AC1 asserts on. The planner substituted
`src/agents/acp/adapter-output.ts` (already authorised under `Modifies`).
**Impact:** the implementer loses the auto-loaded field declaration. A missing
`contextFiles` entry is a runtime warning, not an error, so the run proceeds.
**Not check 4c:** this file is not produced by an upstream story, so the
"flag the planner, do not hand-edit" guidance does not apply — `contextFiles` is a
read hint and may be patched in place.
**Fix:** add `src/agents/types.ts` to US-002's `contextFiles`.

## Major — US-003 lost its build/static-gate verification note

**Checks:** 7 and 5b. **Spec reference:** US-003 § Verification note (US-003).
**Spec text dropped in full:**
> Removals are verified by the build/static gate, not by acceptance criteria:
> `bun run typecheck` and `bun run lint` (which chains `check:file-sizes`,
> `check:alias-internals`, `check:import-cycles`, `check:nax-ai-imports` and
> `check:bundle-externals`). Before deleting, confirm the no-production-caller
> claim for `estimateCost` and `estimateCostByDuration` rather than trusting a
> single search.

**Reality:** US-003's `description` carries Goal / Motivation / Approach / Scope /
Interface and no verification note. The story also has no `analysis` field, so the
text reached neither delivery channel — `story.ts` renders only title,
`description`, `acceptanceCriteria` and `outOfScope`.
**Impact:** the implementer is told to delete but not how removal is verified, and
the instruction to re-confirm the no-production-caller claim — a correction from the
pre-plan review — is invisible at run time.
**Fix:** append the note verbatim to US-003's `description`.

## Minor — 4 orphan PRD ACs (check 3)

None introduce material scope; all trace to spec content that was declared but
left unpinned, which is the planner's documented Rule-11 backfill behaviour.

- US-001 +2 — cover `### Failure Handling` rows 2 ("alias resolves but the catalog
  has no such provider/model") and 3 ("catalog load rejects"), which the spec
  tabulated but never pinned with an AC.
- US-003 +2 — pin `resolvePricingSource`'s Target contract from § Integration.

Recommend keeping all four. The spec, not the PRD, is the thing to correct: those
Failure Handling rows should have carried ACs of their own.

## Minor — US-003 carries 2 ACs where the spec declared none (check 7)

Judged **not** contamination. Neither is additive nor a "does not contain"
re-encoding; both pin behaviour that survives the deletion, and US-003's own
`Modifies` block already authorises re-pinning `resolvePricingSource` coverage in
`test/unit/agents/cost/calculate.test.ts`.

## Minor — 6 helpful `contextFiles` additions (check 4d)

US-001 +`scripts/check-nax-ai-imports.ts`; US-002 +`adapter.ts`, +`adapter-output.ts`;
US-003 +`calculate.ts`, +`pricing.ts`, +`calculate.test.ts`. All exist and are
relevant. No action.

## Recommendations

1. Patch US-002 `contextFiles` to re-add `src/agents/types.ts`.
2. Append the verification note to US-003's `description`.
3. Spec-side follow-up: pin the two Failure Handling rows with ACs so the planner
   does not have to author them next time.

Both patches touch structural fields the planner does not author. Verify nothing
outside `contextFiles` / `description` changes before accepting them.
