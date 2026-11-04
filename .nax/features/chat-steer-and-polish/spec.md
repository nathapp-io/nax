# SPEC: nax chat steering, message queue and polish

## Summary

Five `nax chat` improvements reported together. While a turn runs, return queues the
typed message and the queue drains one message per turn after the turn completes;
ctrl+s **steers** instead: on a native brain the message joins the running turn at its
next round boundary, and on an ACP brain (or when steering is refused) the running turn
is interrupted and the message is sent at once. `/compact` compacts the native
session's history on demand. `/model` lists the five most recently used models first,
each with the effort it was last used at. A completed turn leaves a muted line with its
decode speed. The terminal title names nax and the project, and carries a busy marker
while a turn runs.

## Motivation

Users of `nax chat` (2026-11-03 feedback batch, Ubuntu and macOS):

- Typing while a turn runs is wasted: `ChatInput.submit` drops a non-slash return while
  `busy` is true, so a thought has to be held until the turn ends, and there is no way
  to redirect a long turn short of cancelling it with escape and retyping.
- Compaction only happens automatically, near the context limit. There is no way to
  shed a long, finished exploration before starting the next task.
- `/model` lists the catalogue in catalogue order with each model at its configured
  effort. Switching back to the model and effort used an hour ago means finding it again
  and cycling the effort again, and two providers can offer the same model name
  (`openai/gpt-6.1-sol` and `openai-codex/gpt-6.1-sol`).
- There is no measure of how fast a model is decoding, which matters when choosing
  between providers of the same model.
- A chat in a background terminal tab gives no sign whether it is still working.

## Design

### Integration

Read-only symbols (verified on `main` at `12926a633`):

- `packages/nax-agent/src/session/session-backend.ts` — `OpenedBackend` has optional
  capabilities `acceptsImages?()`, `configure?(input)`, `runCommand?(request)`; the
  facade always exposes the matching `AgentSession` method and refuses with
  `AGENT_SESSION_CAPABILITY_UNSUPPORTED` when the backend lacks it. The ACP backend
  (`nax-agent-acp`) implements neither new capability and is not changed.
- `packages/nax-agent/src/session/agent-session.ts` — the facade. `send` sets
  `this.active` to the turn claim and clears it in the claim's `onSettle`; `runCommand`
  sets `this.active` to a command claim (`claimCommand`, `agent-session-command.ts`).
- `packages/nax-agent/src/session/agent-session-turn.ts` — the turn run: `sendTurn`
  passes `{ ...ctx.turnOpts(), turnId, signal, onTurnEvent, … }` to
  `adapter.sendTurn`; at the end `hooks.onSettle(turnId, status)` runs **before**
  `emit(end)` emits `turn_end`.
- `packages/nax-agent/src/native/session/turn-loop-round-trip.ts` —
  `runRoundTripLoop(state, params)`: each iteration first checks
  `params.deps.deadline?.expired()`, then `maybeCompact`, `runModelRoundTrip`,
  `dispatchToolBatch`. `runTurnEndPhase(state, params)` decides the `before_turn_end`
  continuation (appends `{ role: "user", content: followUp }`, resets
  `params.spinFlags.warned`, returns `{ action: "continue", state }`); `stopped` (spin
  breaker, invalid-call budget, deadline) closes that channel; `MAX_FOLLOW_UPS_PER_TURN`
  is 3.
- `packages/nax-agent/src/native/session/turn-compaction-step.ts` — `summarizeAndApply`
  (module-private) summarizes a `CompactionPlan`'s span and applies it;
  `runProactiveCompaction` wraps it with the `before_compaction` dispatch, a swallowed
  summarizer error and `TurnAccumulator` bookkeeping, none of which manual compaction uses.
- `packages/nax-agent/src/native/session/compaction.ts` — `prepareCompaction`,
  `applyCompaction`, `keepBudget`, `estimateContextTokens`, `COMPACTION_SUMMARY_PREFIX`.
- `packages/nax-agent/src/native/session-adapter.ts` — `NativeSessionAdapter.sendTurn`
  builds the `summarize` closure inline from the turn's client, resolved model, rates
  and signal; history is reloaded from the transcript store at every turn start.
- `packages/nax/src/chat/acp/acp-offer-store.ts` — `createAcpOfferStore`: versioned JSON
  beside the sessions directory, atomic write (temp + rename), load failure warns and
  returns empty. The recent-models store mirrors it.
- `packages/nax/src/cli/chat.ts` — `composeChat` creates and loads the ACP catalog
  (`deps.createAcpCatalog`, `acp.load()`) before `deps.createChatHost`; `startHost` calls
  `host.resume` for `--resume` and `host.start` otherwise.
- `packages/nax/src/chat/chat-ledger.ts` — `ChatLedger.record(event: ChatUsageEvent, previousAt, model?, role?)`.
- `packages/nax/src/tui/chat/ChatApp.tsx` — `submit`: a slash line while
  `sending.current` shows `TURN_BUSY_NOTICE` (`wait for the turn to finish (Ctrl-C to
  interrupt)`) except `/quit`; `sendTurn`'s `finally` awaits `keys.finishTurn()` (which
  applies a queued model or mode switch).
- `packages/nax/src/tui/chat/slash-commands.ts` — `COMMANDS`, `isBuiltin`, `acpDispatch`
  (forwards only non-built-ins on an ACP brain).
- `packages/nax/src/tui/chat/theme.ts` — `ChatGlyphs`, unicode and ASCII sets.
- `packages/nax/src/tui/chat/index.ts` — `renderChat`: writes `ENTER_ALT_SCREEN`, renders,
  then `ENABLE_MOUSE` on a TTY; `restore` writes `DISABLE_MOUSE` (TTY) and `LEAVE_ALT_SCREEN`.

Mutated symbols. The baseline exists only to locate the code; it is never the
interface to implement.

- `AgentSession` (`packages/nax-agent/src/session/agent-session-types.ts`)
  - Target: adds `steer?(text: string): SteerResult` and `compact?(): Promise<CompactResult>`;
    the facade always provides both.
