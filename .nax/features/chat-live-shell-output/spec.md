# SPEC: nax chat live shell output: a live tail in the running Bash card and a full-screen live shell view

Closes: #3022, #3023

## Summary

While a foreground Bash call of the chat's own session runs, its tool card shows the last 5 lines of the command's output, updating live. Opening a background shell (a click on the footer strip when it counts one lone shell, or Enter on a shell row of the jobs picker) opens a full-screen live shell view, mounted the way the subagent view from #3018 is: the chat stays mounted and hidden, ESC or ctrl+c returns to it, and `k` stops a running shell. Both read one bounded in-memory tail per shell that the chat's task registry keeps. The model's tool result is unchanged: the tail is display only. Design: `docs/superpowers/specs/2026-11-22-nax-chat-live-shell-output-design.md` (approved 2026-11-22).

## Motivation

- A foreground Bash call shows nothing until it ends, so during a long build or test run the user cannot tell progress from a hang (#3022).
- A background shell opens as a one-shot collapsed listing (`showOutput` in `packages/nax/src/tui/chat/useChatPicker.ts`), so following it means clicking again and again. Background subagents got a live full-screen view in #3018; shells did not (#3023).
- `nax-agent` already receives the foreground output as it arrives (`runMovableForeground` passes `onOutput` into the launch and keeps the newest 1 MiB in `outputReplay`, `packages/nax-agent/src/tools/bash-background.ts`), but the buffer is private: `ForegroundCommand` carries only `command` and `moveToBackground()`.

## Design

### Integration

Read-only (verified on main `d44409d5c`):

- `packages/nax-agent/src/tools/types.ts:201` `ToolCallContext` has `readonly toolCallId?: string`. The native turn passes the model's call id into the coding-tool request (`native/session/turn-tool-batch.ts:234`, `toolCallId: call.id`), which reaches the runtime through `toolCallContext(request)` (`session/session-interaction.ts:294`). It is the same id the session's `tool_call` / `tool_result` events carry as `callId` (`native/session/turn-event-emitter.ts:138`).
- `packages/nax-agent/src/tools/runtime.ts:443` `runTool(target, callInput, resolvedPaths, approval?)` builds the `ToolRunContext` passed to `target.run(...)`; the call's `context: ToolCallContext | undefined` is in scope there.
- `packages/nax-agent/src/tools/bash.ts:429` calls `runBashWithBackground({ port: opts.background, runInBackground, command, description, signal: ctx.signal, launch })`; `_bashToolDeps.runArgv` (`bash.ts:104`) is the launch seam tests stub; `_bashToolDeps` is already reachable from `@nathapp/nax-agent/internal` (`src/internal.ts:104` re-exports `tools/index`), as `packages/nax/test/unit/tools/bash-intercept.test.ts:37` uses it.
- `packages/nax-agent/src/tools/bash-background.ts`: `runMovableForeground` registers `port.foreground(control.call)` and launches with `onOutput: output.append`; on ctrl+b `moveToBackground()` calls `port.adopt({ origin: "moved", ... })` and `output.replay(sink)` appends every retained chunk (up to `FOREGROUND_REPLAY_BYTES`, 1 MiB) to the new sink before forwarding live output. So a moved command's background task receives its earlier output through the ordinary sink `append` path; no tail needs moving.
- `packages/nax/src/chat/chat-host.ts:319` passes `backgroundCommands: this.tasks` into `open-chat-session.ts:202-206`; subagent sessions (`chat/subagent-session.ts`, `createAgentSession` at :233 and :266) are opened without it. So only the chat's own session registers foreground calls.
- `packages/nax/src/chat/background/task-registry.ts` (496 lines, 104 under the 600-line source limit): `adopt(handle)` creates a `bash-xxxxxxxx` task whose sink `append(stream, chunk)` calls the private `append(entry, chunk)` that writes the task log, ignoring output after the task ended; `foreground(call)` stores calls in `foregroundCalls: Map<symbol, ForegroundCommand>`; `stop(id)` stops a running task; `onAgentEvents` / `notifyEvents` is the precedent for a per-id listener set; `_backgroundTaskDeps.eventLimits` is the precedent for an injectable total limit.
- `packages/nax/src/chat/background/task-events.ts`: the agent event log's caps and eviction of finished logs oldest first are the precedent for the tail caps.
- `packages/nax/src/tui/chat/layout.ts:357` `cachedLines` caches each entry's laid-out lines by entry object identity, width and expansion. A card's lines therefore change only when its transcript entry is replaced by a new object. `use-job-panels.ts` is the precedent for a hook that replaces a transcript entry in place through the `setEntries` updater while a turn streams.
- `packages/nax/src/tui/chat/AgentView.tsx`: full-screen view over `TranscriptViewport` with a 2-row header, a footer hint row, `useInput` for ESC, and `AGENT_VIEW_REFRESH_MS = 80` coalescing. `use-agent-view.tsx`: `useAgentView(host)` (`id`, `display`, `open`, `close`, `hushes`, `closeForCtrlC`; a pending ask closes the view) and `withAgentView(chat, mount)`.
- `packages/nax/src/tui/chat/use-jobs-opener.ts`: `openFromStrip` opens a lone agent task's view, but a lone shell goes to `input.showOutput(taskEntry(...))`. `useChatPicker.ts:200` `choose` opens an agent row's view, else `showOutput(entry)`.
- `packages/nax/src/tui/chat/duration.ts` `formatDuration(ms)`: the chat's one duration format (`42s`, `1m 15s`, `1h 06m 19s`).
- `packages/nax/test/helpers/chat-picker.tsx` `mountChatPicker` (exported through `@test/helpers`) mounts `ChatApp` with a fake host that accepts `tasks`, `jobs` and a scripted `send`; `toolCallEvent` builds a `tool_call` event. `@test/helpers` re-exports `makeFakeClock` from `@nathapp/nax-test-kit/bun/fake-clock`.
- `packages/nax/src/tui/chat/ChatApp.tsx` (1,482 lines) is at its cognitive-complexity gate (see the `use-agent-view.tsx` header), so new logic goes in new modules and ChatApp changes are call-site edits only.

Changed (Baseline only locates the code; implement the Target):

- `ToolRunContext` (`packages/nax-agent/src/tools/registry.ts:95`).
  Baseline: no call id.
  Target: adds `readonly toolCallId?: string`, set by `runTool` from `context?.toolCallId` when present.
- `ForegroundCommand` (`packages/nax-agent/src/tools/bash-background.ts:25`).
  Baseline: `{ readonly command: string; moveToBackground(): void }`.
  Target:
  ```ts
  export interface ForegroundCommand {
    readonly command: string;
    /** The tool call this command runs for, when the runtime knew it. */
    readonly callId?: string;
    moveToBackground(): void;
    /** Observe output chunks as they arrive, until the call ends or moves; returns the unsubscribe. */
    onOutput?(listener: (stream: BackgroundStream, chunk: Uint8Array) => void): () => void;
  }
  ```
  Both new members are optional so existing implementers and test fakes keep compiling. The call `runMovableForeground` registers always carries `onOutput`, and carries `callId` when the Bash tool's `ToolRunContext` had one. The replay buffer and ctrl+b replay are unchanged; the listener is an extra observer.
- `tool` transcript entry (`packages/nax/src/tui/chat/transcript-model.ts:38`).
  Target: gains `liveTail?: readonly string[]`. `applyToolResult` returns the finished entry without `liveTail`.
- `toolCardModel(entry, options)` (`packages/nax/src/tui/chat/tool-card.ts:393`).
  Target: for a `Bash` entry with `status: "running"` and a non-empty `liveTail`, the summary is the last `CARD_TAIL_LINES` lines of `liveTail`, each cut to `CARD_TAIL_LINE_MAX_CHARS` characters, muted, and marked `clip: true`; every other entry is unchanged.
- `CardLine` (`tool-card.ts:22`) gains `readonly clip?: boolean`; `toolSummaryLines` in `layout.ts` draws a clipped line as exactly one row (`singleRow`, then cut to the row's width with a trailing `…`) instead of wrapping it.
- `ChatHost` (`packages/nax/src/chat/chat-host-types.ts:61`).
  Target: gains `readonly shellOutput?: ChatShellOutput`, set by the host to the same registry object as `tasks`.
- `createBackgroundTasks(options)` (`packages/nax/src/chat/background/task-registry.ts:494`) and `createHostTasks(options)` (`packages/nax/src/chat/background/host-tasks.ts:7`).
  Baseline: return `ChatBackgroundTasks` / `{ tasks: ChatBackgroundTasks; ... }`.
  Target: return `ChatBackgroundTasks & ChatShellOutput` / `{ tasks: ChatBackgroundTasks & ChatShellOutput; ... }`, so `chat-host.ts` can set `shellOutput` from the same object it sets `tasks` from (`chat-host.ts:212`).
- The barrel `packages/nax/src/chat/background/index.ts` exports `ChatShellOutput`, `ShellTailView`, `createShellTail`, `SHELL_TAIL_MAX_LINES`, `SHELL_TAIL_MAX_BYTES`, `SHELL_TAIL_REFRESH_MS` and `SHELL_TAIL_TOTAL_MAX_BYTES`.
- `MountOptions` of `mountChatPicker` (`packages/nax/test/helpers/chat-picker.tsx`).
  Target: gains an optional `shellOutput` that the fake host exposes as `host.shellOutput`.

New types (in `packages/nax/src/chat/background/task-types.ts`, exported through `@/chat/background`):

```ts
/** Display-only shell output tails; nothing here reaches the model. */
export interface ChatShellOutput {
  /** The tail of the background shell task `id`; undefined for an unknown id or an agent task. */
  taskTail(id: string): ShellTailView | undefined;
  /** The tail of the running foreground call `callId`; undefined once it ended or moved, or when no call carries that id. */
  foregroundTail(callId: string): ShellTailView | undefined;
  /** Told the task id or call id whose tail changed; returns the unsubscribe. */
  onShellOutput(listener: (id: string) => void): () => void;
}
export interface ShellTailView {
  /** Newest lines, oldest first; the current partial line, if any, is last. */
  readonly lines: readonly string[];
  /** True when older output was dropped from the tail, or the whole tail was evicted. */
  readonly truncated: boolean;
}
```

`ChatBackgroundTasks` is unchanged, so its test fakes are untouched; the registry class implements both interfaces.

New modules:

- `packages/nax/src/chat/background/shell-tail.ts` (pure, one tail): `createShellTail(limits?: { maxLines: number; maxBytes: number })` returns `{ append(chunk: Uint8Array): void; view(): ShellTailView; bytes(): number; evict(): void }`. A streaming UTF-8 decoder (malformed bytes become U+FFFD); `\n` ends a line, and `\r\n` ends one line even when the `\r` and the `\n` arrive in different chunks; a `\r` followed by anything other than `\n` clears the current partial line so the next text replaces it; blank lines are kept; the last line without a newline is the partial line and counts toward both caps; a line's bytes are its UTF-8 text without the newline. Caps: `SHELL_TAIL_MAX_LINES = 2000` and `SHELL_TAIL_MAX_BYTES = 256 * 1024` (UTF-8 bytes of the retained lines), dropping oldest lines first; a line (partial or complete) longer than the byte cap keeps only its newest bytes, cut on a character boundary. One tail serves both stdout and stderr in arrival order, with one decoder and one partial line. The module also exports `SHELL_TAIL_REFRESH_MS`. Any drop sets `truncated`. `evict()` empties the tail and sets `truncated`.
- `packages/nax/src/chat/background/shell-tails.ts` (one per registry): the table of tails keyed by background task id and by foreground call id, the listener set behind `onShellOutput`, and the total-budget eviction. Exports `createShellTails(options)` and `SHELL_TAIL_TOTAL_MAX_BYTES = 4 * 1024 * 1024`; the registry delegates `taskTail`, `foregroundTail` and `onShellOutput` to it. The registry's `finalize` tells it a task ended through `endTask(id)`. Eviction runs after every append and every `endTask`, and removes finished background tasks' tails, oldest-ended first, until the total is at most the limit; running tasks' and foreground calls' tails are never evicted. The total limit is injectable through `_backgroundTaskDeps.shellTailTotalMaxBytes` so a test need not write 4 MiB.
- `packages/nax/src/tui/chat/use-foreground-tails.ts`: the hook that keeps running Bash entries' `liveTail` current.
- `packages/nax/src/tui/chat/ShellView.tsx` and `packages/nax/src/tui/chat/shell-view-model.ts`: the full-screen shell view, structured like `AgentView.tsx` / `agent-view-model.ts`.

Constants: `CARD_TAIL_LINES = 5` in `tool-card.ts`; `SHELL_TAIL_REFRESH_MS = 100` in `shell-tail.ts`, the most often a consumer redraws for tail changes (the registry notifies per append; consumers coalesce); `SHELL_VIEW_TICK_MS = 1000` in `ShellView.tsx`, the elapsed-time tick of a running shell's view header; `CARD_TAIL_LINE_MAX_CHARS = 512` in `tool-card.ts`, the most of one tail line the card model keeps.

`shell-view-model.ts` exports (pure): `shellViewTitle(task: BackgroundTask | undefined, id: string, nowMs: number): StyledLine` (header row; `<id> is no longer listed` when `task` is undefined), `shellViewFooter(task: BackgroundTask | undefined, error?: string): StyledLine` (hint or error), and `shellViewBody(view: ShellTailView | undefined, logPath: string | undefined): readonly StyledLine[]` (truncated notice first, every line passed through `sanitizeText`).

Timer seams: every `schedule(callback, ms)` returns a handle and `cancel(handle)` clears it; tests adapt `makeFakeClock()`'s `setTimeout` / `clearTimeout` to them. `_shellViewDeps.now()` returns epoch milliseconds.

### Running Bash card

`useForegroundTails({ host, entries, setEntries })`, called from `ChatApp.tsx` beside `useJobPanels` (which takes the same `entries` / `setEntries`), subscribes to `host.shellOutput.onShellOutput`. When notified for a call id that names a running `Bash` entry of the transcript, it schedules one update at most `SHELL_TAIL_REFRESH_MS` later (further notifications in that window join it); the update re-checks inside the `setEntries` updater that the id still names a running `Bash` entry (returning the same array when not), and replaces that entry with a copy whose `liveTail` is `host.shellOutput.foregroundTail(callId)?.lines` (or no `liveTail` when that is undefined). Replacing the entry object is what makes `cachedLines` lay the card out again, and the click-to-row mapping (`transcript-click.ts`, `ChatApp.tsx`) reads the same entries, so card height and click targets stay in step. A host without `shellOutput` gets no updates. The hook's timer is reached through `_foregroundTailsDeps.schedule(callback, ms)` / `_foregroundTailsDeps.cancel(handle)`, which tests drive with `makeFakeClock()`.

### Shell view

`ShellView` takes `{ shells: ChatShellOutput, tasks: ChatBackgroundTasks, id, columns, rows, theme, mouse?, onCopy?, onClose }`:

- Header row: the command (and description when present), the state (`running`, `succeeded`, `failed`, `stopped`), the elapsed time (`formatDuration`) while running, refreshed every `SHELL_VIEW_TICK_MS` even when no output arrives, or the duration once ended, the exit code once ended (`exit 2`), and the task id; then a rule row, as the agent view draws.
- Body: `TranscriptViewport` over the tail lines (sanitised like every span), so scrolling and following the newest line behave as in the agent view. When the tail is `truncated`, the first body line reads `earlier output dropped; full log: <logPath>`.
- Footer hint: `esc to return · k to stop` while running, `esc to return` once ended; an error from stopping replaces the hint with the error message.
- Keys: ESC calls `onClose`; `k` while the task runs calls `tasks.stop(id)` and the view stays open; `k` once ended does nothing.
- An id `tasks.get` does not return: the header reads `<id> is no longer listed` and the body is empty (a defensive path: the registry never deletes entries today).
- Redraws for tail changes coalesce to at most one per `SHELL_TAIL_REFRESH_MS`. The view also subscribes to `tasks.onChange`, as `AgentView` does, so a task that ends while the view is open updates its header and footer at once. Unmounting unsubscribes every listener and cancels every pending timer.
- Time is read through `_shellViewDeps.now()` and timers through `_shellViewDeps.schedule` / `_shellViewDeps.cancel`; `_shellViewDeps.rendered()` is called once per render, as `_agentViewDeps.rendered` is.

The open view is held by the existing `useAgentView` state. `withAgentView` mounts `AgentView` when `host.tasks.get(id)?.kind === "agent"`, `ShellView` otherwise when `host.shellOutput` is defined, and `AgentView` (as today) for a non-agent id on a host without `shellOutput`; so `hushes`, `display: none`, the ask-closes-the-view effect and `closeForCtrlC` apply to both unchanged.

Entry points, on a host whose `shellOutput` is defined: `openFromStrip` opens the view for a lone running shell (as it already does for a lone agent), and `useChatPicker`'s `choose` opens the view for any shell row of the jobs picker, running or ended. On a host without `shellOutput`, both keep today's `showOutput` listing. Job rows always keep `showOutput`.

### Failure Handling

| Condition | Behaviour |
|:--|:--|
| Output bytes are not valid UTF-8 | Decoded with U+FFFD replacements; the tail never throws. |
| A tail exceeds 2000 lines or 256 KiB | Oldest lines dropped (a single over-long partial line keeps its newest bytes); `truncated` true. |
| All tails exceed the total limit | Finished background tails evicted oldest-ended first until under; evicted views are empty with `truncated` true. |
| A `onShellOutput` listener throws | The error is logged at warn and the other listeners and the append still run. |
| An `onOutput` listener throws (nax-agent) | The chunk is still retained for ctrl+b replay and still reaches the other listeners. |
| A foreground call carries no `callId` | Its output is still observed, but `foregroundTail` cannot address it and no card shows it. |
| The foreground call ends or moves | Its foreground tail is dropped; `foregroundTail(callId)` returns undefined. |
| The host has no `shellOutput` | No card tail; shells keep the `showOutput` listing. |
| The view's id is no longer listed | Header `<id> is no longer listed`, empty body; ESC still closes. |
| `tasks.stop(id)` throws from the view | The view stays open and shows the error message in its footer row. |
| An ask card arrives while the view is open | The view closes (existing `useAgentView` behaviour). |

## Out of Scope

- Live output of a subagent's own Bash calls, in the agent view or anywhere else: subagent sessions are opened without the background-command port.
- Shell output of ACP-backed agents (claude, codex and others): their shells are not run by nax-agent.
- Input to a running shell (stdin): the view is output only.
- Reading the task log file beyond the in-memory tail in the shell view: a truncated view names the log path instead.
- Rendering ANSI colours in shell output: control sequences are neutralised by the existing `sanitizeText`, colours are not drawn.
- Changes to `nax run` job panels and to job rows of the jobs picker, which keep the existing output listing.
- Keeping tails across a chat restart: tails are in memory only; the log file stays the durable record.
- Any change to the tool result the model receives for a Bash call.
- New scrolling behaviour: the shell view uses `TranscriptViewport` as the agent view does.
- A live tail on `RunCommand` cards: only `Bash` cards show one.
- Separate stdout and stderr tails: one tail interleaves both streams in arrival order, so a multibyte character or partial line split across the two streams may join or show U+FFFD.
- A `.nax/` change: none is needed.

## Stories

The feature is 9 stories of one capability (live shell output, one PR); the split follows packages and the 24-assertion gate, not independent features.

**US-001: nax-agent hands the host a foreground call's id and its output as it arrives.** Workdir: `packages/nax-agent`. No dependencies. `ToolRunContext` gains `toolCallId` from the call's `ToolCallContext`; the Bash tool passes it into `runBashWithBackground`; the `ForegroundCommand` that `runMovableForeground` registers carries `callId` and `onOutput`, which forwards each chunk the launch reports while the call is in the foreground (the listener is notified before `output.append`'s moved-sink short-circuit returns, so it stops receiving once the call moves). The replay buffer and ctrl+b behaviour are unchanged.

**US-002: a bounded, line-aware shell output tail.** Workdir: `packages/nax`. No dependencies. New pure module `src/chat/background/shell-tail.ts` with `createShellTail`, `SHELL_TAIL_MAX_LINES`, `SHELL_TAIL_MAX_BYTES` and `SHELL_TAIL_REFRESH_MS`; the `ShellTailView` type goes in `task-types.ts`; the barrel `src/chat/background/index.ts` exports them.

**US-003: background shell tasks keep a tail and the host exposes `ChatShellOutput`.** Workdir: `packages/nax`. Depends on US-002. New `src/chat/background/shell-tails.ts` (`createShellTails`, `SHELL_TAIL_TOTAL_MAX_BYTES`) owns the tail table, the `onShellOutput` listeners, `endTask(id)` and the total-budget eviction; the `ChatShellOutput` type goes in `task-types.ts` and the barrel. The registry's `adopt` sink appends also feed the task's tail, `finalize` calls `endTask`, and the registry implements `ChatShellOutput` by delegating to `shell-tails.ts`. `createBackgroundTasks` and `createHostTasks` return `ChatBackgroundTasks & ChatShellOutput`, and `ChatHost.shellOutput` is set to the registry.

**US-004: foreground calls keep a tail addressed by call id.** Workdir: `packages/nax`. Depends on US-001, US-003. `foreground(call)` subscribes through `call.onOutput` and keeps a tail under `call.callId` in `shell-tails.ts`; the unregister function drops it.

**US-005: the running Bash card shows the live tail.** Workdir: `packages/nax`. Depends on US-004. `tool` entries gain `liveTail`; `toolCardModel` renders it as clipped lines and `layout.ts` draws a clipped line as one row; new hook `src/tui/chat/use-foreground-tails.ts` keeps it current; `ChatApp.tsx` gets a call-site edit; `mountChatPicker` gains a `shellOutput` mount option.

**US-006: the shell view renders a shell task.** Workdir: `packages/nax`. Depends on US-003. New `shell-view-model.ts` (`shellViewTitle`, `shellViewFooter`, `shellViewBody`) and `ShellView.tsx` drawing header, rule, body over `TranscriptViewport` and footer, with `_shellViewDeps` (`now`, `schedule`, `cancel`, `rendered`) and `SHELL_VIEW_TICK_MS`.

**US-007: the shell view follows the shell live and takes its keys.** Workdir: `packages/nax`. Depends on US-006. `ShellView` subscribes to `onShellOutput` (coalesced to `SHELL_TAIL_REFRESH_MS`) and `tasks.onChange`, ticks the elapsed time every `SHELL_VIEW_TICK_MS` while the task runs, handles ESC and `k`, shows a stop error in the footer, and unsubscribes and cancels its timers on unmount.

**US-008: shells open the live view.** Workdir: `packages/nax`. Depends on US-005, US-007. `withAgentView` mounts `ShellView` for a non-agent id on a host with `shellOutput`; `openFromStrip` and the jobs picker's `choose` open the shell view on such a host; hosts without `shellOutput` and job rows keep `showOutput`.

**US-009: the chat guide describes live shell output.** Workdir: `.`. Depends on US-008. **No-test:** documentation only.

### Context Files

**US-001**
- `packages/nax-agent/src/tools/bash-background.ts`
- `packages/nax-agent/src/tools/bash.ts`
- `packages/nax-agent/src/tools/runtime.ts`
- `packages/nax-agent/src/tools/registry.ts`
- `packages/nax-agent/test/unit/tools/after-tool-truncation.test.ts`

**US-002**
- `packages/nax/src/chat/background/task-events.ts`
- `packages/nax/src/chat/background/task-types.ts`
- `packages/nax/src/chat/background/index.ts`

**US-003**
- `packages/nax/src/chat/background/task-registry.ts`
- `packages/nax/src/chat/background/host-tasks.ts`
- `packages/nax/src/chat/background/index.ts`
- `packages/nax/src/chat/chat-host.ts`
- `packages/nax/src/chat/background/shell-tail.ts` — created by US-002, consumed here

**US-004**
- `packages/nax/src/chat/background/task-registry.ts`
- `packages/nax/src/chat/background/shell-tails.ts` — created by US-003, extended here
- `packages/nax-agent/src/tools/bash.ts`
- `packages/nax/test/unit/tools/bash-intercept.test.ts`

**US-005**
- `packages/nax/src/tui/chat/tool-card.ts`
- `packages/nax/src/tui/chat/layout.ts`
- `packages/nax/src/tui/chat/transcript-model.ts`
- `packages/nax/src/tui/chat/use-job-panels.ts`
- `packages/nax/test/ui/chat/chat-app.test.tsx`

**US-006**
- `packages/nax/src/tui/chat/AgentView.tsx`
- `packages/nax/src/tui/chat/agent-view-model.ts`
- `packages/nax/src/tui/chat/TranscriptViewport.tsx`
- `packages/nax/src/tui/chat/duration.ts`
- `packages/nax/test/ui/chat/agent-view.test.tsx`

**US-007**
- `packages/nax/src/tui/chat/ShellView.tsx` — created by US-006, extended here
- `packages/nax/src/tui/chat/AgentView.tsx`
- `packages/nax/test/ui/chat/agent-view.test.tsx`

**US-008**
- `packages/nax/src/tui/chat/use-agent-view.tsx`
- `packages/nax/src/tui/chat/use-jobs-opener.ts`
- `packages/nax/src/tui/chat/useChatPicker.ts`
- `packages/nax/src/tui/chat/ShellView.tsx` — created by US-006, mounted here
- `packages/nax/test/helpers/chat-picker.tsx`

**US-009**
- `docs/guides/chat-layout-pty.md`
- `docs/README.md`

### Creates

**US-001**
- `packages/nax-agent/test/unit/tools/bash-background-output.test.ts`

**US-002**
- `packages/nax/src/chat/background/shell-tail.ts`
- `packages/nax/test/unit/chat/background/shell-tail.test.ts`

**US-003**
- `packages/nax/src/chat/background/shell-tails.ts`
- `packages/nax/test/unit/chat/background/shell-tails.test.ts`

**US-004**
- `packages/nax/test/unit/chat/background/shell-tails-foreground.test.ts`

**US-005**
- `packages/nax/src/tui/chat/use-foreground-tails.ts`
- `packages/nax/test/ui/chat/use-foreground-tails.test.tsx`

**US-006**
- `packages/nax/src/tui/chat/ShellView.tsx`
- `packages/nax/src/tui/chat/shell-view-model.ts`
- `packages/nax/test/ui/chat/shell-view.test.tsx`
- `packages/nax/test/unit/tui/chat/shell-view-model.test.ts`

**US-007**
- `packages/nax/test/ui/chat/shell-view-live.test.tsx`

**US-008**
- `packages/nax/test/ui/chat/shell-view-open.test.tsx`

**US-009**
- `docs/guides/chat-shells.md`

### Modifies

**US-001**

None. The new `ToolRunContext` and `ForegroundCommand` members are optional, existing fakes in `bash-background-move.test.ts` and `task-registry-notices.test.ts` construct calls without them, and the replay path they assert is unchanged.

**US-002**

None. The module is new; the barrel only gains exports.

**US-003**

None. `ChatBackgroundTasks` is unchanged, so its test fakes keep compiling; `ChatHost.shellOutput` is optional; the wider return types of `createBackgroundTasks` and `createHostTasks` are assignable wherever `ChatBackgroundTasks` was.

**US-004**

None. Calls without `onOutput` register exactly as today.

**US-005**
- `packages/nax/test/helpers/chat-picker.tsx` — `MountOptions` gains an optional `shellOutput` that the fake host returns as `host.shellOutput`. The invariant: every existing caller passes no `shellOutput` and mounts exactly the host it mounts today.

**US-006**

None. The view is new.

**US-007**

None. The view is new.

**US-008**

None. Every existing test that asserts the shell output listing (`jobs-opener.test.tsx`, `footer-shells.test.tsx`, `jobs-picker.test.tsx`, `agent-view.test.tsx` "a lone shell still lists its output instead of opening a view" and "Enter on a shell row still lists its output") mounts a host without `shellOutput`, which keeps the listing.

**US-009**

None. Documentation only: a new guide and one new row in `docs/README.md`.

### Seams

- US-001 → US-004: `ForegroundCommand.callId` and `ForegroundCommand.onOutput`. US-004 AC-9 runs the real Bash tool created with the real registry as its `background` port, with only `_bashToolDeps.runArgv` stubbed (imported from `@nathapp/nax-agent/internal`, as `bash-intercept.test.ts` already does), and reads `foregroundTail`.
- US-002 → US-003: `createShellTail`. US-003 AC-1 drives a background task's tail through the sink `adopt` returns, the entry point nax-agent writes output to.
- US-003 → US-005, US-006, US-008: `ChatHost.shellOutput` / `ChatShellOutput`. US-003 AC-13 pins the host wiring; US-005 AC-1 mounts `ChatApp` through `mountChatPicker` with a host whose `shellOutput` reports a tail; US-006 drives `ShellView` with a `ChatShellOutput` fake.
- US-006/US-007 → US-008: `ShellView`. US-008 AC-1 and AC-4 open it from a footer strip click and a jobs picker Enter in the mounted chat.

## Acceptance Criteria

ACs marked **(control)** already pass on the baseline code and pin behaviour that must not regress. "The fake clock" is `makeFakeClock()` from `@test/helpers`, its `setTimeout` / `clearTimeout` adapted to the named `schedule` / `cancel` seams.

### US-001

"The runtime" is `createCodingToolRuntime({ extraTools: [createBashTool({ background: port })], policy })` with a policy that grants Bash, built as `after-tool-truncation.test.ts` builds one. `port` is a fake `BackgroundCommandPort` that records the `ForegroundCommand` passed to `foreground(call)`. `_bashToolDeps.runArgv` is stubbed with a launch that reports output chunks through the `onOutput` it is given, then waits on a gate the test opens, then resolves.

1. [unit] `runtime.callTool("Bash", { command: "build" }, { toolCallId: "c1" })` registers a `ForegroundCommand` whose `callId` is `"c1"`.
2. [unit] That `ForegroundCommand`'s `command` is `"build"`.
3. [unit] `runtime.callTool("Bash", { command: "build" })` with no call context registers a `ForegroundCommand` that has no `callId` member.
4. [unit] That call-id-less `ForegroundCommand` still has an `onOutput` function.
5. [unit] A listener subscribed through the registered call's `onOutput` receives each chunk the launch reports, in order, with its stream (`stdout` or `stderr`).
6. [unit] After the listener's unsubscribe is called, later chunks are not delivered to it.
7. [unit] After `moveToBackground()`, chunks reported later reach the background sink and not the `onOutput` listener.
8. [unit] (control) After `moveToBackground()`, the background sink first receives every chunk reported before the move, in order.
9. [unit] (control) The tool result of a Bash call that runs to completion in the foreground is the same text whether or not an `onOutput` listener is subscribed.
10. [unit] When an `onOutput` listener throws on a chunk, a later `moveToBackground()` still replays that chunk to the background sink.
11. [unit] When one of two `onOutput` listeners throws on a chunk, the other still receives it.

### US-002

"Append" means `tail.append(bytes)` with the UTF-8 encoding of the text shown.

1. [unit] Appending `"a\nb\n"` gives `view().lines` equal to `["a", "b"]`.
2. [unit] After appending `"a\nb\n"`, `view().truncated` is false.
3. [unit] Appending `"a\nb"` gives `view().lines` equal to `["a", "b"]`, the partial line last.
4. [unit] Appending `"a\nb"` then `"c\n"` gives `view().lines` equal to `["a", "bc"]`.
5. [unit] Appending `"x\r\ny\r\n"` gives `view().lines` equal to `["x", "y"]`.
6. [unit] Appending `"x\r"` then `"\ny\n"` gives `view().lines` equal to `["x", "y"]`, the same as the unsplit input.
7. [unit] Appending `"10%\r50%\r"` then `"100%\n"` gives `view().lines` equal to `["100%"]`.
8. [unit] Appending `"a\n\nb\n"` gives `view().lines` equal to `["a", "", "b"]`.
9. [unit] Appending the bytes of `"é"` split across two `append` calls gives `view().lines` equal to `["é"]`.
10. [unit] Appending the invalid byte `0xff` followed by `"\n"` gives `view().lines` equal to `["�"]`.
11. [unit] With the default limits, appending 2001 lines `"l1\n"` to `"l2001\n"` gives `view().lines` equal to `"l2"` through `"l2001"`.
12. [unit] After those 2001 lines, `view().truncated` is true.
13. [unit] With the default limits, appending lines whose UTF-8 bytes total more than 262144 leaves `bytes()` at most 262144.
14. [unit] `createShellTail({ maxLines: 2, maxBytes: 1024 })` keeps only `["b", "c"]` of `"a\nb\nc\n"`.
15. [unit] With limits `{ maxLines: 1000, maxBytes: 4 }`, appending `"abc\ndef\n"` keeps `["def"]`.
16. [unit] With limits `{ maxLines: 1000, maxBytes: 4 }`, appending `"abcdefgh"` with no newline keeps the partial line `"efgh"`.
17. [unit] With limits `{ maxLines: 1000, maxBytes: 4 }`, appending `"abcdefgh\n"` in one chunk keeps the complete line `"efgh"`.
18. [unit] With limits `{ maxLines: 1000, maxBytes: 4 }`, appending `"ab\ncd\n"` keeps both lines: newlines do not count toward `bytes()`.
19. [unit] With limits `{ maxLines: 2, maxBytes: 1024 }`, appending `"a\nb\nc"` keeps `["b", "c"]`: the partial line counts toward the line cap.
20. [unit] After `evict()`, `view().lines` is empty and `view().truncated` is true.
21. [unit] After `evict()`, `bytes()` is 0.
22. [unit] Appending an empty chunk leaves `view()` unchanged.

### US-003

"The registry" is `ChatBackgroundTasks` built as the existing registry tests build it, with its log writes stubbed through `_backgroundTaskDeps`.

1. [unit] After `adopt(handle)` returns sink `s` for task `bash-00000001`, `s.append("stdout", the UTF-8 bytes of "hi\n")` makes `taskTail("bash-00000001")` return lines `["hi"]`.
2. [unit] `taskTail` returns undefined for an id the registry does not list.
3. [unit] `taskTail` returns undefined for the id of an agent task.
4. [unit] Output appended after the task ended does not change its tail.
5. [unit] Each sink append notifies every `onShellOutput` listener with the task id.
6. [unit] The unsubscribe `onShellOutput` returned stops further notifications to that listener.
7. [unit] An `onShellOutput` listener that throws is logged at warn, and the other listeners are still notified for the same append.
8. [unit] A moved command's background task, adopted with `origin: "moved"` and fed the replayed chunks `"a\n"` and `"b\n"` through its sink, shows `["a", "b"]` in `taskTail(id)`.
9. [unit] With `_backgroundTaskDeps.shellTailTotalMaxBytes` set to 8, when two finished tasks hold 6 bytes of tail each, the tail of the one that ended earlier is evicted: its `taskTail(id).lines` is empty.
10. [unit] The evicted task's `taskTail(id).truncated` is true.
11. [unit] With the same limit, a running task's tail is never evicted, even while the total stays over the limit.
12. [unit] `SHELL_TAIL_TOTAL_MAX_BYTES` equals 4194304.
13. [unit] A chat host built with a task registry exposes `host.shellOutput`, and a task adopted through `host.tasks` is readable through `host.shellOutput.taskTail`.

### US-004

"A foreground fake" is a `ForegroundCommand` whose `onOutput` records its listener and returns an unsubscribe that records the call.

1. [unit] `foreground(call)` with a foreground fake carrying `callId` `"c1"` subscribes through `call.onOutput` once.
2. [unit] A chunk `"x\n"` the foreground fake's listener receives makes `foregroundTail("c1")` return lines `["x"]`.
3. [unit] That chunk notifies `onShellOutput` listeners with `"c1"`.
4. [unit] Calling the unregister function `foreground(call)` returned calls the fake's unsubscribe.
5. [unit] After that unregister, `foregroundTail("c1")` returns undefined.
6. [unit] `foreground(call)` with a call that has no `onOutput` registers it as today: `hasForeground()` is true and `foregroundTail("c1")` returns undefined.
7. [unit] `foreground(call)` with a call that has `onOutput` but no `callId` still subscribes through `onOutput`, and `foregroundTail` returns undefined for every id.
8. [unit] (control) `moveForeground()` moves a registered call that has `callId` and `onOutput`, as today.
9. [integration] The Bash tool created with `createBashTool({ background: registry })`, run with a `ToolRunContext` whose `toolCallId` is `"c1"` and with `_bashToolDeps.runArgv` stubbed to report `"line one\n"` and then wait, makes `registry.foregroundTail("c1")?.lines` equal `["line one"]` while it runs.
10. [integration] Once that stubbed launch resolves and the Bash call returns, `registry.foregroundTail("c1")` returns undefined.
11. [unit] With `_backgroundTaskDeps.shellTailTotalMaxBytes` set to 8 and a foreground tail of 10 bytes, the foreground tail is not evicted.

### US-005

"Mounting the chat" means `mountChatPicker` with its default held turn: after `submit()`, the test emits `ui.emit({ type: "tool_call", callId: "c1", name: "Bash", input: { command: "make" } })` (as `chat-app.test.tsx` does) and the turn stays running until `finish()`. The mount's `shellOutput` fake returns a tail for `"c1"` and calls its `onShellOutput` listeners on demand; timers run on the fake clock through `_foregroundTailsDeps`.

1. [integration] With a `"c1"` tail of lines `["one", "two"]` and a notification for `"c1"`, after `SHELL_TAIL_REFRESH_MS` both lines appear in the running Bash card.
2. [integration] With a tail of 8 lines `"l1"` to `"l8"`, the running card shows `"l4"` to `"l8"` and not `"l3"`.
3. [integration] After the tail gains `"three"` and the fake notifies `"c1"`, the card shows `"three"` once `SHELL_TAIL_REFRESH_MS` has passed.
4. [integration] Before `SHELL_TAIL_REFRESH_MS` has passed after a notification, the card does not yet show the new line.
5. [integration] Ten notifications for `"c1"` within one `SHELL_TAIL_REFRESH_MS` window lay out the `"c1"` card once, counted through `_layoutDeps.layoutEntry` calls for that entry.
6. [integration] A 300-character tail line in a 80-column chat occupies exactly one row of the card, ending in `…`.
7. [integration] After the turn emits the `tool_result` for `"c1"`, the card shows the result preview as today and no tail line absent from that preview.
8. [integration] With no `shellOutput` on the host, the running Bash card renders as today (header only).
9. [integration] A notification for an id that names no running Bash entry replaces no transcript entry.
10. [integration] Clicking the header row of a running Bash card that shows a 5-line tail toggles that card's expansion and no other entry's.
11. [integration] A tail line holding the bytes `\u001b[?1049l` is drawn with that control sequence neutralised, as other tool output is.
12. [integration] Unmounting the chat while a tail update is scheduled leaves no pending timer on the fake clock.
13. [unit] `toolCardModel` for a running Bash entry with `liveTail` `["a", "b"]` returns a summary of two muted lines `"a"` and `"b"`, each with `clip` true.
14. [unit] `toolCardModel` for a running Bash entry with a `liveTail` line of 600 characters returns that line cut to `CARD_TAIL_LINE_MAX_CHARS` characters.
15. [unit] `toolCardModel` for a running Bash entry with an empty `liveTail` returns an empty summary.
16. [unit] `toolCardModel` for a Bash entry with status `ok` returns the same model with and without `liveTail`.
17. [unit] `toolCardModel` for a running `RunCommand` entry returns the same model with and without `liveTail`.
18. [unit] `reduceTranscript` applying the `tool_result` for a Bash entry that had `liveTail` returns an entry with no `liveTail` member.

### US-006

"The view" is `ShellView` rendered with a `ChatShellOutput` fake and a `ChatBackgroundTasks` fake that lists one shell task `bash-00000001` with `command: "npm test"`, `_shellViewDeps.now` returning a fixed epoch-millisecond value and its timers on the fake clock.

1. [integration] For a running task, the header row shows `npm test` and `running`.
2. [integration] The header row shows the task id `bash-00000001`.
3. [integration] For a running task started 75 seconds before `_shellViewDeps.now()`, the header shows `1m 15s`.
4. [integration] For a task that ended with state `failed` and exit code 2, the header shows `failed` and `exit 2`.
5. [integration] For a task with a description, the header shows the description beside the command.
6. [integration] The body shows the tail lines of `taskTail("bash-00000001")`.
7. [integration] When the tail view is `truncated`, the first body line reads `earlier output dropped; full log: ` followed by the task's `logPath`.
8. [integration] A body line holding the bytes `\u001b[?1049l` is drawn with that control sequence neutralised.
9. [integration] For a running task, the footer reads `esc to return · k to stop`.
10. [integration] For an ended task, the footer reads `esc to return`.
11. [integration] For id `bash-00000009`, which the tasks fake does not list, the header reads `bash-00000009 is no longer listed`.
12. [integration] For that unlisted id, the body is empty.
13. [integration] A redraw of the parent with the same props does not re-render the view, counted through `_shellViewDeps.rendered`.
14. [unit] `shellViewTitle` for a task with `state: "stopped"` names the state `stopped`.
15. [unit] `shellViewFooter(task, "boom")` returns a row reading `boom`.
16. [unit] `shellViewBody(undefined, undefined)` returns no lines.

### US-007

"The view" is as in US-006.

1. [integration] When the fake clock advances `SHELL_VIEW_TICK_MS` with no output, a header that read `1m 15s` reads `1m 16s`.
2. [integration] When the tail gains a line and the fake notifies `bash-00000001`, the body shows the new line as its last visible line once `SHELL_TAIL_REFRESH_MS` has passed.
3. [integration] A notification for a different id does not re-render the view, counted through `_shellViewDeps.rendered`.
4. [integration] When the task ends while the view is open and the tasks fake fires `onChange`, the header shows the ended state without waiting for a tick.
5. [integration] After that, the footer reads `esc to return`.
6. [integration] After that, pressing `k` does not call `tasks.stop`.
7. [integration] Pressing ESC calls `onClose` once.
8. [integration] Pressing `k` while the task runs calls `tasks.stop("bash-00000001")` once.
9. [integration] Pressing `k` while the task runs does not call `onClose`.
10. [integration] When `tasks.stop` throws `NaxError` with message `boom`, the footer row shows `boom`.
11. [integration] When `tasks.stop` throws, `onClose` is not called.
12. [integration] After the view unmounts, the fake clock has no pending timer.
13. [integration] After the view unmounts, a notification for `bash-00000001` causes no render.
14. [integration] After the view unmounts, an `onChange` from the tasks fake causes no render.

### US-008

"Mounting the chat" means `mountChatPicker` with a `tasks` fake and a `shellOutput` fake sharing one running shell task `bash-00000001` (`command: "npm test"`), unless an AC says otherwise.

1. [integration] A left click on the footer strip with that lone running shell and no job opens the shell view: the frame shows the view's header with `npm test` and no longer shows the chat input.
2. [integration] ESC in the opened shell view brings back the chat with its input draft as it was before the view opened.
3. [integration] ctrl+c in the opened shell view closes the view and the chat input reappears.
4. [integration] Enter on the shell row of the jobs picker (opened with ctrl+g) closes the picker and opens the shell view for `bash-00000001`.
5. [integration] Enter on the row of a shell task that has ended opens the shell view for it, showing its ended state.
6. [integration] On a host without `shellOutput`, a strip click on the lone running shell appends the output listing as today.
7. [integration] On a host without `shellOutput`, Enter on a shell row appends the output listing as today.
8. [integration] (control) Enter on a job row of the jobs picker appends the job's output listing as today.
9. [integration] (control) A strip click with one lone running agent task opens the agent view as today.
10. [integration] With two running shells, a strip click opens the jobs picker, not a view.
11. [integration] An ask card arriving while the shell view is open closes the view and shows the card.
12. [integration] While the shell view is open, typed characters do not reach the chat input.

### US-009

**No-test:** documentation only.

1. [review] `docs/guides/chat-shells.md` has a section `Live output` stating that a running Bash card shows the last 5 lines of output and that this is display only.
2. [review] `docs/guides/chat-shells.md` has a section `Shell view` naming the two ways to open it (a strip click on a lone shell, and Enter on a shell row of the jobs picker opened with ctrl+g) and its keys ESC, ctrl+c and `k`.
3. [review] `docs/guides/chat-shells.md` states the tail limits (2000 lines or 256 KiB per shell, 4 MiB in total) and that a truncated view names the log file path.
4. [review] `docs/README.md` has a row linking `guides/chat-shells.md`.
