# SPEC: Acceptance integrity

## Summary

One causal chain, observed in a single real run, in which the acceptance pipeline
misreports its own integrity. A provider stalled mid-stream; the failure was recorded as
"the agent produced no test content", a 30-test skeleton of guaranteed-red assertions was
written and committed in its place, each regeneration attempt over that skeleton was logged
as a success, and the run finished reporting `status: "completed"` with 5/5 stories passed
while every acceptance criterion was red. Four stories restore the signal at each link: the
infra failure survives to the stage that decides, the stage stops substituting a skeleton
for a call that never happened, regeneration stops calling a stub a success, and the run's
top-level status file carries a gate summary a reader sees before `postRun`.

## Motivation

Fixes #1872, #1871 and #1873 — three issues filed from one run, each a different link in
the same chain.

- **#1872** — `acceptance-setup` branches only on `testCode` being falsy, so "the model
  replied with prose instead of writing a file" and "the provider dropped the stream and
  returned nothing" arrive identically. The stage log an operator reads says `agent did not
  produce test content; using skeleton`, which names a model-quality problem; the truth
  (`Upstream idle timeout exceeded`, `respLen 0`) appears only in an unrelated middleware
  line 4 ms earlier and in the prompt-audit ledger, correlatable only by `callId`. The
  consequence is not cosmetic: the skeleton is thirty `expect(true).toBe(false)`
  assertions, so a recoverable infrastructure blip is converted into a guaranteed-red gate,
  the acceptance loop then spends its whole retry budget re-running a generator that is
  failing for infrastructure reasons, and the stub is committed to the feature branch by
  the stage's own auto-commit.

- **#1871** — `regenerateAcceptanceTest` decides success by checking only that a file
  exists at the target path, and the skeleton fallback guarantees one. So a regeneration
  that produced nothing but stubs logs `Acceptance test regenerated successfully`, and the
  caller learns the truth one full iteration later, when the loop's own stub check fires
  (`Stub test detected — full regen`). In the observed run that cost all three generation
  attempts — one of them an 18-minute agent session — before `MAX_STUB_REGENS` stopped it.

- **#1873** — `run.status` and `progress` are what a human and any wrapper tooling read
  first, and they are derived from story completion alone. The observed `status.json` reads
  `run.status: "completed"`, `progress: 5 passed / 0 failed`, with
  `postRun.acceptance.status: "failed"` and all thirty ACs listed as failed one level down.
  Nothing surfaces the gate outcome upward, so a run with no working acceptance gate is
  indistinguishable at a glance from one that passed.

## Design

Four stories. US-002 depends on US-001 — US-001 produces the failure signal and nothing
consumes it until US-002 does. US-003 and US-004 are independent of every other story and
of each other.

### Integration

Symbols this feature **changes**. The baseline is stated only to locate the code; it is
never the interface to implement.

**`runSelfHealChain`** — `src/operations/self-heal.ts:58` (US-001)
- Baseline: returns `{ ...last, estimatedCostUsd: totalCost }`, where `last` is the most
  recent corrective turn, or the seed turn when no step fired. A corrective turn therefore
  replaces the seed wholesale, discarding any `adapterFailure` the seed carried.
- Target: the same, except a seed `adapterFailure` is carried onto the returned turn when
  the seed had one and the turn that replaced it did not. A corrective turn that carries
  its own `adapterFailure` keeps its own. This is the link that loses the signal today:
  `acceptanceGenerateOp.hopBody` always runs a path-correction self-heal step after the
  generation turn, so a stalled generation turn's failure is dropped by the corrective turn
  that follows it.

**`AcceptanceGenerateOutput`** — `src/operations/acceptance-generate.ts:17` (US-001, US-002)
- Baseline: `{ testCode: string | null }`.
- Target: the same, plus an optional `adapterFailure` of type `AdapterFailure`, absent
  unless the dispatch that produced the output failed.

**`callOp` run branch** — `src/operations/call.ts:509` (US-001)
- Baseline: the successful run path ends `return await runPostParse(op, parsedRun, input,
  buildCtx)`. The run outcome's `adapterFailure` is read by nothing after
  `recordAgentFallbacks`, so a parsed-but-empty result reaches the caller with no trace of
  the transport failure that produced it.
- Target: the same parsed value, carrying the run outcome's `adapterFailure` when the
  outcome has one and the parsed value does not already carry its own. A parsed value that
  is not a non-null object is returned unchanged. This mirrors the precedent one screen
  above, where the exhausted-fallback branches return `{ ...retryFallback, estimatedCostUsd:
  totalCost }` — producer metadata attached to the operation's own output object.

**`acceptanceSetupStage.execute` generation branch** — `src/pipeline/stages/acceptance-setup.ts:379` (US-002)
- Baseline: two-way. A truthy `testCode` is written to `testPath`; anything else writes
  `generateSkeletonTests(...)` there and warns `"agent did not produce test content; using
  skeleton"` with `storyId` and `testPath`.
