# SPEC: chat-resume-sessions — resumed sessions show their history and a readable name

## Summary

`nax chat` can resume a saved session, but the result is hard to use. A session started with
a skill is titled with the raw skill envelope (`<skill name="superpowers:brainstorming"
location="/Users/…`), the `/resume` picker lists the session you are in and every session that
never had a turn (`untitled fba63185`), and choosing a session leaves the screen empty: the
earlier conversation is on disk but never drawn, and nothing says which session is now open.

This feature makes a resumed session readable: the title comes from what the user typed, the
session list shows only sessions worth resuming, the transcript replays the stored conversation
(tool calls as their one-line cards, thinking omitted) followed by a `resumed <title>` notice,
and the header names the session. It is the first of three chat-polish features split from the
2026-10-28 TUI bug check; model effort switching (B2) and transcript polish (B3) follow.

## Motivation

Observed in a 120x36 tmux probe of `nax chat` v0.91.7-canary.6 (2026-10-28):

- `/resume` listed `<skill name="superpowers:brainstorming" location="/Users/williamkhoo/.claude/plu`
  as a session title twice, because `writeTurnMeta` (`packages/nax/src/chat/turn-runner.ts`) titles
  a session from the first message SENT, and a `/skill` turn sends the expanded
  `buildSkillInvocationMessage` envelope.
- The list's first row was `untitled fba63185  just now`: the session the user was in. Every
  `nax chat` start writes a meta file (`openChatSession`), so sessions closed without a turn
  pile up as `untitled <id>` rows.
- Choosing a session swapped the host's session (`resumeSession`), but the transcript kept the
  welcome card only: `ChatApp` never reads the stored conversation, and `ChatHost` has no way to
  give it one. `openChatSession` already loads the transcript document (`transcripts.load`) to
  decide between create and resume, then drops it.
- The header (`headerLines`, `packages/nax/src/tui/chat/chat-status.ts`) shows product, version,
  model and mode, never the session.

## Design

### Approach

Four changes, all in `packages/nax`:

1. **Title from the typed line.** `ChatHost.send` takes an optional `{ title }`. When the text
   `ChatApp` sends differs from the line the user typed — a skill, `/feature` or catalog command
   turn — it passes the typed slash line `/<name><rest>` as `title`; a plain message (and a job
   delivery) is sent with no options, exactly as today, because the message is its own title.
   `writeTurnMeta` titles a new session from `title` when present instead of the sent text. A pure `sessionTitleText` renders any stored title for display, so the titles already on
   disk that hold a skill envelope show as `/<skill name>`.
2. **List hygiene.** A session "has had a turn" when its stored meta has a non-null `updatedAt`
   (`writeTurnMeta` sets it; `openChatSession` writes `updatedAt: null` for a new session). The
   host's list and its latest-session choice skip sessions without a turn, and the list skips the
   host's own session. When the host leaves a session (a `replace` to a different id, or `close`)
   whose stored meta still has `updatedAt === null`, whose handle's `history.messages` was empty,
   and on which no `send` was attempted, it removes that session's meta after closing its handle, so new empty sessions stop
   accumulating. The filtering, the sent-on set and the cleanup live entirely in a new
   `packages/nax/src/chat/session-hygiene.ts`, because `chat-host.ts` is 570 of its 600 allowed
   lines; the host gains at most 25 net lines, and a measured overage is resolved by moving more
   code into that module, never by raising the cap.
3. **History on the handle.** `openChatSession` keeps the transcript document it already loads
   and returns its messages and `savedAt` on the handle; `ChatHost.history()` returns them for the
   current session. It is the snapshot taken when the session was opened, not a live view; the
   screen reads it only when the session id changes.
4. **Replay in the screen.** A pure `replayHistory` maps stored messages to `TranscriptEntry`
   rows, mirroring nax-agent-acp's `replayTranscript`
   (`packages/nax-agent-acp/src/server/translate/replay.ts`): tool inputs through
   `displayToolInput`, results through `toolResultPreview`, so a replay never shows more than the
   live turn did. `ChatApp` rebuilds its transcript whenever the session id changes (startup
   `--resume`, the picker, `/resume <id>`, `/clear`), and the header gains the session title.

### Integration (extends existing code)

Read only (verified 2026-10-28):

