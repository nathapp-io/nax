# SPEC: Advisor read evidence on finish-approval, and a state-loss review class

## Summary

Two small fixes to how far nax's workflow reviews can be trusted. First, the advisor's reply gains an `inspectedFiles` list (the files it opened), the finish-approval question tells the advisor to open at least the riskiest changed file before approving, and a promoted PR's Summary says how many files the advisor opened, or that it approved from the evidence alone. Second, the shared code-quality checklist both workflow reviewers use gains a "State loss" class, plus a rule that a reachable state loss is never a minor finding.

## Motivation

**Approvals made without reading code.** The finish-approval advisor runs with Read/Glob/Grep (`adviseOp.tools`), and since #2567 its evidence carries the base commit and the changed-file list. In the tool audits of the 13 finish-approvals from nax 0.89.0 to 0.90.2, the final advisor session made zero tool calls in 9, including the two most recent nax PRs (#2599, #2604). Each approval was decided from nax's own summary lines. A PR promoted that way looks the same as one the advisor checked, and nothing in the PR says which it was. Holding the PR on zero reads would draft about 70% of PRs, so this spec discloses the fact and nudges the advisor instead. The ruling that the disclosure is a note, not a hold, was made by the maintainer on 2026-10-18.

**State loss rated minor.** The workflow review checklist (`WORKFLOW_QUALITY_CHECKLIST`, SPEC-workflow-review-depth) has eight classes. None names a write that replaces a whole entry and so drops fields another writer set. In the auth-relogin-recovery run, the branch reviewer found exactly that bug, a quota failure's `mark` replacing the cooldown entry and wiping the stored re-login stamp so the provider could never be released, and rated it minor. It was fixed only because the quality floor forced a fix round.

## Design

### Integration

The baseline listings below exist only to locate the code; they are never the interface to implement. Each mutated symbol states its target.

**Read only (verified 2026-10-18, main `e01e9fb83`):**

- `packages/nax/src/advisor/service.ts` — `decide(actx, asked, run, severity)` calls `decisionDraftFor(actx, asked.question, run.out.reply, model, severity)` and appends the draft to the ledger; `Advisor.advise` returns `{ decision, fallbackReason }`. Unchanged.
- `packages/nax/src/advisor/batch.ts` and `packages/nax/src/operations/advise-batch.ts` — both validate replies with `validateAdvisorReply` and draft decisions with `decisionDraftFor`, so a batch reply that carries `inspectedFiles` keeps it. The batch prompt (`advisor-batch-builder.ts`) has its own reply contract and does not ask for the list. Unchanged.
- `packages/nax/src/advisor/ledger.ts` — `parseLines` keeps any JSON line with an `id` and an `action`, so a decision line carrying `inspectedFiles` reads back unchanged.
- `packages/nax/src/workflow/finalize.ts` — `prMode` calls `askApproval(input.advisor, { feature, evidence })` and passes the outcome to `finishPr(fc, parts, ci, reasons, approval)`.
- `packages/nax/src/prompts/builders/workflow-story-review-builder.ts` (`buildWorkflowStoryReviewPrompt`) and `packages/nax/src/prompts/builders/workflow-branch-builder.ts` (`buildWorkflowBranchReviewPrompt`) — both embed `WORKFLOW_QUALITY_CHECKLIST` verbatim. Unchanged.

**Mutated:**

- `AdvisorReply` (`packages/nax/src/advisor/types.ts`).
  - Baseline: `{ optionId, instruction?, reason?, newText?, rationale, confidence, reversible, needsHumanConfirm }`.
  - Target: adds `inspectedFiles?: string[]`.
- `AdviceDecision` (`packages/nax/src/advisor/types.ts`).
  - Target: adds `inspectedFiles?: string[]`, copied from the reply. Absent when the reply had none.
- `validateAdvisorReply(value, options)` (`packages/nax/src/operations/advise.ts`). Signature unchanged.
  - Baseline: builds the reply from `optionId`, `rationale`, `confidence`, `reversible`, `needsHumanConfirm` and the optional texts.
  - Target: the list is read by a new file-local helper `inspectedFilesOf(raw)` in `advise.ts`, so `validateAdvisorReply` stays under the `check:complexity` limit. When `raw.inspectedFiles` is an array, the reply carries `inspectedFiles` = its string entries whose trimmed text is non-empty, in order (an empty array stays `[]`). When the key is absent or not an array, the reply has no `inspectedFiles` key. The list never makes a reply invalid.