- Target: three-way. A truthy `testCode` is written, unchanged. A falsy `testCode`
  accompanied by an `adapterFailure` writes **nothing** at `testPath` — no skeleton — and
  warns with a message distinct from the skeleton one, carrying the failure's `outcome` and
  `message` alongside `storyId` and `testPath`. A falsy `testCode` with no `adapterFailure`
  keeps today's skeleton behaviour exactly.

**`regenerateAcceptanceTest`** — `src/execution/lifecycle/acceptance-helpers.ts:165` (US-003)
- Baseline: after re-running the acceptance-setup stage it returns `false` only when no
  file exists at `testPath`, and otherwise logs `Acceptance test regenerated successfully`
  and returns `true`.
- Target: the same missing-file branch, plus a second rejection: when the file exists but
  its content is stub content, the function logs at error level with a message distinct
  from the missing-file one and returns `false`. Real regenerated content is unaffected.

**`NaxStatusFile`** — `src/execution/status-file.ts:94` (US-004)
- Baseline: `version`, `run`, `progress`, `cost`, `current`, `iterations`, `updatedAt`,
  `durationMs`, and optional `lastHeartbeat`, `parallel` and `postRun`.
- Target: the same, plus an optional top-level `gates` carrying an `acceptance` and a
  `regression` field, each a `PostRunPhaseStatus`. Optional for the same reason `postRun`
  is: a status file written before this feature has no such key and must still type-check
  on read.

**`buildStatusSnapshot`** — `src/execution/status-file.ts:293` (US-004)
- Baseline: copies `state.postRun` onto the snapshot when present and emits no top-level
  gate summary.
- Target: the same, and when `state.postRun` is present it additionally emits `gates`,
  mirroring `postRun.acceptance.status` and `postRun.regression.status` — except that
  `gates.acceptance` is `"failed"` whenever `postRun.acceptance.skippedPackages` is
  non-empty, which is the rule the `AcceptancePhaseStatus.skippedPackages` doc comment
  already states and nothing enforces.

Symbols this feature only **reads**:

- `isStubTestFile(content: string): boolean` — `src/execution/lifecycle/acceptance-helpers.ts:20`,
  the stub predicate already used by the acceptance loop one iteration after
  `regenerateAcceptanceTest` returns its false success.
- `AdapterFailure` — `src/context/engine/types.ts:22`; a required `category` of
  `"availability"` or `"quality"`, a required `outcome` code (`fail-service-down`,
  `fail-timeout`, `fail-stale`, …), a required `message` and a required `retriable`, plus
  optional `retryAfterSeconds` and `reason`. Every literal constructed in a test must carry
  all four required fields.
- `PostRunPhaseStatus` — `src/execution/status-file.ts:19`; `"not-run" | "running" |
  "passed" | "failed" | "skipped"`.