- `openChatSession(request, deps)` in `packages/nax/src/chat/open-chat-session.ts` — calls
  `const doc = await transcripts.load(meta.sessionId)` and chooses `createAgentSession` when
  `doc === null`, else `resumeAgentSession`.
- `TranscriptDoc` (`@nathapp/nax-agent`, type export) — `{ savedAt: string; messages: readonly
  ConversationMessage[]; … }`; a message is `{ role: "user"; content }`,
  `{ role: "assistant"; content; toolCalls?: { id; name; input }[]; thinking? }` or
  `{ role: "tool-result"; toolCallId; content; isError? }`.
- `displayToolInput(input: unknown): unknown` and `toolResultPreview(content: string): string`
  (`@nathapp/nax-agent`, value exports) — the masking and caps the live `tool_call` /
  `tool_result` events get.
- `COMPACTION_SUMMARY_PREFIX` (`@nathapp/nax-agent/internal`) — a compacted transcript keeps the
  summary as a user message whose content starts with this prefix.
- `buildSkillInvocationMessage({ skill, args })` in
  `packages/nax/src/prompts/builders/skills-builder/index.ts` — the envelope is
  `<skill name="<qualifiedName>" location="<path>">`, a references line, the body, `</skill>`,
  then `\n\n<args>` when args are non-empty.
- `SessionStorage.readMeta(id)`, `removeMeta(id)`, `list({ cwd, cursor })`
  (`@nathapp/nax-agent`); a list entry's `updatedAt` falls back to `createdAt`, so it cannot tell
  a turnless session apart — the meta must be read.
- `TranscriptEntry` and `reduceTranscript` in `packages/nax/src/tui/chat/transcript-model.ts`.
- `ChatApp` in `packages/nax/src/tui/chat/ChatApp.tsx`: `welcomeEntry(host)`, `runCommand`,
  `submit`, `sendTurn`, and the `host.notice()` effect.

Changed — the **Baseline** only locates the code; implement the **Target**.

- `ChatHost.send` (`packages/nax/src/chat/chat-host.ts`)
  - Baseline: `send(message: string, onEvent: (event: SessionEvent) => void): Promise<void>`
  - Target: `send(message: string, onEvent: (event: SessionEvent) => void, options?: ChatSendOptions): Promise<void>`
    with `export interface ChatSendOptions { readonly title?: string }`.
- `ChatHost.history` (new, optional so typed test fakes keep compiling)
  - Target: `history?(): ChatHistory`, returning `this.handle?.history ?? { messages: [] }`.
- `ChatHistory` — declared in `packages/nax/src/chat/open-chat-session.ts` (which `chat-host.ts`
  already imports, so no new import edge) and re-exported from `packages/nax/src/chat/index.ts`:
  `export interface ChatHistory { readonly messages: readonly TranscriptDoc["messages"][number][]; readonly savedAt?: string }`.
- `ChatSessionHandle` (`packages/nax/src/chat/open-chat-session.ts`)
  - Baseline: `{ session; meta; release }`
  - Target: adds an OPTIONAL `readonly history?: ChatHistory` (typed handle fakes in tests build
    `{ session, meta, release }`); `openChatSession` always sets it — `{ messages: doc.messages,
    savedAt: doc.savedAt }` when a document was loaded, `{ messages: [] }` otherwise.
- `RunChatTurnOptions` (`packages/nax/src/chat/turn-runner.ts`)
  - Target: adds `readonly title?: string`; `writeTurnMeta` titles from
    `stored.title ?? clip(options.title?.trim() || message)` (clip = the existing whitespace
    collapse and 80-code-point cut), so an empty or whitespace-only title falls back to the message.
- `sendTurn` inside `ChatApp`
  - Baseline: `sendTurn(message, prepare?)`
  - Target: `sendTurn(message, prepare?, title?)`. It calls `host.send(sent, onEvent)` with two
    arguments when the sent text equals the title it would pass, and
    `host.send(sent, onEvent, { title })` otherwise, where `title` is the `title` argument or, for
    a catalog command, the `message` argument (`/<name><rest>`).
- `headerTitleLine` (`packages/nax/src/tui/chat/chat-status.ts`)
  - Baseline: `headerTitleLine(state, version, glyphs)`.
  - Target: `headerTitleLine(state, version, width, glyphs)`; `headerLines` passes its resolved
    width. `headerLines`' own input shape is unchanged.

