# SPEC: Workflow equivalence corpus (golden traces for the step-graph port)

## Summary

Add test-only golden traces of the two workflow-mode state machines, `runFeatureMachine`
(`src/workflow/feature-machine.ts`) and `runStoryLoop` (`src/workflow/story-loop.ts`). A trace is the
ordered list of everything a machine does to its environment during one run: every step call and its input,
every persisted record, every ledger line, every artifact, every workflow log line, and how the run ended.
A catalogue of scripted scenarios drives each machine through the paths real runs take, plus the paths the
machine must keep handling but real runs rarely reach. Each scenario's trace is stored as a JSON golden
file. A test drives the scenario again and fails on any difference. No production code changes.

## Motivation

The next phases replace the imperative loops in `feature-machine.ts` and `story-loop.ts` with a
declarative step graph. Workflow mode is nax's default execution mode, so the port must not change
behaviour: the same step order, the same ledger text, the same persisted records (a run started on the
old build must resume on the new one), and the same log lines. The existing unit tests assert selected
properties. None of them pins the whole interaction sequence, so a port could pass them and still
reorder ledger writes or drop a record update.

Recorded real runs cannot serve as the reference. A run's `result.json` keeps the final record and
per-step timings, not what each step returned, so there is nothing to replay. The real-run corpus does show
which paths happen. Across 73 workflow feature runs since v0.88.0, every run visited the full step
sequence:
- branch-fix rounds: 0 (21 runs), 1 (39), 2 (13);
- publish outcomes: draft (31) and ready;
- CI states: green, failed, pending, unavailable and conflicting;
- advisor rulings were recorded in 15 runs, and gate repair happened in 1;
- cost stop and abort never happened.

Story loops:
- most stories close in round 0;
- others take 1 to 5 fix rounds;
- some end `complete-with-rulings`.

The scenario catalogue below is chosen to cover those paths, plus the guarded paths no real run has reached.

## Design

### Approach

Golden-master (characterization) tests over the existing scripted harnesses. The trace is captured at
the machine's injection seams, so it records behaviour and not implementation: for the feature machine,
`FeatureEnv.steps` (`FeatureSteps`) and `FeatureEnv.sink` (`FeatureSink`); for the story loop,
`StoryLoopEnv.steps` (`StoryLoopSteps`), `StoryLoopEnv.sink` (`StoryLoopSink`) and `StoryLoopEnv.advisor`
(`WorkflowAdvisor`). Log lines are captured through the logger's `addSink`, as
`test/unit/workflow/feature-machine-log.test.ts` already does. A later graph engine that keeps these seams
and these interactions reproduces the trace byte for byte.

### Integration

Read-only symbols (verified on `main` @ `4c3ad20ee`; no symbol below is changed by this spec):

- `runFeatureMachine(env: FeatureEnv): Promise<WorkflowFeatureRecord>` and the `FeatureEnv`, `FeatureSteps`,
  `FeatureSink`, `FeatureFacts`, `FeatureLimits` types — `src/workflow/feature-machine.ts`. An aborted run
  throws `NaxError` with code `WORKFLOW_ABORTED`.
- `runStoryLoop(env: StoryLoopEnv): Promise<StoryLoopOutcome>` and `StoryLoopEnv`, `StoryLoopSteps`,
  `StoryLoopSink`, `WARM_ROUND_CAP` (3) — `src/workflow/story-loop.ts`.
- `WorkflowAdvisor`, `defaultWorkflowAdvisor` — `src/workflow/advisor.ts`.
- `newFeatureRecord` — `src/workflow/feature-record.ts`; `newStoryRecord` — `src/workflow/result.ts`.
- `FeatureStep`, `WorkflowEndState` (`complete | complete-with-rulings | complete-gate-open`),
  `WorkflowFeatureRecord`, `WorkflowStoryRecord` — `src/workflow/types.ts`. `ImplementTurn` kinds
  (`implement`, `fix`, `answer`, `restart`) — `src/workflow/implement.ts`.
- `startStep` — `src/workflow/run-log.ts`. Its `done` line is `<label><joiner><text>  <formatDuration(durationMs)>`
  with `data.durationMs`, timed by `Date.now` unless `options.now` is given. The feature machine's
  `featureStep` passes no `now`, so these durations are wall-clock and must be normalized.
