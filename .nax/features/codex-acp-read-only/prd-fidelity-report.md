# PRD Fidelity Report — codex-acp-read-only

**Spec:** `docs/specs/SPEC-codex-acp-read-only.md` (`ef49de81a`)
**PRD:** `.nax/features/codex-acp-read-only/prd.json` (`f80f3c973`, `nax plan --profile cross-agent,cc-plan`, nax 0.90.0)
**Date:** 2026-10-17
**Phase:** spec-review Phase 9 (PRD fidelity)
**Verdict:** ✅ ready — 0 blockers, 0 majors, 2 minors

## Summary

| Check | Examined | Findings |
|:--|:--|:--|
| 1. Spec AC → PRD AC mapping | 41 spec ACs (US-001 18, US-002 23) | 41/41 mapped 1:1, every pair ≥ 0.85 text similarity; no splits |
| 2. Behavioural fidelity + signature reality | 41 PRD ACs | 0 degraded; all keep their symbol, inputs and expected outcome; no file-content/grep ACs |
| 3. Orphan PRD ACs | 41 PRD ACs | 0 orphans; 2 `suggestedCriteria` (non-binding), see Minor |
| 3b. Dependency fidelity | 2 stories | spec `No dependencies.` ×2 → PRD `dependencies: []` ×2 |
| 4. File roles | 10 contextFiles, 3 expectedFiles | all contextFiles exist on disk; no self-created file in contextFiles; no expectedFile pre-exists |
| 5. Meta-AC survival | 0 meta-ACs | n/a |
| 5b. Correction survival | 12 spec-review corrections | 12/12 in `description` (most also in an AC or `modifiedFiles` reason); none only in `analysis` |
| 5c. PRD-AC satisfiability (Class B) | 5 invocation ACs with both endpoints existing (US-002 AC19-23) | `SessionManager.openSession` reaches `adapter.openSession` (`session/manager.ts:444`); `completeAsWithFallback` reaches `input.completeWithFallback` (`agents/manager-complete-as.ts:39`); US-001 open ACs reach `session/set_config_option` via `applyMode` (`open.ts`) |
| 6. Out-of-scope preservation | 14 spec bullets | 14/14 present (≥ 0.9 similarity), 0 orphans, 0 inverted into ACs, no story contradicts one |
| 7. Terminal-cleanup story | none in spec | n/a |
| 8. Modifies → modifiedFiles (by path) | 19 distinct spec paths (US-001 7, US-002 12) | 19/19 own entries, every `reason` populated, none opens mid-sentence; the two-part `registry.test.ts` reason kept whole |
| 9. Forward-reference drift re-sweep | 9 new symbols across ACs + descriptions | 0 drift (see note) |

## Spec AC → PRD AC

US-001 AC1-18 → PRD US-001 `acceptanceCriteria[0..17]`, same order, verbatim apart from tag stripping.
US-002 AC1-23 → PRD US-002 `acceptanceCriteria[0..22]`, same order, verbatim apart from tag stripping.

## Corrections checked (5b)

From spec-review passes 1-2: `sandboxFor`/`routerFor` gated on `entry?.preApproval` with callers passing `o.options.entry` / `options.entry`; test home `backend-codex.test.ts`; `CODEX_CONFIG_OPTIONS`; the `codexAcpSettings(opts.config ?? this._config)` one-line replacement; `options.config ?? input.config` precedence; `_codexAcpEnvDeps` lstat/stat split (`entryExists`); `agent-schema.test.ts` exact-default test; the honest `workspace-write` wording (OS sandbox, escalations approved under `full`); `INITIAL_AGENT_MODE` delivery. All present in the owning story's `description`.

## Forward-reference note (9)

Near-miss pairs reported by the sweep and ruled not drift:
- `codexAcpSettings` vs `CodexAcpSettings` — the function and its return type; both declared in the spec's worked skeleton.
- `CODEX_CONFIG_OPTIONS` vs `CLAUDE_CONFIG_OPTIONS` — the new fixture export beside the existing one.

## Minor

1. **Planner `suggestedCriteria`** (one per story, non-binding):
   - US-001: a codex `review` session rejects a file-edit permission request. Consistent with the spec (`decidePermission` rejects non-`execute` under `review`); harmless.
   - US-002: `withCodexAcpEnv` with `agentName` undefined returns its input unchanged. Matches the spec skeleton ("For any other agentName (or undefined) returns the input itself"); harmless.
2. **`branchName`** is `feat/codex-acp-read-only`; the working branch is `feat/codex-acp-read-only-2372`. Same mismatch as earlier features; left as is.

## Gate

PRD is fit for `nax run -f codex-acp-read-only` (requires user approval at launch).