New:

- `packages/nax/src/chat/session-title.ts` — `sessionTitleText(title: string | null, sessionId: string): string`.
- `packages/nax/src/chat/session-hygiene.ts` — `hasHadTurn(meta: SessionMeta): boolean`
  (`meta.updatedAt !== null`); `resumableRows(input)` that reads each listed session's meta and
  drops the host's own id and turnless sessions; `removeIfEmpty(input)` that re-reads the meta and
  removes it when `updatedAt === null`, the left handle's `history.messages` is empty and the id
  is not in the host's sent-on set, warning instead of throwing; a re-read that finds no meta
  (`readMeta` returns `null`) does nothing and logs nothing.
- `packages/nax/src/tui/chat/history-replay.ts` — `replayHistory(history: ChatHistory): readonly TranscriptEntry[]`.

### Replay mapping (`replayHistory`)

| Stored message | Entries |
|:--|:--|
| user, content starts with `COMPACTION_SUMMARY_PREFIX` | one `{ kind: "notice", text: "earlier conversation compacted" }` |
| user, content starts with `<skill name="X"` | one `{ kind: "user", text: "/X" }`, or `"/X <args>"` where args is the text after the LAST `</skill>\n\n` in the content, trimmed (a skill body may itself contain `</skill>`; production args carry a leading space); content that ends in `</skill>` has no args |
| user, any other non-empty content | one `{ kind: "user", text: content }` |
| user, empty content | none |
| assistant, non-empty content | one `{ kind: "reply", turnId: "history-<i>", text: content }` (`i` = message index) |
| assistant `toolCalls[j]` | one `{ kind: "tool", turnId: "history-<i>", callId, name, input: displayToolInput(input), status, preview, startedAt: savedAt, endedAt: savedAt, children: [] }` after the reply |
| assistant `thinking` | none |
| tool-result | none of its own; it sets the status and preview of the call with the same id |

A call whose result is present takes `status: "ok"` (or `"error"` when `isError`) and
`preview: toolResultPreview(content)`; a call with no stored result takes `status: "error"` and
`preview: "No result was recorded for this call."`. `startedAt`/`endedAt` take `savedAt`, or
`"1970-01-01T00:00:00.000Z"` when `savedAt` is absent, so a replayed card never renders as
running.

### Screen behaviour on a session change

`ChatApp` keys its transcript on `host.current().sessionId`. On the first render (the initial
state) and, through a layout effect declared before the notice effects, whenever the id changes,
it sets the transcript to `[welcomeEntry(host), ...replayHistory(host.history?.() ??
{ messages: [] }), notice]`, where `notice` is `{ kind: "notice", text: "resumed <sessionTitleText>" }`
only when the replayed list is non-empty. Mode and model switches reopen the same id and leave the
transcript alone. The `host.notice()` effect re-runs on a session id change as well as on a
changed notice text, so resuming two interrupted sessions in a row shows the interrupted notice
after each rebuild. Entries the other mount effects append (resource notice, sandbox warning,
`host.notice()`) land after the rebuilt list, never before it.

The header's first line becomes `✻ nax chat v<version> · <model> · <mode> · <title>` when
`meta.title` is non-null, with the title rendered by `sessionTitleText` and elided at the end
with the theme's ellipsis (a new end-elision helper beside `elideMiddle`) so the line fits the
header width. When fewer than 8 columns remain for the title text after the model, the mode and
the ` · ` separator before the title, the title segment is left out entirely. The title is the
first thing on the line to yield; product, version, model and mode are drawn as today.

### Failure Handling

| Case | Behaviour |
|:--|:--|
| `options.title` is absent or the empty string | the title falls back to the sent message, as today |
| reading one session's meta fails with `SESSION_META_UNREADABLE` during `listSessions` (reachable only through a race, since `storage.list` already skips unreadable files; tests reach it with a `readMeta` stub) | that row is skipped and `logger.warn("chat", "skipping unreadable session metadata", { sessionId })` is logged; other rows still list |
| `removeMeta` throws, or a test storage fake lacks it, while the host leaves a turnless session | the error is logged with `logger.warn("chat", "could not remove empty session", { sessionId, cause })` and the replace or close continues |
| the meta re-read while leaving a session returns `null` (already gone) | nothing is removed and nothing is logged |
| a stored message has a role the mapping does not name | it is skipped; replay continues with the next message |
| a tool call's input cannot be displayed | `displayToolInput` already returns its bounded placeholder; replay uses it as the input |

