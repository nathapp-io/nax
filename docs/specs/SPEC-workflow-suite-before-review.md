# SPEC: Workflow story loop runs the full suite before the story review

Closes: #2678

## Summary

In workflow mode a story pass runs gates, then the story review, then the full suite. This spec moves the full suite
ahead of the review, so a pass runs gates, full suite, report check, review. While fix rounds remain, a red suite goes
straight to a fix and the review waits for a green suite. On the last pass (no fix round left) a red suite still goes
on to the review, so a story that ends red still carries review findings for the advisor and the human who finishes
it. The story-review prompt states the suite's result as a fact instead of telling the reviewer the suite runs later.
A story that closes without ever being reviewed is marked `unreviewed` in its record and end line.

The cost: the suite now runs on every pass whose gates are green, re-review passes included, so a story the review
sends back pays one extra suite run per fix round. A clean story runs the suite once, as today.

## Motivation

Verified on `main` @ `c5fe5a97c`:

- `evaluate()` (`packages/nax/src/workflow/story-steps.ts`) runs `env.steps.gates()`, `runReportCheck`, `review()`,
  and calls `env.steps.fullSuite()` only when `s.reviewOpen` is empty. The reviewer judges code the suite has not run
  on, and `naxCheckedBlock` (`packages/nax/src/prompts/builders/workflow-story-review-builder.ts`) has to tell it the
  suite runs later and must not be listed in `cannotVerify`. Some reviewers list it anyway (3 of about 55 story-level
  cannot-verify lines in one downstream project named the full suite). `isGateTimingItem`
  (`packages/nax/src/workflow/gate-timing.ts`) already drops lines that say only "runs later", so the lines that
  survive are the ones carrying their own evidence words. A stated suite result removes the reason to write them.
- Code a fix round writes to turn a red suite green is never reviewed today: the review already ran, nothing is in
  `reviewOpen`, so no re-review runs. With the suite first, the first review sees code that has passed the suite.
- A repo whose baseline is already red makes the suite red on every story. `fullSuiteGateOp`
  (`packages/nax/src/operations/full-suite-gate.ts`) labels pre-existing failures but returns `status: "failed"` with
  every finding, and `runWorkflowSuiteGate` (`packages/nax/src/workflow/gates.ts`) maps `failed` to red. A plain
  reorder would skip the review on every such story. Reviewing on the last pass bounds that to one review per story.
- `closeStep` sets the outcome's `unreviewed` only from `s.unreviewed`, which is set only when a review was attempted
  and skipped. A story that closes having never reached a review (gates red to the cap, a no-work close) reports
  `unreviewed: false`. The story summary (`fromRecord`, `packages/nax/src/workflow/feature-record.ts`) and the PR body
  table (`packages/nax/src/workflow/pr-body.ts`) read `record.unreviewed`, so the gap reaches the PR. Moving the suite
  first makes "never reviewed" more common, so the flag must be true whenever no review ran.

## Design

### Approach

One pass of `evaluate()`, in order:

1. `s.suiteThisIteration = false`; run `env.steps.gates()`. Red gates return the gate findings followed by
   `s.reviewOpen`, exactly as today; the suite, report check and review do not run in that pass.
2. Set phase `suite`; `s.suite = await env.steps.fullSuite()`; `s.suiteThisIteration = true`. When `s.suite.red`,
   the suite findings are assigned ids (`s.assign(s.suite.findings)`) here, before any review finding of this pass.
3. Last pass means `s.round >= env.maxFixRounds`. When the suite is red and this is not the last pass, return the
   suite findings followed by `s.reviewOpen`. The report check and the review do not run, and `s.fixBase` is left as
   it is, so the next re-review diffs from the head recorded before the first fix of the open review findings.
4. Otherwise (suite green, skipped, or red on the last pass): `runReportCheck`, set phase `review` or `rereview`,
   then `review()`.
5. Return the suite findings (empty when green or skipped) followed by `s.reviewOpen`.

`review()` passes the merged gate states, `{ ...s.gates?.states, ...s.suite?.states }`, as the second argument of
`env.steps.storyReview`. `reReview` is unchanged.

