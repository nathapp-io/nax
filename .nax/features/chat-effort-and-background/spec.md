# SPEC: chat-effort-and-background — per-model effort, ctrl+t, and background shell commands in `nax chat`

## Summary

Three `nax chat` enhancements, bundled into one feature at the user's request (2026-10-29):

1. **Effort follows the model.** `/effort`, the effort picker and the model picker's left/right
   effort cycling offer only the levels the current model supports, plus `default`. For
   `opencode-go/deepseek-v4.1-flash` (catalog levels `low`, `high`, `max`) the list is
   `default, low, high, max`. `/effort medium` on that model is refused with the supported list
   instead of silently running at `low`. Switching to a model whose effort suffix it does not
   support clamps the suffix to the level the provider would actually use.
2. **ctrl+t cycles effort.** Each press steps to the model's next supported level and wraps:
   `default → low → high → max → default → low …` for the DeepSeek model.
3. **Background shell commands.** The agent's `Bash` tool gains `runInBackground`: the call
   returns at once with a task id and the conversation continues. While the agent waits on an
   ordinary `Bash` call, the user presses **ctrl+b** to move that call to the background (inside
   tmux, whose prefix is ctrl+b, the user presses it twice; tmux's default `send-prefix` passes
   one ctrl+b through). When a background command ends by itself, a `[nax-tasks]` notice is
   delivered as a new turn, so the agent reacts without the user typing. Quitting with tasks or
   nax jobs still running shows a choice card: **quit and stop**, **quit and leave nax jobs
   running**, or **stay in chat**.

## Motivation

- The catalog marks `medium` unsupported for several models (`deepseek-v4.1-flash`,
  `glm-5.3`, `hy3`, ...). nax-ai's `clampThinkingLevel` resolves the `low`/`high` tie to the
  lower level, so a user who picks `medium` silently gets `low`, while `high` works. The
  picker offers all eight levels for every model.
- Switching effort today needs `/effort` plus a picker; the user wants one key.
- A long test suite, build or dev server blocks the conversation for the whole `Bash` call
  (up to `BASH_TIMEOUT_MS`, 300 s), and a dev server cannot run at all. The user wants to keep
  chatting while it runs and be told when it ends (user, 2026-10-29).

## Design

### Approach

**Decided with the user (2026-10-29):**

- `/effort` shows only what the model supports; ctrl+t steps through the same list and wraps
  `max → default → low`.
- Background commands run **inside the nax chat process**, through the same `Bash` tool path as
  a foreground command: command policy, approval card, OS sandbox, interceptor rewrite. Detached
  commands that outlive the chat were rejected because they cannot be sandboxed.
- So background commands always stop when the chat quits; only the existing detached nax jobs
  (`plan`, `run`, `bot_review`, `bot_fix`) can be left running.
- When a background command ends by itself, the agent takes a turn to react. A running turn is
  never interrupted: the notice waits for it. Several ended tasks coalesce into one notice.
- Background commands have no deadline; a command moved with ctrl+b drops its 300 s deadline.

**Builder-level calls (made by the spec author, not the user):**

- `nax-tasks__stop` needs no approval card: it only stops a command this chat started. Stopping
  is immediate: the process group is SIGKILLed, as a turn cancel does today.
- Background tasks belong to the chat host, not one session: `/clear`, `/resume`, ctrl+t,
  shift+tab and `/model` reopen the session and leave tasks running; notices go to the current
  session.
- Only a task that ended by itself (`succeeded` or `failed`) queues a notice; a stopped task
  does not.
- Loop guard: after `MAX_CONSECUTIVE_TASK_NOTICE_TURNS` (3) task-notice turns in a row with no
  user-typed message between them, further task notices stay queued until the user sends a
  message.
- Resource caps, named constants beside the code that uses them:
  `FOREGROUND_REPLAY_BYTES` (1 MiB, the pre-move output kept for replay; oldest bytes dropped
  first), `TASK_LOG_MAX_BYTES` (50 MiB, after which one line
  `[nax] log limit reached; further output dropped` is written and later chunks are dropped),
  `TASK_OUTPUT_MAX_LINES` (500, the most lines `output` returns).
- Tasks are created only when the host has `deps.resources` (the same condition as nax jobs and
  the agents provider); production `nax chat` always passes resources.

### Integration (extends existing code)

Baseline lines exist only to locate code and are never the interface to implement; **Target**
lines are.

**Effort (packages/nax)**