## Out of Scope

- Collapsing a skill invocation into an expandable row, live or replayed, belongs to the later chat-transcript-polish feature; this feature only replays a skill envelope as its typed `/name args` line.
- Replaying a catalog command turn as the command the user typed: the transcript stores only the expanded template text, which is what replay shows.
- Replaying thinking blocks, and replaying nested subagent calls as children of their agent card.
- Showing per-call durations on replayed tool cards.
- A session whose first turn failed before its metadata was written keeps `updatedAt: null` and stays hidden from the list; it is still reachable with `/resume <id>`.
- Deleting turnless sessions already on disk from earlier versions; they are hidden from the list, not removed.
- Model effort switching and the header's model truncation (feature chat-model-effort).
- Any change to `@nathapp/nax-agent` or `@nathapp/nax-agent-acp`.

## Stories

### US-001 — title a session from what the user typed

Workdir: packages/nax. No dependencies.

`ChatHost.send` gains `ChatSendOptions { title? }`, threaded into `runChatTurn` and
`writeTurnMeta`. `ChatApp` passes `{ title: "/<name><rest>" }` for a turn produced by a slash
command (skill, `/feature`, catalog command) and calls `send` with two arguments for a plain
message, as today. New `sessionTitleText` renders a stored title for display (`untitled <first 8
id chars>` for null, `/<name>` for a legacy skill-envelope title, else the title), and the
`/resume` picker rows and the `/sessions` listing use it.

### US-002 — list only resumable sessions and expose the open session's history

Workdir: packages/nax. Depends on US-001.

`openChatSession` returns the loaded transcript's messages and `savedAt` on the handle, and the
host's `history()` returns the current handle's. `listSessions` skips the host's own session
(read from `this.handle?.meta.sessionId`, so listing with no open session does not throw) and
sessions whose meta has `updatedAt === null`; `latestId` skips the latter too. The host records
each session id it attempted a `send` on; when it replaces a session with a different id or
closes, it removes the left session's meta after closing its handle if the stored meta still has
`updatedAt === null` and the id was never sent on. A mode or model switch (same id) removes
nothing. The logic lives in new `packages/nax/src/chat/session-hygiene.ts`; `chat-host.ts` grows
by at most 25 net lines.

### US-003 — replay stored messages as transcript entries

Workdir: packages/nax. Depends on US-002.

New pure `replayHistory(history)` in `packages/nax/src/tui/chat/history-replay.ts` implementing the
replay mapping table above.

### US-004 — rebuild the transcript on a session change and name the session in the header

Workdir: packages/nax. Depends on US-001, US-002, US-003.

`ChatApp` rebuilds its transcript from `host.history()` on the first render and on every session
id change (a layout effect declared before the notice effects), ending with a `resumed <title>`
notice when there is history; the header's first line shows the session title.

### Context Files

**US-001**
- `packages/nax/src/chat/turn-runner.ts`
- `packages/nax/src/chat/chat-host.ts`
- `packages/nax/src/tui/chat/ChatApp.tsx`
- `packages/nax/src/tui/chat/Picker.tsx`
- `packages/nax/src/tui/chat/slash-commands.ts`

**US-002**
- `packages/nax/src/chat/open-chat-session.ts`
- `packages/nax/src/chat/chat-host.ts`
- `packages/nax/test/unit/chat/chat-host.test.ts`
- `packages/nax/test/unit/chat/chat-host-resume.test.ts`

**US-003**
- `packages/nax/src/tui/chat/transcript-model.ts`
- `packages/nax-agent-acp/src/server/translate/replay.ts`
- `packages/nax/src/prompts/builders/skills-builder/index.ts`
- `packages/nax-agent/src/native/session/compaction.ts`

