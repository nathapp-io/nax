# SPEC: chat-acp-switch-and-replay — in-place ACP model/effort switches, a safe reopen, and a faithful ACP history replay

Closes: #2743, #2744

## Summary

Three fixes to `nax chat` on an ACP brain (Claude Code, Codex, Cursor), found in a live smoke of
v0.91.7-canary.9:

1. **In-place switch.** A model or effort change on the same ACP agent stops closing and resuming
   the agent session. A new optional `AgentSession.configure({ model?, effort? })` (nax-agent) is
   implemented by the ACP backend over ACP `session/set_config_option` (nax-agent-acp), and the chat
   host uses it for a same-agent, same-mode change, keeping close-and-reopen for every other switch.
2. **Safe reopen (#2744).** Opening an ACP brain whose stored agent session has never run a turn
   creates a fresh agent session instead of resuming one the agent cannot restore; and a switch
   whose rollback also fails starts a new chat session instead of leaving the host on a closed one.
3. **Faithful history (#2743).** A recorded ACP reply keeps a blank line between the text written
   before and after a tool call, and a resumed chat replays an ACP turn's `[tool] <name>` lines as
   tool rows instead of inline prose.

## Motivation

Live smoke, 2026-10-30, canary.9:

- `nax chat --model acp:codex`, then before the first message `/effort high` (or `/model
  acp:codex/gpt-6-luna`): `✗ The ACP agent is unavailable: session/resume failed: Internal error`,
  and every later message fails `Session "<id>" is closed`. The switch closes the agent session and
  resumes it in a new process; codex-acp has nothing to resume before its first prompt and answers
  JSON-RPC -32603 (`AGENT_SESSION_BACKEND_UNAVAILABLE`), which `isFreshFallback` does not accept.
  The rollback resumes the same never-prompted session, fails the same way, and `this.handle` stays
  on the closed session. After one turn the same switch works.
- An effort bump does not need a new process at all: ACP sets model and effort on a live session
  with `session/set_config_option`, which nax-agent-acp already sends at open
  (`packages/nax-agent-acp/src/client/open.ts` `applyModel` / `applyEffort`) but has no way to send
  later, because `AgentSession` exposes only `send`, `answer`, `cancel`, `close` and `runCommand`.
- A Cursor turn "text, Edit File, text" is recorded as `Creating hello.txt with the content
  hi.Created hello.txt with hi.` (no break), which is also what the next brain receives in its
  handoff; on `--resume` it renders as `…hi. [tool] Edit File` on one line.

## Design

### Approach

**configure (nax-agent).** `AgentSession.configure?(input: SessionConfigureInput): Promise<void>`
mirrors `runCommand`: optional on the interface, implemented by the session class. Refusals, checked
in this order: `AgentSessionError` `AGENT_SESSION_CLOSED` when closing/closed; `AGENT_SESSION_BUSY`
when a turn, a command or another configure is in flight; `AGENT_SESSION_INVALID_OPTIONS` when the
input names neither `model` nor `effort` (or names one as an empty string);
`AGENT_SESSION_CAPABILITY_UNSUPPORTED` (context `{ capability: "configure" }`) when the opened
backend has no `configure`. Otherwise it delegates to `OpenedBackend.configure(input)`. While that
call is pending, `send` and `runCommand` throw `AGENT_SESSION_BUSY`. A backend error propagates
unchanged and the busy guard is released, so the session stays usable. `close()` during a pending
configure proceeds as usual; the pending configure settles with what the backend returns (the ACP
backend rejects with `AGENT_SESSION_CLOSED`, step 4 below).

**configure (nax-agent-acp).** A new module `src/client/session-configure.ts` exports
`configureAcpSession(input: { link: AcpLink; agentSessionId: string; agentName: string; secrets:
readonly string[]; timeoutMs: number; signal: AbortSignal; sessionId: string; configOptions: readonly
SessionConfigOption[]; change: SessionConfigureInput }): Promise<readonly SessionConfigOption[]>`
(the config options after the last request it sent), plus an `onApplied(part, configOptions)`
callback it calls right after each request succeeds. `assemble` gives the ACP `OpenedBackend` a
`configure` that calls it with the live process's link and session id, `live.options.secrets` (the
token-augmented set, so tool-host tokens are redacted from errors), `base.initializeTimeoutMs` and
`ctx.openSignal`, recording each applied part through `onApplied` (step 5). Together they:

1. gets the live process through `liveFor` (reconnecting once after a crash, as a turn does);
2. when `model` is given: resolves it with `resolveModelValue(agentName, ids, model, secrets)`, where
   `ids` are the model option values of the session's current config options (`configModelIds`,
   now exported from `open.ts` with a signature taking `readonly SessionConfigOption[]`), finds `modelOptionId`, and sends
   `session/set_config_option { sessionId: agentSessionId, configId, value }`; no model option
   offering it -> `AGENT_SESSION_CAPABILITY_UNSUPPORTED` (context `{ capability: "model" }`), no
   request sent;
3. then, when `effort` is given: finds `effortOptionId(configOptions, agentName, effort)` in the
   config options **returned by step 2** (or the current ones when no model was set) and sends
   `session/set_config_option`; no option -> `AGENT_SESSION_CAPABILITY_UNSUPPORTED` (context
   `{ capability: "effort" }`), no request sent (unlike open, which skips an unoffered effort with a
   warning);
4. each request is raced against `initializeTimeoutMs` and the session's `openSignal` with `race`:
   a timeout throws `AGENT_SESSION_BACKEND_UNAVAILABLE`, an abort (the session is closing) throws
   `closedDuringOpen(sessionId)` (`AGENT_SESSION_CLOSED`), a JSON-RPC error is mapped by
   `openRequestError` with step label `session/set_config_option`;