- `OpenedBackend` (`packages/nax-agent/src/session/session-backend.ts`)
  - Target: adds `readonly steerable?: true` and
    `compact?(request: { signal: AbortSignal }): Promise<CompactResult>`.
- `SendTurnOpts` (`packages/nax-agent/src/session/session-types.ts`)
  - Target: adds optional `steers?: SteerChannel`, where
    `interface SteerChannel { take(): readonly string[] }`. It already reaches the native
    loop as `params.opts.steers` (the adapter passes its `SendTurnOpts` through to
    `runNativeTurn`); the ACP adapter ignores it.
- `TurnRunContext` / the turn claim hooks (`agent-session-turn.ts`) and the facade's
  `active` claim (`agent-session.ts`)
  - Target: the facade's active claim carries a kind (`"turn" | "command" | "compact"`)
    so `steer` can tell a turn from a command; the turn run adds the facade's
    `SteerChannel` to the options it passes `adapter.sendTurn` when `opened.steerable`.
- `runTurnEndPhase` (`turn-loop-round-trip.ts`)
  - Baseline: breaks early when `followUpsSoFar >= MAX_FOLLOW_UPS_PER_TURN`, before any
    continuation is considered.
  - Target: the cap gates only the `followUp`; pending steers still continue the turn
    when the cap is reached.
- `NativeSessionAdapter` (`packages/nax-agent/src/native/session-adapter.ts`)
  - Target: the `summarize` closure is built by an extracted factory used by both
    `sendTurn` and a new `compactHistory(handle, { signal }): Promise<CompactResult>`.
- `summarizeAndApply` (`turn-compaction-step.ts`) — Target: exported, unchanged behaviour.
- `ChatHost`, `ChatHostDeps`, `ChatHostState`, `ChatSendOptions` — Target: move from
  `chat-host.ts` into a new `chat/chat-host-types.ts` that `chat-host.ts` re-exports
  (US-004), freeing `chat-host.ts` (597 lines, 600-line cap) for the wiring below.
- `ChatHost` — Target: adds optional
  `steer?(text: string): SteerResult`, `compact?(): Promise<CompactResult>`,
  `recentModels?(): readonly string[]` (optional so hand-built test hosts typecheck).
- `ChatHostDeps` — Target: adds optional `recents?: { readonly store: RecentModelStore; readonly initial: readonly string[] }`.
- `ChatCommandDeps` (`_chatCommandDeps`, `cli/chat.ts`) — Target: adds
  `createRecentModelStore(input: { path: string; logger }): RecentModelStore`.
- `ChatInput` (`ChatInput.tsx`)
  - Baseline: `submit` returns early on `busy && !text.startsWith(SLASH)`.
  - Target: a new optional prop `onQueue?(text: string): boolean`; a busy non-slash
    return calls it, and clears the draft only when it returns `true`. Without the prop
    the baseline behaviour stands.
- `ChatAppProps` (`ChatApp.tsx`) — Target: adds optional `onBusyChange?(busy: boolean): void`.
- `PickerModelInput` (`picker-model.ts`) — Target: adds optional `recents?: readonly string[]`.
- `TranscriptEntry` (`transcript-model.ts`) — Target: adds
  `{ kind: "turn-stats"; text: string }`, laid out as one muted row.
- `ChatGlyphs` (`theme.ts`) — Target: adds `busy: string` — `"✳"` unicode, `"*"` ASCII.
- `isSubagentEvent` (`chat-status.ts`) — Target: exported, unchanged behaviour.

New types, exported from `@nathapp/nax-agent` `.`:

```ts
export type SteerResult =
  | { readonly status: "accepted"; readonly steerId: string; readonly applied: Promise<boolean> }
  | { readonly status: "unsupported" }
  | { readonly status: "no_turn" };

export interface CompactResult {
  readonly compacted: boolean;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly usage: TokenUsage;
  readonly costUsd: number;
}
```

New nax modules and their signatures:

```ts
// packages/nax/src/tui/chat/message-queue.ts — immutable
export type MessageQueue = readonly string[];
export function pushQueued(queue: MessageQueue, text: string): MessageQueue;
export function pushQueuedFront(queue: MessageQueue, text: string): MessageQueue;
export function takeQueued(queue: MessageQueue): { readonly text: string; readonly rest: MessageQueue } | undefined;
export function queueToPrompt(queue: MessageQueue, draft: string): string;
export const MAX_QUEUED_ROWS = 3;

// packages/nax/src/tui/chat/turn-stats.ts
export function decodeRate(events: readonly SessionEvent[]): number | undefined;
export function turnStatsText(input: { rate: number | undefined; outputTokens: number; elapsedMs: number }): string;

// packages/nax/src/tui/chat/terminal-title.ts
export const PUSH_TITLE: string; // "\u001b[22;0t"
export const POP_TITLE: string;  // "\u001b[23;0t"
export function setTitleSequence(text: string): string; // "\u001b]0;" + text + "\u0007"
export function chatTitle(project: string, busy: boolean, glyphs: ChatGlyphs): string;

// packages/nax/src/chat/recent-models.ts
export const RECENT_MODELS_FILE = "chat-recent-models.json";
export const MAX_RECENT_MODELS = 5;
export function recordRecentModel(recents: readonly string[], model: string): readonly string[];
export interface RecentModelStore { load(): Promise<readonly string[]>; save(models: readonly string[]): Promise<void>; }
export function createRecentModelStore(input: { path: string; logger?: Pick<Logger, "warn"> }): RecentModelStore;
```

### Steering (native)

The **facade** owns each session's pending steers, in arrival order:

- `steer(text)` throws `AGENT_SESSION_CLOSED` on a closed session and
  `AGENT_SESSION_INVALID_OPTIONS` for empty or whitespace-only text. It returns
  `{ status: "unsupported" }` when the backend is not `steerable`, `{ status: "no_turn" }`
  when no **turn** claim is active (a running `runCommand` or `compact` is not a turn),
  and otherwise appends the text and returns `{ status: "accepted", steerId, applied }`.
- For a steerable backend, each turn's `sendTurn` options carry a `SteerChannel` whose
  `take()` removes every pending steer, resolves each one's `applied` with `true`, and
  returns their texts in order.