- `addSink`, `initLogger`, `resetLogger`, `LogEntry` — `@/logger`; `formatDuration` — `@/log-format`.
- Existing harness `makeFeatureMachineHarness(script, over)` and `featureMachineFixtures` —
  `test/helpers/workflow-feature-machine.ts`, exported from `test/helpers/index.ts`. Its `env.now` is a
  deterministic counter (+5 per call), its `head()` returns `h<callCount>`.
- Workflow config defaults: `maxBranchFixRounds` 2, `finalGateRepairRounds` 1
  (`src/config/schemas-workflow.ts`).

### Trace format

A trace is a JSON object `{ scenario, machine, events, end }`:

- `machine` is `"feature"` or `"story"`.
- `events` is an array in the order the events happened. Each event is one of:
  - `{ "kind": "call", "method": <seam method name>, "args": [...] }`: a call into `steps` or `advisor`;
  - `{ "kind": "return", "method": ..., "value": ... }`: what that call returned;
  - `{ "kind": "step", "step": <FeatureStep> }`: a `FeatureSink.step` call;
  - `{ "kind": "update", "record": ... }`: a `FeatureSink.update` record, or a `StoryLoopSink.update` patch;
  - `{ "kind": "ledger", "text": ..., "options": ... }`;
  - `{ "kind": "artifact", "name": ..., "value": ... }`;
  - `{ "kind": "log", "level": ..., "message": ..., "data": ... }`.
- `end` is `{ "returned": <value> }` or `{ "threw": { "code": <NaxError code, or null>, "message": <message> } }`.

Only log entries with `stage: "workflow"` are recorded. Only seam methods the harness actually provides are
wrapped: an optional method the harness leaves out (`FeatureSteps.modelFor`, `FeatureSteps.flaggedDecisions`,
`StoryLoopSteps.modelFor`, `StoryLoopSteps.workProduced`) stays absent, because the machines branch on
whether it exists.

Normalization, applied before serializing and before comparing:

1. A log entry whose `data.durationMs` is a number has the suffix `formatDuration(data.durationMs)` at the
   end of its `message` replaced with `<dur>`, and `data.durationMs` replaced with `0`. No other text changes.
2. Object keys are serialized in sorted order. Arrays keep their order.
3. `undefined` object values are omitted, matching `JSON.stringify`.
4. Any object key named `endedAt` whose value is a string, at any depth, has that value replaced with
   `"<ts>"`. Both machines stamp it from the wall clock (`publishStep` in `feature-machine.ts`, `closeLoop` in
   `story-loop.ts`, via `new Date().toISOString()`), and G0 changes no production code to inject a clock.

Golden files live at `packages/nax/test/fixtures/workflow-equivalence/<machine>/<scenario>.json`,
pretty-printed with two-space indent and a trailing newline.

### Golden lifecycle

- Signature: `compareWithGolden(trace, options?: { root?: string })`. `root` defaults to
  `packages/nax/test/fixtures/workflow-equivalence/`; the recorder's own tests pass a temp directory.
- `compareWithGolden(trace)` reads the golden file for `trace.machine` / `trace.scenario`. A missing golden
  fails the test with a message that names the file and the regeneration variable. It never creates the file.
- Only when the environment variable `NAX_UPDATE_WORKFLOW_GOLDEN` is `"1"`, `compareWithGolden` writes the
  trace to the golden path instead of comparing.
- On a mismatch, the failure message names the scenario, the index of the first differing event, and both
  versions of that event. When one `events` list is a prefix of the other, the index is the shorter length and
  the missing side is shown as `(none)`. When the events are equal and only `end` differs, the message says
  `end differs` and shows both.
- The implementer generates the goldens from the current code (`main`), by running the equivalence tests
  once with the variable set, and commits them. They are the reference the step-graph port is held to.

### Fixture content (public repo)

nax is a public repository. Scenario scripts and goldens use synthetic content only: story ids `US-00N`,
finding text like `"issue one"`, fake SHAs like `h3`, the harness URL `https://gh/pr/1`. No content is
copied from real run artifacts.