`residualStep` keeps its guard `!s.gates?.red && !s.suiteThisIteration`. With the suite in every pass whose gates are
green, the residual runs the suite only when the last pass ended on red gates, and then the guard skips it, so in
practice the residual no longer runs the suite. Its code does not change.

`closeStep` computes `unreviewed = s.unreviewed || !s.reviewed` and passes it to `closeLoop`, which writes it to the
record in its closing `env.sink.update` (alongside `state`, `reason`, `phase: "closed"`, ...) and uses it for the end
line and the returned outcome. This covers the `closeAs` no-work close too. The flag is display-only: besides the story summary and the PR body
table, `storyNote` (`packages/nax/src/workflow/feature-steps.ts`) appends `unreviewed` to the story's line in the
branch-review facts, so cost-limit, gates-red-to-the-cap and no-work stories now carry that note to the branch
reviewer. Nothing gates behaviour on it.

The prompt block becomes:

```
## What nax already checked
nax ran these gates on this story before your review: lint <s>, typecheck <s>, scoped tests <s>, full suite <s>.
Do not list these gates in "cannotVerify": their results are stated here. Once every story is done nax runs the repository gates; nax records whether they ran and what they returned, so do not list the repository gates in "cannotVerify" either.
If you have a shell tool, run this story's own test files with one scoped test command before you give the spec verdict.<e2e>
```

where each `<s>` is the recorded state or `not run`. When the full suite state is `red`, one more line follows the
gates line: `The full suite is red; nax already records its failures as open findings, so do not repeat them as findings.`
The e2e sentence and `CANNOT_VERIFY_RULE` are unchanged.

### Integration

Read only (verified on `c5fe5a97c`):

- `StoryLoopSteps.fullSuite(): Promise<GateRunResult>` and `StoryLoopSteps.storyReview(concerns, gates?)`
  (`packages/nax/src/workflow/story-loop.ts`).
- `runReportCheck(env, state, runTurn): Promise<boolean>` (`packages/nax/src/workflow/report-check.ts`).
- `ledgerCannotVerify` / `isGateTimingItem` (`packages/nax/src/workflow/gate-timing.ts`), unchanged.
- `deriveEndState` (`packages/nax/src/workflow/close.ts`), unchanged: a red suite still ends `complete-gate-open`.
- `WorkflowStoryGateStates` already includes `"full-suite"`.
- Test harness `makeStoryLoopHarness` (`packages/nax/test/helpers/workflow-story-loop.ts`): `script.suite` queues
  `fullSuite()` results (an exhausted queue is green), `reviewGates` records the gate states each `storyReview` call
  received, `updates` records sink updates.

Changed. The baseline locates the code only; implement the target.

- `evaluate(env, s)` in `story-steps.ts`. Baseline: gates, report check, review, suite (suite only when
  `s.reviewOpen` is empty). Target: the order in § Approach.
- `review(env, s)` in `story-steps.ts`. Baseline: `env.steps.storyReview(s.concerns, s.gates?.states)`. Target:
  `env.steps.storyReview(s.concerns, { ...s.gates?.states, ...s.suite?.states })`.
- `closeStep` / `closeLoop` in `story-steps.ts`. Baseline: `unreviewed` is `s.unreviewed`; the closing update does
  not write `unreviewed`. Target: `unreviewed = s.unreviewed || !s.reviewed`, written in the closing update.
- `naxCheckedBlock(gates, e2eGate)` in `workflow-story-review-builder.ts`. Baseline: names lint, typecheck and
  scoped tests, then says the suite runs after the review. Target: the block in § Approach.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| Suite red, fix rounds left | No report check, no review this pass; open = suite findings, then `s.reviewOpen`; a fix round runs. |
| Suite red on the last pass | Report check and review run; open = suite findings, then review findings; the residual adjudicates the non-gate items; end state `complete-gate-open`. |
| Suite skipped (gate disabled) | Treated as not red: review runs; the prompt states `full suite skipped`. |
| `fullSuite()` throws | Not caught by the loop, as today: the error escapes `runStoryLoop`. |
| Story never reviewed (gates red to the cap, no-work close, cost limit before the first review) | `unreviewed: true` in the outcome, the closing record update and the end line. |

