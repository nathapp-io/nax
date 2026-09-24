# SPEC: Native turn cancellation — stop means stop

## Summary

When a native turn is cancelled (idle watchdog, whole-turn deadline, caller abort) or a Bash/Exec
call times out, nothing further runs. The turn's cancel signal is threaded from the native adapter
through the tool batch, the coding-tool runtime and the ask chain down to `runArgv`. The batch
stops dispatching tool calls once the signal fires, a pending human approval settles as a new
`cancelled` decision instead of executing, a running command's process group is killed, and a
background process that keeps the output pipe open is killed shortly after its shell exits
instead of blocking the call. A keep-alive while a human decides stops the idle watchdog from
cancelling a turn that is legitimately waiting. Design record:
`docs/superpowers/specs/2026-09-24-native-turn-cancellation-design.md`.

## Motivation

Three findings from the P0-P5 cross-phase review (2026-09-24), verified on `main` @ `866a90066`:

**Abort ignored during a pending human ask (review #6, MEDIUM).** `runToolBatch`
(`src/agents/native/session/turn-tool-batch.ts`) never consults a signal between tool calls. The
native adapter's watchdog cancel handle is `turnController` (`src/agents/native/adapter.ts:291`),
and only `complete()` and `summarize()` combine it into their signal. The human ask link
(`src/interaction/ask-link.ts`) listens only to the story-level `abortSignal` it was built with. A
watchdog cancel while an approval prompt is open therefore lets the human's later approval run the
command, runs the next tool call in the same batch, and only then fails the turn at the next
`complete()`, discarding both results. Reproduced: `make deploy` and `git push --force` both
executed after the cancel. Nothing emits activity while an ask is pending, so an
`execution.approvalTimeout` above 900 s is cut short by the idle watchdog's default
`idleTimeoutSeconds` of 900.

**A background child defeats the Bash/Exec deadline (review #7, MEDIUM).** `runArgv`
(`src/utils/argv-exec.ts`) clears its kill timer as soon as the shell exits, then awaits
stdout/stderr end-of-file with no deadline. A background process that inherited the pipe keeps it
open: `sh -c 'sleep 8 & echo started'` with `timeoutMs: 1500` returns after about 8 s, and a daemon
never returns. This holds with the sandbox on or off.

**The abort never reaches Bash/Exec processes (review #16, LOW).** `RunArgvOptions`,
`LaunchRequest` and `ToolRunContext` carry no signal, so an aborted story's command runs until its
own deadline (up to 300 s).

## Design

### Turn signal (US-002)

The native adapter builds one `turnSignal` per turn, next to `turnController`:
`AbortSignal.any` over the caller's `opts.signal` (when present), `turnController.signal`, and a
deadline controller aborted by a `setTimeout` armed with `deadline.remainingMs()` (when defined).
The deadline timer is cleared when the turn settles. `turnSignal` is passed to `runNativeTurn` as
`TurnDeps.signal`. `complete()` and `summarize()` keep their own per-call timers and combine them
with `turnSignal` instead of repeating `opts.signal` and `turnController.signal`.

`runToolBatch` reads `deps.signal`. At the top of each iteration of its call loop, before the
`onActivity` tool beat, if the signal is aborted it answers this call and every later call in the
batch with a synthetic tool result whose content is `Not run: the turn was cancelled.` and
`isError: true`, then breaks. This mirrors the spin-breaker `terminate` branch: every outstanding
`tool_call` is answered, and no `after_tool` event fires for a synthetic answer. `ToolBatchResult`
gains `cancelled: boolean`. When `cancelled` is true, `runNativeTurn` throws `deps.signal.reason`,
or a `DOMException` named `AbortError` when the reason is undefined, which reaches the existing
catch (save, rethrow) unchanged. A call already executing when the signal fires finishes through
its own path; the check applies from the next iteration.

The batch adds `signal` (from `deps.signal`) to the coding-tool interaction request, and US-004
adds `onWaiting`. `buildRunInteractionHandler` copies both into the `ToolCallContext` it passes to
`runtime.callTool`, and `runTool` passes `signal` into the tool's `ToolRunContext`.

### Ask cancellation (US-003) and keep-alive (US-004)

The per-request signal and keep-alive callback travel in a new second argument, never in
`AskRequest`: `AskRequest` is serialized verbatim into approval-audit rows
(`src/interaction/dispatch-ask.ts`, `request: req`) and persisted by `onRemember`, and a signal or
function does not belong in either.

```ts
// src/permissions/ask-chain.ts
export interface AskControl {
  /** Aborts when the turn that asked is cancelled. */
  readonly signal?: AbortSignal;
  /** Called while a human prompt for this request is pending. */
  readonly onWaiting?: () => void;
}
export interface AskLink {
  readonly name: string;
  resolve(req: AskRequest, control?: AskControl): Promise<AskLinkOutcome>;
}
export interface AskResolver {
  readonly humanReachable?: boolean;
  resolve(req: AskRequest, control?: AskControl): Promise<AskVerdict>;
}
```

`chainAskLinks` passes `control` to every link. The `askResolver` built by
`buildDispatchAskWiring` passes `control` to its base resolver and still writes the audit row from
`req` alone. `callTool` (`src/tools/runtime.ts`) calls
`askResolver.resolve(req, { signal: context?.signal, onWaiting: context?.onWaiting })`, and after an
`allow` verdict checks `context?.signal?.aborted` before `runTool`. An aborted signal there logs
`denied:ask` with the cancelled reason and returns `{ kind: "denied", breach: false }`.

`AskDecidedBy` gains `"cancelled"`. The file-local `askDenyReason` in `src/tools/runtime.ts` maps
`"cancelled"` to `Not run: the turn was cancelled before anyone answered.`

The human link (`createHumanAskLink`) keeps one shared in-flight entry per key
(`stage + "\u0000" + command`) and its one-prompt-at-a-time queue. Each `resolve(req, control)`
call becomes a waiter on the entry, and the entry counts live waiters:

1. A waiter whose `control.signal` is already aborted settles
   `{ decision: "deny", decidedBy: "cancelled" }` immediately and does not join.
2. A waiter whose `control.signal` aborts later settles `cancelled`; its abort listener is removed
   when it settles, and the live count drops by one.
3. When the live count reaches zero while the entry's prompt is on screen, the prompt is cancelled
   through the existing `cancel()` path, which calls `chain.cancel(id)`.
4. When the live count reaches zero while the entry is still queued, the entry is never prompted.
5. A human answer settles every live waiter with that answer.
6. The link-level `abortSignal` option keeps its current behaviour.

Keep-alive: the link calls every live waiter's `control.onWaiting` once when the prompt is sent and
then every `ASK_KEEPALIVE_MS` (60,000) until the prompt settles, using a re-armed, cancellable
`setTimeout` (project rule: no `setInterval` in `src/`), cleared on every settle path. The batch
supplies `onWaiting: () => deps.onActivity?.({ kind: "awaiting_human" })`. `NativeTurnActivity`
gains `{ kind: "awaiting_human" }`, which `buildNativeStreamEvent` maps to a new
`AgentStreamEvent` member `AgentAwaitingHumanEvent` (`kind: "agent.awaiting_human"`). The idle
watchdog handles `agent.awaiting_human` without consulting `activityKinds`: it sets
`lastActivityAt` and `lastNonToolCallActivityAt` to the event timestamp and clears the grace
period. The cache link and the approvals link never wait and never call `onWaiting`.

### Process lifecycle (US-001)

All `runArgv` callers get this behaviour: the sandbox launcher (wrapped and unwrapped), the
sandbox probe, the Bash and Exec fallback paths, and dependency install
(`src/worktree/dependencies.ts`).

- `RunArgvOptions` gains `signal?: AbortSignal`.
- `ArgvExecResult` gains `aborted?: boolean` and `orphansKilled?: boolean`. They are optional in the
  type so existing test doubles stay valid; `runArgv` itself always sets both.

`runArgv` lifecycle:

1. `signal` already aborted: `_argvExecDeps.spawn` is not called; the result is
   `{ exitCode: -1, stdout: "", stderr: "", timedOut: false, aborted: true, orphansKilled: false }`.
2. stdout and stderr are read incrementally and concurrently (a reader per stream collecting
   chunks), so a full pipe never blocks the child, partial output survives a kill, and the readers
   can be cancelled.
3. The timeout stays armed until the process has exited and both streams are drained. On expiry:
   `killProcessGroup(pid, "SIGKILL")`, cancel both readers, `timedOut: true`.
4. Abort: the same kill and reader cancel, `aborted: true`. The listener is registered with
   `{ once: true }` and removed when the call settles.
5. Drain grace: after the process exits, both streams get `DRAIN_GRACE_MS` (500) to reach
   end-of-file. If either is still open: `killProcessGroup(pid, "SIGKILL")`, cancel the readers,
   `orphansKilled: true`, and return the real exit code with the output read so far.
6. The MEM-4, BUG-13 and concurrent-drain invariants in the module header stay true and remain
   documented there. If `argv-exec.ts` passes about 250 lines, the incremental reader moves to its
   own module under `src/utils/`.

`DRAIN_GRACE_MS` and `ASK_KEEPALIVE_MS` are internal mechanism constants, not user tunables, in
the same class as `PROBE_TIMEOUT_MS` in `src/sandbox/probe.ts`; each is injectable through its
module's `_deps` object for tests.

`LaunchRequest` gains `signal?: AbortSignal`, passed to `runArgv` on both launcher paths.
`ToolRunContext` gains `signal?: AbortSignal`. `bash.ts` and `run-command-exec.ts` pass
`ctx.signal` to the launcher and to their `runArgv` fallback. Tool results:

- `aborted`: `isError: true`, content starting `Cancelled: the turn ended while this command was running.`
  followed by the output read so far.
- `orphansKilled`: the normal result plus a final line
  `[nax] background processes still holding the output were killed when the command exited. Commands cannot leave processes running; start a server and test it in the same command.`

Every Bash tool description variant gains one sentence stating that background processes still
holding the command's output are killed when the command exits.

### Integration

Read-only symbols (verified at `866a90066`):

- `killProcessGroup(pid, signal)` — `src/utils/process-kill.ts`, via `_argvExecDeps`
- `createCommandLauncher(opts): CommandLauncher` — `src/sandbox/launcher.ts:93`
- `buildDispatchAskWiring(opts, deps?): Promise<DispatchAskWiring>` — `src/interaction/dispatch-ask.ts:95`
- `appendApprovalAudit(dir, runId, row)` — `src/permissions/approval-audit.ts:27`
- `resolveIdleWatchdogSettings`, the watchdog `onAgentStream` switch — `src/runtime/middleware/idle-watchdog/index.ts`
- `waitForCondition`, `waitForFile`, `makeTempDir`, `cleanupTempDir`, `withDepsRestore` — `@test/helpers`

Symbols this feature changes. The baseline exists only to locate the code; it is never the
interface to implement.

- `runArgv` (`src/utils/argv-exec.ts:57`)
  - Baseline: clears the kill timer at process exit, then awaits both streams with no deadline.
  - Target: section "Process lifecycle"; honours `signal`; sets `aborted` and `orphansKilled`.
- `RunArgvOptions`, `ArgvExecResult` (`src/utils/argv-exec.ts:14`, `:30`)
  - Target: `signal?: AbortSignal`; `aborted?: boolean`, `orphansKilled?: boolean`.
- `LaunchRequest` (`src/sandbox/types.ts:62`)
  - Target: adds `signal?: AbortSignal`.
- `ToolRunContext` (`src/tools/registry.ts:50`)
  - Target: adds `signal?: AbortSignal`.
- `ToolCallContext` (`src/tools/runtime.ts:75`)
  - Target: adds `signal?: AbortSignal` and `onWaiting?: () => void`.
- `AdapterInteraction` `coding-tool` member (`src/agents/interaction-handler.ts`)
  - Target: adds `signal?: AbortSignal` and `onWaiting?: () => void`.
- `TurnDeps` (`src/agents/native/session/turn-types.ts:53`)
  - Target: adds `signal?: AbortSignal`.
- `ToolBatchResult` (`src/agents/native/session/turn-tool-batch.ts`)
  - Target: adds `cancelled: boolean`.
- `AskDecidedBy`, `AskLink.resolve`, `AskResolver.resolve`, `chainAskLinks` (`src/permissions/ask-chain.ts`)
  - Baseline: `resolve(req)`; decision sources `cache | model | human | timeout | unavailable`.
  - Target: `resolve(req, control?)` with the new `AskControl`; adds `"cancelled"`.
- `createHumanAskLink` (`src/interaction/ask-link.ts:56`)
  - Baseline: one shared promise per key; cancellation only through the link-level `abortSignal`.
  - Target: waiter counting and keep-alive as in section "Ask cancellation and keep-alive".
- `NativeTurnActivity`, `buildNativeStreamEvent` (`src/agents/native/session/turn-events.ts`)
  - Target: adds `awaiting_human`, mapped to `agent.awaiting_human`.
- `AgentStreamEvent` (`src/runtime/agent-stream-events.ts`)
  - Target: adds `AgentAwaitingHumanEvent`.

### Failure Handling

| Condition | Behavior |
|:--|:--|
| Turn signal aborts between tool calls | Remaining calls answered `Not run: the turn was cancelled.`; the turn rejects with the signal's reason |
| Turn signal aborts while a human ask is pending | That waiter settles `cancelled`; the tool does not run; the prompt is cancelled when no live waiter remains |
| Approval arrives after the turn signal aborted | `denied:ask` with the cancelled reason; the tool does not run |
| Turn signal aborts while a command runs | Process group SIGKILLed; `Cancelled:` tool result with partial output |
| Background process keeps the output pipe open after the shell exits | Process group SIGKILLed after `DRAIN_GRACE_MS`; normal result plus the `[nax] background processes` line |
| Timeout expires while streams are still draining | Process group SIGKILLed; `timedOut: true` |
| Signal already aborted when `runArgv` is called | Nothing is spawned; `aborted: true` |

## Out of Scope

- `ask_human` questions answered over the `interactionBridge` do not observe the turn signal; they are not command approvals.
- Processes that leave the process group (`setsid()`, double-fork) and close their stdio survive a Bash/Exec call; closing that gap needs a sandbox- or cgroup-level reaper.
- The human ask link's dedupe key (`stage` + command, shared by command-less asks) is not changed; only the cancellation of one waiter among several is handled.
- The link-level `abortSignal` of `createHumanAskLink` keeps settling a cancelled prompt as `unavailable`; relabelling it is not part of this feature.
- `DRAIN_GRACE_MS` and `ASK_KEEPALIVE_MS` are not exposed as configuration.
- Context-pull tools do not receive the turn signal.
- ACP agents are not changed; only the native agent's turn loop, runtime, ask chain and process execution are.
- US-001 only: SIGTERM-then-SIGKILL escalation is not introduced; every kill is the existing process-group SIGKILL.
- US-004 only: the keep-alive does not reopen nax#2013; it fires only while a human prompt is pending, which `execution.approvalTimeout` and the turn deadline bound.

## Stories

**US-001 — `runArgv` kills on abort and never waits on a background process (review #7, #16)**
Give `runArgv` an optional `signal`, incremental cancellable stream readers, a deadline that stays
armed through the drain, and a 500 ms post-exit drain grace that kills the process group when a
background process holds the output. Thread `signal` through `LaunchRequest` and `ToolRunContext`
into the launcher and the Bash/Exec fallbacks, map `aborted` and `orphansKilled` into the tool
results, and add the background-process sentence to every Bash tool description. No dependencies.

**US-002 — The turn signal reaches the batch and the tools (review #6, loop side)**
Build one `turnSignal` in the native adapter from the caller's signal, the watchdog's
`turnController` and a deadline timer; pass it as `TurnDeps.signal`; make `runToolBatch` answer
every remaining call synthetically and report `cancelled` once it fires; make `runNativeTurn`
reject with the signal's reason; and carry the signal through the coding-tool interaction and
`ToolCallContext` into `ToolRunContext`. Depends on US-001.

**US-003 — A cancelled turn cancels its human ask (review #6, ask side)**
Add `AskControl` and the `cancelled` decision source, thread `control` through the ask chain, the
dispatch-ask audit wrapper and `callTool`, give the human ask link per-waiter cancellation, and
re-check the signal after an approval so an approval that lands after the cancel never runs.
Depends on US-002.

**US-004 — A pending human ask keeps the turn alive (review #6, keep-alive)**
Give the human ask link a 60 s keep-alive that calls `AskControl.onWaiting` while a prompt is
pending, have the batch supply `onWaiting` as an `awaiting_human` activity beat, map it to the new
`agent.awaiting_human` stream event, and make the idle watchdog always count that event as
activity on both of its clocks. Depends on US-003.

### Context Files

**US-001**

- `src/utils/argv-exec.ts` — `runArgv` and its MEM-4 / BUG-13 / concurrent-drain invariants
- `src/sandbox/launcher.ts` — both `runArgv` call sites and `_launcherDeps`
- `src/tools/bash.ts` — the launcher and fallback call sites, and every description variant
- `src/tools/run-command-exec.ts` — the Exec launcher and fallback call sites
- `test/integration/sandbox/sandbox-live.test.ts` — the "a timeout kills sandboxed grandchildren" survivor-check pattern to follow

**US-002**

- `src/agents/native/adapter.ts` — `turnController`, the `complete`/`summarize` signal composition, the `runNativeTurn` call
- `src/agents/native/session/turn-tool-batch.ts` — the call loop and the spin-breaker `terminate` branch to mirror
- `src/agents/native/session/turn-loop.ts` — where `runToolBatch` returns and the catch that saves and rethrows
- `src/agents/run-interaction-handler.ts` — the `coding-tool` branch that builds the `ToolCallContext`
- `src/tools/runtime.ts` — `ToolCallContext` and `runTool`

**US-003**

- `src/interaction/ask-link.ts` — `createHumanAskLink`, its queue and in-flight map
- `src/permissions/ask-chain.ts` — `AskLink`, `AskResolver`, `chainAskLinks`, `AskDecidedBy`
- `src/interaction/dispatch-ask.ts` — the audit-writing `askResolver` wrapper
- `src/tools/runtime.ts` — the `ask` branch of `callTool` and `askDenyReason`
- `test/unit/interaction/ask-link.test.ts` — the chain double and prompt harness to follow

**US-004**

- `src/interaction/ask-link.ts` — where the prompt is sent and every settle path
- `src/agents/native/session/turn-events.ts` — `NativeTurnActivity` and `buildNativeStreamEvent`
- `src/runtime/agent-stream-events.ts` — the `AgentStreamEvent` union and `AgentStreamEventBus`
- `src/runtime/middleware/idle-watchdog/index.ts` — the `onAgentStream` switch and the two activity clocks
- `src/agents/native/session/turn-tool-batch.ts` — the coding-tool interaction request the batch builds

### Creates

**US-001**

- `test/unit/utils/argv-exec-lifecycle.test.ts` — real-process tests for abort, drain grace and deadline-through-drain

**US-002**

- `test/unit/agents/native/session/turn-tool-batch-cancel.test.ts` — batch cancellation tests, including the q3 scenario
- `test/unit/agents/native/adapter-turn-signal.test.ts` — adapter tests for the turn signal reaching the tools

**US-003**

- `test/unit/interaction/ask-link-cancel.test.ts` — per-waiter cancellation tests

**US-004**

- `test/unit/interaction/ask-link-keepalive.test.ts` — keep-alive timing tests with an injected timer
- `test/unit/runtime/middleware/idle-watchdog-awaiting-human.test.ts` — watchdog handling of `agent.awaiting_human`

### Modifies

**US-001**

- `test/unit/sandbox/launcher.test.ts` — assertions that compare a `LaunchResult` or a captured `runArgv` options object with exact equality may gain `signal`, `aborted` or `orphansKilled`; the invariant kept is that the logical argv is `executed` and the caller's env and timeout reach `runArgv` unchanged.
- `test/integration/sandbox/sandbox-live.test.ts` — gains a wrapped background-process case beside "a timeout kills sandboxed grandchildren"; existing cases are unchanged.

**US-002**

- `test/unit/agents/native/session/turn-loop-seam.test.ts` — an exact-shape assertion over the object returned by `runToolBatch` or over the coding-tool interaction request may gain `cancelled: false`, `signal` or `onWaiting`; the invariant kept is that a batch with no signal behaves exactly as before.

**US-003**

- `test/unit/interaction/ask-link.test.ts` — tests that call `resolve(req)` with one argument stay valid; an assertion that a cancelled prompt settles `unavailable` through the link-level `abortSignal` stays as it is and must not be changed to `cancelled`.

**US-004**

- `test/unit/runtime/middleware/agent-stream-logging.test.ts` — may gain a case showing `agent.awaiting_human` is accepted; existing assertions are unchanged.
- `test/unit/runtime/middleware/_idle-watchdog-harness.ts` — `makeIdleWatchdogConfig` may gain a `toolCallOnlyIdleTimeoutSeconds` override and the harness may gain a `makeAwaitingHumanEvent` factory; existing factories and defaults are unchanged.
- `test/unit/runtime/middleware/usage-audit.test.ts` — may gain a case showing `agent.awaiting_human` is ignored without error; existing assertions are unchanged.

### Seams

- `[unit]` US-002 consumes US-001's `ToolRunContext.signal`: build a coding-tool runtime with a recording tool, call `buildRunInteractionHandler(...).onInteraction` with a `coding-tool` request carrying an `AbortSignal`, and assert the tool's `run` received that same signal in its context.
- `[unit]` US-003 consumes US-002's `ToolCallContext.signal` and `onWaiting`: call `runtime.callTool` for an `ask` verdict with a context carrying a signal and an `onWaiting` function and a recording `askResolver`, and assert `resolve` received both in its second argument.
- `[unit]` US-004 consumes US-003's `AskControl.onWaiting`: run `runNativeTurn` with an interaction handler whose coding-tool branch invokes the request's `onWaiting`, and assert `deps.onActivity` received `{ kind: "awaiting_human" }`.

## Acceptance Criteria

### US-001 — `runArgv` kills on abort and never waits on a background process (review #7, #16)

- `[unit]` `runArgv` with argv `["sh", "-c", "sleep 4712 & echo started"]`, a temp-dir `cwd` and `timeoutMs: 1500` resolves with `stdout` containing `started`.
- `[unit]` that same call resolves with `orphansKilled: true` and `timedOut: false`.
- `[unit]` after that call resolves, no process whose arguments are `sleep 4712` remains alive within 3 s, polled with `waitForCondition`.
- `[unit]` that same call resolves before the background `sleep 4712` would have exited on its own, measured as under 5000 ms of wall time.
- `[unit]` `runArgv` with argv `["sh", "-c", "echo $$ > pid; sleep 4713"]` and an `AbortController` aborted once the `pid` file exists (awaited with `waitForFile`) resolves with `aborted: true`.
- `[unit]` after that aborted call resolves, no process whose arguments are `sleep 4713` remains alive within 3 s, polled with `waitForCondition`.
- `[unit]` `runArgv` called with an already-aborted signal resolves with `aborted: true` and `exitCode: -1`, and a recording `_argvExecDeps.spawn` double is never called.
- `[unit]` `runArgv` running a command that writes 256 KiB to stdout and exits resolves with all 256 KiB in `stdout` and `orphansKilled: false`.
- `[unit]` `runArgv` with argv `["sleep", "5"]` and `timeoutMs: 250` still resolves with `timedOut: true` and `aborted: false`.
- `[unit]` after `runArgv` settles on a signal that never aborts, a recording `AbortSignal` double reports its abort listener was removed.
- `[unit]` the `createCommandLauncher` launcher, in the `disabled` state and in the available (wrapped) state with a recording `_launcherDeps.runArgv`, passes the `signal` of its `LaunchRequest` through to `runArgv`.
- `[unit]` the Bash tool's `run`, given a `ToolRunContext` with a `signal` and no launcher, passes that signal to `_bashToolDeps.runArgv`.
- `[unit]` the Exec tool's `run`, given a `ToolRunContext` with a `signal` and a recording launcher, passes that signal in the `LaunchRequest`.
- `[unit]` the Bash tool's `run`, when the launcher resolves `aborted: true` with stdout `partial`, returns `isError: true` with content starting `Cancelled: the turn ended while this command was running.` and containing `partial`.
- `[unit]` the Bash tool's `run`, when the launcher resolves `exitCode: 0`, `orphansKilled: true` and stdout `ok`, returns content containing `ok` and ending with the line starting `[nax] background processes still holding the output were killed`.
- `[unit]` each of the five Bash tool descriptions `bashToolDescription` can return (`gatedDescription`, `escalateDescription`, `rawDescription` with the contained sentence, `rawDescription` with the uncontained default, and `rawUnavailableDescription`) states that background processes still holding the command's output are killed when the command exits.
- `[integration]` in `sandbox-live.test.ts`, a wrapped Bash call `sleep 4714 & echo started` with a 1500 ms timeout returns content containing `started`, and no process whose arguments are `sleep 4714` remains alive within 3 s; skipped where the sandbox backend is unavailable, like its neighbours.

**Out of scope:** SIGTERM before SIGKILL; processes that leave the process group.

### US-002 — The turn signal reaches the batch and the tools (review #6, loop side)

- `[unit]` running `runNativeTurn` with a `deps.signal` that a coding tool's `onInteraction` handler aborts while handling call `a` of a batch `[a, b]` never calls `onInteraction` for `b`.
- `[unit]` in that scenario, the transcript saved by the turn holds a tool result for `b` with content `Not run: the turn was cancelled.` and `isError: true`.
- `[unit]` in that scenario, every tool call id in the assistant message has exactly one tool result in the saved transcript.
- `[unit]` in that scenario, `runNativeTurn` rejects with the `reason` the signal was aborted with.
- `[unit]` in that scenario, the fake client's `complete` is called exactly once (no round trip after the cancel).
- `[unit]` running `runNativeTurn` with a `deps.signal` aborted with no reason rejects with an error whose `name` is `AbortError`.
- `[unit]` a batch whose signal is already aborted when the batch starts calls `onInteraction` for none of its calls and answers each one `Not run: the turn was cancelled.`
- `[unit]` a registered `after_tool` handler is not invoked for a `Not run: the turn was cancelled.` answer.
- `[unit]` running `runNativeTurn` without `deps.signal` over a two-call batch calls `onInteraction` for both calls and completes normally, as before this feature.
- `[unit]` the native adapter's turn, when the `onActiveCall` cancel handle it registered is invoked while a coding tool is running, aborts the `signal` that tool's `run` received in its `ToolRunContext`.
- `[unit]` the native adapter's turn, when the caller's `opts.signal` aborts while a coding tool is running, aborts the `signal` that tool's `run` received.
- `[unit]` the native adapter's turn with `timeoutSeconds: 1` aborts the `signal` a still-running coding tool received once the deadline passes, awaited with `waitForCondition` rather than a fixed sleep.
- `[unit]` the native adapter's `complete()` request still receives an aborted signal when the `onActiveCall` cancel handle is invoked during the request.
- `[unit]` `buildRunInteractionHandler(...).onInteraction` with a `coding-tool` request carrying a `signal` and an `onWaiting` function passes both in the `ToolCallContext` given to `runtime.callTool`.
- `[unit]` `runtime.callTool` for an allowed tool, given a `ToolCallContext` with a `signal`, passes that signal in the `ToolRunContext` the tool's `run` receives.

**Out of scope:** `ask_human` questions; context-pull tools.

### US-003 — A cancelled turn cancels its human ask (review #6, ask side)

- `[unit]` `runtime.callTool` for an `ask` verdict whose resolver returns `{ decision: "deny", decidedBy: "cancelled" }` returns `kind: "denied"` with a reason containing `Not run: the turn was cancelled before anyone answered.`
- `[unit]` `chainAskLinks([link]).resolve(req, control)` passes the same `control` object to `link.resolve`.
- `[unit]` the `askResolver` from `buildDispatchAskWiring` passes `control` to its human link, and the approval-audit row it appends has a `request` equal to `req` with no `signal` or `onWaiting` field.
- `[unit]` a `createHumanAskLink` waiter whose `control.signal` aborts while its prompt is on screen settles `{ decision: "deny", decidedBy: "cancelled" }`.
- `[unit]` in that single-waiter case, the chain double's `cancel` is called with the prompt's id.
- `[unit]` two waiters on the same stage and command: aborting the first settles it `cancelled` while the second settles with the human's `allow`.
- `[unit]` in that two-waiter case, the chain double's `cancel` is never called.
- `[unit]` two waiters on the same stage and command that both abort cause the chain double's `cancel` to be called once.
- `[unit]` a request queued behind another prompt whose `control.signal` aborts before its turn is never passed to the chain double's `prompt`.
- `[unit]` a request whose `control.signal` is already aborted settles `cancelled` and is never passed to `prompt`.
- `[unit]` `runtime.callTool` with a resolver that returns `allow` after the context's `signal` aborted does not invoke the tool's `run` and returns `kind: "denied"` with a reason containing `Not run: the turn was cancelled before anyone answered.`
- `[unit]` that call writes a tool-audit row with outcome `denied:ask`.
- `[unit]` a `cancelled` ask resolved through the `buildDispatchAskWiring` resolver appends an approval-audit row with `decidedBy: "cancelled"`.

**Out of scope:** the link-level `abortSignal` still settles `unavailable`; the dedupe key is unchanged.

### US-004 — A pending human ask keeps the turn alive (review #6, keep-alive)

- `[unit]` the batch in `runToolBatch` gives every coding-tool interaction request an `onWaiting` function that, when called, invokes `deps.onActivity` with `{ kind: "awaiting_human" }`.
- `[unit]` with an injected timer and a prompt that stays pending, `control.onWaiting` is called once when the prompt is sent and once more each time `ASK_KEEPALIVE_MS` elapses.
- `[unit]` after the prompt settles (by allow, by deny, by timeout and by cancellation), `control.onWaiting` is not called again when further `ASK_KEEPALIVE_MS` periods elapse.
- `[unit]` `buildNativeStreamEvent` given `{ kind: "awaiting_human" }` returns an event with `kind: "agent.awaiting_human"` and the base's `callId`.
- `[unit]` the idle watchdog in `cancel` mode with `activityKinds: ["message_update"]` and the harness's 1 s idle timeout, fed one `agent.awaiting_human` event every 500 ms of fake-clock time for 5 s and no other event, never invokes the call's cancel handle.
- `[unit]` the idle watchdog in `warn-then-cancel` mode, after a call has entered its grace period, does not invoke the call's cancel handle when an `agent.awaiting_human` event arrives before the grace period ends.
- `[unit]` the idle watchdog with a 1 s idle timeout and a 2 s `toolCallOnlyIdleTimeoutSeconds`, fed one `agent.tool_call_update` and one `agent.awaiting_human` event every 500 ms of fake-clock time for 5 s and no other event, never invokes the call's cancel handle.
- `[unit]` the same watchdog fed only `agent.tool_call_update` events every 500 ms invokes the call's cancel handle once the 2 s tool-call-only timeout passes, confirming the previous criterion depends on `agent.awaiting_human`.
- `[unit]` emitting `agent.awaiting_human` on an `AgentStreamEventBus` with the agent-stream-logging and usage-audit listeners attached logs no `listener threw` warning.

**Out of scope:** keep-alive for `ask_human` questions; exposing `ASK_KEEPALIVE_MS` as configuration.
