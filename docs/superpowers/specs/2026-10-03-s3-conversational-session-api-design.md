# S3 — Conversational session API for `nax-agent` (design)

- **Arc:** nax-agent. This is sub-project S3 of 7 (S0-S6).
- **Arc SSOT:** the nax-agent master plan, kept in the maintainer's workspace (not in this repo). It holds the arc decisions and all status. This spec holds S3's design only.
- **Date:** 2026-10-03, from the S3 brainstorm. Revised the same day after a final review: two read-only reviewers checked it against the codebase (accuracy, nax impact) and probed the risky parts (streaming fold, iterator semantics, credentials, approvals).
- **Base:** `main` @ `55e9f3e26` (S2 complete; `@nathapp/nax-agent@0.1.0` published).
- **Inputs:** file and line references were read on the base commit. Paths are relative to `packages/`.

## 1. Goal

Give an embedder (a long-running Node service, for example a NestJS API) a conversational session API on top of
nax-agent: multi-turn chat with a person in the loop, streamed events, embedder-supplied tools, an embedder-supplied
transcript store, cancellation and an approval hook. The native loop is the first backend; the acpx backend (S4)
implements the same S1 adapter contract and needs no change to this API.

**Done means:**
- A packed `@nathapp/nax-agent` under Node 22 and 24 runs a multi-turn native chat with streamed token deltas, one
  embedder tool approved through `answer()`, one approval denied by timeout, one cancel and one resume from a store.
- Many sessions run in one process with different credentials sources and catalog overrides, including with no
  `configureCredentials` call at all.
- `nax run` behaves as before. The one deliberate internal change (streaming model calls, §5.3) passes the S1-recipe
  acceptance smoke.

**Out of scope:**
- The acpx backend (S4) and the ACP-server wrapper (S5).
- Moving nax's own story sessions onto this API. nax keeps calling the S1 adapter; moving it later is an unscheduled
  follow-up, and this design must not foreclose it (§3).
- An MCP client for embedder tools (a reserved, rejected `mcpServers` option, §4.1).
- A durable suspend of a turn waiting on an approval (§6.4).
- Remembered approvals (`allow-remember`) inside the facade (§6.1).
- Making the runtime slot (`nax-agent/src/runtime/slot.ts:4-10`), the logger slot, the built-in tool registry or the
  sandbox registry per-session. They stay process-wide: spawn/glob, logging and built-in tools have no per-session
  variation; embedder tools go through `extraTools` (§4.3). This settles the open note in `runtime/slot.ts`.

## 2. Rulings (from the S3 brainstorm, 2026-10-03)