## Out of Scope

- The full suite still blocks the review on failures that were already present in the baseline; making only new failures block is a separate change.
- `isGateTimingItem` and `ledgerCannotVerify` are not changed.
- The re-review prompt (`buildWorkflowReReviewPrompt`) is not given gate states.
- The repository gates that run after every story is done keep their place and behaviour.
- `deriveEndState` and the end states are unchanged; a red suite still ends a story `complete-gate-open`.
- Pipeline mode is frozen and not changed.
- `residualStep` code is not changed; its suite branch stays for a residual entered with `suiteThisIteration` false.
- A suite result from an earlier pass is not cleared when a later pass stops on red gates; `deriveEndState` and the residual's `redGates` may still name `full-suite` from that earlier pass, as they can today.

## Stories

Three stories in `packages/nax`, one capability: the review always judges code the suite has run on, and a story
that was never reviewed says so.

### US-001: The story-review prompt states the full suite's result
No dependencies. Workdir: packages/nax.

`naxCheckedBlock` names the full suite's recorded state next to lint, typecheck and scoped tests, drops the "after
your review nax runs the full test suite" wording, keeps the repository-gates rule, and adds the red-suite line.

### US-002: The story loop runs the full suite before the review
Depends on US-001. Workdir: packages/nax.

`evaluate()` runs gates, full suite, report check, review. A red suite with fix rounds left goes to a fix without a
review; on the last pass a red suite still goes on to the review. `review()` passes the suite's state to
`storyReview`. The equivalence goldens are regenerated for the new order. The step-order comments in
`story-steps.ts` (above `evaluate`, `evaluateStep` and `residualStep`) and the story line in `packages/nax/README.md`
(`story: implement → gates → full suite → story review → fix rounds → residual ruling`) are updated to the new order,
and `docs/guides/regression-gate.md` says the workflow suite runs before the story review in every pass whose gates are green.

### US-003: A story that was never reviewed closes as unreviewed
Depends on US-002. Workdir: packages/nax.

`closeStep` marks `unreviewed` whenever no review ran, writes it to the record in the closing update, and the end
line says so.

### Context Files

**US-001**
- `packages/nax/src/prompts/builders/workflow-story-review-builder.ts` — `naxCheckedBlock`, `buildWorkflowStoryReviewPrompt`, `WorkflowStoryGateStates`
- `packages/nax/test/unit/prompts/workflow-builders.test.ts` — existing story-review prompt cases

**US-002**
- `packages/nax/src/workflow/story-steps.ts` — `evaluate`, `review`, `residualStep`, `passExit`
- `packages/nax/src/workflow/report-check.ts` — `runReportCheck`, `owesReport`
- `packages/nax/test/helpers/workflow-story-loop.ts` — `makeStoryLoopHarness`, `storyLoopFixtures`
- `packages/nax/test/unit/workflow/story-loop.test.ts` — existing loop cases and local harness
- `packages/nax/test/unit/workflow/story-loop-equivalence.test.ts` — golden recorder and `NAX_UPDATE_WORKFLOW_GOLDEN`

**US-003**
- `packages/nax/src/workflow/story-steps.ts` — `closeStep`, `closeLoop`
- `packages/nax/src/workflow/feature-record.ts` — `fromRecord` reads `record.unreviewed`
- `packages/nax/src/workflow/ledger.ts` — `ledgerText.end`
- `packages/nax/test/unit/workflow/story-loop-no-work.test.ts` — no-work harness

### Creates

**US-002**
- `packages/nax/test/unit/workflow/story-loop-suite-first.test.ts` — the new US-002 loop cases (`story-loop.test.ts` is at 579 of 800 lines)

**US-003**
- `packages/nax/test/unit/workflow/story-loop-unreviewed.test.ts` — the new US-003 close cases

### Modifies

**US-001**
- `packages/nax/test/unit/prompts/workflow-builders.test.ts` — the test "story review says which gates run after it (AC-6)" expects the prompt to contain "After your review nax runs the full test suite on this story", and the test "story review qualifies the suite as conditional and leaves unreached gates to nax's record (F1)" expects the sentences "Both run only when the workflow reaches them: ..." and "nax records whether each one ran and what it returned, so never list the full suite or the repository gates in "cannotVerify", even though they have not run yet."; the suite now runs before the review, so both tests are replaced by assertions on the new block (the gates line naming `full suite`, and the repository-gates sentence). The `not.toContain("if nax never reached one")` assertion stays.