### Failure Handling

| Situation | Behaviour |
|---|---|
| Golden file missing | Test fails: `golden missing: <path> (set NAX_UPDATE_WORKFLOW_GOLDEN=1 to create it)`. |
| Trace differs from golden | Test fails, naming scenario, first differing event index, expected and actual event. |
| Machine throws an error with no `code` | Recorded as `{ "threw": { "code": null, "message": ... } }`, never rethrown out of the recorder. |

## Out of Scope

- Any change under `packages/nax/src/`: G0 is test-only; the step-graph engine and the ports are later phases.
- Replaying recorded real runs: run artifacts do not keep per-step results, so the catalogue is synthetic.
- Copying any content from real run artifacts or private repositories into fixtures.
- Migrating the existing `feature-machine*.test.ts` and `story-loop*.test.ts` files onto the new trace helpers, including replacing the inline story harness in `story-loop.test.ts` with the US-003 factory (the duplication is accepted for G0).
- The pipeline-mode loop and the deprecated `src/finish/` phase: pipeline mode is frozen.
- The feature-level code around the machines (`buildFeatureEnv`, `runWorkflowFeature`, `workflowStage`, `finalize.ts`, `publish`): the ports keep these seams; they are covered by their own tests.
- A CI job or script that regenerates goldens: regeneration is a deliberate manual step through `NAX_UPDATE_WORKFLOW_GOLDEN=1`.

## Stories

### US-001: Trace recorder and golden lifecycle
No dependencies. Workdir: packages/nax.

Adds the shared trace recorder `test/helpers/workflow-trace.ts`: `recordFeatureTrace`, `normalizeTrace` and
`compareWithGolden`, with the normalization rules and golden lifecycle in Design. Its own tests live in
`test/unit/workflow/feature-machine-equivalence-recorder.test.ts` and drive `makeFeatureMachineHarness` with
small scripts. They write golden files only to a temp directory, never to the committed fixture tree.
`compareWithGolden` therefore accepts an optional fixtures root, defaulting to
`test/fixtures/workflow-equivalence/`.

### US-002: Feature-machine golden scenarios
Depends on US-001. Workdir: packages/nax.

Adds the feature-machine scenario catalogue `test/unit/workflow/feature-machine-equivalence.test.ts` (split by describe
block into `feature-machine-equivalence-<concern>.test.ts` files if it would pass the 650-line test-file target), built on
`makeFeatureMachineHarness` and the US-001 recorder. Commits one golden per scenario under
`test/fixtures/workflow-equivalence/feature/`, generated from the current `runFeatureMachine`.

### US-003: Story-loop golden scenarios
Depends on US-001. Workdir: packages/nax.

Adds a shared scripted story-loop harness factory in `test/helpers/workflow-story-loop.ts`, in the style of
`makeFeatureMachineHarness`, and `recordStoryTrace` in `test/helpers/workflow-story-trace.ts`, which reuses US-001's
`normalizeTrace` and `compareWithGolden`. Adds the story-loop scenario
catalogue `test/unit/workflow/story-loop-equivalence.test.ts`. Commits one golden per scenario under
`test/fixtures/workflow-equivalence/story/`, generated from the current `runStoryLoop`.

### Context Files

**US-001**
- `packages/nax/test/helpers/workflow-feature-machine.ts`
- `packages/nax/src/workflow/feature-machine.ts`
- `packages/nax/test/unit/workflow/feature-machine-log.test.ts`
- `packages/nax/src/workflow/run-log.ts`
- `packages/nax/test/helpers/temp.ts`

**US-002**
- `packages/nax/test/helpers/workflow-trace.ts` — created by US-001, used here
- `packages/nax/test/helpers/workflow-feature-machine.ts`
- `packages/nax/src/workflow/feature-machine.ts`
- `packages/nax/src/workflow/types.ts`
- `packages/nax/test/unit/workflow/feature-machine-fix-rounds.test.ts`

**US-003**
- `packages/nax/test/helpers/workflow-trace.ts` — created by US-001, used here
- `packages/nax/src/workflow/story-loop.ts`
- `packages/nax/test/unit/workflow/story-loop.test.ts`
- `packages/nax/src/workflow/implement.ts`
- `packages/nax/src/workflow/advisor.ts`

