# Spec-Review Phase 9 — PRD Fidelity: status-cost-json

**Spec:** `.nax/features/status-cost-json/spec.md`
**PRD:** `.nax/features/status-cost-json/prd.json`
**Reviewed against:** `projects/nax/repos/nax` @ `fe711dfc`
**Date:** 2026-07-10
**Verdict:** ✅ RESOLVED (2026-07-10) — the major (AC6/7/8) was resolved by user decision "Accept & extract dispatcher"; spec + PRD now aligned. Original findings retained below for the record.

## Resolution (2026-07-10)

User chose to **accept and embrace** the planner's expansion. Actions taken:
- Spec updated: status routing extracted into a new exported `dispatchStatusView(workdir,
  options, deps)` (`src/cli/status-dispatch.ts`); `bin/nax.ts` `.action()` delegates to
  it; US-002 ACs 6–8 rewritten to assert dispatch via spied deps; AC9 (I/O propagation)
  kept.
- PRD aligned (no re-plan, per the "keep 9 ACs" decision): US-002 AC6/7/8 rephrased to
  `dispatchStatusView`; `expectedFiles` gained `src/cli/status-dispatch.ts` +
  `test/unit/cli/status-dispatch.test.ts`.
- Result: spec 20 ACs (US-001 11 + US-002 9) ↔ PRD 20 ACs, 1:1; `Creates` ↔
  `expectedFiles` match; `dispatchStatusView` is a directly-tested seam (ACs 6–8) and
  also the seam for `emitCostReportJson`. Only untested residue = the one-line
  `bin/nax.ts` `--json` registration + delegation, routed to the build/typecheck gate.

---

## Story & AC mapping

| Story | Spec ACs | PRD ACs | Mapping |
|---|---|---|---|
| US-001 | 11 | 11 | 1:1, all faithful, behavioral, same symbols/inputs/outputs (reworded to Given/When/Then). No drift. |
| US-002 | 5 | 9 | Spec AC1–5 → PRD AC1–5 faithful. PRD **AC9** = faithful materialization of spec Failure-Handling prose (good). PRD **AC6/AC7/AC8** = drift (see major below). |

## Major — PRD AC6/AC7/AC8 promote spec build-gate wiring into runtime ACs against an untested layer

**Spec reference:** US-002 "Verification note (US-002 wiring)" + Design § Flag interactions. The spec **deliberately routed** the `bin/nax.ts` `--json` flag registration and the `if (options.cost && options.json)` route to the **build/typecheck gate**, explicitly stating "commander action handlers are not unit-tested in this repo."

**PRD reality:** `nax plan` converted that flag-interaction prose into three runtime ACs:
- AC6 — `--cost --json --last` → status action calls `emitCostReportJson`, not `displayLastRunMetrics`.
- AC7 — `--cost --json --model` → status action calls `emitCostReportJson`, not `displayModelEfficiency`.
- AC8 — `json:true, cost:false` → status action calls `displayFeatureStatus`, not `emitCostReportJson`.

**Codebase reality (substantiated):** the status routing is an **un-exported inline** `.action(async (options) => { ... })` closure in `bin/nax.ts:1308`. The existing `test/unit/cli/cli-status.test.ts` tests the **exported `displayFeatureStatus` directly** (calls `displayFeatureStatus({dir})`); it never imports `bin/nax.ts` nor exercises the commander closure. There is no established way to unit-test "the status action dispatches to X" in this repo.

**Consequence:** making AC6/7/8 green forces extracting the status command routing out of the `bin/nax.ts` closure into an exported, testable dispatcher — real scope expansion beyond the spec's "thin inline guard in bin" design, and it overrides the spec's explicit verification-routing decision.

**Recommended fix — pick one:**
1. **Accept & embrace (better design):** extract status routing into an exported `dispatchStatus(options, deps)` (or similar); AC6/7/8 become implementable and the routing gains test coverage. Grows US-002 modestly. Update the spec to match.
2. **Relax to spec intent:** edit `prd.json` to drop AC6/7/8 and restore the build/typecheck-gate verification note. US-002 → 6 ACs (spec AC1–5 + I/O AC9). **Note:** the planner's `normalizeCreatedContextFiles`/candidate-merge would not re-strip these, but re-running `nax plan` may re-promote them from the spec prose — if relaxing, also soften the spec's Flag-interactions wording so a re-plan doesn't re-derive them.

This is a **major, not a blocker**: AC6/7/8 are traceable to spec prose (not pure scope-bleed) and are implementable *if* the routing is extracted — but they contradict the spec's stated verification routing and expand scope, so the user should choose the direction before US-002 runs.

## Minor — PRD AC1 slightly weaker than spec AC1

**Spec:** "`emitCostReportJson` … usable as a function." **PRD AC1:** `typeof emitCostReportJson === "function"`. The behavioral "usable" intent narrowed to a typeof check. Still runtime, still valid; the fuller behavior is covered by AC2–5. No action needed.

## Minor — spec's "existing status-cost unit test" was inaccurate; PRD corrected it (fidelity *improvement*)

**Spec:** US-002 "Creates: (none — extends … the existing status-cost unit test)."
**Codebase reality:** there is **no** `test/unit/cli/status-cost.test.ts`. The PRD correctly sets US-002 `expectedFiles = ["test/unit/cli/status-cost.test.ts"]` — a **new** mirrored test file (per `test-architecture.md`: one test file per source file, `src/cli/status-cost.ts` → `test/unit/cli/status-cost.test.ts`). This is the planner fixing a spec inaccuracy, not a fidelity loss. **Recommend:** update the spec's US-002 `Creates` to list the new test file so the two agree.

## Minor — US-001 helpful contextFiles additions

PRD US-001 `contextFiles` adds `src/metrics/index.ts` (the barrel this story edits — legitimate read) and `test/unit/replay/json.test.ts` (pattern reference). Both are existing files and helpful context (§4d), not findings.

## File-role checks (§4) — clean

- **US-001** `expectedFiles = [report.ts, report.test.ts]` matches spec `Creates`. ✅
- **US-002** `expectedFiles = [status-cost.test.ts]` — new file, correctly in `expectedFiles` (see minor above). ✅
- **US-002** `contextFiles` includes `src/metrics/report.ts` — created by upstream US-001, correctly kept in the consumer's `contextFiles` (exists at US-002's runtime; §4c). ✅
- No self-created file mis-placed in `contextFiles`. ✅

## Meta-AC survival (§5)

The spec's single meta/verification-note (bin wiring → build-gate) was **not preserved as a note** — it was promoted into runtime AC6/7/8. That promotion is the subject of the major above.

## Bottom line

US-001 is clean and ready. US-002's 5 spec ACs plus the I/O-propagation AC9 are faithful and ready. The only decision blocking US-002 is **AC6/7/8**: accept the testable-dispatcher expansion (option 1) or relax back to the build-gate note (option 2).
