# PRD Fidelity — advisor-read-evidence-and-state-loss

**Spec:** `docs/specs/SPEC-advisor-read-evidence-and-state-loss.md` (`19e53de67`)
**PRD:** `.nax/features/advisor-read-evidence-and-state-loss/prd.json` (`4fbd6f307`, `nax plan --profile native-codex`)
**Date:** 2026-10-18
**Verdict:** FAITHFUL. 0 blockers, 0 majors, 2 minors.

## Summary (counts)

- Check 1-2 (AC mapping and behaviour): 24/24 spec ACs map to PRD ACs. US-001 has 21/21, the same text after stripping backticks, in the same order. US-002 has 3/3, and AC 1 carries the full nine-class checklist verbatim. 0 rewritten into file-content assertions, 0 with arguments dropped.
- Check 2 (signature reality): 7 existing call shapes were checked, and every PRD AC matches the real signatures: `validateAdvisorReply(value, options)`, `decisionDraftFor(...)`, `askApproval(advisor, input)`, `buildWorkflowPrBody(input)`, `buildAdvisorPrompt(input)`, `publish(fc, input)`, plus the two review prompt builders.
- Check 3 (orphan ACs): 1 orphan, US-002 PRD AC 4 (minor m1).
- Check 3b (dependencies): 2/2 stories match. Both have the spec's "No dependencies." and PRD `dependencies: []`.
- Check 4 (file roles):
  - a. Creates -> expectedFiles: 2/2 for US-001; US-002 has none. No self-created file appears in `contextFiles`.
  - b. Context Files -> contextFiles: 5/5 for US-001 and 3/3 for US-002.
  - c. Cross-story produced files: none (the stories are independent).
  - d. Planner additions: 1, `workflow-story-review-builder.ts` in US-002 (minor m2).
- Check 5 (meta-ACs): none in the spec.
- Check 5b (correction survival): 7/7 spec-review corrections reach the US-001 `description`, not only `analysis`:
  - the `inspectedFilesOf` helper;
  - the `approval?.inspectedFiles?.length ?? 0` expression and its `ready` guard;
  - the legacy finish flow (`src/finish/advise.ts`) caveat;
  - the batch-prompt caveat;
  - the builder leaf-path import;
  - the own-harness note for the seam test file;
  - the hold arm.
  The pass-2 cannotVerify clause is in US-002 AC 3 and the description.
- Check 5c (PRD-AC satisfiability): 3 invocation-shaped seam ACs (US-001 AC 15, 16 and 20) were traced. Each enters at `publish` in `pr` mode, which goes through `prMode` -> `readinessReasons` (empty, given green gates and CI and a clean tree) -> `askApproval` -> `pushLedger` -> `finishPr` -> `buildWorkflowPrBody`. That path exists in `workflow/finalize.ts` at `e01e9fb83`. No guard is involved beyond the fixture's green state, which each AC states.
- Check 6 (out of scope): 9/9 spec bullets are present in `prd.outOfScope`, with 0 orphans and 0 inverted into ACs. The one story-scoped bullet keeps its `US-001 only:` prefix.
- Check 7 (terminal cleanup): n/a, since there is no removal story.
- Check 8 (Modifies -> modifiedFiles, by path): US-001 has 12/12 paths and US-002 has 2/2. Every entry has its own reason, and none opens with a comma.
- Check 9 (forward-reference drift): 8 symbols were re-swept across the PRD ACs (`FINISH_APPROVAL_READ_RULE`, `advisorFilesRead`, `inspectedFiles`, `buildAdvisorPrompt`, `buildWorkflowPrBody`, `WORKFLOW_QUALITY_CHECKLIST`, `buildWorkflowStoryReviewPrompt`, `buildWorkflowBranchReviewPrompt`). There is no spelling drift.

## Minor

**m1. US-002 has a planner-added AC 4 with no spec source.**
- What it says: `buildWorkflowStoryReviewPrompt` with `concerns: ["Possible state loss without a quotable excerpt"]` returns a prompt containing the closing severity line.
- Why it is minor: it adds no scope. The checklist is embedded unconditionally (`workflow-story-review-builder.ts:54`), so the AC is satisfiable and redundant with AC 1-2.
- Action: keep it.

**m2. The planner added `workflow-story-review-builder.ts` to US-002's `contextFiles`.**
- It is an existing file, and it is useful context for AC 2 and AC 4.
- Action: keep it.

## Suggested criteria

US-001 has 6 suggested criteria (null list, entries with whitespace or duplicates, all entries invalid, `[]` on a decision, a hold with no list, a draft with a count of 3). They are advisory, not ACs, and none contradicts the spec. One of them preserves entries that have surrounding whitespace, which matches the spec ("string entries whose trimmed text is non-empty" keeps the entry as given).

## Gate

Ready for `nax run -f advisor-read-evidence-and-state-loss`. Launching it needs approval.
