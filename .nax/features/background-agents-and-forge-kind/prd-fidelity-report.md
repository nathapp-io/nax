# Spec Review (Phase 9 only) - background-agents-and-forge-kind
**Reviewed against:** spec.md (as edited during planning) and prd.json (7 stories)
**Date:** 2026-11-16
**Phases run:** 1 of 9 (--phase 9: phases 1-8 skipped by request)
**Verdict:** ready (0 blockers, 0 majors, 3 minors)

## Summary
- Phase 9: 104/104 spec ACs matched to PRD ACs (US-001 22, US-002 12, US-003 9, US-004 9, US-005 22, US-006 9, US-007 21 of 24; all in original order, none degraded; 3 strengthened with literals checked against code); 7/7 stories and dependency sets match (US-007 -> US-005, US-006; others empty); file roles: 7 stories, Creates -> expectedFiles 15/15, no self-created file in contextFiles; Modifies -> modifiedFiles 6/6 paths (US-002 5, US-006 1), no comma-leading reasons; outOfScope 15/15 verbatim, none inverted into an AC; forward references: ~58 symbols re-swept over PRD ACs, 0 spelling drift; meta-ACs: none in spec; terminal-cleanup story: none in spec.

## Late-edit presence
| Item | Status |
|:--|:--|
| (a) configuredForgeKind / autoPrForge / capturedForgeKind, no explicitForgeKind dep, no typed read, US-001 AC-22 | present (description Approach; AC-22; `explicitForgeKind` appears nowhere in prd.json) |
| (b) forge schema no prefault/default | present (description code block comment; analysis repeats it) |
| (c) newId(prefix) bash/agent | present (US-005 description) |
| (d) US-004 AC-8, AC-9, AC-6 createInboundRouter(...).attach(...) | present |
| (e) US-003 AC-8/9 hanging-model qualifier | present |
| (f) TurnEndAbort tagged class | present (US-003 and US-004 descriptions and Interface blocks) |

## Findings
### Minor - orphan ACs US-007 AC-22, AC-23, AC-24
Each is traceable to a spec Failure Handling row (idle ask, approval timeout, thrown error in log). No new scope. US-007 now has 24 ACs, exactly at maxAcCount 24, so it has no headroom. Fix: none; do not add more ACs to US-007.

### Minor - US-001 suggestedCriteria[1]
Reads "context.config.forge.kind", the typed-read wording the spec's late edit removed. suggestedCriteria is not an authoritative channel, but it contradicts the cast-based helper. Patch: userStories[US-001].suggestedCriteria[1] = "The auto-PR action selects github when capturedForgeKind returns github and the context's config holds forge: { kind: \"gitlab\" }."

### Minor - extra contextFiles
Planner added existing files not in the spec: US-002 types.ts, US-003 session-interaction-abandoned.test.ts, US-004 tool-calls.test.ts, US-007 subagent-session.ts. Helpful, within limits.

## Notes (not PRD findings)
- spec.md line 226 (Integration, `_autoPrDeps` bullet) still says "then `context.config.forge?.kind`". That is stale against the Approach text. The PRD description does not carry it, so the PRD is correct. Fix the spec if it will be re-read.
- Strengthened ACs verified against code: US-006 AC-9 text matches agents-provider.ts:38; US-007 AC-4 text matches subagent-runs.ts:205; US-004 AC-5 only restates the expected text. Satisfiability spot-check: `formatJobStrip(jobs, tasks)`, `sessionFor`, `_adapterDeps.setTimeout` (deadline timer at session-adapter.ts:268 precedes the round-trip timer at :325), the `task` input of nax-tasks tools, and `attach` on the inbound router all exist.
