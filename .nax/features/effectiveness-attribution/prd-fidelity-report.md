# Spec Review — docs/specs/SPEC-effectiveness-attribution.md

**Reviewed against:** nax repo at `4e5cf86b`
**PRD:** `.nax/features/effectiveness-attribution/prd.json` (cross-agent-pi profile)
**Date:** 2026-08-13
**Phases run:** 9 only (phases 1-8 ran during spec-writing; this invocation is the post-plan fidelity gate)
**Verdict:** ⚠️ revisions needed — 0 blockers, 5 majors (all remediated), 3 minors

## Summary

| Check | Result |
|:---|:---|
| 1. Spec AC → PRD AC mapping | 33 → 39, every spec AC maps; all 6 additions traceable |
| 2. Behavioural fidelity + signature reality | 1 major (locus token degraded) — fixed |
| 3. Orphan PRD ACs | 1 planner-authored AC, accepted (no material scope) |
| 4. File-role delta | no self-`Creates` in any `contextFiles`; 1 major — an upstream fixture US-003 reads was undeclared (see Major 5) |
| 5. Meta-AC / correction survival | corrections reached `description` + `acceptanceCriteria`, never `analysis`-only |
| 5c. PRD-AC satisfiability | Class A (both seam endpoints new) — no trace required |
| 6. Out-of-scope preservation | 7/7 survived; 8th added post-report with a `US-003 only:` prefix; none inverted into an AC |
| 7. Terminal-cleanup integrity | 1 major (gate note dropped) — fixed |
| 8. `Modifies` → `modifiedFiles` | 1 major (all entries dropped) — fixed |

## Majors

### Major 1 — every `### Modifies` entry was dropped (§8)

**Spec reference:** Stories, US-003 and US-004
**PRD reality:** `modifiedFiles` empty on all four stories.
**Cause:** the spec wrote per-story inline `- Modifies:` bullets. The extractor reads
**one** `### Modifies` section between `## Stories` and `## Acceptance Criteria`, with
`**US-00N**` alone on its line. Nothing matched, so nothing extracted.
**Impact:** US-003 and US-004 both rewrite `test/unit/context/engine/effectiveness.test.ts`.
Without authorisation, test-authorship isolation bars the edit, a correct
implementation fails the old assertions, and the implementer's only remaining move
is to revert — the deadlock the block exists to prevent. A `Context Files` entry
does not clear it; that is a read list.
**Fix applied:** spec restructured to the canonical section shape; PRD patched in
place (structural field the planner does not author). Verified nothing outside
`modifiedFiles` changed. Path count 2 spec → 2 PRD entries, one per bullet.

### Major 2 — CLI locus token degraded (§2)

**Spec reference:** US-001 AC-10..12, US-003 AC-12
**PRD reality:** `nax context effectiveness eval` reduced to bare `eval` across five ACs.
**Impact:** an implementer cannot tell which command to invoke. On US-003's seam AC it
additionally erased **seam altitude** — naming the outermost production entry point is
the whole assertion.
**Fix applied:** full command restored in all five ACs.

### Major 3 — an AC landed in the wrong story (§1)

**Spec reference:** Failure Handling, "A single label case throws during scoring"
**PRD reality:** planted in US-003 as "When one label case throws while scoring…".
**Impact:** the behaviour belongs to `scoreEffectiveness`, which lives in
`effectiveness-eval.ts` — a file **US-001 creates** and US-003 only reads. The AC
would have required US-003 to implement behaviour in another story's file.
**Fix applied:** moved to US-001. AC multiset verified identical before/after.

### Major 4 — terminal-cleanup gate note dropped (§7)

**Spec reference:** "Verification note for US-004 … `bun run typecheck && bun run lint`"
**PRD reality:** absent from US-004's `description`.
**Impact:** the story's removals lose their stated verification route. Partially
compensated by the planner's absence AC, which makes the removal runtime-checked.
**Fix applied:** note appended to US-004's `description`.

## Minors

1. **`ManifestInputs` dropped from AC prose.** US-002's ACs kept `buildManifest`,
   `packed` and `chunkScopePaths`, so the mechanism stays legible and the signature
   is not contradicted. No action.