**US-004**
- `packages/nax/src/tui/chat/ChatApp.tsx`
- `packages/nax/src/tui/chat/chat-status.ts`
- `packages/nax/src/tui/chat/history-replay.ts` — created by US-003, wired here
- `packages/nax/src/chat/session-title.ts` — created by US-001, used here
- `packages/nax/test/ui/chat/chat-app.test.tsx`

### Creates

**US-001**
- `packages/nax/src/chat/session-title.ts`
- `packages/nax/test/unit/chat/session-title.test.ts`

**US-002**
- `packages/nax/src/chat/session-hygiene.ts`
- `packages/nax/test/unit/chat/session-hygiene.test.ts`

**US-003**
- `packages/nax/src/tui/chat/history-replay.ts`
- `packages/nax/test/unit/tui/chat/history-replay.test.ts`

**US-004**
- `packages/nax/test/ui/chat/chat-app-session.test.tsx`

### Modifies

**US-001**
- `packages/nax/src/chat/index.ts` — export `sessionTitleText` and `ChatSendOptions` from the chat barrel so the TUI imports them through it.
- `packages/nax/test/unit/chat/turn-runner.test.ts` — add cases for the `title` option; the existing AC-15/AC-16 title assertions stay as they are because a send without `title` still titles from the message.
- `packages/nax/test/ui/chat/slash-resources.test.tsx` — skill and catalog command sends now carry a third argument, an options object whose title is the typed slash line; exact-arity assertions on those sends (message plus a function matcher) gain that options object. Plain-message send assertions stay two-argument.
- `packages/nax/test/ui/chat/slash-commands.test.tsx` — skill, feature and catalog command sends now carry a third argument, an options object whose title is the typed slash line; exact-arity assertions on those sends gain that options object. Plain-message send assertions stay two-argument.
- `packages/nax/test/ui/chat/chat-shell-lines.test.tsx` — catalog command sends now carry a third argument, an options object whose title is the typed slash line; exact-arity assertions on those sends gain that options object.
- `packages/nax/test/ui/chat/picker.test.tsx` — a resume row for a null title still reads `untitled <8 id chars>`; rows built from a legacy skill-envelope title now read as a slash and the skill name, so any fixture asserting the raw envelope as a label changes to that form.

**US-002**
- `packages/nax/src/chat/index.ts` — re-export `ChatHistory` from the chat barrel so the TUI replay imports it through it.
- `packages/nax/test/unit/chat/chat-host.test.ts` — AC-5 lists the host's own freshly started session and expects it back with `heldByPid: 4242`; the list now excludes the host's own session, so the test resumes or stores a separate session with a recorded turn (`updatedAt` set) and asserts that row carries `heldByPid: 4242`.
- `packages/nax/test/unit/chat/open-chat-session.test.ts` — assertions that compare the whole returned handle gain the new `history` field (`{ messages: [] }` for a new session).

**US-004**

None. Every existing header fixture uses `title: null`, which keeps its current first line; the new header and transcript cases go into new tests.

### Seams

- `sessionTitleText` (US-001) is consumed by US-004's header and resumed notice; US-004's ACs render a host whose stored title is a legacy skill envelope and assert the header shows `/<name>`.
- `ChatHost.history` (US-002) and `replayHistory` (US-003) are consumed by `ChatApp` (US-004); US-004's ACs mount `ChatApp` over a host whose `history()` returns stored messages, trigger `/resume <id>` through the input, and assert the replayed rows appear.
- `ChatSendOptions.title` (US-001) is produced by `ChatApp` and consumed by `NativeChatHost.send`; US-001's ACs submit through the mounted `ChatApp` and assert the host's `send` received the typed line as `title`.

## Acceptance Criteria

### US-001 — title a session from what the user typed

