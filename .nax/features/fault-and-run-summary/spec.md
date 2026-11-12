# SPEC: fault-and-run-summary — terminal provider 4xx, adapter errors swap, failed dispatch skips the gates, honest run counters, redactor boundary

Closes: #2877, #2879, #2882

## Summary

Six fixes from the 2026-11-09 .. 11-12 run-artifact analysis. A thrown provider error shaped
`<provider> API error (<status>): <body>` is classified by its status instead of as a transport fault,
so a 4xx stops retrying at once. An adapter error swaps to the next agent after its same-agent retry
whatever `agent.fallback.onQualityFailure` says. A story whose first implementer dispatch failed and left
no work closes `complete-gate-open` without running the gates. The run summary stops counting a
gate-open story as completed, and the interrupt and resume summaries report what the PRD says. A failed
push marks the workflow as not passed. `nax plan` stamps `createdAt` in code and warns when `prd.json`
carries a secret-shaped string. The redactor's `sk-` pattern gets a left boundary.

## Motivation

From workflow runs on 0.91.8-canary.4 .. 0.92.0 across four projects (report
`projects/nax/telemetry/report-2026-11-09-to-12.md` in the owner's workspace):

- **#2877 (1).** pi-ai formats a provider error as `opencode-go API error (400): {...}`
  (`formatProviderError`) and delivers it either as a stream error event's `errorMessage`
  (`pi-client.ts:419`, status from `observed?.status ?? statusFromSdkMessage(...)`) or as a raw throw
  (`pi-client.ts:463`, `classifyThrown`). `statusFromSdkMessage` (`errors.ts:23`) only reads
  `^4xx {` / `^4xx status code`, and `classifyThrown` (`errors.ts:292`, branch at line 296) returns kind
  `transport` for any throw with no status property. The observed retries logged `kind: "transport"`:
  a 400 that can never succeed (the provider's "model trains on request data" policy) was retried 2x
  by the native adapter times 3 same-agent attempts, about 12 calls and 75 s per review call; 84 retry
  events in two runs on one day.
- **#2877 (2).** An implementer hop got `{"detail":"Bad Request"}` (kind `bad-request`, outcome
  `fail-adapter-error`). Its policy is `swap: "quality-gated"`, so with `onQualityFailure` off the swap
  was declined; the failure became a session finding (`story-steps.ts` `absorbTurn`), `implementStep`
  exited `worked`, and the gates ran against a branch with no implementation. Green only after 2 fix
  rounds.
- **#2879 (1).** `workflow/stage.ts` always sets `ctx.agentResult.success = true`, so
  `pipeline/stages/completion.ts` logs "Story passed" and `handlePipelineSuccess` counts the story in
  `storiesCompleted` even when the story closed `complete-gate-open`: one run reported
  `storiesCompleted: 9, storiesFailed: 0` with `success: false` and a draft PR.
- **#2879 (2).** A push rejected by the forge (GitHub push protection GH013 on a secret-shaped test
  string the run auto-committed into `prd.json`) ended `outcome: "local-only", passed: true`; the run
  looked green and published nothing.
- **#2879 (3).** "Feature execution terminated" (`execution/crash-writer.ts`) reports
  `storiesCompleted: 0` after an interrupt because `runner.ts` assigns its counter only after execution
  returns; a resumed run's `run.complete` counts only that session's stories.
- **#2879 (5).** The planner prompt asks the model for `createdAt` (`plan-builder.ts:418`) and
  `validatePlanOutput` (`prd/schema.ts:163`) trusts it; PRDs were dated weeks in the future.
- **#2882.** `SECRET_VALUE_PATTERNS` openai entry `/sk-[A-Za-z0-9_-]{16,}/g`
  (`packages/nax-agent/src/internal/redact.ts:44`) has no left boundary, so `task-...` became
  `ta[REDACTED]` 62 times in audit files.

Dropped after grounding: #2877 (3) (an auth failure is already parked for the run by `fail-auth`'s
`cooldown: "run"`; the two 401 retries were two separate runs) and #2879 (4) (no code on main writes
`observations.jsonl` since the curator was removed in #2861).

## Design

### Approach

One deterministic change per defect; no new config keys.

| Story | Package | Change |
|---|---|---|
| US-001 | nax-ai | `statusFromSdkMessage` also reads `<prefix> API error (<status>): `; `classifyThrown` falls back to it when the throw has no status property |
| US-002 | nax-agent | the openai pattern becomes `/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/g` |
| US-003 | nax | `fail-adapter-error` policy `swap: "after-retry-lane"` |
| US-004 | nax | `implementStep` closes the story `complete-gate-open` when the first implement turn failed and `steps.workProduced` reports no work |
| US-005 | nax | the story's workflow end state reaches completion and the run counters (`storiesGateOpen`, `storiesPassed`) |
| US-006 | nax | the interrupt summary reads the live PRD through the status writer |
| US-007 | nax | a failed push sets `pushFailed` and makes the feature's `passed` false |
| US-008 | nax | `validatePlanOutput` stamps `createdAt`; `finalizeAndWritePrd` warns on secret-shaped PRD strings |

**US-001 message grammar.** The prefix is a provider name: a letter or digit, then up to 79 characters
from letters, digits, space, `.`, `_` and `-` (no colon, so `Request failed: x API error (400)` is not
read), then ` API error (`, three digits starting 4 or 5, then `): `. In regex form:
`^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79} API error \(([45]\d\d)\): `. It matches `opencode-go`, `Azure OpenAI`,
`github-copilot` and `Mistral`. The existing two shapes keep working. In `classifyThrown` the thrown
value's own `status` / `statusCode` / `response.status` (`thrownStatus`) wins, then the message. A throw
whose message matches no shape stays `transport`, as before (connection reset, DNS failure). The kind is
`classifyProviderError(status, message)` on both paths, so 503 is `overloaded` and 500 is `transport`.

