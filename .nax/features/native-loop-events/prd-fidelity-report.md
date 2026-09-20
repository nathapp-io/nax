# Spec Review — Phase 9 (PRD Fidelity)

**Spec:** `docs/specs/SPEC-native-loop-events.md`
**PRD:** `.nax/features/native-loop-events/prd.json`
**Reviewed against:** nax repo at `56c1f6984` (branch `feat/native-loop-events`)
**Date:** 2026-09-20
**Phases run:** 9 of 9 (1–8 run at spec-writing time, pre-plan; 9 run here with `--prd`)
**Verdict:** ✅ ready

## Summary

| check | result |
|:---|:---|
| 1. Spec AC → PRD AC mapping | ✅ 57/57 mapped 1:1 |
| 2. Behavioural fidelity + signature reality | ✅ no degradation, no signature contradiction |
| 3. Orphan PRD ACs | ✅ 3 traceable to `### Seams` — not orphans |
| 4. File-role delta | ✅ 0 blockers, 0 majors, 8 minor additions |
| 5. Meta-AC + correction survival + satisfiability | ✅ n/a / 3 of 3 survived / Class B satisfied |
| 6. Out-of-scope preservation | ✅ 9/9 verbatim, prefix intact |
| 7. Terminal-cleanup integrity | ✅ deletion-only (1 minor) |
| 8. `Modifies` → `modifiedFiles` by path | ✅ 13/13, all reasons populated |

**0 blockers · 0 majors · 2 minors**

## Check 1 — Spec AC → PRD AC mapping

57 spec ACs across 5 stories, all mapped, 1:1, per story:

| story | spec ACs | PRD ACs | delta |
|:---|---:|---:|:---|
| US-001 | 15 | 15 | — |
| US-002 | 18 | 18 | — |
| US-003 | 14 | 17 | +3 seams (check 3) |
| US-004 | 8 | 8 | — |
| US-005 | 2 | 2 | — |
| **total** | **57** | **60** | **+3** |

Every pairing scored ≥ 0.42 word-Jaccard with matching symbol sets. The planner's
only systematic change is reformatting into `When X, then Y`. Lowest-scoring pair
(US-003, 0.42) was read manually and is the same criterion with clauses reordered:

- Spec: *a spilled body larger than `MODEL_MAX_BYTES` is fully recoverable by invoking `ScratchpadRead` on the spill path with successive `offset` values*
- PRD: *When successive `ScratchpadRead` offsets read a spilled body larger than `MODEL_MAX_BYTES`, then the whole body is recoverable*

## Check 2 — Behavioural fidelity and signature reality

No PRD AC was rewritten into a file-content / grep assertion, vagued, or stripped of
its asserted arguments. Every AC retains its locus token.

Signature reality check over PRD ACs naming calls against **existing** interfaces:

| PRD AC call | real signature | verdict |
|:---|:---|:---|
| `cleanupRun` with `runCompleted: true`, `dryRun: false` | `cleanupRun(options: RunCleanupOptions)`; `runCompleted?: boolean` exists at `run-cleanup.ts:71`, `dryRun` is declared new work in the spec's Integration target | ✅ |
| `wipeScratchpad` invoked at run start | `wipeScratchpad(workdir, opts?)` — `scratchpad-wipe.ts:44` | ✅ |
| `buildScratchpadSection` returns text | `buildScratchpadSection(): string` — `prompts/sections/scratchpad.ts` | ✅ |
| `ScratchpadRead` with `offset` / `limit` | schema change declared in the spec's Integration target | ✅ |

`truncateForModel`, `readFileSlice`, `buildToolResult` and the spill writer are
forward references in `Creates`, so no signature exists to contradict.

## Check 3 — Orphan PRD ACs

Three PRD ACs in US-003 have no counterpart in the spec's `## Acceptance Criteria`:

1. `truncateForModel` invoked once with its body and `head` direction
2. `readFileSlice` invoked once with that offset and limit
3. the spill writer is not invoked when a result is within every cap

All three trace to the spec's `### Seams` block, which declares exactly these three
US-003 seam invariants. Promotion of seam entries into the consumer story's
`acceptanceCriteria` is the intended mechanism, not scope bleed. **Not a finding.**

No PRD AC introduces a new enum value, status code, config key or validation
behaviour absent from the spec.

## Check 4 — File-role delta

**4a — `Creates` → `expectedFiles`:** 6 of 6 correct. No self-created file appears in
its own story's `contextFiles` (the blocker condition).

**4b — existing `Context Files` → `contextFiles`:** 13 of 13 retained.

**4c — cross-story produced files:** 4 upstream-produced files were **correctly kept**
in their consumers' `contextFiles` — `truncate.ts` and `read-file.ts` (US-001 → US-003),
`loop-events.ts` (US-002 → US-003), `truncate.ts` (US-001 → US-005). None dropped, none
mis-moved into the consumer's `expectedFiles`. Per the checklist this is explicitly
**not a finding** — the dependency-aware `normalizeCreatedContextFiles` behaved
correctly.

