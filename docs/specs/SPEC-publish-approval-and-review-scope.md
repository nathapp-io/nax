# SPEC: Publish approval before the push, and an explained bot review scope

Closes: #2666, #2667

## Summary

Two defects at the handoff between a workflow publish and the PR it leaves behind.

- **#2666.** In `workflow.publish: "pr"` mode the finish-approval advisor is asked after the push and the CI wait,
  so its ruling is committed locally after the last push and never reaches the PR. A ready PR's head does not carry
  its own approval ruling. This spec asks the advisor **before** the push, from every deterministic condition except
  CI, so the ruling joins the one ledger commit that is pushed. CI then runs on that head, and the PR is ready only
  when CI is green **and** the advisor approved. The post-push ruling commit (`commitApprovalRuling`, nax#2646) and
  the `pushedHead` it needed are removed.
- **#2667.** When `nax bot review` narrows its range to the commits after the workflow's recorded reviewed head, the
  prompt never says so. The reviewer sees a whole PRD beside a two-file diff and lists the earlier, already-reviewed
  work under "Could not verify". This spec states the incremental scope in the prompt, names it in the posted
  summary and in `bot-review.json`, and adds `nax bot review --full` to review from the merge base on demand.

## Motivation

Verified on `main` @ `798a105e1` (v0.91.4).

- **#2666.** `prMode` (`src/workflow/finalize.ts`) runs `ledgerCommit` -> `pushBranch` -> `openDraftFinishPr` ->
  `waitForCi` -> `readinessReasons` (CI included) -> `askApproval` -> `finishPr` -> `commitApprovalRuling`.
  `commitApprovalRuling` (`src/workflow/publish-ledger.ts`) commits the `finish-approval` ledger line locally and
  never pushes it ("rides the next push", the nax#2646 ruling). In a v0.91.4 pr-mode run the last push landed at
  09:08:34, the advisor approved at 09:12:09, the ledger-only commit was made at 09:12:14 and the PR was marked ready
  the same second, leaving the branch one commit ahead of its upstream. The advisor is asked only when CI is already
  green, and a green CI is already a deterministic ready condition, so the ruling does not need the CI result: it can
  be taken before the push.
- **#2667.** `reviewRange` (`src/bot/review-rulings.ts`) returns `rangeBase = reviewedHead` when the workflow PR's
  item index names a reviewed head that is an ancestor of the PR head (spec `SPEC-workflow-pr-rulings-review-split.md`
  § Incremental bot review). `buildBotPrReviewPrompt` (`src/prompts/builders/bot-pr-review-builder.ts`) receives only
  `range: "<rangeBase>..HEAD"`, so it cannot tell a narrowed range from the full one; only the `conversationOnly` case
  carries an explanation. On the same v0.91.4 PR, a CI-repair commit after the last workflow review gave
  `rangeBase..HEAD` = two files, and the posted summary listed "The supplied range contains only the Next.js security
  upgrade; the warning-exit implementation predates the base commit and was not re-reviewed." The verdict and the
  narrowing were correct; only the reporting was wrong.

User rulings 2026-10-23:
- #2666: reorder, approval before the push (supersedes the nax#2646 local-commit ruling);
- #2667: explain the incremental scope, and add a `--full` flag to `nax bot review`;
- bundle both issues as one feature.

## Design

### Approach

1. **Approval before the push (#2666).** `prMode` becomes:
   1. `plan.base` (already `readinessReasons({ ...facts, ci: "skipped" })` plus the dirty-tree reasons) is the set of
      deterministic reasons known before the push. `ciReason("skipped")` is `undefined`, so `plan.base` holds no CI
      reason.
   2. When `plan.base` is empty, `askApproval` is called with `approvalEvidence(input, minorsLeftOf(input.record),
      changed)`, `changed` from `changedFilesEvidence(fc.projectDir, input.record.seed)`. Otherwise no advisor is asked
      and nothing is diffed.
   3. `ledgerCommit(fc)` runs once, after the advisor, so the commit carries the `finish-approval` line the advisor
      just wrote.
   4. `pushBranch(fc)`. A failed push returns `local-only` with `[...plan.base, ...ledgerReasons(ledger),
      <push failed reason>]`, as today.
   5. `bodyFacts(fc, input)` runs after the advisor, so the draft body's `## Advisor decisions` already lists the
      ruling. Then the draft PR, the CI wait and the abort check, as today.
   6. `reasons = [...readinessReasons({ ...plan.facts, ci: ci.outcome, ciDetail: ci.detail }), ...plan.dirty,
      ...ledgerReasons(ledger)]`.
   7. `finishPr(fc, parts, ci, reasons, approval)`. Nothing is committed after it.
   - `minorsLeftOf(record)` is the minors expression `bodyFacts` builds today (`r.minors` with `triage === "leave"` as
     `<storyId>: <text>`, then `r.newMinors`), extracted so `bodyFacts` and the approval question share it.
   - `finishPr` makes the PR ready only when `approval?.approved === true` **and** `reasons` is empty. Its final
     reasons are `[]` when ready, else `reasons` followed by `approval.rationale` only when the advisor held or was
     unavailable (`approval.approved === false`). An approval followed by a red CI therefore adds no reason of its own.
   - A held or unavailable advisor still pushes, so CI runs and the draft shows its state.
   - A ledger commit that fails after an approval leaves `ledgerReasons` non-empty (when the ledger file has lines),
     which keeps the PR a draft. The advisor is no longer guarded by that reason: it was asked first.
   - Each `publish` call asks at most once. A CI repair round re-runs `publish`, so it asks again before its own push
     and adds its own ledger line.
2. **The approval question no longer reports CI (#2666).**
   - `approvalEvidence` drops its `ci` parameter. Its CI line becomes the fixed sentence `CI: not run yet. It runs on
     the pushed head after this ruling, and the PR is ready only when it is green.` at the same position.
   - `askApproval`'s question summary becomes `Approve the workflow PR for <feature>? Every deterministic ready
     condition except CI holds. CI runs on the pushed head after this ruling, and the PR is ready only when it is
     green.`
3. **Remove the post-push ruling commit (#2666).** `commitApprovalRuling`, `PublishOutcome.pushedHead`
   and `waitForCi`'s `pushedHead` result are deleted. `publishStep` (`src/workflow/feature-steps.ts`) hands item threads
   and the CI-repair read the local `head` it reads after `publish`, which now equals the pushed head.
4. **Review scope (#2667).**
   - `BotReviewScope = "full" | "incremental" | "conversation-only"`, exported from `src/bot/review-rulings.ts` with
     `reviewScopeOf({ rangeBase?, mergeBase, conversationOnly? })`: `conversation-only` when `conversationOnly` is
     true; `incremental` when `rangeBase` is set and differs from `mergeBase`; `full` otherwise.
   - `BotPrReviewPromptInput` gains `incrementalSince?: string`. When set and `conversationOnly` is not true,
     `buildBotPrReviewPrompt` inserts, directly after the `Review pull request #<n> (range ...)` line, the paragraph
     `INCREMENTAL_REVIEW_NOTE` filled with the sha:
     `This is an incremental review: every commit up to <sha> was already reviewed by an earlier nax review of this
     pull request. Review only the commits in this range. Judge intent only for what this range changes. Do not list
     earlier commits, or parts of the PRD or spec this range does not change, in cannotVerify.`
   - `runPrReview` (`src/bot/review-step.ts`) passes `incrementalSince: rangeBase` when
     `reviewScopeOf(input) === "incremental"`.
5. **Scope reaches the human, and `--full` (#2667).**
   - `nax bot review` gains `--full` (on the `review` subcommand only, like `--decisions`). `botReviewCommand` adds
     `full: true` to the `runBotReview` input only when the flag is set (conditional spread), next to `decisions`;
     `withBotInput`, which `nax bot fix` shares, never sets it. `BotFixOptions` omits `full` as it omits `decisions`,
     so the fix cycle's re-review (which re-spreads its input into `runBotReview`) is never full.
   - `reviewEnvironment` (`src/bot/review-run.ts`), with `input.full === true`, does not call `reviewRange` (so no
     `isAncestor` call) and reviews from `checkout.mergeBase`. Without it, `reviewRange` runs as today.
   - `PostReviewInput` gains `scope?: BotReviewScope` and `incrementalSince?: string`; `reviewEnvironment` fills both
     from `reviewScopeOf` (`incrementalSince` only for `incremental`).
   - `persistArtifact` writes `scope` (and `incrementalSince` when present) into `bot-review.json`; `version` stays 3,
     because both keys are optional to every reader.
   - `ReviewSummaryInput` gains the same two fields. `renderReviewSummary`'s first line becomes
     `Review of <head7> (incremental since <since7>): intent ...` for `incremental` and
     `Review of <head7> (conversation only): intent ...` for `conversation-only`; `full` and an absent scope keep
     today's `Review of <head7>: intent ...`.

### Integration

Symbols this feature reads (verified on `798a105e1`):

- `readinessReasons(f: ReadinessFacts): string[]` and `ciReason(ci, detail?)` (`src/workflow/approval.ts`);
  `ciReason("skipped")` returns `undefined`.
- `ledgerCommit(fc): Promise<LedgerCommitResult>` and `ledgerReasons(ledger): string[]`
  (`src/workflow/publish-ledger.ts`).
- `buildOpenItems(record)` (`src/workflow/open-items.ts`): emits an advisor item only for `approval.approved === false`.
- `reviewRange(input, isAncestor): Promise<{ rangeBase: string; conversationOnly?: boolean }>`
  (`src/bot/review-rulings.ts`); unchanged.
- `_botReviewDeps.runPrReview`, `_botReviewDeps.postPrReview`, `_botReviewDeps.isAncestor` (`src/bot/review-deps.ts`).
- `withBotOptions`, `withBotInput`, `registerBotCommand` (`src/cli/bot.ts`).
- `wireFinalize`, `makeFinalizeAdvisor` (`test/helpers/finalize.ts`); the call log names `ledger`, `push`, `draft`,
  `ci`, `promote`.

Symbols this feature changes. The baseline exists only to locate the code; it is never the interface to implement:

- `prMode(plan, input)` (`src/workflow/finalize.ts`, module-private). Baseline: ledger, push, body, draft, CI wait,
  readiness, `askApproval`, `finishPr`, `commitApprovalRuling`. Target: the seven-step order in Approach 1.
- `finishPr(fc, parts, ci, reasons, approval)` (module-private). Target: `ready = approval?.approved === true &&
  reasons.length === 0`; final reasons per Approach 1.
- `approvalEvidence(input, ci, minorsLeft, changed): string[]` (exported). Target:
  `approvalEvidence(input, minorsLeft, changed): string[]`, CI line per Approach 2.
- `askApproval(advisor, input)` (`src/workflow/approval.ts`). Target: the summary sentence in Approach 2.
- `bodyFacts(fc, input)` (module-private). Target: takes its `minorsLeft` from the new module-private
  `minorsLeftOf(record)`.
- `waitForCi(fc, forge)` (module-private). Baseline returns `{ ci, pushedHead? }`. Target: returns the
  `CiWaitResult` only.
- `PublishOutcome` (`src/workflow/finalize.ts`). Target: no `pushedHead` field.
- `commitApprovalRuling` (`src/workflow/publish-ledger.ts`). Target: deleted.
- `publishStep(env, rec)` (`src/workflow/feature-steps.ts`). Baseline: `const published = out.pushedHead ?? head`.
  Target: item threads and `ciRepairDecision` receive `head`.
- `BotPrReviewPromptInput` (`src/prompts/builders/bot-pr-review-builder.ts`). Target: adds
  `readonly incrementalSince?: string`.
- `buildBotPrReviewPrompt(input)`. Target: inserts the incremental paragraph per Approach 4.
- `runPrReview(ctx, input)` (`src/bot/review-step.ts`). Target: passes `incrementalSince` per Approach 4.
- `BotReviewInput` (`src/bot/review-run.ts`). Target: adds `readonly full?: boolean`.
- `reviewEnvironment` (`src/bot/review-run.ts`, module-private). Target: skips `reviewRange` when `input.full`, and
  fills `post.scope` / `post.incrementalSince`.
- `PostReviewInput` and `BotReviewArtifact` (`src/bot/post.ts`). Target: both add `readonly scope?: BotReviewScope`
  and `readonly incrementalSince?: string`; `persistArtifact` writes them.
- `ReviewSummaryInput` and `renderReviewSummary` (`src/bot/render-comments.ts`). Target: the two optional fields and
  the first-line forms in Approach 5; `postSummary` passes them through.
- `BotReviewOptions` (`src/cli/bot.ts`). Target: adds `readonly full?: boolean`; the `review` subcommand registers
  `--full`; `botReviewCommand` forwards it. `BotFixOptions` becomes `Omit<BotReviewOptions, "decisions" | "full">`.

### Failure Handling

| Failure | Behaviour |
|---|---|
| The advisor returns no decision or throws before the push | `askApproval` returns `approved: false` with `advisor unavailable: ...` as today; the ledger commit, push, draft and CI wait still run; the PR stays a draft with that reason |
| The ledger commit throws after the advisor ruled | `ledgerCommit` warns as today; when the ledger file has lines, `advisor ledger not committed: the branch is missing <n> advisor rulings` keeps the PR a draft |
| The push fails after the advisor ruled | `local-only` with the `push failed: ...` reason; no draft, no CI wait |
| The run is aborted during the CI wait | `WORKFLOW_ABORTED` as today; no promotion |

## Out of Scope

- The approval advisor is asked before the push even when CI later fails or stays pending, and even when the push then fails: one advisor call per publish round, accepted by the user's ruling.
- The approval question no longer carries the CI outcome; CI is enforced only by `readinessReasons` (green required).
- `workflow.publish: "push"` and `"none"` are unchanged and never ask the advisor.
- The `nax finish` machine (`src/finish/machine.ts`) already commits its ledger before finalizing and is unchanged.
- `nax bot fix` gets no `--full` flag; the re-review of its fix cycle keeps the incremental scope.
- `--full` does not change which settled rulings, earlier findings or threads reach the review prompt.
- The narrowing conditions inside `reviewRange` are unchanged.
- A `cannotVerify` entry about pre-range commits is not dropped deterministically at render time; the prompt paragraph is the fix.
- Documenting `--full` in `docs/guides/cli-reference.md` is a manual follow-up after merge.

## Stories

Three stories in `packages/nax`. US-001 is #2666; US-002 and US-003 are #2667.

### US-001: Ask the approval advisor before the publish push
No dependencies. Workdir: packages/nax.

Reorders `prMode` per Approach 1, adds `minorsLeftOf`, changes `finishPr`'s ready rule and final reasons, drops the
`ci` parameter from `approvalEvidence` with the fixed CI line, and rewords `askApproval`'s summary. With nothing left
to call it, it deletes `commitApprovalRuling`, `PublishOutcome.pushedHead` and `waitForCi`'s `pushedHead`, and makes
`publishStep` hand item threads and the CI-repair read the local `head`. The `prMode` docstring, the F1 comment in
`bodyFacts` ("at this point no advisor has been asked"), the `waitForCi` doc about `pushedHead` and the nax#2646
comment in `publishStep` are rewritten to the new order; in `finalize.test.ts` the titles "AC-10: approval follows the
single pre-CI push" and "AC-6: approval does not add a post-CI ledger commit or push" are reworded to the same order. Those removals are verified by
`bun run typecheck` and `bun run lint` (run from `packages/nax`).

### US-002: Explain an incremental bot review range in the prompt
No dependencies. Workdir: packages/nax.

Adds `BotReviewScope` and `reviewScopeOf` to `src/bot/review-rulings.ts`, `incrementalSince` on
`BotPrReviewPromptInput` with the incremental paragraph, and has `runPrReview` pass it.

### US-003: Review scope in the artifact and summary, and `nax bot review --full`
Depends on US-002. Workdir: packages/nax.

Adds `--full`, `BotReviewOptions.full` and `BotReviewInput.full`, makes `reviewEnvironment` skip `reviewRange` under
`full` and fill `scope` / `incrementalSince` on the post input, writes them into `bot-review.json`, and renders them
in the summary's first line.

### Context Files

**US-001**
- `packages/nax/src/workflow/finalize.ts` — `prMode`, `finishPr`, `approvalEvidence`, `bodyFacts`, `waitForCi`, `PublishOutcome`
- `packages/nax/src/workflow/approval.ts` — `askApproval`, `readinessReasons`, `ciReason`
- `packages/nax/src/workflow/publish-ledger.ts` — `ledgerCommit`, `ledgerReasons`, `commitApprovalRuling`
- `packages/nax/src/workflow/feature-steps.ts` — `publishStep`, `ciRepairDecision`
- `packages/nax/test/helpers/finalize.ts` — `wireFinalize`, `makeFinalizeAdvisor`

**US-002**
- `packages/nax/src/bot/review-rulings.ts` — `reviewRange`
- `packages/nax/src/prompts/builders/bot-pr-review-builder.ts` — `BotPrReviewPromptInput`, `buildBotPrReviewPrompt`
- `packages/nax/src/bot/review-step.ts` — `PrReviewInput`, `runPrReview`
- `packages/nax/test/unit/bot/review-step.test.ts` — the `runPrReview` stubs
- `packages/nax/test/integration/bot/review-run-incremental.test.ts` — the incremental `runBotReview` harness

**US-003**
- `packages/nax/src/cli/bot.ts` — `withBotOptions`, `withBotInput`, `registerBotCommand`, `BotReviewOptions`
- `packages/nax/src/bot/review-run.ts` — `BotReviewInput`, `reviewEnvironment`
- `packages/nax/src/bot/post.ts` — `PostReviewInput`, `BotReviewArtifact`, `persistArtifact`, `postSummary`
- `packages/nax/src/bot/render-comments.ts` — `ReviewSummaryInput`, `renderReviewSummary`
- `packages/nax/test/integration/bot/review-run-incremental.test.ts` — the incremental `runBotReview` harness

### Creates

**US-001**
- `packages/nax/test/unit/workflow/finalize-approval-order.test.ts`

**US-002**
- `packages/nax/test/unit/bot/review-scope.test.ts`

**US-003**
- `packages/nax/test/unit/cli/bot-review-full.test.ts`
- `packages/nax/test/integration/bot/review-run-scope.test.ts`

### Modifies

**US-001**
- `packages/nax/test/unit/workflow/finalize-approval-push.test.ts` — the `["ledger", "push", "draft", "ci", "promote", "ledger"]` sequence and the cases expecting two `ledger` calls with `out.pushedHead` equal to `PUSHED` pin the nax#2646 post-push ruling commit; the approval now precedes the single ledger commit and `pushedHead` is deleted, so the sequence becomes `["ledger", "push", "draft", "ci", "promote"]`, every case expects exactly one `ledger` call, every `out.pushedHead` read is removed, the post-approval-commit cases (a ruling commit that made no commit, a failed post-approval commit) are removed together with the `PUSHED` constant and the `setup` options only they used (`headUnreadable`, `ledger`, `ledgerThrowsAt`), and the describe title "publish commits the approval ruling locally" is renamed to the single-commit order. The invariant that the push happens once and before the CI wait is unchanged.
- `packages/nax/test/unit/workflow/finalize-ci-gate.test.ts` — the conflicting, no-checks (both cases), unavailable and pending cases assert `asked` equals `[]`; the advisor is now asked before the CI wait, so they assert `asked` equals `["finish-approval"]`, keeping their draft and reason assertions. The conflicting case's whole-result `toEqual` gains `approval: { approved: true, rationale: "clean", decisionId: <the decision id> }`, because its default advisor approves. AC-11 ("a failed CI never asks the advisor, so there is no approval key") becomes: a failed CI with an approving advisor keeps the draft and returns an `approval` with `approved: true`. F1 switches its trigger from a failed CI to `reviewRan: false` with a green CI, so the advisor is still never asked and the stale `D-0` hold is still not cited; its ready-line assertion becomes `- [ ] **_run:reason1** (reason) — branch review did not run`, and its comment about the draft body being written before the advisor is asked is reworded to the new order. The cost-limited, git-status and re-review-skipped cases are unchanged.
- `packages/nax/test/unit/workflow/finalize-ci.test.ts` — AC-20 asserts `observed.asked()` is 0 for a CI head mismatch; the advisor is now asked before the wait, so it asserts 1, keeping the `draft` / `unavailable` outcome and the keep-draft assertion.
- `packages/nax/test/unit/workflow/finalize-evidence.test.ts` — `evidenceFor` and the AC-3/4 helper call `approvalEvidence` with a `ci` argument; the parameter is removed, so the calls drop it and the module-level `ci` constant they used is removed. "a failed CI never runs the changed-file diff" becomes "a deterministic non-CI reason never runs the changed-file diff", triggered by passing the publish input a story in `complete-gate-open` (the test's `wire` gains a `stories` override for it), because a failed CI is now observed only after the diff ran for the advisor.
- `packages/nax/test/unit/workflow/finalize.test.ts` — the W-R3 abort case asserts `asked` equals `[]`; the advisor is now asked before the push, so it asserts `["finish-approval"]`, keeping the `WORKFLOW_ABORTED` rejection and the `["ledger", "push", "draft", "ci"]` call sequence. AC-15 ("pr mode keeps the PR a draft and never asks the advisor", `ledgerThrowsAt: 1` with a 3-line ledger) asserts `asked` equals `[]`; the advisor is now asked before the failing ledger commit, so it is renamed to say the PR stays a draft after the advisor ruled and asserts `asked` equals `["finish-approval"]`, keeping the `draft` outcome, the `LEDGER_REASON` and the keep-draft assertions.
- `packages/nax/test/integration/workflow/finalize-approval.test.ts` — the approve/hold case asserts the draft body's `## Advisor decisions` section is `None.`; `bodyFacts` now runs after the advisor, so the draft section contains `D-3`, the same as the final body. The `reads()` count of 2 is unchanged (one read in `bodyFacts`, one in `finishPr`).
- `packages/nax/test/unit/workflow/publish-item-threads.test.ts` — the nax#2646 case builds a publish outcome with `pushedHead` and expects item threads to cite it; the field is deleted, so the case is removed. The invariant that item threads cite the local HEAD read after publish is pinned by US-001's own AC.

**US-002**
None. The existing review-step and builder tests assert with `stringContaining` and `toMatchObject` on the full and conversation-only prompts, which this story leaves unchanged.

**US-003**
None. The existing artifact assertions use `toMatchObject`, and the exact summary assertions in `render-comments.test.ts` build inputs with no scope, whose first line is unchanged.

### Seams

- US-002 -> US-003: `reviewScopeOf` and `BotReviewScope` (US-002) are called by `reviewEnvironment` (US-003) to fill the post input. US-003's seam ACs enter at `runBotReview`.
- US-002's prompt change is consumed by `runPrReview` within the same story; its `runPrReview` ACs drive the real builder. `runBotReview` already passes `runPrReview` the narrowed `rangeBase` (pinned by `review-run-incremental.test.ts` AC-2), so no new entry-point AC is needed.

## Acceptance Criteria

### US-001

- [integration] `publish` in `pr` mode with green CI and an approving advisor, whose `advise` appends `advise` to the `wireFinalize` call log, produces the call sequence `["advise", "ledger", "push", "draft", "ci", "promote"]`.
- [integration] That run returns outcome `ready` with `reasons` equal to `[]`.
- [integration] That run's `promote` call has `keepDraft` false.
- [integration] `publish` in `pr` mode with failed CI and an approving advisor returns outcome `draft` with `reasons` equal to `["CI failed"]`.
- [integration] That run returns `approval` with `approved: true` and the decision's id.
- [integration] `publish` in `pr` mode with pending CI and an approving advisor calls `promote` with `keepDraft` true.
- [integration] `publish` in `pr` mode with green CI and a holding advisor returns outcome `draft` with `reasons` equal to `["advisor held: risky"]`.
- [integration] `publish` in `pr` mode for a story in `complete-gate-open` never calls the advisor's `advise`.
- [integration] That run still calls `ledger`, `push`, `draft` and `ci`, in that order.
- [integration] `publish` in `pr` mode with an advisor whose `advise` returns no decision still calls `push`, and returns outcome `draft` with a reason starting `advisor unavailable:`.
- [integration] `publish` in `pr` mode with green CI, an approving advisor, `commitLedger` throwing and a feature ledger file holding one line (the new test writes it into its own temp project directory) returns outcome `draft` with a reason containing `the branch is missing 1 advisor rulings`.
- [integration] `publish` in `pr` mode with an approving advisor and a failing push returns outcome `local-only` with a reason starting `push failed:`, and never calls `draft` or `ci`.
- [integration] `publish` in `pr` mode with an approving advisor that writes decision `D-3`, where `_workflowDeps.readTrustedDecisions` returns `[]` before the advice and `[D-3]` after it, passes `openDraftFinishPr` a body whose `## Advisor decisions` section contains `D-3`.
- [integration] `publish` in `pr` mode with green CI and an approving advisor calls `commitLedger` exactly once.
- [integration] Two consecutive `publish` calls in `pr` mode on the same feature context (the CI repair path), the first with failed CI and the second with green CI, an approving advisor that appends `advise` to the `wireFinalize` call log and returns decision `D-1` then `D-2`, produce the call sequence `["advise", "ledger", "push", "draft", "ci", "promote", "advise", "ledger", "push", "draft", "ci", "promote"]`; the first result is a `draft` with `approval.decisionId` `D-1` and the second is `ready` with `approval.decisionId` `D-2`.
- [unit] `approvalEvidence(input, [], { kind: "files", files: [] })` returns the line `CI: not run yet. It runs on the pushed head after this ruling, and the PR is ready only when it is green.` directly after the `Final gates:` line.
- [unit] `askApproval` sends the advisor a question whose `summary` is `Approve the workflow PR for f? Every deterministic ready condition except CI holds. CI runs on the pushed head after this ruling, and the PR is ready only when it is green.` for feature `f`.

- [integration] `publish` in `pr` mode with an approving advisor, whose run is aborted during the CI wait, rejects with code `WORKFLOW_ABORTED` and never calls `promote` (regression guard: the abort check already precedes promotion).
- [integration] `publishStep` with a `publish` stub returning a `ready` outcome and a local HEAD of `"a".repeat(40)` hands the item-threads step the head `"a".repeat(40)` (regression guard for the `pushedHead` removal).

**Out of scope:** an advisor call followed by a failed push or a red CI is accepted (see the feature Out of Scope).

Verification note: the deletions of `commitApprovalRuling`, `PublishOutcome.pushedHead` and `waitForCi`'s `pushedHead` are verified by `bun run typecheck` and `bun run lint` from `packages/nax`.

### US-002

- [unit] `reviewScopeOf` is importable from `@/bot/review-rulings`; `reviewScopeOf({ rangeBase: "m", mergeBase: "m" })` returns `"full"`.
- [unit] `reviewScopeOf({ mergeBase: "m" })` returns `"full"`.
- [unit] `reviewScopeOf({ rangeBase: "r", mergeBase: "m" })` returns `"incremental"`.
- [unit] `reviewScopeOf({ rangeBase: "r", mergeBase: "m", conversationOnly: true })` returns `"conversation-only"`.
- [unit] `buildBotPrReviewPrompt` with `incrementalSince` equal to `"a".repeat(40)` returns a prompt containing `This is an incremental review: every commit up to <that sha> was already reviewed by an earlier nax review of this pull request.`
- [unit] That prompt contains `Judge intent only for what this range changes.`
- [unit] That prompt contains `Do not list earlier commits, or parts of the PRD or spec this range does not change, in cannotVerify.`
- [unit] In that prompt the incremental paragraph comes after the `Review pull request #` line and before the intent line.
- [unit] `buildBotPrReviewPrompt` without `incrementalSince` returns a prompt not containing `This is an incremental review`.
- [unit] `buildBotPrReviewPrompt` with `incrementalSince` set and `conversationOnly` true returns a prompt not containing `This is an incremental review`.
- [unit] `runPrReview` with `rangeBase` `"reviewed"` and `mergeBase` `"merge"` sends the review operation a prompt containing `every commit up to reviewed was already reviewed`.
- [unit] `runPrReview` with `rangeBase` absent sends a prompt not containing `This is an incremental review`.
- [unit] `runPrReview` with `rangeBase` equal to `mergeBase` sends a prompt not containing `This is an incremental review`.

### US-003

- [cli] Parsing `bot review 12 --full` calls `runBotReview` with an input whose `full` is `true`.
- [cli] Parsing `bot review 12` calls `runBotReview` with an input that has no `full` key.
- [integration] `runBotReview` with `full: true` on a trusted workflow PR whose item index names a reviewed head that `isAncestor` confirms, with the PR head past it, passes `runPrReview` an input whose `rangeBase` equals the checkout's merge base.
- [integration] That run never calls `_botReviewDeps.isAncestor`.
- [integration] `runBotReview` with `full: true` on a PR whose head equals the reviewed head passes `runPrReview` an input whose `conversationOnly` is not true.
- [integration] `runBotReview` without `full`, on the incremental case, passes `postPrReview` an input with `scope` `"incremental"` and `incrementalSince` equal to the reviewed head.
- [integration] `runBotReview` with `full: true` passes `postPrReview` an input with `scope` `"full"` and no `incrementalSince` key.
- [integration] `runBotReview` on a PR whose head equals the reviewed head passes `postPrReview` an input with `scope` `"conversation-only"`.
- [unit] `postPrReview` with `scope` `"incremental"` and `incrementalSince` `"b".repeat(40)` writes a `bot-review.json` with `version` 3, `scope` `"incremental"` and that `incrementalSince`.
- [unit] `postPrReview` with no `scope` writes a `bot-review.json` with no `scope` key.
- [unit] `renderReviewSummary` with `headSha` `"abc1234ffff"`, `scope` `"incremental"` and `incrementalSince` `"def5678aaaa"` returns a body whose first line is `Review of abc1234 (incremental since def5678): intent pass, quality approved.`
- [unit] `renderReviewSummary` with `scope` `"conversation-only"` returns a first line starting `Review of abc1234 (conversation only): intent`.
- [unit] `renderReviewSummary` with `scope` `"full"` returns a first line starting `Review of abc1234: intent`.
- [unit] `postPrReview` with `scope` `"incremental"` posts a summary comment whose body contains `(incremental since `.
