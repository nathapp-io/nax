# PRD Fidelity Report — agent-bakeoff-mode

**Spec:** `docs/specs/SPEC-agent-bakeoff-mode.md`
**PRD:** `.nax/features/agent-bakeoff-mode/prd.json` (planner: codex, profile `cross-agent-mm`)
**Date:** 2026-07-04
**Phase:** spec-review Phase 9 (PRD fidelity)
**Verdict:** ✅ PASS — 0 blockers, 0 majors, 1 note

---

## 1. Spec AC → PRD AC mapping

| Story | Spec ACs | PRD ACs | Mapping |
|---|---|---|---|
| US-001 | 7 | 7 | 1:1, verbatim behavior + symbols preserved |
| US-002 | 8 | 8 | 1:1, symbols/inputs/expected preserved |
| US-003 | 8 | 9 | 8 mapped 1:1; **+AC9** (`timeout` status) |
| US-004 | 8 | 11 | 8 mapped 1:1; **+AC7, +AC9, +AC11** |
| **Total** | **31** | **35** | all spec ACs present; +4 faithful additions |

Every spec AC maps to ≥1 PRD AC. Every PRD AC remains a runtime `[unit]`/`[integration]` test (same symbol, same inputs, same expected output/exception/invocation). No AC was rewritten into a file-content / grep assertion; no asserted arguments were dropped.

## 2. Added PRD ACs — all grounded in spec (no scope bleed)

- **US-003 AC9** (`timeout`) — the spec's `ContestantStatus` enum lists `timeout` and Failure Handling states "the contestant boundary records `timeout` when those bounds are exhausted." The planner added the missing dedicated AC. Faithful.
- **US-004 AC7** (first contestant DNFs, later runs anyway, both in result) — realizes the spec's Failure Handling §"Fail-open mid-run (per-contestant isolation)."
- **US-004 AC9** (exit 0 when ≥1 contestant finishes) — realizes the spec's CLI Behavior §Exit Codes.
- **US-004 AC11** (no `--compare` → existing single-agent path, `runBakeoff` not called) — inverse of the CLI routing seam (spec US-004 AC8); guards against regressing the default path.

No PRD AC introduces a new enum value, status, config key, or validation behavior absent from the spec.

## 3. AC-count note (US-004: 11 > maxAcCount 10)

`precheck.storySizeGate.maxAcCount` defaults to 10; US-004 lands at 11 purely from the planner's faithful atomic split of spec-described behaviors (isolation, exit codes, CLI-routing inverse). Per standing project practice, a marginal overage from faithful splitting does not warrant a re-plan. (US-003 at 9 is within cap.)

## 4. File-role delta (`contextFiles` vs `expectedFiles`)

- **US-001** — `expectedFiles` = 4 creates (types/ranking/index/test) ✓; `contextFiles` = `src/metrics/types.ts` ✓.
- **US-002** — `expectedFiles` = preflight + test ✓; `contextFiles` added `src/config/runtime-types-agent.ts` (existing file, helpful — supports the `agent.fallback.enabled` reference). Minor helpful addition, **not a finding** (§4d).
- **US-003** — `expectedFiles` = contestant + test ✓; `contextFiles` = 5 (matches spec) ✓.
- **US-004** — `contextFiles` = `bin/nax.ts`, `metrics/tracker.ts`, `preflight.ts` (US-002), `contestant.ts` (US-003), `ranking.ts` (US-001) = 5 ✓. The three cross-story produced files are correctly in `contextFiles` (they exist at US-004's runtime — dependencies run first), not `expectedFiles`. `src/commands/runs.ts` correctly excluded (style precedent only). `expectedFiles` = coordinator/report + 2 tests ✓.

No self-created file placed in its own story's `contextFiles`. No upstream-produced file dropped or mis-moved.

## 5. Meta-AC survival / removal keywords

No meta-ACs in the spec; none to lose. No removal keywords (`delete|remove|consolidate|retire|rename`) affecting existing code → no terminal-cleanup story required (the `WorktreeManager.remove` reference is an API method, not a code deletion).

---

## Conclusion

The PRD faithfully preserves all 31 spec ACs and adds 4 grounded ACs (all tracing to spec-described behavior). Dependency DAG (US-001 → US-002/US-003 → US-004) matches the spec. File-roles are correct. The only note is US-004's marginal +1 AC-count overage from faithful splitting, which is acceptable per standing practice. **Ready for `nax run`.**