**US-002**
- `packages/nax/test/unit/workflow/story-loop-equivalence.test.ts` — "AC-9: every steps and advisor call records a call and a return, in invocation order" expects the call list `["implement", "answerQuestion", "implement", "costExceeded", "gates", "storyReview", "fullSuite"]` and `calls[5]?.args` to equal `[[], GREEN.states]`; the suite now runs before the review, so the list becomes `[..., "gates", "fullSuite", "storyReview"]`, and the review-arguments assertion moves to `calls[6]?.args`, equal to `[[], { ...GREEN.states, ...SUITE_GREEN.states }]`. The call/return pairing invariant is unchanged.
- `packages/nax/test/unit/workflow/story-loop.test.ts` — "the gate states the loop already recorded reach storyReview (AC-10)" expects `h.reviewGates[0]` to equal `{ lint: "green", typecheck: "green", scoped: "green" }`; the suite now runs first and its state is passed too, so the expected value gains `"full-suite": "green"`.
- `packages/nax/test/unit/workflow/story-loop.test.ts` — "residual at the cap with green gates runs the suite once for the record" expects `suiteRuns` to be 1 with `maxFixRounds: 1`; the suite now runs in each of the two evaluate passes and the residual skips it (`suiteThisIteration` is true), so the expected count is 2 and the test name says the suite ran in the last pass.
- `packages/nax/test/fixtures/workflow-equivalence/story/clean.json` — golden trace regenerated with `NAX_UPDATE_WORKFLOW_GOLDEN=1` then biome format: the `fullSuite` call and phase `suite` now come before phase `review` and `storyReview`, whose gate-states argument gains `"full-suite"`.
- `packages/nax/test/fixtures/workflow-equivalence/story/full-suite-red.json` — golden trace regenerated as above for the new step order and the merged gate states passed to `storyReview`.
- `packages/nax/test/fixtures/workflow-equivalence/story/review-fail-one-round.json` — golden trace regenerated as above for the new step order and the merged gate states passed to `storyReview`.
- `packages/nax/test/fixtures/workflow-equivalence/story/rereview-new-finding.json` — golden trace regenerated as above for the new step order and the merged gate states passed to `storyReview`.
- `packages/nax/test/fixtures/workflow-equivalence/story/residual-rulings.json` — golden trace regenerated as above: the suite now runs in every evaluate pass with green gates, and the residual no longer calls `fullSuite`.
- `packages/nax/test/fixtures/workflow-equivalence/story/fresh-after-warm-cap.json` — golden trace regenerated as above: the suite now runs in every evaluate pass with green gates, and the residual no longer calls `fullSuite`.
- `packages/nax/test/fixtures/workflow-equivalence/story/needs-context-answered.json` — golden trace regenerated as above for the new step order and the merged gate states passed to `storyReview`.
- `packages/nax/test/fixtures/workflow-equivalence/story/red-gates-then-green.json` — golden trace regenerated as above for the new step order once the gates are green.
- `packages/nax/test/fixtures/workflow-equivalence/story/review-not-ran.json` — golden trace regenerated as above for the new step order.
- `packages/nax/test/fixtures/workflow-equivalence/story/resume-mid-fix.json` — golden trace regenerated as above for the new step order and the merged gate states passed to `storyReview`.
- `packages/nax/test/fixtures/workflow-equivalence/story/no-work-restart.json` — golden trace regenerated as above: after its restart the story works, so its pass runs the suite before the review.

