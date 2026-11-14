# SPEC: run-time-waste-fixes — stop spending run time on gate and review work that cannot change the outcome

Closes: #2917, #2918, #2919, #2920, #2921

## Summary

The run artifact analysis of 2026-11-12 to 11-14 (34 runs, 110.6 h) found about 15 h spent on work that could not change a story's outcome. This feature removes five such costs in workflow mode. A scoped gate that already ran the full-suite command counts as the suite. A story review verdict that disagrees with its own findings is sent back to the reviewer once instead of opening a fix round. A gate timeout that repeats, or that matches a timed-out run-start baseline, goes to the advisor instead of another fix round. Branch review can promote a deferred minor to a blocking finding, and branch fix receives blocking findings before minors. Behind a config switch that is off by default, the first story review runs at the same time as the full-suite gate.

## Motivation

- **#2917.** When `quality.commands.testScoped` resolves to the same command as `quality.commands.test`, the scoped gate runs the whole suite and the full-suite gate then runs it again on the same tree. In three runs of one consumer project the scoped gate took 365 min and the full-suite gate 316 min for the same command. The same duplicate happens when the scoped gate falls back to the full-suite command (too many changed test files, or a scoped run that executed no tests).
- **#2921.** `parseStoryReviewReply` adds a synthetic important finding when the verdict is `spec: "fail"` or `quality: "changes"` with no blocking finding (`packages/nax/src/operations/workflow-replies.ts`). The implementer then gets a fix round with nothing concrete to fix. Two stories opened a fix round on this finding alone.
- **#2918.** A gate timeout becomes a gate finding and opens a fix round (`packages/nax/src/workflow/gates.ts`). A fix agent cannot repair a slow or hanging command, so the gate times out again with the same limit. One story spent 2 h 15 min on four timeouts and four fix rounds after the run-start baseline had already timed out on the same suite. The `gate-config-route` early stop (#2911) fires only when the implementer replies `BLOCKED`; these agents replied `DONE_WITH_CONCERNS`.
- **#2920.** Branch review triages each deferred minor as `fix-now` or `leave` on the wording "cheap and worth doing before the PR". In this window 147 minors reached branch fix as M items, mixed in one list with the blocking findings. Some were real defects filed too low, and a branch-fix session that hit its step limit had no order to work in.
- **#2919.** Inside a story pass the full-suite gate and the story review run in sequence, yet the review does not read the suite result. Full-suite gates took 11.3 h and story reviews 10.8 h; running the first review beside the suite saves the shorter of the two per pass, 4.6 h in this window.

## Design

### Approach

All five changes are in `packages/nax`. Pipeline mode is frozen and is not touched.

`packages/nax/src/workflow/story-steps.ts` is at 576 of its 600-line limit, and four of these changes touch the story loop. The new loop logic therefore lives in three new modules listed under Creates (`verdict-mismatch.ts`, `timeout-stop.ts`, `suite-review-pass.ts`), and `story-steps.ts` only calls them. The function shapes inside those modules are the implementer's choice, except `gateTimeoutRoute`, which is specified below.

