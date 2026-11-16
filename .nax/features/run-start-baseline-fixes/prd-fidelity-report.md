# PRD Fidelity Report - run-start-baseline-fixes

Spec: .nax/features/run-start-baseline-fixes/spec.md
PRD: .nax/features/run-start-baseline-fixes/prd.json (profile native-codex-dsm)
Phases run: 1 of 9 (--phase 9: phases 1-8 skipped by request)
Verdict: PASS (0 blockers, 0 majors, 3 minors)

## Summary (Phase 9)

- Stories: 5 of 5 present, IDs US-001..US-005, workdir `packages/nax` on all (stated), dependencies match (US-004 -> US-001, US-002, US-003; others none).
- Spec ACs matched: 76 of 76 present, same story and ordinal. PRD carries 79 (US-001 20, US-002 14, US-003 16, US-004 21, US-005 8). The 3 extras derive from the spec Failure Handling table and agree with it (see M3).
- Max ACs per story: 21 (US-004) against cap 24. Within the cap.
- File-role entries: contextFiles 21 of 21 match spec Context Files; expectedFiles 7 of 7 match Creates; modifiedFiles 2 of 2 match Modifies, reasons verbatim.
- Self-Creates in own contextFiles: none. US-004 lists `suite-test-command/index.ts`, created by upstream US-003 (a dependency), which is correct. US-002 lists the old `gate-output-tail.ts`, not its created `gate-output-tail/index.ts`.
- outOfScope: 11 of 11 spec bullets verbatim and in spec order; none hoisted wrongly (all feature-level, so no `US-00N only:` prefix needed).
- Exact strings spot-checked and preserved: skip log line (em dash kept), three refusal texts, `, and 2 more`, the two package-skip log lines, `unparseable`/`gate-disabled`/`no-test-command`/`timeout` reasons, clock values 1000/4500/3500, timeouts 60/90, the `" 15 pass\n 0 fail\n"` and banner strings.
- Forward-reference re-sweep (symbols: captureRunStartBaseline, isNaxAutoCommitSubject, commitsSince, MovedCommit, publishOnlyStart, resolveSuiteTestCommand, SuiteTestCommand, baselineForPackage, resolveUnit, CaptureUnit, BaselineEvidence, clockMs, summaryLines, passedBanner, gateOutputTail): spelling consistent across all descriptions and ACs.
- `RunnerExecutionOptions` (used in the US-001 Interface block) exists at `runner-execution.ts:32`.

## Blockers
None.

## Majors
None.

## Minors

### M1 - US-004: AC1 adds an unstated assertion
- PRD: `userStories[3].acceptanceCriteria[0]` ends "...in its command.cmdWorkdir, passing individual strings for list entries."
- Spec US-004 AC1 stops at "...in its `command.cmdWorkdir`."
- The phrase is consistent with the root path (command lists run serially, one string each) and does not contradict the spec. It is a small invented detail.
- Fix (optional): delete ", passing individual strings for list entries" from that AC. Leaving it is harmless.

### M2 - US-003: AC10 return shape reworded
- PRD: `userStories[2].acceptanceCriteria[9]` says "returns a captured TestBaseline whose entries contain that entry".
- Spec US-003 AC10 says "returns that entry".
- The meaning is preserved and tightened to match the declared return type. The analysis field records the correction. No action needed.

### M3 - US-001 and US-004: ACs added beyond the spec's numbered list
- PRD: `userStories[0].acceptanceCriteria[19]` (existing `test-baseline.json` stays byte-identical) and `userStories[3].acceptanceCriteria[19]` and `[20]` (runner throw stops later groups with that command's evidence; a skipped-for-no-command package gets `unattributed`).
- Each restates a Failure Handling table row or Approach text. None contradicts the spec.
- Row 9's `unattributed` AC rests on US-003's `baselineForPackage` (an upstream dependency of US-004). That is fine.
- No action needed.

Other differences are precondition clarifications that narrow, not change, the assertions. Examples: US-002 AC5, AC6 and AC10 add "parsed output names no failures" or "output non-empty"; US-004 AC6, AC7, AC15, AC16 and AC18 add "packages supplied", "gate enabled" and a parseable command on the other unit. All are consistent with the spec.

## Fixes to apply to prd.json
None required. Only the optional M1 edit.