- The missing-target path in `src/pipeline/stages/acceptance.ts:187-205`, which records a
  package in `missingTargets` when its acceptance test file is absent and the package has
  stories with acceptance enabled. This is the existing seam US-002's "write nothing"
  branch routes into, so an infra failure surfaces as one honest missing target rather than
  thirty fabricated red criteria.

### Approach

**Why the failure is made sticky rather than re-derived (US-001).** The stage cannot ask
whether the dispatch failed — by the time it sees `{ testCode: null }` the turn is gone.
The signal exists exactly once, on the turn the adapter failed, and is destroyed at a
single known point: `runSelfHealChain` returns the corrective turn in place of the seed.
Making the seed's failure survive that replacement is a two-line change at the point of
loss, and it is the only point of loss on this path — no second predicate is introduced
anywhere, and no caller learns to guess.

**Size budget on `src/operations/call.ts` (US-001).** The file is 563 lines against the
project's 600-line hard limit for source files, so the attachment is a small module-private
helper at the run branch's tail, not an inlined block. If the change cannot fit in that
headroom, the helper belongs in `src/operations/post-parse.ts`, which was split out of
`call.ts` for exactly this reason.

**Why the stage writes nothing rather than retrying (US-002).** A skeleton is a reasonable
answer to "the model wrote something unusable" and the wrong answer to "the call never
happened", because it converts a recoverable blip into a guaranteed-red gate and a
committed stub. Retrying or swapping the agent is a manager-tier concern that was settled
in #1869 and #1870 and is tracked further in #1884; this story does not add a retry. It
removes the fabrication, and lets the pre-existing missing-target path report the truth.

**Why `gates` is derived in `buildStatusSnapshot` (US-004).** That function is the single
place every status file is produced — the periodic run status and the end-of-run feature
status both go through it — so a summary derived there cannot disagree with the `postRun`
it summarises, and no call site has to remember to set it. `run.status` keeps its current
meaning ("the run reached its end without crashing"), so nothing that switches on it
changes behaviour.

### Failure Handling

| Condition | Behaviour | Owning story |
|:---|:---|:---|
| Self-heal seed carries no `adapterFailure` | The returned turn carries none; today's behaviour is unchanged | US-001 |
| Both the seed and its corrective turn carry an `adapterFailure` | The corrective turn's own failure is kept — the later failure describes the turn that produced the returned output | US-001 |
| Run outcome carries an `adapterFailure` but the parsed value already has one | The parsed value's own is kept; the operation's own classification outranks the transport's | US-001 |
| Run outcome carries an `adapterFailure` and the parsed value is not a non-null object | The parsed value is returned unchanged; there is nowhere to attach the field | US-001 |
| Generation returns no test code and no `adapterFailure` | The skeleton is written and the existing warning is emitted — the model-quality path is unchanged | US-002 |
| Generation returns no test code with an `adapterFailure`, and a file already exists at `testPath` | The existing file is left as it is; the branch writes nothing, it does not delete | US-002 |
| Regenerated file is missing entirely | The existing missing-file error and `false` return are unchanged | US-003 |
| `postRun` is absent from the run state | No `gates` key is emitted, matching how `postRun` itself is omitted | US-004 |
| `postRun.acceptance.skippedPackages` is non-empty while its `status` says `"passed"` | `gates.acceptance` is `"failed"` — a missing acceptance target is not a pass | US-004 |

## Out of Scope

- Retrying or swapping the agent when acceptance generation fails to dispatch is out of
  scope. Manager-tier retry was settled in #1869 and #1870 and further work is tracked in
  #1884; this feature changes what a failed dispatch is reported as, not how many times it
  is attempted.
- US-002 only: deleting or rolling back an acceptance test file that already exists at the
  target path when a regeneration dispatch fails is out of scope. The branch writes
  nothing; it does not remove prior content.
- US-002 only: propagating the dispatch failure as a thrown error that aborts the run is
  out of scope. The stage records the failure and lets the existing missing-target path
  fail the acceptance gate.