- `decisionDraftFor(...)` (`packages/nax/src/advisor/service-helpers.ts`). Signature unchanged.
  - Target: the drafted decision carries `inspectedFiles` when the reply has it (conditional spread, like `anchorFile`).
- `ApprovalOutcome` (`packages/nax/src/workflow/types.ts`).
  - Target: adds `readonly inspectedFiles?: readonly string[]`.
- `askApproval(advisor, input)` (`packages/nax/src/workflow/approval.ts`). Signature unchanged.
  - Target: the approve and hold outcomes carry the decision's `inspectedFiles` when the decision has it; otherwise they are exactly as today.
- `WorkflowPrBodyInput` (`packages/nax/src/workflow/pr-body.ts`).
  - Target: adds `readonly advisorFilesRead?: number`.
- `summary(input)` (`packages/nax/src/workflow/pr-body.ts`).
  - Baseline: the head line, plus "Not ready because:" and the reasons when there are any.
  - Target: when `input.outcome` is `"ready"` and `input.advisorFilesRead` is defined, a second paragraph follows the head line: `The advisor approved from the evidence alone: it listed no files it opened.` when the count is 0, otherwise `The advisor opened <n> file(s) before approving.`. Otherwise unchanged.
- `finishPr(fc, parts, ci, reasons, approval)` (`packages/nax/src/workflow/finalize.ts`).
  - Target: the final `buildWorkflowPrBody({...})` input gains `...(ready ? { advisorFilesRead: approval?.inspectedFiles?.length ?? 0 } : {})`, so a promoted body carries the count and a draft body carries none. `finalize.ts` is at 598 of its 600-line limit (`check:file-sizes`), so this is one added line inside the existing `buildWorkflowPrBody({...})` call, and nothing else in the file grows.
- `CONTRACT` and `advisorQuestionBlock(q)` (`packages/nax/src/prompts/builders/advisor-builder.ts`).
  - Baseline: `CONTRACT`'s JSON example has no `inspectedFiles`; the question block is the same for every kind.
  - Target: the JSON example gains `"inspectedFiles": ["path"]`, followed by the sentence `List every file you opened in "inspectedFiles"; an empty list means you ruled from the evidence alone.`. A new exported constant `FINISH_APPROVAL_READ_RULE` = `Before you approve, open at least the changed file you judge riskiest. Use the changed files and the base commit the evidence names, when it names them. List every file you opened in inspectedFiles.` is appended as the question block's last paragraph when `q.kind === "finish-approval"`, and only then. Two callers ask that kind: the workflow `askApproval` (whose evidence carries the base commit and changed-file list) and the finish flow in `src/finish/advise.ts` (whose evidence does not), which is why the rule says "when it names them" and makes no claim about the PR. `buildAdvisorPrompt` includes the question block on both first and continuation turns, so both carry the rule. Tests import `FINISH_APPROVAL_READ_RULE` from `@/prompts/builders/advisor-builder` (test files may reach internals), so `src/prompts/index.ts` is not changed.
- `WORKFLOW_QUALITY_CHECKLIST` (`packages/nax/src/prompts/builders/workflow-quality-checklist.ts`).
  - Baseline: a heading, one instruction line and eight class bullets, ending with the Reachability bullet.
  - Target: exactly this text (the State loss bullet sits after Concurrency and atomicity, and the severity line is last):

```text
## Code-quality checklist
Judge the changed code against each class. Report only what you can quote from a file.
- Concurrency and atomicity: a check and the write it guards in separate statements or transactions; two writers racing on one row, slot or counter; shared mutable state without synchronisation.
- State loss: a write that replaces a whole record, map entry or file that other code also fills, so the fields this write did not set are dropped; a reset, retry or migration that discards state still in use.
- Data-store semantics: the collation or case-sensitivity of identity and unique columns; uniqueness enforced only in code, not by the store; transaction boundaries; column types and widths against the values written.
- Production wiring: an in-memory, fake or test stand-in on a production path where the project provides a shared implementation (an id or sequence generator, cache, lock, queue, storage).
- Test isolation: a test that depends on state another test created; ordering dependence; shared mutable fixtures; globals, environment or files not restored.
- Input safety: untrusted keys used for object lookup (inherited keys such as __proto__ or constructor); unbounded lengths or sizes reaching storage; unvalidated input reaching a query, path or command.
- Performance: a database or network call per item inside a loop on a batch path; serial awaits that could be one batched call.
- Error handling: a swallowed failure; a result or exit code never checked; a default substituted on error so the caller cannot tell empty from broken.
- Reachability: a list with no way past its first page; a state a user or caller cannot reach or leave.
A state loss a caller can reach is a critical or important finding, never minor; if you cannot quote it, put it in cannotVerify.
```

  The file's header comment, which says "The eight classes", is updated to nine.

