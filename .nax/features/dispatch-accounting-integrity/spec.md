# SPEC: Dispatch Accounting Integrity

<!-- spec-writing: completed-through-phase-6 -->

## Summary

Four dispatch paths that end anywhere other than the happy hop leave no durable
record of what they did. A run-op whose turn throws spends real money and writes no
usage to the cost ledger; a warm-lifetime native session is never closed, so its
transcript is never deleted and the retention cap structurally cannot see it;
`runTrackedSession` builds coding-tool support with a no-op audit sink and overwrites
the caller's recording runtime; and `nax plan` never claims the project identity, so
two checkouts sharing a project name mix their cost records in one directory. This
feature closes all four so that a failed, warm, off-hop, or plan-time dispatch leaves
the same evidence a successful one does.

## Motivation

Each mechanism nax has for observing its own behaviour is blind to exactly the set
that leaks:

- **[#1881]** `buildDispatchErrorEvent` (`src/agents/manager-dispatch.ts:178`)
  constructs a `DispatchErrorEvent` with `errorCode`, `errorMessage`, `durationMs`
  and ids — and no token or cost fields. The spend survives to the catch block:
  `SessionTurnError` (`src/agents/session-types.ts:235`) already carries
  `tokenUsage`, `estimatedCostUsd` and `exactCostUsd` precisely because "round trips
  completed before a turn fails still spent real money" (BUG-57). The error event
  then drops all of it. The persisted error row also carries no `sessionRole`, so a
  reader filtering the ledger by role sees nothing at all for a failed op. One
  observed feature reported $8.61 across 43 ops with three whole `acceptance-gen`
  sessions — one of them 70 tool calls deep — absent from the figure.
- **[#1880]** `pruneRetainedTranscripts` (`src/agents/native/session/transcript-store.ts:165`)
  runs only inside `closeNativeSession`'s kept-on-failure branch. Warm-lifetime ops
  (`implement`, `write-test`, `autofix-implementer`, `autofix-test-writer`,
  `full-suite-rectify`) skip the close at `src/operations/build-hop-callback.ts:519`
  when `keepOpen` is set, and nothing else closes them: `SessionManager.close()`
  (`src/session/manager.ts:742`) only unsubscribes a stream listener, and
  `sweepOrphansImpl` (`src/session/manager-sweep.ts:16`) mutates the in-memory `Map`
  and never touches disk. So the one set that grows without a close is the one set
  the `MAX_RETAINED_TRANSCRIPTS = 50` cap cannot reach. Observed: five implementer
  transcripts, 3.5 MB, from a single feature; plus one 56,883-byte transcript left at
  its live name by a run that exited normally.
- **[#1874]** `runTrackedSession` (`src/session/manager-run.ts:70`) calls
  `buildCodingToolSupport` directly with no `auditDir`, which selects
  `createNoOpToolAuditSink()`, then spreads the result into `runOptions`, overriding
  whatever the caller supplied. Both real hop paths
  (`src/runtime/session-run-hop.ts:75`, `src/operations/build-hop-callback.ts:301`)
  go through `resolveCodingToolSupport`, which derives `auditDir` and therefore
  always records. An empty ledger reads exactly like "the agent made no tool calls" —
  the equivalence `src/tools/tool-audit.ts` exists to prevent.
- **[#1854]** `claimProjectIdentity` (`src/runtime/paths.ts:75`) has exactly one
  non-test caller, `src/execution/lifecycle/run-setup.ts:351`. `nax plan` never calls
  it, but cost records key on the same `projectKey`, so a plan run from an unclaimed
  checkout writes into a directory owned by a different working directory — and then
  `nax run` refuses the same command, after the plan has already spent money.

The common shape: the accounting mechanism (cost ledger, retention cap, tool audit,
project identity) is wired to the success path and blind to its complement.

## Design

All four stories are independent — no story depends on another, and no two share a
production file.

### Integration

The baselines below exist only to locate the code; they are never the interface to
implement. Where a symbol changes, the **Target** is the contract.

**`DispatchErrorEvent`** — `src/runtime/dispatch-events.ts:130` (US-001)
- Baseline: `{ kind: "error"; origin; agentName; stage; storyId?; errorCode;
  errorMessage; prompt?; durationMs; timestamp; resolvedPermissions; callId?;
  scopeId? }`
- Target: the same, plus four optional fields — `sessionRole?: string`,
  `tokenUsage?: TokenUsage`, `estimatedCostUsd?: number`, `exactCostUsd?: number`.
  `TokenUsage` is the one already imported at `src/runtime/dispatch-events.ts:1`
  from `../agents/cost` (`src/agents/cost/types.ts:16`) — **not** the same-named
  interface at `src/metrics/types.ts:12`. All four are optional, so existing
  constructions stay valid.

**`buildDispatchErrorEvent`** — `src/agents/manager-dispatch.ts:178` (US-001)
- Baseline: input `{ origin; agentName; stage; storyId?; error: unknown; prompt?;
  resolvedPermissions; callId?; scopeId?; startedAt }`.
- Target: the three per-call id fields `storyId` / `callId` / `scopeId` are replaced
  by a single `dispatchOptions: { storyId?: string; callId?: string; scopeId?: string;
  sessionRole?: string }`, and the function reads `tokenUsage`, `estimatedCostUsd`
  and `exactCostUsd` off the thrown value when it is a `SessionTurnError`, leaving
  them undefined otherwise.
- Collapsing three fields into one is deliberate: both call sites live in
  `src/agents/manager.ts`, which is grandfathered at 786 lines in
  `scripts/baselines/file-sizes-baseline.json` against a 600-line limit and **may not
  grow**. Passing the existing `opts` / `options` object as `dispatchOptions` removes
  two lines at each call site.

**`CostErrorEvent`** — `src/runtime/cost-aggregator.ts:89` (US-001)
- Baseline: `{ kind: "error"; ts; runId; projectKey?; schemaVersion?; agentName;
  model?; stage?; storyId?; callId?; scopeId?; errorCode; durationMs }`
- Target: the same, plus `sessionRole?: string`, `tokens?: { input: number; output:
  number; cacheRead?: number; cacheWrite?: number }`, `estimatedCostUsd?: number`,
  `exactCostUsd?: number`, `costUsd?: number`. `tokens` stays **optional and is left
  undefined** when the dispatch error carried no usage — a zeroed `tokens` would
  re-create the "failed vs cost zero" ambiguity the `kind` discriminator was added
  for (#1433).

**`CostSnapshot`** — `src/runtime/cost-aggregator.ts:110` (US-001)
- Baseline: `{ totalCostUsd; totalEstimatedCostUsd; totalExactCostUsd;
  totalInputTokens; …; errorCount }`
- Target: the same, plus `totalErrorCostUsd: number` — the summed `costUsd` of error
  rows. `totalCostUsd` keeps its current meaning (successful spend only), so failed
  spend becomes visible without silently re-basing every historical comparison.

**`pruneRetainedTranscripts`** — `src/agents/native/session/transcript-store.ts:165` (US-002)
- Baseline: `pruneRetainedTranscripts(dir: string, maxRetained = MAX_RETAINED_TRANSCRIPTS): Promise<void>`
- Target: same parameters, returns `Promise<number>` — the count of files deleted.
  Its one existing caller (`src/agents/native/session/session.ts:157`) ignores the
  return value.

**`sweepFeatureTranscripts`** — new, `src/session/transcript-sweep.ts` (US-002)
- Target: `sweepFeatureTranscripts(opts: { featureName?: string; transcriptRoot?:
  string; dryRun?: boolean }): Promise<number>`. Derives the directory through
  `deriveNativeTranscriptDir` (`src/session/manager-deps.ts:45`) — the documented SSOT
  for the transcript path (ADR-028 §3), imported relatively from `./manager-deps` —
  and delegates to `pruneRetainedTranscripts`, imported from the `@/agents/native`
  nested barrel. Returns `0` without touching disk when the directory cannot be
  derived or `dryRun` is true. Exported from the `@/session` barrel; the
  `@/agents/native` barrel gains a `pruneRetainedTranscripts` re-export.
- It mirrors the file shape of `src/session/scratch-purge.ts` (a feature-scoped
  sessions-directory sweep with injectable deps). Note that `purgeStaleScratch` has
  no production caller today despite its docstring — it is a shape precedent only,
  not evidence of an existing run-end hook.

**`setupRun`** — `src/execution/lifecycle/run-setup.ts:187` (US-002)
- Baseline: at `:381` it calls `sessionManager.sweepOrphans()` and logs the count.
- Target: the same block also calls `sweepFeatureTranscripts` with the run's
  `feature` and `runtime.outputDir` (`NaxRuntime.outputDir`, `src/runtime/index.ts:124`;
  it is the value threaded to `SessionManager` as `transcriptRoot` at
  `src/runtime/index.ts:304`) and `runtime.dryRun`, logging the deleted count when
  non-zero. Sweeping here rather than at run end is what makes the cap independent of
  any close.

**`runTrackedSession`** — `src/session/manager-run.ts:70` (US-003)
- Baseline: calls `buildCodingToolSupport({ root, grants, declared, storyId })` and
  unconditionally spreads `codingToolRuntime` / `codingTools` into the injected
  `runOptions`.
- Target: calls `resolveCodingToolSupport(request.runOptions)`
  (`src/agents/coding-tool-support.ts:103`) — which derives `auditDir` via
  `toolAuditDir` and the ledger name via `buildLedgerSessionName`, and therefore
  records — and applies the result **only when** `request.runOptions.codingToolRuntime`
  is `undefined`, so a caller that already built a recording runtime keeps it.

**`planCommand`** — `src/cli/plan-command.ts:79` (US-004)
- Baseline: `planCommand(workdir, config, options)` calls `buildPlanModeContext`
  immediately.
- Target: the same signature; before `buildPlanModeContext`, it claims the project
  identity via a new `_planDeps.claimProjectIdentity` entry
  (`src/cli/plan-runtime.ts`), defaulting to `claimProjectIdentity` from `@/runtime`.
  `projectKey` is derived exactly as `run-setup.ts:350` derives it:
  `config.name?.trim() || basename(workdir)`. `remoteUrl` is resolved the same way,
  via `_planDeps.spawnSync(["git", "remote", "get-url", "origin"])`, and is `null`
  when that fails.
- `planCommand` is the sole `nax plan` entry point — `bin/nax.ts:426` and
  `bin/nax.ts:1045` both route through it, and pipeline mode is reached from inside
  it via `createPlanStrategy`, so one claim covers every plan mode.

Symbols this feature reads but does **not** change:

- `SessionTurnError(message, cancelled, retryable, tokenUsage?, estimatedCostUsd?, exactCostUsd?, adapterFailure?)` — `src/agents/session-types.ts:235`
- `resolveCodingToolSupport(options): CodingToolSupport | undefined` — `src/agents/coding-tool-support.ts:103`; returns `undefined` when `declaredTools` is empty
- `claimProjectIdentity(projectKey, workdir, remoteUrl): Promise<void>` — `src/runtime/paths.ts:75`; throws `NaxError` code `RUN_NAME_COLLISION` on a foreign claim
- `deriveNativeTranscriptDir({ featureName?, transcriptRoot? }): string | undefined` — `src/session/manager-deps.ts:45`
- `MAX_RETAINED_TRANSCRIPTS = 50` — `src/agents/native/session/transcript-store.ts:139`
- `CostAggregator.drain()` — `src/runtime/cost-aggregator.ts:382`; writes `<drainDir>/<runId>.jsonl`

### Approach

Every change is additive at the type level (new optional fields, one new file, one
widened return type) except `buildDispatchErrorEvent`'s input, which is reshaped to
keep `src/agents/manager.ts` from growing past its grandfathered baseline. No
behaviour is removed and no file is deleted, so this feature has no terminal-cleanup
story.

Injection follows the project's `_deps` convention rather than `mock.module()`:
US-002's sweep is reachable through an injectable dep so `setupRun` can be tested
without a real transcript directory, and US-004's claim is injected through the
existing `_planDeps` object.

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| Thrown value is not a `SessionTurnError` (US-001) | Usage fields on the event stay `undefined`; the error row persists as it does today |
| `SessionTurnError` carries no `tokenUsage` (US-001) | `tokens` on the cost row stays `undefined` — never zeroed |
| Transcript directory does not exist (US-002) | `sweepFeatureTranscripts` returns `0`; not an error |
| `featureName` or `transcriptRoot` unavailable (US-002) | `sweepFeatureTranscripts` returns `0` without reading the filesystem |
| Run is a dry run (US-002) | `sweepFeatureTranscripts` returns `0` and deletes nothing |
| `codingToolRoot` missing or empty with tools declared (US-003) | The existing `NaxError` code `CODING_TOOL_ROOT_MISSING` still propagates from `buildCodingToolSupport` |
| Caller already supplied `codingToolRuntime` (US-003) | Preserved; the resolved support is not applied |
| Identity claimed by a different workdir (US-004) | `planCommand` rethrows the `RUN_NAME_COLLISION` `NaxError` before any plan operation dispatches |
| Identity claim fails for any other reason (US-004) | Logged at warn level; the plan proceeds — mirroring `run-setup.ts:352` |

## Out of Scope

- Recording spend for a session killed by `SIGKILL`, which no handler can catch; addressing it would require flushing cost per round trip rather than per op.
- Including failed-dispatch spend in `CostSnapshot.totalCostUsd`; failed spend is reported separately as `totalErrorCostUsd`.
- Adding model attribution (`model`, `pricingSource`) to `DispatchErrorEvent`; only `sessionRole` and usage are added.
- Closing warm-lifetime native sessions at run end; retention is made independent of the close path instead.
- Changing `MAX_RETAINED_TRANSCRIPTS` from 50, or making it configurable.
- Wiring a production caller for `SessionRunClient`; `runTrackedSession` stays reachable only from `SessionManager.runInSession`.
- Wiring `purgeStaleScratch`, which has no production caller today.
- Any change to `nax migrate --reclaim` / `--merge`, or to collision recovery generally.
- Extending the collision guard to `nax resume`, `nax replay`, or any command other than `nax plan`.
- US-001 only: reporting failed spend in the `nax cost` CLI output.

## Stories

1. **US-001: Failed dispatches record the spend they made** — no dependencies
2. **US-002: Transcript retention independent of the close path** — no dependencies
3. **US-003: `runTrackedSession` records tool calls and respects the caller's runtime** — no dependencies
4. **US-004: `nax plan` claims the project identity before it spends** — no dependencies

### US-001 — Failed dispatches record the spend they made

Closes #1881.

#### Context Files
- `src/agents/manager-dispatch.ts` — `buildSessionTurnEvent` shows the field set a success event carries; mirror it
- `src/runtime/dispatch-events.ts` — event interfaces
- `src/runtime/middleware/cost.ts` — the `onDispatch` branch is the mapping pattern the error branch should follow
- `src/runtime/cost-aggregator.ts` — `CostErrorEvent`, `snapshot()`, `drain()`
- `src/agents/session-types.ts` — `SessionTurnError`'s usage fields

#### Creates
- none

### US-002 — Transcript retention independent of the close path

Closes #1880.

#### Context Files
- `src/agents/native/session/transcript-store.ts` — `pruneRetainedTranscripts` and the retention cap
- `src/session/scratch-purge.ts` — feature-scoped sessions-directory sweep; mirror this file shape
- `src/session/manager-deps.ts` — `deriveNativeTranscriptDir`, the transcript-path SSOT
- `src/execution/lifecycle/run-setup.ts` — the `sweepOrphans()` block at `:381` is where the sweep joins
- `src/agents/native/index.ts` — nested barrel to re-export through

#### Creates
- `src/session/transcript-sweep.ts` — `sweepFeatureTranscripts`

### US-003 — `runTrackedSession` records tool calls and respects the caller's runtime

Closes #1874.

#### Context Files
- `src/session/manager-run.ts` — the call site to change
- `src/agents/coding-tool-support.ts` — `resolveCodingToolSupport` vs `buildCodingToolSupport`
- `src/runtime/session-run-hop.ts` — a hop that already resolves correctly; mirror it
- `src/tools/tool-audit.ts` — the ledger sink and its directory layout

#### Creates
- none

### US-004 — `nax plan` claims the project identity before it spends

Closes #1854.

#### Context Files
- `src/cli/plan-command.ts` — `planCommand`, the single plan entry point
- `src/cli/plan-runtime.ts` — `_planDeps`, where the injectable claim belongs
- `src/execution/lifecycle/run-setup.ts` — the claim block at `:339-359` to mirror exactly
- `src/runtime/paths.ts` — `claimProjectIdentity` and its collision error

#### Creates
- none

### Modifies

None. No existing test pins a shape these stories change: no test calls
`buildDispatchErrorEvent` directly (the middleware tests build `DispatchErrorEvent`
literals, which stay valid under added optional fields, and assert field-by-field
rather than exhaustively); no test asserts `pruneRetainedTranscripts`' return value;
and `test/preload.ts` points `globalConfigDir()` at an isolated directory, so
US-004's claim writes there rather than the real `~/.nax`.

### Seams

- US-001: `AgentManager.runAsSession` is the entry point above the try/catch that
  builds the error event — the seam test enters there, not at
  `buildDispatchErrorEvent`.
- US-002: `setupRun` is the entry point that must invoke `sweepFeatureTranscripts`;
  the sweep is otherwise unreachable in production.
- US-003: `SessionManager.runInSession` with a `SessionRunClient` is the only entry
  point that reaches `runTrackedSession` — it dispatches on the runner-shaped
  argument at `src/session/manager.ts:686-694` into the private
  `_runTrackedSession` (`:716`), which delegates to `runTrackedSession`
  (`src/session/manager-run.ts:44`). The seam test must pass a `SessionRunClient`
  to clear that guard.
- US-004: `planCommand` is the entry point; the claim must precede plan dispatch.

## Acceptance Criteria

### US-001 — Failed dispatches record the spend they made

- [unit] `buildDispatchErrorEvent` given a `SessionTurnError` carrying `tokenUsage`, `estimatedCostUsd` and `exactCostUsd` returns a `DispatchErrorEvent` whose `tokenUsage` equals the error's `tokenUsage`.
- [unit] `buildDispatchErrorEvent` given that same `SessionTurnError` returns a `DispatchErrorEvent` whose `estimatedCostUsd` and `exactCostUsd` equal the error's.
- [unit] `buildDispatchErrorEvent` given a plain `Error` returns a `DispatchErrorEvent` whose `tokenUsage`, `estimatedCostUsd` and `exactCostUsd` are all `undefined`.
- [unit] `buildDispatchErrorEvent` given a `SessionTurnError` whose `tokenUsage` is `undefined` returns a `DispatchErrorEvent` whose `tokenUsage` is `undefined`, with `errorCode` and `durationMs` still populated.
- [unit] `buildDispatchErrorEvent` returns a `DispatchErrorEvent` whose `sessionRole`, `storyId`, `callId` and `scopeId` equal the corresponding fields of the `dispatchOptions` argument.
- [unit] `buildDispatchErrorEvent` called with a `dispatchOptions` that omits `sessionRole` returns a `DispatchErrorEvent` whose `sessionRole` is `undefined`.
- [unit] `attachCostSubscriber`: emitting a `DispatchErrorEvent` carrying `tokenUsage` and `exactCostUsd` records a `CostErrorEvent` whose `tokens.input`, `tokens.output`, `estimatedCostUsd`, `exactCostUsd` and `sessionRole` match the emitted event.
- [unit] `attachCostSubscriber`: emitting a `DispatchErrorEvent` with no `tokenUsage` records a `CostErrorEvent` whose `tokens` is `undefined` rather than an object of zeros.
- [unit] `attachCostSubscriber`: the recorded `CostErrorEvent.costUsd` equals `exactCostUsd` when the dispatch error carries one, and equals `estimatedCostUsd` when it carries only that.
- [unit] `CostAggregator.snapshot()` returns `totalErrorCostUsd` equal to the summed `costUsd` of recorded error events, and `totalCostUsd` unchanged by those error events.
- [unit] after `CostAggregator.drain()`, the written `<runId>.jsonl` contains a row with `kind` `"error"` whose `tokens` and `costUsd` are the values recorded, alongside its `errorCode`.
- [integration] with `sendPrompt` stubbed to throw a `SessionTurnError` carrying `tokenUsage` and `exactCostUsd`, calling `AgentManager.runAsSession` emits a dispatch-error event on the bus carrying that `tokenUsage` and `exactCostUsd`, and rethrows the error.

### US-002 — Transcript retention independent of the close path

- [unit] `pruneRetainedTranscripts` returns the number of files it deleted — `3` for a directory holding 53 transcript files with `maxRetained` 50.
- [unit] `pruneRetainedTranscripts` returns `0` and deletes nothing when the directory holds fewer transcript files than `maxRetained`.
- [unit] `pruneRetainedTranscripts` deletes the oldest files by mtime first, leaving exactly the `maxRetained` most recently modified.
- [unit] `sweepFeatureTranscripts` given a `featureName` and `transcriptRoot` prunes `<transcriptRoot>/features/<featureName>/sessions` to `MAX_RETAINED_TRANSCRIPTS` and returns the deleted count.
- [unit] `sweepFeatureTranscripts` deletes a transcript at its live name (`<name>.transcript.json`, left by a session that was never closed) as readily as a `failed-<stamp>` one when the directory is over the cap.
- [unit] `sweepFeatureTranscripts` returns `0` and deletes nothing when `featureName` is `undefined`.
- [unit] `sweepFeatureTranscripts` returns `0` and deletes nothing when `transcriptRoot` is `undefined`.
- [unit] `sweepFeatureTranscripts` returns `0` and deletes nothing when `dryRun` is `true`, even for a directory over the cap.
- [unit] `sweepFeatureTranscripts` returns `0` when the derived directory does not exist.
- [integration] with `sweepFeatureTranscripts` stubbed, running `setupRun` invokes it exactly once with the run's `feature` as `featureName` and the runtime's `outputDir` as `transcriptRoot`.
- [integration] with `sweepFeatureTranscripts` stubbed and `setupRun` run under `dryRun: true`, the stub is invoked with `dryRun` `true`.

### US-003 — `runTrackedSession` records tool calls and respects the caller's runtime

- [integration] `SessionManager.runInSession` with a `SessionRunClient`, `declaredTools` naming a coding tool, a `codingToolRoot` and an `outputDir`, and no caller-supplied `codingToolRuntime`: dispatching a tool call through the runtime the runner receives writes a ledger record under the audit directory `toolAuditDir` derives from those options.
- [unit] `runTrackedSession` with `declaredTools` non-empty and no caller-supplied `codingToolRuntime` passes the runner a request whose `runOptions.codingTools` equal the advertised tools for the declared set.
- [unit] `runTrackedSession` with a caller-supplied `codingToolRuntime` passes the runner a request whose `runOptions.codingToolRuntime` is that same runtime instance.
- [unit] `runTrackedSession` with `declaredTools` empty and no caller-supplied runtime passes the runner a request whose `runOptions.codingToolRuntime` is `undefined`.
- [unit] `runTrackedSession` with `declaredTools` non-empty and `codingToolRoot` an empty string rejects with a `NaxError` whose code is `CODING_TOOL_ROOT_MISSING`.
- [integration] `SessionManager.runInSession` with a `SessionRunClient` and declared tools passes the runner a request whose `runOptions.codingToolRuntime` is defined, and the session transitions to `RUNNING`.

### US-004 — `nax plan` claims the project identity before it spends

- [unit] `planCommand` rejects with a `NaxError` whose code is `RUN_NAME_COLLISION` when an identity for the derived `projectKey` is already registered to a different workdir.
- [unit] in that collision case, the plan strategy's `execute` is never invoked — no plan operation dispatches.
- [unit] `planCommand` with no existing identity for the derived `projectKey` writes an identity whose `workdir` equals the `workdir` argument, and invokes the plan strategy once.
- [unit] `planCommand` with an identity already registered to the same workdir invokes the plan strategy once and updates the stored `lastSeen`.
- [unit] `planCommand` derives `projectKey` from `config.name` when it is a non-empty string, claiming under that key.
- [unit] `planCommand` derives `projectKey` from the basename of `workdir` when `config.name` is absent or only whitespace.
- [unit] `planCommand` passes the trimmed `origin` remote URL as `remoteUrl` when `_planDeps.spawnSync` reports exit code `0`, and `null` when it reports a non-zero exit code.
- [unit] when `_planDeps.claimProjectIdentity` rejects with an error whose code is not `RUN_NAME_COLLISION`, `planCommand` still invokes the plan strategy once and resolves.