**4d — planner additions (minor):** 8 extra `contextFiles`, all existing on disk and
all germane — `registry.ts` on US-001 (where `ToolRunContext` is defined),
`turn-types.ts` and `adapter.ts` on US-002, `scratchpad.ts` on US-004 (the
`ScratchpadWrite` description lives there), and the four tool files being cleaned on
US-005.

## Check 5 — Meta-AC survival, correction survival, satisfiability

**5 — Meta-ACs:** none. The spec routed all removal/absence claims to the build/static
gate at authoring time, so there is no meta-AC to lose.

**5b — Correction survival:** `analysis` is empty (0 chars) on all five stories, so
there is no analysis-only channel to hide in. All three pre-plan spec-review
corrections reached a `description`:

| correction | destination |
|:---|:---|
| `readCeiling` optional, with the 21-test-file rationale | US-001 `description` ("21 test", "optional") |
| `_spillDeps` injection so the spill-failure AC is testable | US-003 `description` (`_spillDeps`, "inject") |
| `cleanupRun` reaches no scratchpad removal today | US-004 `description` (`run-setup-init.ts:120`) |

The fourth correction — the AC pinning absent `readCeiling` — survived as US-003 PRD
AC 10.

**5c — PRD-AC satisfiability (Class B trace):** one invocation AC has both endpoints
already existing — US-004 AC 1, `cleanupRun` → scratchpad removal. The path does
**not** exist today (`wipeScratchpad` has exactly one call site, `run-setup-init.ts:120`).
The checklist requires the spec to say so explicitly rather than assert a false path,
and US-004's `description` does: *"`wipeScratchpad` is called only at run start
(`run-setup-init.ts:120`), so files survive until the next run's wipe."* The AC
therefore describes wiring the story creates. **Satisfiable.** See minor 2.

## Check 6 — Out-of-scope preservation

9 spec bullets → 9 `prd.outOfScope` entries, **all 1.00 exact-match verbatim**.

- **6a** every exclusion present ✅ (well under the 25-item cap)
- **6b** field present, spec defers real work ✅
- **6c** no exclusion surfaced in any story's `acceptanceCriteria` ✅
- **6d** the single story-scoped hoist carries its prefix — `US-003 only: rejecting
  invented range-argument aliases on ScratchpadRead` ✅. Both story-level blocks also
  reached their own stories' `outOfScope` (US-003, US-004). No story's scope
  declaration contradicts a feature-level exclusion.
- **6e** no orphan entries ✅

## Check 7 — Terminal-cleanup integrity

US-005 is the PRD's last story and is deletion-only: 2 ACs, both
capability-preservation (`Grep` and `Git` results still bounded after the deletions),
no additive ACs, no `modifiedFiles`, dependency on US-003 intact. Neither removal was
re-encoded as a file-content "does not contain" AC. See minor 1.

## Check 8 — `Modifies` → `modifiedFiles`, counted by path

13 distinct paths in the spec's `### Modifies` block → **13 `modifiedFiles` entries**,
correctly attributed per story (US-001: 1, US-002: 3, US-003: 7, US-004: 2, US-005: 0
with its `None.` justification). Every entry carries both `path` and `reason`.

Both swallowed-path tells are negative: no `reason` begins with a comma, and the entry
total equals the distinct path count. All 13 paths exist on disk.

## Findings

### Minor 1 — US-005 verification note lost its verbatim gate command

**Spec reference:** `## Acceptance Criteria` § US-005, verification note
**PRD reality:** US-005 `description` says *"the build and lint gates are what confirm
no reference survives"*. The spec's explicit `bun run typecheck && bun run lint` did
not survive verbatim.
**Impact:** the implementer is told the gate class but not the command. nax runs
typecheck and lint automatically in the pipeline, so the gate still executes.
**Recommended fix:** none required; if desired, add the literal command to US-005's
description before `nax run`.

### Minor 2 — US-004's Class B statement survived as motivation rather than as an explicit non-reachability claim

**Spec reference:** `### Integration`, `cleanupRun` entry
**PRD reality:** the spec's *"It does **not** invoke any scratchpad removal today"* was
paraphrased into US-004's **Motivation** as *"`wipeScratchpad` is called only at run
start (`run-setup-init.ts:120`)"*.
**Impact:** none material — the load-bearing fact (one call site, at run start) reached
the implementer through `description`, which is a rendered channel. The satisfiability
requirement in check 5c is met.
**Recommended fix:** none.

## Recommendations

1. Proceed to `nax run -f native-loop-events`. No blocker or major stands between the
   PRD and implementation.
2. Optionally add the literal `bun run typecheck && bun run lint` to US-005's
   description (minor 1) — cheap, and it makes the terminal story's gate explicit.
3. Watch US-002 (18 ACs) during the run. It is the largest story, but it sits well
   under this project's `maxAcCount` of 24 and its ACs did not split during planning,
   so no precheck risk is expected.