### Creates

Each scenario commits one golden `<scenario>.json`; one file per story is listed below as the directory marker.


**US-001**
- `packages/nax/test/helpers/workflow-trace.ts`
- `packages/nax/test/unit/workflow/feature-machine-equivalence-recorder.test.ts`

**US-002**
- `packages/nax/test/unit/workflow/feature-machine-equivalence.test.ts`
- `packages/nax/test/fixtures/workflow-equivalence/feature/clean-pass.json`

**US-003**
- `packages/nax/test/helpers/workflow-story-loop.ts`
- `packages/nax/test/helpers/workflow-story-trace.ts`
- `packages/nax/test/unit/workflow/story-loop-equivalence.test.ts`
- `packages/nax/test/fixtures/workflow-equivalence/story/clean.json`

### Modifies

**US-001**
- `packages/nax/test/helpers/index.ts` — add exports for `recordFeatureTrace`, `normalizeTrace`, `compareWithGolden` and their types; existing exports are unchanged.

**US-002**
None. US-002 adds new test and fixture files only; it reuses `makeFeatureMachineHarness` unchanged.

**US-003**
- `packages/nax/test/helpers/index.ts` — add exports for the story-loop harness factory, its script type, and `recordStoryTrace`; existing exports are unchanged.

### Seams

- US-002 and US-003 call `compareWithGolden` and `normalizeTrace` from US-001's `test/helpers/workflow-trace.ts`. A story golden mismatch fails with the same message shape as a feature one.

## Acceptance Criteria

### US-001

1. [unit] `recordFeatureTrace(scenarioName, harness)` runs `runFeatureMachine` on the harness `env` and returns a trace whose `machine` is `"feature"` and whose `events` list, in call order, one `call` event and one `return` event for every `FeatureSteps` method invocation, with the method name and its arguments; a `FeatureSteps` method the harness does not provide stays absent on the wrapped env.
2. [unit] In a trace from `recordFeatureTrace`, every `FeatureSink.step`, `FeatureSink.update`, `FeatureSink.ledger` and `FeatureSink.artifact` call appears as a `step`, `update`, `ledger` or `artifact` event, at its position relative to the step calls.
3. [unit] A `stage: "workflow"` log entry emitted during `runFeatureMachine` appears in the trace as a `log` event with its level, message and data, and a log entry with any other stage does not appear.
4. [unit] When `runFeatureMachine` returns, the trace's `end` is `{ returned: <the returned record> }`; when it throws a `NaxError`, `end` is `{ threw: { code, message } }` and `recordFeatureTrace` itself resolves rather than rejecting.
5. [unit] When a scripted step throws a plain `Error` with message `"boom"`, the trace's `end` is `{ threw: { code: null, message: "boom" } }` and `recordFeatureTrace` resolves.
6. [unit] `normalizeTrace` replaces the string value of every `endedAt` key, at any depth of an event or of `end`, with `"<ts>"`, and leaves other string values unchanged.
7. [unit] `normalizeTrace` replaces the trailing `formatDuration(data.durationMs)` text of a log message with `<dur>` and sets `data.durationMs` to `0`, and leaves a log message without numeric `data.durationMs` unchanged.
8. [unit] `normalizeTrace` serializes object keys in sorted order, so two traces that differ only in key insertion order serialize to identical text.
9. [unit] Calling `recordFeatureTrace` twice on two freshly built harnesses from the same script yields serialized traces that are identical.
10. [unit] `compareWithGolden(trace, { root })` with no golden file present, and `NAX_UPDATE_WORKFLOW_GOLDEN` unset, throws an error whose message contains the expected golden path and the text `NAX_UPDATE_WORKFLOW_GOLDEN=1`, and no file is created.
11. [unit] `compareWithGolden(trace, { root })` with `NAX_UPDATE_WORKFLOW_GOLDEN` set to `"1"` writes the normalized trace to `<fixtures root>/feature/<scenario>.json` with two-space indent and a trailing newline.
12. [unit] `compareWithGolden(trace, { root })` against a golden that differs at one event throws an error naming the scenario, the index of the first differing event, and the expected and actual event.
13. [unit] `compareWithGolden(trace, { root })` against a golden whose `events` equal the trace's but whose `end` differs throws an error containing `end differs`.