2. **Planner-authored absence AC in US-004** — "the module has no `classifyEffectiveness`
   export". The spec deliberately routed removal to the build/static gate instead.
   Accepted rather than reverted: it is runtime-testable under Bun, matches the story's
   exact purpose, is not a file-content assertion, and the gate note now also stands.
3. **US-004 AC-1/AC-2 re-verify US-003's exports.** Harmless duplication of coverage;
   they add no code, so the story stays deletion-only (`expectedFiles` is empty).

## Checks that passed clean

- **File roles (§4):** no story lists a file it creates in its own `contextFiles`.
  US-003 correctly reads `effectiveness-eval.ts`, produced upstream by US-001 — the
  allowed cross-story case, not a finding.
- **Correction survival (§5b):** `buildManifest`, the self-sourcing size-correlation
  threshold, and the `static-rules.ts` 583/600 sizing constraint all reached a
  `description` or an `acceptanceCriteria` entry. None survived only in `analysis`.
- **Satisfiability (§5c):** US-003's seam AC stubs `scoreEffectiveness` and triggers
  `nax context effectiveness eval`. Both endpoints are created by this spec — no
  existing `effectiveness` CLI surface — so this is Class A and needs no path trace.
- **Out of scope (§6):** all 7 bullets present, including the §23 deferral. None
  inverted into an AC (`scoreChunk`, "learned per-provider multiplier", "LLM-backed
  judge", "counterfactual", "hand-labelled" appear in zero ACs). No story contradicts
  a feature-level exclusion.
- **Signature reality (§2):** `StaticRulesProvider.fetch` and `buildManifest` ACs match
  the real signatures captured during spec-writing; no hallucinated arity.
- **Dependencies:** `US-003 → US-001, US-002`; `US-004 → US-003`. DAG intact.

## AC arithmetic

| story | spec | PRD | delta |
|:---|--:|--:|:---|
| US-001 | 12 | 15 | +2 exit-2 cases split from the Failure Handling table, +1 relocated from US-003 |
| US-002 | 7 | 7 | unchanged |
| US-003 | 12 | 14 | +3 Failure Handling rows, −1 relocated to US-001 |
| US-004 | 2 | 3 | +1 planner-authored absence AC |
| **total** | **33** | **39** | all additions traceable to the spec's own Failure Handling table or to atomic splitting |

## Recommendations

1. **Before the next spec:** write `### Modifies` as one section between `## Stories`
   and `## Acceptance Criteria`, `**US-00N**` alone on its line, one backticked path
   per bullet. This is the second time the inline shape has cost a round trip.
2. ~~Consider hoisting US-003's coverage-constant deferral~~ — **applied.** Now a
   feature-level bullet prefixed `US-003 only:`, so propagation cannot waive the
   property in the other three stories.
3. ~~Author the synthetic label fixture before starting US-001~~ — **withdrawn, this
   recommendation was wrong.** `test/fixtures/effectiveness/labels.sample.json` is in
   US-001's `expectedFiles`: the story authors it. Nothing needs to pre-exist. The
   genuinely hand-labelled set remains the Out-of-Scope manual task, which is a
   different artefact.

## Post-report patches (2026-08-13)

Checking recommendation 3 surfaced a real gap it had masked:

### Major 5 — US-003 scores against a fixture it never declared as a read

**Spec reference:** US-003 AC-10/AC-11 ("scoring the committed synthetic fixture") and
the seam AC's `--labels <fixture>`.
**Reality:** `test/fixtures/effectiveness/labels.sample.json` appeared in neither the
spec's US-003 `Context Files` nor the PRD's `contextFiles`. Not planner drift — the
spec never listed it, so Phase 9 §4c had nothing to compare against.
**Impact:** US-003's implementer gets no read hint for the file three of its ACs score
against, and would hit a missing-context warning rather than a pointer.
**Fix applied:** added to the spec's US-003 `Context Files` and the PRD's
`contextFiles`, annotated as produced by US-001 — the legitimate cross-story read.

Both patches verified isolated: only `contextFiles` and `outOfScope` changed in the
PRD. Out-of-scope count is now 8 in both spec and PRD, well under the 25-item cap.