**US-003 (design change).** `after-retry-lane` already exists (`fail-timeout`, `fail-spin`,
`fail-invalid-tool-call`): `trySameAgentRetry` spends the `adapter-error` lane first, then `decideSwap`
swaps, subject to `fallback.enabled` and the hop cap. This reverses the earlier rule, pinned in
`test/unit/agents/native/errors.test.ts`, that a malformed request (`bad-request`) and a context overflow
stay on the failing agent unless `onQualityFailure` is on: user ruling 2026-11-12, a provider-side 400
is better served by another agent than by gates on an empty branch. `fail-quality` and `fail-unknown`
stay `quality-gated`.

**US-004.** The check is the existing optional story-loop step `steps.workProduced`
(`workflow/story-loop.ts:60`; `buildStoryEnv` wires it to `storyWorkEvidence`). Absent means
"work produced" and a throw is read as work, the same fail-open reading `runNoWorkLadder` uses
(`workflow/no-work.ts`). The close mirrors the no-work ladder close: `closeAs` with state
`complete-gate-open`, exit `"no-work"` (the graph routes `no-work` to `close`, skipping `evaluate`).
Only the story's first implement turn is covered; a fix-round dispatch failure keeps today's
session-finding path. The discriminator is `result.outcome` (the no-work ladder's last turn). An aborted
run (`env.aborted?.()` true) never takes the new close: the stage's abort path handles it.

**US-005 counting rule.** A story whose workflow end state is `complete-gate-open` is still marked
`passed` in `prd.json` (user ruling 2026-11-12: reporting only, so a resume never re-runs it); it is not
counted in `storiesCompleted` and is counted in a new `storiesGateOpen` on the "Feature execution
completed" event, which also adds `storiesPassed`, the PRD-wide passed count (gate-open stories
included, because their PRD status is `passed`). The new counters are optional fields read with `?? 0`,
so the many test literals of `IterationResult` and the completion options keep compiling. A gate-open
story still ends its iteration as terminal (`closeStoryIfTerminal`), so its sessions close. The progress
line keeps status `passed` (`appendProgress` takes a `StoryStatus`, which has no gate-open value) and its
text says `closed gate-open`.

**US-006 counting rule.** "Feature execution terminated" reads the PRD the executor last loaded: the
runner's own `prd` is the setup copy, and the unified executor replaces `state.prd` with a fresh
`loadPRD` after each story, so the only live copy reachable from the crash handler is the one
`StatusWriter.setPrd` receives each iteration. The event reports `storiesCompleted` and `storiesPassed`
(both the PRD passed count) and `storiesFailed` (the PRD failed count).

**US-007.** `featurePassed` (`approval.ts:135`) stays a stories-and-gates verdict; `publishStep` ANDs it
with "no push failure", because the run's `success` comes from the record's `passed`
(`workflow-end-report.ts:223` -> `run-completion-phases.ts:395`), not from `buildVerdict`. `buildVerdict`
gets the same clause for `nax workflow status` and chat. `publishStep` always writes `pushFailed` (true or
false), like `approval` and `ciDetail`, because the record merges patches (`stage-env.ts:168`) and a
`--publish-only` re-publish resumes the prior record (`publish-only.ts:31`): a successful re-publish after
a failed push must clear the flag. The finished-at-HEAD path (`feature.ts:239-245`) is unchanged: it only
accepts `ready`, `draft` or `pushed` records, which never carry a push failure once the flag is cleared.

**US-008 scan.** For each story (only the stories in `args.scope` when a scope is given), every string in
`title`, `description` and `acceptanceCriteria` is passed through `redactSecrets`
(`@nathapp/nax-agent/internal`, as `config/secret-scan.ts` imports it); a string that comes back changed
is a hit. Hits are warned, never redacted and never fatal (user ruling 2026-11-12: specs about redaction
quote fake keys legitimately). `findPrdSecretShapes` is exported from the `src/prd/index.ts` barrel.

### Integration (extends existing code)

The baselines below exist only to locate the code; the interface to implement is the target.

Changed symbols:

- `statusFromSdkMessage(message: string | undefined): number | undefined` — `packages/nax-ai/src/protocols/errors.ts:23`.
  - Baseline: matches `/^([45]\d\d):? (\{|status code)/` only.
  - Target: same signature; also returns the status for `<prefix> API error (<4xx|5xx>): ...`.
- `classifyThrown(cause: unknown): ProtocolError` — `errors.ts:292`.
  - Baseline: no `thrownStatus` -> `{ kind: "transport", message, cause }`.
  - Target: no `thrownStatus` -> `statusFromSdkMessage(message)`; when that yields a status the kind is `classifyProviderError(status, message)` and the error carries `status`; otherwise `transport` as before.
- `SECRET_VALUE_PATTERNS` openai entry — `packages/nax-agent/src/internal/redact.ts:44`.
  - Baseline: `{ kind: "openai", re: /sk-[A-Za-z0-9_-]{16,}/g }`.
  - Target: `{ kind: "openai", re: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/g }`.
- `POLICIES["fail-adapter-error"]` — `packages/nax/src/agents/retry/failure-policy.ts:147`.
  - Baseline: `swap: "quality-gated"`.
  - Target: `swap: "after-retry-lane"`; other fields unchanged.
