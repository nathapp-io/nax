# SPEC: review-rulings — reviewers see rulings and scope, no-op fixes and narrower residuals go to the advisor, repair diffs are reviewed

Closes: #2878

## Summary

The workflow story loop keeps re-reviewing findings the advisor has already ruled on, and keeps
narrowing a residual that cannot be closed. Four changes let the agents settle these on their own,
without new verdicts or human steps. The story brief lists the story's advisor rulings (including
mid-loop answers) and its out-of-scope list, and it is rewritten before every story review and
re-review. A fix round that changed nothing skips the re-review, and a re-review residual the reviewer
marks `narrower` stops the fix loop: both send the open findings to the existing residual advisor. The
residual advisor reply asks for the files it read. Finally, a gate repair or CI repair diff gets one
re-review, and the approval advisor reads its result instead of "the repair diff was not re-reviewed".

## Motivation

Evidence from the workflow runs of 2026-11-09 .. 11-12 (1,121 review-layer calls, 46 advisor decisions):

1. **Re-review never sees advisor rulings or spec trade-offs.** In one run, US-001 and US-002 had their
   trade-offs waived by the advisor mid-loop (`implementer-question` answers D-2, D-4, D-5). The
   implementer correctly committed nothing, and every re-review still answered NOT_ADDRESSED ("The fix
   diff is empty") until the 5-round cap, where the residual advisor ruled "Already ruled in D-2". 24 of
   144 re-reviews in the window judged an empty or no-op fix. `rulingsForStory` keeps only pre-flight
   and carry decisions, and the brief is written once at story start (`workflow/stage.ts`), so a
   mid-loop answer never reaches a reviewer.
2. **PARTIAL residuals ratchet.** "Describe only what remains" lets a reviewer always find a narrower
   remainder: a name-check-then-delete race re-raised 5 rounds, a byte-accounting nit that ended in 1-byte
   reads, `toContain` vs exact equality for 3 rounds.
3. **Reviewers push the implementer outside the story's scope.** The PRD carries `story.outOfScope`
   (propagated from the feature list at load), but the workflow brief never renders it, so neither the
   implementer nor the reviewers see it. One story was pushed to change a package the story declared
   read-only.
4. **Repair diffs are never reviewed.** A gate repair or CI repair commits after the branch re-review;
   3 finish-advisor holds cite "a complete review of an earlier tree does not cover a later unreviewed
   repair diff".
5. **Residual advisor reads nothing on record.** All 5 residual rulings record `inspectedFiles: 0`. The
   batch call has Read/Glob/Grep, but its reply contract never asks for `inspectedFiles`.

## Design

### Approach

The design keeps the harness loose: reviewers and the advisor get more context, and two cheap signals
end a loop that cannot converge. No new verdict, no new graph node, no new advisor question kind.

**US-001 rulings and scope.** `rulingsForStory(decisions, storyId)` keeps today's pre-flight and carry
lines and adds, in ledger order, two kinds of decisions whose `storyId` equals the story:
an `implementer-question` decision with an `answer` action renders `Advisor answer <id>: <text>`; a
`residual` decision with a `waive` or `defer` action renders `Residual ruling <id> (<type>): <reason>`. A
`hold` is left out: it means a human still decides, so it is not a settled ruling.
`WorkflowBriefInput` gains an optional `outOfScope?: readonly string[]`, rendered as a `## Out of scope` section
(one bullet per item, after "Rulings in force") and omitted when absent or empty. `writeBrief` passes
`sc.story.outOfScope ?? []`. A new `refreshBrief(sc)` in `workflow/brief.ts` calls `writeBrief(sc)` and
turns a throw into a warning (`Could not refresh the story brief - the review reads the previous one`);
the error is rethrown instead when `sc.runSignal?.aborted` is true. `buildStoryEnv` (`workflow/stage-env.ts`) calls `refreshBrief(sc)` at the
start of its `storyReview` and `reReview` steps, before the review runs. The story review and re-review
prompts each gain one paragraph: the brief's "Rulings in force" and "Out of scope" sections are settled;
do not report a finding a ruling already decides or whose fix needs out-of-scope work; to disagree with
a ruling, report a `minor` finding that names the ruling id.

**US-002 no-op fixes and narrower residuals.** The re-review reply may carry `"narrower": true` on a
finding entry: what remains is the same problem as the finding, in a narrower form. The prompt also asks
that a residual `issue` name a concrete scenario that still fails. `parseReReviewReply` copies
`narrower: true` onto the verdict entry only when the entry is PARTIAL (it describes a residual). `StoryLoopSteps` gains an
optional `fixDiffEmpty?(fixBase: string): Promise<boolean>`; `buildStoryEnv` wires it to "HEAD equals
`fixBase` and `listUncommitted` is empty". In the story loop's re-review branch:

- when the fix turn did not fail (no `implementer session failed` finding is pending from it) and
  `fixDiffEmpty` is wired and resolves `true`, the re-review is not called, the ledger gets the note
  `fix round r<N> changed nothing: <ids> go to the advisor` (ids joined by `, `), and the pass routes
  to the advisor. A failed fix turn keeps today's path: the re-review runs and the next round retries;
- otherwise the re-review runs as today; after absorbing it, if any asked finding that is still open
  carries `narrower`, the pass routes to the advisor.

"Routes to the advisor" means `evaluateStep` returns the existing `capped` exit whatever the round, so
the existing `residual` node adjudicates every open non-gate finding in one batched call. The flag lives
on the node-local `LoopState` copy only, so the graph's `produces` keys do not change. A `fixDiffEmpty`
that throws counts as "not empty" (the re-review runs). The branch re-review (`feature-steps.ts`) parses
the same reply and ignores `narrower`.

**US-003 residual reads.** The residual block's reply example in `advisor-batch-builder.ts` gains
`"inspectedFiles": ["path"]` (added in the residual block only; the shared `ANSWER_FIELDS` and the
pre-flight reply stay as they are), and the residual block says: read the file each item names before you rule,
and list every file you opened in `inspectedFiles`. `validateAdvisorReply` and `decisionDraftFor` already
carry `inspectedFiles` onto the decision.

**US-004 repair review.** `FeatureSteps` gains an optional
`repairReview?(findings: readonly WorkflowFinding[], base: string): Promise<ReviewOutcome<ReReviewVerdict>>`,
wired in `buildFeatureEnv` to `runBranchReReview(fc, { ...spec, findings, fixBase: base })`. In
`gateRepairStep` and `ciRepairStep`, when `repairReview` is wired and the round has findings: read
`env.steps.head()` before `branchFix`; after a `branchFix` with no `failure`, read it again; when it moved,
call `repairReview(findings, before)` once and append one line to `rec.repairReviews`. The repair
session (`branchFix`) always runs as today, whatever the `head()` reads return:

- ran: `<kind> r<N> reviewed: <id> addressed|PARTIAL|NOT addressed, ...` and, when the verdict has new
  findings, `; new: [<severity>] <file>: <issue>` per finding (`[<severity>] <issue>` when the finding
  has no file) joined by `; `;
- not ran: `<kind> r<N> review skipped: <why>`.

`<kind>` is `gate repair` or `CI repair`. When HEAD did not move, nothing is reviewed and no line is
added. A `head()` throw (before or after the repair) skips the review with the ledger note
`<kind> r<N> review skipped: could not read HEAD`. The review reuses the branch re-review prompt and its
`package-branch-fix.diff` artifact path, which it overwrites; that is accepted.
The steps above live in one helper, `reviewRepairDiff(env, { kind, round, findings, run })` in a new
`workflow/repair-review.ts`, which `gateRepairStep` and `ciRepairStep` both call around their `branchFix`.
`WorkflowFeatureRecord` gains `repairReviews?: readonly string[]`; the `gate-repair` and `ci-repair` nodes
add `repairReviews` to `produces`. `repairEvidence(record)` keeps its lines, but a round line ends
`the repair diff was reviewed` when `repairReviews` has an entry for that kind containing ` reviewed: `
(a `review skipped` entry keeps `the repair diff was not re-reviewed`), and every `repairReviews` entry
follows the round lines. The approval advisor already reads `repairEvidence` (`finalize.ts`).
Findings of a repair review are evidence for the approval advisor; they open no new fix round.

### Integration (extends existing code)

Symbols read only (verified on main `6bcbcf512`):

- `readTrustedDecisions` via `_workflowDeps.readTrustedDecisions` (`workflow/step-context.ts`).
- `AdviceDecision` (`advisor/types.ts`): `kind`, `storyId?`, `action` (`answer` has `text`; `waive`/`defer`/`hold` have `reason`).
- `UserStory.outOfScope?: string[]` (`prd/types.ts:200`), filled from the feature list by `propagateOutOfScopeToStories` at PRD load.
- `absorbReReviewVerdict(asked, verdict)` (`workflow/re-review-absorb.ts`), `adjudicateResidual` (`workflow/adjudicate.ts`).
- `runBranchReReview(fc, { specPath?, findings, fixBase })` (`workflow/branch-review.ts:318`).
- `readHead`, `listUncommitted` (`workflow/git.ts`).
- `validateAdvisorReply` (`operations/advise.ts`), already copying `inspectedFiles`.

Symbols this feature changes. The baseline only locates the code; the target is the interface to build.

- `rulingsForStory` (`workflow/rulings.ts`). Baseline: pre-flight supersede/hold and carry lines only. Target: also `Advisor answer <id>: <text>` and `Residual ruling <id> (<type>): <reason>` for the story's own decisions.
- `WorkflowBriefInput` / `buildWorkflowBrief` (`prompts/builders/workflow-implementer-builder.ts`). Target: `readonly outOfScope?: readonly string[]`, rendered as `## Out of scope` when non-empty.
- `buildWorkflowStoryReviewPrompt` (`prompts/builders/workflow-story-review-builder.ts`) and `buildWorkflowReReviewPrompt` (`prompts/builders/workflow-re-review-builder.ts`). Target: the settled-rulings paragraph; the re-review also the `narrower` field and the failing-scenario request.
- `ReReviewVerdict.verdicts[]` (`operations/workflow-types.ts:61`). Target: `readonly narrower?: true`.
- `parseReReviewReply` (`operations/workflow-replies.ts:155`). Target: copies `narrower`.
- `StoryLoopSteps` (`workflow/story-loop.ts`). Target: `fixDiffEmpty?(fixBase: string): Promise<boolean>`.
- `review` / `evaluateStep` (`workflow/story-steps.ts`). Target: the advisor route above.
- `buildStoryEnv` (`workflow/stage-env.ts:49`). Target: `refreshBrief` before both reviews; `fixDiffEmpty` wired.
- `buildAdvisorBatchPrompt` residual block (`prompts/builders/advisor-batch-builder.ts`). Target: `inspectedFiles` field and read instruction.
- `FeatureSteps` (`workflow/feature-machine.ts:26`). Target: `repairReview?`.
- `gateRepairStep` (`workflow/feature-steps.ts:356`), `ciRepairStep` (`workflow/ci-repair-steps.ts:210`). Target: the repair review above.
- `WorkflowFeatureRecord` (`workflow/types.ts`). Target: `repairReviews?: readonly string[]`.
- `FEATURE_GRAPH` (`workflow/feature-graph.ts`). Target: `gate-repair` and `ci-repair` produce `repairReviews`.
- `repairEvidence` (`workflow/repair-evidence.ts`). Target: the reviewed wording and the review lines.
- `buildFeatureEnv` (`workflow/feature-env.ts:39`). Target: `repairReview` wired.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| Brief refresh throws (spec unreadable, project-context file gone) | Warning logged; the review runs and reads the previous brief. |
| Brief refresh hit by a run abort | The abort error propagates. |
| `fixDiffEmpty` throws | Treated as not empty: the re-review runs. |
| `fixDiffEmpty` not wired | The re-review runs as today. |
| Repair review: `head()` throws | The repair session still runs; no review; ledger note `<kind> r<N> review skipped: could not read HEAD`; the step returns its round as today. |
| Fix turn failed (session failure finding pending) | No advisor route on an empty diff; the re-review runs and the next fix round retries, as today. |
| Repair review did not run (timeout, unparseable reply) | Line `<kind> r<N> review skipped: <why>`. |
| Repair session failed or committed nothing | No review, no line. |
| `repairReview` not wired | The repair steps behave as today. |

## Out of Scope

- The branch-level re-review does not act on `narrower`; only the story loop routes on it.
- No warm-memory residual advisor; the residual batch stays a stateless call.
- No new verdict value, re-review status or advisor question kind.
- A repair review's findings open no fix round; they are evidence for the approval advisor only.
- Folding the finish advisor's spot-check questions into the branch-review prompt.
- No schema rule requires a failing scenario in a residual; the prompt asks for it.

## Stories

### US-001 — the brief carries the story's rulings and out-of-scope list, refreshed before each review

Workdir: packages/nax. No dependencies.

Extend `rulingsForStory` with the story's `implementer-question` answers and residual rulings, render
`story.outOfScope` in the brief, add the settled-rulings paragraph to the story review and re-review
prompts, and have `buildStoryEnv` rewrite the brief through `refreshBrief` before both reviews.

### US-002 — a no-op fix or a narrower residual goes to the residual advisor

Workdir: packages/nax. Depends on US-001.

Add the optional `narrower` re-review field and its parsing, the `fixDiffEmpty` step and its wiring, and
the story-loop route that sends the open findings to the existing residual adjudication.

### US-003 — the residual advisor is asked for the files it read

Workdir: packages/nax. No dependencies.

Add `inspectedFiles` and the read instruction to the residual batch prompt.

### US-004 — a gate repair diff is re-reviewed

Workdir: packages/nax. No dependencies.

Add the optional `repairReview` step to `FeatureSteps`, `repairReviews` to `WorkflowFeatureRecord`, and a
shared helper `reviewRepairDiff` in a new `workflow/repair-review.ts` that reads HEAD around a repair, calls
`repairReview` and returns the `repairReviews` patch and ledger notes. Call it from `gateRepairStep`, and
add `repairReviews` to the `gate-repair` node's `produces`.

### US-005 — a CI repair diff is re-reviewed

Workdir: packages/nax. Depends on US-004.

Call US-004's `reviewRepairDiff` from `ciRepairStep` with kind `CI repair`, and add `repairReviews` to
the `ci-repair` node's `produces`. The behaviour mirrors US-004 for the CI step.

### US-006 — the approval evidence and the live wiring use the repair review

Workdir: packages/nax. Depends on US-004.

Render `repairReviews` in `repairEvidence`, and wire `steps.repairReview` in `buildFeatureEnv` to
`runBranchReReview`.

### Context Files

**US-001**
- `packages/nax/src/workflow/rulings.ts` — the rulings list to extend.
- `packages/nax/src/workflow/brief.ts` — `writeBrief`, home of `refreshBrief`.
- `packages/nax/src/prompts/builders/workflow-implementer-builder.ts` — `buildWorkflowBrief`.
- `packages/nax/src/workflow/stage-env.ts` — `buildStoryEnv` review steps.
- `packages/nax/src/prompts/builders/workflow-story-review-builder.ts` — the story review prompt.

**US-002**
- `packages/nax/src/workflow/story-steps.ts` — `review`, `evaluateStep`, `passExit`.
- `packages/nax/src/operations/workflow-replies.ts` — `parseReReviewReply`.
- `packages/nax/src/prompts/builders/workflow-re-review-builder.ts` — the re-review prompt.
- `packages/nax/src/workflow/story-loop.ts` — `StoryLoopSteps`.
- `packages/nax/src/workflow/stage-env.ts` — step wiring.

**US-003**
- `packages/nax/src/prompts/builders/advisor-batch-builder.ts` — the residual block.
- `packages/nax/src/operations/advise.ts` — `validateAdvisorReply`, `inspectedFilesOf`.

**US-004**
- `packages/nax/src/workflow/feature-steps.ts` — `gateRepairStep`.
- `packages/nax/src/workflow/feature-machine.ts` — `FeatureSteps`.
- `packages/nax/src/workflow/types.ts` — `WorkflowFeatureRecord`.
- `packages/nax/src/workflow/feature-graph.ts` — node `produces`.

**US-005**
- `packages/nax/src/workflow/ci-repair-steps.ts` — `ciRepairStep`.
- `packages/nax/src/workflow/repair-review.ts` — created by US-004, called here.
- `packages/nax/src/workflow/feature-graph.ts` — node `produces`.

**US-006**
- `packages/nax/src/workflow/repair-evidence.ts` — the approval evidence lines.
- `packages/nax/src/workflow/feature-env.ts` — `buildFeatureEnv`.
- `packages/nax/src/workflow/branch-review.ts` — `runBranchReReview`.

### Creates

**US-001**
None.

**US-002**
None.

**US-003**
None.

**US-004**
- `packages/nax/src/workflow/repair-review.ts` — `reviewRepairDiff`, shared by the gate and CI repair steps.

**US-005**
None.

**US-006**
None.

### Modifies

**US-001**
- `packages/nax/test/unit/workflow/stage-env.test.ts` — tests that drive the `storyReview` or `reReview` step built by `buildStoryEnv` now also run `refreshBrief`, which writes the brief; their fixtures may stub `_workflowDeps.readTrustedDecisions`, `_workflowDeps.resolveFeatureSpec` and `_workflowDeps.loadProjectContextOverride` so the refresh stays local, and an assertion on the exact warnings logged may include the refresh warning.

The existing `rulingsForStory` test uses decisions of other stories and pre-flight/carry kinds only, so its expected list is unchanged; the prompt and brief tests assert with substring checks.

**US-002**
None. `"narrower"` sits on the finding entry, outside the pinned `"residual": {...}` substring, and story-loop tests that do not wire `fixDiffEmpty` keep today's re-review path.

**US-003**
None. No existing test pins the residual reply-field string.

**US-004**
- `packages/nax/test/unit/workflow/feature-graph.test.ts` — `expectedProduces["gate-repair"]` becomes `["gateRepairRounds", "repairReviews"]`, because the gate repair node now records its repair review.

**US-005**
- `packages/nax/test/unit/workflow/feature-graph.test.ts` — `expectedProduces["ci-repair"]` becomes `["ciRepairRounds", "ciRepairFindings", "ciRepairConcerns", "repairReviews"]`, because the CI repair node now records its repair review.

**US-006**
None. The existing `repairEvidence` tests use records without `repairReviews`, so their expected lines are unchanged.

### Seams

- US-002 reads the re-review prompt US-001 extends; both edit `buildWorkflowReReviewPrompt`, so US-002 runs after US-001.
- US-004 creates `reviewRepairDiff` and the optional `repairReview` step; US-005 calls `reviewRepairDiff` from `ciRepairStep`; US-006 wires `repairReview` in `buildFeatureEnv`, and its wiring AC enters there.

## Acceptance Criteria

### US-001

1. [unit] `rulingsForStory` given an `implementer-question` decision `D-2` with `storyId` `"US-1"` and action `{ type: "answer", text: "Keep the lstat walk" }` returns, for `"US-1"`, a list that includes `"Advisor answer D-2: Keep the lstat walk"`.
2. [unit] `rulingsForStory` given a `residual` decision `D-3` with `storyId` `"US-1"` and action `{ type: "waive", reason: "Already ruled in D-2" }` returns, for `"US-1"`, a list that includes `"Residual ruling D-3 (waive): Already ruled in D-2"`.
3. [unit] `rulingsForStory` given a `residual` decision `D-4` with `storyId` `"US-1"` and action `{ type: "hold", reason: "needs a human" }` returns, for `"US-1"`, a list with no entry that mentions `D-4`.
4. [unit] `rulingsForStory` given an `implementer-question` answer decision with `storyId` `"US-2"` returns, for `"US-1"`, a list that does not include that decision's text.
5. [unit] `rulingsForStory` given, in ledger order, a pre-flight hold `D-1` applying to `"US-1"` and an `implementer-question` answer `D-2` for `"US-1"` returns the pre-flight line first and the `Advisor answer D-2` line second.
6. [unit] `buildWorkflowBrief` with `outOfScope: ["No run lease or lock"]` returns text with a `## Out of scope` heading followed by the bullet `- No run lease or lock`.
7. [unit] `buildWorkflowBrief` with `outOfScope: []`, and again with `outOfScope` absent, returns text without a `## Out of scope` heading.
8. [integration] `writeBrief` for a story whose `outOfScope` is `["No run lease or lock"]` writes a brief file whose text includes `- No run lease or lock` under `## Out of scope`.
9. [unit] `buildWorkflowStoryReviewPrompt` output states that the brief's "Rulings in force" and "Out of scope" sections are settled and that a finding they already decide is not reported.
10. [unit] `buildWorkflowStoryReviewPrompt` output tells the reviewer to report a disagreement with a ruling as a `minor` finding that names the ruling id.
11. [unit] `buildWorkflowReReviewPrompt` output states that the brief's "Rulings in force" and "Out of scope" sections are settled and that a finding they already decide is not reported.
12. [integration] Through `buildStoryEnv`, with `_workflowDeps.readTrustedDecisions` stubbed to return an `implementer-question` answer `D-2` for the story, the brief file read at the moment the stubbed `_workflowDeps.callOp` receives the `workflow-story-review` op includes `Advisor answer D-2`.
13. [integration] Through `buildStoryEnv`, with the same `readTrustedDecisions` stub, the brief file read at the moment the stubbed `_workflowDeps.callOp` receives the `workflow-re-review` op includes `Advisor answer D-2`.
14. [integration] Through `buildStoryEnv`, when `_workflowDeps.loadProjectContextOverride` throws during the refresh before the story review, the stubbed `_workflowDeps.callOp` still receives the `workflow-story-review` op.
15. [integration] In the same case, a warning with the message `Could not refresh the story brief - the review reads the previous one` is logged.
16. [unit] `refreshBrief` rethrows the error when the step context's run signal is aborted and `writeBrief` throws.

### US-002

1. [unit] `parseReReviewReply` given an entry `{"id": "F1", "verdict": "PARTIAL", "narrower": true, "residual": {"issue": "x"}}` for open id `F1` returns a verdict entry with `narrower` `true`.
2. [unit] `parseReReviewReply` given a PARTIAL entry for `F1` with no `narrower` field returns a verdict entry without a `narrower` key.
3. [unit] `parseReReviewReply` given an `ADDRESSED` entry for `F1` with `"narrower": true` returns a verdict entry without a `narrower` key.
4. [unit] `parseReReviewReply` given a `NOT_ADDRESSED` entry for `F1` with `"narrower": true` returns a verdict entry without a `narrower` key.
5. [unit] `buildWorkflowReReviewPrompt` output describes the `"narrower": true` field as "the same problem as the finding, in a narrower form".
6. [unit] `buildWorkflowReReviewPrompt` output asks that a residual `issue` name a concrete scenario that still fails.
7. [integration] `runStoryLoop` with one open review finding `F1`, `maxFixRounds` 3, and `steps.fixDiffEmpty` resolving `true` after the first fix round never calls `steps.reReview`.
8. [integration] In that run, `advisor.ruleResidual` is called once with `items` containing `F1`.
9. [integration] In that run, the outcome's `rounds` is `1`.
10. [integration] In a run with two open review findings `F1` and `F2` and `steps.fixDiffEmpty` resolving `true` after the first fix round, the ledger receives a note containing `fix round r1 changed nothing: F1, F2 go to the advisor`.
11. [integration] `runStoryLoop` with one open finding and `steps.fixDiffEmpty` resolving `false` calls `steps.reReview` after the first fix round.
12. [integration] `runStoryLoop` with one open finding and no `steps.fixDiffEmpty` calls `steps.reReview` after the first fix round.
13. [integration] `runStoryLoop` with one open finding and `steps.fixDiffEmpty` rejecting with an error calls `steps.reReview` after the first fix round.
14. [integration] `runStoryLoop` with one open finding whose first fix turn fails (the implementer step returns a `failure`) and `steps.fixDiffEmpty` resolving `true` calls `steps.reReview` after that round and runs a second fix round.
15. [integration] `runStoryLoop` with `maxFixRounds` 3 whose first re-review returns a PARTIAL verdict with `narrower: true` for `F1` runs no second fix round and calls `advisor.ruleResidual` with `items` containing `F1` carrying the residual issue text.
16. [integration] `runStoryLoop` with `maxFixRounds` 3 whose first re-review returns a PARTIAL verdict without `narrower` for `F1` runs a second fix round.
17. [integration] `runStoryLoop` whose first re-review returns PARTIAL `narrower` for `F1` and NOT_ADDRESSED for `F2` calls `advisor.ruleResidual` with `items` containing both `F1` and `F2`.
18. [integration] `buildStoryEnv` on a temporary git repository whose HEAD equals the given base and whose worktree is clean returns a `steps.fixDiffEmpty(base)` that resolves `true`.
19. [integration] `buildStoryEnv` on a temporary git repository with one commit after the given base returns a `steps.fixDiffEmpty(base)` that resolves `false`.
20. [integration] `buildStoryEnv` on a temporary git repository whose HEAD equals the given base and which has one modified tracked file returns a `steps.fixDiffEmpty(base)` that resolves `false`.

### US-003

1. [unit] `buildAdvisorBatchPrompt` for kind `"residual"` returns a reply example whose answer object includes `"inspectedFiles": ["path"]`.
2. [unit] `buildAdvisorBatchPrompt` for kind `"residual"` tells the advisor to read the file each item names before it rules.
3. [unit] `buildAdvisorBatchPrompt` for kind `"residual"` tells the advisor to list every file it opened in `inspectedFiles`.
4. [unit] `buildAdvisorBatchPrompt` for kind `"preflight"` returns text without `inspectedFiles`.

### US-004

1. [unit] `gateRepairStep` with a wired `steps.repairReview`, one gate repair finding, and `steps.head` resolving `"h1"` before the repair and `"h2"` after it calls `steps.repairReview` once with findings `[G1]` and base `"h1"`.
2. [unit] In that case, when the review verdict marks `G1` addressed with no new findings, the step's patch has `repairReviews` equal to `["gate repair r1 reviewed: G1 addressed"]`.
3. [unit] When the review verdict marks `G1` not addressed and has one new finding of severity `important` at `src/a.ts` with issue `leaks a handle`, the patch's `repairReviews` equals `["gate repair r1 reviewed: G1 NOT addressed; new: [important] src/a.ts: leaks a handle"]`.
4. [unit] When the review verdict marks `G1` addressed and has one new finding of severity `minor` with issue `naming` and no file, the patch's `repairReviews` equals `["gate repair r1 reviewed: G1 addressed; new: [minor] naming"]`.
5. [unit] When the review verdict carries a residual for `G1`, the patch's `repairReviews` equals `["gate repair r1 reviewed: G1 PARTIAL"]`.
6. [unit] When `steps.repairReview` resolves `{ ran: false, why: "timeout" }` (any `why`, including an unparseable reply), the patch's `repairReviews` equals `["gate repair r1 review skipped: timeout"]`.
7. [unit] When `steps.head` resolves the same sha before and after the repair, `steps.repairReview` is not called.
8. [unit] When `steps.head` resolves the same sha before and after the repair, the patch has no `repairReviews` key.
9. [unit] When `steps.branchFix` returns a `failure`, `steps.repairReview` is not called.
10. [unit] When `steps.head` rejects before the repair, `steps.branchFix` is still called once.
11. [unit] When `steps.head` rejects before the repair, `steps.repairReview` is not called.
12. [unit] When `steps.head` rejects before the repair, the ledger gets the note `gate repair r1 review skipped: could not read HEAD`.
13. [unit] When `steps.head` resolves `"h1"` before the repair and rejects after it, `steps.repairReview` is not called.
14. [unit] When the record already has `repairReviews: ["gate repair r1 reviewed: G1 addressed"]`, a second round's patch has `repairReviews` with the earlier line first and the new `gate repair r2` line second.
15. [unit] `gateRepairStep` without `steps.repairReview` never calls `steps.head`.
16. [unit] `gateRepairStep` without `steps.repairReview` returns a patch without a `repairReviews` key.
17. [unit] `FEATURE_GRAPH`'s `gate-repair` node lists `repairReviews` in `produces`.

### US-005

1. [unit] `ciRepairStep` with a wired `steps.repairReview`, one CI finding, and `steps.head` moving from `"h1"` to `"h2"` calls `steps.repairReview` once with findings `[C1]` and base `"h1"`.
2. [unit] In that case, with a verdict marking `C1` addressed and no new findings, the patch's `repairReviews` equals `["CI repair r1 reviewed: C1 addressed"]`.
3. [unit] `ciRepairStep` with a wired `steps.repairReview` and `steps.head` rejecting before the repair still calls `steps.branchFix` once.
4. [unit] In that case, the ledger gets the note `CI repair r1 review skipped: could not read HEAD`.
5. [unit] `ciRepairStep` without `steps.repairReview` returns a patch without a `repairReviews` key.
6. [unit] `FEATURE_GRAPH`'s `ci-repair` node lists `repairReviews` in `produces`.

### US-006

1. [unit] `repairEvidence` for a record with `gateRepairRounds` 1 and `repairReviews: ["gate repair r1 reviewed: G1 addressed"]` returns `["Gate repair: 1 round(s) after the final gates went red; the repair diff was reviewed", "gate repair r1 reviewed: G1 addressed"]`.
2. [unit] `repairEvidence` for a record with `gateRepairRounds` 1 and `repairReviews: ["gate repair r1 review skipped: timeout"]` returns `["Gate repair: 1 round(s) after the final gates went red; the repair diff was not re-reviewed", "gate repair r1 review skipped: timeout"]`.
3. [unit] `repairEvidence` for a record with `ciRepairRounds` 1 and `repairReviews: ["CI repair r1 reviewed: C1 addressed"]` returns `["CI repair: 1 round(s) after CI failed on the PR; the repair diff was reviewed", "CI repair r1 reviewed: C1 addressed"]`.
4. [integration] `buildFeatureEnv` returns a `steps.repairReview` that, called with findings `[G1]` and base `"h1"`, makes the stubbed `_workflowDeps.callOp` receive the `workflow-re-review` op with `openIds` `["G1"]`.