- When the turn claim settles (`onSettle`, which runs before `turn_end` is emitted), the
  channel closes: every steer still pending resolves `applied` with `false` and is
  discarded. A claim voided before the turn started settles the same way. Pending
  steers never carry into the next `send()`.

The native turn loop calls `take()` at two points:

1. **Round boundary.** At the top of every `runRoundTripLoop` iteration after the first,
   **after** the deadline check and only when the turn signal is not aborted, before
   `maybeCompact`: the taken texts are appended to `state.messages` as
   `{ role: "user", content: text }`, in order, after the previous round's tool results.
   Two consecutive user messages (tool results, then the steer) is intentional: the
   compaction path already produces that order, and nax-ai passes it to the provider
   unchanged.
2. **Turn end.** In `runTurnEndPhase`, when the turn is not `stopped` and the signal is
   not aborted: if `take()` returns texts, they are appended as user messages, followed
   by a `before_turn_end` `followUp` when the handler returned one within its cap, and
   the turn continues exactly as a honoured `followUp` does (including
   `spinFlags.warned = false`). Steers do not count against `MAX_FOLLOW_UPS_PER_TURN`.

Injected steers are ordinary transcript user messages, so they persist and replay. No
new `SessionEvent` type is introduced, so the ACP server's event translator is untouched.

### Manual compaction (native)

`NativeSessionAdapter.compactHistory(handle, { signal })` loads the stored history,
estimates `tokensBefore` with `estimateContextTokens(messages, undefined, undefined)`,
plans with `prepareCompaction(messages, keepBudget(window, compaction))`, and when a
plan exists calls the exported `summarizeAndApply` with the summarizer from the shared
factory, saves the compacted transcript (same owner and model identity as a turn save),
and clears the session's stored `lastUsage` anchor so the next turn re-estimates from
the compacted array. The summarizer factory takes everything the turn's closure uses —
the client for the session's model, its pricing rate card, the resolved context window
(`resolveContextWindow`) and the session's compaction settings
(`state.compaction.get(id)`, falling back to `DEFAULT_COMPACTION`) — so `sendTurn` and
`compactHistory` resolve them the same way. It ignores `compaction.enabled`, which governs automatic compaction
only. When `prepareCompaction` returns `undefined` it returns `compacted: false`,
`tokensAfter === tokensBefore`, zero usage and zero cost, without calling the
summarizer. A summarizer error propagates and the stored history is unchanged. It does
not dispatch `before_compaction`.

The facade's `compact()` refuses, in order: `AGENT_SESSION_CLOSED`, `AGENT_SESSION_BUSY`
(a turn, command, configure or compact in flight), `AGENT_SESSION_CAPABILITY_UNSUPPORTED`
(backend has no `compact`). It holds the session's single slot while it runs (so `send`
refuses `AGENT_SESSION_BUSY`) under the session's `turnTimeoutSeconds` deadline, and the
signal it passes aborts on that deadline or on `close()`.

### Message queue (TUI)

- Return while a turn runs, on a draft that is not a slash line, appends the text to
  the queue and clears the prompt. A slash line is never queued: it keeps today's
  behaviour (the `TURN_BUSY_NOTICE` notice, `/quit` excepted).
- Above the input, the queue draws at most `MAX_QUEUED_ROWS` muted rows
  `queued · <text>` (one line each), plus `+N more` when longer; these rows count
  against the bottom region's row budget like the working line does.
- When a turn's send settles and the turn ended `completed`, after `keys.finishTurn()`
  has run, the first queued message is submitted through the same path as a typed
  return (so `@` mentions expand and it gets its own `user` row, title and history
  entry). One message per turn, in order.
- When a turn ends any other way (`cancelled`, `errored`, `timed_out`, or the send
  rejects) and **no interrupt-send is pending**, nothing is sent: the queued texts move
  back into the prompt via `queueToPrompt`, and the queue empties.
- A draft holding an image placeholder is not queued: the notice
  `images cannot be queued; send it after the turn ends` is shown and the draft stays.
- Queued messages die with the process.
- While `/compact` runs, the screen is busy exactly as during a turn (`sending` and
  `busy` held, working line `compacting…`), so return queues; when the compaction
  settles the queue drains as after a completed turn.

### Steer key (TUI)

`ChatApp`'s own `useInput` owns ctrl+s and reads `ChatApp`'s own `draft.editor.text`.
A `host.steer` that throws appends an error row with the message and keeps the draft.
With a non-empty, non-slash draft:

| State | Effect |
|:--|:--|
| no turn running | same as return: sends the draft |
| turn running, `host.steer(text)` returns `accepted` | prompt clears; a muted `steering · <text>` row shows above the queue rows; `applied` `true` → the row goes and a transcript `user` row with the text is appended; `applied` `false` → the row goes and the text goes to the **front** of the queue |
| turn running, `unsupported`, `no_turn`, or `host.steer` absent | interrupt-send: the text becomes the pending interrupt-send, the prompt clears, and the turn is cancelled as escape does; when the send settles, the pending text is sent first and the queue stays queued, draining after it |