- `implementStep(env: StoryLoopEnv, state: StoryLoopState): Promise<StepResult<StoryLoopState>>` — `packages/nax/src/workflow/story-steps.ts:332`.
  - Target: same signature; when `result.outcome.failure` is set, the ladder did not close, and `env.steps.workProduced` exists and resolves `false`, returns `closeAs: { state: "complete-gate-open", reason: "implementer dispatch failed: <failure>" }` and exit `"no-work"`.
- `PipelineContext` — `packages/nax/src/pipeline/types.ts:55`.
  - Target: gains optional `workflowEndState?: StoryState` (`StoryState` from `workflow/types.ts:170`).
- the workflow stage `execute` — `packages/nax/src/workflow/stage.ts` (around lines 52-85).
  - Target: sets `ctx.workflowEndState` to `outcome.state` after the loop, and to `"complete-gate-open"` on the error path.
- the completion stage — `packages/nax/src/pipeline/stages/completion.ts:139-157`.
  - Target: for a story whose `ctx.workflowEndState` is `"complete-gate-open"`, still calls `markStoryPassed`, logs `"Story closed gate-open"` instead of `"Story passed"`, and appends progress with status `"passed"` and a text ending `— closed gate-open`.
- `PipelineSuccessResult` / `handlePipelineSuccess` — `packages/nax/src/execution/pipeline-result-handler.ts:206-225`.
  - Target: `storiesCompletedDelta` excludes the stories whose context end state is `"complete-gate-open"`; new optional field `storiesGateOpenDelta?: number`, set on every success result.
- the iteration result and executor chain — `IterationResult` (`execution/iteration-runner.ts:27`, built at lines 76, 247, 256), `execution/dry-run.ts:27`, `execution/executor-types.ts:76`, `execution/unified-executor.ts:101,154`, `execution/unified-executor-dispatch-phases.ts:42,73,183`, `execution/runner-execution.ts:70,288`, `execution/runner-completion.ts:55,161`, `execution/lifecycle/run-completion.ts:64` (`RunCompletionOptions`), `execution/runner.ts:138`.
  - Target: an optional `storiesGateOpen?: number` / `storiesGateOpenDelta?: number` beside each `storiesCompleted` / `storiesCompletedDelta`, read with `?? 0`; `closeStoryIfTerminal` treats `storiesCompletedDelta > 0 || (storiesGateOpenDelta ?? 0) > 0` as terminal.
- "Feature execution completed" — `packages/nax/src/execution/lifecycle/run-completion-phases.ts:392`.
  - Target: data adds `storiesGateOpen` (0 when absent) and `storiesPassed: finalCounts.passed`.
- `StatusWriter` — `packages/nax/src/execution/status-writer.ts:80,157`.
  - Target: gains `currentPrd(): PRD | null`, returning the PRD last passed to `setPrd`.
- `RunCompleteContext` / `writeRunComplete` — `packages/nax/src/execution/crash-writer.ts:50-83`.
  - Target: `RunCompleteContext` gains optional `getStoriesFailed?: () => number` and `getStoriesPassed?: () => number`; the entry's data adds `storiesFailed` and `storiesPassed` (0 when a getter is absent).
- the runner's crash context — `packages/nax/src/execution/runner.ts:252-253`.
  - Target: each getter reads `setupResult?.statusWriter.currentPrd() ?? prd` (through `setupResult`, as `getTotalCost` at line 247 does, because the destructured `statusWriter` const at line 262 is not yet initialised when a signal arrives during setup); `getStoriesCompleted` and `getStoriesPassed` return that PRD's `countStories(...).passed`, `getStoriesFailed` its `failed`; without a PRD, `getStoriesCompleted` returns the runner's own counter and `getStoriesPassed` / `getStoriesFailed` return 0.
- `PublishOutcome` — `packages/nax/src/workflow/finalize.ts:41`.
  - Target: gains optional `pushFailed?: true`, set on the failed-push returns of `pushMode` (`finalize.ts:439`, return at 443) and `prMode` (`finalize.ts:461`, return at 478).
- `pushBranch` — `finalize.ts:95`.
  - Target: the "Push failed — the feature ends local-only" log becomes error level.
- `WorkflowFeatureRecord` — `packages/nax/src/workflow/types.ts:220`.
  - Target: gains optional `pushFailed?: boolean`.
- `publishStep` — `packages/nax/src/workflow/feature-steps.ts:422` (patch at 447-470).
  - Target: the patch always writes `pushFailed: out.pushFailed === true`; when it is true, `passed` is `false`, otherwise `passed` is as today.
- `buildVerdict(rec: WorkflowFeatureRecord): WorkflowVerdict | undefined` — `packages/nax/src/workflow/open-items.ts:158`.
  - Target: `workflowPassed` is also false when `rec.pushFailed === true`.
- `validatePlanOutput(raw: unknown, feature: string, branch: string): PRD` — `packages/nax/src/prd/schema.ts:117`.
  - Target: `validatePlanOutput(raw: unknown, feature: string, branch: string, now?: Date): PRD`; `createdAt` and `updatedAt` are both `(now ?? new Date()).toISOString()`, whatever the model wrote.
- the planner prompt's PRD schema — `packages/nax/src/prompts/builders/plan-builder.ts:418-419`.
  - Target: the `createdAt` and `updatedAt` lines are removed from the schema the model is shown.
- `finalizeAndWritePrd(args: PersistPrdArgs): Promise<string>` — `packages/nax/src/plan/strategies/persist-prd.ts:233`.
  - Target: before the final write (line ~356) calls new `findPrdSecretShapes(prd, args.scope)` and logs one `getLogger().warn("plan", ...)` per hit; the written PRD is unchanged.