- US-001 only: attaching the run outcome's `adapterFailure` to the outputs of operations
  other than `acceptance-generate` is a consequence of `callOp` being shared, but no other
  operation's behaviour is changed to read it here.
- US-001 only: carrying an `adapterFailure` through the `complete`-kind branch of `callOp`
  is out of scope; the acceptance generator is a `run`-kind operation.
- US-003 only: changing `MAX_STUB_REGENS`, the acceptance loop's retry budget, or when the
  loop decides to regenerate is out of scope. This story changes what a regeneration
  reports, not how many are attempted.
- US-003 only: changing the stub-detection predicate itself is out of scope; the existing
  classifier is used as it stands.
- US-004 only: changing the meaning of `run.status`, adding a new value such as
  `completed-with-failures`, or changing the values of `PostRunPhaseStatus` is out of
  scope. This story adds an additive summary field and leaves every existing value alone.
- US-004 only: surfacing `gates` in the TUI, the headless run footer, or the `nax status`
  command is out of scope; this story writes the field into the status file.
- US-004 only: including the `finish` phase in `gates` is out of scope — `postRun.finish`
  is optional and describes what happened after the gates, not a gate.
- Backfilling `gates` onto status files already written to disk is out of scope.
- Changing the auto-commit that the acceptance-setup stage performs is out of scope; with
  US-002 landed there is simply no stub file for it to commit on the dispatch-failure path.

## Stories

Four stories. US-002 depends on US-001. US-003 and US-004 are independent.

### US-001: A dispatch failure survives to the operation's output

Fixes the producer half of #1872. Today the signal is destroyed twice over: the
path-correction self-heal turn replaces the failed generation turn wholesale, and `callOp`
reads the run outcome's `adapterFailure` only to record agent fallbacks before dropping it.
This story makes the failure sticky across the self-heal chain and attaches it to the
operation's parsed output. Nothing consumes the field yet — US-002 does.

- Depends on: none

#### Context Files
- `src/operations/self-heal.ts` — `runSelfHealChain`, where the corrective turn replaces the seed
- `src/operations/call.ts` — the run branch's parse-and-return tail and the `retryFallback` attachment precedent
- `src/operations/acceptance-generate.ts` — `AcceptanceGenerateOutput` and the `hopBody` that always runs a self-heal step
- `src/context/engine/types.ts` — the `AdapterFailure` shape
- `test/unit/operations/self-heal.test.ts` — existing self-heal test patterns

#### Acceptance Criteria

1. `[unit]` `runSelfHealChain` given a seed turn carrying an `adapterFailure` with outcome
   `fail-service-down`, and one step whose corrective turn carries no `adapterFailure`,
   returns a turn whose `adapterFailure.outcome` is `fail-service-down`.
2. `[unit]` `runSelfHealChain` given a seed turn carrying an `adapterFailure` with outcome
   `fail-service-down`, and one step whose corrective turn carries its own `adapterFailure`
   with outcome `fail-timeout`, returns a turn whose `adapterFailure.outcome` is
   `fail-timeout`.
3. `[unit]` `runSelfHealChain` given a seed turn with no `adapterFailure` and one step whose
   corrective turn also has none returns a turn with no `adapterFailure` property.
4. `[unit]` `runSelfHealChain` given a seed turn carrying an `adapterFailure` and a step
   that detects nothing and issues no corrective turn returns a turn whose `output` and
   `adapterFailure` are the seed's.
5. `[unit]` `callOp` running a `run`-kind operation whose dispatch outcome carries an
   `adapterFailure` with outcome `fail-service-down`, and whose `parse` returns
   `{ testCode: null }`, resolves to a value whose `adapterFailure.outcome` is
   `fail-service-down` and whose `testCode` is `null`.
6. `[unit]` `callOp` running a `run`-kind operation whose dispatch outcome carries no
   `adapterFailure` resolves to the parsed value with no `adapterFailure` property.
