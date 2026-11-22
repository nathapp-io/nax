# nax chat: live shell output (design)

Date: 2026-11-22. Status: APPROVED (short design, 2026-11-22); this full doc pending the user's read.
Issues: #3022 (foreground Bash tail), #3023 (live shell view). Base: main `d44409d5c` (v0.92.14).

## 1. Intent

`nax chat` is meant to be a full interactive coding agent, at parity with the Claude Code / Codex
terminals the user works in today. Two shell gaps remain from the 2026-11-18 screenshot triage:

- A **foreground** Bash call shows nothing until it ends. During a long build or test run the user
  cannot tell progress from a hang.
- A **background** shell, opened from the footer `N shells` strip or the jobs picker, appends a
  one-shot collapsed listing. Following it means clicking again and again. Background subagents got
  a full-screen live view in #3018; shells did not.

Success: a long command visibly progresses in its card, and any background shell can be opened and
watched live, then left with ESC, the same way subagents work.

## 2. Goals, non-goals, anti-goals

Goals
- G1. While a foreground Bash call of the chat's own session runs, its tool card shows the last 5
  lines of combined stdout/stderr, updating live.
- G2. Opening a shell task (strip click on a lone shell, or Enter on a shell row in the jobs picker)
  opens a full-screen live shell view; ESC (or ctrl+c) returns to the chat exactly as it was.
- G3. A command moved to the background with ctrl+b keeps its output: the view shows what the card
  showed, then continues.
- G4. The view can stop a running shell.

Non-goals
- Live output inside the subagent view for a subagent's own Bash calls (the agent view keeps its
  event log; a later slice may add it).
- Shell output of ACP-backed agents (claude/codex/...): their shells are not ours.
- `nax run` job panels: unchanged.
- Interactive input to a shell (stdin). Output only.
- Colour / ANSI rendering beyond what tool output rendering already does (see 6.4).

Anti-goals (a failure even if it works)
- A1. Anything extra reaching the model's context. The live tail is display only; the tool result
  the model receives is byte-for-byte what it is today.
- A2. Unbounded memory: a chatty command (a `yes`, a verbose test run) must not grow memory without
  limit or drive a render storm.
- A3. Breaking ctrl+b: moving a foreground call must still replay its output to the background log.
- A4. A second, different view pattern: the shell view behaves like the agent view (hidden chat,
  ESC back, lone opens directly, picker otherwise).

## 3. What exists (verified on `d44409d5c`)

nax-agent, `packages/nax-agent/src/tools/bash-background.ts`
- `runMovableForeground` launches a foreground call with `onOutput: output.append`, where
  `outputReplay()` keeps the newest `FOREGROUND_REPLAY_BYTES` (1 MiB) so ctrl+b can replay it into
  the background sink. The buffer is private to the call.
- `BackgroundCommandPort.foreground(call: ForegroundCommand)` registers the call with the host;
  `ForegroundCommand` carries only `command` and `moveToBackground()`. The host never sees output.
- Background launches (`startBashBackground`) stream chunks to `BackgroundCommandSink.append`.
- The tool-call id exists on session events (`tool_call` / `tool_result` carry `callId`,
  `native/session/turn-event-emitter.ts`) and on `ToolCallContext` (`tools/types.ts:198-203`, used
  for logging in `tools/runtime.ts:327,339`). It does NOT reach the tool: `ToolRunContext`
  (`tools/registry.ts:95-135`) has no call id. It must be threaded `ToolCallContext` -> `runTool` ->
  `ToolRunContext` -> `bash.ts` -> `BashExecutionRequest` / `foregroundControl`. That touches the run
  context every tool receives, so it is its own story (builder check, 2026-11-22).
- Only the chat's own session gets the port: `chat-host.ts:319` passes `backgroundCommands: this.tasks`
  through `open-chat-session.ts:202-206`; subagent sessions (`chat/subagent-session.ts`,
  `createAgentSession` at :233/:266) are opened without it. So subagent Bash calls never register as
  foreground calls and never get a tail; no origin filter is needed (verified 2026-11-22).

nax, `packages/nax/src/chat/background/task-registry.ts` (`ChatBackgroundTasks`, `task-types.ts`)
- `adopt()` creates a `bash-xxxxxxxx` task; `append()` writes chunks to the task's log file
  (`<outputDir>/chat-tasks/<id>.log`, `appendFileSync`), with a byte cap (`capped`).
