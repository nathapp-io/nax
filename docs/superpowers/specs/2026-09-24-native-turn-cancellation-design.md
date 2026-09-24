# Native turn cancellation: stop means stop (design)

**Status:** design, approved in conversation 2026-09-24. No `src/` code.
**Implementation spec:** `.nax/features/turn-cancellation/spec.md` (supersedes this record where they differ; see section 10).
**Baseline:** `main` @ `866a90066` (v0.82.0-canary.19; #2198-#2202 merged). All line citations are against that commit.
**Source:** cross-phase review P0-P5 (2026-09-24), findings #6 (MEDIUM), #7 (MEDIUM), #16 (LOW).

## 1. Purpose

When a native turn is cancelled (idle watchdog, whole-turn deadline, caller abort) or a tool call
times out, nothing further runs:

- no command is executed on an approval that arrived after the cancel;
- no later tool call in the same batch is executed;
- no process started by a Bash/Exec call survives the call;
- no tool call waits forever on a background process.

### 1.1 The defects

1. **#6 - abort ignored during a pending human ask.** `runToolBatch`
   (`src/agents/native/session/turn-tool-batch.ts:87-230`) never consults a signal between tool
   calls. The watchdog's cancel handle is `turnController` (`src/agents/native/adapter.ts:291`),
   and only `complete()` and `summarize()` combine it into their signal (`adapter.ts:324`, `:349`).
   The P2 human ask link listens only to the story-level `ctx.abortSignal`
   (`src/pipeline/stages/execution.ts:128`, `src/interaction/ask-link.ts:174`). Repro
   (`xreview-p0-p5-2026-09-24/turnloop/q3-abort-during-ask.ts`): after a watchdog cancel the
   pending ask is approved, `make deploy` runs, then `git push --force` (the next call in the
   batch) runs, then the next `complete()` throws and the results are discarded. Nothing emits
   activity while an ask is pending, so `execution.approvalTimeout` (up to 3,600,000 ms,
   `src/config/schemas-execution.ts:288`) is cut short by `agent.idleWatchdog.idleTimeoutSeconds`
   (default 900, `src/config/schemas-infra.ts:251`).
2. **#7 - a background child defeats the Bash/Exec deadline.** `runArgv`
   (`src/utils/argv-exec.ts:57-93`) clears its kill timer when `proc.exited` resolves (`:89`), then
   awaits stdout/stderr EOF with no deadline. A grandchild that inherited the pipe keeps it open:
   `sh -c 'sleep 8 & echo started'` with `timeoutMs: 1500` returns after about 8 s, and a daemon
   never returns. Sandbox on or off.
3. **#16 - the abort signal never reaches Bash/Exec processes.** `RunArgvOptions`
   (`argv-exec.ts:14`), `LaunchRequest` (`src/sandbox/types.ts:62`) and the tool run context carry
   no signal. An aborted story's command runs until its own deadline (up to 300 s).

### 1.2 Non-goals

- `ask_human` questions over `interactionBridge` (a separate channel; not a command approval).
- Processes that leave the process group (`setsid()`, double-fork). See section 8.
- The ask dedupe key itself (review #21). Only its cross-story consequence under cancellation is
  handled (section 4.1).
- Context-pull tools (no process, no approval).
- Any other review finding (#8-#15, #17, #19-#22).

## 2. Success criteria

1. The q3 scenario, as a unit test: an abort while call `a` of `[a, b]` is pending means `a`'s
   approval does not execute, `b` is never dispatched, every tool call has a result, and the turn
   rejects with the signal's reason.
2. `sh -c 'sleep 8 & echo started $!'` with `timeoutMs: 1500` returns in under 2 s with `started` in
   stdout, and the `sleep` process is gone afterwards (a real process, not mocked).
3. An abort during `sleep 30` returns in under 1 s and the process group is gone.
4. A human ask pending for longer than `idleTimeoutSeconds` does not trip the idle watchdog, and
   three consecutive 600 s asks do not trip `toolCallOnlyIdleTimeoutSeconds`.
5. `bun run test`, `bun run typecheck`, `bun run lint` pass. (`typecheck` is not in `check:all`.)

## 3. The turn signal

### 3.1 Construction (`src/agents/native/adapter.ts`)

One `turnSignal` per turn, built next to `turnController` (`adapter.ts:291`):

```ts
const deadlineController = new AbortController();
const remainingMs = deadline.remainingMs();
const deadlineTimer = remainingMs !== undefined ? setTimeout(() => deadlineController.abort(), remainingMs) : undefined;
const turnSignal = AbortSignal.any([
  ...(opts.signal !== undefined ? [opts.signal] : []),
  turnController.signal,
  deadlineController.signal,
]);
```

`deadlineTimer` is cleared in the turn's `finally`. It is handed to `runNativeTurn` as
`TurnDeps.signal`. `complete()` and `summarize()` keep their own per-call timers but combine
`turnSignal` instead of repeating `opts.signal` and `turnController.signal`.

### 3.2 Threading

Every new field is optional. Absent means today's behaviour exactly.

| Hop | Field added | Filled from |
|---|---|---|
| `TurnDeps` (`src/agents/native/session/turn-types.ts:53`) | `signal?: AbortSignal` | adapter, 3.1 |
| `runToolBatch` | reads `deps.signal` | - |
| `AdapterInteraction` `coding-tool` (`src/agents/interaction-handler.ts`) | `signal?: AbortSignal`, `onWaiting?: () => void` | batch |
| `ToolCallContext` (`src/tools/runtime.ts:75`) | `signal?`, `onWaiting?` | `src/agents/run-interaction-handler.ts:83` copies both |
| `AskRequest` (`src/permissions/types.ts:12`) | `signal?`, `onWaiting?` | `runtime.ts:439` |
| `ToolRunContext` (`src/tools/registry.ts:50`) | `signal?` | `runTool` (`runtime.ts:380-393`) |
| `LaunchRequest` (`src/sandbox/types.ts:62`) | `signal?` | `src/tools/bash.ts:227`, `src/tools/run-command-exec.ts:81` |
| `RunArgvOptions` (`src/utils/argv-exec.ts:14`) | `signal?` | launcher (both paths), Bash/Exec fallback paths |

### 3.3 Batch cancellation (`turn-tool-batch.ts`)

At the top of each iteration of the call loop (`:87`), before the `onActivity` beat: if
`deps.signal?.aborted`, answer this call and every later call in the batch with a synthetic
result `{ content: "Not run: the turn was cancelled.", isError: true }` and break. This is the
spin-terminate pattern (`:131`): every outstanding call is answered so the transcript never holds
an unanswered `tool_call`, and no `after_tool` event fires for a synthetic answer.

`ToolBatchResult` gains `cancelled: boolean`. The loop (`turn-loop.ts`, after `runToolBatch` at
`:341`) throws `deps.signal.reason` (or an `AbortError` `DOMException` when the reason is
undefined) when `cancelled` is true. That is the error the next `complete()` would have thrown,
so the catch at `:403` (save, rethrow) and the adapter's cancel classification and retry are
unchanged.

A call already executing when the signal fires is not answered synthetically: it finishes through
its own path (the ask resolves `cancelled`, section 4; the process is killed, section 5) and its
real result is recorded. The check applies to the next iteration.

## 4. The human ask

### 4.1 Per-request cancellation (`src/interaction/ask-link.ts`)

Today `resolve()` shares one in-flight promise per key `stage + "\0" + command` (`:181`) and
serializes prompts through `queue`. With per-request signals, a request's abort must not deny
another caller that shares the prompt (a second story asking for the same command).

Each call to `resolve(req)` becomes a **waiter** on the shared entry. The entry holds a count of
live waiters.

- A waiter's `req.signal` fires: that waiter's promise settles `{ decision: "deny", decidedBy:
  "cancelled" }` and the count drops by one. Its `abort` listener is removed when it settles.
- The count reaches zero while the prompt is on screen: cancel it through the existing
  `cancel()` -> `chain.cancel(id)` path, so the Telegram/CLI prompt closes.
- The count reaches zero while the entry is still queued behind another prompt: the entry is
  removed and never prompted.
- A waiter whose signal is already aborted at `resolve()` settles `cancelled` at once and does
  not join.
- The link-level `opts.abortSignal` (story) keeps its current behaviour.
- A human answer settles every live waiter with that answer, as today.

### 4.2 Re-check after approval (`src/tools/runtime.ts`)

`callTool` passes `context.signal` and `context.onWaiting` into the `AskRequest` (`:439`). After
an `allow` verdict, it checks `context.signal?.aborted` before `runTool`. If aborted, the call is
logged `denied:ask` with the `cancelled` reason and returns `{ kind: "denied", breach: false }`.
This closes the window where the human approves in the same instant the turn is cancelled.

### 4.3 `cancelled` as a decision source

- `AskDecidedBy` (`src/permissions/ask-chain.ts:19`) becomes
  `"cache" | "model" | "human" | "timeout" | "unavailable" | "cancelled"`.
- `askDenyReason` (`runtime.ts:146`) maps `cancelled` to
  `"Not run: the turn was cancelled before anyone answered."`.
- The approval-audit row is written as for any resolved ask; P5 consumers select `human` and so
  exclude it.
- Every `switch`, `Record<AskDecidedBy, ...>` and exhaustive check over `AskDecidedBy` is updated;
  none may fall through to a default silently.

### 4.4 Keep-alive while a human decides

- The batch supplies `onWaiting: () => deps.onActivity?.({ kind: "awaiting_human" })` in the
  coding-tool interaction. `awaiting_human` joins the native activity union
  (`src/agents/native/session/turn-events.ts:21-36`).
- The human link calls `req.onWaiting` once when the prompt is sent, then every
  `ASK_KEEPALIVE_MS = 60_000` (module constant) until the prompt settles. The interval is cleared
  on every settle path. With several waiters on one prompt, each live waiter's `onWaiting` is
  called.
- `buildNativeStreamEvent` (`turn-events.ts:54`) maps it to a new `AgentStreamEvent` kind
  `agent.awaiting_human` (`src/runtime/agent-stream-events.ts:100`).
- The idle watchdog (`src/runtime/middleware/idle-watchdog/index.ts:288`) handles
  `agent.awaiting_human` **without** consulting `activityKinds`: it sets both `lastActivityAt` and
  `lastNonToolCallActivityAt` to the event timestamp and clears the grace period. A keep-alive is
  not user-configurable.
- nax#2013 is not reopened: the event fires only while a human prompt is pending, which
  `approvalTimeout` and the turn deadline bound.
- The cache link never waits and the decision-proxy model link is a loopback call with its own
  timeout; neither calls `onWaiting`.
- Every other `onAgentStream` subscriber (`agent-stream-logging.ts:20`, `usage-audit.ts:34`,
  `src/session/manager.ts:112`, `src/tui/hooks/useAgentStreamEvents.ts:47`) must accept the new
  kind without throwing or logging an "unknown event" warning.

## 5. Processes (`src/utils/argv-exec.ts`)

All `runArgv` callers get this behaviour: the launcher (wrapped and unwrapped,
`src/sandbox/launcher.ts:46`, `:72`), the sandbox probe (`src/sandbox/probe.ts:51`), the Bash/Exec
fallback paths (`bash.ts:235`, `run-command-exec.ts:90`), and dependency install
(`src/worktree/dependencies.ts:63`). This is deliberate: an install whose postinstall leaves a
background process holding stdout hangs today in the same way.

### 5.1 Interface

- `RunArgvOptions.signal?: AbortSignal`.
- `ArgvExecResult` gains `aborted: boolean` and `orphansKilled: boolean` (both always present).

### 5.2 Lifecycle

1. `signal` already aborted: do not spawn; return `{ exitCode: -1, stdout: "", stderr: "",
   timedOut: false, aborted: true, orphansKilled: false }`.
2. Read stdout and stderr incrementally into chunk arrays (a reader per stream), concurrently, so
   a full pipe never blocks the child (the existing concurrent-drain invariant), partial output
   survives a kill, and readers can be cancelled.
3. The timeout deadline stays armed until the process has exited **and** both streams are drained.
   On expiry: `killProcessGroup(pid, "SIGKILL")`, cancel both readers, `timedOut: true`.
4. Abort: same kill and cancel, `aborted: true`. The listener is `{ once: true }` and removed in
   `finally`.
5. Drain grace: after `exited`, allow `DRAIN_GRACE_MS = 500` (module constant) for both streams to
   reach EOF. If either is still open: `killProcessGroup(pid, "SIGKILL")`, cancel the readers,
   `orphansKilled: true`, and return the real exit code with the output read so far.
6. The MEM-4, BUG-13 and concurrent-drain invariants in the module header stay true and are
   restated in the header comment.

If `argv-exec.ts` exceeds about 250 lines, the incremental reader moves to its own module.

### 5.3 Launcher and tools

- `LaunchRequest.signal` is passed to `runArgv` on both launcher paths. `LaunchResult` carries
  `aborted` and `orphansKilled` through.
- `bash.ts` and `run-command-exec.ts` pass `ctx.signal` to the launcher and to the fallback.
- `aborted`: `isError: true`, content
  `"Cancelled: the turn ended while this command was running.\n"` followed by the output read so
  far.
- `orphansKilled`: the normal result plus a trailing line
  `"[nax] background processes still holding the output were killed when the command exited. Commands cannot leave processes running; start a server and test it in the same command."`
- The Bash tool description (`bash.ts`, all description variants) gains one sentence stating that
  background processes are killed when the command exits.

## 6. Stories

Each story is green on its own. Order is by dependency.

### US-001: `runArgv` process lifecycle

Scope: section 5.

Acceptance criteria:
1. `runArgv` with `argv: ["sh", "-c", "sleep 8 & echo started $!"]` and `timeoutMs: 1500` returns in under 2000 ms with `stdout` containing `started`, `orphansKilled: true`, `timedOut: false` (real process).
2. After criterion 1, the background pid printed after `started` is no longer alive (`process.kill(pid, 0)` throws `ESRCH`).
3. `runArgv` with `argv: ["sleep", "30"]` and an `AbortSignal` aborted after 200 ms returns in under 1000 ms with `aborted: true`, and the process group is gone.
4. An already-aborted signal returns `aborted: true` without calling `_argvExecDeps.spawn`.
5. A command writing 256 KB to stdout and exiting returns the full 256 KB with `orphansKilled: false`.
6. A command that exceeds `timeoutMs` while its shell is still alive returns `timedOut: true` with partial output (existing behaviour preserved).
7. The abort listener is removed after the call settles (no listener left on a long-lived signal).
8. `LaunchRequest.signal` reaches `runArgv` on both the wrapped and unwrapped launcher paths (unit test with `_launcherDeps`).
9. `ToolRunContext.signal` reaches `runArgv` from the Bash tool and from Exec, on the launcher path and the fallback path.
10. Bash/Exec map `aborted` to an `isError` result starting `Cancelled: the turn ended while this command was running.`, and `orphansKilled` to the normal result plus the `[nax] background processes` line.
11. Every Bash tool description variant contains the background-process sentence.
12. `test/integration/sandbox/sandbox-live.test.ts` gains a wrapped `sleep 8 & echo started` case (timeout 1500 ms, returns in under 2500 ms), skipped where srt is unavailable like its neighbours.

### US-002: turn signal plumbing and batch cancellation

Scope: section 3. Depends on US-001 (`ToolRunContext.signal`).

Acceptance criteria:
1. The adapter builds one `turnSignal` from `opts.signal`, `turnController.signal` and a deadline timer, passes it as `TurnDeps.signal`, and clears the timer when the turn ends.
2. `complete()` and `summarize()` still abort on the watchdog cancel, the caller signal and their per-call deadline (existing tests pass unchanged).
3. With `deps.signal` aborted while call `a` of `[a, b]` executes, `onInteraction` is never called for `b`.
4. In criterion 3, `b` gets a tool result `Not run: the turn was cancelled.` with `isError: true`, and the transcript has a result for every tool call id.
5. In criterion 3, `runNativeTurn` rejects with `signal.reason`, the transcript is saved (catch path), and no further `complete()` is issued.
6. A signal aborted before the batch starts answers every call synthetically and dispatches none.
7. No `after_tool` event fires for a synthetic cancellation answer.
8. With no `deps.signal`, batch behaviour and results are unchanged (regression test over the existing batch suite).
9. The coding-tool interaction carries `signal`, `run-interaction-handler` copies it into `ToolCallContext`, and `runTool` passes it into the tool's `ToolRunContext`.

### US-003: ask cancellation and keep-alive

Scope: section 4. Depends on US-002.

Acceptance criteria:
1. `AskDecidedBy` includes `cancelled`; `askDenyReason("cancelled")` returns `Not run: the turn was cancelled before anyone answered.`; `bun run typecheck` passes with every exhaustive check over `AskDecidedBy` updated.
2. A single waiter whose `req.signal` aborts while its prompt is on screen settles `{ decision: "deny", decidedBy: "cancelled" }` and `chain.cancel(id)` is called.
3. Two waiters on the same key: aborting one settles it `cancelled`; the other still receives the human's `allow`; `chain.cancel` is not called.
4. Two waiters on the same key both aborting cancels the prompt through `chain.cancel`.
5. A request queued behind another prompt whose signal aborts is never passed to `chain.prompt`.
6. A request whose signal is already aborted settles `cancelled` without prompting.
7. The link-level `abortSignal` still cancels the active prompt (existing test passes).
8. `callTool` with a resolver returning `allow` after `context.signal` aborted does not run the tool, logs `denied:ask`, and returns `kind: "denied"` with the cancelled reason.
9. With fake timers, `req.onWaiting` is called once when the prompt is sent and once per 60 s until it settles, and never after it settles (on allow, deny, timeout and cancel).
10. The batch's `onWaiting` produces an `agent.awaiting_human` stream event through `buildNativeStreamEvent`.
11. The idle watchdog configured with `activityKinds: ["message_update"]` resets `lastActivityAt` and `lastNonToolCallActivityAt` on `agent.awaiting_human` and clears the grace period.
12. With `idleTimeoutSeconds: 900`, `toolCallOnlyIdleTimeoutSeconds: 1800` and keep-alives every 60 s, a 1800 s span of pending asks with no model text does not cancel the call.
13. Every `onAgentStream` subscriber accepts `agent.awaiting_human` without throwing or warning.
14. An approval-audit row is written for a `cancelled` ask with `decidedBy: "cancelled"`.

## 7. Error handling summary

| Situation | Outcome |
|---|---|
| Turn aborted between tool calls | Remaining calls answered `Not run`, turn rejects with the signal's reason |
| Turn aborted during a human ask | That waiter settles `cancelled`; tool not run; prompt closed if no waiter remains |
| Approval arrives after abort | `denied:ask`, `cancelled`, tool not run |
| Turn aborted during a command | Process group SIGKILLed, `Cancelled:` result with partial output |
| Background child holds the pipe | Group SIGKILLed after 500 ms drain grace, normal result plus notice |
| Deadline while draining | Group SIGKILLed, `timedOut` |

## 8. Residual (for the PR body)

A process that calls `setsid()` or double-forks leaves the process group, so the group kill does
not reach it. If it also closes its stdio (as a proper daemon does), the call returns normally and
the process survives the call. Closing this needs a sandbox- or cgroup-level reaper and is out of
scope.

## 9. Testing notes

- Real-process tests (US-001 criteria 1-3, 5, 6) use short timings and `sh`/`sleep` only; no
  network.
- Fake timers for the keep-alive and watchdog tests; no real 60 s waits.
- The q3 repro script stays in the review folder; its scenario lives on as US-002 criteria 3-5.
- File-size gate is 600 lines: `runtime.ts` is 503, `turn-tool-batch.ts` about 230.

## 10. Revisions made while writing the implementation spec

Grounding the design against the code and `.nax/rules/` changed five points. The spec is authoritative.

1. **`AskControl`, not `AskRequest` fields.** `AskRequest` is serialized verbatim into approval-audit
   rows (`src/interaction/dispatch-ask.ts`, `request: req`) and persisted by `onRemember`. The signal
   and `onWaiting` travel in a second argument: `AskLink.resolve(req, control?)` and
   `AskResolver.resolve(req, control?)`.
2. **`aborted` and `orphansKilled` are optional in `ArgvExecResult`** so the many hand-built result
   doubles in `test/` stay valid; `runArgv` always sets both.
3. **The keep-alive re-arms a cancellable `setTimeout`**; `setInterval` is banned in `src/`.
4. **Tests follow the repo's rules**: no fixed sleeps and no `process.kill`; real-process checks use a
   unique `sleep 47xx` marker, a `ps` survivor check and `waitForCondition` / `waitForFile`, as in
   `sandbox-live.test.ts`.
5. **Four stories, not three.** Counted as assertions, the ask story exceeded `maxAcCount` (24), so
   keep-alive and the watchdog event moved to US-004.