### Approach

`inspectedFiles` is self-reported, the same model the story and branch reviewers already use. Cross-checking it against the session's tool audit is out of scope. An absent list and an empty list both count as zero in the PR body: either way the advisor named no file it opened.

### Failure Handling

| Situation | Behaviour |
|---|---|
| The advisor reply has no `inspectedFiles`, or it is not an array | The reply is valid, carries no list, and a promoted PR reads it as zero files opened. |
| `inspectedFiles` holds non-strings or blank strings | Those entries are dropped; the rest are kept in order. |

No other new failure paths.

## Out of Scope

- The finish-approval outcome does not depend on `inspectedFiles`: an approval with zero files opened still promotes the PR, by maintainer ruling 2026-10-18.
- `inspectedFiles` is not cross-checked against the advisor session's tool audit; the list is taken as reported.
- A draft PR's body, the `nax workflow status` open items and the decisions sidecar do not show the advisor's file count, and no count field is added to `result.json`; the persisted approval outcome (`FeatureRecord.approval`) carries the `inspectedFiles` list as is.
- Advisor kinds other than finish-approval get the `inspectedFiles` reply field but no reading rule, and no caller acts on their list.
- The finish flow's finish-approval question (`src/finish/advise.ts`) receives the reading rule through the shared question block, but its PR body (built by `buildAdvisorSection`) gains no file-count sentence.
- The batch advisor prompt (`advisor-batch-builder.ts`) does not ask for `inspectedFiles`.
- The quality floor (`withQualityFloor` in `workflow/feature-machine.ts`) and the story-review spec rubric are unchanged.
- The story and branch review reply schemas are unchanged; the severity rule lives only in the shared checklist text.
- US-001 only: a decision line already in a ledger, written before this change, is not rewritten; it reads back with no `inspectedFiles`.

## Stories

The two stories are independent and touch separate code. They stay separate so each gets its own review pass and one can land even if the other stalls.

### US-001: finish-approval records and discloses the files the advisor opened

Workdir: `packages/nax`. No dependencies.

The advisor reply and decision carry an optional `inspectedFiles` list. The advisor prompt asks every advisor to list the files it opened, and tells the finish-approval advisor to open at least the riskiest changed file before approving. `askApproval` passes the list through on its outcome, and a promoted PR's Summary states how many files the advisor opened, or that it approved from the evidence alone.

### US-002: the review checklist names state loss

Workdir: `packages/nax`. No dependencies.

`WORKFLOW_QUALITY_CHECKLIST` gains a State loss class and a closing rule that a reachable state loss is critical or important, never minor. The story review and branch review prompts pick the change up through the existing verbatim embed.

### Context Files

**US-001**

- `packages/nax/src/operations/advise.ts` — `validateAdvisorReply`, `adviseOp`.
- `packages/nax/src/advisor/service-helpers.ts` — `decisionDraftFor`.
- `packages/nax/src/workflow/approval.ts` — `askApproval`.
- `packages/nax/src/workflow/pr-body.ts` — `summary`, `buildWorkflowPrBody`, `WorkflowPrBodyInput`.
- `packages/nax/src/prompts/builders/advisor-builder.ts` — `CONTRACT`, `advisorQuestionBlock`, `buildAdvisorPrompt`.

**US-002**

- `packages/nax/src/prompts/builders/workflow-quality-checklist.ts` — the checklist constant and header comment.
- `packages/nax/test/unit/prompts/workflow-quality-checklist.test.ts` — the verbatim pin and the embed tests.
- `packages/nax/src/prompts/builders/workflow-branch-builder.ts` — `buildWorkflowBranchReviewPrompt` (read only).

### Creates

**US-001**

- `packages/nax/test/unit/workflow/finalize-advisor-reads.test.ts` — the seam tests through `publish` (US-001 AC 15, 16 and 20). `finalize.test.ts` is at 797 of its 800-line limit and its `wire`, `input` and `advisor` helpers are module-local, so this file defines its own minimal `wire` and an `advisor` stub that takes an `inspectedFiles` argument and passes it to `makeAdviceDecision` (the precedent is `finalize-evidence.test.ts`, which carries its own `wire`).
- `packages/nax/test/unit/advisor/service-helpers.test.ts` — the `decisionDraftFor` tests (US-001 AC 6-7); no test file covers `service-helpers.ts` today.