- `output(id, lines)` reads the file tail. `onChange` fires on lifecycle changes only; there is no
  per-output event.
- `foreground(call)` keeps the calls in `foregroundCalls` (for `hasForeground()` / ctrl+b).
- Agent tasks already have the live pattern: `record(event)` into a bounded per-task log with a
  total cap across tasks, plus `onAgentEvents(listener)`.

nax TUI, `packages/nax/src/tui/chat/`
- `use-agent-view.tsx`: `useAgentView` (open id, `display: none` on the chat, `hushes`,
  `closeForCtrlC`, an ask card closes the view) and `withAgentView` (mounts `AgentView` beside the
  hidden chat). `AgentView.tsx` keys: ESC closes, ctrl+o toggles expansion.
- `use-jobs-opener.ts`: strip click with exactly one running task and no job opens an agent's view
  directly, but a lone shell goes to `showOutput` (the static listing). Otherwise the jobs picker.
- `useChatPicker.ts` `showOutput`: one-shot collapsed `listing` of `OUTPUT_TAIL_LINES`.
- `tool-card.ts`: a running card has tone `running`; agent cards preview nested children.

## 4. Approaches considered

1. **Live tail from the source (chosen).** nax-agent exposes the foreground output stream through
   the existing port; the host keeps a bounded in-memory tail per shell (foreground and background)
   with an output-changed event; the card and the view read that tail.
   Covers both gaps with one mechanism, no file polling, and ctrl+b keeps one tail across the move.
2. **Poll the log file on a timer.** Works for background shells only (foreground calls have no
   log file), lags by the interval, re-reads the file each tick. Rejected: does not cover #3022.
3. **Give foreground calls a log file too and poll.** Adds disk writes to every foreground command
   and still polls. Rejected: cost on every call for a display feature, and still laggy.

The user approved approach 1 with the short design (2026-11-22).

## 5. Design

### 5.1 nax-agent: foreground output reaches the host

- `ForegroundCommand` gains a read-only way for the host to receive output as it arrives, and the
  tool-call id of the call (so the TUI can attach the tail to the right card). Shape is the
  builder's, e.g. `callId?: string` plus `onOutput(listener): unsubscribe`, or the port's
  `foreground()` returning a sink. Constraint: the existing replay buffer and the ctrl+b replay
  stay exactly as they are (A3); the host listener is an extra observer, not a replacement.