5. records each part as soon as its request succeeds, so a later reconnect re-applies exactly what
   the live agent holds: the `AcpSession` gains a mutable `base` (replacing `readonly base`) updated
   to `{ ...base, model }` after the model request and `{ ...base, effort }` after the effort
   request, and a mutable `configOptions` set to each response's `configOptions`. When the model
   request succeeds and the effort step then fails, the model stays recorded and `configure`
   rejects with the effort failure.

The session's config options come from a new `OpenedAcp.configOptions` field. Today `applyEffort`
returns `void` and `applyConfig` returns the post-model offers, dropping the effort response; the
target: `applyEffort` returns the offers carrying the `set_config_option` response's
`configOptions` (or its input offers when it sent nothing), and `applyConfig` returns `{ offers:
<post-model offers>, configOptions: <post-effort offers' configOptions> }`. `OpenedAcp.offered` stays
computed from the post-model offers exactly as today (`backend-offered-choices.test.ts` pins that);
`OpenedAcp.configOptions` is the post-effort `configOptions` — the response to the last config
request open sent, else the `session/new` or restore response's options. It is copied to
`AcpSession.configOptions` at open and at every reconnect. The legacy `session/set_model` path is
not used by `configure`.

**Zero-turn guard (nax).** `openAcpBrain` resumes only a stored agent document that carries a
`turn` marker (`TranscriptDoc.turn`, written by the first `send`). A document without one is a
session the agent never prompted: it is deleted with `store.delete(sessionId)` and a fresh agent
session is created, with no notice (nothing was lost) and `fresh: true`.

**Recorder pass-through (nax).** Every ACP agent session reaches the host wrapped by
`recordAcpTurns` (`acp-recorder.ts`), whose hand-built object forwards only `id`, `backend`,
`lastTurn`, `runCommand`, `send`, `answer`, `cancel` and `close`. It gains a `configure` getter
modelled on the `runCommand` getter: the wrapped session's `configure` bound to it, or `undefined`
when the wrapped session has none. Without it the in-place path is unreachable in production.

**Switch (nax).** `ChatHost.switchSession` delegates to a new `switchChatSession` in
`packages/nax/src/chat/session-switch.ts`:

```ts
export interface SwitchTarget {
  readonly mode: ChatMode;
  readonly model: string;
}
export interface SwitchInput {
  readonly previous: ChatSessionHandle;      // the open handle being switched away from
  readonly from: SwitchTarget;               // its mode and model
  readonly target: SwitchTarget;             // the requested mode and model
  readonly reopen: (to: SwitchTarget) => Promise<ChatSessionHandle>;    // resume previous.meta.sessionId
  readonly openFresh: (to: SwitchTarget) => Promise<ChatSessionHandle>; // a new chat session, as start opens one
  readonly writeMeta: (meta: SessionMeta) => Promise<void>;
}
export interface SwitchOutcome {
  readonly handle: ChatSessionHandle;
  readonly error?: unknown;   // the switch failure to rethrow after applying the outcome
  readonly notice?: string;   // set only on the new-session path
}
export async function switchChatSession(input: SwitchInput): Promise<SwitchOutcome>;
```

1. **In place.** When `target.mode === from.mode` and `acpInPlaceChange(from.model, target.model)`
   returns a change and `previous.session.configure` is defined, call it with the change, then
   `writeMeta({ ...previous.meta, model: target.model })` and return `{ handle: { ...previous, meta:
   <that meta> } }`. Any error from `configure` (including `AGENT_SESSION_CAPABILITY_UNSUPPORTED`)
   or from that `writeMeta` falls through to step 2 with the previous session still open (step 2's
   reopen applies the target from scratch and writes the meta again).