**Suite reuse (#2917).** Two rules, both in the scoped path.

1. `selectScopedTests` (`packages/nax/src/test-runners/scoped-selection.ts`) treats a scoped command that equals the full-suite command as no scoping at all. After `buildScopedCommand` builds the command for the selected files, if it is equal to `input.testCommand` (the same string, or lists of the same strings in the same order), the function returns the same result as its `fullSuite()` helper with no options: `isFullSuite: true`, `thresholdFallback: false`. In workflow mode `verifyScopedOp` runs with `regressionMode: "deferred"`, so its existing rule then skips the scoped gate and the full-suite gate runs the suite once.
2. `verifyScopedOp` (`packages/nax/src/operations/verify-scoped.ts`) reports when a green scoped run was the full-suite command. `VerifyScopedOutput` gains `coversFullSuite: boolean`. It is `true` only when the run's `status` is `"passed"`, `isFullSuite` is `true`, and the command the run executed equals the command the full-suite gate would run. That command comes from a new dep, `VerifyScopedDeps.resolveFullSuiteCommand(config, workdir, packageDir)`, called with `input.packagePrefix` as its third argument and wired by default to `resolveQualityTestCommands(...).testCommand` (the resolver `fullSuiteGateOp` uses). Every other outcome sets `coversFullSuite: false`.

`runStoryGates` (`packages/nax/src/workflow/gates.ts`) copies it onto the gate result as `suiteCovered: true` (the key is absent otherwise). In `evaluate` (`story-steps.ts`), a gate result with `suiteCovered` skips `env.steps.fullSuite()`: the pass records the suite as `{ red: false, states: { "full-suite": "green" }, findings: [] }`, sets `suiteThisIteration`, and writes the ledger note `full-suite green (scoped gate ran the full-suite command; reused)`.

**Verdict mismatch (#2921).** `parseStoryReviewReply` stops adding synthetic findings. `StoryReviewVerdict` gains an optional field:

```ts
export type VerdictMismatch = "spec" | "quality";
// on StoryReviewVerdict:
readonly mismatch?: readonly VerdictMismatch[];
```

`"spec"` is listed when `spec` is `"fail"` and no finding has `kind: "spec"` with a severity other than `minor`. `"quality"` is listed when `quality` is `"changes"` and no finding of any kind has a severity other than `minor`. The order is `spec` then `quality`. The key is absent when neither holds.

Branch review keeps today's behaviour. `parseBranchReviewReply` applies the two floors itself after calling `parseStoryReviewReply`, in today's order and with the same texts: the spec floor first, then the quality floor only when no finding with a severity other than `minor` remains after the spec floor. A reply with `spec: "fail"`, `quality: "changes"` and no findings therefore still gets one synthetic finding, the spec one. It returns no `mismatch` key.

`workflowStoryReviewOp` (`packages/nax/src/operations/workflow-story-review.ts`) uses its one existing retry for the follow-up. Its retry `validate` rejects a parsed verdict that carries `mismatch`. Its `prompts.invalid` receives the last output: when that output parses to a verdict with `mismatch` it returns `buildWorkflowVerdictMismatchRetry(mismatch)`, otherwise `buildWorkflowReviewJsonRetry()` as today. `maxAttempts` stays 2 and `exhaustedFallback` is unchanged. Once the retry is spent, the op's own `parse` of the last reply is the result: a verdict that still carries `mismatch`, or `null` when the last reply does not parse. A reply that was first unparseable and then mismatched gets no third turn.

`buildWorkflowVerdictMismatchRetry` is a new function in `packages/nax/src/prompts/builders/workflow-story-review-builder.ts`, exported from `@/prompts`:

```ts
export function buildWorkflowVerdictMismatchRetry(mismatch: readonly VerdictMismatch[]): string;
```

For `"spec"` it says: `You returned spec: fail but no critical or important spec finding. Either name the acceptance criterion that fails as a finding, or change the verdict to pass.` For `"quality"` it says: `You returned quality: changes but no critical or important finding. Either name the defect as a finding, or change the verdict to approved.` It ends with the same reply-shape instruction `buildWorkflowReviewJsonRetry` gives.

In the story loop the findings are the truth in both directions: a verdict with `mismatch` and only minor findings opens no fix round, and one with a blocking finding opens a fix round on that finding as today. For a verdict with `mismatch` the loop writes one ledger note per kind (`story review verdict inconsistent: spec fail without a blocking spec finding; findings kept` and `story review verdict inconsistent: quality changes without a blocking finding; findings kept`) and records it on the story record as `verdictMismatch: { kinds, model? }`, where `model` is `env.steps.modelFor?.("story-review")?.model` and the key is absent when no model is known. The run summary counts mismatches per model: `WorkflowSummaryView.verdictMismatches` is a list of `{ model, count }` sorted by `model`, a record with no `model` counts under `unknown`, and `formatWorkflowSummary` prints `Inconsistent review verdicts: <model> <count>, <model> <count>`.

**Gate timeout facts (#2918, first part).** `GateRunResult` gains `timedOut?: readonly GateName[]`, absent when no gate timed out. `runStoryGates` lists `scoped` when `verifyScopedOp` returns `status: "timeout"`. `runWorkflowSuiteGate` lists `full-suite` when `fullSuiteGateOp` returns `"passed-on-timeout"` or `"timeout"`. The gate states and findings are unchanged.

A new module `packages/nax/src/workflow/timeout-stop.ts` (the shape of `blocked-stop.ts`) holds the rule as a pure function:

```ts
export interface GateTimeoutRouteInput {
  readonly previous: GateRunResult | undefined;      // the gates of the pass before this one
  readonly previousSuite: GateRunResult | undefined; // the suite the pass before this one ran, if it ran one
  readonly current: GateRunResult | undefined;
  readonly currentSuite: GateRunResult | undefined;  // the suite this pass ran, if it ran one
  readonly baselineTimedOut: boolean;
}
export interface GateTimeoutRoute {
  readonly gates: readonly GateName[]; // every gate that timed out in the current pass
  readonly why: "baseline" | "repeated";
}
export function gateTimeoutRoute(input: GateTimeoutRouteInput): GateTimeoutRoute | null;
```

It returns `null` when no gate timed out in the current pass. It returns `why: "baseline"` when `baselineTimedOut` is true. Otherwise it returns `why: "repeated"` when a gate that timed out in the current pass also timed out in the previous pass. Otherwise it returns `null`: a first timeout with a healthy baseline still gets one fix round, because a test the story made slow is code a fix agent can change.

`StoryLoopSteps` gains an optional step `timeoutFacts?(): Promise<{ baselineTimedOut: boolean; limitSeconds: number }>`. `buildStoryEnv` (`packages/nax/src/workflow/stage-env.ts`) wires it: `baselineTimedOut` is true when `readRunBaseline(projectDir, feature)` returns `{ kind: "no-baseline", reason: "timeout" }`, and `limitSeconds` is `resolveFullSuiteTimeoutSeconds(config)`. The run-start capture already records a timed-out baseline that way; this step makes it visible to the story loop.

`deriveEndState` (`packages/nax/src/workflow/close.ts`) gains an optional input `timedOut?: readonly GateName[]`. When at least one gate is red and every red gate is in `timedOut`, the reason is `gate timeout: <gates joined with ", ">` instead of `red: <gates>`. The state stays `complete-gate-open`.

**Gate timeout route (#2918, second part).** `StoryLoopState` gains `timeoutAsked: boolean` (initially false), produced by the `evaluate` node. After a pass, `evaluateStep` applies the rule before `stopOnUnchangedBlock`; when the rule fires, `stopOnUnchangedBlock` is not consulted for that pass.

A suite result counts only for the pass that ran the suite. `evaluate` returns early on red gates and keeps the earlier pass's suite in its state, so `currentSuite` is passed only when this pass set `suiteThisIteration`, and `previousSuite` only when the previous pass did. `timeoutFacts` is read only when the current pass has a timed-out gate. When the rule fires:

1. If `timeoutAsked` is false, nax asks the advisor itself through `env.advisor.answerQuestion`, and sets `timeoutAsked`. The request is an `ImplementerQuestionRequest` with `status: "GATE_TIMEOUT"`, `concerns` set to one sentence about the timeout whose wording is the implementer's choice, and a new `timing` field that carries the facts. When `scoped` is among the timed-out gates, `facts` come from `env.steps.configFacts(["scoped"])`; for a timeout of `full-suite` alone, `configFacts` is not called and the request has no `facts` (the #2911 rule offers no change for the full-suite command). It writes the ledger note `gate timeout on <gates> (<why>): no fix round, asked the advisor`.
2. A config change the advisor picks is applied through the existing `absorbConfigChange` transaction. When it is applied, `evaluateStep` runs the pass once more in the same node, with no implementer turn, so the gates read the changed command.
3. A string answer is written to the ledger as `gate timeout advice: <text>` and no implementer turn runs. A `null` answer writes nothing more. A refused change keeps the ledger line `absorbConfigChange` already writes.
4. In every case where no change was applied, and whenever the rule fires again after the advisor was already asked, the pass exits `capped`: the residual node rules and the story closes.

`closeStep` passes the timed-out gates of the last pass to `deriveEndState` and, when there are any, records them on the story record as `gateTimeouts`. The same rule as above applies: a suite's `timedOut` counts only when the last pass, or the residual node after it, ran the suite, so a suite result kept from an earlier pass adds nothing. The run summary carries them per story (`stories[].gateTimeouts`), and `formatWorkflowSummary` prints `Held on a gate timeout: <storyId> (<gates>), <storyId> (<gates>)`.

```ts
// packages/nax/src/workflow/advisor.ts
export interface GateTimeoutFacts {
  readonly gates: readonly GateName[];
  readonly baselineTimedOut: boolean;
  readonly repeated: boolean;
  readonly limitSeconds?: number; // absent when the timeoutFacts step is unwired or threw
}
// ImplementerQuestionRequest.status becomes "NEEDS_CONTEXT" | "BLOCKED" | "GATE_TIMEOUT",
// and the request gains: readonly timing?: GateTimeoutFacts;
```

`implementerQuestionDraft` (`packages/nax/src/workflow/advisor-live.ts`) builds the draft for `GATE_TIMEOUT` with the summary `nax stopped the fix loop for <storyId>: the <gates> gate timed out and another fix round cannot change a slow or hanging command.` Its first evidence item has `source: "gate"` and the text `Gate timeout facts: limit <n> s; run-start baseline timed out: <yes|no>; same gate timed out in the previous pass: <yes|no>`, with `limit unknown` in place of `limit <n> s` when `limitSeconds` is absent. The menu is unchanged (`answer`, `hold`, and the config changes in `facts`).

**Minors triage (#2920).** `MinorTriageDecision` becomes `"promote" | "fix-now" | "leave"`. The branch review prompt (`packages/nax/src/prompts/builders/workflow-branch-builder.ts`) states the three by consequence:

`Triage each deferred minor: "promote" when it describes wrong behaviour a user or caller can reach (it is then fixed as a blocking finding), "fix-now" when it is a real defect or a breach of a project rule worth fixing before the PR, or "leave" when it is style, comment wording, formatting or duplication that no project rule names (it is listed in the PR body and not fixed). Its "minorTriage" entry is its whole verdict: do not repeat a deferred minor as a finding.`

The reply shape reads `"decision": "promote|fix-now|leave"`. `parseBranchReviewReply` accepts `promote`; an unknown or missing decision still reads as `leave`.

`branchReviewStep` (`packages/nax/src/workflow/feature-steps.ts`) turns each promoted minor into a blocking finding `{ kind: "quality", severity: "important", issue: "<storyId>: <text>" }`, assigned a B id after the reviewer's own blocking findings. The minor stays in the record with `triage: "promote"`, so it is in neither the fix-now group nor the PR body's left-minors list. The branch quality floor (`withQualityFloor`) adds its synthetic finding only when the verdict has no blocking finding of its own and no minor was promoted: a promoted minor is the concrete item to fix. The step line adds the promoted count only when it is above zero: `deferred minors: 2 promote, 3 fix-now, 9 leave`, and `deferred minors: 3 fix-now, 9 leave` when none was promoted.

`branchFixStep` orders round 1's items as review findings, then gate findings, then fix-now minors. `buildWorkflowBranchFixPrompt` renders findings with a severity other than `minor` under `## Findings to fix` and the minor ones under a second heading `## Minor findings to fix after those`, which is omitted when there is none. The "How to work" list gains `Fix the findings in the first list before the minor ones.`

The run summary's `branch` view gains `minors: { found, promoted, fixNow, left }`, counted from the record's `minors` list by triage (`left` is the `leave` count) and present only when that list is not empty. The existing `minorsLeft` keeps its meaning: the `leave` count plus the record's `newMinors`. `formatWorkflowSummary` prints `Deferred minors: 9 found, 2 promoted, 3 fix-now, 4 left`.

**Review beside the suite (#2919).** `workflow.review` gains `parallelWithSuite: boolean`, default `false`. `packages/nax/src/cli/config-descriptions.ts` gains a description for it, and the `workflow.review` description is reworded to name both keys. `StoryLoopEnv` gains `parallelReview?: boolean` and `now?: () => number` (default `Date.now`). `buildStoryEnv` sets `parallelReview` to `(workflow.review ?? WORKFLOW_REVIEW_DEFAULTS).parallelWithSuite === true`, because a hand-built `workflow` block can omit `review`, and its `storyReview` step forwards the third argument to `runStoryReview`.

A pass is a parallel pass when `env.parallelReview` is true, `env.resume` is `null`, the story has not been reviewed yet, the gates are green and the gate result has no `suiteCovered`. A parallel pass runs in this order: the report check (`runReportCheck`) first, then `env.steps.fullSuite()` and the first story review together. The report check moves ahead of the suite in a parallel pass only, so a first pass whose suite turns red still spends the report turn when one is owed. Both the suite and the review are awaited to settlement before the pass goes on; if the review rejects (a run abort), the rejection is rethrown after the suite settles. The review step is called with the gate states recorded so far (no `full-suite` key) and a new third argument `{ suiteRunning: true }`. `runStoryReview` passes it to `buildWorkflowStoryReviewPrompt`, whose gates line then ends `full suite still running.` followed by the sentence `The full suite is still running while you review; nax records its result itself, so do not list it under cannotVerify.`

After both settle, the pass returns the suite findings plus the review's open findings. A red suite before the round cap therefore opens a fix round that carries both. Every other pass (a re-review, a resumed story, a pass with `suiteCovered`) keeps today's order, including the rule that a red suite before the cap bypasses the re-review.

The pass measures the overlap with `env.now`: it reads the clock once before starting the two, once when the suite settles and once when the review settles, and the overlap is the smaller of the two elapsed times. It is recorded on the story record as `reviewOverlapMs`. The run summary sums it over the stories as `reviewOverlapMs` (absent when zero), and `formatWorkflowSummary` prints `Review overlap with the full suite: <formatDuration(ms)>`.

The reviewer tree guard (`packages/nax/src/review/reviewer-guard/`) restores non-ignored paths that changed during a review turn. With the switch on, a suite that writes files git does not ignore can have them removed when the review ends. The config description says so; the switch is for suites whose outputs are gitignored.

### Integration (extends existing code)

The baseline below exists only to locate the code. It is never the interface to implement.

Symbols this feature changes:

- `selectScopedTests(input: SelectScopedTestsInput): Promise<SelectScopedTestsResult>` (`packages/nax/src/test-runners/scoped-selection.ts`). The signature is unchanged. Target: a built scoped command equal to `input.testCommand` yields the `fullSuite()` result.
- `VerifyScopedOutput` (`packages/nax/src/operations/verify-scoped.ts`). Target: gains `readonly coversFullSuite: boolean`. `VerifyScopedDeps` gains `resolveFullSuiteCommand: (config, workdir: string, packageDir: string | undefined) => Promise<QualityCommandSpec | undefined>`.
- `GateRunResult` (`packages/nax/src/workflow/types.ts`). Baseline: `{ red, states, findings }`. Target: the same plus `suiteCovered?: true` and `timedOut?: readonly GateName[]`.
- `StoryReviewVerdict` (`packages/nax/src/operations/workflow-types.ts`). Target: gains `mismatch?: readonly VerdictMismatch[]`. `MinorTriageDecision` in the same file. Baseline: `"fix-now" | "leave"`. Target: `"promote" | "fix-now" | "leave"`.
- `parseStoryReviewReply(output: string): StoryReviewVerdict | null` and `parseBranchReviewReply(output: string, minorIds: readonly string[]): BranchReviewVerdict | null` (`packages/nax/src/operations/workflow-replies.ts`). Signatures unchanged; behaviour as described in Approach.
- `workflowStoryReviewOp.retry` (`packages/nax/src/operations/workflow-story-review.ts`). Baseline: `validate: (parsed) => parsed !== null`, `prompts.invalid: buildWorkflowReviewJsonRetry`. Target: as described in Approach.
- `StoryLoopSteps.storyReview` (`packages/nax/src/workflow/story-loop.ts`). Baseline: `storyReview(concerns, gates?)`. Target: `storyReview(concerns, gates?, options?: { readonly suiteRunning?: boolean })`. `StoryLoopSteps` also gains `timeoutFacts?`. `StoryLoopEnv` gains `parallelReview?` and `now?`. `StoryLoopState` gains `timeoutAsked: boolean`.
- `runStoryReview(sc, concerns, gates?)` (`packages/nax/src/workflow/story-review.ts`). Target: a fourth parameter `options?: { readonly suiteRunning?: boolean }`.
- `WorkflowStoryRecord` (`packages/nax/src/workflow/types.ts`). Target: gains `verdictMismatch?: { readonly kinds: readonly VerdictMismatch[]; readonly model?: string }`, `gateTimeouts?: readonly GateName[]` and `reviewOverlapMs?: number`.
- `ImplementerQuestionRequest` (`packages/nax/src/workflow/advisor.ts`). Baseline: `status: "NEEDS_CONTEXT" | "BLOCKED"`. Target: `status: "NEEDS_CONTEXT" | "BLOCKED" | "GATE_TIMEOUT"` plus `timing?: GateTimeoutFacts`.
- `deriveEndState(input)` (`packages/nax/src/workflow/close.ts`). Target: `input` gains `timedOut?: readonly GateName[]`.
- `WorkflowSummaryView` (`packages/nax/src/log-format/types.ts`). Target: `stories[]` entries gain `gateTimeouts?: readonly string[]`; `branch` gains `minors?: { found: number; promoted: number; fixNow: number; left: number }`; the view gains `verdictMismatches?: readonly { model: string; count: number }[]` and `reviewOverlapMs?: number`.
- `WorkflowConfig["review"]` (`packages/nax/src/config/runtime-types-workflow.ts`) and `WorkflowReviewConfigSchema` (`packages/nax/src/config/schemas-workflow.ts`). Baseline: `{ coverageRetries }`. Target: `{ coverageRetries, parallelWithSuite }`.
- `buildWorkflowStoryReviewPrompt(input)` (`packages/nax/src/prompts/builders/workflow-story-review-builder.ts`). Target: `input` gains `suiteRunning?: boolean`.

Symbols this feature only reads:

- `resolveQualityTestCommands(config, workdir, storyWorkdir?)` (`packages/nax/src/quality/command-resolver.ts`); its result's `testCommand` is the full-suite gate's command.
- `readRunBaseline(root: string, featureId: string): Promise<TestBaseline | undefined>` (`packages/nax/src/verification/test-baseline.ts`); a timed-out capture is `{ kind: "no-baseline", reason: "timeout" }`.
- `resolveFullSuiteTimeoutSeconds(config)` (`packages/nax/src/quality/gate-timeout.ts`).
- `absorbConfigChange(input: ConfigAnswerInput): Promise<ConfigAnswerResult>` (`packages/nax/src/workflow/config-change-absorb.ts`).
- `makeParseRetryStrategy(opts: ParseRetryOpts)` (`packages/nax/src/agents/retry/parse-retry.ts`); `prompts.invalid` receives the last output.
- `runReportCheck(env, state, runTurn)` (`packages/nax/src/workflow/report-check.ts`).
- `stopOnUnchangedBlock(env, input)` (`packages/nax/src/workflow/blocked-stop.ts`).
- `StepModel { agentName; model }` (`packages/nax/src/workflow/run-log.ts`).

Patterns to follow: `blocked-stop.ts` for a pure early-stop rule with its own ledger line; the `_deps` injection pattern for every new seam; optional record fields that are absent rather than empty, as `configChanges` is.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| `resolveFullSuiteCommand` throws or resolves `undefined` | `coversFullSuite` is `false`; the scoped result is otherwise unchanged and the full-suite gate runs. |
| The reviewer's follow-up reply is unparseable | The op returns `null`, the review is skipped as today (`unparseable reply`) and the story closes unreviewed. |
| The reviewer's follow-up reply still carries a mismatch | The verdict is used with its findings; the mismatch is ledgered and recorded. |
| `timeoutFacts` is unwired or throws | The rule runs with `baselineTimedOut: false`; `timing.limitSeconds` is absent. A warn is logged for a throw. |
| `env.advisor.answerQuestion` throws for a `GATE_TIMEOUT` question | A warn is logged, no advice is recorded, and the pass exits `capped`. |
| The advisor's config change is refused or its write fails | The existing refusal ledger line is kept and the pass exits `capped`. |
| The story review rejects while the suite is still running (parallel pass) | The rejection is rethrown after the suite settles. |
| The suite step rejects while the story review is still running (parallel pass) | The rejection is rethrown after the review settles. |
| The story review is skipped (`ran: false`) in a parallel pass | The story is marked unreviewed as today; the suite result is used unchanged. |

## Out of Scope

- A gate is not stopped early when its output stalls or repeats; that is tracked in #2923 and every gate still runs to its configured timeout.
- Pipeline mode (`execution.mode: "pipeline"`) is not changed; it is frozen.
- Branch review keeps both synthetic findings for a verdict without a blocking finding, and gets no follow-up turn; the branch half of that problem is tracked in #2924.
- The re-review verdict shape and its parser are not changed.
- The run-start baseline capture is not changed, and neither its duration nor a gate's last passing duration is recorded or shown to the advisor; only the baseline's existing timeout marker is read.
- A gate timeout is not routed on the ground that the fix turn changed no file; a second consecutive timeout of the same gate already routes it.
- The gate timeout limit (`execution.regressionGate.timeoutSeconds`) is not changed by nax, and the advisor is offered no change to it.
- The #2911 rule that a `full-suite` gate offers no config change stays; a full-suite timeout is asked without config candidates.
- The first gate timeout of a story with a healthy baseline still opens one fix round.
- A monorepo orchestrator test command is not treated as covering the full suite unless the scoped gate ran exactly the command the full-suite gate resolves.
- `workflow.review.parallelWithSuite` stays `false` by default, and no project config is edited by this feature.
- The reviewer tree guard is not changed; with `parallelWithSuite` on, suite outputs that git does not ignore can be removed when the review ends.
- Re-reviews, resumed stories and branch review never run beside the suite.
- Deferred minors triaged `leave` are not removed from the PR body, and the story reviewer's own severity wording (changed by #2922) is not edited again.
- Saved `result.json` files from earlier runs are not rewritten; the new record fields are absent on them.
- No file under `.nax/` is created or edited by any story.

## Stories

This feature has nine stories because it bundles five issues that share one function (`evaluate` and `evaluateStep` in the story loop) and so must land in one order on one branch. Splitting it into separate features would put the same file under several concurrent branches.

### US-001 — a scoped gate that ran the full-suite command counts as the suite

Workdir: packages/nax. No dependencies.

`selectScopedTests` treats a scoped command equal to the test command as the full suite, `verifyScopedOp` reports `coversFullSuite`, the gate result carries `suiteCovered`, and `evaluate` skips the second suite run and says so in the ledger.

### US-002 — the story review op reports a verdict mismatch and asks the reviewer once

Workdir: packages/nax. No dependencies.

`parseStoryReviewReply` reports `mismatch` instead of adding a synthetic finding, `parseBranchReviewReply` keeps today's floors, and `workflowStoryReviewOp` spends its one retry on `buildWorkflowVerdictMismatchRetry`.

### US-003 — the story loop keeps the findings as the truth and counts mismatches

Workdir: packages/nax. Depends on US-002.

A verdict with `mismatch` opens no fix round of its own, is written to the ledger and the story record, and is counted per reviewer model in the run summary.

### US-004 — gate timeouts are facts the story loop can read

Workdir: packages/nax. Depends on US-001.

The gate result lists timed-out gates, `gateTimeoutRoute` decides when a timeout cannot be fixed by another round, the `timeoutFacts` step exposes the run-start baseline timeout and the limit, and `deriveEndState` names a gate timeout in its reason.

### US-005 — a repeated or baseline-matched gate timeout is asked of the advisor, not fixed

Workdir: packages/nax. Depends on US-004.

`evaluateStep` applies `gateTimeoutRoute`, asks the advisor once with the timing facts and the scoped gate's config facts, records the advice, and exits the pass to the residual node instead of a fix round.

### US-006 — a gate-timeout config change is applied, and a held story says why

Workdir: packages/nax. Depends on US-005.

A config change the advisor picks for a gate timeout re-runs the pass without a fix turn; a story that closes on a gate timeout records it, the advisor draft states the timing facts, and the run summary lists the held stories.

### US-007 — branch review can promote a deferred minor, and branch fix gets blocking findings first

Workdir: packages/nax. No dependencies.

`promote` joins the triage decisions and becomes a B finding, the triage wording is stated by consequence, the branch-fix prompt lists blocking findings before minors, and the run summary reports found, promoted, fix-now and left.

### US-008 — the `parallelWithSuite` switch, and a review prompt that knows the suite is running

Workdir: packages/nax. No dependencies.

`workflow.review.parallelWithSuite` (default `false`) reaches the story env as `parallelReview`, and `runStoryReview` can tell the reviewer the full suite is still running.

### US-009 — the first story review runs beside the full-suite gate

Workdir: packages/nax. Depends on US-001, US-003, US-006, US-008.

With `parallelReview` on, a fresh story's first pass runs the report check, then the full-suite gate and the story review together; a red suite keeps the review's findings for the same fix round, and the run summary shows the overlap.

### Context Files

**US-001**
- `packages/nax/src/test-runners/scoped-selection.ts` — `selectScopedTests`, `buildScopedCommand`, the `fullSuite()` helper
- `packages/nax/src/operations/verify-scoped.ts` — `verifyScopedOp`, `VerifyScopedOutput`, `VerifyScopedDeps`
- `packages/nax/src/workflow/gates.ts` — `runStoryGates`, `runWorkflowSuiteGate`
- `packages/nax/src/workflow/story-steps.ts` — `evaluate`, `residualStep`
- `packages/nax/src/quality/command-resolver.ts` — `resolveQualityTestCommands`

**US-002**
- `packages/nax/src/operations/workflow-replies.ts` — `parseStoryReviewReply`, `parseBranchReviewReply`, the two synthetic issue texts
- `packages/nax/src/operations/workflow-story-review.ts` — `workflowStoryReviewOp` and its retry
- `packages/nax/src/agents/retry/parse-retry.ts` — `makeParseRetryStrategy`, `prompts.invalid`
- `packages/nax/src/prompts/builders/workflow-story-review-builder.ts` — `buildWorkflowReviewJsonRetry`
- `packages/nax/src/operations/workflow-types.ts` — `StoryReviewVerdict`

**US-003**
- `packages/nax/src/workflow/story-steps.ts` — `review`, `deferMinors`
- `packages/nax/src/workflow/story-loop.ts` — `StoryLoopEnv`, `StoryLoopSteps.modelFor`
- `packages/nax/src/workflow/run-summary.ts` — `buildWorkflowRunSummary`
- `packages/nax/src/log-format/types.ts` — `WorkflowSummaryView`
- `packages/nax/src/log-format/workflow-summary.ts` — `formatWorkflowSummary`

**US-004**
- `packages/nax/src/workflow/gates.ts` — where a scoped or suite timeout becomes a red gate
- `packages/nax/src/workflow/blocked-stop.ts` — the pure early-stop rule to mirror
- `packages/nax/src/workflow/close.ts` — `deriveEndState`
- `packages/nax/src/workflow/stage-env.ts` — `buildStoryEnv`, the `steps` object
- `packages/nax/src/verification/test-baseline.ts` — `readRunBaseline`, the `no-baseline` shape

**US-005**
- `packages/nax/src/workflow/story-steps.ts` — `evaluateStep`, `passExit`, `consultAdvisor`
- `packages/nax/src/workflow/timeout-stop.ts` — created by US-004, extended here
- `packages/nax/src/workflow/story-loop.ts` — `StoryLoopState`, `StoryLoopSteps`
- `packages/nax/src/workflow/story-graph.ts` — the `evaluate` node's `produces` keys
- `packages/nax/src/workflow/advisor.ts` — `ImplementerQuestionRequest`, `WorkflowAdvisor`

**US-006**
- `packages/nax/src/workflow/config-change-absorb.ts` — `absorbConfigChange`
- `packages/nax/src/workflow/story-steps.ts` — `evaluateStep`, `closeStep`, `closeLoop`
- `packages/nax/src/workflow/advisor-live.ts` — `implementerQuestionDraft`, `createLiveWorkflowAdvisor`
- `packages/nax/src/workflow/run-summary.ts` — the `stories` rows of `buildWorkflowRunSummary`
- `packages/nax/src/log-format/workflow-summary.ts` — `formatWorkflowSummary`

**US-007**
- `packages/nax/src/workflow/feature-steps.ts` — `branchReviewStep`, `branchFixStep`, `fixNowMinors`, `withQualityFloor`
- `packages/nax/src/prompts/builders/workflow-branch-builder.ts` — the triage line, the reply shape, `buildWorkflowBranchFixPrompt`
- `packages/nax/src/operations/workflow-replies.ts` — `triageOf`, `parseBranchReviewReply`
- `packages/nax/src/workflow/run-summary.ts` — `branchOf`, `minorsLeftOf`
- `packages/nax/src/log-format/workflow-summary.ts` — `formatWorkflowSummary`

**US-008**
- `packages/nax/src/config/schemas-workflow.ts` — `WorkflowReviewConfigSchema`, `WORKFLOW_REVIEW_DEFAULTS`
- `packages/nax/src/workflow/story-loop.ts` — `StoryLoopSteps.storyReview`, `StoryLoopEnv`
- `packages/nax/src/workflow/stage-env.ts` — `buildStoryEnv`
- `packages/nax/src/workflow/story-review.ts` — `runStoryReview`
- `packages/nax/src/prompts/builders/workflow-story-review-builder.ts` — the gates line of `buildWorkflowStoryReviewPrompt`

**US-009**
- `packages/nax/src/workflow/story-steps.ts` — `evaluate`, `review`
- `packages/nax/src/workflow/report-check.ts` — `runReportCheck`
- `packages/nax/src/workflow/story-loop.ts` — `StoryLoopEnv.parallelReview`, `StoryLoopEnv.now`
- `packages/nax/src/workflow/run-summary.ts` — `buildWorkflowRunSummary`
- `packages/nax/src/log-format/workflow-summary.ts` — `formatWorkflowSummary`

### Creates

**US-003**
- `packages/nax/src/workflow/verdict-mismatch.ts` — the ledger notes and the story-record write for a verdict with `mismatch`

**US-004**
- `packages/nax/src/workflow/timeout-stop.ts` — `gateTimeoutRoute` and its input and result types

**US-009**
- `packages/nax/src/workflow/suite-review-pass.ts` — the parallel pass: suite and first review together, and the overlap measurement

### Modifies

**US-001**
- `packages/nax/test/unit/workflow/gates.test.ts` — the typed fixture `green` (`satisfies Record<string, Result>`) holds a `VerifyScopedOutput` literal without `coversFullSuite`, which no longer compiles once the field is required; the literal gains `coversFullSuite: false` and its assertions stay unchanged.
- `packages/nax/test/unit/operations/verify-scoped.test.ts` — the helper `fakeDeps(): VerifyScopedDeps` returns a full literal without `resolveFullSuiteCommand`, which no longer compiles once the dep is required; the literal gains a `resolveFullSuiteCommand` that resolves `undefined`.
- `packages/nax/test/unit/operations/verify-scoped-scratch.test.ts` — the helper `fakeDeps(): VerifyScopedDeps` returns a full literal without `resolveFullSuiteCommand`, which no longer compiles once the dep is required; the literal gains a `resolveFullSuiteCommand` that resolves `undefined`.

**US-002**
- `packages/nax/test/unit/operations/workflow-replies.test.ts` — the three tests "spec fail with no blocking spec finding gets a synthetic one", "spec fail with only a minor spec finding still gets the synthetic one" and "quality changes with no blocking finding gets a synthetic quality one" assert that `parseStoryReviewReply` adds an important finding; the new invariant is that it adds none and returns `mismatch` (`["spec"]` or `["quality"]`), while the same three inputs through `parseBranchReviewReply` still get the synthetic finding.

**US-003**
None. No existing story-loop fixture passes a verdict that carries `mismatch`, and the new summary key is absent for records without one.

**US-004**
None. `GateRunResult.timedOut` and the `deriveEndState` input are optional, and existing assertions read `red`, `states`, `findings`, `state` and `reason` for inputs with no timeout.

**US-005**
- `packages/nax/test/unit/workflow/story-graph.test.ts` — `EXPECTED_PRODUCES.evaluate` lists the `evaluate` node's `produces` keys and is compared to the graph with a sorted equality check; the list gains `timeoutAsked`.

**US-006**
None. The config-change re-run and the `gateTimeouts` record field appear only on a pass that carries `timedOut`, which no existing fixture sets.

**US-007**
- `packages/nax/test/unit/prompts/workflow-branch-builder.test.ts` — one test expects the reply shape text `"minorTriage": [{"id": "M1", "decision": "fix-now|leave"}]`; the shape now reads `"decision": "promote|fix-now|leave"`.
- `packages/nax/test/unit/workflow/feature-machine.test.ts` — one test expects the branch-fix input ids in the order `["B3", "M1", "B1", "B2"]` (review findings, fix-now minors, gate findings); the new order is review findings, gate findings, fix-now minors, so the expectation becomes `["B3", "B1", "B2", "M1"]`.

**US-008**
- `packages/nax/test/unit/config/schemas-workflow-review.test.ts` — three equality expectations pin `workflow.review` to `{ coverageRetries: <n> }`; the object now also carries `parallelWithSuite: false`.
- `packages/nax/test/unit/config/workflow-config.test.ts` — the expected default `workflow` object lists `review: { coverageRetries: 3 }`; it becomes `review: { coverageRetries: 3, parallelWithSuite: false }`.
- `packages/nax/test/unit/config/removed-config-keys.test.ts` — the test "project loading retains only coverageRetries" expects `config.workflow.review` to equal `{ coverageRetries: 2 }`; the loaded object now also carries `parallelWithSuite: false`, and the removed key `sliceFiles` is still absent.

**US-009**
None. The parallel pass runs only when `env.parallelReview` is true, which no existing story-loop fixture sets.

### Seams

- US-004 exports `gateTimeoutRoute` from `packages/nax/src/workflow/timeout-stop.ts` and adds the `timeoutFacts` step; US-005 calls both from `evaluateStep`. US-005's ACs enter at `runStoryLoop(env)` and assert that `env.steps.timeoutFacts` and `env.advisor.answerQuestion` are called.
- US-002 adds `StoryReviewVerdict.mismatch`; US-003 reads it in the story loop, entered at `runStoryLoop(env)`.
- US-002 adds `buildWorkflowVerdictMismatchRetry`, exported from `@/prompts` and called by `workflowStoryReviewOp` in the same story (US-002 AC 17).
- US-001 adds `GateRunResult.suiteCovered`; US-009 reads it to keep a covered pass sequential (US-009 AC 6 and 7).
- US-008 adds `StoryLoopEnv.parallelReview` and the third `storyReview` argument; US-009 reads the first and passes the second (US-009 AC 3).

## Acceptance Criteria

### US-001

1. [unit] `selectScopedTests` with `testCommand: "pytest -q"`, `testScopedTemplate: "pytest -q"` and one changed test file returns `isFullSuite === true`.
2. [unit] `selectScopedTests` with `testCommand: "pytest -q"`, `testScopedTemplate: "pytest -q"` and one changed test file returns `thresholdFallback === false`.
3. [unit] `selectScopedTests` with `testCommand: ["a", "b"]`, `testScopedTemplate: ["a", "b"]` and one changed test file returns `isFullSuite === true`.
4. [unit] `selectScopedTests` with `testCommand: "pytest -q"`, `testScopedTemplate: "pytest -q {{files}}"` and one changed test file returns `isFullSuite === false`.
5. [unit] `verifyScopedOp.execute` with `quality.commands.test` and `quality.commands.testScoped` both `"pytest -q"`, `regressionMode: "deferred"` and one changed test file returns `status === "skipped"`.
6. [unit] `verifyScopedOp.execute` with `quality.commands.test` and `quality.commands.testScoped` both `"pytest -q"`, `regressionMode: "deferred"` and one changed test file never calls `deps.regression`.
7. [unit] `verifyScopedOp.execute` whose selection returns `isFullSuite: true` with `thresholdFallback: true`, whose `deps.regression` succeeds and whose `deps.resolveFullSuiteCommand` resolves the command the run executed returns `coversFullSuite === true`.
8. [unit] `verifyScopedOp.execute` after a green full-suite scoped run calls `deps.resolveFullSuiteCommand` with `input.packagePrefix` as its third argument.
9. [unit] `verifyScopedOp.execute` whose selection returns `isFullSuite: true` with `thresholdFallback: true`, whose `deps.regression` succeeds and whose `deps.resolveFullSuiteCommand` resolves a different command returns `coversFullSuite === false`.
10. [unit] `verifyScopedOp.execute` whose selection returns `isFullSuite: false` and whose `deps.regression` succeeds returns `coversFullSuite === false`.
11. [unit] `verifyScopedOp.execute` whose selection returns `isFullSuite: true` with `thresholdFallback: true` and whose `deps.regression` returns `status: "TIMEOUT"` returns `coversFullSuite === false`.
12. [unit] `verifyScopedOp.execute` whose selection returns `isFullSuite: true` with `thresholdFallback: true` and whose `deps.regression` fails with parsed failures returns `coversFullSuite === false`.
13. [unit] `verifyScopedOp.execute` whose `deps.resolveFullSuiteCommand` resolves `undefined` after a green full-suite scoped run returns `coversFullSuite === false`.
14. [unit] `verifyScopedOp.execute` whose `deps.resolveFullSuiteCommand` throws after a green full-suite scoped run returns `coversFullSuite === false`.
15. [unit] `verifyScopedOp.execute` whose `deps.resolveFullSuiteCommand` throws after a green full-suite scoped run returns `status === "passed"`.
16. [unit] `runStoryGates(sc)` whose `verifyScopedOp` output is `status: "passed"` with `coversFullSuite: true` returns a result with `suiteCovered === true`.
17. [unit] `runStoryGates(sc)` whose `verifyScopedOp` output is `status: "passed"` with `coversFullSuite: false` returns a result with no `suiteCovered` key.
18. [unit] `runStoryLoop(env)` whose `steps.gates` resolves `{ red: false, states: { scoped: "green" }, findings: [], suiteCovered: true }` and whose review is clean never calls `steps.fullSuite`.
19. [unit] `runStoryLoop(env)` whose `steps.gates` resolves a green result with `suiteCovered: true` calls `sink.ledger` with `full-suite green (scoped gate ran the full-suite command; reused)`.
20. [unit] `runStoryLoop(env)` whose `steps.gates` resolves a green result with `suiteCovered: true` calls `steps.storyReview` with a gates argument whose `"full-suite"` value is `"green"`.
21. [unit] `runStoryLoop(env)` whose `steps.gates` resolves a green result with `suiteCovered: true` and whose review is clean resolves with `state === "complete"`.
22. [unit] `runStoryLoop(env)` whose `steps.gates` resolves a green result with no `suiteCovered` key calls `steps.fullSuite` exactly once in that pass.

### US-002

1. [unit] `parseStoryReviewReply` of `{"spec": "fail", "quality": "approved", "findings": []}` returns `findings` equal to `[]`.
2. [unit] `parseStoryReviewReply` of `{"spec": "fail", "quality": "approved", "findings": []}` returns `mismatch` equal to `["spec"]`.
3. [unit] `parseStoryReviewReply` of a `spec: "fail"` reply whose only finding is `{ severity: "minor", kind: "spec", issue: "naming" }` returns `mismatch` equal to `["spec"]`.
4. [unit] `parseStoryReviewReply` of a `spec: "fail"` reply whose only finding is `{ severity: "minor", kind: "spec", issue: "naming" }` returns exactly one finding.
5. [unit] `parseStoryReviewReply` of `{"spec": "pass", "quality": "changes", "findings": []}` returns `mismatch` equal to `["quality"]`.
6. [unit] `parseStoryReviewReply` of `{"spec": "fail", "quality": "changes", "findings": []}` returns `mismatch` equal to `["spec", "quality"]`.
7. [unit] `parseStoryReviewReply` of a `spec: "fail"` reply with one `{ severity: "important", kind: "spec" }` finding returns a verdict with no `mismatch` key.
8. [unit] `parseStoryReviewReply` of a `quality: "changes"` reply with one `{ severity: "important", kind: "spec" }` finding returns a verdict with no `mismatch` key.
9. [unit] `parseBranchReviewReply` of `{"spec": "fail", "quality": "approved", "findings": []}` returns exactly one finding, with `kind: "spec"` and `severity: "important"`.
10. [unit] `parseBranchReviewReply` of `{"spec": "fail", "quality": "approved", "findings": []}` returns a verdict with no `mismatch` key.
11. [unit] `parseBranchReviewReply` of `{"spec": "pass", "quality": "changes", "findings": []}` returns exactly one finding, with `kind: "quality"` and `severity: "important"`.
12. [unit] `parseBranchReviewReply` of `{"spec": "fail", "quality": "changes", "findings": []}` returns exactly one finding, with `kind: "spec"`.
13. [unit] `buildWorkflowVerdictMismatchRetry(["spec"])` imported from `@/prompts` returns text that includes `You returned spec: fail but no critical or important spec finding`.
14. [unit] `buildWorkflowVerdictMismatchRetry(["quality"])` returns text that includes `You returned quality: changes but no critical or important finding`.
15. [integration] `callOp(ctx, workflowStoryReviewOp, input)` against an agent whose first reply is `{"spec": "fail", "quality": "approved", "findings": []}` and whose second reply is `{"spec": "pass", "quality": "approved", "findings": []}` sends exactly two turns.
16. [integration] `callOp(ctx, workflowStoryReviewOp, input)` against that agent returns a verdict with `spec === "pass"`.
17. [integration] `callOp(ctx, workflowStoryReviewOp, input)` against an agent whose first reply is `{"spec": "fail", "quality": "approved", "findings": []}` sends a second turn whose prompt equals `buildWorkflowVerdictMismatchRetry(["spec"])`.
18. [integration] `callOp(ctx, workflowStoryReviewOp, input)` against an agent that replies `{"spec": "fail", "quality": "approved", "findings": []}` twice returns a verdict with `mismatch` equal to `["spec"]`.
19. [integration] `callOp(ctx, workflowStoryReviewOp, input)` against an agent whose first reply is not JSON and whose second reply is `{"spec": "fail", "quality": "approved", "findings": []}` sends exactly two turns.
20. [integration] `callOp(ctx, workflowStoryReviewOp, input)` against an agent whose first reply is not JSON and whose second reply is `{"spec": "fail", "quality": "approved", "findings": []}` returns a verdict with `mismatch` equal to `["spec"]`.
21. [integration] `callOp(ctx, workflowStoryReviewOp, input)` against an agent whose first reply is `{"spec": "fail", "quality": "approved", "findings": []}` and whose second reply is not JSON returns `null`.
22. [integration] `callOp(ctx, workflowStoryReviewOp, input)` against an agent whose first reply is not JSON sends a second turn whose prompt equals `buildWorkflowReviewJsonRetry()`.

### US-003

1. [unit] `runStoryLoop(env)` whose `steps.storyReview` resolves a verdict with `spec: "fail"`, `findings: []` and `mismatch: ["spec"]` over green gates never calls `steps.implement` with a turn of `kind: "fix"`.
2. [unit] `runStoryLoop(env)` whose `steps.storyReview` resolves a verdict with `findings: []` and `mismatch: ["spec"]` over green gates resolves with `state === "complete"`.
3. [unit] `runStoryLoop(env)` whose `steps.storyReview` resolves a verdict with `mismatch: ["spec"]` calls `sink.ledger` with `story review verdict inconsistent: spec fail without a blocking spec finding; findings kept`.
4. [unit] `runStoryLoop(env)` whose `steps.storyReview` resolves a verdict with `mismatch: ["quality"]` calls `sink.ledger` with `story review verdict inconsistent: quality changes without a blocking finding; findings kept`.
5. [unit] `runStoryLoop(env)` whose `steps.storyReview` resolves a verdict with `mismatch: ["spec"]` and whose `steps.modelFor("story-review")` returns `{ agentName: "native", model: "m1" }` calls `sink.update` with `verdictMismatch` equal to `{ kinds: ["spec"], model: "m1" }`.
6. [unit] `runStoryLoop(env)` whose `steps.storyReview` resolves a verdict with `mismatch: ["spec"]` and whose env has no `steps.modelFor` calls `sink.update` with `verdictMismatch` equal to `{ kinds: ["spec"] }`.
7. [unit] `runStoryLoop(env)` whose `steps.storyReview` resolves a verdict with `mismatch: ["spec"]` and one minor finding calls `sink.update` with `deferredMinors === 1`.
8. [unit] `runStoryLoop(env)` whose `steps.storyReview` resolves a verdict with `mismatch: ["spec"]` and one important `quality` finding runs a turn of `kind: "fix"` whose `findings` hold that one finding.
9. [unit] `buildWorkflowRunSummary` over a result with two story records carrying `verdictMismatch.model: "m1"` and one carrying `verdictMismatch.model: "m2"` returns `verdictMismatches` equal to `[{ model: "m1", count: 2 }, { model: "m2", count: 1 }]`.
10. [unit] `buildWorkflowRunSummary` over a result whose one mismatched story record has no `verdictMismatch.model` returns `verdictMismatches` equal to `[{ model: "unknown", count: 1 }]`.
11. [unit] `buildWorkflowRunSummary` over a result with no `verdictMismatch` on any story record returns a view with no `verdictMismatches` key.
12. [unit] `formatWorkflowSummary` of a view with `verdictMismatches: [{ model: "m1", count: 2 }, { model: "m2", count: 1 }]` returns text with the line `Inconsistent review verdicts: m1 2, m2 1`.

### US-004

1. [unit] `runStoryGates(sc)` whose `verifyScopedOp` output is `status: "timeout"` returns `timedOut` equal to `["scoped"]`.
2. [unit] `runStoryGates(sc)` whose `verifyScopedOp` output is `status: "failed"` returns a result with no `timedOut` key.
3. [unit] `runWorkflowSuiteGate(sc)` whose `fullSuiteGateOp` output is `status: "passed-on-timeout"` returns `timedOut` equal to `["full-suite"]`.
4. [unit] `runWorkflowSuiteGate(sc)` whose `fullSuiteGateOp` output is `status: "timeout"` returns `timedOut` equal to `["full-suite"]`.
5. [unit] `runWorkflowSuiteGate(sc)` whose `fullSuiteGateOp` output is `status: "failed"` returns a result with no `timedOut` key.
6. [unit] `gateTimeoutRoute` with `current.timedOut: ["scoped"]`, `previous.timedOut: ["scoped"]` and `baselineTimedOut: false` returns `{ gates: ["scoped"], why: "repeated" }`.
7. [unit] `gateTimeoutRoute` with `current.timedOut: ["scoped"]`, `previous: undefined` and `baselineTimedOut: true` returns `{ gates: ["scoped"], why: "baseline" }`.
8. [unit] `gateTimeoutRoute` with `current.timedOut: ["scoped"]`, `previous.timedOut: ["scoped"]` and `baselineTimedOut: true` returns `why === "baseline"`.
9. [unit] `gateTimeoutRoute` with `current.timedOut: ["scoped"]`, a previous pass with no `timedOut` and `baselineTimedOut: false` returns `null`.
10. [unit] `gateTimeoutRoute` with `current.timedOut: ["scoped"]`, `previousSuite.timedOut: ["full-suite"]`, a previous gates result with no `timedOut` and `baselineTimedOut: false` returns `null`.
11. [unit] `gateTimeoutRoute` with `currentSuite.timedOut: ["full-suite"]`, `previousSuite.timedOut: ["full-suite"]` and `baselineTimedOut: false` returns `{ gates: ["full-suite"], why: "repeated" }`.
12. [unit] `gateTimeoutRoute` with no `timedOut` on `current` or `currentSuite` and `baselineTimedOut: true` returns `null`.
13. [unit] `deriveEndState({ costStop: false, gates: { red: true, states: { scoped: "red" }, findings: [] }, timedOut: ["scoped"], rulings: 0 })` returns `reason === "gate timeout: scoped"`.
14. [unit] `deriveEndState` with red `lint` and red `scoped` gates and `timedOut: ["scoped"]` returns `reason === "red: lint, scoped"`.
15. [unit] `deriveEndState` with a red `scoped` gate and no `timedOut` returns `reason === "red: scoped"`.
16. [integration] the `steps.timeoutFacts` step that `buildStoryEnv` wires resolves `baselineTimedOut === true` when the feature's run baseline file holds `{ kind: "no-baseline", reason: "timeout" }`.
17. [integration] the `steps.timeoutFacts` step that `buildStoryEnv` wires resolves `baselineTimedOut === false` when the feature's run baseline file holds a `captured` baseline.
18. [integration] the `steps.timeoutFacts` step that `buildStoryEnv` wires resolves `limitSeconds === 120` when the config sets `execution.regressionGate.timeoutSeconds: 120`.

### US-005

In these criteria, "the two-timeout case" is `runStoryLoop(env)` whose `steps.gates` returns a red result with `timedOut: ["scoped"]` on the first and second pass and whose `steps.timeoutFacts` resolves `{ baselineTimedOut: false, limitSeconds: 600 }`. "The baseline case" is `runStoryLoop(env)` whose first pass returns a red gate result with `timedOut: ["scoped"]` and whose `steps.timeoutFacts` resolves `{ baselineTimedOut: true, limitSeconds: 600 }`.

1. [unit] The two-timeout case runs exactly one turn of `kind: "fix"`.
2. [unit] The two-timeout case calls `advisor.answerQuestion` exactly once.
3. [unit] The two-timeout case calls `advisor.answerQuestion` with `status === "GATE_TIMEOUT"`.
4. [unit] The two-timeout case calls `advisor.answerQuestion` with `timing` equal to `{ gates: ["scoped"], baselineTimedOut: false, repeated: true, limitSeconds: 600 }`.
5. [unit] The baseline case runs no turn of `kind: "fix"`.
6. [unit] The baseline case calls `advisor.answerQuestion` with `timing` equal to `{ gates: ["scoped"], baselineTimedOut: true, repeated: false, limitSeconds: 600 }`.
7. [unit] The baseline case calls `steps.timeoutFacts` exactly once.
8. [unit] `runStoryLoop(env)` whose passes never carry `timedOut` never calls `steps.timeoutFacts`.
9. [unit] The baseline case with `advisor.answerQuestion` resolving `null` resolves with `state === "complete-gate-open"`.
10. [unit] The baseline case calls `sink.ledger` with `gate timeout on scoped (baseline): no fix round, asked the advisor`.
11. [unit] The baseline case with `advisor.answerQuestion` resolving the string `raise the limit` calls `sink.ledger` with `gate timeout advice: raise the limit`.
12. [unit] The baseline case with `advisor.answerQuestion` resolving a string runs no turn of `kind: "answer"`.
13. [unit] The baseline case with `advisor.answerQuestion` rejecting resolves with `state === "complete-gate-open"`.
14. [unit] The baseline case with `advisor.answerQuestion` rejecting runs no turn of `kind: "fix"`.
15. [unit] `runStoryLoop(env)` with a first-pass `timedOut: ["scoped"]` and `steps.timeoutFacts` rejecting runs one turn of `kind: "fix"` before any `advisor.answerQuestion` call.
16. [unit] The two-timeout case with `steps.timeoutFacts` rejecting calls `advisor.answerQuestion` with `timing.repeated === true`.
17. [unit] The two-timeout case with `steps.timeoutFacts` rejecting calls `advisor.answerQuestion` with a `timing` that has no `limitSeconds` key.
18. [unit] The baseline case calls `steps.configFacts` with `["scoped"]`.
19. [unit] `runStoryLoop(env)` whose first pass has green gates and a red suite with `timedOut: ["full-suite"]`, with `steps.timeoutFacts` resolving `{ baselineTimedOut: true, limitSeconds: 600 }`, never calls `steps.configFacts`.
20. [unit] `runStoryLoop(env)` whose first pass has green gates and a suite with `timedOut: ["full-suite"]`, whose second pass has a red `lint` gate with no `timedOut`, and whose `steps.timeoutFacts` resolves `{ baselineTimedOut: false, limitSeconds: 600 }` never calls `advisor.answerQuestion` with `status: "GATE_TIMEOUT"`.
21. [unit] `runStoryLoop(env)` in that suite-timeout-then-red-lint case runs a second turn of `kind: "fix"`.
22. [unit] The two-timeout case whose fix turn replied `BLOCKED` never calls `sink.ledger` with a text that starts `fix round r1 blocked`.

### US-006

"The baseline case" is defined as in US-005: `runStoryLoop(env)` whose first pass returns a red gate result with `timedOut: ["scoped"]` and whose `steps.timeoutFacts` resolves `{ baselineTimedOut: true, limitSeconds: 600 }`.

1. [unit] The baseline case with `advisor.answerQuestion` resolving a config change that `steps.applyConfigChange` applies calls `steps.gates` a second time with no implementer turn between the two calls.
2. [unit] The baseline case with an applied config change, a green second gate run, a green suite and a clean review resolves with `state === "complete"`.
3. [unit] The baseline case with an applied config change and a second gate run that again carries `timedOut: ["scoped"]` calls `advisor.answerQuestion` exactly once in total.
4. [unit] The baseline case with an applied config change and a second gate run that again carries `timedOut: ["scoped"]` resolves with `reason === "gate timeout: scoped"`.
5. [unit] The baseline case with a config change that `steps.applyConfigChange` refuses resolves with `state === "complete-gate-open"`.
6. [unit] The baseline case with `advisor.answerQuestion` resolving `null` resolves with `reason === "gate timeout: scoped"`.
7. [unit] The baseline case with `advisor.answerQuestion` resolving `null` calls `sink.update` with `gateTimeouts` equal to `["scoped"]`.
8. [unit] `runStoryLoop(env)` that closes `complete` after green gates never calls `sink.update` with a `gateTimeouts` key.
9. [unit] `createLiveWorkflowAdvisor(input).answerQuestion` with `status: "GATE_TIMEOUT"`, `storyId: "US-003"` and `timing.gates: ["scoped"]` passes the advisor a draft whose `summary` equals `nax stopped the fix loop for US-003: the scoped gate timed out and another fix round cannot change a slow or hanging command.`
10. [unit] `createLiveWorkflowAdvisor(input).answerQuestion` with `status: "GATE_TIMEOUT"` and `timing: { gates: ["scoped"], baselineTimedOut: true, repeated: false, limitSeconds: 600 }` passes the advisor a draft whose first evidence item has `source === "gate"`.
11. [unit] `createLiveWorkflowAdvisor(input).answerQuestion` with that `timing` passes the advisor a draft whose first evidence item's text equals `Gate timeout facts: limit 600 s; run-start baseline timed out: yes; same gate timed out in the previous pass: no`.
12. [unit] `createLiveWorkflowAdvisor(input).answerQuestion` with `status: "GATE_TIMEOUT"` and `timing: { gates: ["scoped"], baselineTimedOut: false, repeated: true }` passes the advisor a draft whose first evidence item's text equals `Gate timeout facts: limit unknown; run-start baseline timed out: no; same gate timed out in the previous pass: yes`.
13. [unit] `buildWorkflowRunSummary` over a result whose story record `US-003` carries `gateTimeouts: ["scoped"]` returns a `stories` entry for `US-003` with `gateTimeouts` equal to `["scoped"]`.
14. [unit] `buildWorkflowRunSummary` over a result whose story record has no `gateTimeouts` returns a `stories` entry with no `gateTimeouts` key.
15. [unit] `formatWorkflowSummary` of a view whose `stories` hold `{ id: "US-003", gateTimeouts: ["scoped"] }` returns text with the line `Held on a gate timeout: US-003 (scoped)`.

### US-007

1. [unit] `parseBranchReviewReply` of a reply with `minorTriage: [{ id: "M1", decision: "promote" }]` and `minorIds: ["M1"]` returns `minorTriage` equal to `[{ id: "M1", decision: "promote" }]`.
2. [unit] `parseBranchReviewReply` of a reply with `minorTriage: [{ id: "M1", decision: "drop" }]` and `minorIds: ["M1"]` returns `minorTriage` equal to `[{ id: "M1", decision: "leave" }]`.
3. [unit] `buildWorkflowBranchReviewPrompt` returns text that includes the reply shape `"minorTriage": [{"id": "M1", "decision": "promote|fix-now|leave"}]`.
4. [unit] `buildWorkflowBranchReviewPrompt` returns text that includes `"promote" when it describes wrong behaviour a user or caller can reach`.
5. [unit] `buildWorkflowBranchReviewPrompt` returns text that includes `"leave" when it is style, comment wording, formatting or duplication that no project rule names`.
6. [unit] `branchReviewStep` over a record with minors `M1`, `M2`, `M3` (story `US-001`, texts `a`, `b`, `c`) and a verdict that has one important finding and triages them `promote`, `fix-now`, `leave` returns `patch.reviewOpen` with exactly two findings.
7. [unit] `branchReviewStep` in that case returns a second `patch.reviewOpen` finding equal to `{ id: "B2", kind: "quality", severity: "important", issue: "US-001: a" }`.
8. [unit] `branchReviewStep` in that case returns `patch.minors` whose `triage` values are `["promote", "fix-now", "leave"]`.
9. [unit] `branchReviewStep` in that case logs a `branch-review` step line that ends with `; deferred minors: 1 promote, 1 fix-now, 1 leave`.
10. [unit] `branchReviewStep` over a verdict that triages two minors `fix-now` and one `leave` logs a `branch-review` step line that ends with `; deferred minors: 2 fix-now, 1 leave`.
11. [unit] `branchReviewStep` over a verdict with `quality: "changes"`, no finding of its own and one minor triaged `promote` returns `patch.reviewOpen` holding exactly one finding, the promoted one.
12. [unit] `branchReviewStep` over a verdict with `quality: "changes"`, no finding of its own and no promoted minor returns `patch.reviewOpen` holding exactly one finding with the issue `quality: reviewer reported changes without a finding`.
13. [unit] `branchFixStep` on round 1 over a record with `reviewOpen: [B3]`, `gateFindings: [B1, B2]` and one `fix-now` minor `M1` calls `steps.branchFix` with ids in the order `["B3", "B1", "B2", "M1"]`.
14. [unit] `branchFixStep` on round 1 over a record whose minor `M1` has `triage: "promote"` and whose `reviewOpen` holds its finding `B2` calls `steps.branchFix` with exactly one item, id `B2`.
15. [unit] `buildWorkflowBranchFixPrompt` with one important finding `B1` and one minor finding `M1` returns text where the heading `## Findings to fix` and `B1` come before the heading `## Minor findings to fix after those` and `M1`.
16. [unit] `buildWorkflowBranchFixPrompt` with only important findings returns text with zero occurrences of the heading `## Minor findings to fix after those`.
17. [unit] `buildWorkflowBranchFixPrompt` returns text that includes `Fix the findings in the first list before the minor ones.`
18. [unit] `buildWorkflowRunSummary` over a feature record whose `minors` hold 2 `promote`, 3 `fix-now` and 4 `leave` items returns `branch.minors` equal to `{ found: 9, promoted: 2, fixNow: 3, left: 4 }`.
19. [unit] `buildWorkflowRunSummary` over a feature record with an empty `minors` list returns a `branch` with no `minors` key.
20. [unit] `buildWorkflowRunSummary` over a feature record whose `minors` hold 2 `promote` and 4 `leave` items and whose `newMinors` holds 1 item returns `branch.minorsLeft === 5`.
21. [unit] `formatWorkflowSummary` of a view with `branch.minors: { found: 9, promoted: 2, fixNow: 3, left: 4 }` returns text with the line `Deferred minors: 9 found, 2 promoted, 3 fix-now, 4 left`.

### US-008

1. [unit] `NaxConfigSchema.parse({}).workflow.review.parallelWithSuite` equals `false`.
2. [unit] `NaxConfigSchema.parse({ workflow: { review: { parallelWithSuite: true } } }).workflow.review.parallelWithSuite` equals `true`.
3. [unit] `WORKFLOW_REVIEW_DEFAULTS` equals `{ coverageRetries: 3, parallelWithSuite: false }`.
4. [unit] `FIELD_DESCRIPTIONS["workflow.review.parallelWithSuite"]` from `packages/nax/src/cli/config-descriptions.ts` is a non-empty string.
5. [unit] `FIELD_DESCRIPTIONS["workflow.review"]` includes the key name `parallelWithSuite`.
6. [integration] `buildStoryEnv` over a config with `workflow.review.parallelWithSuite: true` returns an `env` with `parallelReview === true`.
7. [integration] `buildStoryEnv` over a config whose `workflow` block has no `review` key returns an `env` with `parallelReview === false`.
8. [unit] `buildWorkflowStoryReviewPrompt` with green `lint`, `typecheck` and `scoped` gates and `suiteRunning: true` returns text with the line ending `scoped tests green, full suite still running.`
9. [unit] `buildWorkflowStoryReviewPrompt` with `suiteRunning: true` returns text that includes `The full suite is still running while you review; nax records its result itself, so do not list it under cannotVerify.`
10. [unit] `buildWorkflowStoryReviewPrompt` with no `suiteRunning` and no recorded `full-suite` state returns text with the gates line ending `full suite not run.`
11. [unit] `runStoryReview(sc, concerns, gates, { suiteRunning: true })` dispatches `workflowStoryReviewOp` with a prompt that includes `full suite still running`.
12. [integration] calling `steps.storyReview(concerns, gates, { suiteRunning: true })` on the `env` that `buildStoryEnv` returns dispatches `workflowStoryReviewOp` with a prompt that includes `full suite still running`.

### US-009

1. [unit] `runStoryLoop(env)` with `parallelReview: true`, green gates and a `steps.fullSuite` promise still pending has called `steps.storyReview` before that promise resolves.
2. [unit] `runStoryLoop(env)` with `parallelReview` unset, green gates and a `steps.fullSuite` promise still pending has not called `steps.storyReview` before that promise resolves.
3. [unit] `runStoryLoop(env)` with `parallelReview: true` calls `steps.storyReview` with a third argument equal to `{ suiteRunning: true }`.
4. [unit] `runStoryLoop(env)` with `parallelReview: true` calls `steps.storyReview` with a gates argument that has no `"full-suite"` key.
5. [unit] `runStoryLoop(env)` with `parallelReview: true`, a `DONE` first turn and `steps.reportExists` resolving `false` runs the turn of `kind: "report"` before the first `steps.fullSuite` call.
6. [unit] `runStoryLoop(env)` with `parallelReview: true` and a gate result carrying `suiteCovered: true` calls `steps.storyReview` with no third argument.
7. [unit] `runStoryLoop(env)` with `parallelReview: true` and a gate result carrying `suiteCovered: true` calls `steps.storyReview` with a gates argument whose `"full-suite"` value is `"green"`.
8. [unit] `runStoryLoop(env)` with `parallelReview: true`, a red suite on the first pass and a review verdict with one important finding runs a first turn of `kind: "fix"` whose `findings` hold the suite finding.
9. [unit] `runStoryLoop(env)` in that red-suite case runs a first turn of `kind: "fix"` whose `findings` hold the review finding.
10. [unit] `runStoryLoop(env)` with `parallelReview: true`, a green suite and a clean review resolves with `state === "complete"`.
11. [unit] `runStoryLoop(env)` with `parallelReview: true`, a green suite and a clean review calls `steps.fullSuite` exactly once.
12. [unit] `runStoryLoop(env)` with `parallelReview: true`, a green suite and a clean review calls `steps.storyReview` exactly once.
13. [unit] `runStoryLoop(env)` with `parallelReview: true`, on the pass after a fix round, has not called `steps.reReview` before that pass's `steps.fullSuite` promise resolves.
14. [unit] `runStoryLoop(env)` with `parallelReview: true` and a non-null `env.resume` whose `reviewed` is `false` has not called `steps.storyReview` before the `steps.fullSuite` promise resolves.
15. [unit] `runStoryLoop(env)` with `parallelReview: true` whose `steps.storyReview` rejects while `steps.fullSuite` is pending rejects only after the `steps.fullSuite` promise has settled.
16. [unit] `runStoryLoop(env)` with `parallelReview: true` whose `steps.fullSuite` rejects while `steps.storyReview` is pending rejects only after the `steps.storyReview` promise has settled.
17. [unit] `runStoryLoop(env)` with `parallelReview: true` whose `steps.storyReview` resolves `{ ran: false, why: "timeout" }` and whose suite is green resolves with `unreviewed === true`.
18. [unit] `runStoryLoop(env)` with `parallelReview: true` and an `env.now` that returns 0 before the two start, 100 when the review settles and 300 when the suite settles calls `sink.update` with `reviewOverlapMs === 100`.
19. [unit] `runStoryLoop(env)` with `parallelReview` unset never calls `sink.update` with a `reviewOverlapMs` key.
20. [unit] `buildWorkflowRunSummary` over a result whose two story records carry `reviewOverlapMs: 100` and `reviewOverlapMs: 200` returns `reviewOverlapMs === 300`.
21. [unit] `buildWorkflowRunSummary` over a result with no `reviewOverlapMs` on any story record returns a view with no `reviewOverlapMs` key.
22. [unit] `formatWorkflowSummary` of a view with `reviewOverlapMs: 300000` returns text with the line `Review overlap with the full suite: ` followed by the value of `formatDuration(300000)`.