**US-002**

None.

### Modifies

**US-001**

- `packages/nax/src/workflow/finalize.ts` — `finishPr` passes `advisorFilesRead` into the promoted body's `buildWorkflowPrBody` input; one added line, since the file is at 598 of its 600-line `check:file-sizes` limit.
- `packages/nax/src/advisor/types.ts` — `AdvisorReply` and `AdviceDecision` gain the optional `inspectedFiles` field, per the Design target.
- `packages/nax/src/workflow/types.ts` — `ApprovalOutcome` gains the optional `inspectedFiles` field, per the Design target.
- `packages/nax/src/operations/advise.ts` — `validateAdvisorReply` reads an optional `inspectedFiles` array into the reply, per the Design target.
- `packages/nax/src/advisor/service-helpers.ts` — `decisionDraftFor` copies the reply's `inspectedFiles` onto the drafted decision with a conditional spread.
- `packages/nax/src/workflow/approval.ts` — `askApproval`'s approve and hold outcomes carry the decision's `inspectedFiles` when it has one.
- `packages/nax/src/workflow/pr-body.ts` — `WorkflowPrBodyInput` gains `advisorFilesRead`, and `summary` adds the advisor file-count sentence on a ready body.
- `packages/nax/src/prompts/builders/advisor-builder.ts` — `CONTRACT` gains the `inspectedFiles` field and sentence; the new exported `FINISH_APPROVAL_READ_RULE` is appended to `advisorQuestionBlock` for finish-approval questions. Tests import the constant from the builder's own module path, so the prompts barrel is not changed.
- `packages/nax/test/unit/operations/advise.test.ts` — gains the `validateAdvisorReply` tests (US-001 AC 1-5); existing assertions are unchanged, since their replies carry no `inspectedFiles`.
- `packages/nax/test/unit/workflow/approval.test.ts` — gains the `askApproval` tests (US-001 AC 8, 9, 21); the existing `toEqual` outcome pins stay green, since their decisions carry no `inspectedFiles`.
- `packages/nax/test/unit/workflow/pr-body.test.ts` — gains the `buildWorkflowPrBody` Summary tests (US-001 AC 10-13); existing assertions are unchanged.
- `packages/nax/test/unit/prompts/advisor-builder.test.ts` — gains the prompt tests (US-001 AC 14, 17-19); existing assertions are unchanged.

**US-002**

- `packages/nax/src/prompts/builders/workflow-quality-checklist.ts` — `WORKFLOW_QUALITY_CHECKLIST` becomes the nine-class text with the closing severity line, and the header comment's "The eight classes" becomes "The nine classes".
- `packages/nax/test/unit/prompts/workflow-quality-checklist.test.ts` — the test "is the checklist text verbatim (AC-1)" pins the old eight-class `CHECKLIST` literal with `toBe`; the literal becomes the nine-class text with the closing severity line, exactly as the Design target states. The embed tests (AC-3, AC-4) are unchanged.

### Seams

- US-001: the decision's `inspectedFiles` reaches the PR body through the existing `prMode` → `askApproval` → `finishPr` → `buildWorkflowPrBody` path, entered at `publish` (US-001 AC 15, 16 and 20).
- US-002: the checklist reaches both reviewers through the existing verbatim embed (US-002 AC 2-3).

## Acceptance Criteria

### US-001