- No change to what the tool returns to the model (A1).
- The change is additive to the public `BackgroundCommandPort` types; embedders that implement the
  port (koda's runner embeds nax-agent) must keep compiling: new members optional, or a default.

### 5.2 nax host: one live tail per shell

- The registry keeps, per shell (foreground call or background task), a bounded in-memory tail of
  decoded text lines. Bounds (my call): last 2,000 lines or 256 KiB per shell, whichever first, and
  a total cap across all shells (my call: 4 MiB), evicting finished shells' tails oldest first
  (same policy as the agent event logs). The log file stays the durable record and keeps its cap.
- A partial last line (no trailing newline yet) is shown as the current line and completed when
  more output arrives. Carriage returns: a `\r` without `\n` replaces the current line (progress
  bars), my call.
- An output-changed event, `onShellOutput(listener: (id) => void)` or similar, coalesced so a
  chatty command emits at most one notification per frame interval (my call: 100 ms). Consumers
  re-read the tail on notification.
- Foreground calls are addressable by tool-call id; background tasks by task id. On ctrl+b the
  foreground tail moves to the new background task (the same lines, not re-decoded from the file),
  so the view continues where the card left off (G3).
- A foreground tail is dropped when its call ends (the card then shows the normal result).
- A foreground call registered without a call id (an embedder on the old port shape) is still
  registered for `hasForeground()` / ctrl+b as today and still collects its tail (so a ctrl+b move
  keeps it), but no card shows it. Registry keying stays per registration; the call id is a lookup
  index beside it (my call).

### 5.3 TUI: running Bash card (#3022)

- While a Bash card of the chat's own session is in tone `running` and its call has a tail, the
  card shows the last 5 lines of the tail (my call: 5, Claude Code's figure) beneath its header,
  dimmed, each line truncated to the card width (no wrap), refreshed on the coalesced event.
- When the call ends, the card renders exactly as today (result preview), and the tail is gone.
- A call moved with ctrl+b renders as today ("moved to the background as bash-...").
- Elapsed time on the running card if not already shown: builder's call.

### 5.4 TUI: live shell view (#3023)

- A full-screen `ShellView` mounted the same way as `AgentView`: the chat stays mounted and hidden
  (`display: none`), every chat handler hushes while it is open, an ask card closes it.
  Generalise `useAgentView`/`withAgentView` to a "task view" that mounts AgentView or ShellView by
  task kind, rather than a second parallel hook (A4). Naming is the builder's.
- Header: command (and description when present), state (running / succeeded / failed / stopped),
  elapsed time while running or duration when ended, exit code when ended, the task id.
- Body: the tail, following the newest line while the user has not scrolled; scrolling up (wheel,
  PgUp/PgDn, arrows) pins the position; scrolling back to the bottom or End resumes following.
- Beyond the in-memory tail: if the tail was capped or evicted, the view says so on its first line
  and points at the log file path (the file holds more than the tail). My call: no on-demand file
  read in the view in v1.
- Keys: ESC closes; ctrl+c closes (as #3018 ruled for the agent view); `k` stops a running shell
  (my call, Claude Code's key; the jobs picker keeps its ctrl+x). After stop the view stays open
  and shows the stopped state. Copy via the existing mouse selection / `onCopy` path, as AgentView.
- Entry points: a strip click on a lone running shell opens the view directly (replacing
  `showOutput`); Enter on a shell row of the jobs picker opens the view (finished shells too, from
  their tail or the evicted notice). The static `showOutput` listing for shells is removed; job rows
  keep their current behaviour.

## 6. Constraints

- 6.1 Immutability, small files (<400 lines typical, 800 max), functions <50 lines, ChatApp is at its
  cognitive-complexity gate: new logic lives in new hooks/modules, not in `ChatApp.tsx`.
- 6.2 Repo gates: root typecheck, `check:all`, `test:coverage`; no bare `bun test`.
- 6.3 Bun timer and process seams for tests (fake clock for the 100 ms coalescing; no real sleeps).
- 6.4 Output text is untrusted terminal bytes: decode as UTF-8 with replacement, strip or neutralise
  ANSI control sequences the same way existing tool-output rendering does, so a command cannot
  move the cursor or rewrite the screen.

## 7. Left to the builder

- Exact type names and shapes for 5.1 (listener vs returned sink), and threading the call id.
- Where the per-shell tail type lives (registry module vs its own file).
- How the card finds its tail (host lookup by callId vs a prop passed from the transcript model).
- Story split: expected 2 features or one feature of ~8 stories: nax-agent port change; host tail +
  event; ctrl+b move of the tail; card tail; task-view generalisation; ShellView; entry points;
  docs (`docs/guides` chat page).

## 8. Decision log

| # | Decision | By |
|---|----------|----|
| 1 | File #3022 + #3023 and draft the design | user, 2026-11-22 ("proceed") |
| 2 | Approach 1: live tail from the source, shared by card and view | user approved short design |
| 3 | 5 lines in the running card | my call (Claude Code parity) |
| 4 | `k` stops a shell from the view | my call (Claude Code key) |
| 5 | ctrl+c closes the view | follows #3018 ruling for the agent view |
| 6 | Tail caps 2,000 lines / 256 KiB per shell, 4 MiB total, evict finished oldest | my call |
| 7 | 100 ms output-event coalescing | my call |
| 8 | `\r` replaces the current line | my call |
| 9 | No file read beyond the tail in v1; view names the log path | my call |
| 10 | Subagents' own Bash tails and ACP agents' shells out of scope | my call |
| 11 | Call id threaded into `ToolRunContext` as its own story | builder check finding |
| 12 | No origin filter: subagent sessions never get the port (verified wiring) | builder check, answered from code |
| 13 | Call-id-less foreground calls keep a tail but no card shows it | my call |

## 9. Glossary

- Foreground call: a Bash tool call the model waits on; ctrl+b can move it to the background.
- Background task / shell: a `bash-xxxxxxxx` task in the chat's task registry, started with
  `runInBackground: true` or moved there with ctrl+b.
- Tail: the bounded, in-memory newest lines of a shell's output, for display only.
- Strip: the footer's `N shells / N agents / N jobs` segment, clickable.