7. `[unit]` `callOp` running a `run`-kind operation whose dispatch outcome carries an
   `adapterFailure` with outcome `fail-service-down`, and whose `parse` returns a value
   that already carries an `adapterFailure` with outcome `fail-quality`, resolves to a
   value whose `adapterFailure.outcome` is `fail-quality`.
8. `[unit]` `callOp` running a `run`-kind operation whose dispatch outcome carries an
   `adapterFailure` and whose `parse` returns a string resolves to that same string.

### US-002: acceptance-setup names the dispatch failure and writes no skeleton over it

Fixes the consumer half of #1872. The generation branch becomes three-way: real test code
is written as before, a falsy result with no failure attached still gets the skeleton, and
a falsy result carrying an `adapterFailure` gets no file and a warning that names the
failure. Writing nothing routes the package into the acceptance stage's existing
missing-target path, so the run reports one honest missing target instead of thirty
fabricated red criteria, and no stub reaches the auto-commit.

- Depends on: US-001

#### Context Files
- `src/pipeline/stages/acceptance-setup.ts` — the generation branch and `_acceptanceSetupDeps`
- `src/operations/acceptance-generate.ts` — created field consumed here; `AcceptanceGenerateOutput` gains `adapterFailure` in US-001
- `src/pipeline/stages/acceptance.ts` — the missing-target path this branch relies on (`:187-205`)
- `test/unit/pipeline/stages/acceptance-setup-agent-file.test.ts` — existing stage tests for the write-vs-skeleton decision

#### Acceptance Criteria

1. `[unit]` With `_acceptanceSetupDeps.callOp` stubbed to return
   `{ testCode: null, adapterFailure: { category: "availability", outcome:
   "fail-service-down", message: "Upstream idle timeout exceeded", retriable: true } }` for the
   `acceptance-generate` operation, executing `acceptanceSetupStage` performs no
   `_acceptanceSetupDeps.writeFile` call whose path is the group's acceptance test path.
2. `[unit]` Under that same stubbed failure, executing `acceptanceSetupStage` emits a
   warning on the `acceptance-setup` channel whose message differs from `"agent did not
   produce test content; using skeleton"` and whose metadata carries `outcome`
   `fail-service-down` and the failure's message text.
3. `[unit]` With `_acceptanceSetupDeps.callOp` stubbed to return `{ testCode: null }`
   with no `adapterFailure`, executing `acceptanceSetupStage` writes skeleton content to the
   group's acceptance test path and emits the warning `"agent did not produce test content;
   using skeleton"` — the model-quality path is unchanged.
4. `[unit]` With `_acceptanceSetupDeps.callOp` stubbed to return a non-empty
   `testCode` together with an `adapterFailure`, executing `acceptanceSetupStage` writes
   that `testCode` to the group's acceptance test path — a recovered call is not treated as
   a failure.
5. `[unit]` Under the stubbed failure of AC 1, with a file already present at the
   group's acceptance test path, executing `acceptanceSetupStage` leaves that file's content
   unchanged.
6. `[unit]` The acceptance stage records a package in the acceptance verdict's
   `missingTargets` when no file exists at that package's acceptance test path and the
   package has at least one story with acceptance enabled.

### US-003: Regeneration reports success only for a non-stub test

Fixes #1871. `regenerateAcceptanceTest` gains the stub check the acceptance loop already
performs one iteration later, so a regeneration that produced only stubs is reported as the
failure it is instead of costing a further generation attempt.

- Depends on: none

#### Context Files
- `src/execution/lifecycle/acceptance-helpers.ts` — `regenerateAcceptanceTest` and the stub predicate above it
- `src/execution/lifecycle/acceptance-loop.ts` — the caller and its own stub check one iteration later
- `test/unit/execution/lifecycle/acceptance-loop.test.ts` — existing `regenerateAcceptanceTest` tests and their `_regenerateDeps` stubbing

#### Acceptance Criteria

