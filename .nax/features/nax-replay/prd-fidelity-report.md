# PRD Fidelity Report — nax-replay

**Spec:** `docs/specs/SPEC-nax-replay.md`
**PRD:** `.nax/features/nax-replay/prd.json` (planner: codex, profile `cross-agent-mm`)
**Reviewed against:** repo `main` head (branch `feat/nax-replay`)
**Date:** 2026-07-04
**Phases run:** 9 of 9 (1–8 passed clean on the unchanged spec in the prior pass; this pass focuses Phase 9)
**Verdict:** ✅ ready — 0 blockers, 0 majors, 1 minor (accepted)

## Counts

| Story | Spec ACs | PRD ACs | Δ | Reason |
|---|---|---|---|---|
| US-001 core | 10 | 12 | +2 | 2 faithful "expose X" + "X behaves" importable-splits (`inferPhases`, `reconstructTimeline`) |
| US-002 discovery | 4 | 6 | +2 | 1 importable-split (`discoverRun`) + 1 spec-grounded failure AC (ambiguous prefix) |
| US-003 renderer | 8 | 9 | +1 | 1 importable-split (`renderReport`) |
| US-004 json+CLI | 7 | 10 | +3 | 2 importable-splits (`toReplayJson`, `registerReplayCommand`) + 1 spec-grounded failure AC (malformed JSONL) |
| **Total** | **29** | **37** | **+8** | all faithful splits / spec-grounded materializations; 0 scope bleed |

## Spec AC → PRD AC mapping

Every one of the 29 spec ACs maps to ≥1 PRD AC with the same symbol, inputs, and expected output/exception/invocation. No behavioural degradation, no grep/file-content regressions — all PRD ACs remain runtime `[symbol] returns X when given Y` tests.

- US-001: spec AC1→PRD AC1+AC2; AC2→AC3; AC3→AC4; AC4→AC5; AC5→AC6+AC7; AC6→AC8; AC7→AC9; AC8→AC10; AC9→AC11; AC10→AC12.
- US-002: spec AC1→PRD AC1+AC2; AC2→AC3; AC3→AC4; AC4→AC5. (PRD AC6 = spec §Failure Handling "ambiguous run-id".)
- US-003: spec AC1→PRD AC1+AC2; AC2→AC3; AC3→AC4; AC4→AC5; AC5→AC6; AC6→AC7; AC7→AC8; AC8→AC9.
- US-004: spec AC1→PRD AC1+AC2; AC2→AC3; AC3→AC4; AC4→AC5; AC5→AC6+AC7; AC6→AC8; AC7→AC10. (PRD AC9 = spec §Failure Handling "empty / truncated JSONL".)

## "Orphan" PRD ACs — both spec-grounded (not scope bleed)

- **US-002 AC6** (throws `RUN_NOT_FOUND` when >1 entry matches the prefix): materializes the spec's §Failure Handling clause "Unknown / **ambiguous** run-id: `discoverRun` throws `NaxError` `RUN_NOT_FOUND`." In-scope. *Minor note:* `RUN_NOT_FOUND` for an ambiguous (multiple-match) case is semantically imprecise ("too many" ≠ "not found"), but it is exactly what the spec prose grouped — faithful, not drift. Left as-is for spec consistency.
- **US-004 AC9** (skips malformed JSONL lines, renders remaining spine, exit 0): materializes the spec's §Failure Handling clause "Empty / truncated JSONL: malformed lines are skipped … never throws on a bad line." In-scope.

## File-role delta (`contextFiles` vs `expectedFiles`)

Clean. No self-created file placed in `contextFiles`; all cross-story produced files correctly kept in the consumer's `contextFiles`.

- **US-001** `expectedFiles` = spec `Creates` (types/phase-infer/reconstruct/index) ✅. `contextFiles` = spec 3 (logger/types, metrics/types, status-file) **+2 helpful existing additions** (`src/execution/story-orchestrator-logging.ts`, `src/agents/manager.ts`) — both verified to exist → **minor helpful additions** (9.4.d), not findings.
- **US-002** `expectedFiles` = [discovery.ts] ✅. `contextFiles` adds `src/commands/logs-reader.ts` (the resolver being mirrored — verified exists, helpful) and keeps `src/replay/index.ts` (US-001-produced, upstream dep) ✅.
- **US-003** keeps `src/replay/types.ts` + `index.ts` (US-001-produced) in `contextFiles` ✅.
- **US-004** keeps `src/replay/discovery.ts` (US-002) + `report.ts` (US-003) in `contextFiles` ✅; `expectedFiles` = [json.ts, commands/replay.ts] ✅.

## Seams / meta-ACs / cleanup

- **Seams preserved:** US-004 PRD AC3 (stub `discoverRun`, assert invoked) and AC4 (assert reconstructed timeline flows to `renderReport`) preserve both two-anchor seams.
- **Meta-ACs:** none in spec — nothing to lose.
- **Terminal-cleanup story:** not applicable (pure additive feature; no removal keywords).

## Sizing (Phase 8.5 on PRD)

All stories within hard caps: contextFiles ≤5 (US-001/002/004 = 5, US-003 = 3); AC count ≤15.

**Only deviation:** US-001 = 12 ACs vs the repo's `maxAcCount: 10` (`src/config/schemas-infra.ts:184`). This is a **marginal faithful-split overage** (12 driven by 2 importable-splits of compound spec ACs, 0 orphans) — accepted per prior precedent (agent-bakeoff-mode US-004 was 11>10, accepted). No re-plan warranted.

## Verdict

✅ **Ready for `nax run`.** No blockers, no majors. The only cap deviation (US-001 12>10) is an accepted faithful-split overage; the two extra failure-path ACs are faithful materializations of spec §Failure Handling.
