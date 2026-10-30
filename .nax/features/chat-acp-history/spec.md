# SPEC: chat-acp-history — one conversation across native and ACP brains in `nax chat`

## Summary

Since F2 (`chat-acp-brain`, #2740) `nax chat` can run on Claude Code, Codex or Cursor over ACP, but each
brain keeps its own transcript: a switch from a native model to an agent, from an agent back to a native
model, or from one agent to another starts the new brain without the turns the old one took, and the TUI
says so (`<new> does not see <old>'s turns`). This feature makes the chat one conversation again. Every
ACP turn that shows agent work is recorded in nax's native chat transcript, and an ACP agent that opens (fresh, or resumed on
its own session) is handed the turns it has not seen, bounded in size, in front of its first prompt.

It is feature F3 of the design `docs/superpowers/specs/2026-10-29-nax-chat-acp-agents-design.md` (§5.6).
F1 (`acp-tools-codex-cursor`, #2739) and F2 (`chat-acp-brain`, #2740) are merged.

## Motivation

- User ruling 2026-10-29 (design §6.4): history carries over on a switch, in every direction (native to
  ACP, ACP to native, ACP to another ACP agent), the same experience as switching native models today.
  Anti-goal (design §4): history that disappears on a brain switch.
- F2 left this open on purpose: a stored session document refuses to reopen on another backend
  (`checkBackendKind`, `AGENT_SESSION_BACKEND_MISMATCH`), so each brain keeps its own document — the
  native one in `<sessions dir>`, each agent's in `<sessions dir>/acp-<agent>/`. The ACP backend stores
  only its ACP record and cost baseline there, never the messages (`packages/nax-agent-acp/src/client/backend.ts`
  `saveBaseline` / `saveFinal`), so nobody owns an ACP brain's message history yet.
- Resuming a chat session that ran on an agent replays only the native document (`ChatSessionHandle.history`),
  so an agent's earlier turns are missing from the resumed TUI transcript. Recording them in the native
  document fixes that too.

## Design

### Approach

1. **Record every ACP turn in the native document.** `openChatSession` wraps an ACP brain's session
   (`recordAcpTurns`). After each turn that reaches `turn_end` having shown agent work (a non-empty
   `text_delta`, a non-empty `thinking_delta` or a `tool_call`), the wrapper appends two messages to the
   native chat transcript document (the store at `request.storage.dir`, the one the native brain resumes
   from): the person's message as typed, and one assistant message holding the agent's reply text
   (`turn_end.output`, or the concatenated `text_delta` texts when it is empty), a
   one-line `[tool] <name>` summary per tool call, and `origin: { provider: "acp:<agent>", model: <model or "default"> }`.
   `origin` is nax-ai's existing "who wrote this message" field (`ConversationMessage` in
   `packages/nax-ai/src/protocols/types.ts`): pi-ai treats a message from another provider as another
   model's, and the recorded message has no thinking to drop. Tool calls are summaries, not structured
   `toolCalls` / `tool-result` messages, because the native model has no such tools to pair them with.
