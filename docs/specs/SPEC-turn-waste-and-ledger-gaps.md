# SPEC: Agent turn waste and ledger gaps

## Summary

Four independent fixes, bundled for one run. Two stop agents burning turns on refusals whose text
misleads them (nax#2226, nax#2228): the raw Bash screen's refusal tells an agent that was only
*reading* `prd.json` that it tried to *modify* it, and the scratchpad guidance never says that
runnable probe scripts belong there rather than in `/tmp`. Two close gaps between the cost ledger
and the usage sidecar (nax#2059, nax#2225): a one-shot `complete()` dispatch writes a cost row but
no usage row, and a run that shuts down while a native turn is still in flight loses that turn's
spend from the cost ledger and its tool calls from tool-audit.

## Motivation

**nax#2226.** In `raw` bash mode, `screenRawBashCommand` (`src/tools/policy-bash-raw.ts`) refuses
any command whose tokens name a nax-owned file, including read-only commands. nax updates
`.nax/features/<feature>/prd.json` itself during a run, so it shows as modified in `git status`;
agents then run `git diff`, `git log`, `cat ... | head`, `git restore` against it. On canary.19,
20 Bash calls naming `prd.json` were denied in one day, 9 of them in a single implementer session.
The refusal reads "names X, which nax owns and no tool may modify -- change it through nax", which
does not match what a reading agent did, so it retries with a variant. The screen's allow/deny
decision is deliberate and stays as it is; only the text changes.

**nax#2228.** Agents write probe scripts to `/tmp` through Bash heredocs. The imports in those
scripts do not resolve (`Cannot find module './test/helpers' from '/private/tmp/...'`), and the
`Write` tool refuses `/tmp` outright, so the agent burns turns learning which tool writes where.
About 10 such failures occurred across 4 feature runs in one day; an agent that wrote its probe to
`.nax/scratchpad/` resolved its imports fine. The scratchpad prompt section and the
`ScratchpadWrite` description both frame the scratchpad as a place for notes, never for runnable
code.

**nax#2059.** The usage sidecar (`usage/<runId>.jsonl`) is fed only by `agent.usage_update` stream
events, which only session paths emit. A one-shot `complete()` dispatch emits none, so it writes a
cost-ledger row and zero usage rows. Any reconciliation of sidecar against ledger silently
under-counts the whole one-shot class.

**nax#2225.** The cost ledger records one row per *finished* turn (`AgentManager.runAsSession`
emits its dispatch event only after `sendPrompt` resolves). A turn still running at shutdown
never produces a row: an aborted native turn emits `agent.call_ended` with status `error` (or `cancelled` when
the idle watchdog fired) and rethrows a plain error, so no dispatch-error row carries its spend either. Observed on canary.19:
a SIGINT after 100 minutes in one `acceptance-gen` session left the cost ledger at 5 rows /
$0.0056 while the usage sidecar held 243 round trips / $2.69. The per-hop tool-audit buffer is
written only in the hop's `finally`, which does not run before `process.exit`, so that session's
tool-audit file was lost too.

## Design

### Integration

The baselines below exist only to locate the code. The **Target** lines are the interface to
implement; a baseline is never the interface.

**Read-only (verified, not changed):**

- `isNaxOwnedWritePath(rel: string): boolean` — `src/tools/nax-owned-writes.ts:79`. True for the
  root queue-control files (`QUEUE_CONTROL_FILES = {".queue.txt", ".queue.txt.processing"}`,
  `:67`) and for `.nax/features/**/prd.json`.
- `isNaxConfigFile(root: string, resolved: string): boolean` — `src/tools/nax-owned-writes.ts:34`.
- `naxOwnedWriteRefusal(tool, rel, exemptRel?)` — `src/tools/nax-owned-writes.ts:101`. The
  per-kind refusal text the Write/Edit tools already use; its wording is the precedent to mirror.
- `SCRATCHPAD_DIR = ".nax/scratchpad"` — `src/tools/scratchpad.ts:25`.
- `IDispatchEventBus.onDispatch` / `onDispatchError` — `src/runtime/dispatch-events.ts:255-258`.
  `CompleteDispatchEvent` (`:110`, `kind: "complete"`) carries `sessionName`, `sessionRole`,
  `agentName`, `stage`, `storyId`, and — via the manager's `buildCompleteEvent` — `tokenUsage`,
  `estimatedCostUsd`, `exactCostUsd`, `callId`, `scopeId`. `DispatchErrorEvent` (`:139`) carries
  `scopeId?`, `callId?`, `tokenUsage?`, `estimatedCostUsd?`, `exactCostUsd?`, `agentName`, `stage`,
  `storyId?` and **no** `sessionName`.
- `AgentStreamEventBase.callId` — `src/runtime/agent-stream-events.ts:11`: a stream-local UUID
  minted **per turn** by the adapter. `agent.call_started` (`:33`, carries `model`),
  `agent.usage_update` (`:49`), `agent.call_ended` (`:94`, `status: "success" | "error" |
  "cancelled" | "timeout"`).
- Native emits `agent.call_ended` with `status: "cancelled"` or `"error"` on its catch path and
  rethrows (`src/agents/native/adapter.ts:466-500`); on the normal path it emits `"success"`,
  `"timeout"` or `"cancelled"` after the turn resolves (`:511-516`). Native `agent.usage_update`
  beats carry `cadence: "round-trip"` and a per-round-trip `costUsd` delta
  (`src/agents/native/session/turn-events.ts:76-86`). ACP beats carry `cadence: "agent"`
  (`src/agents/acp/spawn-client-session.ts:236`).
- `CostAggregator.record(event: CostEvent)` and `drain()` — `src/runtime/cost-aggregator.ts`.
  `drain()` warns on open scopes and writes every recorded row (`:539-596`). `run.complete` and
  status.json read `totalSpendUsd(costAggregator.snapshot())` through `liveRunTotalCost`
  (`src/execution/runner.ts:257-262`), so any row recorded before `drain()` reaches the reported
  total with no further change.
- `resolveCodingToolSupport` creates the tool-audit sink through `buildCodingToolSupport`
  (`src/agents/coding-tool-support.ts:208-215`, header built at `:432-437` with `runId`); the
  sink is flushed in the hop `finally` (`src/runtime/session-run-hop.ts:220-230`,
  `src/operations/build-hop-callback.ts:573-583`). These three files are not changed by this
  spec: `coding-tool-support.ts` (596 lines) and `build-hop-callback.ts` (598) have almost no
  headroom under the 600-line gate, and registration inside `createToolAuditSink` makes threading
  unnecessary.

**Mutated:**

- Raw screen refusal text — `src/tools/policy-bash-raw.ts:132-150`.
  - Baseline: both the token branch and the redirect branch return
    `` `${tool} command names "${hit}", which nax owns and no tool may modify -- change it through nax rather than by writing its file` ``
    (redirect branch: "redirects into"), identical for every kind of nax-owned file.
  - Target: `protectedHit` returns the kind it matched alongside the token, and the refusal text
    comes from a new exported function in `src/tools/nax-owned-writes.ts`:

    ```ts
    export type NaxOwnedKind = "prd" | "queue" | "config";
    /**
     * Write-guard kind of a root-relative, posix-separated path: "prd" or "queue", or undefined.
     * Never returns "config" -- config files are detected by the lexical isNaxConfigFile pass.
     */
    export function naxOwnedKind(rel: string): "prd" | "queue" | undefined;
    /** Refusal text for a Bash command that names (verb "names") or redirects into (verb "redirects into") a nax-owned file. */
    export function naxOwnedBashRefusal(
      tool: string,
      kind: NaxOwnedKind,
      hit: string,
      verb: "names" | "redirects into",
    ): string;
    ```

    `isNaxOwnedWritePath(rel)` keeps its signature and becomes `naxOwnedKind(rel) !== undefined`.
    The refusal text must not contain the literal `.nax/features/` (the `check:feature-dir-ssot`
    gate covers `src/tools/`); it names the hit token the agent used. The `config` kind comes from the lexical `isNaxConfigFile` pass in
    `protectedHit`, which is checked first, exactly as today. The screen's allow/deny decision for
    every input is unchanged.

- `buildNaxArtifactsSection` — `src/prompts/sections/nax-artifacts.ts:21`. Signature unchanged;
  the returned text gains one paragraph (content below).
- `buildScratchpadSection` — `src/prompts/sections/scratchpad.ts:27`. Signature unchanged; the
  returned text gains the probe-script guidance (content below).
- `ScratchpadWrite` description — `src/tools/scratchpad.ts:39`. Baseline: "Use it for notes to
  yourself, command output you want to re-read, or intermediate lists." Target: that list also
  names a probe script to run against the project's code.
- `attachUsageAuditSubscriber` — `src/runtime/middleware/usage-audit.ts:30`.
  - Baseline: `attachUsageAuditSubscriber(bus: IAgentStreamEventBus, auditor: IUsageAuditor, runId: string): () => void`,
    switching only on `agent.usage_update`.
  - Target: `attachUsageAuditSubscriber(bus: IAgentStreamEventBus, dispatchEvents: IDispatchEventBus, auditor: IUsageAuditor, runId: string): () => void`.
    It additionally subscribes to `dispatchEvents.onDispatch` and records one row per
    `kind === "complete"` event: `input`/`output`/`cacheRead`/`cacheWrite` from `tokenUsage`
    (`inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`),
    `costUsd = exactCostUsd ?? estimatedCostUsd`, `cadence: "one-shot"`, `ts` from the event's
    `timestamp`, `scopeId`/`sessionName`/`storyId`/`stage`/`agentName` copied from the event, and
    `streamCallId` set to the event's `callId`, or the literal `"one-shot"` when the event has
    none. The returned function detaches both subscriptions. The single production caller is
    `src/runtime/index.ts:425`.
- `UsageAuditEntry.cadence` — `src/runtime/usage-auditor.ts:39`. Baseline:
  `"round-trip" | "agent"`. Target: `"round-trip" | "agent" | "one-shot"`.
- `CostEvent` — `src/runtime/cost-aggregator.ts:3`. Target: gains `readonly partial?: boolean`
  (absent on every existing row). The file is 597 lines against the 600-line gate and is not in
  the size baseline, so the field is one line with a doc comment of at most two lines. `COST_ROW_SCHEMA_VERSION` (`src/runtime/middleware/cost.ts:92`)
  goes from `6` to `7`, and the version doc block above it (`cost.ts:20-91`) records v7 as
  "adds `partial`".
- Runtime close — `src/runtime/index.ts:487-522`.
  - Baseline: detaches subscribers, closes managers, then
    `Promise.allSettled([promptAuditor.flush(), usageAuditor.flush(), reviewAuditor.flush(), costAggregator.drain()])`.
  - Target: `close()` detaches the in-flight tracker together with the other subscribers. After
    detaching and before that `allSettled`, `close()` (1) records every
    in-flight residual from the new tracker into `costAggregator` as a partial `CostEvent`, and
    (2) awaits `flushOpenToolAuditSinks(runId)`, imported through the `@/tools` barrel
    (`src/tools/index.ts` exports it; `.nax/rules/forbidden-patterns-source.md` bans deep imports).
    The `allSettled` set is unchanged. Tool calls a hop records after the partial flush are not
    written: the sink's later `flush()` is a no-op, and this only happens on the shutdown path.
- `createToolAuditSink` — `src/tools/tool-audit.ts:170`. Signature unchanged. Target: a sink whose
  `header.runId` is set registers itself in a module-level registry keyed by `runId` on creation
  and unregisters on its first `flush()`. `ToolAuditHeader` (`:163`) is unchanged; the written
  file body gains a top-level `partial: true` field only when written by the registry flush.

### New modules

**`src/runtime/in-flight-usage.ts`** — tracks spend of native turns that have not finished.

```ts
export interface InFlightResidual {
  readonly streamCallId: string;
  readonly agentName: string;
  readonly model: string;            // from agent.call_started; "unknown" if none was seen
  readonly sessionName: string;
  readonly storyId?: string;
  readonly stage?: string;
  readonly scopeId?: string;
  readonly tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  readonly costUsd: number;
  readonly roundTrips: number;
}

export interface InFlightUsageTracker {
  residuals(): readonly InFlightResidual[];
}

/** Subscribes to both buses; the returned `off` detaches both. */
export function attachInFlightUsageTracker(
  streamBus: IAgentStreamEventBus,
  dispatchEvents: IDispatchEventBus,
): { tracker: InFlightUsageTracker; off: () => void };

/** Maps one residual to a CostEvent with partial: true. */
export function toPartialCostEvent(residual: InFlightResidual, runId: string, projectKey?: string): CostEvent;
```

Rules, applied in this order per stream `callId`:

1. `agent.usage_update` with `cadence: "round-trip"` adds its `inputTokens`, `outputTokens`,
   `cacheRead`, `cacheWrite` and `costUsd` (each treated as 0 when absent) to that stream's entry,
   creating the entry if needed. `roundTrips` increments by one only when the beat carries a
   `roundTrip` field (compaction and retry beats carry none, `turn-events.ts:82-86`). Events with
   any other `cadence` (ACP's `"agent"`) are ignored.
2. `agent.call_started` records `model` on the entry (creating it if needed). An empty-string
   `model` (native sends `handle.modelDef?.model ?? ""`, `adapter.ts:315`) is stored as
   `"unknown"`, as is a stream that never saw `call_started`.
3. `agent.call_ended` with status `"success"` or `"timeout"` **deletes** the entry — the turn
   resolved, so its dispatch event records the spend.
4. `agent.call_ended` with status `"error"` or `"cancelled"` marks the entry **ended-unrecorded**,
   stamps it with an ended sequence number, and keeps it. Either the turn threw (whether its
   spend reaches the ledger then depends on the dispatch-error event), or — for `"cancelled"` on
   the native normal path, when the idle watchdog's turn controller fired but the turn still
   returned (`adapter.ts:511-516`) — the turn resolved and a session-turn dispatch follows.
5. The tracker remembers, per `sessionName`, the stream `callId` that most recently received any
   `agent.call_ended` (whatever its status). A session-turn `DispatchEvent`
   (`kind: "session-turn"`) deletes that remembered stream's entry only if it is still present
   and ended with status `"cancelled"` — the watchdog-cancelled turn resolved and its spend is on
   the session-turn row. A successful turn's entry is already gone by rule 3 (its `call_ended`
   precedes the dispatch event, `adapter.ts:511-516` before `manager.ts:478-490`), so the event
   then deletes nothing; older ended-unrecorded entries of the session are never touched by it.
6. A `DispatchErrorEvent` whose `tokenUsage` is present or whose
   `exactCostUsd ?? estimatedCostUsd` is greater than 0 deletes the **most recently ended**
   ended-unrecorded entry whose `scopeId` equals that event's `scopeId` or its `callId` — that
   turn's spend was recorded on the error row. Entries with no `scopeId` are never deleted by
   this rule.
7. `residuals()` returns every remaining entry (open or ended-unrecorded) whose `costUsd` is
   greater than 0 or whose token total is greater than 0.

Native stream events carry no `storyId` or `stage` on this path (`adapter.ts:299-305`), so the
tracker records them only when an event carries them; partial rows are attributed through
`sessionRole` instead.

`toPartialCostEvent` produces: `partial: true`, `schemaVersion: 7`, `ts` = now, `agentName`,
`model`, `sessionRole: deriveSessionRole(sessionName)` (`src/runtime/usage-auditor.ts:81`,
omitted when it returns `undefined`), `stage` and `storyId` when the residual has them,
`scopeId`, `callId` = the stream `callId`, `tokens`, `roundTrips`,
`roundTripUnit: "model-call"`, `costUsd` = `estimatedCostUsd` = `exactCostUsd` = the residual's
`costUsd` (matching how the cost subscriber normalises estimated rows, `cost.ts:121`),
`confidence: "estimated"`, `durationMs: 0`, and no `pricingSource`.

The tracker is attached in `createRuntime` next to the other subscribers, whether or not
`agent.usageAudit.enabled` is set — it does not read the usage sidecar file.

**`src/tools/tool-audit-registry.ts`** — open tool-audit sinks per run.

```ts
export function registerToolAuditSink(runId: string, sink: RegisteredSink): void;
export function unregisterToolAuditSink(runId: string, sink: RegisteredSink): void;
/** Flushes every still-registered sink for runId with partial: true, then clears them. */
export async function flushOpenToolAuditSinks(runId: string): Promise<void>;
```

`RegisteredSink` is the internal interface `createToolAuditSink` returns plus a
`flushPartial(): Promise<void>` method. After `flushPartial()` runs, that sink's own `flush()`
is a no-op, so a hop `finally` that runs later writes no second file.

### Prompt and refusal text

These are the target texts. Wording may be polished; each bullet under "must state" is a
requirement.

**Raw-screen refusal, `prd` kind** — must state: the command names (or redirects into) the file;
the file is the story's acceptance criteria and nax updates it itself during the run, so it
shows as modified; any Bash command naming it is refused, reads included; leave it as is; to view
it, use the `Read` tool.

**Raw-screen refusal, `queue` kind** — must state: the file is nax's run-control queue; any Bash
command naming it is refused, reads included; change the run through the queue command.

**Raw-screen refusal, `config` kind** — must state: the file is nax configuration; any Bash
command naming it is refused, reads included; nax configuration is not changed from inside a run.

**`buildNaxArtifactsSection` added paragraph** — must state: nax updates
`.nax/features/<feature>/prd.json` itself during a run, so it shows as modified in `git status`;
do not diff or revert it; the story's criteria are already in this prompt, and if its contents
are needed, read it with the `Read` tool; shell commands that name it may be refused. (The
section is also sent to ACP agents and gated-mode runs, where the raw screen does not apply, so
it says "may be refused", not "are refused".)

**`buildScratchpadSection` added text** — must state: to try a snippet that imports project code
or dependencies, write it under `.nax/scratchpad/` with `ScratchpadWrite` and run it from there;
relative imports resolve from `.nax/scratchpad/`, so prefer the project's package names or path
aliases where it has them; scripts written outside the repository, such as in `/tmp`, cannot
resolve the project's modules, and the file tools cannot write there.

### Failure Handling

| Situation | Behaviour |
|:---|:---|
| `flushOpenToolAuditSinks` rejects for one sink | Logged as a warning (`"tools"`, `"tool-audit partial flush failed"`); the other sinks still flush; `close()` continues to the drain. |
| A partial `CostEvent` cannot be built (residual has no `agentName`) | Not possible: `agentName` is on every stream event. No guard. |
| A one-shot `complete` event has no `tokenUsage` and cost 0 | No usage row is written, matching the cost subscriber, which also skips it (`cost.ts:135`). |
| `close()` is called twice | Idempotent as today; the second call returns before any residual is recorded. |

## Out of Scope

- Changing which commands the raw Bash screen allows or denies. Only the refusal text changes; every allow/deny decision stays identical.
- Changing the gated-mode Bash policy, the sandbox writable roots, or path containment for `/tmp`. nax#2228 is a prompt-only fix.
- Excluding `.nax/scratchpad/` from any quality gate. In this repository `lint:biome` covers only `src/ bin/ test/ scripts/` and tsc includes only `src` and `bin`, so a probe script there is not linted; repositories whose lint covers every file may lint it.
- Partial cost rows for ACP turns. ACP `agent.usage_update` beats may carry running totals rather than per-beat deltas, and that semantics is unverified; the in-flight tracker ignores `cadence: "agent"` beats.
- Writing an `exit-summary` line on the SIGINT path. None is written there today; `run.complete` and status.json carry the total.
- Changing the shipped default of `agent.usageAudit.enabled` (false).
- Bumping `TOOL_AUDIT_SCHEMA_VERSION`. The `partial` field is additive and optional.
- Changing `src/agents/coding-tool-support.ts`, `src/runtime/session-run-hop.ts` or `src/operations/build-hop-callback.ts`. Tool-audit sinks register themselves inside `createToolAuditSink`, so no sink needs to be threaded through these files, and two of them sit at 596-598 lines against the 600-line gate.
- US-004 only: tool-audit sinks whose header `runId` differs from the runtime's own `runId` (a hop given a foreign `runId`, `session-run-hop.ts:32`) are not flushed by that runtime's `close()`.
- Reconciling the residual difference between the usage sidecar and the cost ledger on a completed run beyond what one-shot rows and partial rows close.
- US-003 only: turns whose stream events carry no `scopeId` and end with `error`/`cancelled` while a dispatch-error row also records their spend may be counted twice (once on the error row, once as partial). Only native protocol-fault errors carry spend, and native beats carry a `scopeId` whenever the op has one. Likewise, a one-shot `completeAs` error row sharing a `scopeId` with an ended session turn may clear that turn's entry.

## Stories

**US-001 — Tell agents the truth about nax-owned files and where probe scripts go** (no dependencies)
Kind-specific raw-screen refusal text and the `prd.json` paragraph (nax#2226); probe-script
guidance in the scratchpad section and the `ScratchpadWrite` description (nax#2228).

**US-002 — One-shot dispatches write a usage row** (no dependencies)
`attachUsageAuditSubscriber` records a `cadence: "one-shot"` row for every `complete` dispatch
event (nax#2059).

**US-003 — Track spend of in-flight native turns** (no dependencies)
`in-flight-usage.ts` tracker and `toPartialCostEvent`; `CostEvent.partial`;
`COST_ROW_SCHEMA_VERSION` 6 → 7 (nax#2225, cost half, part 1).

**US-004 — Flush open tool-audit buffers at close** (no dependencies)
`tool-audit-registry.ts`, self-registering sinks, partial flush in `close()` (nax#2225, tool-audit
half).

**US-005 — Record in-flight spend as partial cost rows at close** (depends on US-002, US-003, US-004)
`createRuntime` attaches the tracker; `close()` records its residuals as partial `CostEvent`s
before the drain (nax#2225, cost half, part 2).

### Context Files

**US-001**
- `src/tools/policy-bash-raw.ts` — `protectedHit` and both refusal branches.
- `src/tools/nax-owned-writes.ts` — `isNaxOwnedWritePath`, `isNaxConfigFile`, and `naxOwnedWriteRefusal` as the wording precedent.
- `src/prompts/sections/nax-artifacts.ts` — section to extend.
- `src/prompts/sections/scratchpad.ts` — section to extend.
- `src/tools/scratchpad.ts` — `ScratchpadWrite` description at line 39.

**US-002**
- `src/runtime/middleware/usage-audit.ts` — subscriber to extend.
- `src/runtime/usage-auditor.ts` — `UsageAuditEntry` shape.
- `src/runtime/dispatch-events.ts` — `CompleteDispatchEvent` and `IDispatchEventBus`.
- `src/agents/manager-dispatch.ts` — `buildCompleteEvent`, which fills `tokenUsage` and cost fields.
- `src/runtime/index.ts` — production caller at line 425.

**US-003**
- `src/runtime/agent-stream-events.ts` — stream event types.
- `src/runtime/dispatch-events.ts` — `DispatchErrorEvent`.
- `src/runtime/cost-aggregator.ts` — `CostEvent`, `record`, `drain`.
- `src/runtime/middleware/cost.ts` — `COST_ROW_SCHEMA_VERSION` and how rows are built from dispatch events.

**US-004**
- `src/tools/tool-audit.ts` — `createToolAuditSink`, `ToolAuditHeader`.
- `src/runtime/index.ts` — `close()`.
- `src/agents/coding-tool-support.ts` — where the sink is created with `header.runId` (read only; not changed).

**US-005**
- `src/runtime/in-flight-usage.ts` — created by US-003, wired here.
- `src/runtime/index.ts` — `createRuntime` subscriber wiring and `close()`.
- `src/runtime/cost-aggregator.ts` — `record`, `drain`, `snapshot`.
- `src/execution/runner.ts` — `liveRunTotalCost` read of the aggregator (read only).

### Creates

**US-003**
- `src/runtime/in-flight-usage.ts` — the in-flight tracker and `toPartialCostEvent`.
- `test/unit/runtime/in-flight-usage.test.ts` — tracker rules.

**US-004**
- `src/tools/tool-audit-registry.ts` — the per-run sink registry.
- `test/unit/tools/tool-audit-registry.test.ts` — registry and partial-flush behaviour.

**US-005**
- `test/unit/runtime/runtime-close-partial.test.ts` — `close()` records partial rows before the drain. New file because `test/unit/runtime/runtime.test.ts` is 611 lines and `test/unit/execution/lifecycle/run-setup.test.ts` is 772 against the 800-line test gate.

### Modifies

**US-001**
- `test/unit/prompts/__snapshots__/rectifier-builder.test.ts.snap` — the snapshot embeds the full text of `buildNaxArtifactsSection` and `buildScratchpadSection`, both of which gain a paragraph. The replacing invariant: the snapshot is regenerated and differs from the old one only by the added paragraphs.
- `test/unit/prompts/__snapshots__/review-builder.test.ts.snap` — the snapshot embeds the full text of `buildScratchpadSection`, which gains the probe-script guidance. The replacing invariant: the snapshot is regenerated and differs from the old one only by the added text.
- `test/unit/prompts/builders/__snapshots__/rectifier-builder-helpers.test.ts.snap` — the snapshot embeds the full text of both sections. The replacing invariant: the snapshot is regenerated and differs from the old one only by the added paragraphs.

**US-002**
- `test/unit/runtime/middleware/usage-audit.test.ts` — its calls to `attachUsageAuditSubscriber` pass three arguments `(bus, auditor, runId)`; the target signature inserts `dispatchEvents` as the second parameter. The replacing invariant: every existing call passes a `DispatchEventBus` as the second argument and its existing stream-event assertions are unchanged.
- `test/unit/runtime/middleware/agent-stream-logging.test.ts` — line 293 calls `attachUsageAuditSubscriber(bus, auditor, "r-001")` with three arguments; the target signature inserts `dispatchEvents` as the second parameter. The replacing invariant: the call passes a `DispatchEventBus` as the second argument and the test's assertions are unchanged.

**US-003**
- `test/unit/runtime/middleware/cost.test.ts` — lines 588-589, 701 and 714 pin `schemaVersion` and `COST_ROW_SCHEMA_VERSION` to the literal `6`. The replacing invariant: they pin `7`, the version that adds `partial`.
- `test/unit/runtime/middleware/cost-rate-provenance.test.ts` — lines 133-134, 146, 638-639 and 651 pin `schemaVersion` and `COST_ROW_SCHEMA_VERSION` to the literal `6`, and the comments at lines 8 and 470 name version 6. The replacing invariant: they pin and name `7`.

**US-004**
None. The registry is new, `createToolAuditSink`'s signature is unchanged, and no existing test asserts the absence of a top-level `partial` field or that `close()` writes no tool-audit file.

**US-005**
None. The change to `close()` adds steps before the existing flush/drain set; no existing test asserts what `close()` records into the aggregator or pins its step order.

### Seams

- **US-002 → `createRuntime`.** The subscriber's new `dispatchEvents` parameter must be supplied by the production caller at `src/runtime/index.ts:425`. US-002's integration criterion drives a runtime created by `createRuntime` and emits a `complete` dispatch on `runtime.dispatchEvents`, not a directly attached subscriber.
- **US-002, US-004 → US-005 (ordering only).** All three edit adjacent code in `src/runtime/index.ts` (the subscriber block near line 425 and the steps before `close()`'s `allSettled`), so US-005 runs after US-002 and US-004 to avoid conflicting edits.
- **US-003 → US-005.** US-003 exports `attachInFlightUsageTracker` and `toPartialCostEvent`; US-005 calls both from `createRuntime` and `close()`.
- **US-005 → `createRuntime` / `close()`.** The tracker is attached inside `createRuntime` and read inside `close()`. US-005's integration criterion creates a runtime, emits stream events on its agent-stream bus, calls `close()`, and reads the drained cost file.
- **US-004 → `createToolAuditSink` / `close()`.** Registration happens inside `createToolAuditSink`, and the flush inside `close()`. US-004's integration criterion creates a sink with a `runId` header through `createToolAuditSink`, records a call, and calls `close()` on a runtime with that `runId`.

## Acceptance Criteria

### US-001 — Tell agents the truth about nax-owned files and where probe scripts go

1. [unit] `naxOwnedKind(".nax/features/f/prd.json")` returns `"prd"`, `naxOwnedKind(".queue.txt")` returns `"queue"`, `naxOwnedKind(".queue.txt.processing")` returns `"queue"`, and `naxOwnedKind("src/prd.json")` returns `undefined`.
2. [unit] `naxOwnedKind(".nax/config.json")` returns `undefined`, and `naxOwnedWriteRefusal("Write", ".nax/config.json")` returns the same value as before this story.
3. [unit] `screenRawBashCommand` with command `git diff .nax/features/f/prd.json` returns `deny`, and its reason states that nax updates the file itself during the run, that Bash commands naming it are refused including reads, and that the `Read` tool can view it.
4. [unit] `screenRawBashCommand` with command `echo x > .nax/features/f/prd.json` returns `deny`, and its reason says the command redirects into the file and states that nax updates it itself during the run.
5. [unit] `screenRawBashCommand` with command `cat .queue.txt` returns `deny`, and its reason names the file as the run-control queue, states reads are refused, and points to the queue command; it does not mention the `Read` tool.
6. [unit] `screenRawBashCommand` with command `cat .nax/config.json` returns `deny`, and its reason names the file as nax configuration and states reads are refused; it does not mention the `Read` tool.
7. [unit] For every command in the existing `policy-bash-raw` suite, `screenRawBashCommand` returns the same `kind` (`allow` or `deny`) as before this story.
8. [unit] `buildNaxArtifactsSection("implementer")` states that nax updates `.nax/features/<feature>/prd.json` itself during a run so it shows as modified, that the agent must not diff or revert it, that the `Read` tool can read it if its contents are needed, and that shell commands naming it may be refused.
9. [unit] `buildScratchpadSection()` states that a snippet importing project code or dependencies should be written under `.nax/scratchpad/` with `ScratchpadWrite` and run from there.
10. [unit] `buildScratchpadSection()` states that scripts written outside the repository, naming `/tmp`, cannot resolve the project's modules and that the file tools cannot write there.
11. [unit] The `ScratchpadWrite` tool's `description` names a probe script to run against the project's code as one of the scratchpad's uses.

### US-002 — One-shot dispatches write a usage row

1. [unit] With `attachUsageAuditSubscriber(bus, dispatchEvents, auditor, "run-1")` attached, emitting a `complete` dispatch event with `tokenUsage {inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5, cacheCreationInputTokens: 1}` and `exactCostUsd: 0.01` records exactly one `UsageAuditEntry` with `input: 100`, `output: 20`, `cacheRead: 5`, `cacheWrite: 1`, `costUsd: 0.01` and `cadence: "one-shot"`.
2. [unit] A `complete` event with `exactCostUsd` absent and `estimatedCostUsd: 0.02` records a row with `costUsd: 0.02`.
3. [unit] The recorded one-shot row carries the event's `scopeId`, `sessionName`, `storyId`, `stage` and `agentName`, and `streamCallId` equal to the event's `callId`.
4. [unit] A `complete` event with no `callId` records a row whose `streamCallId` is `"one-shot"`.
5. [unit] Emitting a `session-turn` dispatch event records no usage row.
6. [unit] A `complete` event with no `tokenUsage` and a cost of 0 records no usage row.
7. [unit] Calling the function returned by `attachUsageAuditSubscriber` detaches both subscriptions: a later `complete` dispatch event and a later `agent.usage_update` event each record nothing.
8. [integration] On a runtime built by `createRuntime` with `agent.usageAudit.enabled: true`, emitting a `complete` event on `runtime.dispatchEvents` and calling `close()` leaves one row with `cadence: "one-shot"` in `usage/<runId>.jsonl`.

### US-003 — Track spend of in-flight native turns

1. [unit] Two `agent.usage_update` events with `cadence: "round-trip"` on stream `callId` `c1`, costs `0.10` and `0.15`, followed by no `agent.call_ended`, make `residuals()` return one entry for `c1` with `costUsd` `0.25` and `roundTrips` `2`.
2. [unit] Token fields add up per stream: two beats with `inputTokens` 10 and 30 give a residual with `tokens.input` 40, and a beat with `cacheRead` absent contributes 0 to `tokens.cacheRead`.
3. [unit] `agent.call_started` with `model: "m1"` on stream `c1` makes the residual for `c1` carry `model: "m1"`; a stream with no `call_started`, or whose `call_started` carried `model: ""`, carries `model: "unknown"`.
4. [unit] `agent.call_ended` with status `"success"` on `c1` removes `c1` from `residuals()`.
5. [unit] `agent.call_ended` with status `"timeout"` on `c1` removes `c1` from `residuals()`.
6. [unit] `agent.call_ended` with status `"cancelled"` on `c1` leaves `c1` in `residuals()`.
7. [unit] After `c1` (sessionName `n1`) ends with status `"cancelled"`, a `session-turn` dispatch event with `sessionName: "n1"` removes `c1` from `residuals()`.
8. [unit] When `c1` (sessionName `n1`) ends with status `"error"` and then `c2` (sessionName `n1`) ends with status `"success"`, a `session-turn` dispatch event with `sessionName: "n1"` leaves `c1` in `residuals()`.
9. [unit] Two beats on `c1` where only the first carries a `roundTrip` field give a residual with `roundTrips` `1`.
10. [unit] After `c1` (scopeId `s1`) ends with status `"error"`, a `DispatchErrorEvent` with `scopeId: "s1"` and `tokenUsage` present removes `c1` from `residuals()`.
11. [unit] When `c1` then `c2` (both scopeId `s1`) end with status `"error"` in that order, one `DispatchErrorEvent` with `scopeId: "s1"` and `tokenUsage` present removes `c2` and leaves `c1` in `residuals()`.
12. [unit] After `c1` (scopeId `s1`) ends with status `"error"`, a `DispatchErrorEvent` with `callId: "s1"`, no `scopeId`, and `exactCostUsd: 0.05` removes `c1` from `residuals()`.
13. [unit] After `c1` (scopeId `s1`) ends with status `"error"`, a `DispatchErrorEvent` with `scopeId: "s1"`, no `tokenUsage` and zero cost leaves `c1` in `residuals()`.
14. [unit] A `DispatchErrorEvent` with `scopeId: "s1"` and `tokenUsage` present does not remove a still-open stream (no `call_ended` yet) with scopeId `s1`.
15. [unit] `agent.usage_update` events with `cadence: "agent"` produce no entry in `residuals()`.
16. [unit] A stream whose only beats have cost 0 and zero tokens is absent from `residuals()`.
17. [unit] `toPartialCostEvent` maps a residual with `sessionName` `"feat-US-001-acceptance-gen"` to a `CostEvent` with `partial: true`, `schemaVersion: 7`, `sessionRole: "acceptance-gen"`, `costUsd`, `estimatedCostUsd` and `exactCostUsd` all equal to the residual's `costUsd`, `confidence: "estimated"`, `roundTripUnit: "model-call"`, `callId` equal to the stream `callId`, and no `pricingSource`.
18. [unit] `toPartialCostEvent` for a residual whose `sessionName` maps to no known role produces a `CostEvent` with no `sessionRole` field.
19. [unit] `COST_ROW_SCHEMA_VERSION` is `7`, and a successful session-turn dispatch recorded by `attachCostSubscriber` has no `partial` field.

### US-004 — Flush open tool-audit buffers at close

1. [unit] A sink created by `createToolAuditSink` with `header.runId: "r1"` that has recorded one call and not been flushed is written by `flushOpenToolAuditSinks("r1")` as one file whose body has `partial: true` and contains that call.
2. [unit] After `flushOpenToolAuditSinks("r1")`, calling that sink's own `flush()` writes no second file.
3. [unit] A sink whose own `flush()` already ran is not written again by a later `flushOpenToolAuditSinks("r1")`.
4. [unit] A sink with no recorded calls produces no file from `flushOpenToolAuditSinks("r1")`.
5. [unit] `flushOpenToolAuditSinks("r1")` does not flush a sink registered under `runId` `"r2"`.
6. [unit] A sink's normal `flush()` writes a body with no `partial` field.
7. [unit] When one registered sink's write rejects, `flushOpenToolAuditSinks` still writes the other sinks for that `runId`, logs a warning with message `"tool-audit partial flush failed"`, and resolves.
8. [unit] `flushOpenToolAuditSinks` is importable from the `@/tools` barrel and flushes a sink registered through `createToolAuditSink`.
9. [unit] A sink created without `header.runId` is never registered: `flushOpenToolAuditSinks` for any `runId` writes nothing for it.
10. [integration] With a runtime built by `createRuntime` and a sink created by `createToolAuditSink` with `header.runId` set to that runtime's `runId` and holding one recorded call, calling `runtime.close()` writes one tool-audit file with `partial: true` into the sink's directory.

### US-005 — Record in-flight spend as partial cost rows at close

1. [integration] On a runtime built by `createRuntime` with `agent.usageAudit.enabled: false`, emitting `agent.call_started` and two `cadence: "round-trip"` `agent.usage_update` events (costs `0.4` and `0.6`) on the runtime's agent-stream bus, then calling `close()`, leaves exactly one row with `partial: true` and `costUsd` `1.0` in `cost/<runId>.jsonl`.
2. [integration] In the same setup, `totalSpendUsd(runtime.costAggregator.snapshot())` read after `close()` includes the `1.0` partial spend.
3. [integration] On a runtime where the in-flight stream received `agent.call_ended` with status `"success"` before `close()`, `cost/<runId>.jsonl` is either absent or contains no row with `partial: true`.
4. [integration] Calling `close()` a second time adds no further partial row.