New symbol:

- `findPrdSecretShapes(prd: PRD, scope?: ReadonlySet<string>): PrdSecretShape[]` in new
  `packages/nax/src/prd/secret-shapes.ts`, exported from `packages/nax/src/prd/index.ts`, with
  `interface PrdSecretShape { readonly storyId: string; readonly field: string }`; `field` is `"title"`,
  `"description"` or `"acceptanceCriteria[<index>]"`. With a `scope`, only stories whose id is in it are
  scanned.

Read-only (verified):

- `thrownStatus` (`errors.ts:247`), `classifyProviderError` (`errors.ts:176`), `classifyHttpError` (`errors.ts:11`).
- `decideSwap(failure, hopsSoFar, fallback): SwapDecision` (`agents/swap-decision.ts:58`).
- `runNoWorkLadder`, `storyWorkEvidence` (`workflow/no-work.ts`), `StoryLoopSteps.workProduced` (`workflow/story-loop.ts:60`).
- `countStories(prd)` (`prd/index.ts:270`), `markStoryPassed` (`prd/index.ts:298`).
- `redactSecrets<T>(input: T): T` (`@nathapp/nax-agent/internal`, `packages/nax-agent/src/internal/redact.ts:153`).

### Failure Handling

| Case | Behaviour | Owner |
|---|---|---|
| A thrown error has both a `status` property and an `API error (NNN)` message that disagree | the property wins | US-001 |
| `steps.workProduced` throws after a failed first implement turn | read as work: today's session-finding path, gates run | US-004 |
| `steps.workProduced` is not wired | read as work: today's path | US-004 |
| The run is aborted (`env.aborted?.()` true) after a failed first turn with no work | no gate-open close from this path; today's path | US-004 |
| The workflow loop throws (stage error path) | the story's end state is `complete-gate-open` for the counters | US-005 |
| No PRD is loaded when an interrupt writes "Feature execution terminated" | the runner's own counter for `storiesCompleted`, and `storiesPassed` / `storiesFailed` 0 | US-006 |
| `publish: none`, or no forge, ends local-only | not a push failure: `pushFailed` false, `passed` unchanged | US-007 |
| A `--publish-only` re-publish succeeds after a failed push | `pushFailed` is cleared and `passed` is recomputed | US-007 |
| A signal arrives during setup, before the status writer exists | the getters fall back to the setup PRD or 0; no throw | US-006 |
| `redactSecrets` throws inside `findPrdSecretShapes` | the PRD is still written; one warn says the scan could not run | US-008 |

## Out of Scope

- Caching a provider's credential failure across runs: `fail-auth` already parks the provider for the whole run (`cooldown: "run"`); the #2877 report of a second 401 was a second run, ruled not a defect 2026-11-12.
- `runs/run-*/observations.jsonl` accuracy (#2879 item 4): nothing on main writes the file since the curator was removed in #2861.
- A fix-round implementer dispatch that fails: it keeps today's session-finding path; only the story's first implement turn closes gate-open.
- Changing a `complete-gate-open` story's `prd.json` status away from `passed`: ruled out 2026-11-12 (reporting only), so a resume never re-runs it.
- Refusing `nax plan` on a secret-shaped PRD string, or redacting it: ruled out 2026-11-12; the plan only warns.
- Rewording the `fail-adapter-error: same-agent retry with fresh session` log line or its `retriable` field.
- Marking `fail-quality` or `fail-unknown` swap-eligible without `onQualityFailure`.
- Recovering a status quoted in the middle of an error message: only the anchored prefix shapes are read.
- Logging an interrupt during session open at a level other than error ("Story failed").
- The `story:completed` event's `passed: true` for a gate-open story (hook and reporter payloads): only the log line and the run counters change.

## Stories

### US-001 — a `<provider> API error (NNN)` message is classified by its status

Workdir: packages/nax-ai. No dependencies.

Extend `statusFromSdkMessage` with the `<provider> API error (<status>): ` shape (the provider-name
grammar in Design), which also fixes the stream error event path in `pi-client.ts`, and make
`classifyThrown` fall back to it when the thrown value has no status property, so a 4xx is
`bad-request` / `auth` / `rate-limit` / `quota` on both paths and is never retried as a transport fault.

### US-002 — the redactor's `sk-` pattern needs a left boundary

Workdir: packages/nax-agent. No dependencies.

Anchor the openai entry of `SECRET_VALUE_PATTERNS` with `(?<![A-Za-z0-9_-])` so `task-...`, `disk-...`
and similar words are not redacted, while a real `sk-` key at the start, after whitespace or punctuation
or inside quotes still is.

### US-003 — an adapter error swaps after its same-agent retry

Workdir: packages/nax. No dependencies.

Change the `fail-adapter-error` row of `POLICIES` to `swap: "after-retry-lane"` (a design change: a
`bad-request` and a context overflow now swap without `onQualityFailure`).

### US-004 — a failed first dispatch with no work closes the story without gates

Workdir: packages/nax. No dependencies.

In `implementStep`, after the no-work ladder: when `result.outcome.failure` is set, the ladder did not
close the story, the run is not aborted, and `env.steps.workProduced` is wired and resolves `false`, close
the story `complete-gate-open` with reason `implementer dispatch failed: <failure>` and exit `"no-work"`.

### US-005 — the run summary counts gate-open stories apart

Workdir: packages/nax. No dependencies.

Carry the workflow end state on `PipelineContext.workflowEndState`; the completion stage logs
"Story closed gate-open" for such a story (PRD status still `passed`); `handlePipelineSuccess` and the
executor chain count it in an optional `storiesGateOpen` instead of `storiesCompleted`, and still treat
its iteration as terminal; "Feature execution completed" adds `storiesGateOpen` and `storiesPassed`.

### US-006 — the interrupt summary reads the live PRD

Workdir: packages/nax. No dependencies.

Add `StatusWriter.currentPrd()`; the runner's crash-context getters read it (falling back to the setup
PRD); "Feature execution terminated" adds `storiesPassed` and `storiesFailed` and reports the live PRD's
passed count as `storiesCompleted`.