- `src/chat/chat-effort.ts` — read-only: `EFFORT_LEVELS` (all eight, canonical order),
  `isEffortLevel`, `modelEffort`, `withEffort`.
  - Baseline: `cycleEffort(level: EffortLevel, step: 1 | -1): EffortLevel`
  - Target: `cycleEffort(level: EffortLevel, step: 1 | -1, levels: readonly EffortLevel[] = EFFORT_LEVELS): EffortLevel`
    steps within `levels`. When `level` is not in `levels`, step `1` returns the first entry
    whose `EFFORT_LEVELS` rank is higher than `level`'s (wrapping to `levels[0]`); step `-1`
    returns the last entry with a lower rank (wrapping to the last entry).
  - New `export type SupportedEffort = Exclude<EffortLevel, "default">` (derived from nax-agent's
    `THINKING_LEVELS`, already imported here). `ThinkingLevel` from `@nathapp/nax-ai` may be
    named only under `src/agents/catalog/` (`check:nax-ai-imports`), so every chat-side
    signature below uses `SupportedEffort`; nax-ai's `ThinkingLevel` is structurally the same union.
  - New `effortLevelsFor(supported: readonly SupportedEffort[] | undefined): readonly EffortLevel[]`:
    `["default", ...entries of supported in EFFORT_LEVELS order]`; `EFFORT_LEVELS` when
    `undefined`; `["default"]` for `[]`.
  - New `clampEffort(level, levels)`: `level` when listed (`default` always is); otherwise the
    listed non-default level nearest in `EFFORT_LEVELS` rank, a tie going to the lower one
    (mirrors nax-ai's `clampThinkingLevel`); `default` when no non-default level is listed.
  - New `clampModelEffort(model: string, levels: readonly EffortLevel[]): string` =
    `withEffort(model, clampEffort(modelEffort(model), levels))`.
  - All exported from `src/chat/index.ts` beside the existing effort exports.
- `src/agents/catalog/index.ts` (the only nax-ai importer): new
  `lookupThinkingLevels(provider: string, model: string): Promise<readonly ThinkingLevel[] | undefined>`
  (the one site that names nax-ai's `ThinkingLevel`),
  same fail-open contract as `lookupContextWindow`: `catalog.model(provider, model)?.thinkingLevels`,
  `undefined` on miss, load failure or throw.
- `src/chat/chat-models.ts`: new
  `chatEffortLevels(input: { config; models: readonly string[]; lookupThinkingLevels }): Promise<ReadonlyMap<string, readonly EffortLevel[]>>`
  keyed by base model (`provider/id`, no effort suffix); a
  `config.agent.native.catalogOverrides` entry's `thinkingLevels` wins over the catalog; a model
  that neither declares is left out.
- `src/cli/chat.ts`: `_chatCommandDeps` gains `lookupThinkingLevels`; the command composes the map
  for the model choices plus the session's starting model (when `--model` names one) and passes
  it as `ChatHostDeps.effortLevels`. A model outside the map (for example a resumed session's
  model that is not among the choices) falls back to `EFFORT_LEVELS`; that is intended.
- `src/chat/chat-host.ts`:
  - `ChatHostDeps` gains `readonly effortLevels?: ReadonlyMap<string, readonly EffortLevel[]>`.
  - `ChatHost` gains the **optional** method `effortLevels?(model: string): readonly EffortLevel[]`
    (optional like `agents?` and `history?`, so inline test hosts keep compiling); the native
    host returns the map entry for the base model, else `EFFORT_LEVELS`. Callers read
    `host.effortLevels?.(model) ?? EFFORT_LEVELS`.
  - `switchTo({ model })` passes the requested model through `clampModelEffort`.
- `src/tui/chat/picker-model.ts`: `PickerModelInput` gains
  `readonly effortLevels?: readonly EffortLevel[]` (absent = `EFFORT_LEVELS`); the `"effort"`
  picker lists those entries.
- `src/tui/chat/useChatPicker.ts`: `modelOf` passes the current model's levels; `cycle` passes
  the entry model's levels to `cycleEffort`.
- `src/tui/chat/slash-commands.ts`: `effortCommand` validates against the current model's levels.

**Exec layer (packages/nax-agent)**

- `src/internal/argv-exec.ts` — `RunArgvOptions` gains:
  - `readonly releaseDeadline?: AbortSignal` — on abort the deadline timer is cleared; already
    aborted at spawn means no deadline timer is armed; `timedOut` then stays `false`. Its
    listener is removed on every settle path.
  - `readonly onOutput?: (stream: "stdout" | "stderr", chunk: Uint8Array) => void` — called with
    every chunk `drainToEof` reads, in read order, before capture; a throwing callback is
    swallowed and the drain continues.
- `src/sandbox/types.ts`: `LaunchRequest` gains both fields; `src/sandbox/launcher.ts` forwards
  both to `runArgv` on the wrapped and the unwrapped path, as it forwards `signal`.

**Bash background port (packages/nax-agent)**

- New `src/tools/bash-background.ts`:

```ts
export type BackgroundStream = "stdout" | "stderr";
export interface BackgroundCommandEnd {
  readonly exitCode: number;     // -1 when the launch itself failed
  readonly timedOut: boolean;
  readonly aborted: boolean;
  /** Set when the launch rejected (sandbox wrap failure, interceptor throw, spawn failure). */
  readonly launchError?: string;
}
export interface BackgroundCommandHandle {
  readonly command: string;
  readonly description?: string;
  readonly origin: "agent" | "moved";
  readonly ended: Promise<BackgroundCommandEnd>;   // never rejects
  /** Immediately SIGKILLs the process group; `ended` then resolves with `aborted: true`. */
  stop(): void;
}
export interface BackgroundCommandSink {
  readonly id: string;
  append(stream: BackgroundStream, chunk: Uint8Array): void;
}
export interface ForegroundCommand {
  readonly command: string;
  moveToBackground(): void;
}
export interface BackgroundCommandPort {
  adopt(handle: BackgroundCommandHandle): BackgroundCommandSink;
  /** A foreground Bash call registers while it runs; the returned function unregisters it. */
  foreground(call: ForegroundCommand): () => void;
}
```

- `src/tools/bash.ts`: `BashToolOptions` gains `readonly background?: BackgroundCommandPort`.
  - Absent: schema, description and behaviour exactly as today.
  - Present: `bashToolInputSchema` adds `runInBackground: { type: "boolean" }`; the description
    appends one sentence saying the call returns at once with a task id and a notice arrives
    when the command ends.
  - `runInBackground: true`: the tool starts `launchIntercepted` without awaiting it, with a
    tool-owned `AbortController` (never `ctx.signal`) and an already-aborted
    `releaseDeadline`; adopts the handle with `origin: "agent"`; forwards every `onOutput` chunk
    to the sink; returns `{ content: "started in the background as <id>", isError: false }`.
    If the launch promise rejects, `ended` resolves
    `{ exitCode: -1, timedOut: false, aborted: false, launchError: <message> }` — never an
    unhandled rejection.
  - Foreground call while the port is present: launch with a tool-owned controller that
    `ctx.signal` aborts, register `port.foreground({ command, moveToBackground })`, keep the
    most recent `FOREGROUND_REPLAY_BYTES` of `onOutput` chunks, unregister when the call
    settles. `moveToBackground()` (1) aborts the call's `releaseDeadline`, (2) detaches
    `ctx.signal` so a later turn cancel no longer kills the command, (3) adopts with
    `origin: "moved"`, replays the kept chunks to the sink in order, then forwards later ones,
    and (4) returns `{ content: "moved to the background as <id>", isError: false }`.
    `moveToBackground()` after the call settled does nothing.
  - The interceptor's `postProcess` is not applied to background output.
  - New logic lives in `bash-background.ts` helpers so `createBashTool.run` stays within its
    `check:complexity` baseline.
- `src/session/agent-session-types.ts`: `AgentSessionHostPorts` gains
  `readonly backgroundCommands?: BackgroundCommandPort`.
- `src/session/native-backend-options.ts`: the `hostPorts` strict schema accepts
  `backgroundCommands` validated with `hasMethods(["adopt", "foreground"])`, message
  `"must implement adopt and foreground"`.
- Threading, mirroring `unsandboxedCommands`: `native-backend.ts` passes
  `raw.hostPorts?.backgroundCommands` into `buildSessionToolSupport` as `backgroundCommands` →
  `session-tool-support.ts` → `buildCodingToolSupport` → `coding-tool-extras.ts` →
  `createBashTool({ background })`. Each hop omits the key when absent, through a spread helper
  like `unsandboxedToolOptions`, so `coding-tool-support.ts` stays within its complexity
  baseline.
- The five port types are exported from the package entry `@nathapp/nax-agent`; the API
  snapshot `packages/nax-agent/api/nax-agent.api.txt` is regenerated with `bun run api:update`.

**Background tasks (packages/nax)**

- New `src/chat/background/` — `task-types.ts`, `task-registry.ts`, `tasks-provider.ts`,
  `tasks-listing.ts`, `host-tasks.ts`, `index.ts`:

```ts
export type BackgroundTaskState = "running" | "succeeded" | "failed" | "stopped";
export interface BackgroundTask {
  readonly id: string;               // `bash-<8 lowercase hex>`
  readonly command: string;
  readonly description?: string;
  readonly origin: "agent" | "moved";
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly state: BackgroundTaskState;
  readonly exitCode?: number;
  readonly note?: string;            // launchError, when the launch failed
  readonly logPath: string;          // <outputDir>/chat-tasks/<id>.log, machine-local
}
export const TASK_ID_PATTERN = /^bash-[0-9a-f]{8}$/;
export interface ChatBackgroundTasks extends BackgroundCommandPort {
  list(): readonly BackgroundTask[];                 // newest first
  get(id: string): BackgroundTask | undefined;
  running(): readonly BackgroundTask[];
  output(id: string, lines?: number): Promise<string>; // last `lines` log lines, default 40
  stop(id: string): BackgroundTask;                  // NaxError CHAT_TASK_NOT_RUNNING when not running
  stopAll(): Promise<void>;                          // stops every running task; resolves when all ended
  moveForeground(): boolean;                         // newest registered foreground call; false when none
  hasForeground(): boolean;
  peekNotice(): string | undefined;                  // one coalesced notice for every un-noticed ended task
  takeNotice(): string | undefined;                  // returns the peeked text; clears exactly those tasks
  onChange(listener: () => void): () => void;        // adopt, end, foreground register/unregister
}
export function createBackgroundTasks(options: { outputDir: string; now: () => Date; logger: Pick<Logger, "warn"> }): ChatBackgroundTasks;
```

  - State from `BackgroundCommandEnd`: `aborted` → `stopped`; `launchError` → `failed` with
    `note`; `exitCode === 0` and not `timedOut` → `succeeded`; otherwise `failed`.
  - When a task ends by itself, the log gets a final line `[nax] exit code <n>` (or
    `[nax] launch failed: <launchError>`).
  - `_backgroundTaskDeps` exposes `randomHex`, `mkdir`, `appendLog`, `readLog` for tests.
- `tasks-provider.ts` — static `ToolProvider`, id `nax-tasks`, stages `["*"]`, `instructions`
  from the prompt builder below:
  - `list` (no input) → JSON `{ tasks: [{ id, command, state, startedAt, endedAt, exitCode }] }`.
  - `output` (`{ task, lines? }`) → JSON of the task plus `output`; `lines` must be an integer
    1..`TASK_OUTPUT_MAX_LINES`.
  - `stop` (`{ task }`) → `stopped task <id>`.
  - Errors: id failing `TASK_ID_PATTERN` → `{ isError: true, content: "[chat] invalid task id <id>" }`;
    unknown → `"[chat] unknown task <id>"`; not running → `"[chat] task <id> is not running"`;
    bad `lines` → `"[chat] lines must be an integer from 1 to 500"`.
- `host-tasks.ts` — `createHostTasks({ outputDir, now, logger })` returns `{ tasks, provider }`;
  `chat-host.ts` calls it and stays under the 600-line source limit (it is at 572; any
  composition that does not fit moves into `host-tasks.ts`).
- New `src/prompts/builders/background-builder.ts`, exported from `src/prompts/index.ts`:
  - `buildBackgroundTasksInstructions()` — names `Bash` `runInBackground`, `nax-tasks__list`,
    `nax-tasks__output`, `nax-tasks__stop`, and says a `[nax-tasks]` notice arrives when a
    background command ends.
  - `buildBackgroundTaskNotice(tasks)` — one line per task
    `[nax-tasks] background command <id> (<command>) ended: <state>, exit code <n>, log <logPath>`,
    then ``Read its output with `nax-tasks__output`, report the outcome to the user and propose the next step.``
- `src/chat/chat-host.ts`:
  - `ChatHost` gains `readonly tasks?: ChatBackgroundTasks`, set when `deps.resources` is present.
  - All three session-open sites — `startSession` (~line 284), `resumeSession` (~line 374) and
    `reopen` (~line 412) — pass `backgroundCommands: this.tasks` when tasks exist.
  - `toolProviders` order: resource providers, then `nax-jobs` (when present), then `nax-tasks`,
    then `nax-agents` (when present).
  - `src/chat/chat-mcp.ts`: `"nax-tasks"` joins `RESERVED_SERVER_IDS`, so a user MCP server
    cannot shadow the built-in provider.
  - `teardown()` awaits `tasks.stopAll()` **after** `hygiene.close(handle)` (inside
    `closeSessionAndResources`, before `resources.teardown()`), so no in-flight `Bash` call can
    adopt a task afterwards. Once `stopAll()` has begun, `adopt` stops the new handle at once and
    records the task as `stopped`.
- `src/chat/open-chat-session.ts`: the request gains
  `readonly backgroundCommands?: BackgroundCommandPort`; `nativeBackend(...)` receives
  `hostPorts: { ...(commandShadow), ...(backgroundCommands) }`, each key only when present.
- `src/tui/chat/use-jobs.ts`: also subscribes to `host.tasks.onChange` (and works when
  `host.jobs` is absent). When idle, a queued job notice is delivered first; otherwise
  `host.tasks.peekNotice()` with the same deliver-then-take protocol. A running turn is never
  interrupted: notices wait for idle. `useJobs` now returns
  `{ running: readonly ChatJob[]; noteUserTurn(): void }`; it counts consecutive task-notice
  turns, and at `MAX_CONSECUTIVE_TASK_NOTICE_TURNS` stops delivering task notices until
  `noteUserTurn()` is called. `ChatApp.tsx`'s `submit` (the user-typed path) calls
  `noteUserTurn()` before `sendTurn`. Job-notice turns neither count nor reset.
- `src/tui/chat/slash-commands.ts`: `/jobs` appends `formatTasksListing(host.tasks.list())`,
  one line per task `<id> <state> <command>`; nothing when there are no tasks. When `host.jobs`
  is undefined but tasks exist, `/jobs` shows only the task lines; with neither, today's
  `jobs are not available in this session`.

**Keys, footer and quit (packages/nax)**

- `src/tui/chat/useChatKeys.ts`:
  - ctrl+t (ink: `key.ctrl` and `input === "t"`): next = `cycleEffort(modelEffort(model), 1, levels)`.
    Idle → `runControl(() => host.switchTo({ model: withEffort(model, next) }))`. During a
    turn → queued; repeated presses advance from the queued model. `queued` becomes
    `{ mode?: ChatMode; model?: string }`, and `finishTurn` applies a queued mode and a queued
    effort as **one** `host.switchTo(...)` call whose argument omits absent keys (a mode-only
    queue still calls `switchTo({ mode })`).
  - ctrl+b (`key.ctrl`, `input === "b"`): `host.tasks?.moveForeground()`; when that returns
    `false` or there are no tasks, calls the new **optional** option
    `onNotice?: (text: string) => void` with `"no running command to move to the background"`
    (skipped when `onNotice` is absent; `ChatApp` always passes it).
  - `close()` keeps today's `if (host.confirmBeforeClose)` guard: a host without it closes
    synchronously as now (the existing "US-015 AC-14 no-confirmation close synchronously disables
    controls" test keeps passing unchanged); with it, `close()` awaits it and returns without
    closing when it resolves exactly `false`.
- `src/tui/chat/chat-status.ts`: `FooterHint` gains `"background"` →
  `"esc to interrupt · ctrl+b to background"` and `"backgroundTmux"` →
  `"esc to interrupt · ctrl+b ctrl+b to background"`.
- `src/tui/chat/use-clipboard-feedback.ts`: `footerHint`'s input gains `backgroundable: boolean`
  and `tmux: boolean`; `busy && backgroundable` → `"backgroundTmux"` under tmux, else
  `"background"`; quit and clear still win. `ChatApp.tsx` passes
  `backgroundable: host.tasks?.hasForeground() ?? false` and `tmux` read once from
  `TMUX` through an injectable deps object.
- `src/chat/ask-controller.ts`:
  - New `HostChoiceCard { tool; summary; reason; choices: readonly { id: string; label: string }[]; fallback: string; signal? }`.
  - New `requestHostChoice(card): Promise<string>` — resolves the chosen id; `fallback` on
    timeout, on abort and on `reset()`. Request ids are `host-choice-<n>`, so the existing
    `startsWith("host-")` guards in `handle()` and `canRemember` skip them; pending choices
    live in their own map, which `reset()` settles with each card's `fallback`.
  - Pending variant `{ type: "host_choice", requestId, tool, summary, reason, choices, fallback, at, expiresAt }`
    appears in `pending()`; `ChatPendingAsk` widens to include it; `resolveChoice(requestId, id)`
    answers it.
- `src/tui/chat/ask-card.ts`, `AskCard.tsx`: `askCardModel` maps `host_choice` to
  `AskCardChoice { kind: "choice"; title; summary; reason; fallback; options: { index; label; id }[] }`.
  A number key or Return on the selection resolves that id; escape resolves `fallback`.
- New `src/chat/close-confirm.ts` — `createCloseConfirm({ hostJobs?, tasks?, asks, logger }): () => Promise<boolean>`:
  - Nothing running (no owned jobs, no running tasks) → `true`, no card.
  - Otherwise `requestHostChoice` with `tool: "nax-close"`, `fallback: "stay"`, summary
    `"<j> nax job(s) and <t> background command(s) still running: <ids>"`, and choices
    `stop` "Quit and stop them"; `leave` "Quit and leave nax jobs running (background commands stop)"
    (only when owned jobs exist); `stay` "Stay in chat".
  - `stop`: `chains.stop("the chat closed")`, cancel each owned job (warn and continue on a
    failed cancel), await `tasks.stopAll()`, → `true`.
  - `leave`: `chains.stop("the chat closed")`, await `tasks.stopAll()`, → `true`.
  - `stay`: stops nothing (chains stay active), → `false`.
  - It never calls `createHostJobs().close()` (its `AbortController` abort is irreversible);
    the host's own `close()` still calls it after a quitting choice.
- `src/chat/jobs/jobs-host.ts`: `confirmClose` is removed from `createHostJobs`'s return value;
  its behaviour moves to `close-confirm.ts`. `ChatHost.confirmJobsBeforeClose` is renamed
  `confirmBeforeClose?: () => Promise<boolean>`, set when jobs or tasks exist.

### Failure Handling

| Case | Behaviour |
|:--|:--|
| Catalog load fails or model unknown | `lookupThinkingLevels` → `undefined`; model falls back to `EFFORT_LEVELS` |
| `/effort <level>` not offered by the model | `effort "<level>" is not available for <model>; use one of: <levels>`; no switch |
| `/effort <word>` not a level | `unknown effort "<word>"; use one of: <model's levels>`; no switch |
| `onOutput` callback throws | Swallowed; capture and drain continue |
| Background launch rejects (sandbox wrap, interceptor, spawn) | `ended` resolves with `exitCode -1` and `launchError`; task `failed` with `note`; a notice is queued |
| Log append fails | Task keeps running and its state still updates; one `logger.warn`; later chunks dropped |
| Log reaches `TASK_LOG_MAX_BYTES` | One limit line written; later chunks dropped; task keeps running |
| ctrl+b with no foreground Bash call | Notice `no running command to move to the background` |
| Quit card times out or is escaped | Resolves `stay`; the chat stays open |
| `nax-tasks__stop` on a finished task | `[chat] task <id> is not running` |

## Out of Scope

- Background commands that survive quitting `nax chat`: rejected by the user, because detached commands cannot run in the OS sandbox.
- Killing background commands when the nax chat process itself crashes or is SIGKILLed: only graceful exits (quit, SIGTERM, SIGHUP through `cli/chat.ts`) stop them; a crash can orphan their process groups.
- Keeping a background command's session-scoped sandbox state (its `TMPDIR` and command shadow) alive after `/clear`, `/resume` or a model switch closes that session: a command that depends on its session `TMPDIR` after the switch may fail.
- A cap on the number of concurrently running background commands.
- Pruning old task log files under `<outputDir>/chat-tasks/`, which, like nax job logs, are machine-local and kept.
- Background commands from subagent sessions: only the parent chat session receives the `backgroundCommands` port.
- Background support for the `RunCommand` tool's argv branch: only `Bash` gains `runInBackground`.
- Interceptor `postProcess` rewriting of background command output.
- A dedicated TUI panel for background tasks: `/jobs` lists them and notices report their end.
- An approval card for `nax-tasks__stop`.
- Persisting background task records across chat processes: tasks are in-memory; only logs stay on disk.
- Changing nax-ai's `clampThinkingLevel` or the pi-ai catalog data.
- Changing effort handling in `nax run` / `nax plan` profiles: only the chat TUI changes.
- A configurable ctrl+t or ctrl+b binding, or any tmux configuration change.

## Stories

Thirteen stories. The feature bundles two capabilities (per-model effort, background commands)
at the user's request; every split below exists only to keep each story at or under 24
assertions once `nax plan` splits compound criteria.

### US-001 — effort levels per model: core

Workdir: packages/nax. No dependencies.

`SupportedEffort`, `effortLevelsFor`, `clampEffort`, `clampModelEffort` and the new
`cycleEffort` signature in `src/chat/chat-effort.ts`; `lookupThinkingLevels`;
`chatEffortLevels`; composition in `src/cli/chat.ts`; `ChatHost.effortLevels?` and the clamp in
`switchTo`. Tests extend `test/unit/chat/chat-effort.test.ts`,
`test/unit/chat/chat-models.test.ts` and `test/unit/cli/chat.test.ts`, and add
`lookupThinkingLevels` cases beside the existing `lookupContextWindow` tests.

### US-002 — effort levels per model: picker, `/effort` and ctrl+t

Workdir: packages/nax. Depends on US-001.

The effort picker, the model picker's effort cycle and `/effort` read the model's levels;
ctrl+t and the combined queued switch in `useChatKeys`. UI tests extend
`test/ui/chat/effort-command.test.tsx` and `test/ui/chat/picker-effort.test.tsx`, and add a new
`test/ui/chat/effort-keys.test.tsx` whose fixture `switchTo` updates `current()`.

### US-003 — runArgv deadline release and output tee

Workdir: packages/nax-agent. No dependencies.

`releaseDeadline` and `onOutput` on `RunArgvOptions` and `LaunchRequest`, forwarded in
`src/sandbox/launcher.ts`. Tests extend `test/unit/internal/argv-exec.test.ts` and
`test/unit/sandbox/launcher.test.ts`, with `_argvExecDeps` timers.

### US-004 — the Bash tool: `runInBackground`

Workdir: packages/nax-agent. Depends on US-003.

New `src/tools/bash-background.ts` (the port types and helpers) and the `background` option on
`createBashTool`: schema, description, the unawaited background launch and launch-failure
handling. Tests go in a new `test/unit/tools/bash-background.test.ts`, stubbing
`_bashToolDeps.runArgv`.

### US-005 — the Bash tool: moving a foreground call to the background

Workdir: packages/nax-agent. Depends on US-004.

Foreground registration through `port.foreground`, `moveToBackground()`, the
`FOREGROUND_REPLAY_BYTES` replay and the `ctx.signal` detach. Tests go in a new
`test/unit/tools/bash-background-move.test.ts`.

### US-006 — `hostPorts.backgroundCommands` and the public port types

Workdir: packages/nax-agent. Depends on US-005.

`AgentSessionHostPorts.backgroundCommands`, its schema check, the threading from
`native-backend.ts` to `createBashTool`, the package-entry exports and the API snapshot. Tests
extend `test/unit/session/native-backend-options.test.ts` and add a session-level case to the
existing native-backend tests.

### US-007 — the background task registry: adopt, log and state

Workdir: packages/nax. Depends on US-006.

New `src/chat/background/task-types.ts`, `task-registry.ts` and `index.ts`: ids, log writing and
its cap, state mapping and `output`. Tests go in a new
`test/unit/chat/background/task-registry.test.ts`.

### US-008 — the background task registry: notices, stop and foreground

Workdir: packages/nax. Depends on US-007.

`peekNotice`/`takeNotice` coalescing, `stop`, `stopAll` (including adopt after `stopAll`),
`moveForeground`/`hasForeground` and `onChange`. Tests go in a new
`test/unit/chat/background/task-registry-notices.test.ts`.

### US-009 — `nax-tasks` tools, listing and prompt text

Workdir: packages/nax. Depends on US-008.

New `tasks-provider.ts`, `tasks-listing.ts`, `host-tasks.ts` and
`src/prompts/builders/background-builder.ts`. Tests go in new
`test/unit/chat/background/tasks-provider.test.ts` and
`test/unit/prompts/builders/background-builder.test.ts`.

### US-010 — wiring tasks into the chat host, notices and `/jobs`

Workdir: packages/nax. Depends on US-009.

`ChatHost.tasks`, `backgroundCommands` at all three open sites and in `open-chat-session.ts`,
provider order, `stopAll` in teardown, task-notice delivery with the loop guard in
`use-jobs.ts` and `noteUserTurn` in `ChatApp.tsx`, and the `/jobs` task lines. Tests go in a new
`test/unit/chat/chat-host-tasks.test.ts` (fixture built like
`test/unit/chat/chat-host-jobs.test.ts`) and a new `test/ui/chat/task-notices.test.tsx`.

### US-011 — ctrl+b and the footer hint

Workdir: packages/nax. Depends on US-002, US-010.

ctrl+b and `onNotice` in `useChatKeys`, the two `FooterHint` kinds, and the `ChatApp.tsx`
wiring. Tests go in a new `test/ui/chat/background-keys.test.tsx`, plus two new rows in
`HINT_CASES` in `test/unit/tui/chat/chat-status.test.ts` and new `footerHint` cases there.

### US-012 — the `host_choice` ask and its card

Workdir: packages/nax. Depends on US-011.

`HostChoiceCard`, `requestHostChoice`, `resolveChoice`, the `host_choice` pending variant, and
the `choice` card in `ask-card.ts` / `AskCard.tsx`. Tests extend the existing ask-controller and
ask-card tests and add a new `test/ui/chat/choice-card.test.tsx`.

### US-013 — the three-choice quit: `createCloseConfirm`

Workdir: packages/nax. Depends on US-012.

New `src/chat/close-confirm.ts`, removal of `confirmClose` from `createHostJobs`, the
`confirmBeforeClose` rename on `ChatHost`, and `useChatKeys.close()` honouring `false`. Tests
add `test/unit/chat/close-confirm.test.ts` and update the close tests listed under Modifies.

### Context Files

**US-001**
- `packages/nax/src/chat/chat-effort.ts`
- `packages/nax/src/agents/catalog/index.ts`
- `packages/nax/src/chat/chat-models.ts`
- `packages/nax/src/chat/chat-host.ts`
- `packages/nax/src/cli/chat.ts`

**US-002**
- `packages/nax/src/tui/chat/picker-model.ts`
- `packages/nax/src/tui/chat/useChatPicker.ts`
- `packages/nax/src/tui/chat/slash-commands.ts`
- `packages/nax/src/tui/chat/useChatKeys.ts`
- `packages/nax/test/helpers/chat-picker.tsx`

**US-003**
- `packages/nax-agent/src/internal/argv-exec.ts`
- `packages/nax-agent/src/sandbox/launcher.ts`
- `packages/nax-agent/src/sandbox/types.ts`
- `packages/nax-agent/test/unit/internal/argv-exec.test.ts`

**US-004**
- `packages/nax-agent/src/tools/bash.ts`
- `packages/nax-agent/src/internal/exec-framing.ts`
- `packages/nax-agent/test/unit/tools/bash.test.ts`

**US-005**
- `packages/nax-agent/src/tools/bash.ts`
- `packages/nax-agent/src/tools/bash-background.ts` — created by US-004, extended here

**US-006**
- `packages/nax-agent/src/session/agent-session-types.ts`
- `packages/nax-agent/src/session/native-backend-options.ts`
- `packages/nax-agent/src/session/native-backend.ts`
- `packages/nax-agent/src/session/session-tool-support.ts`
- `packages/nax-agent/src/coding-tools/coding-tool-support.ts`

**US-007**
- `packages/nax/src/chat/jobs/job-runner.ts`
- `packages/nax/src/chat/jobs/job-store.ts`
- `packages/nax/src/chat/jobs/job-types.ts`

**US-008**
- `packages/nax/src/chat/background/task-registry.ts` — created by US-007, extended here
- `packages/nax/src/chat/jobs/job-runner.ts`

**US-009**
- `packages/nax/src/chat/jobs/jobs-provider.ts`
- `packages/nax/src/chat/jobs/jobs-listing.ts`
- `packages/nax/src/prompts/builders/workflow-builder.ts`
- `packages/nax/src/chat/background/task-registry.ts` — created by US-007, read here

**US-010**
- `packages/nax/src/chat/chat-host.ts`
- `packages/nax/src/chat/open-chat-session.ts`
- `packages/nax/src/tui/chat/use-jobs.ts`
- `packages/nax/src/tui/chat/ChatApp.tsx`
- `packages/nax/src/chat/background/host-tasks.ts` — created by US-009, wired here

**US-011**
- `packages/nax/src/tui/chat/useChatKeys.ts`
- `packages/nax/src/tui/chat/use-clipboard-feedback.ts`
- `packages/nax/src/tui/chat/chat-status.ts`
- `packages/nax/src/tui/chat/ChatApp.tsx`

**US-012**
- `packages/nax/src/chat/ask-controller.ts`
- `packages/nax/src/tui/chat/ask-card.ts`
- `packages/nax/src/tui/chat/AskCard.tsx`

**US-013**
- `packages/nax/src/chat/jobs/jobs-host.ts`
- `packages/nax/src/chat/chat-host.ts`
- `packages/nax/src/tui/chat/useChatKeys.ts`
- `packages/nax/test/unit/chat/chat-host-chain.test.ts`
- `packages/nax/test/unit/chat/chat-host-jobs.test.ts`

### Creates

**US-001**
- None.

**US-002**
- `packages/nax/test/ui/chat/effort-keys.test.tsx`

**US-003**
- None.

**US-004**
- `packages/nax-agent/src/tools/bash-background.ts`
- `packages/nax-agent/test/unit/tools/bash-background.test.ts`

**US-005**
- `packages/nax-agent/test/unit/tools/bash-background-move.test.ts`

**US-006**
- None.

**US-007**
- `packages/nax/src/chat/background/task-types.ts`
- `packages/nax/src/chat/background/task-registry.ts`
- `packages/nax/src/chat/background/index.ts`
- `packages/nax/test/unit/chat/background/task-registry.test.ts`

**US-008**
- `packages/nax/test/unit/chat/background/task-registry-notices.test.ts`

**US-009**
- `packages/nax/src/chat/background/tasks-provider.ts`
- `packages/nax/src/chat/background/tasks-listing.ts`
- `packages/nax/src/chat/background/host-tasks.ts`
- `packages/nax/src/prompts/builders/background-builder.ts`
- `packages/nax/test/unit/chat/background/tasks-provider.test.ts`
- `packages/nax/test/unit/prompts/builders/background-builder.test.ts`

**US-010**
- `packages/nax/test/unit/chat/chat-host-tasks.test.ts`
- `packages/nax/test/ui/chat/task-notices.test.tsx`

**US-011**
- `packages/nax/test/ui/chat/background-keys.test.tsx`

**US-012**
- `packages/nax/test/ui/chat/choice-card.test.tsx`

**US-013**
- `packages/nax/src/chat/close-confirm.ts`
- `packages/nax/test/unit/chat/close-confirm.test.ts`

### Modifies

**US-001**
- `packages/nax/test/unit/chat/chat-effort.test.ts` — the `cycleEffort` table calls the two-argument form; it keeps passing because `levels` defaults to `EFFORT_LEVELS`, and new rows add the three-argument form.
- `packages/nax/test/unit/cli/chat.test.ts` — composition tests that pin the exact `createChatHost` deps object must accept the new `effortLevels` map; the invariant is that `models` is unchanged and `effortLevels` holds an entry per model whose levels are known.

**US-002**
- `packages/nax/test/ui/chat/effort-command.test.tsx` — "AC-7 AC-8 AC-9 shows eight ordered levels with current marked" asserts the picker always lists all of `EFFORT_LEVELS`; the picker now lists the model's levels, so that fixture's host leaves `effortLevels` undefined (falling back to all eight) for the expectation to hold.
- `packages/nax/test/ui/chat/picker-effort.test.tsx` — the model-picker cycle test expects `cycleEffort("high", 1)` over all eight levels; cycling steps within the entry model's levels, so the expectation passes the same `levels` the fixture host returns (all eight when it defines none).

**US-003**
None. Both options are additive and optional; no existing assertion pins `RunArgvOptions` or `LaunchRequest` as closed shapes.

**US-004**
None. With no `background` option the tool is unchanged, which is what existing Bash tests construct.

**US-005**
None. The move path exists only when a `background` port is supplied.

**US-006**
- `packages/nax-agent/test/unit/session/native-backend-options.test.ts` — any test pinning the accepted `hostPorts` keys as exactly `protectedPaths`, `commandShadow`, `commandInterceptor` must accept `backgroundCommands` as a fourth; unknown `hostPorts` keys are still rejected.
- `packages/nax-agent/api/nax-agent.api.txt` — the public API snapshot gains the five exported port types; regenerate with `bun run api:update` so `check:api` and the public-surface test pass.

**US-007**
None. Every file is new.

**US-008**
None. Only US-007's new files change.

**US-009**
- `packages/nax/src/prompts/index.ts` — gains the exports `buildBackgroundTaskNotice` and `buildBackgroundTasksInstructions`; no existing export changes.

**US-010**
- `packages/nax/test/unit/chat/chat-host-jobs.test.ts` — "AC-1/4/5/23 composes ordered provider instructions" asserts `toolProviders.slice(-2)` is `["nax-jobs", "nax-agents"]`; with `nax-tasks` between them the expected tail is `["nax-jobs", "nax-tasks", "nax-agents"]`. "AC-2/3/24 no entry preserves resource providers" asserts `request.toolProviders` is the resource array itself; with resources present the host appends `nax-tasks`, so the invariant becomes: the resource providers come first, in order, `nax-tasks` follows, and `nax-jobs` is absent.
- `packages/nax/test/unit/chat/chat-host-resources.test.ts` — asserts `request.toolProviders` `toBe(f.resources.toolProviders)` across start, switch and resume (~line 131) and `objectContaining({ toolProviders: f.resources.toolProviders })` (~line 248); with resources present the host appends `nax-tasks`, so the invariant becomes: the request's providers begin with the resource providers in order, followed by `nax-tasks`.
- `packages/nax/test/unit/chat/host-subagents.test.ts` — "AC-2 start passes the resources' own providers when the catalog has no agents" asserts `toolProviders` `toBe(h.resources.toolProviders)`; the invariant becomes: the resource providers in order, followed by `nax-tasks`, and no `nax-agents`.
- `packages/nax/src/chat/chat-host.ts` — gains `tasks`, `backgroundCommands` at the three open sites, provider order and `stopAll` in teardown; it must stay at or under 600 lines, moving composition into the US-009 host-tasks module under src/chat/background as needed.
- `packages/nax/src/tui/chat/ChatApp.tsx` — reads `useJobs`'s new return shape and calls `noteUserTurn()` in `submit` before `sendTurn`; no other change.
- `packages/nax/src/chat/chat-mcp.ts` — `"nax-tasks"` is added to `RESERVED_SERVER_IDS` so a user MCP server cannot shadow the new built-in provider.
- `packages/nax/test/unit/chat/chat-mcp.test.ts` — any assertion pinning the reserved-id set must include `nax-tasks`; the invariant stays that a reserved id is rejected with `[resources] mcp server id <id> is reserved`.

**US-011**
- `packages/nax/src/tui/chat/ChatApp.tsx` — passes `onNotice` to `useChatKeys` and `backgroundable`/`tmux` to `footerHint`; no other change.

**US-012**
- `packages/nax/test/ui/chat/ask-card.test.tsx` — its `fakeController` builds a fully typed `ChatAskController` literal; the interface gains `requestHostChoice` and `resolveChoice`, so the fake gains inert stubs for both (the test typecheck); no assertion changes.
- `packages/nax/test/ui/chat/slash-commands.test.tsx` — its typed `ChatAskController` literal gains inert `requestHostChoice` and `resolveChoice` stubs for the same reason; no assertion changes.
- `packages/nax/test/ui/chat/chat-app.test.tsx` — its typed `ChatAskController` literal gains inert `requestHostChoice` and `resolveChoice` stubs for the same reason; no assertion changes.

**US-013**
- `packages/nax/test/unit/chat/chat-host-jobs.test.ts` — "AC-12", "AC-13/14/16" and "AC-15" call `confirmJobsBeforeClose` and answer a `nax-jobs__close` allow/deny card; they move to `confirmBeforeClose` and a `nax-close` choice card, `stop` replacing allow and `leave` replacing deny, keeping the cancel-each-owned-job and warn-and-continue assertions. "AC-2/3/24" and "without resources an entry alone registers no jobs" assert `confirmJobsBeforeClose` is `undefined`; the field is renamed `confirmBeforeClose`, defined when tasks exist (resources present) and `undefined` without resources.
- `packages/nax/test/unit/chat/chat-host-chain.test.ts` — "AC-15 stops before an empty close without asking" and "AC-16 stops before one close approval and keeps a declined job running" assert chains stop before the ask through `createHostJobs().confirmClose`; `confirmClose` is removed and chains stop only after a quitting choice, so these tests drive `createCloseConfirm` and assert: empty close → chain stopped with reason `the chat closed` and no card; `leave` → chain stopped and the job kept running; `stay` → chain still active. The close-race test keys its stub on `card.tool === "nax-jobs__close"`; the card is now `requestHostChoice` with tool `nax-close`, and the invariant stays that a chain activation racing a quitting close ends with no active chain.
- `packages/nax/test/ui/chat/chat-jobs-close.test.tsx` — mounts with `confirmJobsBeforeClose` and expects `decisions` `["allow"]`; it moves to `confirmBeforeClose` resolving `true`/`false`, and `false` leaves the app mounted.
- `packages/nax/src/chat/jobs/jobs-host.ts` — `confirmClose` and its now-unused `errorMessage` import are removed from `createHostJobs`; `close()` and `sessionChanged()` stay.

### Seams

- US-001 adds `ChatHost.effortLevels?`; US-002's picker, `/effort` and ctrl+t ACs consume it.
- US-001's `chatEffortLevels` reaches production through `src/cli/chat.ts`; US-001 carries that seam AC.
- US-004/US-005 define the port and the `background` option; US-006 threads `hostPorts.backgroundCommands` to it and carries the session-level seam ACs.
- US-007–US-009 build the registry and provider; US-010 passes them through all three open sites and `open-chat-session.ts` and carries those seam ACs.
- US-010 exposes `ChatHost.tasks` with `moveForeground`/`hasForeground`; US-011 carries the ctrl+b seam AC.
- US-012 adds `requestHostChoice`; US-013's close tests consume it.

## Acceptance Criteria

### US-001 — effort levels per model: core

- [unit] `effortLevelsFor(["low", "high", "max"])` returns `["default", "low", "high", "max"]`.
- [unit] `effortLevelsFor(["max", "low"])` returns `["default", "low", "max"]`.
- [unit] `effortLevelsFor(undefined)` returns `EFFORT_LEVELS`.
- [unit] `effortLevelsFor([])` returns `["default"]`.
- [unit] `cycleEffort("max", 1, ["default", "low", "high", "max"])` returns `"default"`.
- [unit] `cycleEffort("default", 1, ["default", "low", "high", "max"])` returns `"low"`.
- [unit] `cycleEffort("medium", 1, ["default", "low", "high", "max"])` returns `"high"`.
- [unit] `cycleEffort("medium", -1, ["default", "low", "high", "max"])` returns `"low"`.
- [unit] `cycleEffort("high", 1)` with no third argument returns `"xhigh"`.
- [unit] `clampEffort("medium", ["default", "low", "high", "max"])` returns `"low"`.
- [unit] `clampEffort("xhigh", ["default", "low", "high", "max"])` returns `"high"`.
- [unit] `clampEffort("high", ["default"])` returns `"default"`.
- [unit] `clampModelEffort("p/m[medium]", ["default", "low", "high"])` returns `"p/m[low]"`.
- [unit] With `_catalogDeps.loadProviders` resolving a catalog whose `opencode-go/deepseek-v4.1-flash` has `thinkingLevels` `["low", "high", "max"]`, `lookupThinkingLevels("opencode-go", "deepseek-v4.1-flash")` resolves `["low", "high", "max"]`.
- [unit] With `_catalogDeps.loadProviders` rejecting, `lookupThinkingLevels("p", "m")` resolves `undefined`.
- [unit] `chatEffortLevels` for models `["p/m[high]"]` with `lookupThinkingLevels` resolving `["low", "max"]` returns a map whose `"p/m"` entry is `["default", "low", "max"]`.
- [unit] `chatEffortLevels` with `config.agent.native.catalogOverrides` `[{ provider: "p", models: [{ id: "m", thinkingLevels: ["high"], ... }] }]` and `lookupThinkingLevels` resolving `["low"]` maps `"p/m"` to `["default", "high"]`.
- [unit] A native chat host created with `effortLevels` mapping `"p/m"` to `["default", "low", "high", "max"]` returns that list from `effortLevels("p/m[high]")`.
- [unit] A native chat host created with `effortLevels` mapping only `"p/m"` returns `EFFORT_LEVELS` from `effortLevels("p/other")`.
- [unit] A native chat host whose `effortLevels` maps `"p/m"` to `["default", "low", "high", "max"]`, on `switchTo({ model: "p/m[medium]" })`, opens the next session with model `"p/m[low]"`.
- [integration] Seam: the `nax chat` command composition, with `_chatCommandDeps.listCatalogModels` returning `["p/m"]` and `_chatCommandDeps.lookupThinkingLevels` returning `["low", "max"]` for `p/m`, calls `createChatHost` with deps whose `effortLevels` maps `"p/m"` to `["default", "low", "max"]`.

### US-002 — effort levels per model: picker, `/effort` and ctrl+t

- [integration] With the session on `p/m` and `host.effortLevels` returning `["default", "low", "high", "max"]`, `/effort` opens an effort picker whose entry values are exactly `["default", "low", "high", "max"]`.
- [integration] With the session on `p/m` and those levels, `/effort medium` shows `effort "medium" is not available for p/m; use one of: default, low, high, max` and does not call `host.switchTo`.
- [integration] With the session on `p/m` and those levels, `/effort bogus` shows `unknown effort "bogus"; use one of: default, low, high, max` and does not call `host.switchTo`.
- [integration] In the model picker, pressing right on entry `p/m` with effort `max` and `host.effortLevels` returning `["default", "low", "high", "max"]` sets that entry's effort label to `default`.
- [integration] With the session idle on `p/m[max]` and those levels, pressing ctrl+t calls `host.switchTo` with `{ model: "p/m" }`.
- [integration] With the session idle on `p/m`, those levels, and a fixture `switchTo` that updates `current()`, pressing ctrl+t calls `host.switchTo` with `{ model: "p/m[low]" }`.
- [integration] With a turn running on `p/m[low]` and those levels, pressing ctrl+t twice makes no `host.switchTo` call before the turn ends.
- [integration] With a turn running on `p/m[low]` and those levels, pressing ctrl+t twice leads, after the turn ends, to exactly one `host.switchTo` call, with `{ model: "p/m[max]" }`.
- [integration] With a turn running on `p/m` in mode `guarded` and those levels, pressing shift+tab then ctrl+t leads, after the turn ends, to exactly one `host.switchTo` call, with `{ mode: "full", model: "p/m[low]" }`.
- [integration] With a turn running in mode `guarded`, pressing only shift+tab leads, after the turn ends, to exactly one `host.switchTo` call, with `{ mode: "full" }` and no `model` key.

### US-003 — runArgv deadline release and output tee

- [unit] `runArgv` with `timeoutMs` 1000 and a `releaseDeadline` signal aborted before the fake clock reaches 1000 ms does not kill the command at 1000 ms.
- [unit] `runArgv` with `timeoutMs` 1000 and a `releaseDeadline` aborted before 1000 ms resolves with `timedOut: false`.
- [unit] `runArgv` with an already-aborted `releaseDeadline` never calls `_argvExecDeps.setTimeout` with `timeoutMs` as the delay.
- [unit] `runArgv` with a `releaseDeadline` that never aborts removes its abort listener from that signal by the time it resolves.
- [unit] `runArgv` with an `onOutput` spy, for a command printing `a` to stdout, calls the spy with `"stdout"` and the bytes of `a`.
- [unit] `runArgv` with an `onOutput` spy, for a command printing `b` to stderr, calls the spy with `"stderr"` and the bytes of `b`.
- [unit] `runArgv` with an `onOutput` that throws on every call still resolves the full `stdout` of the command.
- [unit] `runArgv` with neither option kills a hung command at `timeoutMs` and resolves `timedOut: true`.
- [unit] The sandbox launcher's `run` with `releaseDeadline` and `onOutput` set calls `_launcherDeps.runArgv` with both fields on the wrapped path.
- [unit] The sandbox launcher's `run` with `unwrapped: true` and both fields set calls `_launcherDeps.runArgv` with both fields on the unwrapped path.

### US-004 — the Bash tool: `runInBackground`

- [unit] `createBashTool({})` returns an input schema with no `runInBackground` property.
- [unit] `createBashTool({})` returns a description identical to today's.
- [unit] `createBashTool({ background: port })` returns an input schema with a boolean `runInBackground` property.
- [unit] `createBashTool({ background: port })` returns a description ending with the background sentence.
- [unit] With `background: port` whose `adopt` returns sink id `bash-1a2b3c4d`, `run({ command: "sleep 9", runInBackground: true })` resolves with content `started in the background as bash-1a2b3c4d` while the stubbed `runArgv` promise is still pending.
- [unit] With `background: port`, `run({ command: "sleep 9", runInBackground: true })` resolves with `isError` false.
- [unit] With `background: port`, a `runInBackground: true` call passes `runArgv` an already-aborted `releaseDeadline`.
- [unit] With `background: port`, a `runInBackground: true` call passes `runArgv` a `signal` that is not `ctx.signal`.
- [unit] With `background: port`, a `runInBackground: true` call for `sleep 9` adopts a handle whose `origin` is `"agent"`.
- [unit] With `background: port`, a `runInBackground: true` call for `sleep 9` adopts a handle whose `command` is `"sleep 9"`.
- [unit] With `background: port`, aborting `ctx.signal` after a `runInBackground: true` call returned does not abort the `signal` passed to `runArgv`.
- [unit] With `background: port`, calling the adopted handle's `stop()` aborts the `signal` passed to `runArgv`.
- [unit] With `background: port`, when the stubbed `runArgv` invokes `onOutput("stdout", "x")` for a `runInBackground: true` call, the sink's `append` receives `("stdout", "x")`.
- [unit] With `background: port`, when `runArgv` resolves `{ exitCode: 3, timedOut: false }` for a `runInBackground: true` call, the handle's `ended` resolves with `exitCode` 3.
- [unit] With `background: port`, when the stubbed `runArgv` rejects with `Error("wrap failed")` for a `runInBackground: true` call, the handle's `ended` resolves `{ exitCode: -1, timedOut: false, aborted: false, launchError: "wrap failed" }`.
- [unit] With `background: port`, when the stubbed `runArgv` rejects for a `runInBackground: true` call, no unhandled promise rejection is raised.

### US-005 — the Bash tool: moving a foreground call to the background

- [unit] With `background: port`, a foreground `run({ command: "bun test" })` calls `port.foreground` once with `command: "bun test"`.
- [unit] With `background: port`, when a foreground `run({ command: "bun test" })` settles, the function `port.foreground` returned is called once.
- [unit] With `background: port` whose `adopt` returns sink id `bash-1a2b3c4d`, calling the registered call's `moveToBackground()` while `runArgv` is pending resolves the tool call with content `moved to the background as bash-1a2b3c4d`.
- [unit] With `background: port`, a tool call moved by `moveToBackground()` resolves with `isError` false.
- [unit] With `background: port`, `moveToBackground()` aborts the `releaseDeadline` passed to `runArgv`.
- [unit] With `background: port`, `moveToBackground()` adopts a handle whose `origin` is `"moved"`.
- [unit] With `background: port`, chunks emitted through `onOutput` before `moveToBackground()` are appended to the sink in emission order before any later chunk.
- [unit] With `background: port`, when `FOREGROUND_REPLAY_BYTES` plus 10 bytes are emitted before the move, the replay appended to the sink is at most `FOREGROUND_REPLAY_BYTES` long.
- [unit] With `background: port`, when more than `FOREGROUND_REPLAY_BYTES` are emitted before the move, the replay appended to the sink ends with the last emitted byte.
- [unit] With `background: port`, aborting `ctx.signal` after `moveToBackground()` does not abort the `signal` passed to `runArgv`.
- [unit] With `background: port`, aborting `ctx.signal` on a foreground call before any move aborts the `signal` passed to `runArgv`.
- [unit] With `background: port`, calling `moveToBackground()` after the foreground call resolved does not call `port.adopt`.

### US-006 — `hostPorts.backgroundCommands` and the public port types

- [unit] `parseNativeBackendOptions({ model: "openai/x", hostPorts: { backgroundCommands: { adopt() {}, foreground() {} } } })` does not throw.
- [unit] `parseNativeBackendOptions({ model: "openai/x", hostPorts: { backgroundCommands: { adopt() {} } } })` throws an error whose message contains `backend.hostPorts.backgroundCommands`.
- [integration] Seam: a session opened with `nativeBackend({ model, hostPorts: { backgroundCommands: port } })` and profile `full` advertises a `Bash` tool whose input schema has `runInBackground`.
- [integration] A session opened with `nativeBackend({ model })` and profile `full`, without the port, advertises `Bash` without `runInBackground`.
- [integration] In a session opened with `nativeBackend({ model, hostPorts: { backgroundCommands: port } })`, a model `Bash` call with `runInBackground: true` reaches `port.adopt` once.
- [unit] `BackgroundCommandPort`, `BackgroundCommandHandle`, `BackgroundCommandSink`, `BackgroundCommandEnd` and `ForegroundCommand` are importable as types from `@nathapp/nax-agent`, and an object `{ adopt, foreground }` type-checks as `BackgroundCommandPort`.

### US-007 — the background task registry: adopt, log and state

- [unit] With `_backgroundTaskDeps.randomHex` returning `1a2b3c4d`, `adopt(handle)` returns sink id `bash-1a2b3c4d`.
- [unit] After `adopt` returned `bash-1a2b3c4d`, `get("bash-1a2b3c4d")` has `state` `running`.
- [unit] After `adopt` returned `bash-1a2b3c4d` with output dir `/o`, `get("bash-1a2b3c4d")` has `logPath` `/o/chat-tasks/bash-1a2b3c4d.log`.
- [unit] Chunks passed to a task sink's `append` are written to that task's log in order.
- [unit] `output("bash-1a2b3c4d")` for a task whose log holds 50 lines returns the last 40.
- [unit] When an adopted handle's `ended` resolves `exitCode` 0 and `timedOut` false, the task's `state` becomes `succeeded`.
- [unit] When an adopted handle's `ended` resolves `exitCode` 0, the task's `endedAt` is set.
- [unit] When an adopted handle's `ended` resolves `exitCode` 2, the task's `state` becomes `failed`.
- [unit] When an adopted handle's `ended` resolves `exitCode` 2, the task log's last line is `[nax] exit code 2`.
- [unit] When an adopted handle's `ended` resolves with `launchError` `"wrap failed"`, the task's `state` becomes `failed`.
- [unit] When an adopted handle's `ended` resolves with `launchError` `"wrap failed"`, the task's `note` is `"wrap failed"`.
- [unit] When an adopted handle's `ended` resolves `aborted: true`, the task's `state` becomes `stopped`.
- [unit] When `_backgroundTaskDeps.appendLog` rejects, the task still reaches `succeeded` when its `ended` resolves `exitCode` 0.
- [unit] When `_backgroundTaskDeps.appendLog` rejects on every call, the logger's `warn` is called exactly once.
- [unit] After `TASK_LOG_MAX_BYTES` of appended output, the log's next line is `[nax] log limit reached; further output dropped`.
- [unit] After the log limit line has been written, a later appended chunk is not written to the log.

### US-008 — the background task registry: notices, stop and foreground

- [unit] A task whose `ended` resolved `aborted: true` leaves `peekNotice()` returning `undefined`.
- [unit] After two tasks end, one `succeeded` and one `failed`, `peekNotice()` returns one text naming both task ids.
- [unit] After two tasks end, `takeNotice()` returns the same text `peekNotice()` returned.
- [unit] After `takeNotice()` with no further ended task, `peekNotice()` returns `undefined`.
- [unit] A task that ends between `peekNotice()` and `takeNotice()` stays pending, so the next `peekNotice()` names only that task.
- [unit] `stop("bash-1a2b3c4d")` on a running task calls that task handle's `stop()`.
- [unit] `stop` on a task in state `succeeded` throws a `NaxError` with code `CHAT_TASK_NOT_RUNNING`.
- [unit] `stopAll()` calls `stop()` on every running task handle.
- [unit] `stopAll()` resolves only after every running task's `ended` has settled.
- [unit] `adopt(handle)` called after `stopAll()` has begun calls that handle's `stop()` immediately.
- [unit] A handle adopted after `stopAll()` has begun ends as a task with `state` `stopped`.
- [unit] `moveForeground()` calls `moveToBackground()` on the most recently registered foreground call.
- [unit] `moveForeground()` with a foreground call registered returns `true`.
- [unit] `moveForeground()` with no foreground call registered returns `false`.
- [unit] `hasForeground()` is `true` while a foreground call is registered.
- [unit] `hasForeground()` is `false` after that registration's unregister function runs.
- [unit] An `onChange` listener fires when a handle is adopted.
- [unit] An `onChange` listener fires when a task ends.
- [unit] An `onChange` listener fires when a foreground call registers.
- [unit] An `onChange` listener fires when a foreground call unregisters.

### US-009 — `nax-tasks` tools, listing and prompt text

- [unit] The `nax-tasks` provider's `output` tool with `{ task: "../x" }` returns `{ isError: true, content: "[chat] invalid task id ../x" }`.
- [unit] The `nax-tasks` provider's `output` tool with `{ task: "bash-00000000" }` for an unknown id returns `{ isError: true, content: "[chat] unknown task bash-00000000" }`.
- [unit] The `nax-tasks` provider's `output` tool with `lines` 501 returns `{ isError: true, content: "[chat] lines must be an integer from 1 to 500" }`.
- [unit] The `nax-tasks` provider's `output` tool for a known task returns JSON whose `output` is the registry's `output(id, lines)` result.
- [unit] The `nax-tasks` provider's `stop` tool on a finished task returns `{ isError: true, content: "[chat] task bash-1a2b3c4d is not running" }`.
- [unit] The `nax-tasks` provider's `stop` tool on a running task returns `stopped task bash-1a2b3c4d`.
- [unit] The `nax-tasks` provider's `list` tool returns JSON whose `tasks[0]` has `id`, `command`, `state` and `startedAt`.
- [unit] The `nax-tasks` provider's `instructions()` resolves the text of `buildBackgroundTasksInstructions()`.
- [unit] `buildBackgroundTaskNotice` for one failed task `bash-1a2b3c4d` running `bun test` with exit code 1 and log `/o/chat-tasks/bash-1a2b3c4d.log` returns text whose first line is `[nax-tasks] background command bash-1a2b3c4d (bun test) ended: failed, exit code 1, log /o/chat-tasks/bash-1a2b3c4d.log`.
- [unit] `buildBackgroundTasksInstructions()` returns text naming `runInBackground`, `nax-tasks__output` and `nax-tasks__stop`.
- [unit] `formatTasksListing` for one running task `bash-1a2b3c4d` running `bun dev` returns `bash-1a2b3c4d running bun dev`.
- [unit] `createHostTasks(...)` returns a provider with id `nax-tasks` whose `stop` tool stops a task in the returned `tasks`.

### US-010 — wiring tasks into the chat host, notices and `/jobs`

- [integration] Seam: a chat host created with resources calls the `open` dependency on `start` with a request whose `backgroundCommands` is `host.tasks`.
- [integration] Seam: a chat host created with resources, on `resume({ id })`, calls `open` with `backgroundCommands` equal to `host.tasks`.
- [integration] Seam: a chat host created with resources, on `switchTo({ model: "p/other" })`, calls `open` with `backgroundCommands` equal to `host.tasks`.
- [integration] A chat host with a nax entry, resources and catalog agents opens with `toolProviders` ids ending in `["nax-jobs", "nax-tasks", "nax-agents"]`.
- [integration] A chat host created without resources has `tasks` undefined, and its open request has no `backgroundCommands`.
- [integration] Seam: `openChatSession` given a request with `backgroundCommands: port` calls its `nativeBackend` dependency with `hostPorts.backgroundCommands` equal to `port`.
- [integration] `openChatSession` given `backgroundCommands: port` and a configured command shadow calls `nativeBackend` with `hostPorts.commandShadow` still set.
- [unit] `host.close()` on a host with one running task calls that task handle's `stop()` after the session handle was closed.
- [integration] With the screen idle, `host.jobs` undefined and one ended task in `host.tasks`, the chat sends one turn whose text is the task notice, without any keypress after the task ended.
- [integration] With the screen idle and one ended task, the task notice is taken only after its turn started.
- [integration] With a turn running when a task ends, no task-notice turn is sent until that turn ends.
- [integration] With both a job notice and a task notice queued on an idle screen, the job notice's turn is sent first.
- [integration] After three task-notice turns in a row with no user-typed message, a fourth ended task's notice is not sent.
- [integration] After notices were held by the three-turn guard, a user-typed message whose turn then ends lets the held task notice be sent.
- [integration] `/jobs` with one running task `bash-1a2b3c4d` running `bun dev` shows a line `bash-1a2b3c4d running bun dev`.
- [integration] `/jobs` on a host with tasks but no `host.jobs` shows the task lines and not `jobs are not available in this session`.
- [unit] A configured MCP server with id `nax-tasks` is not attached and yields the diagnostic `[resources] mcp server id nax-tasks is reserved`.

### US-011 — ctrl+b and the footer hint

- [integration] Seam: with a turn running and `host.tasks.moveForeground` stubbed to return `true`, pressing ctrl+b calls `moveForeground` once.
- [integration] With a turn running and `host.tasks.moveForeground` stubbed to return `true`, pressing ctrl+b appends no notice.
- [integration] With `host.tasks.moveForeground` returning `false`, pressing ctrl+b appends the notice `no running command to move to the background`.
- [integration] With `host.tasks` undefined, pressing ctrl+b appends the notice `no running command to move to the background`.
- [unit] `footerHint` with `busy: true`, `backgroundable: true`, `tmux: false` and no armed quit or clear returns `"background"`.
- [unit] `footerHint` with `busy: true`, `backgroundable: true`, `tmux: true` and no armed quit or clear returns `"backgroundTmux"`.
- [unit] `footerHint` with `busy: true` and `backgroundable: false` returns `"busy"`.
- [unit] `footerHint` with `quitArmed: true` and `backgroundable: true` returns `"quit"`.
- [unit] The footer line built with hint `"background"` ends with `esc to interrupt · ctrl+b to background`.
- [unit] The footer line built with hint `"backgroundTmux"` ends with `esc to interrupt · ctrl+b ctrl+b to background`.
- [integration] With a turn running, `host.tasks.hasForeground()` true and `TMUX` unset, the footer shows `esc to interrupt · ctrl+b to background`.
- [integration] With a turn running, `host.tasks.hasForeground()` true and `TMUX` set, the footer shows `esc to interrupt · ctrl+b ctrl+b to background`.
- [integration] When `host.tasks` fires `onChange` after `hasForeground()` turns false, the footer shows `esc to interrupt` without a keypress.

### US-012 — the `host_choice` ask and its card

- [unit] `requestHostChoice` with choices `stop` and `stay` and `fallback` `"stay"` adds one pending ask of type `host_choice` carrying both choices.
- [unit] The pending `host_choice` ask carries `fallback` `"stay"`.
- [unit] The pending `host_choice` ask's `requestId` starts with `host-choice-`.
- [unit] `resolveChoice(requestId, "stop")` on a pending `host_choice` ask resolves its promise with `"stop"`.
- [unit] `resolveChoice(requestId, "stop")` removes the pending `host_choice` ask.
- [unit] `requestHostChoice` with `fallback` `"stay"` resolves `"stay"` when its timeout fires (driven by `_askControllerDeps` timers).
- [unit] `requestHostChoice` with `fallback` `"stay"` resolves `"stay"` when its `signal` aborts.
- [unit] `requestHostChoice` with `fallback` `"stay"` resolves `"stay"` when `reset()` runs.
- [unit] `askCardModel` for a `host_choice` ask with choices `stop` / `Quit and stop them` and `stay` / `Stay in chat` returns kind `choice` with options `[{ index: 1, label: "Quit and stop them", id: "stop" }, { index: 2, label: "Stay in chat", id: "stay" }]`.
- [integration] On a shown choice card with choices `stop` and `stay`, pressing `2` resolves `stay`.
- [integration] On a shown choice card with `fallback` `"stay"`, pressing escape resolves `stay`.
- [integration] On a shown choice card with choices `stop` and `stay`, pressing Return on the first option resolves `stop`.

### US-013 — the three-choice quit: `createCloseConfirm`

- [unit] `createCloseConfirm(...)()` with no owned jobs and no running tasks resolves `true`.
- [unit] `createCloseConfirm(...)()` with no owned jobs and no running tasks adds no pending ask.
- [unit] With one running task `bash-1a2b3c4d` and no owned jobs, the close card's choice ids are exactly `["stop", "stay"]`.
- [unit] With one running task `bash-1a2b3c4d` and no owned jobs, the close card's summary is `0 nax job(s) and 1 background command(s) still running: bash-1a2b3c4d`.
- [unit] With one owned job and one running task, the close card's choice ids are exactly `["stop", "leave", "stay"]`.
- [unit] Answering `stop` on the close card cancels every owned job.
- [unit] Answering `stop` on the close card awaits `tasks.stopAll()`.
- [unit] Answering `stop` on the close card stops an active chain with reason `the chat closed`.
- [unit] Answering `stop` on the close card resolves `true`.
- [unit] Answering `leave` on the close card awaits `tasks.stopAll()`.
- [unit] Answering `leave` on the close card stops an active chain with reason `the chat closed`.
- [unit] Answering `leave` on the close card cancels no job.
- [unit] Answering `leave` on the close card resolves `true`.
- [unit] Answering `stay` on the close card cancels no job.
- [unit] Answering `stay` on the close card does not call `tasks.stopAll()`.
- [unit] After answering `stay` on the close card, an active chain is still active.
- [unit] Answering `stay` on the close card resolves `false`.
- [unit] Answering `stop` when cancelling the first of two owned jobs rejects still cancels the second job.
- [unit] Answering `stop` when cancelling the first of two owned jobs rejects calls the logger's `warn` once.
- [integration] With `host.confirmBeforeClose` resolving `false`, ctrl-c on an idle screen leaves the app mounted and does not call `host.close()`.
- [integration] With `host.confirmBeforeClose` resolving `true`, ctrl-c on an idle screen calls `host.close()`.