2. **Close and reopen** (today's path, moved): close `previous.session`, `previous.release({
   retainLock: true })`, `reopen(target)`, `writeMeta(next.meta)`; return `{ handle: next }`.
3. **Rollback.** If step 2 fails after closing: close/release the half-opened `next` as today, then
   `reopen(from)`; success returns `{ handle, error }` with the original error.
4. **New session.** If the rollback reopen also fails: `previous.release()` (no `retainLock`, so the
   old session's lock is freed), `openFresh(from)` (a new chat session on the original mode and
   model, as `start` opens one), and return `{ handle, error, notice }` with notice
   `ROLLBACK_NEW_SESSION_NOTICE(oldId, reason)` = `could not reopen session <oldId> after the failed
   switch (<reason>); started a new session (/resume <oldId> retries it)`, where `reason` is the
   first line of `errorMessage(E)`. The reason is in the notice because the TUI rebuilds its
   transcript on the new session id and drops the error entry it appended for the rejected switch. If `openFresh` fails too, `switchChatSession`
   throws `new NaxError(<message naming both failures>, "CHAT_SESSION_REOPEN_FAILED", { stage:
   "chat", sessionId: <oldId>, switchError: errorMessage(E), cause: <openFresh error> })`. The new
   session deliberately bypasses `replace()`: no `asks.reset()` is needed (the old session was
   closed with no pending asks) and its hygiene is skipped: the old session stays on disk so the notice's
   `/resume` can retry it.

`acpInPlaceChange(from, to): SessionConfigureInput | undefined` (new, `packages/nax/src/chat/acp/acp-switch.ts`)
parses both with `parseChatAcpModel` (a string that throws on parse counts as not ACP) and returns
a change only when both are ACP models of the same agent and something differs. When the model part
differs it returns `{ model }` plus `effort` whenever the target names one (an agent may reset effort
on a model change); when only the effort differs it returns `{ effort }`. It returns `undefined` when
either string is not a valid ACP model, the agents differ, nothing differs, or a differing part's
target value is absent (the agent's own default: `acp:codex` with no model, or no `[effort]`) — ACP
has no value that means "your default", so those reopen.

The host applies the outcome: `this.handle = outcome.handle`; when the session id changed it calls
`this.hostJobs?.sessionChanged()` and sets `this.resumeNotice = outcome.notice`; then
`asks.setMode(outcome.handle.meta.mode === "full" ? "full" : "guarded")` (`SessionMeta.mode` is `"full" | "ask"`, `ChatMode` is `"full" | "guarded"`), `primeContextWindow(model)`, and rethrows `outcome.error`
when present. To keep `chat-host.ts` within its 600-line cap (593 today), a private
`openArgs()` helper builds the open arguments that `startSession`, `resumeSession` and `reopen`
each spell out today (`cwd`, `repoRoot`, `config`, `loopHandlers`, `toolProviders`,
`backgroundCommands`), and those three sites and `openFresh` use it. The TUI needs no change: a new
`sessionId` already rebuilds the transcript and appends `host.notice()` (`ChatApp.tsx`), and the
reason the switch failed reaches the user through the notice.

**Reply segments (nax).** `acpTurnMessages`' reply text becomes: the turn's `text_delta` text after
the last `stream_reset`, split into segments at each `tool_call` event, empty segments dropped, the
rest joined with a blank line (`\n\n`); `turn_end.output` only when that is empty. The ACP client
flushes its text stream at every tool event and at turn end, so the deltas hold the whole scrubbed
reply. The tool lines are unchanged: `toolLines` still lists every `tool_call` of the turn,
including those before a `stream_reset`, while the text keeps only what follows the reset.

**Replay (nax).** `replayHistory` treats an assistant message whose `acpAgentOfMessage` is defined
as `<reply text>` followed by the trailing run of lines that start with `[tool] `: the text (if
non-empty) becomes one `reply` entry; each `[tool] <name>` line becomes a `tool` entry (`name` =
the line after `[tool] ` with a trailing ` (error)` removed, `status` `"error"` when that suffix was
present else `"ok"`, `input` `{}`, no `preview`, `children` `[]`, `callId`
`history-<index>-acp-<n>` with `n` the 0-based line index in the run); a `[tool] … and <N> more`
line becomes a `notice` entry `… and <N> more tool calls`. Native assistant messages replay exactly
as today.

### Integration (extends existing code)

Read-only (verified):

- `packages/nax-agent/src/session/session-backend.ts` — `OpenedBackend` (`runCommand?`, `adapter`, `handle`, `info`, `turnOpts`, `close`).
- `packages/nax-agent/src/session/agent-session.ts` — `runCommand` refusal order (closing -> `AGENT_SESSION_CLOSED`, active -> `AGENT_SESSION_BUSY`, no backend method -> `AGENT_SESSION_CAPABILITY_UNSUPPORTED`), the `active` slot, `send`.
- `packages/nax-agent/src/native/session/transcript-types.ts` — `TranscriptDoc.turn?: TurnMarker`; `TranscriptStore.delete(sessionId)` ("Missing is not an error").
- `packages/nax-agent-acp/src/client/capabilities.ts` — `selectValues`, `modelOptionId`, `resolveModelValue`, `effortOptionId`.
- `packages/nax-agent-acp/src/client/errors.ts` — `openRequestError`, `rpcErrorOf`, `backendUnavailable`, `capabilityUnsupported`.
- `packages/nax-agent-acp/src/client/race.ts` — `race(promise, { timeoutMs, signal })`.
- `packages/nax-agent-acp/src/client/connection.ts` — `AcpLink.setConfigOption`.
- `packages/nax/src/chat/acp/acp-model.ts` — `parseChatAcpModel` -> `ChatAcpModel { agent, model?, effort? }`.
- `packages/nax/src/tui/chat/ChatApp.tsx` — session-id rebuild and `host.notice()` append.

Changed (baseline locates the code only; the target is the interface to implement):

- `AgentSession` (`agent-session-types.ts`). Baseline: no `configure`. Target: `configure?(input: SessionConfigureInput): Promise<void>`, with `export interface SessionConfigureInput { readonly model?: string; readonly effort?: string }` exported from `@nathapp/nax-agent`.
- `OpenedBackend`. Baseline: no `configure`. Target: `configure?(input: SessionConfigureInput): Promise<void>`.
- `OpenedAcp` (`open.ts`). Baseline: no config options. Target: adds `readonly configOptions: readonly SessionConfigOption[]`.
- `applyEffort` / `applyConfig` (`open.ts`). Baseline: `applyEffort` returns `Promise<void>`; `applyConfig` returns the post-model offers. Target: `applyEffort` returns `Promise<SessionOffers>` carrying the effort response's `configOptions`; `applyConfig` returns `{ offers, configOptions }` (post-model offers for `offered`, post-effort options for `configOptions`).
- `configModelIds` (`open.ts`). Baseline: private, takes `SessionOffers`. Target: exported, `configModelIds(options: readonly SessionConfigOption[]): string[]`; open's callers pass `offers.configOptions`.
- `recordAcpTurns` (`acp-recorder.ts`). Baseline: the returned session has no `configure`. Target: a `configure` getter forwarding the wrapped session's, bound, or `undefined`.
- `AcpSession` (`backend.ts`). Baseline: `readonly base`. Target: `base` mutable; adds `configOptions: readonly SessionConfigOption[]`.
- `openAcpBrain` (`open-chat-session.ts`). Baseline: resumes whenever `store.load` returns a document. Target: resumes only a document with `turn`; deletes a turn-less one and creates.
- `ChatHost.switchSession` (`chat-host.ts`). Baseline: close, reopen, rollback reopen inline. Target: delegates to `switchChatSession` and applies its outcome (host file stays within its 600-line cap; it is 593 today).
- `replyText` (`acp-history.ts`). Baseline: `turn_end.output` first, else concatenated deltas. Target: segmented deltas first, `turn_end.output` only when empty.
- `replayMessage` (`history-replay.ts`). Baseline: assistant content -> one `reply` entry. Target: ACP-origin content split into reply, tool and notice entries.

### Failure Handling

| Situation | Behaviour |
|:--|:--|
| `configure` on a closed/closing session | `AGENT_SESSION_CLOSED` |
| `configure` during a turn, command or another configure | `AGENT_SESSION_BUSY` |
| `configure({})` or an empty-string value | `AGENT_SESSION_INVALID_OPTIONS` (checked before backend support) |
| `configure` on a backend without it (native) | `AGENT_SESSION_CAPABILITY_UNSUPPORTED` |
| `close()` while a configure is pending | close proceeds; ACP configure rejects `AGENT_SESSION_CLOSED` |
| ACP: model/effort not offered by a config option | `AGENT_SESSION_CAPABILITY_UNSUPPORTED`, no request sent |
| ACP: model applied, then the effort step fails | model stays recorded for reconnect; `configure` rejects with the effort failure |
| ACP: `set_config_option` times out | `AGENT_SESSION_BACKEND_UNAVAILABLE` |
| ACP: `set_config_option` JSON-RPC error | `openRequestError("session/set_config_option", …)` |
| Host: `configure` throws | falls back to close-and-reopen |
| Host: `writeMeta` throws after `configure` succeeded | falls back to close-and-reopen |
| Host: reopen fails, rollback succeeds | handle = rolled-back session; original error rethrown |
| Host: reopen and rollback fail | old lock released; new chat session on the original target; notice; original error rethrown |
| Host: new session also fails | `NaxError` `CHAT_SESSION_REOPEN_FAILED`, `cause` = the new-session error, `context.switchError` = the original message |
| Stored ACP doc without `turn` | deleted, fresh agent session, no notice |

## Out of Scope

- Changing the guarded/full mode in place: a mode change keeps close-and-reopen.
- In-place switching for the native brain: its reopen is an in-process transcript resume.
- Switching between two ACP agents in place: a different agent is a different process.
- The legacy ACP `session/set_model` path in `configure`: only config options are used; an agent that offers its model only through the legacy block falls back to reopen.
- Refreshing `BackendInfo.capabilities.offeredModels` / `offeredEfforts` after `configure` (they stay as reported at open).
- Restoring an agent's own default model or effort in place: a switch to `acp:<agent>` with no model, or to no `[effort]`, reopens.
- A first send that fails before the agent received the prompt still leaves a `turn` marker (`markTurn(running)` is written first), so a later resume of that agent session can fail as before; the zero-turn guard covers only sessions that never started a turn.
- The recorder's `origin.model` after an in-place model change: messages keep the model the recorder was built with until the next reopen.
- Removing the old session from disk on the new-session path: it is kept so `/resume <oldId>` can retry it.
- An ACP reply whose own last lines start with `[tool] ` replays those lines as tool rows; the recorded text is not escaped.
- Recording ACP tool inputs or results in the native document, or replaying ACP tool calls with arguments.
- Changing `turn_end.output` in nax-agent-acp (`parts.join("")`); the segment fix is in nax's recorder only.
- `/model` filtering on the displayed label ("Codex · gpt-…") instead of the model id.
- Cursor's own permission behaviour in guarded mode (file edits without a nax card).

## Stories

### US-001 — `AgentSession.configure`

Workdir: packages/nax-agent. No dependencies.

Adds `SessionConfigureInput`, `OpenedBackend.configure?` and `AgentSession.configure?`, implemented on
the session class with the refusal order above and a busy guard while a configure is pending.
Exports `SessionConfigureInput` from the package entry. Verification note: `bun run check:api` passes
after `bun run api:update`.

### US-002 — the ACP backend sets model and effort on a live session

Workdir: packages/nax-agent-acp. Depends on US-001.

`configureAcpSession` in a new `src/client/session-configure.ts`; `open.ts` exports
`configModelIds`, returns the effort response from `applyEffort`/`applyConfig` and fills
`OpenedAcp.configOptions`; `AcpSession` keeps the current config options and a mutable `base`;
`assemble` adds `configure`. The in-memory fake agent gains `setConfigOptionFailure` and
`setConfigOptionHang` script knobs.

### US-003 — open a fresh ACP agent session when the stored one never ran a turn

Workdir: packages/nax. No dependencies.

`openAcpBrain` resumes only a stored agent document with a `turn` marker; a turn-less document is
deleted and a fresh agent session is created without a notice.

### US-004 — detect an in-place change and let it reach the agent session

Workdir: packages/nax. Depends on US-001.

`acpInPlaceChange` in a new `src/chat/acp/acp-switch.ts`, exported from `src/chat/acp/index.ts`;
`recordAcpTurns` forwards `configure`.

### US-005 — the switch: in place, reopen, rollback, new session

Workdir: packages/nax. Depends on US-001, US-004.

`switchChatSession`, `SwitchInput`, `SwitchOutcome` and `ROLLBACK_NEW_SESSION_NOTICE` in a new
`src/chat/session-switch.ts`; `ChatHost.switchSession` delegates to it and applies the outcome; the
host's open arguments move into a private `openArgs()` helper. Verification note: `bun run
check:file-sizes` passes with `chat-host.ts` at or under 600 lines.

### US-006 — ACP history keeps reply segments and replays tool lines as tool rows

Workdir: packages/nax. No dependencies.

`replyText` segments deltas at tool calls; `replayHistory` splits an ACP-origin assistant message
into reply, tool and notice entries. `acpAgentOfMessage` is re-exported from `src/chat/index.ts`.

### Context Files

**US-001**
- `packages/nax-agent/src/session/agent-session.ts`
- `packages/nax-agent/src/session/agent-session-types.ts`
- `packages/nax-agent/src/session/session-backend.ts`
- `packages/nax-agent/src/session/agent-session-errors.ts`
- `packages/nax-agent/test/unit/session/agent-session-run-command.test.ts`

**US-002**
- `packages/nax-agent-acp/src/client/backend.ts`
- `packages/nax-agent-acp/src/client/open.ts`
- `packages/nax-agent-acp/src/client/capabilities.ts`
- `packages/nax-agent-acp/src/client/errors.ts`
- `packages/nax-agent-acp/test/unit/client/backend-offered-choices.test.ts`

**US-003**
- `packages/nax/src/chat/open-chat-session.ts`
- `packages/nax-agent/src/native/session/transcript-types.ts`
- `packages/nax/test/unit/chat/open-chat-session-acp.test.ts`

**US-004**
- `packages/nax/src/chat/acp/acp-model.ts`
- `packages/nax/src/chat/acp/acp-recorder.ts`
- `packages/nax/test/unit/chat/acp/acp-recorder.test.ts`

**US-005**
- `packages/nax/src/chat/chat-host.ts`
- `packages/nax/src/chat/open-chat-session.ts`
- `packages/nax/test/unit/chat/chat-host-acp.test.ts`
- `packages/nax/test/unit/chat/chat-host-acp-history.test.ts`
- `packages/nax/src/chat/acp/acp-switch.ts` — created by US-004, integrated here

**US-006**
- `packages/nax/src/chat/acp/acp-history.ts`
- `packages/nax/src/tui/chat/history-replay.ts`
- `packages/nax/src/tui/chat/transcript-model.ts`
- `packages/nax/test/unit/tui/chat/history-replay.test.ts`

### Creates

**US-001**
- `packages/nax-agent/test/unit/session/agent-session-configure.test.ts`

**US-002**
- `packages/nax-agent-acp/src/client/session-configure.ts`
- `packages/nax-agent-acp/test/unit/client/backend-configure.test.ts`

**US-003**
- `packages/nax/test/unit/chat/open-chat-session-acp-zero-turn.test.ts`

**US-004**
- `packages/nax/src/chat/acp/acp-switch.ts`
- `packages/nax/test/unit/chat/acp/acp-switch.test.ts`

**US-005**
- `packages/nax/src/chat/session-switch.ts`
- `packages/nax/test/unit/chat/session-switch.test.ts`
- `packages/nax/test/unit/chat/chat-host-acp-switch.test.ts`

**US-006**
- `packages/nax/test/unit/tui/chat/history-replay-acp.test.ts`

### Modifies

**US-001**
- `packages/nax-agent/src/session/agent-session-types.ts` — adds `SessionConfigureInput` and the optional `AgentSession.configure`.
- `packages/nax-agent/src/session/session-backend.ts` — adds the optional `OpenedBackend.configure`.
- `packages/nax-agent/src/session/agent-session.ts` — implements `configure` and makes `send` and `runCommand` refuse `AGENT_SESSION_BUSY` while a configure is pending.
- `packages/nax-agent/src/index.ts` — exports the `SessionConfigureInput` type beside `AgentSession`.
- `packages/nax-agent/api/nax-agent.api.txt` — regenerated by `bun run api:update` for the new type.

**US-002**
- `packages/nax-agent-acp/src/client/open.ts` — exports `configModelIds` taking `readonly SessionConfigOption[]`; `applyEffort` returns the offers carrying the effort response; `applyConfig` returns `{ offers, configOptions }` with `offers` the post-model offers (so `OpenedAcp.offered` is unchanged) and `configOptions` the post-effort ones; `OpenedAcp` gains `configOptions`.
- `packages/nax-agent-acp/src/client/backend.ts` — `AcpSession.base` becomes mutable, `AcpSession` gains `configOptions` (set at open and at each reconnect from `live.acp.configOptions`), and `assemble` adds `configure` calling `configureAcpSession`.
- `packages/nax-agent-acp/test/fixtures/fake-agent/script.ts` — adds optional `setConfigOptionFailure` (a JSON-RPC error answered to every set-config-option request) and `setConfigOptionHang` (never answers), beside the existing `setModeFailure`; existing scripts are unaffected because both default to absent.
- `packages/nax-agent-acp/test/fixtures/fake-agent/agent.ts` — the set-config-option request handler honours `setConfigOptionFailure` and `setConfigOptionHang` after recording the request, like the `setModeFailure` handling of the set-mode request.
- `packages/nax-agent-acp/api/nax-agent-acp.api.txt` — regenerated by `bun run api:update` only if the public surface changes.

**US-003**
- `packages/nax/src/chat/open-chat-session.ts` — `openAcpBrain` resumes only a stored agent document with `turn`, deletes a turn-less one and creates.
- `packages/nax/test/unit/chat/open-chat-session-acp.test.ts` — the seeded agent documents in `resumeFailing`, `AC-6 resumes the agent document with the session id and the agent store` and the history test that seeds `agent-only` gain `turn: { turnId: "t1", state: "ended" }`, because only a document that ran a turn is resumed now; their expectations are unchanged.
- `packages/nax/test/unit/chat/open-chat-session-acp-history.test.ts` — `seedAgentDoc` saves `turn: { turnId: "t1", state: "ended" }` with the document, because its callers expect the stored agent session to be resumed (or its resume to fail) and a turn-less document is now deleted instead; their expectations are unchanged.

**US-004**
- `packages/nax/src/chat/acp/acp-recorder.ts` — the session `recordAcpTurns` returns gains a `configure` getter forwarding the wrapped session's `configure` bound to it, `undefined` when it has none.
- `packages/nax/src/chat/acp/index.ts` — re-exports `acpInPlaceChange`.
- `packages/nax/test/unit/chat/acp/acp-recorder.test.ts` — adds the `configure` forwarding cases beside the existing `runCommand` forwarding cases; existing cases are unchanged.

**US-005**
- `packages/nax/src/chat/chat-host.ts` — `switchSession` delegates to `switchChatSession` and applies its outcome (handle, `sessionChanged`, `resumeNotice`, mode, context window, rethrow); the inline close/reopen/rollback body is removed; a private `openArgs()` replaces the open-argument blocks repeated in `startSession`, `resumeSession` and `reopen`.

**US-006**
- `packages/nax/src/chat/acp/acp-history.ts` — `replyText` builds the reply from delta segments split at tool calls and uses `turn_end.output` only when that is empty.
- `packages/nax/src/tui/chat/history-replay.ts` — `replayMessage` splits ACP-origin assistant content into reply, tool and notice entries.
- `packages/nax/src/chat/index.ts` — re-exports `acpAgentOfMessage` from the chat ACP barrel.
- `packages/nax/test/unit/chat/acp/acp-history.test.ts` — `prefers the turn_end output over the deltas` expects `"Hello world"` from `[textDelta("x"), turnEnd("Hello world")]`; replace it with a test that the deltas win (`"x"`) and that `turn_end.output` is used only when the deltas hold no text, because the reply is now built from segmented deltas.

### Seams

- US-005 consumes `acpInPlaceChange` (US-004) and `AgentSession.configure` (US-001) through the `recordAcpTurns` wrapper (US-004). Entry point: `createChatHost(...).switchTo({ model })` on a host built over the real `openChatSession` (as `chat-host-acp-history.test.ts` builds one) with `_openChatSessionDeps.createAgentSession` returning a stub agent session that has `configure`, and an `acp` catalog stub whose `effortLevels` returns `["default", "high"]` (without one the host clamps `[high]` to the default and the switch is a no-op). US-005 AC-12 asserts the stub's `configure` was called with `{ effort: "high" }`, so the call crosses the real wrapper; AC-13 asserts no second open.
- US-004 AC-11 drives `recordAcpTurns(session, …).configure` and asserts the wrapped session's `configure` received the input.
- US-002 implements US-001's `OpenedBackend.configure`; US-002 AC-1 drives it through `createAgentSession({ backend: acpBackend(...) }).configure(...)`, the public path, against the in-memory fake agent.

## Acceptance Criteria

### US-001

1. [unit] A session whose opened backend has `configure`: `session.configure({ effort: "high" })` resolves and the backend's `configure` was called once with `{ effort: "high" }`.
2. [unit] `session.configure({ model: "m2", effort: "low" })` passes `{ model: "m2", effort: "low" }` to the backend's `configure` unchanged.
3. [unit] A session whose opened backend has no `configure`: `session.configure({ effort: "high" })` rejects with `AgentSessionError` code `AGENT_SESSION_CAPABILITY_UNSUPPORTED` and context `capability` `"configure"`.
4. [unit] `session.configure({})` rejects with code `AGENT_SESSION_INVALID_OPTIONS` and the backend's `configure` is not called.
5. [unit] `session.configure({ model: "" })` rejects with code `AGENT_SESSION_INVALID_OPTIONS`.
6. [unit] `session.configure({})` on a session whose backend has no `configure` rejects with `AGENT_SESSION_INVALID_OPTIONS` (input is checked before backend support).
7. [unit] After `session.close()` resolved, `session.configure({ effort: "high" })` rejects with code `AGENT_SESSION_CLOSED`.
8. [unit] While a `send` turn is in flight, `session.configure({ effort: "high" })` rejects with code `AGENT_SESSION_BUSY` and the backend's `configure` is not called.
9. [unit] While the backend's `configure` promise is pending, `session.send("hi")` throws code `AGENT_SESSION_BUSY`.
10. [unit] While the backend's `configure` promise is pending, a second `session.configure({ effort: "low" })` rejects with code `AGENT_SESSION_BUSY`.
11. [unit] While the backend's `configure` promise is pending, `session.runCommand("ls", onEvent)` on a backend with `runCommand` rejects with code `AGENT_SESSION_BUSY`.
12. [unit] When the backend's `configure` rejects with an `AgentSessionError` code `AGENT_SESSION_BACKEND_UNAVAILABLE`, `session.configure` rejects with that same error object.
13. [unit] After the backend's `configure` rejected, `session.send("hi")` starts a turn (the busy guard is released on failure).
14. [unit] After the backend's `configure` resolved, `session.send("hi")` starts a turn.
15. [unit] `session.close()` called while the backend's `configure` promise is pending resolves, and the session is closed afterwards (`send` throws `AGENT_SESSION_CLOSED`).
16. [unit] `SessionConfigureInput` is importable as a type from `@nathapp/nax-agent` and an object `{ model: "m", effort: "e" }` satisfies it.

### US-002

1. [integration] Against the in-memory fake ACP agent offering a `model` config option with values `a` and `b`, `createAgentSession({ backend: acpBackend(...) })` then `session.configure({ model: "b" })` sends `session/set_config_option` with `configId` the model option's id and `value` `"b"` for the session's agent session id.
2. [integration] `session.configure({ effort: "high" })` on an agent offering a `thought_level` option with `high` sends `session/set_config_option` with that option's id and `value` `"high"`.
3. [integration] `session.configure({ model: "b", effort: "high" })` sends the model request first and resolves the effort option from the `configOptions` the model response returned: with a fake whose initial `thought_level` option lacks `high` and whose `setConfigOptionsAnswer` adds it, the effort request is still sent.
4. [integration] For Codex (no `thought_level` category), `configure({ effort: "high" })` sets the option with id `reasoning_effort` when it offers `high`.
5. [integration] For Cursor offering `gpt-5.5[context=272k]`, `configure({ model: "gpt-5.5" })` sends `value` `"gpt-5.5[context=272k]"` (resolved by `resolveModelValue`).
6. [integration] `configure({ model: "zzz" })` with no model option offering `zzz` rejects with code `AGENT_SESSION_CAPABILITY_UNSUPPORTED` and context `capability` `"model"`, and no `session/set_config_option` request is recorded.
7. [integration] `configure({ effort: "max" })` with no option offering `max` rejects with code `AGENT_SESSION_CAPABILITY_UNSUPPORTED` and context `capability` `"effort"`, and no request is recorded.
8. [integration] On Codex with `profile: "full"` and no model or effort at open (so open sends no `session/set_config_option`), with the fake's `setConfigOptionHang` set and `initializeTimeoutMs` 50, `configure({ model: "b" })` rejects with code `AGENT_SESSION_BACKEND_UNAVAILABLE`.
9. [integration] On Codex with `profile: "full"` and no model or effort at open, with the fake's `setConfigOptionFailure` set to a JSON-RPC internal error (-32603), `configure({ model: "b" })` rejects with code `AGENT_SESSION_BACKEND_UNAVAILABLE` and context `step` `"session/set_config_option"`.
10. [integration] On Codex with `profile: "full"` and no model or effort at open and `setConfigOptionHang` set, `session.close()` while `configure({ model: "b" })` is pending makes that configure reject with code `AGENT_SESSION_CLOSED`.
11. [integration] After `configure({ model: "b" })` resolved and the agent process exited, the next `send` reconnects and the reconnect's open sends `session/set_config_option` setting the model option to `"b"`.
12. [integration] After `configure({ effort: "high" })` resolved and the agent process exited, the reconnect's open sets the effort option to `"high"`.
13. [integration] After `configure({ model: "b" })` resolved, `send("hi")` runs a turn on the same agent process (one launch in total).
14. [integration] When the agent process has exited before `configure` is called, `configure({ model: "b" })` reconnects once and sends the request on the new process.
15. [integration] After an open that set an effort, a following `configure({ model: "b" })` resolves the model from the config options the open's effort response returned (`OpenedAcp.configOptions` holds the last open response, not the post-model one).
16. [integration] `configure({ model: "b", effort: "max" })` on an agent offering model `b` but no `max` effort sends the model request, then rejects with code `AGENT_SESSION_CAPABILITY_UNSUPPORTED` (context `capability` `"effort"`); after the agent process exits, the reconnect's open sets the model option to `"b"`.
17. [unit] `configModelIds(options)` returns the values of every `model`-category select option in offer order and ignores options of other categories.

### US-003

1. [unit] `openChatSession` resuming a chat on `acp:codex` whose agent store holds a document without `turn` calls the agent store's `delete` with the session id and then `createAgentSession`, and never calls `resumeAgentSession`.
2. [unit] In that case the returned handle has no `notice`.
3. [unit] In that case the agent store's `retainFailed` is not called.
4. [unit] In that case the agent session receives the whole native history as its handoff (it is treated as fresh): its first `send` is prefixed with the `<conversation-so-far>` handoff of every native message.
5. [unit] A stored agent document with `turn: { turnId: "t1", state: "ended" }` is resumed with `resumeAgentSession(sessionId, options)` and `delete` is not called.
6. [unit] A stored agent document with `turn: { turnId: "t1", state: "running" }` (an interrupted turn) is resumed, not deleted.
7. [unit] With no stored agent document, `createAgentSession` is called and `delete` is not called.
8. [unit] The native brain's open is unchanged: a native session whose transcript document has no `turn` is resumed with `resumeAgentSession`.

### US-004

1. [unit] `acpInPlaceChange("acp:codex/gpt-5.5", "acp:codex/gpt-5.5[high]")` returns `{ effort: "high" }`.
2. [unit] `acpInPlaceChange("acp:codex/gpt-5.5", "acp:codex/gpt-6-luna")` returns `{ model: "gpt-6-luna" }`.
3. [unit] `acpInPlaceChange("acp:codex/gpt-5.5[low]", "acp:codex/gpt-6-luna[high]")` returns `{ model: "gpt-6-luna", effort: "high" }`.
4. [unit] `acpInPlaceChange("acp:codex/gpt-5.5[high]", "acp:codex/gpt-6[high]")` returns `{ model: "gpt-6", effort: "high" }` (a model change carries the target's effort).
5. [unit] `acpInPlaceChange("acp:codex/gpt-5.5[high]", "acp:codex/gpt-5.5")` returns `undefined` (the target effort is the agent default).
6. [unit] `acpInPlaceChange("acp:codex/gpt-5.5", "acp:codex")` returns `undefined` (the target model is the agent default).
7. [unit] `acpInPlaceChange("acp:claude", "acp:codex/gpt-5.5")` returns `undefined` (different agents).
8. [unit] `acpInPlaceChange("openai/gpt-6", "acp:codex/gpt-5.5")` and `acpInPlaceChange("acp:codex/gpt-5.5", "openai/gpt-6")` both return `undefined`.
9. [unit] `acpInPlaceChange("acp:codex/gpt-5.5", "acp:codex/gpt-5.5")` returns `undefined`.
10. [unit] `acpInPlaceChange("acp:gemini/x", "acp:codex/gpt-5.5")` returns `undefined` instead of throwing (a malformed ACP string counts as not ACP).
11. [unit] `recordAcpTurns(session, …).configure({ effort: "high" })` on a wrapped session with `configure` calls the wrapped session's `configure` once with `{ effort: "high" }`, with `this` the wrapped session.
12. [unit] `recordAcpTurns(session, …).configure` is `undefined` when the wrapped session has no `configure`.

### US-005

1. [unit] `switchChatSession` with an in-place change and a `configure` that resolves calls `writeMeta` once with the previous meta and `model` set to the target, never closes the previous session, never calls `reopen`, and returns a handle whose `session` is the previous session and whose `meta.model` is the target.
2. [unit] `switchChatSession` whose `configure` rejects with `AGENT_SESSION_CAPABILITY_UNSUPPORTED` closes the previous session, calls `reopen(target)`, and returns `{ handle: <reopened> }` with no `error`.
3. [unit] `switchChatSession` whose `configure` resolves but whose first `writeMeta` rejects closes the previous session, calls `reopen(target)`, and returns the reopened handle.
4. [unit] `switchChatSession` with a mode change (`target.mode !== from.mode`) never calls `configure` and takes the close-and-reopen path.
5. [unit] `switchChatSession` whose previous session has no `configure` takes the close-and-reopen path.
6. [unit] `switchChatSession` whose `reopen(target)` rejects with error E and whose `reopen(from)` resolves returns `{ handle: <rolled back>, error: E }` and no `notice`.
7. [unit] `switchChatSession` whose `reopen(target)` rejects with E and whose `reopen(from)` also rejects calls `previous.release()` with no `retainLock`, then `openFresh(from)`, and returns `{ handle: <fresh>, error: E, notice: ROLLBACK_NEW_SESSION_NOTICE(<old session id>, <first line of E's message>) }`.
8. [unit] `ROLLBACK_NEW_SESSION_NOTICE("abc", "agent gone")` equals `could not reopen session abc after the failed switch (agent gone); started a new session (/resume abc retries it)`.
9. [unit] When `reopen(target)`, `reopen(from)` and `openFresh(from)` all reject, `switchChatSession` rejects with a `NaxError` code `CHAT_SESSION_REOPEN_FAILED` whose `cause` is `openFresh`'s error.
10. [unit] That `CHAT_SESSION_REOPEN_FAILED` error's context has `stage` `"chat"`, `sessionId` the old session id, and `switchError` the message of E.
11. [unit] On the close-and-reopen path `switchChatSession` calls `previous.release({ retainLock: true })` after closing the previous session and before `reopen(target)`.
12. [integration] A host built over the real `openChatSession` on `acp:codex/gpt-5.5` (stub agent session with `configure` from `_openChatSessionDeps.createAgentSession`, and an `acp` catalog stub whose `effortLevels` returns `["default", "high"]`): `switchTo({ model: "acp:codex/gpt-5.5[high]" })` calls the stub's `configure` once with `{ effort: "high" }`, and `host.current().model` is `acp:codex/gpt-5.5[high]`.
13. [integration] In that switch `createAgentSession` and `resumeAgentSession` are not called again after the initial open, and the stored meta read back from the session storage has model `acp:codex/gpt-5.5[high]`.
14. [integration] A host over the real `openChatSession` whose `_openChatSessionDeps.createAgentSession` resolves on call 1, rejects on calls 2 and 3 (switch reopen and rollback reopen) and resolves on call 4, and whose `randomUUID` returns a new id on its later calls: `switchTo` rejects with the switch error, then `host.current().sessionId` differs from the old id, `host.notice()` is `ROLLBACK_NEW_SESSION_NOTICE(<old id>, <first line of the call-2 error>)`, and `host.send("hi", onEvent)` runs a turn without throwing `AGENT_SESSION_CLOSED`.
15. [integration] A host whose switch reopen fails and rollback succeeds: `switchTo` rejects with the switch error and `host.current()` reports the original model and session id.

### US-006

1. [unit] `acpTurnMessages` for events `[textDelta("Creating."), toolCall("c1", "Edit"), textDelta("Created."), turnEnd("Creating.Created.")]` records assistant content `Creating.\n\nCreated.\n[tool] Edit`.
2. [unit] Deltas `[textDelta("Hel"), textDelta("lo"), turnEnd("Hello")]` with no tool call record `Hello`.
3. [unit] A tool call before any text (`[toolCall("c1", "Read"), textDelta("done"), turnEnd("done")]`) records `done\n[tool] Read` (no leading blank line).
4. [unit] Two consecutive tool calls between two texts record the two texts separated by exactly one blank line.
5. [unit] A turn with no text deltas and `turn_end.output` `"Hi"` records `Hi`.
6. [unit] Text before a `stream_reset` is discarded while its tool call is still listed: `[textDelta("a"), toolCall("c1", "X"), reset, textDelta("b"), turnEnd("")]` records `b\n[tool] X`.
7. [unit] `replayHistory` of an assistant message `{ role: "assistant", content: "Done.\n[tool] Read\n[tool] Edit", origin: { provider: "acp:cursor", model: "default" } }` returns a `reply` entry with text `Done.` followed by two `tool` entries named `Read` and `Edit` with status `"ok"`.
8. [unit] A replayed ACP line `[tool] Edit (error)` becomes a `tool` entry named `Edit` with status `"error"`.
9. [unit] A replayed ACP line `[tool] … and 3 more` becomes a `notice` entry with text `… and 3 more tool calls`.
10. [unit] Replayed ACP tool entries carry `input` `{}`, no `preview`, `children` `[]`, and `callId` `history-<message index>-acp-<n>` (for the message at index 1: `history-1-acp-0`, `history-1-acp-1`).
11. [unit] An ACP-origin assistant message with only tool lines (`[tool] Read`) replays no `reply` entry and one `tool` entry.
12. [unit] An ACP-origin assistant message `Use [tool] syntax here.\n[tool] Read` replays a `reply` with `Use [tool] syntax here.` and one `tool` entry (only the trailing run of `[tool] ` lines is parsed).
13. [unit] A native assistant message (no `origin`) whose content is `x\n[tool] Read` replays as one `reply` entry with that exact text and no `tool` entry.
14. [unit] `acpAgentOfMessage` is importable from `@/chat` and returns `"cursor"` for an assistant message with origin provider `acp:cursor`.
