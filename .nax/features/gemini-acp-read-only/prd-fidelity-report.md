# PRD Fidelity Report — gemini-acp-read-only

**Spec:** `docs/specs/SPEC-gemini-acp-read-only.md` (`6b849d41f`)
**PRD:** `.nax/features/gemini-acp-read-only/prd.json` (`nax plan --profile cross-agent`, nax 0.90.0)
**Date:** 2026-10-17
**Phase:** spec-review Phase 9 (PRD fidelity)
**Verdict:** ✅ ready — 0 blockers, 0 majors, 3 minors

## Summary

| Check | Examined | Findings |
|:--|:--|:--|
| 1. Spec AC → PRD AC mapping | 36 spec ACs (US-001 18, US-002 18) → 81 PRD ACs (42 + 39) | 36/36 mapped. The planner split compound ACs into one PRD AC per assertion; every split part keeps the spec's symbol, inputs and expected value. Spot-checked the low-similarity matches part by part: malformed offers (US-001 PRD AC 3), `modeFor("full")` (8), restore via `session/load` and via `session/resume` (26-27), `setModeFailure` and `setModelFailure` (28, 30), the 60-id refusal and 50-entry cap (32-33), `/custom` and empty `GEMINI_CLI_HOME` source homes (US-002 12-13), the no-`env` input (25), the empty-string model env (28-29), the `SessionManager.openSession` seam (38) |
| 2. Behavioural fidelity + signature reality | 81 PRD ACs | 0 degraded; no file-content/grep ACs; call shapes match the spec or existing signatures (`unmetRequirement`, `buildCapabilityRecord`, `modeFor`, `createAgentSession`, `SessionManager.openSession`) |
| 3. Orphan PRD ACs | 81 | 0 material orphans |
| 3b. Dependency fidelity | 2 stories | spec `No dependencies.` ×2 → PRD `dependencies: []` ×2 |
| 4. File roles | 10 Context Files, 6 Creates | Context Files 10/10 kept (5 per story, none dropped); Creates 6/6 in `expectedFiles`, none pre-exist, none in `contextFiles` |
| 5. Meta-AC survival | 0 meta-ACs | n/a |
| 5b. Correction survival | 1 blocker + 3 majors (pass 1) and 4 polishes (pass 2) | all in a `description` or an AC: `setModeFailure`/`setModelFailure` and the `MAX_OFFERED_MODELS` (50) combined cap (US-001 description + ACs 28-33); settings rewritten on every call and non-string/array/`null` `selectedType` (US-002 description + ACs 16-20); the `acp-env.test.ts` literal-settings wording (`modifiedFiles` reason); resume variant (US-001 AC 27); `profile full` on the refusal ACs; set_model failure (US-001 AC 30); no-`env` input (US-002 AC 25). None only in `analysis` |
| 5c. PRD-AC satisfiability (Class B) | 8 invocation ACs with existing endpoints | `establish` runs `applyConfig` after both `newSession` and `restoreSession` (`open.ts`), so restore re-applies the mode; config options are tried before the session blocks; `routerFor` gives gemini no sandbox, so `full` + `execute` records `FULL_REASON`; `unmetRequirement` yields capability `tools` for an embedder tool; `SessionManager.openSession` → `selectModel` → `withAcpEnv` |
| 6. Out-of-scope preservation | 13 spec bullets | 13/13 present (≥ 0.9 similarity), 0 PRD-only entries, none inverted into an AC, no story contradicts one |
| 7. Terminal-cleanup story | none in spec | n/a |
| 8. Modifies → modifiedFiles (by path) | 21 distinct spec paths (US-001 10, US-002 11) | 21/21 own entries, every `reason` populated, none opens mid-sentence |
| 9. Forward-reference drift re-sweep | 16 new symbols over all PRD ACs and descriptions | 0 drift (the only near-match, `AgentAcpConfigSchema` vs `AgentGeminiAcpConfigSchema`, is the existing schema the new one is added to) |

## Minor

1. **Sibling-referencing split (US-001 PRD AC 33):** "When that 60-id model offer is refused…" refers to AC 32 instead of restating its setup. Each PRD AC becomes its own test, so the implementer must carry AC 32's fixture into AC 33; the reference is unambiguous, so left as is.
2. **Planner `suggestedCriteria`** (non-binding, 5 + 4). Consistent with the spec, with one note: US-002's suggestion about a later source settings file losing `selectedType` must not be read as requiring the isolated file to be removed — the spec's Out of Scope leaves a previously written isolated settings file in place.
3. **`branchName`** is `feat/gemini-acp-read-only`; the working branch is `feat/gemini-acp-read-only-2372`. Same as earlier features; left as is.

## Gate

PRD is fit for `nax run -f gemini-acp-read-only` (requires user approval at launch).
