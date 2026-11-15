# Spec Review (Phase 9 only) - chat-job-panel PRD fidelity
**Spec:** .nax/features/chat-job-panel/spec.md
**PRD:** .nax/features/chat-job-panel/prd.json
**Reviewed against:** nax monorepo at de2346b16
**Date:** 2026-11-15
**Phases run:** 1 of 9 (--phase 9: phases 1-8 skipped by request)
**Verdict:** revisions needed (0 blockers, 1 major, 3 minors)

## Summary
- Phase 9 only. Examined: 7 stories (dependency sets), 117 spec ACs matched to PRD ACs (see table), 11 out-of-scope bullets, 7 context/created file lists, 2 spec `### Modifies` paths, 20+ forward-referenced symbols re-swept across PRD descriptions and ACs, 5 existing-signature ACs checked against real code.
- Blockers: 0. Majors: 1. Minors: 3.

## Spec AC -> PRD AC mapping

| Story | Spec ACs | PRD ACs | Result |
|:--|:--|:--|:--|
| US-001 | 19 | 24 | spec 1-19 map to PRD 1-20 verbatim (PRD 1-20 also covers the spec's `readJobStatus` AC); PRD 21-24 are additions, traceable (see minors) |
| US-002 | 22 | 22 | 22/22 verbatim |
| US-003 | 22 | 22 | 22/22 verbatim |
| US-004 | 15 | 15 | 15/15 verbatim |
| US-005 | 15 | 15 | 15/15 verbatim |
| US-006 | 14 | 14 | 14/14; PRD AC 14 adds a clarifying clause (see minors) |
| US-007 | 16 | 18 | 16/16 verbatim; PRD 17-18 additions, traceable |

No spec AC is missing or degraded. No AC was rewritten into a file-content or grep assertion. Asserted values (2520000, 66666, 33333, 115200, 38400, `Nov 14 23:05`, `1h 05m`, 5 full and 11 empty cells, 3300000, 1800000) are unchanged.

Signature reality check: `compactionThreshold(window, cfg)`, `shouldCompact(tokens, window, cfg)`, `keepBudget(window, cfg, aggressive)` match `packages/nax-agent/src/native/session/compaction.ts` (lines 108, 113, 121). `readRunProgress(job, repoRoot)` matches `job-outcome.ts:39` and its `{cost, progress}` projection. No contradiction.

## Dependency fidelity (3b)
Spec vs PRD sets match for all 7 stories: US-001 [], US-002 [US-001], US-003 [US-001, US-002], US-004 [], US-005 [], US-006 [US-005], US-007 [US-006]. No finding.

## File-role delta (4)

### MAJOR - US-006 `schemas-chat.ts` and `runtime-types-chat.ts` mis-moved into `expectedFiles`
- PRD location: `userStories[US-006].expectedFiles` holds `packages/nax/src/config/schemas-chat.ts` and `packages/nax/src/config/runtime-types-chat.ts`; neither is in `contextFiles`.
- Spec text: `### Context Files` / **US-006** lists both as reads ("`ChatConfigSchema` (from `chat-workflow-flow`)", "`ChatConfig` (from `chat-workflow-flow`)"). The spec's `### Creates` never lists them. The Summary says the feature "extends the `chat` config block added by the `chat-workflow-flow` feature".
- Reality: both files are absent on disk (expected, sibling feature) and are produced by `chat-workflow-flow`, not by this PRD. US-006 extends them, it does not author them. Listing them in `expectedFiles` tells the implementer they are created by this story, which invites a competing chat config file and loses the read hint. The story's own description ("without implementing a competing chat-workflow configuration") contradicts its `expectedFiles`.
- Severity: major (spec-listed read hint dropped from `contextFiles` and mis-moved to the consumer's `expectedFiles`, section 4c). Not a blocker because the producer is a sibling feature that merges first.
- Fix to prd.json: in US-006, remove both paths from `expectedFiles` and add them to `contextFiles` (after `packages/nax/src/chat/open-chat-session.ts`). `expectedFiles` should keep only `chat-compaction.ts` and the two new test files. If `nax plan` re-strips them (the producer is outside this PRD's dependency graph), flag the planner rather than re-hand-editing.

## Out-of-scope preservation (6)
- 11/11 spec bullets present in `prd.outOfScope`, order and wording identical. No missing item, no orphan entry.
- No out-of-scope statement became an AC; no story scope declaration contradicts a feature-level exclusion. Per-story `**Scope** - Out:` text only restates exclusions or names other stories. No `story.outOfScope` arrays (expected, root field is the SSOT).
- No story-scoped deferral hoisted without prefix (the spec has none).

## Modifies -> modifiedFiles (8)
- Spec `### Modifies`: 2 paths, both under US-004, one per bullet. PRD US-004 `modifiedFiles`: 2 entries with path and reason, neither reason opens with a comma. Match. All other stories declare "None" in both.

## Meta-AC, correction survival, terminal cleanup
- The spec has no meta-ACs and no terminal-cleanup story. The spec's design constraints (no `setInterval`, no growth of `chat-status.ts`, barrel imports, panel content not in agent context) are carried into the descriptions of US-001, US-003, US-007, and the matching exclusions into `outOfScope`.
- No earlier-round corrections are recorded as living only in `analysis`; the descriptions carry the full Approach text.

## PRD-AC satisfiability (5c)
Invocation-shaped PRD ACs with both endpoints existing: US-006 AC 12-14 (`openChatSession` -> stubbed `nativeBackend`; `runSubagent` -> `_subagentSessionDeps.nativeBackend`) and US-007 AC 16 (`deps.renderChat`). These are the spec's own ACs verbatim (AC 14 plus a clause); the spec's seam statements are unchanged. No PRD-introduced invocation AC, so no new satisfiability exposure.

## Forward-reference drift re-sweep (9)
Re-swept: `buildJobPanelView`, `readJobPanelView`, `readJobStatus`, `decisionBody`, `_jobPanelDeps`, `JOB_PANEL_LOG_LINES`, `JOB_PANEL_DECISION_ROWS`, `JOB_PROGRESS_CELLS`, `JOB_PANEL_REFRESH_MS`, `formatElapsed`, `jobPanelLines`, `upsertJobPanel`, `hasJobPanel`, `useJobPanels`, `turnEndClock`, `turnStatsText`, `turnStatsEntry`, `MIN_COMPACT_AT_TOKENS`, `chatCompactAtTokens`, `idleCompactAfterMs`, `idleCompactAfterMinutes`, `createIdleCompactor`, `IDLE_COMPACT_MIN_TOKENS`, `useIdleCompact`, `DEFAULT_CHAT_COMPACT_AT_TOKENS`, `DEFAULT_IDLE_COMPACT_AFTER_MINUTES`. All spelled byte-identically across the spec, descriptions and ACs. No near-miss variants. No finding.

## Minors (no PRD edit required)
1. US-001 has 24 ACs, exactly at the `maxAcCount` 24 gate (not over). The 5 additions beyond the spec's 19 are traceable: PRD 21-23 pin the spec's Failure Handling rows (missing status, prd, decisions sources); PRD 24 pins the Modifies note "`readRunProgress` keeps its behaviour". No further additions to this story without a split.
2. US-007 PRD AC 17 (failed idle compaction, no retry) and AC 18 (no `idleCompactAfterMs` prop means off) are traceable to the spec's Failure Handling table and the `ChatAppProps` target ("absent means 0, off"). Not scope bleed.
3. US-006 PRD AC 14 adds "and whose `execution.compaction` has no `compactAtTokens`" to the spec's `runSubagent` AC. It narrows the fixture rather than changing the assertion, and matches the spec's intent. Acceptable.
4. Helpful context additions (US-004 `ui/chat/turn-stats.test.tsx` and `transcript-model.ts`; US-005 `native-backend-compaction.test.ts`; US-006 `config/runtime-types.ts`; US-007 `cli/chat.ts` and `chat-compact.test.tsx`) all exist on disk. Note US-006 and US-007 modify `runtime-types.ts`, `ChatApp.tsx`, `cli/chat.ts` while the spec's Modifies says None; that is a spec-level choice carried through faithfully, not a PRD defect.

## Recommendations
1. Patch US-006 `contextFiles`/`expectedFiles` as described under the major finding. Everything else is faithful and ready for `nax run` once `chat-workflow-flow` is merged.