**US-003**
- `packages/nax/test/unit/workflow/story-graph.test.ts` — "AC-39/AC-40: closeAs decides the outcome, and the record is closed once through the sink" builds its state from `initialStoryState`, so `reviewed` is false, and expects `result.patch.outcome` to equal `{ ..., unreviewed: false }`; a story closed with no review now reports `unreviewed: true`, so the expected outcome has `unreviewed: true`. The single closing update and its `toMatchObject` fields are unchanged.
- `packages/nax/test/fixtures/workflow-equivalence/story/clean.json` — golden trace regenerated with `NAX_UPDATE_WORKFLOW_GOLDEN=1` then biome format: the closing record update gains `unreviewed` (`false` for a reviewed story).
- `packages/nax/test/fixtures/workflow-equivalence/story/full-suite-red.json` — golden trace regenerated as above: the closing record update gains `unreviewed`.
- `packages/nax/test/fixtures/workflow-equivalence/story/review-fail-one-round.json` — golden trace regenerated as above: the closing record update gains `unreviewed`.
- `packages/nax/test/fixtures/workflow-equivalence/story/rereview-new-finding.json` — golden trace regenerated as above: the closing record update gains `unreviewed`.
- `packages/nax/test/fixtures/workflow-equivalence/story/residual-rulings.json` — golden trace regenerated as above: the closing record update gains `unreviewed`.
- `packages/nax/test/fixtures/workflow-equivalence/story/fresh-after-warm-cap.json` — golden trace regenerated as above: the closing record update gains `unreviewed`.
- `packages/nax/test/fixtures/workflow-equivalence/story/needs-context-answered.json` — golden trace regenerated as above: the closing record update gains `unreviewed`.
- `packages/nax/test/fixtures/workflow-equivalence/story/red-gates-then-green.json` — golden trace regenerated as above: the closing record update gains `unreviewed`.
- `packages/nax/test/fixtures/workflow-equivalence/story/review-not-ran.json` — golden trace regenerated as above: the closing record update gains `unreviewed`.
- `packages/nax/test/fixtures/workflow-equivalence/story/resume-mid-fix.json` — golden trace regenerated as above: the closing record update gains `unreviewed`.
- `packages/nax/test/fixtures/workflow-equivalence/story/cost-exceeded.json` — golden trace regenerated as above: the story stops on the cost limit before any review, so the closing record update gains `unreviewed: true` and the end line ends `, unreviewed`.
- `packages/nax/test/fixtures/workflow-equivalence/story/no-work-restart.json` — golden trace regenerated as above: the story works after its restart and is reviewed, so the closing record update gains `unreviewed: false`.

### Seams

- US-001 → US-002: `buildWorkflowStoryReviewPrompt` already receives the `gates` argument through `runStoryReview`
  (`packages/nax/src/workflow/story-review.ts`); US-002 adds `"full-suite"` to what `review()` passes, and its seam
  AC enters at `runStoryLoop` and asserts the states `storyReview` received.
- US-003 reads `s.reviewed` as left by US-002's `evaluate`; its ACs enter at `runStoryLoop`.

## Acceptance Criteria

### US-001

- [unit] `buildWorkflowStoryReviewPrompt` with `gates` `{ lint: "green", typecheck: "green", scoped: "green", "full-suite": "green" }` returns a prompt containing `nax ran these gates on this story before your review: lint green, typecheck green, scoped tests green, full suite green.`
- [unit] `buildWorkflowStoryReviewPrompt` with `gates` `{ lint: "green", typecheck: "green", scoped: "green" }` returns a prompt whose gates line ends `full suite not run.`
- [unit] `buildWorkflowStoryReviewPrompt` with `gates` whose `"full-suite"` is `"skipped"` returns a prompt whose gates line ends `full suite skipped.`
- [unit] `buildWorkflowStoryReviewPrompt` with any `gates` returns a prompt that does not contain `After your review nax runs the full test suite`.
- [unit] `buildWorkflowStoryReviewPrompt` returns a prompt containing `Do not list these gates in "cannotVerify": their results are stated here.`
- [unit] `buildWorkflowStoryReviewPrompt` returns a prompt containing `Once every story is done nax runs the repository gates; nax records whether they ran and what they returned, so do not list the repository gates in "cannotVerify" either.`
- [unit] `buildWorkflowStoryReviewPrompt` with `gates` whose `"full-suite"` is `"red"` returns a prompt containing `The full suite is red; nax already records its failures as open findings, so do not repeat them as findings.`
- [unit] `buildWorkflowStoryReviewPrompt` with `gates` whose `"full-suite"` is `"green"` returns a prompt that does not contain `The full suite is red`.
- [unit] `buildWorkflowStoryReviewPrompt` with `e2eGate: true` still returns a prompt containing `do not list e2e journeys in cannotVerify`.

