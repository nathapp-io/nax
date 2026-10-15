# PRD Fidelity Report — pre-stable-hardening

**Spec:** `docs/specs/SPEC-pre-stable-hardening.md` (`dd1c5c089`)
**PRD:** `.nax/features/pre-stable-hardening/prd.json` (`0bd95ace4`, `nax plan --profile cross-agent,cc-plan`)
**Date:** 2026-10-15
**Phase run:** 9 (PRD fidelity). Phases 1-8 ran as two fresh spec-review passes before planning; every finding was fixed after verification against the code.
**Verdict:** ✅ ready for `nax run`

## Summary

| Check | Examined | Result |
|:--|:--|:--|
| 1. Spec AC → PRD AC | 166 spec ACs vs 166 PRD ACs, 9 stories | 166/166 verbatim matches (similarity 1.0); 0 missing |
| 2. Behavioural fidelity / signature reality | 166 PRD ACs | 0 degraded: every PRD AC is its spec AC verbatim, so the spec-review Phase 2/8 signature checks carry over |
| 3. Orphan PRD ACs | 166 | 0 |
| 3b. Dependency fidelity | 9 stories, 4 edges | Exact: US-004 ← US-002, US-003; US-005 ← US-003; US-009 ← US-008; the other 5 stories `[]` (spec `No dependencies.`) |
| 4a. `Creates` → `expectedFiles` | 17 created files | 17/17 in the owning story's `expectedFiles`; none in `contextFiles` |
| 4b. `Context Files` → `contextFiles` | 41 entries | 40/41 kept by the planner; US-005 `packages/nax/src/mcp/client.ts` dropped by the planner (model omission, `MAX_SPEC_CONTEXT_FILES` is 200) and **restored by hand** before the PRD commit (major, resolved) |
| 4c. Upstream-produced reads | 0 | No consumer story lists an upstream-created file |
| 4d. Planner additions | 0 | — |
| 5. Meta-ACs | 0 | Spec has none |
| 5b. Correction survival | 47 key correction tokens from the two review rounds, across 9 descriptions | 47/47 present in `description` (e.g. `spawnSync` + `gitSpawnEnv`, `-z --no-renames`, `check-ignore` without `-z`, completion keeps `savePRD`, fold into `systemPrompts`, `nax-stash-restore.ts`, optional `McpPool.instructions`, hand-written config interfaces) |
| 5c. PRD-AC satisfiability | 0 new invocation ACs | No AC was split or reworded, so the spec-review pass-2 Class B traces hold |
| 6a. Out of Scope preserved | 21 spec bullets | 21/21 in `prd.outOfScope`; 0 extra |
| 6c. Exclusion inverted into an AC | 21 | 0 |
| 6d. Story-scoped prefixes | 2 (`US-001 only:`, `US-004 only:`) | Both kept with their prefix |
| 7. Terminal cleanup story | — | n/a (no removals) |
| 8. `Modifies` → `modifiedFiles` | 2 paths | 2/2, each its own entry with a populated reason (US-001 guard test, 553 chars; US-003 API snapshot, 247 chars) |
| 9. Forward-reference drift | 166 ACs | 0: AC text is verbatim |

## Findings

- **Major (resolved):** US-005 `contextFiles` lost `packages/nax/src/mcp/client.ts` in planning. Restored in the committed PRD. Upstream note: the planner dropped a 6th context file with no cap reason; consistent with [nax-plan-drops-dependencies-and-upstream-context-files].

No open blockers or majors.
