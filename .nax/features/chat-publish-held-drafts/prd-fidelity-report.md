# PRD Fidelity Report - chat-publish-held-drafts

**Spec:** .nax/features/chat-publish-held-drafts/spec.md
**PRD:** .nax/features/chat-publish-held-drafts/prd.json
**Reviewed against:** packages/nax at 8a088cb8a (spec and PRD uncommitted)
**Date:** 2026-11-17
**Phases run:** 1 of 9 (--phase 9: phases 1-8 skipped by request)
**Verdict:** READY (0 blockers, 0 majors, 2 minors)

## Summary

- Phase 9: 67 spec ACs matched to 67 PRD ACs (67/67 survive, 2 planner adds); 4 stories and dependency sets compared; 4 contextFiles lists (19 entries) and 4 Creates lists (all None) checked; 14 Modifies paths against modifiedFiles; 8 out-of-scope bullets; 0 terminal-cleanup stories; forward-reference symbols re-swept: `publishedAtHead`, `isTransientDraft`, `heldItemList`, `HELD_ITEMS_NAMED`, `HeldDraft`, `preparePublish`, `loadPriorFeature`, `headSha`, `loadRunVerdict`, `resolveOutputDir`, `JobNoticeInput.held` (0 drift) - 0 blockers, 0 majors, 2 minors.

## Check results

### 1-2. AC survival and behavioural fidelity
Spec ACs per story: US-001 17, US-002 19, US-003 20, US-004 11 (67). PRD ACs: 18, 20, 20, 11 (69). Every spec AC maps to the PRD AC at the same index, with the same symbol, inputs and expected output. Normalised text diffs (ignoring backticks and whitespace):
- US-001 AC2 and AC10: argv expanded to the literal `[...ctx.naxEntry, "run", "-f", "f1", "-d", ctx.repoRoot, "--headless", "--publish-only", "--profile", "a"]`. Spec said "the nax entry, then `run`, `f1`, `--publish-only` and the profile arguments". This is a faithful expansion. The `-f`/`-d`/`--headless` flags are stated in the PRD's own Scope, and `--publish-only` exists in `job-argv.ts:174`. No meaning change.
- US-003 AC1-AC4, AC15: reworded or lengthened with a restated stub. The assertions are the same.
- US-004 AC2-AC5: the spec's "That third line ..." is restated with the full input. Content is identical, including `verified:`, `confirm:`, `override:`, `waive:`, `fixed <sha>`, "findings are left to `nax bot fix`" and the `gh` or `glab` post-on-yes. No assertion is dropped.
- No AC was turned into a file-content or grep assertion, and none was weakened. No call-shape contradicts a real signature. `heldItemList`, `publishedAtHead`, `loadRunVerdict` and `_jobsLaunchDeps` match the spec's Integration section.

### 3. Orphan PRD ACs (2 planner adds, both trace to the spec)
- US-001 AC18, "launchJob for kind publish and feature f1 over a PRD with 2 pending stories returns { isError: true, content: "[chat] f1 has 2 pending stories; finish them with nax-jobs__run first" }". It traces to the spec's `### Modifies` US-001 jobs-launch.test.ts reason ("The pending-stories refusal text ... unchanged"). The literal matches `jobs-launch.ts:283`. It adds no scope.
- US-002 AC20, `loadPriorFeature` returning null and `headSha` returning `abcdef0123` calls approve with summary `nax run f1 --publish-only`. It traces to the Failure Handling row "`loadPriorFeature` returns `null`". It adds no scope.

### 3b. Dependencies and workdirs
US-001: []. US-002: [US-001]. US-003: [US-001]. US-004: [US-003]. These match the spec's per-story declarations exactly. Every story has workdir `packages/nax`. Story IDs match, and no story is missing or invented.

### 4. File roles
- `contextFiles`: all four stories match the spec's Context Files (5, 5, 5, 3 entries) with no drops, no additions and no moves.
- `expectedFiles`: absent on every story, which is correct because every `Creates` is None. No self-created file is in `contextFiles`.
- `modifiedFiles`: US-001 has 13 of 13 spec paths, US-002 has 1 of 1, US-003 has 1 of 1, and US-004 has none, as the spec says. Each is a single path with its own populated reason. No reason starts with a comma. The reasons are carried in full.

### 5. Meta-ACs and correction survival
The spec has no meta-ACs. Every spec-review correction visible in the spec reaches `description` or `acceptanceCriteria`:
- `workflowFeatureDir` vs `featureDir`: US-002 description.
- Next step at `summary().next - 1` of `active().steps`: US-002 description and AC14.
- The stop applies to any following step, including `bot_review`: US-003 AC16.
- The line-6 phrase: US-001 AC17.

### 5c. PRD-AC satisfiability
The only invocation-shaped ACs are US-002 AC14 to AC16 (`launchJob` calling `chains.stop`) and US-004 AC11 (runner child-exit to notice). Both come from the spec unchanged and use existing entry points named in the spec's Integration section. The planner introduced no new invocation ACs.

### 6. Out-of-scope preservation
`prd.outOfScope` holds 8 of 8 spec bullets, verbatim and in order. No exclusion appears as an AC. No story contradicts one. There are no unprefixed story-scoped hoists and no orphan exclusions. The stories' descriptions echo the spec's exclusions correctly.

### 7. Terminal cleanup
The spec has none. This is not applicable.

### 8. Modifies by path
14 spec paths, 14 `modifiedFiles` entries. There is no multi-path bullet.

### 9. Forward-reference drift re-sweep
No near-miss spelling variants across PRD `description` and `acceptanceCriteria`.

## Findings

### Minor 1 - AC mechanism tags retained in every PRD AC
Every one of the 69 PRD `acceptanceCriteria` strings starts with the spec's tag, for example US-001 AC1 `[unit] createJobsProvider(options).tools(root) ...` and US-002 AC10 `[integration] launchJob for kind publish ...`. Only `[unit]` and `[integration]` occur. The banned `[grep]`, `[file]` and `[verbatim]` tags do not. The tags are runtime-valid, so this is cosmetic. The skill notes `nax plan` usually strips them, so the retention is only a deviation from the usual shape.
- Suggested fix: none required. Optionally strip the leading `[unit] ` or `[integration] ` in place. This is a patch to the PRD with no content change.

### Minor 2 - `suggestedCriteria` carries extra criteria on US-002 and US-003
US-002 has 3 and US-003 has 3. These are not in `acceptanceCriteria`, and no run-time prompt reads them. One goes slightly beyond the spec's text. US-002: "publishedAtHead returns undefined for a done draft record at the current HEAD whose reasons include PR update failed: network error, preserving retry eligibility." That depends on the `isTransientDraft` body, which the spec says moves unchanged.
- Suggested fix: none required, since they are inert. Ignore them, or drop the field.

## Not findings
- US-001 AC2 and AC10 name the full argv. This is a faithful expansion of the spec.
- No shell commands or file-content assertions appear in any AC. `nax workflow status -f f1 --json` in US-004 AC2 is spec-mandated notice text.
- The `analysis` field was not used as evidence for any correction.