2. **The native brain needs no change.** The native backend already carries history across models
   (`carryHistoryAcrossModels: true`, `transcript-identity.ts` keeps another model's document), and a
   document with no `backend` field reads as native (`checkBackendKind`). A session started on an agent
   gets a native document created by the recorder (`{ savedAt, messages }`), so a later switch to a
   native model resumes it rather than creating a new session.
3. **Hand an opening agent the turns it has not seen.** When the ACP branch opens an agent:
   - a fresh agent session (no agent document, or the F2 fallback after an unusable one) has seen none of
     the native document;
   - a resumed agent session has seen everything up to and including the last assistant message whose
     `origin.provider` is `acp:<that agent>`; it has not seen what follows. With no such message (a
     session from before this feature), it has seen none.
   The unseen messages become handoff entries (`acpHandoff`), rendered by the new prompt builder
   `buildChatHandoff`, and the wrapper puts that text in front of the first message it sends:
   `<handoff>\n\n<message>`. ACP sends the session's system instructions only on the first prompt of a
   new session (`instructionsSent` in `backend.ts`), so a fresh agent receives instructions, then the
   handoff, then the message; a resumed one receives the handoff and the message. The handoff is
   cleared once a send reaches `turn_end` having shown agent work. This is a deliberately narrower
   evidence set than the one the ACP backend uses to mark its instructions delivered (#2364: `receipt()`
   in `events.ts` also fires on usage, plan and tool-update updates and on settle); a turn the backend
   counts as delivered but that showed no text, thinking or tool call keeps the handoff pending and is
   not recorded (accepted, Out of Scope). A turn with no agent work
   (an auth or quota failure before the agent saw the prompt) is not recorded either, so the agent's
   last-seen point never moves past turns it was not given.
4. **Bounded handoff.** One entry per user message and per assistant message (tool-result messages are
   dropped; an assistant message with neither text nor tool calls is dropped; `thinking` is ignored).
   Lengths are JavaScript string lengths (UTF-16 code units). An entry's text longer than
   `ACP_HANDOFF_ENTRY_MAX_CHARS` (4,000) is cut to its first 4,000 units followed by `…`. The entries kept
   are the longest contiguous newest suffix whose `speaker.length + text.length` (text after the cut)
   sum to at most `ACP_HANDOFF_MAX_CHARS` (40,000); the count of earlier entries dropped is reported.
   When any were dropped, the handle's `notice` says so.
5. **The brain-change notice goes.** `useSwitchNotices` no longer adds `<new> does not see <old>'s turns`;
   a model change shows only `model: <name>`, as for a native model change.

The new ACP-branch logic (unseen messages, handoff, wrapping, notice) goes in a small helper in
`open-chat-session.ts` rather than inline in `openChatSession`, which `check:complexity` already scores
at 11 of 20.

`packages/nax/src/chat/chat-host.ts` is at 593 of 600 lines and is not changed: all wiring sits in
`open-chat-session.ts` (342 lines) and five new modules under `src/chat/acp/`.

### Handoff text

```text
<conversation-so-far>
These turns happened in this nax chat before this message, while you were not the model answering. Use them as context. Tool calls are listed by name only.
[2 older messages omitted]

User: plan the cache layer

nax (gpt-6): Here is a plan ...
[tool] Read

Codex: I changed the store ...
</conversation-so-far>
```

The bracketed omitted line appears only when entries were dropped. Speakers: `User`; `nax` for an
assistant message with no `origin`; `nax (<origin.model>)` for an `origin` whose provider does not start
with `acp:`; the agent label (`Claude Code`, `Codex`, `Cursor`) for `acp:<agent>`; the raw provider for an
`acp:` provider naming another agent.

### Integration (extends existing code)

Read only (verified at main `c12fc11bd`):

- `packages/nax-agent/src/session/agent-session-types.ts` — `AgentSession { runCommand?; id; backend; lastTurn (getter); send(message): AsyncIterable<SessionEvent>; answer; cancel; close }`; `send` claims the session's turn slot synchronously. `SessionEvent` bodies used here: `text_delta { round; text }`, `stream_reset { round; attempt }`, `tool_call { callId; name; input }`, `tool_result { callId; isError; preview }`, `turn_end { status: TurnEndStatus; output; ... }`; `TurnEndStatus = "completed" | "cancelled" | "timed_out" | "interrupted" | "errored"`. `turn_end` is always the last event.
- `packages/nax-agent/src/native/session/transcript-types.ts` — `TranscriptDoc { schemaVersion?; backend?; acp?; owner?; model?; savedAt; messages; turn?; instructionSources?; instructionDirectories? }`, `TranscriptStore { load(id): Promise<TranscriptDoc | null>; save(id, doc) }`. nax reaches the message type as `TranscriptDoc["messages"][number]` (nax may not import nax-ai outside `src/agents/catalog/`).
- `packages/nax-ai/src/protocols/types.ts` — assistant `ConversationMessage` has optional `origin: { provider; model }`.
- `packages/nax-agent-acp/src/client/events.ts` — ACP agent text arrives as `text_delta` round 0, already scrubbed of the session's secret values.
- `packages/nax/src/chat/acp/acp-model.ts` — `ChatAcpModel { agent; model?; effort? }`, `AcpChatAgent`, `ACP_CHAT_AGENTS`, `acpAgentLabel(agent)`.
- `packages/nax/src/chat/acp/acp-session-options.ts` — `ACP_FRESH_SESSION_NOTICE(label)`.
- `packages/nax/src/tui/chat/session-transcript.ts` — `sessionTranscript(host)` replays `host.history()`, which is `ChatSessionHandle.history` (the native document's messages at open).

Changed (the **Baseline** lines only locate the code; implement the **Target**):

- `packages/nax/src/chat/open-chat-session.ts`
  - Baseline: `openAcpBrain(request, { meta, acp }, deps): Promise<OpenedBrain>` with `OpenedBrain { session; notice? }`; the ACP branch of `openChatSession` returns `{ ...opened, meta, release, history }` where `history = historyOf(await transcripts.load(meta.sessionId))`.
  - Target: `openAcpBrain` also reports whether the agent session is fresh (created, with or without the fallback). The ACP branch computes `unseenMessages(history.messages, acp.agent, fresh)`, then `acpHandoff(...)`, renders it with `buildChatHandoff`, and returns `session: recordAcpTurns(opened.session, { store: transcripts, sessionId: meta.sessionId, acp, handoff })`. Its `notice` is the fallback notice and `ACP_HANDOFF_TRIMMED_NOTICE(label, omitted)` (when `omitted > 0`), joined by `"; "` when both exist, undefined when neither does. When neither exists the handle has no `notice` key at all (the existing `open-chat-session-acp.test.ts` asserts `"notice" in handle` is false). The `ChatSessionHandle.notice` doc comment is updated to cover the trimmed-handoff case. The native branch is unchanged and its session is not wrapped.
- `packages/nax/src/tui/chat/use-switch-notices.ts`
  - Baseline: `modelNotices(from, to)` adds `` `${modelName(to)} does not see ${modelName(from)}'s turns` `` when `brainOf(from) !== brainOf(to)`.
  - Target: `modelNotices(to)` takes only the new model and returns only `model: <name>` (the call site passes only `model`); `brainOf` and the then-unused `parseChatAcpModel` import are removed (build gate).
- `packages/nax/src/prompts/builders/chat-builder.ts` and `src/prompts/index.ts`
  - Target: new export `buildChatHandoff(input: ChatHandoffInput): string` with `ChatHandoffInput { entries: readonly { speaker: string; text: string }[]; omitted: number }`, re-exported from `@/prompts` beside `buildChatAcpInstructions`.

### New modules: `packages/nax/src/chat/acp/`

```ts
// acp-history.ts (US-001)
export type ChatMessage = TranscriptDoc["messages"][number];
export const ACP_TOOL_SUMMARY_LIMIT = 20;
export const ACP_TOOL_NAME_MAX_CHARS = 80;
/** `{ provider: "acp:<agent>", model: acp.model ?? "default" }`; the effort is not part of it. */
export function acpOrigin(acp: ChatAcpModel): { readonly provider: string; readonly model: string };
/** The ACP chat agent that wrote an assistant message, from `origin.provider`; undefined otherwise. */
export function acpAgentOfMessage(message: ChatMessage): AcpChatAgent | undefined;
/** The user message and the assistant message that record one ACP turn. */
export function acpTurnMessages(input: {
  readonly message: string;
  readonly events: readonly SessionEvent[];
  readonly acp: ChatAcpModel;
}): readonly [ChatMessage, ChatMessage];

// acp-handoff-entries.ts (US-002)
export const ACP_HANDOFF_ENTRY_MAX_CHARS = 4_000;
export interface HandoffEntry { readonly speaker: string; readonly text: string }
/** The messages an opening agent has not seen (see Approach 3). */
export function unseenMessages(
  messages: readonly ChatMessage[],
  agent: AcpChatAgent,
  fresh: boolean,
): readonly ChatMessage[];
/** One entry per user / assistant message (Approach 4), each text cut to the entry cap; no total bound. */
export function handoffEntries(messages: readonly ChatMessage[]): readonly HandoffEntry[];

// acp-handoff.ts (US-003)
export const ACP_HANDOFF_MAX_CHARS = 40_000;
export interface AcpHandoff { readonly entries: readonly HandoffEntry[]; readonly omitted: number }
/** handoffEntries(messages), bounded to the newest contiguous suffix within ACP_HANDOFF_MAX_CHARS. */
export function acpHandoff(messages: readonly ChatMessage[]): AcpHandoff;
export function ACP_HANDOFF_TRIMMED_NOTICE(label: string, omitted: number): string;
//   `${label} was not given the ${omitted} oldest earlier message(s); the handoff is capped`

// acp-transcript-append.ts (US-004)
/**
 * Append messages to the native chat document: load, then save
 * `{ ...doc, savedAt, messages: [...doc.messages, ...messages] }`, or `{ savedAt, messages }` when
 * there is no document. Never throws: a load or save rejection is logged with
 * getLogger().warn("chat", "could not record the ACP turn", { sessionId, error: errorMessage(error) }).
 */
export function appendNativeTurn(
  store: TranscriptStore,
  sessionId: string,
  messages: readonly ChatMessage[],
  now?: () => Date,
): Promise<void>;

// acp-recorder.ts (US-005 forwarding and handoff, US-006 recording)
export interface RecordAcpTurnsInput {
  /** The native chat transcript store (the one at the sessions dir), not the agent's. */
  readonly store: TranscriptStore;
  readonly sessionId: string;
  readonly acp: ChatAcpModel;
  /** Rendered handoff, put in front of the first message sent; empty or absent means none. */
  readonly handoff?: string;
}
/** Test seam. */
export const _acpRecorderDeps: { appendNativeTurn: typeof appendNativeTurn };
export function recordAcpTurns(session: AgentSession, input: RecordAcpTurnsInput): AgentSession;
```

`acpTurnMessages` builds the assistant `content` as: the reply text — the `turn_end` event's `output`
when it is non-empty, else the `text_delta` texts concatenated in order (a `stream_reset` discards the
text collected so far) — then one line per `tool_call` in call order, `[tool] <name>`, or
`[tool] <name> (error)` when the `tool_result` with the same `callId` has `isError: true`, with the name
cut to `ACP_TOOL_NAME_MAX_CHARS` code points. At most `ACP_TOOL_SUMMARY_LIMIT` lines are written, then
`[tool] … and <n> more`. Text and the first line are separated by one newline (no leading newline when
there is no text). With neither text nor tool calls the content is `(no reply; turn <status>)` from the
`turn_end` event. `thinking_delta` text and tool inputs and previews are never recorded. The assistant
message has `origin` and no `toolCalls` or `thinking`.

`handoffEntries` maps a user message to speaker `User`; an assistant message to the speaker of
"Handoff text" above, with text = its `content`, then one `[tool] <name>` line per `toolCalls` entry
(one newline between, no leading newline when `content` is empty).

`recordAcpTurns` returns an `AgentSession` that reads `id`, `backend` and `lastTurn` from the wrapped
session when they are read (getters, so a stub without them still wraps), forwards `answer`, `cancel`,
`close` and (when present) `runCommand`, and implements `send(message)` by calling the wrapped
session's `send` synchronously with `handoff + "\n\n" + message` while a handoff is pending (else
`message`), forwarding every event unchanged and in order. When the wrapped iteration ends with a
`turn_end` and showed agent work, it clears the handoff and awaits
`_acpRecorderDeps.appendNativeTurn(store, sessionId, acpTurnMessages({ message, events, acp }))` before its own iteration
completes, so `runChatTurn` (which consumes the whole iteration before writing session metadata) sees
the turn recorded.

### Failure Handling

| Situation | Behaviour |
|:---|:---|
| The native store's `load` or `save` rejects while recording a turn | `appendNativeTurn` resolves; `getLogger().warn("chat", "could not record the ACP turn", { sessionId, error })`; the send completes normally with every event delivered; the turn is missing from the native document. |
| The wrapped `send` throws, or its iteration ends without `turn_end` | The error (if any) propagates; nothing is recorded; a pending handoff stays pending for the next send. |
| A turn reaches `turn_end` with no agent work (no non-empty `text_delta`, no non-empty `thinking_delta`, no `tool_call`) | Not recorded; a pending handoff stays pending. |
| A turn with agent work ends `cancelled`, `timed_out`, `interrupted` or `errored` | It is recorded like a completed turn (the reply so far, or `(no reply; turn <status>)` for thinking only). |
| The unseen messages exceed `ACP_HANDOFF_MAX_CHARS` | The oldest entries are dropped; the handle's `notice` carries `ACP_HANDOFF_TRIMMED_NOTICE`. |
| One message's text exceeds `ACP_HANDOFF_ENTRY_MAX_CHARS` | It is cut to that many units followed by `…`. |
| An entry's text contains `</conversation-so-far>` | Written as `<\/conversation-so-far>` so it cannot close the block. |
| No unseen messages | No handoff; the first message is sent as typed. |

## Out of Scope

- Recording an ACP turn's tool calls as structured native `toolCalls` / `tool-result` messages, or carrying tool inputs, results or thinking; a turn's tools are recorded as one `[tool] <name>` line each.
- Writing ACP turns into the agent's own transcript document under `acp-<agent>/`; that document keeps only the ACP record and cost baseline.
- Recording a turn that throws or ends without `turn_end`.
- Retrying, or showing in the TUI, a failed recording; it is logged as a warning only.
- Native compaction that summarises away every message an agent wrote: that agent's next reopen is then handed the whole native history again, including turns it already saw.
- An agent session opened before this feature has no recorded turns of its own, so its first reopen is handed the whole native history, possibly repeating what it saw.
- Handing history to an agent through its own history import (`session/load` replay or an agent-specific API); the handoff is text in front of the first prompt.
- Making the handoff bounds configurable; they are constants.
- Recording, or clearing the handoff for, a turn the ACP backend counts as delivered (usage or plan updates only) but that showed no text, thinking or tool call; such a turn keeps the handoff pending and is not recorded.
- A dedicated speaker for a native compaction summary (a user message starting with `COMPACTION_SUMMARY_PREFIX`); it is handed over as a `User:` entry.
- Keeping UTF-16 surrogate pairs whole when an entry is cut at 4,000 units.
- Showing the handoff text in the TUI transcript.
- Changing `chat-host.ts`, the native backend, nax-agent or nax-agent-acp.
- Workflow tools on the `nax-agent` ACP server that koda connects to; a separate later feature.
- Updating `.nax/mono/packages/nax/context.md`, which is read-only to the run; a manual follow-up after merge.

## Stories

Seven stories, one capability (one `nax chat` conversation across brains), all in `packages/nax`.

### US-001 — record an ACP turn as native messages

Workdir: packages/nax. No dependencies.

New `src/chat/acp/acp-history.ts`: `ChatMessage`, `ACP_TOOL_SUMMARY_LIMIT`, `ACP_TOOL_NAME_MAX_CHARS`,
`acpOrigin`, `acpAgentOfMessage` and `acpTurnMessages`. Pure functions.

### US-002 — the unseen messages and their handoff entries

Workdir: packages/nax. Depends on US-001.

New `src/chat/acp/acp-handoff-entries.ts`: `unseenMessages`, `handoffEntries`, `HandoffEntry` and
`ACP_HANDOFF_ENTRY_MAX_CHARS`. Pure functions.

### US-003 — the bounded handoff and its prompt

Workdir: packages/nax. Depends on US-002.

New `src/chat/acp/acp-handoff.ts` (`acpHandoff`, `AcpHandoff`, `ACP_HANDOFF_MAX_CHARS`,
`ACP_HANDOFF_TRIMMED_NOTICE`) and `buildChatHandoff` / `ChatHandoffInput` in the chat prompt builder,
exported from `@/prompts`.

### US-004 — append a turn to the native chat document

Workdir: packages/nax. Depends on US-001.

New `src/chat/acp/acp-transcript-append.ts`: `appendNativeTurn`, which never throws and logs a failed
load or save.

### US-005 — the session wrapper and its handoff

Workdir: packages/nax. No dependencies.

New `src/chat/acp/acp-recorder.ts` with `recordAcpTurns`: it wraps an `AgentSession`, forwards every
member, puts the pending handoff in front of the first send, and clears it after a turn that ended with
agent work. Recording is US-006.

### US-006 — the wrapper records each worked turn

Workdir: packages/nax. Depends on US-004, US-005.

`recordAcpTurns` (in `acp-recorder.ts`, created by US-005) appends each turn that ended with agent work
to the native document through the test seam `_acpRecorderDeps = { appendNativeTurn }`, and keeps the
handoff pending after a turn without agent work.

### US-007 — `openChatSession` carries history into and out of an ACP brain

Workdir: packages/nax. Depends on US-003, US-006.

The ACP branch of `openChatSession` computes the unseen messages, renders the handoff, wraps the
session with `recordAcpTurns` and reports a trimmed handoff in the handle's `notice`;
`useSwitchNotices` drops the `does not see` notice. The `src/chat/acp/index.ts` barrel exports the new
modules' public names. Verification note: `bun run typecheck` and `bun run check:all` stay green with
`brainOf` and its import removed.

### Context Files

**US-001**
- `packages/nax/src/chat/acp/acp-model.ts`
- `packages/nax-agent/src/session/agent-session-types.ts`
- `packages/nax-agent/src/native/session/transcript-types.ts`
- `packages/nax-ai/src/protocols/types.ts`

**US-002**
- `packages/nax/src/chat/acp/acp-model.ts`
- `packages/nax/src/chat/acp/acp-history.ts` — created by US-001, read here

**US-003**
- `packages/nax/src/prompts/builders/chat-builder.ts`
- `packages/nax/src/prompts/index.ts`
- `packages/nax/src/chat/acp/acp-handoff-entries.ts` — created by US-002, read here

**US-004**
- `packages/nax-agent/src/native/session/transcript-types.ts`
- `packages/nax/src/chat/session-hygiene.ts`
- `packages/nax/src/chat/acp/acp-history.ts` — created by US-001, read here

**US-005**
- `packages/nax-agent/src/session/agent-session-types.ts`
- `packages/nax-agent/src/session/agent-session.ts`

**US-006**
- `packages/nax/src/chat/turn-runner.ts`
- `packages/nax/src/chat/acp/acp-history.ts` — created by US-001, read here
- `packages/nax/src/chat/acp/acp-transcript-append.ts` — created by US-004, read here
- `packages/nax/src/chat/acp/acp-recorder.ts` — created by US-005, extended here

**US-007**
- `packages/nax/src/chat/open-chat-session.ts`
- `packages/nax/test/unit/chat/open-chat-session-acp.test.ts`
- `packages/nax/src/tui/chat/use-switch-notices.ts`
- `packages/nax/src/chat/acp/acp-handoff.ts` — created by US-003, integrated here
- `packages/nax/src/chat/acp/acp-recorder.ts` — created by US-005 and US-006, integrated here

### Creates

**US-001**
- `packages/nax/src/chat/acp/acp-history.ts`
- `packages/nax/test/unit/chat/acp/acp-history.test.ts`

**US-002**
- `packages/nax/src/chat/acp/acp-handoff-entries.ts`
- `packages/nax/test/unit/chat/acp/acp-handoff-entries.test.ts`

**US-003**
- `packages/nax/src/chat/acp/acp-handoff.ts`
- `packages/nax/test/unit/chat/acp/acp-handoff.test.ts`
- `packages/nax/test/unit/prompts/chat-handoff.test.ts`

**US-004**
- `packages/nax/src/chat/acp/acp-transcript-append.ts`
- `packages/nax/test/unit/chat/acp/acp-transcript-append.test.ts`

**US-005**
- `packages/nax/src/chat/acp/acp-recorder.ts`
- `packages/nax/test/unit/chat/acp/acp-recorder.test.ts`

**US-006**
- `packages/nax/test/unit/chat/acp/acp-recorder-record.test.ts`

**US-007**
- `packages/nax/test/unit/chat/open-chat-session-acp-history.test.ts`
- `packages/nax/test/unit/chat/chat-host-acp-history.test.ts`

### Modifies

**US-003**
- `packages/nax/src/prompts/builders/chat-builder.ts` — adds `ChatHandoffInput` and `buildChatHandoff`; existing builders unchanged.
- `packages/nax/src/prompts/index.ts` — re-exports `buildChatHandoff` and `ChatHandoffInput` beside `buildChatAcpInstructions`.

**US-007**
- `packages/nax/src/chat/open-chat-session.ts` — the ACP branch wraps the agent session with `recordAcpTurns`, hands it the unseen messages and combines the fallback and trimmed notices, leaving the `notice` key absent when there is neither; the `ChatSessionHandle.notice` doc comment is updated to name the trimmed-handoff case; the native branch is unchanged.
- `packages/nax/src/chat/acp/index.ts` — re-exports the public names of the five new modules of this feature (history, handoff entries, handoff, transcript append, recorder) beside the existing exports.
- `packages/nax/src/tui/chat/use-switch-notices.ts` — `modelNotices(to)` takes only the new model and returns only the `model: <name>` notice; `brainOf` and the then-unused `parseChatAcpModel` import are deleted.
- `packages/nax/test/ui/chat/acp-labels.test.tsx` — the `US-011 useSwitchNotices brain changes` cases `AC-10 native to ACP`, `AC-13 ACP to native` and `AC-14 one agent to another` expect a second `<new> does not see <old>'s turns` notice; replace each expectation with the single `model: <name>` notice (`["model: Codex"]`, `["model: gpt-6[high]"]`, `["model: Claude Code"]`), because a brain change now carries the conversation.

### Seams

- US-007 consumes `recordAcpTurns` (US-005, US-006), `acpHandoff` (US-003), `buildChatHandoff` (US-003) and `unseenMessages` (US-002). Entry point: `openChatSession` on an `acp:` model, which `ChatHost.start`, `switchTo` and `resume` reach through the host's opener. US-007 AC-1, AC-4 and AC-7 drive `openChatSession` and then the returned `handle.session.send`, and assert on what the stubbed agent session received and what the native store holds; AC-17 enters one level higher, through `createChatHost(...).send`.
- US-006 consumes `appendNativeTurn` (US-004) and `acpTurnMessages` (US-001); US-006 AC-4 stubs `_acpRecorderDeps.appendNativeTurn` and asserts its arguments.
- US-003 consumes `handoffEntries` (US-002); US-003 AC-2 compares its kept entries with `handoffEntries(messages)`.

## Acceptance Criteria

### US-001

1. [unit] `acpOrigin({ agent: "codex", model: "gpt-5.5" })` returns `{ provider: "acp:codex", model: "gpt-5.5" }`.
2. [unit] `acpOrigin({ agent: "claude" })` returns `{ provider: "acp:claude", model: "default" }`.
3. [unit] `acpOrigin({ agent: "codex", model: "gpt-5.5", effort: "high" })` returns `{ provider: "acp:codex", model: "gpt-5.5" }`.
4. [unit] `acpAgentOfMessage` of an assistant message with `origin: { provider: "acp:cursor", model: "default" }` returns `"cursor"`.
5. [unit] `acpAgentOfMessage` of a user message returns `undefined`.
6. [unit] `acpAgentOfMessage` of an assistant message with no `origin` returns `undefined`.
7. [unit] `acpAgentOfMessage` of an assistant message with `origin.provider` `"openai"` returns `undefined`.
8. [unit] `acpAgentOfMessage` of an assistant message with `origin.provider` `"acp:gemini"` returns `undefined`.
9. [unit] `acpTurnMessages({ message: "hi", events, acp })` returns an array of length 2 whose first element is `{ role: "user", content: "hi" }`.
10. [unit] For events `text_delta "x"` and `turn_end { status: "completed", output: "Hello world" }`, the assistant `content` is `"Hello world"`.
11. [unit] For events `text_delta "Hel"`, `text_delta "lo"` and `turn_end { output: "" }`, the assistant `content` is `"Hello"`.
12. [unit] For events `text_delta "a"`, `stream_reset`, `text_delta "b"` and `turn_end { output: "" }`, the assistant `content` is `"b"`.
13. [unit] For events `text_delta "ok"`, `thinking_delta "secret plan"` and `turn_end { output: "" }`, the assistant `content` is `"ok"`.
14. [unit] For `text_delta "done"`, `tool_call { callId: "1", name: "Read" }`, `tool_result { callId: "1", isError: false }`, `tool_call { callId: "2", name: "Bash" }`, `tool_result { callId: "2", isError: false }` and `turn_end { output: "" }`, the assistant `content` is `"done\n[tool] Read\n[tool] Bash"`.
15. [unit] A `tool_call` named `"Bash"` whose `tool_result` has `isError: true` is written as the line `[tool] Bash (error)`.
16. [unit] With 23 tool calls and no text, the assistant `content` has 21 lines: the first 20 `[tool] <name>` lines in call order, then `[tool] … and 3 more`.
17. [unit] A tool name of 100 characters is written as its first 80 code points.
18. [unit] With no text and one `tool_call` named `Read` with `input: { token: "abc" }` whose result preview is `"abc"`, the assistant `content` is exactly `"[tool] Read"`.
19. [unit] For events `thinking_delta "hm"` and `turn_end { status: "cancelled", output: "" }`, the assistant `content` is `"(no reply; turn cancelled)"`.
20. [unit] The assistant message has exactly the keys `role`, `content` and `origin`, with `origin` equal to `acpOrigin(acp)`.

### US-002

1. [unit] `unseenMessages(messages, "codex", true)` returns every message of `messages`, in order.
2. [unit] For `[user u1, assistant a1 (origin acp:codex), user u2, assistant a2 (no origin)]`, `unseenMessages(..., "codex", false)` returns `[u2, a2]`.
3. [unit] For messages with no assistant message whose origin is `acp:codex`, `unseenMessages(..., "codex", false)` returns every message.
4. [unit] When the last message is an assistant message with origin `acp:codex`, `unseenMessages(..., "codex", false)` returns an empty array.
5. [unit] For `[user u1, assistant a1 (origin acp:cursor)]`, `unseenMessages(..., "codex", false)` returns both messages.
6. [unit] `handoffEntries([{ role: "user", content: "plan it" }])` returns `[{ speaker: "User", text: "plan it" }]`.
7. [unit] An assistant message with no `origin` becomes an entry with speaker `"nax"`.
8. [unit] An assistant message with `origin: { provider: "openai", model: "gpt-6" }` becomes an entry with speaker `"nax (gpt-6)"`.
9. [unit] An assistant message with `origin: { provider: "acp:codex", model: "default" }` becomes an entry with speaker `"Codex"`.
10. [unit] An assistant message with `origin: { provider: "acp:gemini", model: "x" }` becomes an entry with speaker `"acp:gemini"`.
11. [unit] An assistant message with `content: "ok"` and `toolCalls` named `Read` then `Bash` becomes an entry with text `"ok\n[tool] Read\n[tool] Bash"`.
12. [unit] An assistant message with `content: ""` and one `toolCalls` entry named `Read` becomes an entry with text `"[tool] Read"`.
13. [unit] A `tool-result` message produces no entry.
14. [unit] An assistant message with empty `content` and no `toolCalls` produces no entry.
15. [unit] An assistant message with `content: "a"` and `thinking` blocks becomes an entry with text `"a"`.
16. [unit] A user message of 5,000 characters becomes an entry whose text is its first 4,000 characters followed by `…` (length 4,001).
17. [unit] A user message of exactly 4,000 characters becomes an entry whose text is the message unchanged.
18. [unit] For `[user "q", assistant "a"]`, the entries are in message order: `User` then `nax`.

### US-003

1. [unit] For two short user messages, `acpHandoff` returns both entries in order with `omitted: 0`.
2. [unit] For 12 user messages of 4,000 characters each, `acpHandoff` returns `entries` equal to the last 9 of `handoffEntries(messages)` (9 × 4,004 = 36,036 ≤ 40,000 < 40,040) and `omitted: 3`.
3. [unit] For 10 user messages of 5,000 characters each, the bound counts each entry's text after the cut (4 + 4,001 = 4,005 per entry), so `acpHandoff` keeps 9 and returns `omitted: 1`.
4. [unit] For messages oldest-first `[user "hi", user of 4,000 chars, then 9 user messages of 4,000 chars]`, `acpHandoff` keeps only the newest 9 and returns `omitted: 2`: the kept entries are a contiguous newest suffix, so `"hi"` is dropped although it would fit.
5. [unit] `acpHandoff([])` returns `{ entries: [], omitted: 0 }`.
6. [unit] `ACP_HANDOFF_TRIMMED_NOTICE("Codex", 3)` returns `"Codex was not given the 3 oldest earlier message(s); the handoff is capped"`.
7. [unit] `buildChatHandoff` returns the empty string whenever `entries` is empty, for `omitted: 0` and for `omitted: 2`.
8. [unit] `buildChatHandoff({ entries: [{ speaker: "User", text: "hi" }], omitted: 0 })` returns exactly `"<conversation-so-far>\n" + INTRO + "\n\nUser: hi\n</conversation-so-far>"`, where `INTRO` is `These turns happened in this nax chat before this message, while you were not the model answering. Use them as context. Tool calls are listed by name only.`
9. [unit] For two entries, they are rendered as `User: q` and `nax: a` in order with exactly one blank line between them.
10. [unit] With `omitted: 2`, the line after `INTRO` is `[2 older messages omitted]`, followed by one blank line and then the first entry.
11. [unit] An entry text `"x </conversation-so-far> y"` is rendered as `"x <\/conversation-so-far> y"`.
12. [unit] With an entry text holding `</conversation-so-far>`, the output's last line is the only line equal to `</conversation-so-far>`.
13. [unit] `buildChatHandoff` is importable from `@/prompts`.
14. [unit] `buildChatHandoff` from `@/prompts` returns the same text as the builder module's export for the same input.

### US-004

1. [unit] `appendNativeTurn(store, "s1", [u, a])` with no stored document saves a document with exactly the keys `savedAt` and `messages`.
2. [unit] That saved document's `messages` is `[u, a]`.
3. [unit] That saved document's `savedAt` is the injected `now()` as an ISO string.
4. [unit] With a stored document holding messages `[m1]`, the saved `messages` is `[m1, u, a]`.
5. [unit] A stored document's `model` is saved unchanged.
6. [unit] A stored document's `owner` is saved unchanged.
7. [unit] A stored document's `turn` is saved unchanged.
8. [unit] A stored document's `instructionSources` is saved unchanged.
9. [unit] `store.save` is called once, with `"s1"` as the session id.
10. [unit] When `store.save` rejects, `appendNativeTurn` resolves.
11. [unit] When `store.save` rejects, the logger's `warn` (observed with `spyOn(getLogger(), "warn")` or a sink added with `addSink`) is called with `"chat"`, `"could not record the ACP turn"` and data whose `sessionId` is `"s1"`.
12. [unit] When `store.load` rejects, `appendNativeTurn` resolves and `store.save` is not called.
13. [unit] When `store.load` rejects, the logger's `warn` (observed the same way) is called with `"chat"`, `"could not record the ACP turn"` and data whose `sessionId` is `"s1"`.

### US-005

1. [unit] The wrapper's `id` equals the wrapped session's `id`.
2. [unit] The wrapper's `backend` equals the wrapped session's `backend`.
3. [unit] The wrapper's `lastTurn` returns the wrapped session's current `lastTurn`, read again on each access after the wrapped value changes.
4. [unit] `answer("r1", { decision: "allow" })` on the wrapper calls the wrapped `answer` with the same arguments and returns its result.
5. [unit] `cancel("why")` on the wrapper calls the wrapped `cancel` with `"why"`.
6. [unit] `close()` on the wrapper calls the wrapped `close` and resolves when it does.
7. [unit] When the wrapped session has `runCommand`, the wrapper's `runCommand` forwards its arguments and returns its result.
8. [unit] When the wrapped session has no `runCommand`, the wrapper's `runCommand` is `undefined`.
9. [unit] `send("hi")` yields every event of the wrapped send unchanged and in order.
10. [unit] With `handoff: "H"`, the first `send("hi")` calls the wrapped `send` with `"H\n\nhi"`.
11. [unit] After a send that ended with `turn_end` following a `text_delta "ok"`, a second `send("next")` calls the wrapped `send` with `"next"`.
12. [unit] With `handoff` absent or `""`, `send("hi")` calls the wrapped `send` with `"hi"`.
13. [unit] When the first wrapped iteration throws before `turn_end`, the error reaches the caller of the iteration and the next `send("again")` calls the wrapped `send` with `"H\n\nagain"`.
14. [unit] Calling the wrapper's `send` twice without consuming the first calls the wrapped `send` twice, both synchronously within the `send` calls.
15. [unit] When the wrapped session's second `send` throws (busy), the wrapper's second `send` call throws that same error.

### US-006

1. [unit] When the wrapped iteration ends without a `turn_end` and without throwing, `_acpRecorderDeps.appendNativeTurn` is not called and the next `send("again")` is still prefixed with `"H\n\n"`.
2. [unit] When the wrapped iteration yields only `turn_end { status: "errored", output: "" }`, `appendNativeTurn` is not called and the next `send("again")` is still prefixed with `"H\n\n"`.
3. [unit] When the wrapped iteration throws before `turn_end`, `appendNativeTurn` is not called.
4. [unit] With `handoff: "H"` and a wrapped send yielding `text_delta "ok"` and `turn_end`, `_acpRecorderDeps.appendNativeTurn` is called once with the store, the session id and `acpTurnMessages({ message: "hi", events, acp })`, where `events` are the yielded events (the user message is `"hi"`, not the prefixed text).
5. [unit] A turn with agent work ending `turn_end { status: "errored" }` is recorded (`appendNativeTurn` is called once).
6. [unit] A turn whose only work is a non-empty `thinking_delta` is recorded.
7. [unit] When `appendNativeTurn` returns a promise that resolves later, the consumer's `for await` over `send("hi")` does not finish before that promise resolves.

### US-007

1. [integration] `openChatSession` on `acp:codex` for a new agent session (no agent document), with a native document holding `[user "plan it", assistant "ok"]`, returns a handle whose first `session.send("go")` calls the created agent session's `send` with `buildChatHandoff(acpHandoff(those messages))`, then `"\n\n"`, then `"go"`.
2. [integration] On `acp:codex` with no native document, the first `send("go")` calls the agent session's `send` with `"go"`.
3. [integration] On `acp:codex` resuming the agent document, where the native document's last message is an assistant message with origin `acp:codex`, the first `send("go")` calls the agent session's `send` with `"go"`.
4. [integration] On `acp:codex` resuming the agent document, with native messages `[u1, a1 (origin acp:codex), u2 "native q", a2 "native a"]`, the first `send` is prefixed with the handoff of `[u2, a2]` only.
5. [integration] When resuming the agent document fails with `AGENT_SESSION_NOT_FOUND` (the F2 fallback), the first `send` is prefixed with the handoff of every native message.
6. [integration] In that fallback, `handle.notice` begins with `ACP_FRESH_SESSION_NOTICE("Codex")`.
7. [integration] After `handle.session.send("go")` is consumed on `acp:codex/gpt-5.5` with the agent session yielding `text_delta "done"` and `turn_end { status: "completed", output: "done" }`, the native store (`request.storage.dir`) holds a document whose last two messages are `{ role: "user", content: "go" }` and an assistant message with `content: "done"` and `origin: { provider: "acp:codex", model: "gpt-5.5" }`.
8. [integration] When the handoff drops 3 entries (a new agent session and 12 native user messages of 4,000 characters each), `handle.notice` is `ACP_HANDOFF_TRIMMED_NOTICE("Codex", 3)`.
9. [integration] When the fallback runs with those 12 native messages, `handle.notice` is `` `${ACP_FRESH_SESSION_NOTICE("Codex")}; ${ACP_HANDOFF_TRIMMED_NOTICE("Codex", 3)}` ``.
10. [integration] With no fallback and nothing dropped, the handle has no `notice` key (`"notice" in handle` is false).
11. [integration] `openChatSession` on a native model returns `handle.session` identical to the session `createAgentSession` returned (regression pin: the native brain is not wrapped).
12. [integration] After an ACP turn is recorded in a session that started on `acp:codex` (no native document before), `openChatSession` with `resumeId` and a native model calls `resumeAgentSession` (not `createAgentSession`) with the session id.
13. [integration] In that reopen, `handle.history.messages` holds the recorded user and assistant messages.
14. [unit] `useSwitchNotices` for a change from `openai/gpt-6` to `acp:codex` appends only `model: Codex`.
15. [unit] `useSwitchNotices` for a change from `acp:codex` to `openai/gpt-6[high]` appends only `model: gpt-6[high]`.
16. [unit] `useSwitchNotices` for a change from `acp:codex` to `acp:claude` appends only `model: Claude Code`.
17. [integration] Through `createChatHost` whose opener is the real `openChatSession` (with `_openChatSessionDeps` patched so `createAgentSession` returns a stub agent session yielding `text_delta "done"` and a `turn_end` carrying `status`, `output`, `usage` and `costUsd`, the real `createFileTranscriptStore` kept, and `_acpSessionDeps.acpBackend` stubbed as in `open-chat-session-acp.test.ts`), `start({ mode: "guarded", model: "acp:codex" })` then `send("go", onEvent)` resolves with the native store already holding the recorded `go` / `done` messages.