1. `[unit]` `regenerateAcceptanceTest` returns `false` when the acceptance-setup stage it
   invokes leaves stub content at the target path.
2. `[unit]` `regenerateAcceptanceTest` returns `true` when the acceptance-setup stage it
   invokes leaves real test content at the target path.
3. `[unit]` `regenerateAcceptanceTest` returns `false` when the acceptance-setup stage it
   invokes leaves no file at the target path.
4. `[unit]` When `regenerateAcceptanceTest` returns `false` because the target path holds
   stub content, it logs at error level on the `acceptance` channel with a message that
   differs from the one it logs when the file is missing entirely.
5. `[unit]` `regenerateAcceptanceTest` writes the pre-existing content of the target path to
   a sibling path ending in `.bak` before invoking the acceptance-setup stage, whichever
   value it goes on to return.

### US-004: The status file carries a top-level gate summary

Fixes #1873. `buildStatusSnapshot` emits a top-level `gates` object mirroring the post-run
phase outcomes, so a reader of `status.json` sees that the acceptance gate failed without
descending into `postRun`. `run.status` keeps its current meaning, so nothing that switches
on it changes.

- Depends on: none

#### Context Files
- `src/execution/status-file.ts` — `NaxStatusFile`, `PostRunStatus` and `buildStatusSnapshot`
- `src/execution/status-writer.ts` — the two call sites that turn run state into a status file
- `test/integration/execution/status-file.test.ts` — existing `buildStatusSnapshot` tests including its `postRun` block

#### Acceptance Criteria

1. `[unit]` `buildStatusSnapshot` given run state whose `postRun` has
   `acceptance.status: "failed"` and `regression.status: "passed"` returns a snapshot whose
   `gates.acceptance` is `"failed"` and whose `gates.regression` is `"passed"`.
2. `[unit]` `buildStatusSnapshot` given run state with no `postRun` returns a snapshot with
   no `gates` property.
3. `[unit]` `buildStatusSnapshot` given run state whose `postRun` has
   `acceptance.status: "passed"` with a non-empty `acceptance.skippedPackages` returns a
   snapshot whose `gates.acceptance` is `"failed"`.
4. `[unit]` `buildStatusSnapshot` given run state whose `postRun` has
   `acceptance.status: "passed"` with `acceptance.skippedPackages` absent returns a snapshot
   whose `gates.acceptance` is `"passed"`.
5. `[unit]` `buildStatusSnapshot` given run state whose `postRun` has
   `acceptance.status: "failed"` returns a snapshot whose `run.status` equals the state's
   own `runStatus` value — the gate summary does not alter the run status.
6. `[unit]` `buildStatusSnapshot` given run state whose `postRun` has
   `regression.status: "not-run"` returns a snapshot whose `gates.regression` is
   `"not-run"`.
7. `[integration]` Writing a snapshot that carries `gates` with `writeStatusFile` and
   reading the file back yields `gates.acceptance` equal to the value written.

### Seams

- **US-001 → US-002.** US-001 adds `adapterFailure` to `AcceptanceGenerateOutput` and
  populates it from `callOp`; US-002 is the only consumer. US-002 AC 1 and AC 2 are the seam
  invariants: they stub `_acceptanceSetupDeps.callOp` — the stage's own dispatch seam — to
  return the field, trigger `acceptanceSetupStage.execute`, and assert on the stage's
  observable decisions (no write at the test path, a warning naming the outcome). US-002
  AC 3 pins the complementary input class, so an implementation that ignores the field
  entirely fails AC 1 and one that treats every falsy result as a failure fails AC 3.
- **US-002 → the acceptance stage.** US-002's "write nothing" branch depends on the
  pre-existing missing-target path in `src/pipeline/stages/acceptance.ts`, which is not
  changed by this feature. US-002 AC 6 pins that path's behaviour so the branch's
  consequence is anchored rather than assumed.

<!-- spec-writing: completed-through-phase-6 -->