| # | Ruling |
|---|---|
| R1 | **Original arc design stands:** the embedder imports the library in-process; one session contract, backends native and acpx; the ACP-server wrapper (S5) is a separate entry for other ACP clients. |
| R2 | **Workspace = per-session tool profile** `none` \| `read` \| `full`, stated backend-neutrally. S3 builds and tests `none` and `read`; `full` uses the same mechanism behind the security floor (§6.3). The acpx backend honours the same profile (S4). |
| R3 | **Layer on top:** S3 is a facade over the S1 `AgentSessionAdapter`; nax keeps the S1 contract. Moving nax onto S3 later stays possible. |
| R4 | **The embedder owns history** through an injected `TranscriptStore`; file and memory stores ship; `resumeAgentSession` rebuilds context after a restart; the document schema is versioned and public. |
| R5 | **Approvals are an in-memory wait with a per-session timeout.** `approvalTimeoutMs` (default 600000, range 30000..3600000, the same as nax's `execution.approvalTimeout`) and `bashApproval` are session options; nax-agent enforces the timeout; timeout = deny. A restart mid-wait ends the turn as `interrupted`. |
| R6 | **Embedder tools: in-process functions now; an MCP client later.** Each tool declares `approval: "never" \| "always"`. |
| R7 | **Real token streaming in S3**, for nax and the facade alike: native model calls stream. |
| R8 | **Per-session client.** Sessions may pass `catalogOverrides` and a `credentials` source (memory or exec) that falls back to the `configureCredentials` slot. |
| R9 | **Approach 1:** a session facade over the S1 adapter; `send()` returns an async iterable of events; approvals and questions are answered with `session.answer()`. |

## 3. Architecture

```
embedder ──► createAgentSession / resumeAgentSession      (session/agent-session.ts, new)
                 │  composes: InteractionHandler (embedder tools, coding tools, questions), ask link,
                 │            TranscriptStore, tool policy from profile, host-port defaults, event channel
                 ▼
             AgentSessionAdapter (S1 contract; nax-visible behaviour unchanged)
                 ├── NativeSessionAdapter   (per-instance session state, optional own client, streaming)
                 └── AcpAgentAdapter        (S4)
nax ─────────────────► AgentSessionAdapter directly (unchanged)
```

The facade knows no backend internals. Everything it needs from a backend arrives through new optional fields on the
S1 contract (`SendTurnOpts.onTurnEvent`, `OpenSessionOpts.transcriptStore`, `OpenSessionOpts.retainOnClose`,
`NativeSessionAdapter` constructor options), which nax does not set. That keeps the later move of nax onto the facade a
pure caller change.

## 4. Public API

### 4.1 Creating a session

```ts
const session = await createAgentSession({
  backend: "native",                       // "acpx" in S4, same options
  sessionId?: string,                      // generated when absent; the store key
  model: string,                           // "provider/model[effort]", parsed by parseModelSpec
  profile: "none" | "read" | "full",
  workdir?: string,                        // required for read and full
  instructions?: string,                   // embedder system prompt
  tools?: EmbedderTool[],
  transcriptStore: TranscriptStore,
  approvalTimeoutMs?: number,              // default 600000, 30000..3600000
  bashApproval?: "raw" | "gated" | "escalate",   // full only; default "gated"
  allowUnsandboxed?: boolean,              // full only, see §6.3
  credentials?: CredentialSource,          // falls back to the configureCredentials slot
  catalogOverrides?: NativeCatalogOverrides,
  loopHandlers?: LoopHandlerSet,           // P6 handler registration, now public
  hostPorts?: {
    runDeclaredCommand?: DeclaredCommandRunner,
    protectedPaths?: ProtectedPathsPolicy,
    commandInterceptor?: CommandInterceptor,
  },
  metadata?: Record<string, string>,       // passed through on every event
  turnTimeoutSeconds?: number,             // per-turn wall clock; default 3600, see §6.1
  // reserved, rejected if set in S3: mcpServers
});
```

- Options are validated with zod; a bad option throws `AGENT_SESSION_INVALID_OPTIONS`.
- `createAgentSession` with a `sessionId` whose document already exists throws `AGENT_SESSION_EXISTS` (it never wipes
  history; S1's `openSession` deletes the transcript unless `resume: true`, `native/session/session.ts:169`).
- The facade fills the S1 `OpenSessionOpts` required fields itself: `agentName: "native"`, `resolvedPermissions`
  (derived from the profile), `modelDef` (from `model` and the catalog), `timeoutSeconds` (from
  `turnTimeoutSeconds`). It sets `SendTurnOpts.maxInteractions` above zero so `ask_human` is advertised
  (`native/session/turn-loop.ts:145-155`).
- `loopHandlers`: the loop-event and handler types (`LoopHandlerSet`, `LoopHandlerContext`, `LoopEventMap`, ...) move
  from `/internal` to `.` (they are already referenced by the public `SendTurnOpts`). The facade fills
  `LoopHandlerContext` with `sessionName`, `workdir`, `model` and `provider`; the nax-shaped fields (`storyId`,
  `feature`, `role`) stay optional and unset.
- **As built (S3-4):** `instructions` is sent as the request's top-level `system` through a new optional
  `OpenSessionOpts.systemPrompt` (nax-ai's `ConversationMessage` has no system role). `workdir` is optional for `none`;
  the facade then uses a private temporary root, removed on `close()`. `bashApproval` and `allowUnsandboxed` are rejected
  outside `full`, and `allowUnsandboxed` requires `bashApproval: "gated"`. `hostPorts.runDeclaredCommand` is deferred
  (RunCommand needs a declared-command catalogue); `lastTurn` is `{...} | undefined` rather than optional.

### 4.2 The session object

```ts
interface AgentSession {
  readonly id: string;
  readonly lastTurn?: { turnId: string; status: TurnEndStatus };  // set after each turn_end and on resume
  send(message: string): AsyncIterable<SessionEvent>;
  answer(requestId: string, reply: { decision: "allow" | "deny" } | { text: string }):
    "accepted" | "expired" | "cancelled" | "unknown";
  cancel(reason?: string): void;
  close(): Promise<void>;
}
function resumeAgentSession(sessionId: string, options: CreateAgentSessionOptions): Promise<AgentSession>;
```

**`send`:**
- Claims the single-flight slot synchronously; a second `send` while a turn is claimed throws `AGENT_SESSION_BUSY`;
  after `close` it throws `AGENT_SESSION_CLOSED`.
- The returned iterable is single-use. The turn starts on the first `next()`. A claimed but never-iterated turn is
  released by `cancel()` or `close()`.
- Breaking out of the iteration (the iterator's `return()`) means `cancel("iterator closed")`. Pending asks resolve as
  deny with `decidedBy: "cancelled"`; the turn drains, saves and is marked ended. The session stays busy until that
  settles. A turn never runs on unseen.

**`answer`:** returns `"accepted"`, or `"expired"` / `"cancelled"` for an id settled earlier in the current or last
turn (the click that lands at the deadline is an expected race, not an error), or `"unknown"` after `close()`. It
throws `AGENT_SESSION_INVALID_ANSWER` only for an id never issued by this session, or for a kind mismatch (a decision
sent to a question, or text sent to an approval).

**`cancel`:** aborts the running turn (`turn_end.status: "cancelled"`); a no-op when no turn runs.

**`close`:** idempotent; concurrent calls share one promise. It cancels a running turn, awaits its settlement (the
open iterator receives `turn_end(cancelled)`), keeps the document in the store and marks the session closed.

**`resumeAgentSession`:**
- A missing document throws `AGENT_SESSION_NOT_FOUND`; an unknown `schemaVersion` throws
  `AGENT_SESSION_SCHEMA_UNSUPPORTED`.
- A document whose recorded `model` differs from `options.model` throws `AGENT_SESSION_MODEL_MISMATCH`. Today's loop
  silently reads such a transcript as an empty conversation (`isForeignTranscript`,
  `native/session/transcript-store.ts:124-143`); the facade makes it explicit.
- Opens the S1 session with `resume: true`.

### 4.3 Embedder tools

```ts
interface EmbedderTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  approval: "never" | "always";
  describe?(input: unknown): string;      // the approval summary; default: redacted, capped JSON of input
  run(input: unknown, ctx: { sessionId: string; toolCallId: string; signal: AbortSignal }):
    Promise<{ content: string; isError?: boolean }>;
}
```

- **As built (S3-4):** the facade appends a descriptor-only `CodingTool` per embedder tool to `SendTurnOpts.codingTools`
  and runs the embedder's `run` from its own `InteractionHandler`, which receives the `toolCallId` and the turn signal on
  the `coding-tool` request. It does not use the runtime's `extraTools`, which would let a name shadow a built-in. A
  failed embedder tool (`isError: true` or a throw) is reported by throwing from the handler; the tool batch records the
  message as an `isError` result. The model sees the tool's own `name`. (The `ProviderTool` route,
  `tools/provider-adapt.ts`, namespaces names as `<providerId>__<localName>` and is not used here.)
- A name that collides with a built-in or reserved name throws `AGENT_SESSION_TOOL_NAME_RESERVED` at creation (same
  reserved list as `registerCodingTool`, `tools/registry.ts:124-148`).
- `approval: "always"`: the facade's wrapper around `run` calls the session ask link itself before running, with
  `summary = describe(input)` (or the redacted, capped JSON) and the `toolCallId`. The policy's grant-only path would
  otherwise allow the call with no ask, and `askSummary` (`tools/ask-request.ts`) builds text only from `ToolScope`
  fields, so a person would approve a call they cannot see.
- `ctx.sessionId` and `ctx.toolCallId` come from the facade (`ToolRunContext` carries neither,
  `tools/registry.ts:63-103`; the call id reaches the facade's `InteractionHandler` on the `coding-tool` request).
- A tool that throws becomes a tool result with `isError: true`.

### 4.4 Events

`SessionEvent` is a discriminated union on `type`. Every event carries `sessionId`, `turnId`, `at` (ISO time) and
`metadata`. Events inside one model call carry `round` (the loop's round-trip index).

| `type` | Payload |
|---|---|
| `turn_start` | — |
| `text_delta` | `round`, `text` |
| `thinking_delta` | `round`, `text` |
| `stream_reset` | `round`, `attempt` — the deltas of this round so far are void (a retry) |
| `tool_call` | `callId`, `name`, `input` (redacted) |
| `tool_result` | `callId`, `isError`, `preview` (byte-capped, redacted) |
| `approval_requested` | `requestId`, `callId?`, `tool`, `summary`, `command?`, `reason`, `expiresAt` |
| `approval_resolved` | `requestId`, `decision`, `decidedBy` (`human` \| `timeout` \| `cancelled` \| `unavailable` \| `unshowable`) |
| `question` | `requestId`, `text`, `expiresAt` |
| `usage` | `round`, `inputTokens`, `outputTokens`, `cacheRead?`, `cacheWrite?`, `costUsd` — one per model call; marks the round's end |
| `compaction` | `reason` |
| `turn_end` | `status`: `completed` \| `cancelled` \| `timed_out` \| `interrupted` \| `errored`; `output`; `usage`; `costUsd`; `error?` `{code, message}` |

- `turn_end` is always the last event of a `send`; the iterator then completes. Turn failures arrive as `turn_end`,
  never as a throw from the iterator.
- **Deltas are provisional.** `after_response` handlers may patch the recorded text, so the transcript and
  `turn_end.output` are authoritative. `turn_end.output` is the final round's text, as `TurnResult.output` is today.
- **Delivery:** the loop pushes; the facade's channel buffers between the loop and a slow consumer. While the consumer
  lags, adjacent `text_delta` / `thinking_delta` events of the same round are coalesced. Control events (everything
  else) are never dropped or merged. If undelivered control events exceed a hard cap (1000), the turn is cancelled and
  ends `errored` with code `AGENT_SESSION_CONSUMER_STALLED`.
- `tool_call.input` and `tool_result.preview` are taken after `before_tool` / `after_tool` shaping, so truncation and
  spill apply.

### 4.5 Profiles

| Profile | Tools advertised |
|---|---|
| `none` | embedder tools, the scratchpad trio |
| `read` | + Read, Glob, Grep, read-only Git |
| `full` | + Write, Edit, Delete, Bash, under the sandbox and `bashApproval`; RunCommand only with `hostPorts.runDeclaredCommand`; GitCommit only with `hostPorts.protectedPaths` (§6.2) |

Profiles are capability statements, not tool-name lists, so S4 can map them to ACP client capabilities.

### 4.6 Stage labels

Facade events carry no nax pipeline `stage`. Embedders tag sessions through `metadata`. The stage narrowing in nax's
stream bus (unknown labels dropped) stays nax-only, so embedders cannot hit that trap.

## 5. Components and backend changes

### 5.1 The facade (`session/agent-session.ts`)

Owns the single-flight guard, the event channel behind `send()`'s iterator, the pending-ask table with deadline
timers, and the per-session `InteractionHandler`. That handler has two branches: `coding-tool` requests go to the
session's `CodingToolRuntime.callTool` (built by `buildCodingToolSupport` with the facade's policy, ask resolver and
host ports); `question` requests go to the pending-ask table (§6.1). There is no `context-tool` branch: the facade has
no context engine, and `contextPullTools` stays unset. nax's `buildRunInteractionHandler`
(`nax/src/agents/run-interaction-handler.ts`) stays in nax.

The facade creates one `NativeSessionAdapter` per session. Facade clients are cached per process by canonical
overrides key plus credentials-source identity (`canonicalOverrideKey` exists in `native/client.ts`), because a client
build loads the catalog (about 50 ms and 650 KB, `native/client.ts:197-199`).

### 5.2 Per-session native state

**State.** These ten module-scope collections in `native/session/session.ts:31-128` move into the
`NativeSessionAdapter` instance: `nativeTranscriptDirs`, `nativeSessionScratchpadRoots`, `nativeSessionTimeouts`,
`nativeSessionStreamHooks`, `nativeSessionFailed`, `nativeSessionTranscriptOwners`, `nativeSessionCompaction`,
`nativeSessionTransportRetry`, `nativeSessionSpinBreaker`, `nativeSessionLastUsage`.

- In-package readers that must take the state explicitly: `session-adapter.ts`, `native/session/turn-loop.ts`
  (`:30,73,85,111`), `native/session/turn-loop-round-trip.ts` (`:47,218`), `native/session/truncation-handler.ts`
  (`spillRootFor`, `:27,35,68`, reached from `registerBuiltinLoopHandlers`) and `sessionAnchorFor`
  (`session.ts:137`). The state is threaded through `TurnDeps` and `createTruncationHandler`.
- `packages/nax/src` reads none of these maps. About 14 nax test files and the nax-agent tests import them from
  `/internal` (for example `native-truncation-chokepoint.test.ts`). Those tests change in the same PR. The maps are in
  the `[./internal]` section of `api/nax-agent.api.txt` (not semver-covered), so they are replaced by an instance
  state object, not kept.
- **Invariant:** a session is opened, used and closed through one adapter instance. Today the module-scope maps let
  any instance close a session another opened. nax builds one `NativeAgentAdapter` per `createAgentRegistry`
  (`nax/src/agents/registry.ts:127`), and its other constructions (`registry.ts:41` listing path, `cli/agents.ts:110`)
  open no sessions. A nax test pins the invariant.

**Client and credentials.**
- The module client memo (`native/client.ts:177-181`) stays as the default: `nativeComplete`
  (`native/complete.ts:55`), `model-resolver.ts:76` (reached from nax's precheck) and every adapter built without
  options keep using it, so nax builds one client as today and the `NATIVE_CLIENT_OVERRIDES_MISMATCH` behaviour and
  test preloads stay.
- `new NativeSessionAdapter({ catalogOverrides?, credentials? })` with either option builds and owns its client
  instead of using the memo.
- The auth stamp follows the client: `servedAuth` / `authFields` (`native/adapter-deps.ts:9,46`,
  `session-adapter.ts:~380`, `complete.ts:107`) read the instance's credential store, not the global memo, so cost rows
  carry the session's account.
- **Memory source:** built with nax-ai's `createMemoryCredentialStore`; no change guard, no fingerprint salt file and
  no `configDir`, so it works with no `configureCredentials` call.
- **Exec source:** a new per-session construct reusing `createExecCredentialSource` with its own lease, plus the change
  guard keyed by an in-memory salt. (Today `assembleStore`, `native/credentials/index.ts:56-62`, builds the exec source
  from the global slot's auth config.)
- Absent `credentials`: the global credential store memo (`native/credentials/index.ts:118`) as today.

### 5.3 Streaming model calls (R7)

nax-ai already implements `Client.complete()` as `collectStream(streamFrom(...))`, and every protocol implements only
`stream()` (`nax-ai/src/client.ts`, `nax-ai/src/protocols/types.ts`). The wire path is already a stream; S3 taps it.

- **Where:** the `complete` closure in `NativeSessionAdapter.sendTurn` (`native/session-adapter.ts:~260-300`) calls
  `collectStream(tap(client.stream(model, req)))` instead of `client.complete(model, req)`. `collectStream` and
  `ProtocolStreamError` are exported by the pinned `@nathapp/nax-ai@0.1.16` (`index.ts:60`), so no nax-ai release is
  needed. The fold is not reimplemented: `collectStream` encodes last-usage-wins, a required `done` and
  `ProtocolStreamError` on an error event, which the retry classifiers rely on.
- `tap` is an async generator that passes each event to the sink in a try/catch (a throwing sink cannot break the call)
  and yields it unchanged. `client.stream()` throws synchronously on header or session-id validation, so it is called
  inside the async closure, preserving `complete()`'s rejection behaviour.
- The `summarize` closure (compaction) keeps `client.complete()`: summaries are not shown to the person.
- **Unchanged:** transport retry and the overflow-compaction retry key off a thrown `protocolError.kind`
  (`native/session/turn-retry.ts`, `turn-complete-step.ts:156`); `NativeTurnActivity` byte counts are computed after
  the call from the result, so they stay exact; abort and per-call timeouts use the same `AbortSignal.any` composite;
  partial tool-call JSON is assembled inside the protocol before its `tool-call` event, as today.
- **`stream_reset`:** nax-ai retries transport faults only before the first event (`nax-ai/src/client.ts:124-126`), so
  a retry after emitted deltas always comes from the loop (`turn-retry`, configured by
  `nativeSessionTransportRetry`, or the overflow-compaction retry). The sink emits `stream_reset` on every request
  attempt after the first.
- Without a sink (nax), the tap is a pass-through; nax's events and results are unchanged.

### 5.4 Richer turn events

The same per-turn sink (`SendTurnOpts.onTurnEvent`) carries `tool_call`, `tool_result`, `usage` per call and
`compaction`, so the facade builds §4.4 without parsing the activity stream. Questions and approvals do not go through
the sink: the facade raises them itself (§6.1). The existing activity and stream-bus events stay unchanged for nax.

**As built (S3-3).** `compaction.reason` is `"proactive" | "overflow"`. The compaction summary emits no `usage` (turn
totals come from `TurnResult`). `ask_human`, and calls the loop answers without running (spin stop, cancel, the invalid
call budget), emit no tool events. Redaction and byte caps (`tool_call.input` 8192, `tool_result.preview` 4096) are
applied in the backend at the sink, best-effort. `stream_reset` is emitted by the loop's per-attempt request wrapper.
`tool_call.input` redaction cuts each string to the scan size first (S3-4).

### 5.5 `TranscriptStore` port (R4)

```ts
interface TranscriptStore {
  load(sessionId: string): Promise<TranscriptDoc | null>;
  save(sessionId: string, doc: TranscriptDoc): Promise<void>;
  retainFailed(sessionId: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
  markTurn(sessionId: string, marker: TurnMarker): Promise<void>;   // read-merge, facade only
}
interface TranscriptDoc {
  schemaVersion?: 1;          // absent = 1; written by facade sessions only
  owner?: string;
  model?: string;
  savedAt: string;
  messages: ConversationMessage[];
  turn?: TurnMarker;          // read-only to the loop; owned by markTurn
}
interface TurnMarker { turnId: string; state: "running" | "ended" }
```

As built (S3-1): `retainFailed` takes no document; it moves the stored one aside.

- **File store.** `createFileTranscriptStore(dir)` keeps today's layout and bytes: `<dir>/<name>.transcript.json`,
  the `.transcript.failed-<stamp>.json` rename, the prune to 50 (`native/session/transcript-store.ts:16,172-193`),
  `TRANSCRIPT_CORRUPT` on an unreadable file (`:92`) and the legacy bare-array read. nax-written documents carry no
  `schemaVersion` or `turn`, so nax's files are byte-identical. `OpenSessionOpts.transcriptDir` stays as shorthand that
  builds it. `pruneRetainedTranscripts(dir)` stays exported (`nax/src/session/transcript-sweep.ts` uses it).
- **Memory store.** `createMemoryTranscriptStore()` ships for tests and simple embedders.
- **Identity check.** The owner/model mismatch rules move out of `loadTranscript` into one loop-side function applied
  to the loaded document, with today's semantics: an owner mismatch reads as empty history; a model mismatch reads as
  empty only when the document records a model; a legacy bare array is dropped when the reader has an owner.
- **Snapshot, not log.** The loop loads the whole history and saves at turn end (throws on failure) and on a caught
  error (best-effort, swallowed; `turn-loop.ts:240-245`). A process kill mid-turn loses that turn's user message and
  round trips.
- **`markTurn`.** The loop's `save` writes a fresh document and never carries `turn`, so the marker has its own
  read-merge method. Write order per turn: `markTurn(running)` → `sendTurn` (the loop saves) →
  `markTurn(ended)` → emit `turn_end`. A store whose `markTurn` throws fails the turn.
- **Close.** New `OpenSessionOpts.retainOnClose`: the facade sets it, so `closeSession` neither deletes the document on
  a clean close nor renames it to `.failed-<stamp>` after a failed turn (`session.ts:220-240`); the live document stays
  resumable. nax keeps today's delete and rename.

## 6. Approvals, host ports and the write policy

### 6.1 Approvals and questions (R5)

The facade's `AskResolver` is `chainAskLinks([sessionAskLink])`, passed to `buildCodingToolSupport` (which forwards
`askResolver` and `askRules`). `sessionAskLink`:
1. emits `approval_requested` with `expiresAt = now + approvalTimeoutMs`;
2. settles on the first of `answer()` (`decidedBy: "human"`), the deadline (deny, `"timeout"`) or the turn signal
   (deny, `"cancelled"`);
3. emits `approval_resolved`.

- An `AskRequest` with `unshowable: true` (`permissions/types.ts:35-40`) is denied without prompting
  (`decidedBy: "unshowable"`), as nax's human link does. Otherwise `command` is the full text, so a person never
  approves unseen text; the embedder keeps it behind its own auth.
- Embedder tools with `approval: "always"` call the same link from their wrapper (§4.3).
- **Questions.** The facade's `InteractionHandler` answers `question` requests from the same table: it emits
  `question`, and races `answer()` against the deadline and the turn signal. A timeout or cancel returns `null`, so the
  loop answers with the existing no-operator text (`native/session/turn-ask-human.ts:48-56`; `isError: true`, no
  budget consumed). No nax-agent loop change is needed, and nax's `dispatch-ask` path is untouched.
- Asks are serial per session. There is no remembered-approval cache; the `AskLink` chain stays public, so an embedder
  can put its own link in front.
- **Turn deadline.** `turnTimeoutSeconds` is wall clock (`createTurnDeadline`, `session-adapter.ts:141`) and keeps
  running during asks. When it fires, the turn ends `timed_out` and pending asks resolve with `decidedBy: "cancelled"`.
  The default (3600) is at least the largest `approvalTimeoutMs`, so one ask cannot outlive its turn by default.

**As built (S3-4).** Under `full`, `bashApproval: "gated"` puts every Bash command to the person (an unconditional ask
rule over the unconditional grant); `"escalate"` asks only for commands the screen refuses; `"raw"` never asks. Write,
Edit and Delete never ask. `approval_requested.command` is masked with `maskForPrompt`; a command that cannot be masked
safely is unshowable. An embedder tool's `run` is raced against the turn signal and abandoned on abort.

### 6.2 Host ports for embedders

| Port | S1 behaviour when absent | Facade behaviour when absent |
|---|---|---|
| `runDeclaredCommand` | RunCommand answers exit 1 (`tools/run-command.ts:103,303`) | RunCommand is not advertised |
| `protectedPaths` | GitCommit refuses every path (`tools/git-commit.ts:94-103`); the sandbox requires it (`coding-tools/coding-tool-sandbox.ts:107`) | GitCommit is not advertised; the sandbox gets an embedder default policy (below) |
| `commandInterceptor` | pass-through | pass-through |

**`ProtectedPathsPolicy` change (0.2.0, additive for callers).** `projectStateDir`, `credentialDir` and
`trustStoreFile` become optional (`tools/protected-paths.ts:10-21`); the sandbox policy skips an absent entry. nax
always passes all of them, so its policy is unchanged. The embedder default is `{ gitExcludePathspecs: [],
gitIgnorePatterns: [], credentialDir?, trustStoreFile? }`, where the credential entries come from the session's
credentials source: the file or exec source reports its directory; a memory source reports none.

### 6.3 Security floor

The threat model is agent mistakes only (arc decision D8).
- `full` without a usable sandbox fails at creation with `AGENT_SESSION_SANDBOX_UNAVAILABLE`, unless `bashApproval`
  is `gated` and `allowUnsandboxed: true` is passed. The check uses `resolveSessionSandbox`
  (`coding-tools/coding-tool-sandbox.ts:~113-135`, `state.kind === "unavailable"` carries the reason), cached per
  process.
- `read` and `none` need no sandbox. Under D8 that holds even though Grep spawns `rg`/`grep` and Git spawns git: Git
  already runs with hardened argv and env (`internal/git-exec.ts:84`, `hardenedGitArgv`), which neutralises repo-local
  config hooks.
- **Credential read-deny (new).** Today `protectedPaths.credentialDir` is enforced only for Bash by the sandbox
  (`coding-tool-sandbox.ts:126`) and `denyPaths` only by Delete (`tools/deny-paths.ts`); Read, Grep and Glob enforce
  root containment only. S3 adds a read-deny check to Read, Glob and Grep for the credential directory and trust-store
  file, resolving symlinks the way `nax-owned-writes.ts` does (`realOrRaw`). For nax this changes nothing unless a
  workdir contains the credential directory, where it now refuses as it should.
- Event payloads are redacted with the existing redaction.

### 6.4 Restart

Pending asks die with the process. `resumeAgentSession` finds `turn.state === "running"`, writes
`markTurn(ended)`, and sets `session.lastTurn = { turnId, status: "interrupted" }` so the embedder can show it. The
interrupted turn's user message is not in history (§5.5). The next `send` starts a normal turn.

### 6.5 Owned-writes policy (arc decision D16; carried from S1 §4.2 row 6)

`tools/nax-owned-writes.ts` moves to nax. nax-agent gains a neutral port shaped by its six real consumers
(`tools/policy.ts:21,108,167`, `tools/policy-bash-raw.ts:54,167-218`, `tools/policy-paths-branch.ts:27,101,144`,
`sandbox/policy-builder.ts:14-17,136-138,191`, and the `compileToolPolicy` options `ownedWriteExemption` /
`naxAllowWrite`, `policy.ts:56-65`):

```ts
interface OwnedPathsPolicy {
  /** Write refusal for a root-relative path; null = not owned. Today's naxOwnedWriteRefusal. */
  writeRefusal(tool: string, rel: string, ctx: { exemptRel?: string; optIns: readonly string[] }): string | null;
  /** Refusal for any tool, reads included (today's isNaxConfigFile branch). */
  configRefusal(root: string, resolved: string): string | null;
  /** Bash/Exec screen over lexical and realpath candidates; full refusal text. Today's naxOwnedKind + naxOwnedBashRefusal. */
  bashRefusal(tool: string, candidates: readonly string[], ctx: { root: string; verb: "names" | "redirects into"; sandboxWrapped: boolean }): string | null;
  /** Sandbox inputs as data. */
  deniedEntries: readonly string[];          // NAX_ALWAYS_DENIED_ENTRIES
  rootWriteDenies: readonly string[];        // QUEUE_CONTROL_FILES
  scratchpadEntry?: string;                  // NAX_SCRATCHPAD_ENTRY
  writeOptIns(root: string, allowWrite: readonly string[]): readonly string[];   // naxWriteOptIns
}
```

- nax injects today's policy through `buildCodingToolSupport`; `compileToolPolicy` keeps its option names.
- The nax-agent tests that pin the file (`test/unit/tools/{nax-owned-writes,policy,policy-bash-raw,git-commit,git}.test.ts`
  and `test/helpers/protected-paths.ts`) move with it or switch to an injected fixture; refusal texts are pinned
  byte-identical.
- The facade default is an empty policy (no owned paths). The credential directory is protected by §6.3's read-deny
  and the sandbox, not by this policy.

## 7. Errors

All new codes are namespaced `AGENT_SESSION_*` to avoid clashes with nax's `SESSION_NOT_FOUND` / `SESSION_BUSY`
(`nax/src/session/manager.ts`) and `registerCodingTool`'s `TOOL_NAME_RESERVED` (`tools/registry.ts:148`). All are
`NaxError` (`infra/nax-error.ts:6-16`).

| Code | When |
|---|---|
| `AGENT_SESSION_INVALID_OPTIONS` | option validation fails, or reserved `mcpServers` is set |
| `AGENT_SESSION_EXISTS` | `createAgentSession` with an existing `sessionId` |
| `AGENT_SESSION_BUSY` / `AGENT_SESSION_CLOSED` | `send` misuse |
| `AGENT_SESSION_INVALID_ANSWER` | `answer` with a never-issued id or a kind mismatch |
| `AGENT_SESSION_NOT_FOUND` / `AGENT_SESSION_SCHEMA_UNSUPPORTED` / `AGENT_SESSION_MODEL_MISMATCH` | resume |
| `AGENT_SESSION_SANDBOX_UNAVAILABLE` | §6.3 |
| `AGENT_SESSION_TOOL_NAME_RESERVED` | embedder tool name collides with a built-in or reserved name |
| `AGENT_SESSION_CONSUMER_STALLED` | `turn_end.error.code` when the control-event cap is hit (§4.4) |
| `AGENT_SESSION_TURN_FAILED` | `turn_end.error.code` for a turn failure with no adapter outcome or nax-agent code (S3-4); provider faults carry `AdapterFailure.outcome`, nax-agent errors their own code |
| `AGENT_SESSION_SPIN_STOPPED` / `AGENT_SESSION_INVALID_TOOL_CALLS` / `AGENT_SESSION_TURN_INCOMPLETE` | `turn_end.error.code` when the loop halts the turn (spin breaker, invalid-call budget, calls left pending); `output` and `usage` are kept (S3-4) |

Turn-level failures map to `turn_end.status`: provider and transport faults `errored`, the turn deadline `timed_out`,
`cancel()` and iterator `return()` `cancelled`, a throwing store `errored`.

## 8. Tests

- TDD per unit with bun:test; the facade and new ports meet the package coverage gate (80% overall and per file,
  empty baseline).
- The Node contract suite (vitest, Node 22 and 24) gains facade cases against a stub streaming client: multi-turn
  chat; deltas, coalescing and `stream_reset`; embedder tool with `always` approval allowed, denied and timed out;
  `answer` at the deadline returning `"expired"`; question answered and timed out; cancel during a tool; iterator
  `break`; `close` during a turn; resume after a simulated restart (`interrupted`); resume with a different model;
  `none` and `read` tool sets; two sessions with different catalog overrides and a memory credentials source in one
  process with no `configureCredentials` call.
- The packed-tarball smoke grows into the chat round-trip of §1.
- Behaviour-neutral PRs keep the nax suites green and pin nax-visible outputs: refusal texts, transcript file bytes,
  stream-bus events, the one-adapter-instance invariant.

## 9. Delivery

Small PRs to main; behaviour-neutral work first. Each PR gets a just-in-time plan against the latest main.

| PR | Content | nax behaviour |
|---|---|---|
| S3-0a | Session state moves into the adapter instance (threaded through `TurnDeps` and the truncation handler); one-instance invariant test | unchanged |
| S3-0b | Adapter-owned client and credentials (`catalogOverrides`, memory and exec sources, per-instance auth stamp); module memo stays the default | unchanged |
| S3-1 | `TranscriptStore` port with `markTurn`; file store byte-identical; memory store; loop-side identity check; `retainOnClose` | unchanged |
| S3-2 | `OwnedPathsPolicy` port, `nax-owned-writes.ts` moves to nax; `ProtectedPathsPolicy` optional fields; credential read-deny in Read/Glob/Grep | refusals pinned; read-deny only fires when a workdir contains the credential directory |
| S3-3 | Streaming model calls (tap + `collectStream`) and the `onTurnEvent` sink | wire path unchanged; billed S1-recipe smoke |
| S3-4 | The facade: create, events and channel, `answer`, questions, embedder tools, profiles, host-port defaults, security floor; loop types promoted to `.` | unchanged (new API) |
| S3-5 | `resumeAgentSession` and `interrupted`; API snapshot; README and CHANGELOG; Node contract cases; packed smoke; 0.2.0 release (approval) | unchanged |

S3-1, S3-2 and S3-3 depend only on S3-0a and can run in parallel. S3-4 depends on S3-0a..S3-3.

## 10. Acceptance

1. The packed-tarball chat smoke of §1 passes on Node 22 and 24 against a stub provider.
2. A real-provider chat smoke on Node: two turns and one embedder tool with an approval (billed; approval at launch).
3. `nax run` unchanged: the billed S1-recipe smoke passes with identical tool-audit and cost-row shapes (approval at
   launch).

## 11. Carried to S4

- Map profiles to ACP client capabilities (`fs.readTextFile`, `fs.writeTextFile`, terminal).
- Route ACP permission requests through the same ask link and deadline (today ACP races interactions against a fixed
  5-minute timeout, `nax/src/agents/acp/adapter-send-turn.ts:~225`).
- Expose embedder tools to the external agent as an MCP server nax-agent starts for the session.
- Then the deferred MCP client (`mcpServers`).
