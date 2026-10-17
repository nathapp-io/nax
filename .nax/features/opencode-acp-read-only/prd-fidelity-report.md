# PRD Fidelity Report — opencode-acp-read-only

**Spec:** `docs/specs/SPEC-opencode-acp-read-only.md` (`df806b456`)
**PRD:** `.nax/features/opencode-acp-read-only/prd.json` (`nax plan --profile cross-agent`, nax 0.90.0)
**Date:** 2026-10-17
**Phase:** spec-review Phase 9 (PRD fidelity)
**Verdict:** ✅ ready — 0 blockers, 1 major (patched in place), 3 minors

## Summary

| Check | Examined | Findings |
|:--|:--|:--|
| 1. Spec AC → PRD AC mapping | 39 spec ACs (US-001 20, US-002 19) → 81 PRD ACs (44 + 37) | 39/39 mapped; the planner split every compound AC into one PRD AC per assertion. Each split part keeps the spec's symbol, inputs and expected value |
| 2. Behavioural fidelity + signature reality | 81 PRD ACs | 0 degraded; no file-content/grep ACs; every call shape matches the spec or an existing signature (`unmetRequirement`, `buildCapabilityRecord`, `modeFor`, `selectModel`, `completeAsWithFallback`, `SessionManager.openSession`) |
| 3. Orphan PRD ACs | 81 | 0 material orphans. US-001 PRD AC 43 and 44 (tagged "failure handling": none/review/ask with a caller `OPENCODE_CONFIG_CONTENT` of `"{}"`) extend spec AC14/AC15 to the other profiles and trace to the spec's Failure Handling rows; see Minor 2 |
| 3b. Dependency fidelity | 2 stories | spec `No dependencies.` ×2 → PRD `dependencies: []` ×2 |
| 4. File roles | 11 spec Context Files, 5 Creates | Creates 5/5 in `expectedFiles`, none pre-exist, none in `contextFiles`. Context Files 10/11 kept; `backend-reconnect.test.ts` dropped (see Major 1) |
| 5. Meta-AC survival | 0 meta-ACs | n/a |
| 5b. Correction survival | 4 majors + 3 minors from spec-review pass 1 | all present in a `description` or an AC: outer `AgentAcpConfigSchema.default` literal and the `config/index.ts` barrel re-export (US-002 description + `modifiedFiles`); resumable fake + `crash()` for the relaunch AC (US-001 description + AC 34); `withOpencodeAcpEnv` input classes (US-002 ACs 20-24); `AgentAcpConfig` name (US-002 description); regression-anchor label (US-001 ACs 41-42). None only in `analysis` |
| 5c. PRD-AC satisfiability (Class B) | 9 invocation ACs with both endpoints existing | `createAgentSession` → `openAcpSession` launch (US-001 ACs 26-34, 43-44); reconnect → `connect` → `openAcpSession` when the fake advertises resume (`backend.ts` `liveFor`/`canRestore`); review + policy sandbox → `routerFor` drops the sandbox → `REVIEW_NO_SANDBOX_REASON` (ACs 35-37); `SessionManager.openSession` → adapter `openSession` (`manager.ts:449`); `completeAsWithFallback` → `input.completeWithFallback` (`manager-complete-as.ts:40`) |
| 6. Out-of-scope preservation | 12 spec bullets | 12/12 present (≥ 0.9 similarity), 0 PRD-only entries, none inverted into an AC, no story contradicts one |
| 7. Terminal-cleanup story | none in spec | n/a |
| 8. Modifies → modifiedFiles (by path) | 17 distinct spec paths (US-001 4, US-002 13) | 17/17 own entries, every `reason` populated, none opens mid-sentence |
| 9. Forward-reference drift re-sweep | 14 new symbols over all PRD ACs and descriptions | 0 drift (only generic words like `settings` / `launch` matched as substrings) |

## Major

1. **Dropped context file (§4b): `packages/nax-agent-acp/test/unit/client/backend-reconnect.test.ts`.** The spec's US-001 lists 6 Context Files; the planner keeps 5 (plan log: `declaredCount 6, presentCount 5, dropped [backend-reconnect.test.ts]`). That file is the reconnect pattern the spec-review M3 fix pointed at. The behaviour itself survived (US-001 description mentions the resumable fake and `crash()`; PRD AC 34 names `InMemoryAgent.crash()` and a fake advertising resume). **Patched in place:** one sentence appended to the US-001 `description` naming the file, its `RESUMABLE` script and `fake.crash()`; a structural diff confirms nothing else in `prd.json` changed. For future specs: keep a story's Context Files at 5 or fewer.

## Minor

1. **Planner `suggestedCriteria`** (non-binding): US-001 — frozen `none`/`review` records; a resumed (not reconnected) session's launch carries the policy. US-002 — mkdir-throws returns the input by reference; an existing `OPENCODE_CONFIG_DIR` returns the input by reference; `{ agent: { acp: {} } }` and `{ opencode: {} }` default to `{ isolateConfig: false }`; request config enabling isolation beats a manager config disabling it; `NAX_GLOBAL_CONFIG_DIR` relocates `isolatedOpencodeConfigDir()`. All consistent with the spec; harmless.
2. **US-001 PRD ACs 43 and 44** (none/review/ask with a caller `OPENCODE_CONFIG_CONTENT` of `"{}"`) go slightly beyond spec ACs 14-15 (read/full only). Both follow directly from the spec's Failure Handling rows ("enforcement value replaces it" for none/read/review; "passed through unchanged" for full or ask) and from the Design's `{ ...options.env, ...launchEnvFor(...) }`, so they add no scope.
3. **`branchName`** is `feat/opencode-acp-read-only`; the working branch is `feat/opencode-acp-read-only-2372`. Same mismatch as earlier features; left as is.

## Gate

PRD is fit for `nax run -f opencode-acp-read-only` (requires user approval at launch).
