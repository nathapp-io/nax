# PRD Fidelity Report — mutation-spot-check

**SPEC:** `docs/specs/SPEC-mutation-spot-check.md`
**PRD:** `.nax/features/mutation-spot-check/prd.json`
**Planner:** `nax plan` with profile `cross-agent-mm` (codex)
**Date:** 2026-07-05
**Verdict:** ✅ PASS (0 blockers)

## AC counts per PRD story

| Story | Spec | PRD | >10? |
|:--|:--|:--|:--|
| US-001 Config | 6 | 6 | no |
| US-002 Generation | 9 | 9 | no |
| US-003 Apply & classify | 5 | 5 | no |
| US-004 `mutationCheckOp` | 9 | 9 | no |
| US-005 Phase integration | 6 | 6 | no |

35 total, all ≤ 10-AC cap.

## Summary counts

- Spec ACs mapped: **35 / 35**
- Dropped: **0**
- Degraded (symbol/args lost): **0**
- Rewritten to grep/file assertion: **0**
- Orphaned PRD ACs: **0**
- Meta-ACs lost: **0**
- File-role inversions (self-created file under own `contextFiles`): **0**

## Checks

1. **Spec AC → PRD AC mapping.** All 35 spec ACs map 1:1 in order to a PRD AC. No dropped behavior.
2. **Behavioural fidelity.** Every PRD AC keeps the same symbol/inputs/expected output. Verified: classify status mapping (`TEST_FAILURE`→killed, `SUCCESS`→survived, `ENVIRONMENTAL_FAILURE`/`ASSET_CHECK_FAILED`/`TIMEOUT`→errored) intact at both core (US-003) and op (US-004) level; config defaults (`enabled===false`, `maxMutants===3`) intact; op descriptor shape (`kind`/`name`/`stage`) intact.
3. **Orphan PRD ACs.** None. Only elaboration: US-001 PRD AC5 names `mergePackageConfig()` as the merge entrypoint (concretization of the spec's "field-wise spread merge", grounded by PRD analysis against `src/config/merge.ts`) — not scope bleed.
4. **Verification-mechanism tags.** No `[grep]`/`[file]`/`[verbatim]` tags; no shell commands in any AC. Planner reformatted ACs into Given/When/Then prose and dropped the inline `[unit]`/`[integration]` labels from AC text — informational, not a defect (mechanism implied by `routing.testStrategy: tdd-simple`).
5. **Meta-AC survival.** All architectural ACs survive as runtime PRD ACs (US-005 `STRICT_VERDICT_PHASE_NAMES` check, CANONICAL_ORDER position, advisory-no-short-circuit; US-004 op descriptor).
6. **File-role fidelity.** No self-created file placed under its own `contextFiles`. Upstream-produced files (`mutation/index.ts`, `mutation/types.ts`, `mutation-check.ts`) correctly kept in downstream `contextFiles`. Edit-only US-001/US-005 have empty `expectedFiles`.

## Verdict

**PASS.** The spec→PRD transformation preserved all load-bearing assertions. Ready for `nax run -f mutation-spot-check` (pending explicit approval).
