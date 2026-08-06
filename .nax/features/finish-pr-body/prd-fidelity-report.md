# PRD Fidelity Report — finish-pr-body

**Spec:** `.nax/features/finish-pr-body/spec.md`
**PRD:** `.nax/features/finish-pr-body/prd.json` (generated 2026-08-05, profile `cross-agent-mm`)
**Repo:** nax @ `ee81d9ad`
**Phase:** spec-review Phase 9 (PRD fidelity)
**Verdict:** ✅ ready — both findings resolved by hand-patch (no re-plan needed). See § Resolution.

## Resolution (applied)

`prd.json.bak` holds the pre-patch PRD. Two fields changed, nothing else:

1. `outOfScope`: 17 → 9, replaced with the spec's section verbatim. All 9 real entries had
   survived the plan **unreworded**, so the replacement is lossless; the 8 over-extracted rows
   are gone.
2. US-004 `dependencies`: `["US-002"]` → `["US-003"]`.

Re-verified after patch: 51 ACs unchanged, DAG acyclic and topologically ordered,
`nax features resolve finish-pr-body --json` returns `status: ok`.

The spec fix (removing literal `##`-level heading tokens from Design prose) is retained so a
future re-plan cannot reintroduce the over-extraction.

## Summary

| Check | Result |
|:---|:---|
| 1. Spec AC → PRD AC mapping | ✅ 49/49 mapped by symbol overlap; PRD has 51 (+2 legitimate splits) |
| 2. Behavioural fidelity | ✅ 0 degraded; no grep/file-content ACs; locus tokens preserved |
| 3. Orphan ACs | ✅ none introducing material scope |
| 4. File-role delta | ✅ correct (see note) |
| 5. Meta-AC survival | ✅ n/a — spec has no meta-ACs |
| 5b. Correction survival | ✅ both corrections in `description`/`acceptanceCriteria`; **neither analysis-only** |
| 5c. PRD-AC satisfiability | ✅ 3 Class B ACs (US-001 AC1/AC3/AC4); all call paths verified in source |
| 6a/6e. Out-of-scope preservation | ❌ **BLOCKER** — 8 over-extracted entries |
| 6c. Exclusion inverted into an AC | ✅ 0 hits |
| 7. Terminal-cleanup story | ✅ n/a — spec has none |
| — DAG fidelity | ⚠️ **MAJOR** — US-004 dependency rewritten |

## Blocker — 8 non-exclusions captured into `prd.outOfScope`

**Check 6e.** `prd.outOfScope` holds 17 entries; only 9 trace to the spec's `## Out of Scope`
section (all 9 present at 1.00 token overlap, including the cost exclusion — check 6a passes).
The other 8 are not exclusions at all:

- `Body assembly is **fail-open throughout**: opening the PR must never block on it.`
- `A section whose source is empty renders **no heading at all** …`
- all 7 `### Failure Handling` table rows (`prd.json` unreadable → …, `status.json` unreadable → …,
  `git diff --stat` non-zero → …, rounds file absent → …, `gh pr edit` non-zero → …,
  `loadFinishPrContext` or a builder throws → …)

These describe behaviour the ACs **require**: US-003 AC11/AC12 and US-004 AC5/AC6 exist precisely
to implement the fail-open rows now labelled out-of-scope. Check 6e grades this a blocker —
an out-of-scope entry excluding something the ACs require. `nax plan` copies `outOfScope` onto
every story, so every implementer would be told the fail-open behaviour their own ACs demand is
a hard boundary, and the adversarial reviewer could cite it to close legitimate findings.

**Root cause — the spec, not the planner.** Spec line 115 (pre-fix) *began* with the token
`` `## Out of Scope` `` inside a prose sentence. The extractor tolerates surrounding backticks,
so it opened a section capture there and consumed everything down to `## Stories` — the
Body-layout note, the fail-open line, and the whole Failure Handling table — in addition to the
real section at line 156.

**Fix applied:** the Design prose no longer contains literal `##`-level heading tokens
(`.nax/features/finish-pr-body/spec.md`, § Body layout). Requires a re-plan to take effect.

## Major — US-004's dependency was rewritten

**Spec:** US-004 depends on **US-003**. **PRD:** `dependencies: ["US-002"]`.

US-003 creates `loadFinishPrContext`; US-004's six ACs all assert additional return fields of
that **same function** in the **same file** (`flows/nax-finish/steps/pr-body.ts`). Branching
US-004 off US-002 means the function does not exist in its tree, so US-004 must re-create it —
and in parallel mode two divergent versions of one function are merged. Sequential ordering
happens to hide this; the declared graph is still wrong.

**Fix:** set US-004 `dependencies` to `["US-003"]` (hand-patch, or re-verify after re-plan).

## What survived correctly

- **All 9 spec exclusions** reached `prd.outOfScope` verbatim, including the cost exclusion.
- **AC counts** per story match the spec exactly for US-001..US-004 (4/15/14/6). US-005 went
  10 → 12: the planner split the GitLab fail-open sibling out of the `gh pr edit` row, and split
  "loader throws" from "builder throws". Both trace to stated Failure Handling rows — Rule 11
  working as designed, not scope bleed.
- **No AC degraded** into a file-content or grep assertion (0 hits).
- **Locus tokens preserved** — `buildFinishTitle`, `buildFinishBody`, `loadFinishPrContext`,
  `gatesRan`, `run.storiesPassed`, `gh pr edit`, `glab mr update`, `nothing-to-finish`, and the
  footer format string all survived verbatim.
- **File roles correct (check 4).** `pr-body.ts` is in US-002's `expectedFiles` and in US-003/
  US-004/US-005's `contextFiles` — the upstream-produced-file case (4c), explicitly *not* a
  finding. The planner also added `test/unit/flows/nax-finish/steps/pr-body.test.ts` to
  US-002's `expectedFiles`: a helpful addition (4d), minor.

## Recommendation

Re-run `nax plan` after the spec fix, then re-check two things only: that `prd.outOfScope` holds
**9** entries, and that US-004 depends on US-003.