### US-002

Feature scenarios (each drives `makeFeatureMachineHarness` with the stated script, then `compareWithGolden`; each also asserts the property named, so a scenario cannot silently stop exercising its path):

1. [unit] `clean-pass`: green repo gates, review `spec: pass` with no findings, publish `ready`. The trace's `step` events are exactly `repo-gates`, `branch-review`, `branch-fix`, `branch-rereview`, `adjudicate`, `final-gates`, `publish`, `done`, and no `branchFix` call occurs.
2. [unit] `one-fix-round`: review with two `important` findings and one `minor`, re-review marks both addressed. Exactly one `branchFix` call, whose argument holds the two important findings.
3. [unit] `two-fix-rounds`: review with one `important` finding, the first re-review leaves it not addressed, the second addresses it, with `maxBranchFixRounds` 2. Exactly two `branchFix` calls.
4. [unit] `residual-adjudicated`: review with one `important` finding never addressed across the round cap. An `adjudicate` call occurs with that finding, and the publish step still runs.
5. [unit] `repo-gates-red`: the first repo-gates run returns a failing `lint` with one gate finding. The first `branchFix` call's argument includes that gate finding, and a ledger event's text contains `repo gates red: lint`.
6. [unit] `final-gates-repair`: the three gate runs are green, then red with one gate finding, then green, with one fix round between the first two. The `step` events include `gate-repair`.
7. [unit] `review-not-ran`: `branchReview` returns `{ ran: false }`. The final record has `reviewRan` false, and a ledger event records the skipped review.
8. [unit] `rereview-timeout`: the review returns one `important` finding, and the re-review returns `{ ran: false, why: "timeout" }`. The final record has `reReviewSkipped` true.
9. [unit] `cost-stop-before-review`: `costExceeded` is true from the first agent step. No `branchReview` call occurs, the final record has `costLimited` true, and the publish step runs.
10. [unit] `cost-stop-before-fix`: the review returns one `important` finding, and `costExceeded` turns true once the `branchReview` call has happened. No `branchFix` call occurs, and the final record has `costLimited` true.
11. [unit] `aborted`: `aborted` is true from the start. The trace has no `call` events and its `end` is a throw with code `WORKFLOW_ABORTED`.
12. [unit] `resume-at-rereview`: the harness starts from a record whose `step` is `branch-rereview`, with one open `important` finding, a `fixBase`, `fixRan` true and `fixRounds` 1. The first `step` event is `branch-rereview`, no `branchReview` call occurs, and the only `repoGates` call comes after the `branchReReview` call (the `final-gates` step, which re-runs the gates because `fixRan` is true).
13. [unit] `publish-draft-ci-failed`: publish returns `outcome: "draft"` with `ci: "failed"`. The final record's `outcome` is `draft` and its `ci` is `failed`.
14. [unit] `publish-local-only`: publish returns `outcome: "local-only"`. The final record's `outcome` is `local-only`.
15. [unit] `branch-review-empty-seed`: the harness record has an empty `seed`. No `branchReview` call occurs, and a ledger event records the review skipped for no seed.
16. [unit] `branch-fix-session-failed`: the review returns one `important` finding, and `branchFix` returns `failure: "crashed"` with `autoCommitted` true and `dirty` true. Ledger events record the failed session, the auto-commit and the uncommitted edits.
17. [unit] `head-unreadable`: the review returns one `important` finding, and every `head()` call throws. The scenario passes the harness to `recordFeatureTrace` with `env.steps.head` replaced by a function that throws `new Error("git")` (spread over the harness `env`; the harness file is not edited), so the later HEAD reads also log their warnings into the golden. No `branchFix` call occurs, and a ledger event records `branch fix skipped: HEAD could not be read`.
18. [unit] `fix-now-minor`: the record carries one deferred minor, and the review triages it `fix-now` with no blocking finding. The first `branchFix` call's argument includes that minor.
19. [unit] `quality-floor`: the review returns `quality: "changes"` with only a `minor` finding. A `branchFix` call occurs, and its argument includes a finding whose issue is `quality: reviewer reported changes without a finding`.