### US-002

- [unit] `runStoryLoop` on a story whose gates, suite and review are all green calls `fullSuite` before `storyReview`: the recorded step calls are `gates`, then `fullSuite`, then `storyReview`.
- [unit] On that clean story, the record's `phase` updates run `implement`, `gates`, `suite`, `review`, `closed`, in that order.
- [unit] On that clean story, the gate states `storyReview` receives equal `{ lint: "green", typecheck: "green", scoped: "green", "full-suite": "green" }`.
- [unit] With `maxFixRounds: 2` and the suite queued red then green, `storyReview` is not called before the first fix turn, and that fix turn's findings all have `kind: "gate"` and `gate: "full-suite"`.
- [unit] In that scenario `storyReview` is called exactly once, after the second `fullSuite` call, and the story ends `complete` after 1 round.
- [unit] With `maxFixRounds: 2`, the suite queued red then green, and a story whose last implementer reply is `DONE` while `reportExists` returns `false`, no `report` turn runs before the first fix turn.
- [unit] With `maxFixRounds: 3`, a first review that opens one blocking spec finding `F1`, and the suite queued green, red, green, the second fix turn's findings are the suite finding followed by `F1`, and `reReview` is not called between the first and second fix turns.
- [unit] In that scenario the one `reReview` call receives as its fix base the head recorded before the first fix turn, and `head` is called once.
- [unit] With `maxFixRounds: 1` and the suite queued red, red, `storyReview` is called exactly once, after the second `fullSuite` call, and the story ends `complete-gate-open` with reason `red: full-suite`.
- [unit] In that scenario the gate states that `storyReview` receives have `"full-suite": "red"`.
- [unit] With `maxFixRounds: 1`, the suite queued red, red, and the one story review returning one blocking spec finding, the advisor's residual adjudication receives that spec finding among its items and `redGates` equal to `["full-suite"]`.
- [unit] In that scenario the open findings recorded for the last pass are, in order, the suite finding `F2` and the spec finding `F3`.
- [unit] With `maxFixRounds: 2`, a first review that opens one blocking spec finding `F1`, a re-review that leaves it open, and the suite queued green, red, red, `reReview` is called exactly once, in the last pass, with the head recorded before the first fix turn as its fix base, and the open findings of that pass are the new suite finding followed by `F1`.
- [unit] With `maxFixRounds: 0` and the suite queued red, `storyReview` is called exactly once and no fix turn runs.
- [unit] With the suite returning `{ red: false, states: { "full-suite": "skipped" }, findings: [] }`, `storyReview` is called once and the gate states it receives have `"full-suite": "skipped"`.
- [unit] With a `fullSuite` step that throws an error, `runStoryLoop` rejects with that same error object and `storyReview` is never called.
- [unit] With the first gates red (lint), `fullSuite` and `storyReview` are not called before the first fix turn, and that fix turn's findings all have `kind: "gate"`.

### US-003

- [unit] With `maxFixRounds: 1` and the gates red (lint) on both passes, `runStoryLoop` returns an outcome with `unreviewed: true` and `storyReview` is never called.
- [unit] In that scenario the ledger's end line is `complete-gate-open (1 round(s), red: lint, unreviewed)`.
- [unit] In that scenario the record update that sets `phase: "closed"` also sets `unreviewed: true`.
- [unit] A story closed by the no-work ladder (three no-work implementer turns) returns an outcome with `unreviewed: true`, and its closing record update sets `unreviewed: true`.
- [unit] A story whose gates, suite and review are all green returns an outcome with `unreviewed: false`, and its closing record update sets `unreviewed: false`.
- [unit] A story whose `costExceeded` returns `true` before its first review returns an outcome with `unreviewed: true` and state `complete-gate-open` with reason `cost-limit`.
- [unit] A story whose story review returns an unparseable reply still returns an outcome with `unreviewed: true` and state `complete`.