An empty or slash draft makes ctrl+s do nothing. A draft holding an image is refused with
the queue's notice. `/help` appends the line `ctrl+s  steer the running turn (or interrupt
and send)` after the built-in lines, on native and ACP brains alike.

`ChatHost.steer` returns `{ status: "no_turn" }` when no session is open, and otherwise
the session's `steer` result.

### `/compact` (TUI)

- Built-in: inserted in `COMMANDS` directly after `agents` and before `jobs`, with the
  `COMMAND_DESCRIPTIONS` entry `compact the conversation history`. While a turn runs it gets the generic
  `TURN_BUSY_NOTICE` like every built-in.
- Native brain: shows the notice `compacting…`, calls `host.compact()`, then shows
  `compacted: <before> → <after> tokens` (counts via `formatTokens`) or
  `nothing to compact`. The footer's context reading becomes `tokensAfter`.
- A host without `compact`: the notice `compaction is not available in this session`.
- ACP brain: `acpDispatch` forwards `compact` to the agent as typed (`/compact<rest>`),
  as it does non-built-ins.
- `ChatHost.compact` records the spend when `costUsd > 0` or any token count is
  non-zero: one ledger row through `ChatLedger.record` with a synthesized usage event
  (`type: "usage"`, the session's `sessionId`, a fresh `turnId`, `round: 0`, `at` = now,
  empty `metadata`, `inputTokens` / `outputTokens` / `cacheRead` / `cacheWrite` from
  `usage`, `costUsd`; `previousAt` = the time `compact()` was called), and the session
  metadata's `costUsd` increased by `costUsd`, written to storage and reflected in the
  host's current handle. `compacted: false` with zero spend writes nothing.
- A rejection shows the error in the transcript; the session stays usable.

### Recent models (`/model`)

- Store: `chat-recent-models.json` in the chat sessions directory,
  `{ "version": 1, "models": [...] }`, newest first, at most `MAX_RECENT_MODELS`, unique
  by base (`parseModelSpec(model).model`, i.e. `provider/model`). Recording a model
  whose base is listed replaces that entry with the new effort and moves it to the front.
- `composeChat` creates the store next to the ACP catalog, loads it once before
  `createChatHost`, and passes `{ store, initial }` as `ChatHostDeps.recents`. The
  `@/chat` barrel exports `createRecentModelStore` and `RecentModelStore`.
- `useChatPicker` passes `recents: host.recentModels?.()` to `pickerModel`.
- The host records (and saves) on a successful `start`, `resume`, and every `switchTo`
  that changes the model or its effort. A failed switch records nothing. A save failure
  warns once per failure and never fails the switch.
- The model picker lists recent rows first, newest first, then the remaining catalogue
  rows in catalogue order without the bases already shown. A recent row's effort is its
  stored effort and its detail reads `recent · effort <level>`; the session's own base is
  marked `current` wherever it appears, and `modelNote` applies to recent rows as to
  catalogue rows. A recent whose base is not in the host's models is not shown.
- Load failure (unreadable or wrong version): warn, empty list.

### Decode speed (TUI)

`decodeRate` folds one turn's chat-session events (events whose `metadata.subagentTask`
is set are ignored, via `isSubagentEvent`): per `round`, the window runs from that
round's first `text_delta` or `thinking_delta` to its `usage` event; a `stream_reset`
for the round restarts its window. Rate = (sum of `outputTokens` over rounds with a
window longer than zero) ÷ (sum of those windows in seconds), rounded to one decimal.
When a turn ends `completed` with `outputTokens > 0`, a `turn-stats` transcript row
follows the reply: `48.2 tok/s · 1.3k out · 14s` (output is `turn_end.usage.outputTokens`
via `formatTokens`; elapsed is the floor of the whole seconds from `turn_start` to `turn_end`). With no measurable window the `tok/s`
part is left out (`1.3k out · 14s`). Cancelled and errored turns, replayed history and
`runCommand` lines leave no row.

### Terminal title

Only on a TTY (the same `isTTY` check `renderChat` applies before enabling mouse
reporting). `<project>` is the base name of `props.cwd ?? props.host.repoRoot`, with
control characters removed. Glyphs are `props.theme?.glyphs`, falling back to
`resolveChatTheme({ env: {}, colorLevel: 0 }).glyphs`. `renderChat` writes, in order: `ENTER_ALT_SCREEN`, render,
`ENABLE_MOUSE`, `PUSH_TITLE`, `setTitleSequence(chatTitle(project, false, glyphs))`. It
passes `ChatApp` an `onBusyChange` that writes
`setTitleSequence(chatTitle(project, busy, glyphs))`; `ChatApp` calls it whenever
`turnRunning` changes. `restore` writes `DISABLE_MOUSE`, `LEAVE_ALT_SCREEN`, then
`POP_TITLE` — the last only when `PUSH_TITLE` was written (a render that throws first
pops nothing).

### Failure Handling

| Case | Behaviour |
|:--|:--|
| `steer` on a closed session | throws `AGENT_SESSION_CLOSED` |
| `steer` with empty text | throws `AGENT_SESSION_INVALID_OPTIONS` |
| steer pending when a turn is cancelled, errors, times out or is stopped | discarded; `applied` resolves `false`; the TUI re-queues it at the front |
| `compact` while a turn, command or configure runs | throws `AGENT_SESSION_BUSY` |
| `compact` on a backend without it | throws `AGENT_SESSION_CAPABILITY_UNSUPPORTED` |
| `compact` with nothing to drop | `compacted: false`, summarizer not called |
| summarizer throws during `compact` | rejects with the error; stored history unchanged |
| `/compact` rejects in the TUI | error row in the transcript; chat stays usable |
| recent-models file unreadable or wrong version | warn, empty list |
| recent-models save fails | warn, switch result unchanged |

## Out of Scope

- Manual compaction does not dispatch the `before_compaction` loop event; plugin handlers see only proactive and overflow compactions.
- `/compact` takes no argument; focus instructions for the summary are not supported.
- Steering on ACP brains: the ACP protocol has no mid-turn user input, so ctrl+s interrupts and sends instead.
- Queued messages are not persisted across a restart or a session switch, and cannot be edited or reordered in place.
- A message carrying an image cannot be queued or steered.
- No decode-speed row for replayed history or for a subagent's turns.
- The terminal title does not show a separate marker for a pending approval or question.
- No new `SessionEvent` type; the ACP server event translator is not changed.

## Stories

**US-001: Native steering in nax-agent.** No dependencies. Workdir: `packages/nax-agent`.
The facade's pending-steer list and `steer()`, the `SteerChannel` on `SendTurnOpts`, the
native backend's `steerable` flag, and the two injection points in the native turn loop.

**US-002: Native manual compaction in nax-agent.** No dependencies. Workdir: `packages/nax-agent`.
The extracted summarizer factory, `NativeSessionAdapter.compactHistory`, the backend's
`compact`, and the facade's `compact()`.

**US-003: Message queue in the chat TUI.** No dependencies. Workdir: `packages/nax`.
The queue model, `ChatInput.onQueue`, queue rows, and draining after completed turns.

**US-004: ctrl+s steers or interrupts.** Depends on US-001, US-003. Workdir: `packages/nax`.
`ChatHost.steer`, the ctrl+s binding, the steering row and the interrupt-send fallback.

**US-005: `/compact`.** Depends on US-002, US-004. Workdir: `packages/nax`.
`ChatHost.compact` (ledger row and metadata spend) and the built-in slash command.

**US-006: Recently used models in `/model`.** No dependencies. Workdir: `packages/nax`.
The recent-models store, its composition and recording in the host, and recent rows in the model picker.

**US-007: Decode speed after a turn.** No dependencies. Workdir: `packages/nax`.
`decodeRate`, `turnStatsText` and the `turn-stats` transcript row.

**US-008: Terminal title with a busy marker.** No dependencies. Workdir: `packages/nax`.
Title push, set, busy updates and pop.

### Context Files

**US-001**
- `packages/nax-agent/src/session/agent-session.ts` — the facade; `this.active`, claims, `onSettle`.
- `packages/nax-agent/src/session/agent-session-turn.ts` — `sendTurn` options and the settle-before-`turn_end` order.
- `packages/nax-agent/src/session/session-backend.ts` — `OpenedBackend` optional capabilities.
- `packages/nax-agent/src/native/session/turn-loop-round-trip.ts` — `runRoundTripLoop`, `runTurnEndPhase`.
- `packages/nax-agent/src/session/session-types.ts` — `SendTurnOpts`.

**US-002**
- `packages/nax-agent/src/native/session/turn-compaction-step.ts` — `summarizeAndApply`, `runProactiveCompaction`.
- `packages/nax-agent/src/native/session/compaction.ts` — the compaction core and `COMPACTION_SUMMARY_PREFIX`.
- `packages/nax-agent/src/native/session-adapter.ts` — the inline `summarize` closure to extract.
- `packages/nax-agent/src/session/agent-session.ts` — the facade, its claims and `claimCommand` use (`agent-session-command.ts`) to mirror.
- `packages/nax-agent/src/session/native-backend.ts` — the native `OpenedBackend`.

**US-003**
- `packages/nax/src/tui/chat/ChatApp.tsx` — `submit`, `sendTurn`, the busy state and row budgets.
- `packages/nax/src/tui/chat/ChatInput.tsx` — `submit` and its busy guard.
- `packages/nax/src/tui/chat/useChatKeys.ts` — `interrupt`, `finishTurn`.
- `packages/nax/test/ui/chat/chat-app.test.tsx` — `fakeHost` and the send assertions to mirror.

**US-004**
- `packages/nax/src/chat/chat-host.ts` — `send`, `cancel`, `runCommand` delegation.
- `packages/nax/src/tui/chat/ChatApp.tsx` — `useInput`, the queue wiring US-003 added.
- `packages/nax/src/tui/chat/message-queue.ts` — created by US-003, the queue.
- `packages/nax/src/tui/chat/slash-commands.ts` — `formatHelp`.

**US-005**
- `packages/nax/src/chat/chat-ledger.ts` — `ChatLedger.record`, `ChatUsageEvent`.
- `packages/nax/src/chat/turn-runner.ts` — the metadata write a turn performs.
- `packages/nax/src/tui/chat/slash-commands.ts` — `COMMANDS`, `acpDispatch`, `runSlashCommand`.
- `packages/nax/src/tui/chat/chat-status.ts` — `formatTokens`, `TurnStatus.contextTokens`.
- `packages/nax/src/chat/host-steer-compact.ts` — created by US-004, where `compact` joins `steer`.

**US-006**
- `packages/nax/src/chat/acp/acp-offer-store.ts` — the store to mirror.
- `packages/nax/src/chat/chat-host.ts` — `start`, `resume`, `switchSession`.
- `packages/nax/src/tui/chat/picker-model.ts` — `modelEntries`, `pickerModel`.
- `packages/nax/src/cli/chat.ts` — `composeChat`, `_chatCommandDeps`.
- `packages/nax/src/tui/chat/useChatPicker.ts` — the `pickerModel` call site.

**US-007**
- `packages/nax/src/tui/chat/chat-status.ts` — `reduceTurnStatus`, `formatTokens`, `isSubagentEvent`.
- `packages/nax/src/tui/chat/transcript-model.ts` — `TranscriptEntry`, `reduceTranscript`.
- `packages/nax/src/tui/chat/layout.ts` — the per-kind line layout.
- `packages/nax/src/tui/chat/ChatApp.tsx` — `handleEvent`.

**US-008**
- `packages/nax/src/tui/chat/index.ts` — `renderChat`, `restore`, `_renderChatDeps`.
- `packages/nax/src/tui/chat/theme.ts` — `ChatGlyphs`.
- `packages/nax/src/tui/chat/ChatApp.tsx` — `turnRunning`.
- `packages/nax/test/ui/chat/index.test.tsx` — the write-sequence assertions to mirror.

### Creates

**US-001**
- `packages/nax-agent/src/session/steer-channel.ts` — the facade's pending-steer list, `SteerChannel` and settle-time discard.

**US-002**
- `packages/nax-agent/src/native/session/manual-compaction.ts` — `compactHistory`'s body.
- `packages/nax-agent/src/native/session/session-summarizer.ts` — the extracted summarizer factory.

**US-003**
- `packages/nax/src/tui/chat/message-queue.ts` — the queue model.

**US-004**
- `packages/nax/src/chat/chat-host-types.ts` — `ChatHost`, `ChatHostDeps`, `ChatHostState`, `ChatSendOptions` moved out of `chat-host.ts`, re-exported from it.
- `packages/nax/src/chat/host-steer-compact.ts` — the host's `steer` (and, from US-005, `compact`), kept out of `chat-host.ts`, which sits at the 600-line source cap.

**US-006**
- `packages/nax/src/chat/recent-models.ts` — the store and `recordRecentModel`.
- `packages/nax/src/chat/host-recents.ts` — the host's recording and `recentModels`, kept out of `chat-host.ts`.

**US-007**
- `packages/nax/src/tui/chat/turn-stats.ts` — `decodeRate` and `turnStatsText`.

**US-008**
- `packages/nax/src/tui/chat/terminal-title.ts` — the title sequences and `chatTitle`.

### Modifies

**US-001**
- `packages/nax-agent/api/nax-agent.api.txt` — the public type list gains `SteerResult` and `SteerChannel`; regenerate with `bun run api:update` so `check:api` matches.

**US-002**
- `packages/nax-agent/api/nax-agent.api.txt` — the public type list gains `CompactResult`; regenerate with `bun run api:update` so `check:api` matches.

**US-003**
- `packages/nax/test/ui/chat/chat-app.test.tsx` — "AC-4 keeps draft and ignores Enter during a turn" pins the old busy drop; rewrite it so a busy non-slash return clears the prompt, draws `queued · draft`, and still does not call `send` during the turn.
- `packages/nax/test/ui/chat/chat-input.test.tsx` — an assertion that a busy non-slash return keeps the draft now holds only when no `onQueue` prop is given; with `onQueue` returning `true` the draft clears and `onQueue` receives the text.

**US-004**
- `packages/nax/test/unit/tui/chat/slash-commands-acp.test.ts` — its "AC-7" help test asserts the exact help text on an ACP brain; the expected value gains the trailing ctrl+s line after the built-in lines.

**US-005**
- `packages/nax/test/ui/chat/slash-menu.test.tsx` — "AC-10 seventeen matches draw eight rows" pins the overflow row `… 10 more`; with `compact` added to `COMMANDS` it becomes `… 11 more`.

**US-006**
- `packages/nax/test/unit/cli/chat.test.ts` — the fixture spreads `_chatCommandDeps`; add a stub `createRecentModelStore` so the chat command tests never touch the real global sessions directory.

**US-008**
- `packages/nax/test/ui/chat/index.test.tsx` — assertions on the exact sequence `renderChat` writes on mount and restore gain `PUSH_TITLE` and the title after `ENABLE_MOUSE`, and `POP_TITLE` after `LEAVE_ALT_SCREEN`, on a TTY only.

### Seams

- US-001 → US-004: `AgentSession.steer` is called by `ChatHost.steer`, reached from ctrl+s in the chat screen.
- US-002 → US-005: `AgentSession.compact` is called by `ChatHost.compact`, reached from the `/compact` slash line.
- US-003 → US-004: a steer whose `applied` resolves `false` goes to the front of the US-003 queue.
- US-006: `createRecentModelStore` is called by `composeChat` and its list reaches the `/model` picker.

## Acceptance Criteria

### US-001

1. [unit] On a session over a steerable stub backend with a turn in flight, `session.steer("also check b.ts")` returns `{ status: "accepted" }` with a non-empty `steerId`.
2. [unit] On a session over a steerable stub backend with no turn in flight, `session.steer("x")` returns `{ status: "no_turn" }`.
3. [unit] On a session over a steerable stub backend, while a `runCommand` is in flight and no turn is, `session.steer("x")` returns `{ status: "no_turn" }`.
4. [unit] On a session whose backend is not `steerable`, `session.steer("x")` during a turn returns `{ status: "unsupported" }`.
5. [unit] `session.steer("   ")` throws an `AgentSessionError` with code `AGENT_SESSION_INVALID_OPTIONS`.
6. [unit] `session.steer("x")` after `close()` throws an `AgentSessionError` with code `AGENT_SESSION_CLOSED`.
7. [unit] The `steers` channel a steerable backend receives in `sendTurn` options returns `["a", "b"]` from `take()` for steers `a` then `b`, and both `applied` promises resolve `true`.
8. [unit] A steer still pending when the turn's adapter `sendTurn` settles resolves `applied` `false` before the `turn_end` event reaches the `send()` iterator, and a second `take()` from that turn's channel returns `[]`.
9. [unit] A steer accepted while the turn claim exists but before the adapter's `sendTurn` is invoked, on a turn that is then cancelled, resolves `applied` `false` exactly once.
10. [integration] With a scripted model that answers round 1 with one tool call and round 2 with text, a steer accepted while round 1's tool runs makes round 2's request messages end with the tool result followed by `{ role: "user", content: <steered text> }`.
11. [integration] Two steers accepted during the same tool batch appear in round 2's request as two user messages in the order they were steered.
12. [integration] With a scripted model that answers round 1 with text only, a steer accepted during round 1 makes the turn send a second request whose messages end with `{ role: "user", content: <steered text> }`, and `turn_end` reports `completed`.
13. [integration] When a `before_turn_end` handler returns a `followUp` and a steer is pending at turn end, the continuation request ends with the steer's user message followed by the followUp's user message.
14. [integration] A turn continued by a steer at turn end still honours a `before_turn_end` handler's `followUp` `MAX_FOLLOW_UPS_PER_TURN` times: steering does not use that count.
15. [integration] A steer accepted during a turn whose deadline expires before the next round is not appended to the transcript and resolves `applied` `false`.
16. [integration] A steer accepted during a turn that is then cancelled is not sent to the model and resolves `applied` `false`.
17. [integration] A steer accepted during a turn the spin breaker stops resolves `applied` `false` and starts no further round.
18. [integration] A steer whose `applied` resolved `false` in one turn is absent from the next `send()`'s request messages.
19. [integration] After a turn that applied a steer, the stored transcript holds the steered text as a user message between the tool result and the next assistant message, and a resumed session's next request includes it.

### US-002

1. [integration] On a native session whose stored history is above the keep budget, `session.compact()` resolves `{ compacted: true }` with `tokensAfter` less than `tokensBefore`.
2. [integration] After a successful `compact()`, the next `send()` request's messages begin with the compaction summary message, whose content starts with `COMPACTION_SUMMARY_PREFIX`.
3. [integration] `compact()` returns the summarizer response's `usage` and `costUsd` unchanged in its result.
4. [integration] On a native session whose history fits the keep budget, `compact()` resolves `{ compacted: false, costUsd: 0 }` with `tokensAfter` equal to `tokensBefore`, and the summarizer stub records no call.
5. [integration] On a native session configured with `compaction.enabled: false` and history above the keep budget, `compact()` resolves `{ compacted: true }`.
6. [unit] `compact()` while a turn is in flight throws an `AgentSessionError` with code `AGENT_SESSION_BUSY`.
7. [unit] `send()` called while a `compact()` is pending throws an `AgentSessionError` with code `AGENT_SESSION_BUSY`.
8. [unit] `compact()` on a session whose backend has no `compact` throws an `AgentSessionError` with code `AGENT_SESSION_CAPABILITY_UNSUPPORTED`.
9. [unit] `compact()` after `close()` throws an `AgentSessionError` with code `AGENT_SESSION_CLOSED`.
10. [unit] The signal the backend's `compact` receives aborts when the session's `turnTimeoutSeconds` deadline elapses.
11. [integration] When the summarizer stub throws, `compact()` rejects with that error and the next `send()` request carries the uncompacted history.
12. [integration] `compact()` does not dispatch the `before_compaction` loop event: a registered handler records no call.
13. [integration] A `send()` after a successful `compact()` triggers no proactive compaction from a stale usage anchor: with history now below the threshold, the summarizer stub records no call during that turn.
14. [integration] `sendTurn`'s automatic compaction still produces the same summary request as before the summarizer extraction: a proactive compaction's summarizer call receives the dropped span and previous summary.

### US-003

1. [unit] `takeQueued(pushQueued(pushQueued([], "a"), "b"))` returns `{ text: "a", rest: ["b"] }`, and `takeQueued([])` returns `undefined`.
2. [unit] `takeQueued(pushQueuedFront(["a"], "z"))` returns `{ text: "z", rest: ["a"] }`.
3. [unit] `queueToPrompt(["a", "b"], "c")` returns `"a\nb\nc"`, and `queueToPrompt(["a", "b"], "")` returns `"a\nb"`.
4. [integration] In the chat screen with a turn running, typing `next please` and pressing return clears the prompt and draws a row reading `queued · next please` above the input.
5. [integration] With a turn running, a typed `/help` line shows `wait for the turn to finish (Ctrl-C to interrupt)` and draws no `queued ·` row.
6. [integration] With `first` and `second` queued, when the running turn ends `completed` the host's `send` receives `first`; when that turn ends `completed` it receives `second`.
7. [integration] A queued message sent after a turn appends its own `user` transcript row with the queued text.
8. [integration] A queued message containing `@a.ts` is sent expanded exactly as a typed message with `@a.ts` would be.
9. [integration] With no pending interrupt-send, `first` and `second` queued and `draft` in the prompt, when the running turn ends `cancelled` the host's `send` is not called again and the prompt holds `first\nsecond\ndraft`.
10. [integration] When the running turn ends `errored` with `first` queued, `send` is not called again and the prompt holds `first`.
11. [integration] With five messages queued, the screen draws three `queued ·` rows and a `+2 more` row.
12. [integration] A queued model switch (ctrl+t during the turn) is applied before the first queued message is sent: the host's `switchTo` call precedes the next `send` call.
13. [integration] With a turn running and an image placeholder in the draft, return shows the notice `images cannot be queued; send it after the turn ends`, queues nothing and keeps the draft.
14. [integration] `ChatInput` given `busy` and an `onQueue` returning `true` calls `onQueue` with the text on a non-slash return and clears its draft; with `onQueue` returning `false` the draft stays.

### US-004

1. [unit] `ChatHost.steer("x")` on an open native session returns the session's `steer` result unchanged.
2. [unit] `ChatHost.steer("x")` when no session is open returns `{ status: "no_turn" }`.
3. [integration] With `ChatApp` mounted over `createChatHost` whose opened session is a stub, during a running turn ctrl+s on `x` calls the stub session's `steer` once with `x`.
4. [integration] With a turn running and a host whose `steer` returns `accepted`, typing `look at b.ts` and pressing ctrl+s clears the prompt and draws a `steering · look at b.ts` row.
5. [integration] When that steer's `applied` resolves `true`, the `steering ·` row is gone and a `user` transcript row reading `look at b.ts` is appended.
6. [integration] When that steer's `applied` resolves `false`, the `steering ·` row is gone and the text is first in the queue, ahead of a message queued earlier.
7. [integration] With a turn running and a host whose `steer` returns `unsupported`, ctrl+s on `retry with x` clears the prompt and calls the host's `cancel` once.
8. [integration] With `q1` queued, a host whose `steer` returns `unsupported`, and ctrl+s on `retry`, after the turn ends `cancelled` the host's `send` receives `retry` and then, after that turn completes, `q1`.
9. [integration] With a turn running and a host without a `steer` method, ctrl+s cancels the turn and sends the draft next, as for `unsupported`.
10. [integration] With no turn running, ctrl+s on `hello` sends `hello` as a turn, as return does.
11. [integration] ctrl+s on an empty prompt or a `/help` line calls neither `steer`, `cancel` nor `send`.
12. [integration] With a turn running and an image placeholder in the draft, ctrl+s shows `images cannot be queued; send it after the turn ends` and calls neither `steer` nor `cancel`.
13. [integration] `/help` on a native brain and on an ACP brain ends with the `ctrl+s` line, after the built-in lines.
14. [integration] With a turn running and a host whose `steer` throws `closed`, ctrl+s appends an error row containing `closed` and keeps the draft.

### US-005

1. [unit] `ChatHost.compact()` on an open native session returns the session's `compact()` result.
2. [unit] After `ChatHost.compact()` resolves with `costUsd: 0.02`, the session metadata written to storage and `current()` both carry a `costUsd` larger by `0.02`.
3. [unit] `ChatHost.compact()` records one ledger row whose output tokens equal the result's `usage.outputTokens` and whose cost equals `costUsd`.
4. [unit] A `compacted: false` result with zero usage and cost writes no ledger row and no metadata.
5. [integration] With `ChatApp` mounted over `createChatHost` whose opened session is a stub, submitting `/compact` calls the stub session's `compact` once.
6. [integration] On a native brain with no turn running, `/compact` shows `compacting…` then `compacted: 84.2k → 12.1k tokens` for a result with `tokensBefore` 84200 and `tokensAfter` 12100.
7. [integration] A result with `compacted: false` shows `nothing to compact`.
8. [integration] After a successful `/compact`, the footer's context reading shows the result's `tokensAfter`.
9. [integration] With a turn running, `/compact` shows `wait for the turn to finish (Ctrl-C to interrupt)` and does not call `compact`.
10. [integration] On an ACP brain, `/compact` is sent to the host's `send` as the message `/compact` and the host's `compact` is not called.
11. [integration] On a host without `compact`, `/compact` shows `compaction is not available in this session`.
12. [integration] When the host's `compact` rejects with `boom`, an error row containing `boom` is appended and a following message still sends.
13. [integration] `/help` lists `/compact` between `/agents` and `/jobs`.
14. [integration] While a `/compact` is pending, typing `after` and pressing return draws `queued · after`, and when the compaction resolves the host's `send` receives `after`.

### US-006

1. [unit] `recordRecentModel([], "openai/gpt-6[high]")` returns `["openai/gpt-6[high]"]`.
2. [unit] `recordRecentModel(["a/x[low]", "b/y"], "a/x[high]")` returns `["a/x[high]", "b/y"]`.
3. [unit] `recordRecentModel(["openai/gpt-6.1-sol"], "openai-codex/gpt-6.1-sol")` returns two entries, because the bases differ by provider.
4. [unit] Recording a sixth distinct base onto five entries keeps `MAX_RECENT_MODELS` entries and drops the oldest.
5. [unit] `createRecentModelStore` round-trips: `save(["a/x[high]"])` then `load()` returns `["a/x[high]"]`, and the file holds `version: 1`.
6. [unit] `load()` on a missing file returns `[]` without a warning; on a file with `version: 2` it returns `[]` with one warning.
7. [unit] A `save` whose write throws leaves no `.tmp` file beside the store path.
8. [unit] A host built with `recents.initial` `["b/y"]` returns `["b/y"]` from `recentModels()` before any switch.
9. [unit] After `ChatHost.switchTo({ model: "a/x[high]" })` succeeds, `recentModels()` starts with `a/x[high]` and the store's `save` received that list.
10. [unit] A `switchTo` that rejects leaves `recentModels()` unchanged and calls no `save`.
11. [unit] After `ChatHost.start({ mode: "guarded", model: "a/x" })`, `recentModels()` starts with `a/x`.
12. [unit] After `ChatHost.resume({ id })` opens a session on `c/z[low]`, `recentModels()` starts with `c/z[low]`.
13. [unit] When the store's `save` rejects, `switchTo` still resolves and the host logs one warning.
14. [unit] `pickerModel` for kind `model` with `recents` `["b/y[high]"]` and models `["a/x", "b/y", "c/z"]` returns rows whose values are `["b/y", "a/x", "c/z"]`.
15. [unit] That `b/y` row has `effortLabel` `high`, `original` `b/y[high]` and `detail` `recent · effort high`.
16. [unit] A recent whose base is not in the models list produces no row, and a recent row whose base is the current model is marked `current`.
17. [integration] Choosing the `b/y` recent row in the `/model` picker calls the host's `switchTo` with `{ model: "b/y[high]" }`.
18. [integration] `composeChat` calls `createRecentModelStore` with the path `chat-recent-models.json` under `resolveChatSessionsDir`'s directory, calls its `load` once before `createChatHost`, and passes the loaded list as `recents.initial`.

### US-007

1. [unit] `decodeRate` over a round whose first `text_delta` is at `t` and whose `usage` reports 100 output tokens at `t + 2s` returns `50`.
2. [unit] `decodeRate` over two rounds of 100 tokens in 2s and 300 tokens in 4s returns `66.7`.
3. [unit] `decodeRate` ignores events whose `metadata.subagentTask` is set.
4. [unit] `decodeRate` starts a round's window at its first `thinking_delta` when thinking precedes text.
5. [unit] A `stream_reset` for a round restarts that round's window at the next delta.
6. [unit] `decodeRate` returns `undefined` when no round has both a delta and a usage event.
7. [unit] `turnStatsText({ rate: 48.2, outputTokens: 1300, elapsedMs: 14_400 })` returns `48.2 tok/s · 1.3k out · 14s`.
8. [unit] `turnStatsText({ rate: undefined, outputTokens: 1300, elapsedMs: 14_400 })` returns `1.3k out · 14s`.
9. [integration] After a turn ends `completed` with output tokens, one muted `turn-stats` row with the stats text follows the reply.
10. [integration] A turn that ends `cancelled` or `errored` adds no stats row.
11. [integration] A turn that ends `completed` with zero output tokens adds no stats row.
12. [integration] A resumed session's replayed history shows no stats rows.

### US-008

1. [unit] `chatTitle("my-repo", false, glyphs)` returns `nax · my-repo`, and `chatTitle("my-repo", true, glyphs)` returns `✳ nax · my-repo` with the unicode glyphs.
2. [unit] `chatTitle("my-repo", true, asciiGlyphs)` returns `* nax · my-repo`.
3. [unit] `chatTitle("a\u0007b", false, glyphs)` returns `nax · ab`.
4. [unit] `setTitleSequence("x")` returns `"\u001b]0;x\u0007"`, `PUSH_TITLE` is `"\u001b[22;0t"` and `POP_TITLE` is `"\u001b[23;0t"`.
5. [integration] On a TTY, `renderChat` writes `PUSH_TITLE` then `setTitleSequence("nax · <project>")` after `ENABLE_MOUSE`.
6. [integration] On a TTY, unmounting writes `POP_TITLE` after `LEAVE_ALT_SCREEN`.
7. [integration] When the terminal is not a TTY, `renderChat` writes no title sequence.
8. [integration] While a turn runs, `ChatApp` has called `onBusyChange(true)`, and after the turn ends its last call is `onBusyChange(false)`.
9. [integration] The `onBusyChange` that `renderChat` passes writes `setTitleSequence(chatTitle(<project>, busy, glyphs))` on a TTY.
10. [integration] With `cwd` absent from the props, `<project>` is the base name of `host.repoRoot`.
11. [unit] Both glyph sets of `ChatGlyphs` define `busy`: `✳` in the unicode set and `*` in the ASCII set.
