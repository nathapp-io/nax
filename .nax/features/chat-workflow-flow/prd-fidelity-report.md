# Spec Review (Phase 9 only) - chat-workflow-flow
**Spec:** /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/.nax/features/chat-workflow-flow/spec.md
**PRD:** /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/.nax/features/chat-workflow-flow/prd.json
**Reviewed against:** nax monorepo at 5049ac897
**Date:** 2026-11-15
**Phases run:** 1 of 9 (--phase 9: phases 1-8 skipped by request)
**Verdict:** ready (no blockers, no majors)

## Summary
- Phase 9: 92 of 92 spec ACs matched to PRD ACs (89 verbatim after backtick/quote normalisation, 3 reworded, see Minor); 7 of 7 stories mapped by ID; 4 dependency sets compared (US-003->US-002, US-006->US-005, US-007->US-005, rest empty), all equal; 5 contextFiles/expectedFiles role checks on Creates entries (US-001 x1, US-005 x2, US-006 x1, plus PRD-added test files), 0 self-Creates in contextFiles; 11 of 11 out-of-scope bullets present in `prd.outOfScope`, none inverted into an AC; 2 spec Modifies blocks (US-001 x1, US-002 x3, US-007 x1 = 5 paths) vs 5 `modifiedFiles` entries; 13 forward-referenced symbols re-swept across spec and PRD, 0 spelling drift.

## Checks

1. Spec AC to PRD AC mapping: complete. Per-story counts match exactly (US-001 9, US-002 15, US-003 8, US-004 7, US-005 12, US-006 23, US-007 18) and order is preserved. No missing, no orphan ACs.
2. Behavioural fidelity: all 92 are runtime ACs ([unit]/[integration] kept in the same positions); none degraded into file-content or grep assertions. Call shapes (`modelFor(undefined, undefined)`, `applyWorkflowDefaults`, `unknownWorkflowProfile`, `abandonedToolMessage(name, signal)`) are identical to the spec.
3. Orphan PRD ACs: none.
3b. Dependencies: spec and PRD sets are equal for every story, no invented or omitted edge.
4. File roles: every spec `Creates` file (similar-features.ts, schemas-chat.ts, runtime-types-chat.ts, workflow-defaults.ts) is in the owning story's `expectedFiles` and in no `contextFiles`. Every spec `Context Files` entry is in the matching story's `contextFiles`. `packages/nax/src/config/runtime-types-chat.ts` in US-007 `contextFiles` is produced by upstream dependency US-005 and is correctly kept (not a finding). Planner additions (feature-name.ts, nax-error.ts, job-argv.ts, new test files in `expectedFiles`) exist or are new tests owned by their story: helpful additions only.
5. Meta-ACs / correction survival: the spec's Modifies corrections (old-test rewrites for US-001, US-002, US-007) are carried in `modifiedFiles[].reason` and again in the story `description`, so they reach the implementer prompt (not only `analysis`).
5c. PRD-AC satisfiability: no PRD AC was split or newly introduced, so no new invocation-shaped AC exists beyond what the spec already carried.
6. Out-of-scope: all 11 bullets are present verbatim in `prd.outOfScope`; no spec exclusion appears as an AC; story `Scope - Out` text does not contradict a feature-level exclusion. None of the spec's bullets is story-scoped, so the `US-00N only:` prefix rule does not apply.
7. Terminal cleanup story: the spec has none; n/a.
8. Modifies to modifiedFiles by path count: 5 spec paths, 5 entries, each with `path` and `reason`; no comma-leading reason.
9. Forward-reference re-sweep: `similarFeatureNames`, `MAX_SIMILAR_FEATURES`, `NotStartedFeature`, `abandonedToolMessage`, `applyWorkflowDefaults`, `unknownWorkflowProfile`, `_workflowDefaultsDeps`, `WorkflowDefaultsApplied`, `ChatWorkflowConfig`, `ChatConfigSchema`, `DEFAULT_SPEC_FIX_ROUNDS`, `WorkflowProviderOptions`, `allowedTools` are spelled identically in spec and PRD (ACs and descriptions).

## Findings

### Blocker
None.

### Major
None.

### Minor
- **US-004 AC5 and AC6** reword the spec's "yields the error result / error message ... through `createSessionInteractionHandler`" into "`onInteraction(request)` rejects with a NaxError whose message equals ...". Verified against `packages/nax-agent/src/session/session-interaction.ts`: `answerFor` throws `toolError(outcome.content, ...)` for an error outcome, so a handler-level test can only observe a rejection. The expected message text is byte-identical to the spec, so this is a faithful refinement, not degradation. No action needed; consider aligning the spec wording at the next edit.
- **US-007 AC3** only rewords the quoting ("a line starting with the exact prefix ..."); the asserted prefix is identical.
- **US-005 contextFiles** adds `packages/nax/src/chat/jobs/job-argv.ts` (helpful addition, existing file).

## Recommendations
1. Proceed to `nax run`; no PRD patch or re-plan is required.