- [unit] `runChatTurn` with `message: "<skill …>body"` and `title: "/brainstorm plan it"` on a session whose stored meta has `title: null` writes meta with `title === "/brainstorm plan it"`.
- [unit] `runChatTurn` with `title: ""` and `message: "hello there"` writes `title === "hello there"`.
- [unit] `runChatTurn` with `title` longer than 80 code points writes the first 80 code points after collapsing whitespace, the same clip a message gets.
- [unit] a second `runChatTurn` with a different `title` on a session whose stored meta already has `title: "first"` leaves `title === "first"`.
- [integration] `NativeChatHost.send("expanded", onEvent, { title: "/x y" })` on a fresh session results in stored meta `title === "/x y"`.
- [unit] `sessionTitleText(null, "fba63185-0000-4000-8000-000000000000")` returns `"untitled fba63185"`.
- [unit] `sessionTitleText('<skill name="superpowers:brainstorming" location="/Users/a/.claude/plu', id)` returns `"/superpowers:brainstorming"`.
- [unit] `sessionTitleText("fix the login bug", id)` returns `"fix the login bug"`.
- [unit] `sessionTitleText('<skill name="x"', id)` with an unterminated name attribute (no closing quote) returns the stored title unchanged.
- [integration] typing `hello world` and Return in a mounted `ChatApp` calls the host's `send` with exactly two arguments, `"hello world"` and the event callback.
- [unit] `runChatTurn` with `title: "   "` and `message: "hello there"` writes `title === "hello there"`.
- [integration] typing `/superpowers:brainstorming plan the cut` for a catalog skill calls `send` with the skill invocation message as the first argument and `{ title: "/superpowers:brainstorming plan the cut" }` as the third.
- [integration] typing `/feature chat-resume-sessions` with a readable spec calls `send` with `{ title: "/feature chat-resume-sessions" }`.
- [integration] typing a catalog command `/review now` calls `send` with the expanded template message and `{ title: "/review now" }`.
- [integration] the `/resume` picker draws a session row whose stored title is a skill envelope as `/superpowers:brainstorming`.
- [integration] `/sessions` prints each row as `<sessionId> <sessionTitleText(title, sessionId)>`, so a null-title row reads `<id> untitled <8 id chars>`.

### US-002 — list only resumable sessions and expose the open session's history

- [unit] `openChatSession` for a new session returns a handle whose `history` equals `{ messages: [] }`.
- [unit] `openChatSession` with `resumeId` of a session whose transcript store returns a document with two messages and `savedAt: "2026-10-28T01:00:00.000Z"` returns `history` with those two messages and that `savedAt`.
- [integration] after `resume({ id })` of a stored session with a transcript, `host.history()` returns that transcript's messages.
- [integration] `listSessions()` does not include the host's current session id.
- [integration] `listSessions()` on a host that has not opened a session returns the stored sessions with a recorded turn and does not throw.
- [integration] a host that `start`s a session, switches mode with `switchTo({ mode: "full" })`, sends once, and closes keeps that session's meta.
- [integration] `listSessions()` omits a stored session whose meta has `updatedAt: null` and includes one whose meta has `updatedAt` set.
- [integration] `resume({})` skips a newer stored session whose meta has `updatedAt: null` and opens the newest session with `updatedAt` set.
- [integration] a host that `start`s a session and then `close`s without calling `send` leaves no meta for that session (`storage.readMeta(id)` returns `null`).
- [integration] a host that `start`s a session, calls `send`, and `close`s keeps that session's meta.
- [integration] a host that `start`s a session and then `resume`s another removes the first session's meta when nothing was sent on it.
- [integration] a host that `resume`s a session whose meta has `updatedAt: null` but whose transcript holds messages, then closes without sending, keeps that session's meta.
- [integration] a host whose own session's meta was already removed by another process closes without error and without logging a warning.
- [integration] when `storage.removeMeta` rejects during `close`, `close` resolves and the logger records `warn("chat", "could not remove empty session", …)` with that `sessionId`.
- [integration] when one listed session's `readMeta` throws `SESSION_META_UNREADABLE`, `listSessions()` returns the other rows and logs `warn("chat", "skipping unreadable session metadata", …)` with that `sessionId`.

### US-003 — replay stored messages as transcript entries