### US-007 — a failed push marks the workflow as not passed

Workdir: packages/nax. No dependencies.

Set `pushFailed: true` on the `PublishOutcome` of a failed push (push and pr modes); `publishStep` always
writes `pushFailed` (true or false) and writes `passed: false` when it is true; `buildVerdict` reports
`workflowPassed: false` for a push-failed record; the push failure logs at error level.

### US-008 — `nax plan` stamps `createdAt` and warns on secret-shaped PRD strings

Workdir: packages/nax. No dependencies.

`validatePlanOutput` takes an optional `now` and ignores the model's `createdAt`/`updatedAt`; the
planner prompt stops asking for them. Create `prd/secret-shapes.ts` with `findPrdSecretShapes`, exported
from `src/prd/index.ts`; `finalizeAndWritePrd` warns once per hit with the story id and field and writes
the PRD unchanged.

### Context Files

**US-001**
- `packages/nax-ai/src/protocols/errors.ts`
- `packages/nax-ai/src/protocols/pi-client.ts`
- `packages/nax-ai/test/protocols/errors.test.ts`

**US-002**
- `packages/nax-agent/src/internal/redact.ts`
- `packages/nax-agent/test/unit/logger/redact.test.ts`

**US-003**
- `packages/nax/src/agents/retry/failure-policy.ts`
- `packages/nax/src/agents/swap-decision.ts`
- `packages/nax/src/agents/manager-run-fallback.ts`
- `packages/nax/test/unit/agents/fail-stale-agent-manager.test.ts`

**US-004**
- `packages/nax/src/workflow/story-steps.ts`
- `packages/nax/src/workflow/no-work.ts`
- `packages/nax/src/workflow/story-loop.ts`
- `packages/nax/src/workflow/story-graph.ts`
- `packages/nax/test/unit/workflow/story-loop-no-work.test.ts`

**US-005**
- `packages/nax/src/workflow/stage.ts`
- `packages/nax/src/pipeline/stages/completion.ts`
- `packages/nax/src/execution/pipeline-result-handler.ts`
- `packages/nax/src/execution/unified-executor-dispatch-phases.ts`
- `packages/nax/src/execution/lifecycle/run-completion-phases.ts`

**US-006**
- `packages/nax/src/execution/status-writer.ts`
- `packages/nax/src/execution/crash-writer.ts`
- `packages/nax/src/execution/runner.ts`
- `packages/nax/src/execution/unified-executor.ts`
- `packages/nax/test/unit/execution/crash-recovery.test.ts`

**US-007**
- `packages/nax/src/workflow/finalize.ts`
- `packages/nax/src/workflow/feature-steps.ts`
- `packages/nax/src/workflow/publish-only.ts`
- `packages/nax/src/workflow/open-items.ts`
- `packages/nax/src/execution/workflow-end-report.ts`

**US-008**
- `packages/nax/src/prd/schema.ts`
- `packages/nax/src/prompts/builders/plan-builder.ts`
- `packages/nax/src/plan/strategies/persist-prd.ts`
- `packages/nax/src/config/secret-scan.ts`
- `packages/nax/src/prd/index.ts`

### Creates

**US-008**
- `packages/nax/src/prd/secret-shapes.ts`
- `packages/nax/test/unit/prd/secret-shapes.test.ts`

### Modifies

**US-001**
- `packages/nax-ai/test/protocols/pi-client-error-status.test.ts` — add an `opencode-go API error (400): {...}` error-event row (no observed status) to the status table, expecting kind `bad-request` and status 400; existing rows are unchanged.

**US-002**
None. No existing redactor test constructs an `sk-` run preceded by a letter, digit, `_` or `-`; the new cases are additions.

**US-003**
- `packages/nax/test/unit/agents/native/errors.test.ts` — the test "an overflow is declined by default, like any fail-adapter-error" now expects `decideSwap(toAdapterFailure({ kind: "context-overflow" }), 0, fallback)` to return a swap (`{ swap: true }`), and is renamed to say an overflow swaps after the retry lane.
- `packages/nax/test/unit/agents/native/errors.test.ts` — the test "a genuinely malformed request stays declined" now expects `decideSwap(toAdapterFailure({ kind: "bad-request" }), 0, fallback)` to return a swap, and is renamed to say a malformed request swaps after the retry lane (design change, user ruling 2026-11-12).

**US-004**
None. Existing story-loop tests that fail the first implement turn do not wire `steps.workProduced`, so they keep today's session-finding path.

**US-005**
None. The new fields are optional and the existing completion and result-handler assertions are property-style; the new cases are additions.

**US-006**
None. The "Feature execution terminated" assertions in `crash-recovery.test.ts` are property-style, so the added fields break nothing.

**US-007**
None. The failed-push cases in `finalize.test.ts` and `finalize-approval-failures.test.ts` assert `outcome` and `reasons` property by property, and no test pins the push-failure log level.