1. [unit] `validateAdvisorReply` given a valid approve reply with `inspectedFiles: ["src/a.ts", "src/b.ts"]` returns `ok: true` and a reply whose `inspectedFiles` equals `["src/a.ts", "src/b.ts"]`.
2. [unit] `validateAdvisorReply` given a valid approve reply with `inspectedFiles: []` returns `ok: true` and a reply whose `inspectedFiles` equals `[]`.
3. [unit] `validateAdvisorReply` given a valid approve reply with no `inspectedFiles` key returns `ok: true` and a reply that has no `inspectedFiles` key.
4. [unit] `validateAdvisorReply` given a valid approve reply with `inspectedFiles: "src/a.ts"` (a string, not an array) returns `ok: true` and a reply that has no `inspectedFiles` key.
5. [unit] `validateAdvisorReply` given a valid approve reply with `inspectedFiles: ["src/a.ts", 3, "", "  "]` returns a reply whose `inspectedFiles` equals `["src/a.ts"]`.
6. [unit] The decision drafted by `decisionDraftFor` from a reply with `inspectedFiles: ["src/a.ts"]` has `inspectedFiles` equal to `["src/a.ts"]`.
7. [unit] The decision drafted by `decisionDraftFor` from a reply with no `inspectedFiles` has no `inspectedFiles` key.
8. [unit] `askApproval` with an advisor whose `advise` returns an approve decision with id `D-1`, rationale `clean` and `inspectedFiles: []` returns `{ approved: true, rationale: "clean", decisionId: "D-1", inspectedFiles: [] }`.
9. [unit] (regression pin) `askApproval` with an advisor whose `advise` returns an approve decision with id `D-1`, rationale `clean` and no `inspectedFiles` returns exactly `{ approved: true, rationale: "clean", decisionId: "D-1" }`.
10. [unit] `buildWorkflowPrBody` with outcome `ready` and `advisorFilesRead: 0` returns a body whose `## Summary` section contains `The advisor approved from the evidence alone: it listed no files it opened.`
11. [unit] `buildWorkflowPrBody` with outcome `ready` and `advisorFilesRead: 3` returns a body whose `## Summary` section contains `The advisor opened 3 file(s) before approving.`
12. [unit] (regression pin) `buildWorkflowPrBody` with outcome `ready` and no `advisorFilesRead` returns a body containing neither `The advisor approved from the evidence alone` nor `before approving.`
13. [unit] `buildWorkflowPrBody` with outcome `draft` and `advisorFilesRead: 0` returns a body whose `## Summary` section omits both advisor file-count sentences (`The advisor approved from the evidence alone: it listed no files it opened.` and `The advisor opened 0 file(s) before approving.`), since only a promoted PR states what the advisor read.
14. [unit] `buildAdvisorPrompt` for a non-continuation question of kind `finish-approval` returns a prompt containing `FINISH_APPROVAL_READ_RULE`, and `FINISH_APPROVAL_READ_RULE` equals `Before you approve, open at least the changed file you judge riskiest. Use the changed files and the base commit the evidence names, when it names them. List every file you opened in inspectedFiles.`
15. [unit] `publish` in `pr` mode with green gates and CI, with an advisor whose `advise` returns an approve decision with `inspectedFiles: []`, promotes the PR with a body (the last `openOrPromotePr` call's `body`) containing `The advisor approved from the evidence alone: it listed no files it opened.`
16. [unit] `publish` in `pr` mode with green gates and CI, with an advisor whose `advise` returns an approve decision with `inspectedFiles: ["src/a.ts", "src/b.ts"]`, promotes the PR with a body containing `The advisor opened 2 file(s) before approving.`
17. [unit] `buildAdvisorPrompt` with `continuation: true` for a question of kind `finish-approval` returns a prompt containing `FINISH_APPROVAL_READ_RULE`.
18. [unit] `buildAdvisorPrompt` for a non-continuation question of kind `finish-judgment` returns a prompt that omits `FINISH_APPROVAL_READ_RULE`: the reading rule is added for the finish-approval kind only.
19. [unit] `buildAdvisorPrompt` for a question of any kind returns a prompt containing `"inspectedFiles"` and the sentence `List every file you opened in "inspectedFiles"; an empty list means you ruled from the evidence alone.`
20. [unit] `publish` in `pr` mode with green gates and CI, with an advisor whose `advise` returns an approve decision that has no `inspectedFiles` key, promotes the PR with a body containing `The advisor approved from the evidence alone: it listed no files it opened.`
21. [unit] `askApproval` with an advisor whose `advise` returns a hold decision with id `D-2`, rationale `risky` and `inspectedFiles: ["src/a.ts"]` returns `{ approved: false, rationale: "advisor held: risky", decisionId: "D-2", inspectedFiles: ["src/a.ts"] }`.

### US-002

1. [unit] `WORKFLOW_QUALITY_CHECKLIST` equals the nine-class checklist text given in the Design target, verbatim.
2. [unit] `buildWorkflowStoryReviewPrompt` returns a prompt containing the line `- State loss: a write that replaces a whole record, map entry or file that other code also fills, so the fields this write did not set are dropped; a reset, retry or migration that discards state still in use.`
3. [unit] `buildWorkflowBranchReviewPrompt` returns a prompt containing the line `A state loss a caller can reach is a critical or important finding, never minor; if you cannot quote it, put it in cannotVerify.`