### US-003

Harness and recorder:

1. [unit] The story-loop harness factory in `test/helpers/workflow-story-loop.ts` builds a `StoryLoopEnv` from a script of queued gate results, full-suite results, story-review verdicts (or `null` for not ran), re-review addressed flags, and an implement function. With an empty script, `runStoryLoop` on it returns state `complete` with `rounds` 0.
2. [unit] `recordStoryTrace(scenarioName, harness)` runs `runStoryLoop` and returns a trace with `machine` `"story"`. Every `StoryLoopSteps` and `WorkflowAdvisor` invocation appears as `call` and `return` events, every `StoryLoopSink.update` and `StoryLoopSink.ledger` call as an `update` or `ledger` event, and every `stage: "workflow"` log line as a `log` event, in order (the sink wrappers are closures that do not rely on `this`, because the loop passes `env.sink.ledger` unbound to `adjudicateResidual`); a `StoryLoopSteps` method the harness does not provide stays absent on the wrapped env.
3. [unit] For a story trace, `compareWithGolden` reads and writes under `test/fixtures/workflow-equivalence/story/`, and a mismatch fails with the same message shape as a feature trace (scenario name, first differing index, expected and actual event).
4. [unit] Two `recordStoryTrace` runs from the same script on fresh harnesses serialize identically, including the final `update` patch's `endedAt`, which reads `"<ts>"`.
5. [unit] When a scripted story step throws a plain `Error` with message `"boom"`, the story trace's `end` is `{ threw: { code: null, message: "boom" } }` and `recordStoryTrace` resolves.

Story scenarios (each runs through `compareWithGolden` and asserts the property named):

6. [unit] `clean`: green gates, passing review. The outcome is `complete` with `rounds` 0, and exactly one `implement` call, of kind `implement`.
7. [unit] `red-gates-then-green`: the first gate run has a red `lint` with one gate finding, the second is green. An implement call of kind `fix` occurs before the story review.
8. [unit] `review-fail-one-round`: the first review fails with one `important` finding, and the re-review addresses it. The outcome is `complete` with `rounds` 1.
9. [unit] `fresh-after-warm-cap`: four failing reviews, then a pass, with `maxFixRounds` 5. The `fix` turns of rounds 1 to 3 carry `fresh: false`, and the round-4 `fix` turn carries `fresh: true`.
10. [unit] `residual-rulings`: reviews keep failing past `maxFixRounds`, and the advisor's `ruleResidual` rules the open finding. The outcome is `complete-with-rulings`, and a `ruleResidual` call appears in the trace.
11. [unit] `needs-context-answered`: the implementer replies `NEEDS_CONTEXT` once, and the advisor answers `"try X"`. An implement call of kind `answer` with text `"try X"` follows.
12. [unit] `review-not-ran`: `storyReview` returns `{ ran: false }`. The outcome's `unreviewed` is true.
13. [unit] `full-suite-red`: the full suite returns red with one gate finding, every time. The outcome state is `complete-gate-open`.
14. [unit] `cost-exceeded`: `costExceeded` returns true from the start. Exactly one implement call (kind `implement`) occurs, no `gates` call occurs, and the outcome is `complete-gate-open` with reason `cost-limit`.
15. [unit] `no-work-restart`: the first implement reply has `noStatusBlock: true` and `workProduced` returns false once, then the warm restart's reply is a normal `DONE`. An implement call of kind `restart` with `fresh: false` follows the first turn, and the outcome is `complete`.
16. [unit] `resume-mid-fix`: with `maxFixRounds` 5, the harness resumes from a record with `round` 2, `reviewed` true, one open finding of kind `spec`, and a `fixBase`, with green gates. No implement call of kind `implement` occurs, and the first agent call is `reReview` with round 2.
17. [unit] `rereview-new-finding`: the re-review addresses the open finding and adds one new `important` finding, which a later round addresses. The trace's re-review return lists the new finding, and a later `fix` turn includes it.
