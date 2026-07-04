# PRD Fidelity Report — flaky-test-quarantine

**Spec:** `docs/specs/SPEC-flaky-test-quarantine.md`
**PRD:** `.nax/features/flaky-test-quarantine/prd.json` (generated 2026-07-04, profile `cross-agent-mm`, planner agent codex)
**Phase:** spec-review Phase 9
**Verdict:** ✅ PASS — 0 blockers, 0 majors, 3 notes

## 1. Spec AC → PRD AC mapping

| Story | Spec ACs | PRD ACs | Mapping |
|---|---|---|---|
| US-001 | 10 | 11 | 1:1 for ACs 1–9; spec AC 10 (timeout/env counts as failed probe, two sub-assertions) faithfully atomic-split into PRD ACs 10+11 |
| US-002 | 9 | 10 | 1:1 except spec AC 5 (flaky→relabel / consistent→keep, compound) faithfully split into PRD ACs 5+6 |
| US-003 | 6 | 6 | 1:1; PRD AC 2 adds the qualifier "and there are no other blocking findings" — a faithful tightening, not drift |
| US-004 | 6 | 6 | 1:1 |

No spec AC is missing from the PRD. Every PRD AC remains a runtime Given/When/Then behavior — no grep/file-content degradation, no dropped asserted arguments.

## 2. AC-count note (US-001: 11 > maxAcCount 10)

`precheck.storySizeGate.maxAcCount` defaults to 10; US-001 lands at 11 purely from the planner's faithful atomic split of a compound spec AC. Per standing project practice, a marginal overage from faithful splitting does not warrant a re-plan.

## 3. Orphan / suggested criteria

- **US-001 `suggestedCriteria` (mergePackageConfig deep-merge)** — technically scope beyond the spec's AC list, but it exposes a REAL gap: `mergePackageConfig()` (`src/config/merge.ts:71`, verified) shallow-spreads `packageOverride.execution` and deep-merges only known subtrees; without a `flakeDetection` sub-merge, a partial package override clobbers the root block. The spec's Config section has been amended to require the sub-merge in US-001. **Recommendation: treat this suggested criterion as in-scope for US-001's implementation** (the spec now mandates the merge.ts change); promoting it to a formal AC would push US-001 to 12 and is left to the operator's discretion.
- **US-002 `suggestedCriteria` (non-eligible findings pass through unchanged)** — traceable to the design ("input: `failed-test` findings"); harmless, useful.

## 4. File-role delta

- US-001: `Creates` → `expectedFiles` ✓ (`flake-probe.ts`); all 5 spec Context Files present in `contextFiles` ✓. Note: `src/config/merge.ts` is absent from `contextFiles` — with the amended spec, the implementer should also read it (minor; surfaced here rather than hand-editing the PRD).
- US-002: upstream-produced `flake-probe.ts` correctly **kept** in consumer `contextFiles` ✓; `flake-triage.ts` in `expectedFiles` ✓.
- US-003/US-004: modification-only stories, upstream `flake-triage.ts` correctly in `contextFiles`, no `expectedFiles` ✓.

## 5. Meta-ACs / terminal-cleanup

None in spec; nothing to verify.

## Notes for the run

1. US-001 implementer must edit `src/config/merge.ts` (flakeDetection sub-merge) — spec amended, PRD `suggestedCriteria` covers it, `contextFiles` does not list it.
2. Planner analysis correctly warns: `gateRegressedAfterRectification` keyless-failure handling must not be weakened when excluding `flaky-test` (phase-eval.ts:142) — US-003 AC 5 covers the positive case; keyless behavior is guarded by existing tests.
3. Routing: all four stories → `opencode` / balanced / `tdd-simple` under profile `cross-agent-mm`.