**US-008**
None. No existing test pins a model-supplied `createdAt` or the exact schema lines of the planner prompt.

## Seams

- US-001: the extended `statusFromSdkMessage` is reached from `pi-client.ts:419` (stream error event); the extended `classifyThrown` from `pi-client.ts:463` (the stream's catch). One seam AC per path enters through the pi client stream.
- US-004: `implementStep`'s new close is reached from `runStoryLoop(env)`; the seam AC enters there and asserts `env.steps.gates` is never called.
- US-005: `ctx.workflowEndState` is produced by the workflow stage and consumed by the completion stage and `handlePipelineSuccess`; the count reaches "Feature execution completed" through the executor chain.
- US-006: `StatusWriter.currentPrd()` is produced in this story and consumed by the runner's crash context in this story.
- US-007: `PublishOutcome.pushFailed` is produced by `publish` and consumed by `publishStep`; the record's `passed: false` reaches `run.complete` through `workflow-end-report.ts`.
- US-008: `findPrdSecretShapes` is created and consumed in the same story, through `finalizeAndWritePrd`.

## Acceptance Criteria

### US-001

1. [unit] `statusFromSdkMessage("opencode-go API error (400): {\"type\":\"invalid_request_error\"}")` returns `400`.
2. [unit] `statusFromSdkMessage("Azure OpenAI API error (429): rate limited")` returns `429`, so a provider name with a space is read.
3. [unit] `statusFromSdkMessage("github-copilot API error (413): {\"message\":\"failed to parse request\"}")` returns `413`.
4. [unit] `statusFromSdkMessage("opencode-go API error (503): upstream down")` returns `503`.
5. [unit] `statusFromSdkMessage("Request failed: opencode-go API error (400): x")` returns `undefined`, because a colon is not part of a provider name.
6. [unit] `statusFromSdkMessage("opencode-go API error (200): x")` returns `undefined`, because only 4xx and 5xx are read.
7. [unit] `statusFromSdkMessage("400 {\"error\":\"bad\"}")` still returns `400` and `statusFromSdkMessage("400 status code (no body)")` still returns `400`.
8. [unit] `classifyThrown(new Error("opencode-go API error (400): {\"type\":\"invalid_request_error\"}"))` returns kind `"bad-request"` with `status` `400`.
9. [unit] `classifyThrown(new Error("opencode-go API error (401): {\"code\":\"api_key_expired\"}"))` returns kind `"auth"`.
10. [unit] `classifyThrown(new Error("opencode-go API error (429): slow down"))` returns kind `"rate-limit"`.
11. [unit] `classifyThrown(new Error("opencode-go API error (503): upstream down"))` returns kind `"overloaded"`, and the same with `(500)` returns kind `"transport"` with `status` `500`.
12. [unit] `classifyThrown(new Error("socket hang up"))` still returns kind `"transport"` with no `status`.
13. [unit] `classifyThrown(Object.assign(new Error("opencode-go API error (400): x"), { status: 429 }))` returns kind `"rate-limit"` with `status` `429`, because the thrown status property wins over the message.
14. [unit] `classifyThrown(new Error("opencode-go API error (400): x"))` keeps the original error as `cause` and the full message as `message`.
15. [integration] When the pi-ai stream the pi client drives throws `new Error("opencode-go API error (400): {\"type\":\"invalid_request_error\"}")` with no status property, the pi client stream yields one `error` event whose `error.kind` is `"bad-request"` and whose `error.status` is `400`.
16. [integration] When the pi-ai stream emits an `error` event whose `errorMessage` is `opencode-go API error (400): {"type":"invalid_request_error"}` and no response status was observed, the pi client stream yields one `error` event whose `error.kind` is `"bad-request"` and whose `error.status` is `400`.

### US-002

1. [unit] `redactSecrets("test:task-abcdefghijklmnopqrst")` returns `"test:task-abcdefghijklmnopqrst"` unchanged.
2. [unit] `redactSecrets("chat-task-abcdefghijklmnopq/workflow")` returns the input unchanged.
3. [unit] `redactSecrets("disk-0123456789abcdefgh")` returns the input unchanged.
4. [unit] `redactSecrets("my_sk-0123456789abcdefgh")` returns the input unchanged, because `_` before `sk-` is a word character.
5. [unit] `redactSecrets("sk-aaaaaaaaaaaaaaaaaaaa")` returns a string that no longer holds `aaaaaaaaaaaaaaaaaaaa`.
6. [unit] `redactSecrets("key: sk-aaaaaaaaaaaaaaaaaaaa")` redacts the key that follows `: `.
7. [unit] `redactSecrets("\"sk-aaaaaaaaaaaaaaaaaaaa\"")` redacts the key inside double quotes.
8. [unit] `redactSecrets("token=sk-proj-aaaaaaaaaaaaaaaaaaaa")` returns a string that no longer holds `aaaaaaaaaaaaaaaaaaaa`.
9. [unit] `redactSecrets("(sk-aaaaaaaaaaaaaaaaaaaa)")` redacts the key that follows `(`.
10. [unit] `redactSecrets("line one\nsk-aaaaaaaaaaaaaaaaaaaa")` redacts the key that follows a newline.
11. [unit] `redactSecrets("keys/sk-aaaaaaaaaaaaaaaaaaaa")` redacts the key that follows `/`.
12. [unit] `redactSecrets("a,sk-aaaaaaaaaaaaaaaaaaaa")` redacts the key that follows `,`.

### US-003

1. [unit] `failurePolicyFor("fail-adapter-error").swap` is `"after-retry-lane"`.
2. [unit] `failurePolicyFor("fail-adapter-error").sameAgentRetry` is still `"adapter-error"`, its `cooldown` still `"none"` and its `cooldownScope` still `"model"`.
3. [unit] `failurePolicyFor("fail-quality").swap` and `failurePolicyFor("fail-unknown").swap` are still `"quality-gated"`.
4. [unit] `decideSwap(toAdapterFailure({ kind: "bad-request" }), 0, { enabled: true, onQualityFailure: false, ... })` returns a decision to swap, not `quality-failure-declined`.
5. [unit] `decideSwap(toAdapterFailure({ kind: "context-overflow" }), 0, ...)` with the same fallback config returns a decision to swap.
6. [unit] `decideSwap` with a `fail-quality` failure and the same fallback config still returns `quality-failure-declined`.
7. [unit] `decideSwap` with a `fail-adapter-error` failure and `fallback.enabled: false` returns `fallback-disabled`.
8. [unit] `decideSwap` with a `fail-adapter-error` failure and `hopsSoFar` equal to the configured hop cap returns `hop-cap-reached`.
9. [integration] `AgentManager.runWithFallback` with `agent.fallback` `{ enabled: true, map: { claude: ["codex"] }, onQualityFailure: false }`, where every `claude` attempt fails with `{ category: "quality", outcome: "fail-adapter-error", retriable: false }` and `codex` succeeds, dispatches `codex` after the `claude` attempts and returns `result.success: true`.
10. [integration] In the same setup with an aborted run signal, an aborted `fail-adapter-error` hop is still neither retried nor swapped.

### US-004

1. [unit] With an implement turn that returns `{ failure: "Agent \"native\" failed: Bad Request", autoCommitted: false }` and `steps.workProduced` resolving `false`, `implementStep` returns exit `"no-work"`.
2. [unit] In the same case `implementStep`'s patch carries `closeAs.state` `"complete-gate-open"`.
3. [unit] In the same case `closeAs.reason` is `"implementer dispatch failed: Agent \"native\" failed: Bad Request"`.
4. [unit] With the same failed turn and `steps.workProduced` resolving `true`, `implementStep` returns exit `"worked"` and the patch's `pendingSession` holds the `implementer session failed: ...` finding.
5. [unit] With the same failed turn and no `steps.workProduced` wired, `implementStep` returns exit `"worked"`.
6. [unit] With the same failed turn and `steps.workProduced` rejecting, `implementStep` returns exit `"worked"`.
7. [unit] With the same failed turn, `steps.workProduced` resolving `false` and `env.aborted` returning `true`, `implementStep` does not return `closeAs` with reason `implementer dispatch failed: ...`.
8. [unit] With a turn that returns a reply and no `failure`, `steps.workProduced` resolving `false` does not produce a `closeAs` whose reason starts with `implementer dispatch failed:`.
9. [integration] `runStoryLoop(env)` with a first implement turn returning `{ failure: "Bad Request", autoCommitted: false }` and `steps.workProduced` resolving `false` never calls `env.steps.gates`.
10. [integration] In the same run `runStoryLoop` returns `state` `"complete-gate-open"` and `rounds` `0`.
11. [integration] In the same run `env.steps.storyReview` is never called.
12. [integration] `runStoryLoop(env)` with the same failed first turn and `steps.workProduced` resolving `true` calls `env.steps.gates`, and the next fix turn's findings include `implementer session failed: Bad Request`.

### US-005

1. [unit] After `runStoryLoop` resolves with `state: "complete-gate-open"`, the workflow stage's `execute` leaves `ctx.workflowEndState` equal to `"complete-gate-open"`.
2. [unit] After `runStoryLoop` resolves with `state: "complete"`, the workflow stage leaves `ctx.workflowEndState` equal to `"complete"`.
3. [unit] When `runStoryLoop` throws (not aborted), the workflow stage leaves `ctx.workflowEndState` equal to `"complete-gate-open"`.
4. [unit] The completion stage, for a story whose context has `workflowEndState: "complete-gate-open"`, still sets that story's PRD `status` to `"passed"`.
5. [unit] The completion stage, for that story, logs info `"Story closed gate-open"` under stage `completion` and does not log `"Story passed"`.
6. [unit] The completion stage, for that story, appends a progress entry with status `"passed"` whose text ends with `— closed gate-open`.
7. [unit] The completion stage, for a story with `workflowEndState: "complete"` or with no `workflowEndState`, logs `"Story passed"` as today.
8. [unit] `handlePipelineSuccess` for one story whose pipeline context has `workflowEndState: "complete-gate-open"` returns `storiesCompletedDelta` `0` and `storiesGateOpenDelta` `1`.
9. [unit] `handlePipelineSuccess` for one story with no `workflowEndState` returns `storiesCompletedDelta` `1` and `storiesGateOpenDelta` `0`.
10. [unit] `closeStoryIfTerminal` with `storiesCompletedDelta` `0` and `storiesGateOpenDelta` `1` closes the story's sessions, as it does for a completed story.
11. [unit] The unified executor's dispatch phase given an iteration result with no `storiesGateOpenDelta` key leaves its `storiesGateOpen` count unchanged (not `NaN`).
12. [integration] A unified-executor run over two stories, the first ending `complete` and the second `complete-gate-open`, ends with `storiesCompleted` `1` and `storiesGateOpen` `1`.
13. [integration] In the same run "Feature execution completed" data carries `storiesGateOpen: 1` and `storiesCompleted: 1`.
14. [unit] "Feature execution completed" data carries `storiesPassed` equal to `countStories(prd).passed`, including stories passed by an earlier run of the same feature.

### US-006

1. [unit] `StatusWriter.currentPrd()` returns `null` before any `setPrd` call.
2. [unit] After `setPrd(a)` then `setPrd(b)`, `StatusWriter.currentPrd()` returns `b`.
3. [unit] `writeRunComplete` with `getStoriesCompleted` returning `8`, `getStoriesPassed` returning `8` and `getStoriesFailed` returning `1` writes "Feature execution terminated" data with `storiesCompleted: 8`, `storiesPassed: 8` and `storiesFailed: 1`.
4. [unit] `writeRunComplete` with no `getStoriesPassed` and no `getStoriesFailed` writes `storiesPassed: 0` and `storiesFailed: 0`.
5. [integration] The runner's crash context, when the status writer's current PRD has 3 stories passed and 1 failed while the runner's setup PRD has none passed, reports `getStoriesCompleted()` `3`, `getStoriesPassed()` `3` and `getStoriesFailed()` `1`.
6. [integration] The runner's crash context, when the status writer has no PRD yet, falls back to the setup PRD's counts.
7. [integration] A signal that writes "Feature execution terminated" while setup is still running (no setup result yet) does not throw, and the entry carries `storiesPassed: 0` and `storiesFailed: 0`.

### US-007

1. [unit] `publish` in push mode, when `_featureDeps.commitAndPush` rejects with `new Error("remote: error: GH013: Repository rule violations found")`, returns `outcome: "local-only"` and `pushFailed: true`.
2. [unit] `publish` in pr mode, when the push rejects the same way, returns `outcome: "local-only"` and `pushFailed: true`.
3. [unit] `publish` with `publish: none` returns `outcome: "local-only"` and no `pushFailed` key.
4. [unit] `publish` in push mode with a successful push returns no `pushFailed` key.
5. [unit] A rejected push logs `"Push failed — the feature ends local-only"` at error level with the rejection message in `error`.
6. [unit] `publishStep`, given a publish outcome with `pushFailed: true` and stories that all closed `complete`, returns a patch with `pushFailed: true` and `passed: false`.
7. [unit] `publishStep`, given a publish outcome with no `pushFailed` and the same stories, returns a patch with `pushFailed: false` and `passed: true`.
8. [unit] `publishStep`, run on a prior record carrying `pushFailed: true` (a `--publish-only` re-publish) with a successful publish outcome and stories that all closed `complete`, returns a patch with `pushFailed: false` and `passed: true`.
9. [unit] `buildVerdict` for a record with `outcome: "local-only"`, `passed: true`, `pushFailed: true` and no open items returns `workflowPassed: false`.
10. [unit] `buildVerdict` for a record with `outcome: "local-only"`, `passed: true`, no `pushFailed` and no open items returns `workflowPassed: true`.
11. [integration] `runEndPhaseReported` whose end phase returns a feature record with `passed: false` after a failed push hands `workflowPassed: false` to the close input, and "Feature execution completed" data carries `success: false`.

### US-008

1. [unit] `validatePlanOutput(raw, "f", "feat/f", new Date("2026-11-12T00:00:00.000Z"))` with `raw.createdAt` `"2026-12-04T00:00:00.000Z"` returns `createdAt` `"2026-11-12T00:00:00.000Z"`.
2. [unit] The same call returns `updatedAt` `"2026-11-12T00:00:00.000Z"`.
3. [unit] `validatePlanOutput(raw, "f", "feat/f")` with no `now` returns a `createdAt` within one second of the current time, whatever `raw.createdAt` holds.
4. [unit] The planner prompt built by the plan builder shows a PRD schema with no `createdAt` key and no `updatedAt` key.
5. [unit] `findPrdSecretShapes` for a PRD whose `US-002` acceptance criterion at index 3 holds `sk-aaaaaaaaaaaaaaaaaaaa` returns `[{ storyId: "US-002", field: "acceptanceCriteria[3]" }]`.
6. [unit] `findPrdSecretShapes` for a PRD whose `US-001` description holds `ghp_aaaaaaaaaaaaaaaaaaaa` returns `[{ storyId: "US-001", field: "description" }]`.
7. [unit] `findPrdSecretShapes` for a PRD whose `US-001` title holds `ghp_aaaaaaaaaaaaaaaaaaaa` returns `[{ storyId: "US-001", field: "title" }]`.
8. [unit] `findPrdSecretShapes` for a PRD with no secret-shaped string returns `[]`.
9. [unit] `findPrdSecretShapes` for a PRD whose story text holds `task-abcdefghijklmnopqrst` returns `[]`.
10. [unit] `findPrdSecretShapes` returns one entry per hit, in story order then field order (title, description, acceptance criteria by index).
11. [unit] `findPrdSecretShapes(prd, new Set(["US-002"]))` for a PRD with a hit in `US-001` and one in `US-002` returns only the `US-002` entry.
12. [unit] `findPrdSecretShapes` is importable from the `src/prd` barrel and returns the same result as the module function.
13. [integration] `finalizeAndWritePrd` for a PRD with one hit logs one warn under stage `plan` whose data names the `storyId` and `field`.
14. [integration] In the same call the file written to `args.outputPath` still holds the acceptance criterion's original text.
15. [integration] `finalizeAndWritePrd` for a PRD with no hit logs no warn under stage `plan` about secret-shaped strings.
16. [integration] When `findPrdSecretShapes` throws, `finalizeAndWritePrd` still writes the PRD and logs one warn under stage `plan` saying the secret-shape scan could not run.
