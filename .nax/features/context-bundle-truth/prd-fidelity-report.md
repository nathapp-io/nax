# PRD Fidelity Report — context-bundle-truth

**Spec:** `docs/specs/SPEC-context-bundle-truth.md`
**PRD:** `.nax/features/context-bundle-truth/prd.json`
**Planned:** 2026-08-09, `nax plan` 0.77.3, profile `cross-agent` (codex, 140s session turn)
**Reviewed against:** `main` @ `dbeaacb4`
**Verdict:** ✅ ready — 0 blockers; 3 majors found and fixed in both spec and PRD

## Summary

| Check | Result |
|:---|:---|
| 1. Spec AC → PRD AC mapping | ✅ all mapped; 26 spec ACs → 27 PRD ACs (one atomic split in US-003) |
| 2. Behavioural fidelity + signature reality | ✅ all Given/When/Then runtime ACs; `packChunks`, `assemble`, `rebuildForAgent` call shapes match real signatures |
| 3. Orphan PRD ACs | ⚠️ 1 planner-authored AC (`floorOverageItems`) — traceable to a Failure Handling row, but unsupported by the Design. **Fixed.** |
| 4. File-role delta | ✅ no self-`Creates` in own `contextFiles`; US-003's `rebuild.ts` is a legitimate upstream read from US-001; planner added 3 existing files (minor, useful) |
| 5b. Correction survival | ✅ all four spec-review corrections reached a `description` or an AC — none stranded in `analysis` |
| 5c. PRD-AC satisfiability | ✅ no Class B invocation ACs (US-001's stub target is created by this spec) |
| 6. Out-of-scope preservation | ✅ 12/12 bullets verbatim; none inverted into an AC; no story contradicts one |
| 7. Terminal-cleanup story | n/a — spec has none |

## Majors found and fixed

### M1 — `chunkIdMap` survived in prose but not as an assertion

The spec's US-003 order AC ended "…**so `manifest.rebuildInfo.chunkIdMap` pairs each prior id with itself**". `nax plan` kept the leading clause and dropped the trailing one; a token sweep found `chunkIdMap` in **0 of 27** PRD ACs.

Not invisible — the full rationale survived verbatim in US-003's `description` (Approach), including the `orchestrator.ts:537-542` citation. But the ACs are the acceptance-test surface and the reviewer's quote surface, so the index-zip correctness the review was built to protect had no test pinning it.

**Fix:** split into a standalone AC in both artefacts. `chunkIdMap` now appears in 1 PRD AC.
🔑 A trailing `so …` clause is the planner's natural cut point — put a load-bearing assertion in its own AC.

### M2 — planner-authored AC the Design did not support

US-003 gained: *"…`manifest.floorOverageItems` contains every floor chunk ID that overflowed the effective budget."* Legitimate Rule-11 behaviour (it traces to the spec's Failure Handling row), and `floorOverageItems` is real (`manifest-types.ts:137`, filled from `PackResult.floorOverageIds` at `manifest-builder.ts:90`).

But `rebuildForAgent` builds its manifest by spreading `...prior.manifest` and never calls `buildManifest`, so the field carries the **prior** bundle's value. An implementer following the Design alone would spread the stale value and go red with no guidance.

**Fix:** Design now directs the rebuild to overwrite `floorOverageItems` from the new `PackResult`; the AC is sharpened to "lists exactly … rather than the prior bundle's values".

### M3 — no story was authorised to edit anything

`modifiedFiles` was `[]` for all four stories — the spec had no `### Modifies` block. Harmless for created files, but US-004 must **edit** `test/unit/context/engine/packing.test.ts` to replace the #1448 fixture, and US-001/US-002 must edit `orchestrator.ts`. Those sat only in `contextFiles`, which is read semantics.

Since test-authorship isolation is precisely why spec-review graded that fixture a blocker, leaving the edit unauthorised risked re-creating the deadlock the review prevented.

**Fix:** `### Modifies` block added to the spec (between `## Stories` and `## Acceptance Criteria`); `modifiedFiles` populated per story in the PRD.

## Post-fix state

| Story | ACs | modifiedFiles |
|:---|:---|:---|
| US-001 | 6 | `orchestrator.ts` |
| US-002 | 6 | `orchestrator.ts` |
| US-003 | 10 | `rebuild.ts` |
| US-004 | 6 | `packing.ts`, `packing.test.ts` |

28 ACs total, max 10 per story against `maxAcCount: 16`. `outOfScope` 12/12 intact. Spec and PRD are aligned; the PRD was hand-patched rather than re-planned, so no new drift was introduced.