- [unit] `replayHistory({ messages: [] })` returns an empty array.
- [unit] a user message `"hello"` replays as `[{ kind: "user", text: "hello" }]`.
- [unit] a user message with empty content replays as no entries.
- [unit] a user message whose content is `buildSkillInvocationMessage` output for skill `superpowers:brainstorming` with args `"plan it"` replays as `{ kind: "user", text: "/superpowers:brainstorming plan it" }`.
- [unit] the same skill envelope with empty args replays as `{ kind: "user", text: "/superpowers:brainstorming" }`.
- [unit] a skill envelope built with args `" plan it"` (leading space, as `/skill plan it` produces) replays as `{ kind: "user", text: "/superpowers:brainstorming plan it" }`.
- [unit] a skill envelope whose body itself contains the line `</skill>` and whose args are `"go"` replays as `{ kind: "user", text: "/superpowers:brainstorming go" }`.
- [unit] a skill envelope whose body contains `</skill>` followed by a blank line and `more`, built with empty args, replays as `{ kind: "user", text: "/superpowers:brainstorming" }`.
- [unit] a user message starting with `COMPACTION_SUMMARY_PREFIX` replays as `{ kind: "notice", text: "earlier conversation compacted" }`.
- [unit] an assistant message at index 3 with content `"done"` and no tool calls replays as `{ kind: "reply", turnId: "history-3", text: "done" }`.
- [unit] an assistant message with empty content and one tool call replays as exactly one `tool` entry and no `reply` entry.
- [unit] an assistant tool call `{ id: "c1", name: "Read", input: { path: "a" } }` followed by tool-result `{ toolCallId: "c1", content: "17 lines" }` replays as a `tool` entry with `status: "ok"`, `preview` equal to `toolResultPreview("17 lines")`, `input` equal to `displayToolInput({ path: "a" })`, and `children: []`.
- [unit] a tool-result with `isError: true` gives its call `status: "error"`.
- [unit] a tool call with no matching tool-result replays with `status: "error"` and `preview: "No result was recorded for this call."`.
- [unit] with `savedAt: "2026-10-28T01:00:00.000Z"`, every replayed tool entry has `startedAt` and `endedAt` equal to it.
- [unit] with `savedAt` absent, replayed tool entries have `startedAt` and `endedAt` equal to `"1970-01-01T00:00:00.000Z"`.
- [unit] an assistant message's `thinking` blocks produce no entries.
- [unit] a message whose `role` is not user, assistant or tool-result is skipped and the messages after it still replay.
- [unit] a tool result whose content holds an `sk-` style secret replays with the masked preview `toolResultPreview` returns, not the raw content.

### US-004 — rebuild the transcript on a session change and name the session in the header

- [integration] mounting `ChatApp` over a host whose `history()` returns `{ messages: [] }` draws the welcome card and no `resumed` notice.
- [integration] mounting `ChatApp` over a host whose `history()` returns a user message `"earlier question"` and an assistant reply `"earlier answer"` draws both after the welcome card, followed by the notice `resumed <title>`.
- [integration] typing `/resume s2` in a mounted `ChatApp`, where the fake host's `resume` switches `current().sessionId` to `s2` and `history()` to a transcript containing `"from s2"`, replaces the transcript with the welcome card, `"from s2"` and `resumed <title of s2>`; rows from before the resume are gone.
- [integration] choosing a session in the `/resume` picker rebuilds the transcript the same way as `/resume <id>`.
- [integration] a mode switch through `/mode full` that keeps the same session id leaves the transcript rows unchanged.
- [integration] `/clear`, where the host's new session has empty history, leaves only the welcome card.
- [integration] a host without a `history` member renders the welcome card only, without error.
- [integration] the `resumed` notice uses `sessionTitleText`: a resumed session whose stored title is a skill envelope reads `resumed /superpowers:brainstorming`.
- [integration] a resource notice from `host.resourceNotice()` appears after the replayed rows, not before them.
- [integration] resuming two interrupted sessions one after the other shows the interrupted notice after each rebuild.
- [integration] a resumed session whose last turn was interrupted shows the `resumed <title>` notice first and the host's `"The last turn was interrupted. Send a message to continue it."` notice after it.
- [unit] `headerLines` at width 40 for model `p/abcdefghijklmnopqrstuvwx` (24-character name) in guarded mode, where fewer than 8 columns remain for the title text after the separator, draws the first line with no title segment.
- [unit] `headerLines` for a state whose `meta.title` is `"fix login"` ends its first line with ` · fix login`.
- [unit] `headerLines` for a state whose `meta.title` is `null` draws the first line without a title segment.
- [unit] `headerLines` at width 60 for model `p/m` in guarded mode with a 100-character title keeps the first line within 60 display columns and ends it with the theme ellipsis.
- [unit] `headerLines` for a state whose `meta.title` is a skill envelope shows `/superpowers:brainstorming` as the title segment.
