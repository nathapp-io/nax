# S3 — Conversational session API for `nax-agent` (design)

- **Arc:** nax-agent. This is sub-project S3 of 7 (S0-S6).
- **Arc SSOT:** the nax-agent master plan, kept in the maintainer's workspace (not in this repo). It holds the arc decisions and all status. This spec holds S3's design only.
- **Date:** 2026-10-03, from the S3 brainstorm.
- **Base:** `main` @ `55e9f3e26` (S2 complete; `@nathapp/nax-agent@0.1.0` published).
- **Inputs:** file and line references below were read on the base commit.

## 1. Goal

Give an embedder (a long-running Node service, for example a NestJS API) a conversational session API on top of
nax-agent: multi-turn chat with a person in the loop, streamed events, embedder-supplied tools, an embedder-supplied
transcript store, cancellation and an approval hook. The native loop is the first backend; the acpx backend (S4)
implements the same S1 adapter contract and needs no change to this API.

**Done means:**
- A packed `@nathapp/nax-agent` under Node 22 and 24 runs a multi-turn native chat with streamed token deltas, one
  embedder tool approved through `answer()`, one approval denied by timeout, one cancel and one resume from a store.
- Many sessions run in one process with different credentials sources and catalog overrides.
- `nax run` behaves as before. The one deliberate internal change (streaming model calls, §5.3) passes the S1-recipe
  acceptance smoke.

**Out of scope:**
- The acpx backend (S4) and the ACP-server wrapper (S5).
- Moving nax's own story sessions onto this API. nax keeps calling the S1 adapter; moving it later is an unscheduled
  follow-up, and this design must not foreclose it (§3).
- An MCP client for embedder tools (a reserved, unimplemented `mcpServers` option, §4.1).
- A durable suspend of a turn waiting on an approval (§6.4).
- Remembered approvals (`allow-remember`) inside the facade (§6.1).

## 2. Rulings (from the S3 brainstorm, 2026-10-03)

| # | Ruling |
|---|---|
| R1 | **Original arc design stands:** the embedder imports the library in-process; one session contract, backends native and acpx; the ACP-server wrapper (S5) is a separate entry for other ACP clients. |
| R2 | **Workspace = per-session tool profile** `none` \| `read` \| `full`, stated backend-neutrally. S3 builds and tests `none` and `read`; `full` uses the same mechanism behind the security floor (§6.3). The acpx backend honours the same profile (S4). |
| R3 | **Layer on top:** S3 is a facade over the S1 `AgentSessionAdapter`; nax keeps the S1 contract. Moving nax onto S3 later stays possible. |
| R4 | **The embedder owns history** through an injected `TranscriptStore`; file and memory stores ship; `resumeAgentSession` rebuilds context after a restart; the document schema is versioned and public. |
| R5 | **Approvals are an in-memory wait with a per-session timeout.** `approvalTimeoutMs` (default 600000, range 30000..3600000, the same as nax's `execution.approvalTimeout`) and `bashApproval` are session options; nax-agent enforces the timeout; timeout = deny. A restart mid-wait ends the turn as `interrupted`. |
| R6 | **Embedder tools: in-process functions now; an MCP client later.** Each tool declares `approval: "never" \| "always"`. |
| R7 | **Real token streaming in S3**, for nax and the facade alike: the native loop moves to `client.stream()`. |
| R8 | **Per-session client.** The process-wide client memo goes; sessions may pass `catalogOverrides` and a `credentials` source (memory or exec) that falls back to the `configureCredentials` slot. |
| R9 | **Approach 1:** a session facade over the S1 adapter; `send()` returns an async iterable of events; approvals and questions are answered with `session.answer()`. |

## 3. Architecture

```
embedder ──► createAgentSession / resumeAgentSession      (session/agent-session.ts, new)
                 │  composes: InteractionHandler (embedder tools + ask link), TranscriptStore,
                 │            tool policy from profile, host-port defaults, event channel
                 ▼
             AgentSessionAdapter (S1 contract, unchanged for nax)
                 ├── NativeSessionAdapter   (per-instance state + client, streaming loop)
                 └── AcpAgentAdapter        (S4)
nax ─────────────────► AgentSessionAdapter directly (unchanged)
```

The facade knows no backend internals. Everything it needs from a backend arrives through optional fields on the S1
contract (`SendTurnOpts.onTurnEvent`, `OpenSessionOpts.transcriptStore`, `retainOnClose`), which nax does not set.
That keeps the later move of nax onto the facade a pure caller change.

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
  bashApproval?: "raw" | "gated" | "escalate",   // full only
  allowUnsandboxed?: boolean,              // full only, see §6.3
  credentials?: CredentialSource,          // falls back to the configureCredentials slot
  catalogOverrides?: NativeCatalogOverrides,
  loopHandlers?: LoopHandlerSet,           // P6 handler registration, now public
  hostPorts?: {
    runDeclaredCommand?: DeclaredCommandRunner,
    protectedPaths?: ProtectedPathsPolicy,
    commandInterceptor?: CommandInterceptor,
    ownedWrites?: OwnedWritesPolicy,
  },
  metadata?: Record<string, string>,       // passed through on every event
  timeoutSeconds?: number,                 // per-turn deadline
  // reserved, rejected if set in S3: mcpServers
});
```

Options are validated with zod; a bad option throws `INVALID_SESSION_OPTIONS`.

### 4.2 The session object

```ts
interface AgentSession {
  readonly id: string;
  readonly lastTurn?: { turnId: string; status: TurnEndStatus };   // set after each turn_end and on resume
  send(message: string): AsyncIterable<SessionEvent>;     // single-flight
  answer(requestId: string, reply: { decision: "allow" | "deny" } | { text: string }): void;
  cancel(reason?: string): void;                          // aborts the running turn
  close(): Promise<void>;                                 // keeps the transcript in the store
}
function resumeAgentSession(sessionId: string, options: CreateAgentSessionOptions): Promise<AgentSession>;
```

- `send` while a turn runs throws `SESSION_BUSY`; after `close` it throws `SESSION_CLOSED`.
- `answer` for an unknown or settled id throws `ASK_NOT_PENDING`.
- `resumeAgentSession` loads the store document; a missing document throws `SESSION_NOT_FOUND`; an unknown
  `schemaVersion` throws `TRANSCRIPT_SCHEMA_UNSUPPORTED`.

### 4.3 Embedder tools

```ts
interface EmbedderTool {
  name: string;                 // must not shadow a built-in (TOOL_NAME_RESERVED)
  description: string;
  inputSchema: JsonSchema;
  approval: "never" | "always";
  run(input: unknown, ctx: { sessionId: string; toolCallId: string; signal: AbortSignal }):
    Promise<{ content: string; isError?: boolean }>;
}
```

They are adapted through the existing `ProviderTool` / `adaptProviderTool` route into the runtime's `extraTools`
(`packages/nax-agent/src/tools/provider-adapt.ts:26`). A tool that throws becomes a tool result with `isError: true`.

### 4.4 Events

`SessionEvent` is a discriminated union on `type`. Every event carries `sessionId`, `turnId`, `at` (ISO time) and
`metadata`.

| `type` | Payload |
|---|---|
| `turn_start` | — |
| `text_delta` | `text` |
| `thinking_delta` | `text` |
| `stream_reset` | `attempt` — the deltas since the last model call started are void (a transport retry) |
| `tool_call` | `callId`, `name`, `input` (redacted) |
| `tool_result` | `callId`, `isError`, `preview` (byte-capped, redacted) |
| `approval_requested` | `requestId`, `tool`, `summary`, `command?` (full text), `reason`, `expiresAt` |
| `approval_resolved` | `requestId`, `decision`, `decidedBy` |
| `question` | `requestId`, `text`, `expiresAt` |
| `usage` | `inputTokens`, `outputTokens`, `cacheRead?`, `cacheWrite?`, `costUsd` — per model call |
| `compaction` | `reason` |
| `turn_end` | `status`: `completed` \| `cancelled` \| `timed_out` \| `interrupted` \| `errored`; `output`; `usage`; `costUsd`; `error?` `{code, message}` |

`turn_end` is always the last event of a `send`; the iterator then completes. Turn failures arrive as `turn_end`,
never as a throw from the iterator. Events are delivered in order with backpressure through the iterator (no
unbounded buffering).

### 4.5 Profiles

| Profile | Tools advertised |
|---|---|
| `none` | embedder tools, the scratchpad trio |
| `read` | + Read, Glob, Grep, read-only Git |
| `full` | + Write, Edit, Delete, Bash, RunCommand (only with a runner, §6.2), GitCommit — under the sandbox and `bashApproval` |

Profiles are capability statements, not tool-name lists, so S4 can map them to ACP client capabilities.

### 4.6 Stage labels

Facade events carry no nax pipeline `stage`. Embedders tag sessions through `metadata`. The stage narrowing in nax's
stream bus (unknown labels dropped) stays nax-only, so embedders cannot hit that trap.

## 5. Components and backend changes

### 5.1 The facade (`session/agent-session.ts`)

Owns the single-flight guard, the event channel behind `send()`'s iterator, the pending-ask table with deadline
timers, and the per-session `InteractionHandler` (embedder tools + `context-tool` routing + questions). It builds the
tool policy from `profile` and calls `buildCodingToolSupport` with the host ports (§6.2). It only calls the S1
`AgentSessionAdapter`.

### 5.2 Per-session native state

These move from module scope into the `NativeSessionAdapter` instance (`packages/nax-agent/src/native/session/session.ts`):
`nativeTranscriptDirs`, `nativeSessionScratchpadRoots`, `nativeSessionTimeouts`, `nativeSessionStreamHooks`,
`nativeSessionFailed`, `nativeSessionTranscriptOwners`, `nativeSessionCompaction`, `nativeSessionTransportRetry`,
`nativeSessionSpinBreaker`, `nativeSessionLastUsage`; and the client memo (`packages/nax-agent/src/native/client.ts`,
`cached` / `cachedOverrides`, whose second-call-with-different-overrides throw goes away).

The facade creates one adapter per session, so each session owns its client, credentials source and catalog
overrides (R8). nax creates one adapter per run and sees no change. The `/internal` exports of the maps become
instance accessors; nax call sites change in the same PR.

The per-session `credentials` source reuses the chained store (`packages/nax-agent/src/native/credentials/index.ts`):
a memory source or an exec source with its own lease; absent means the slot.

### 5.3 Streaming model calls (R7)

`turn-loop-round-trip` calls `client.stream()` (`packages/nax-ai/src/client.ts:57`) and folds the `ProtocolEvent`s
into the same result shape `complete()` returns. Retry, invalid-call repair, spin-break, compaction and usage/cost code
keep the same input. Deltas go to the new optional per-turn sink `SendTurnOpts.onTurnEvent`. nax does not set it, and
nax's byte-count activity events (`NativeTurnActivity`) are computed exactly as today.

When transport retry restarts a model call after deltas were emitted, the sink emits `stream_reset` before the new
attempt's deltas. If a provider protocol cannot stream, the loop keeps `complete()` for it; the plan verifies the
protocol list in nax-ai.

### 5.4 Richer turn events

The same sink carries `tool_call` (with input), `tool_result` (preview), `usage` per call, `compaction`, `question`
and the approval events, so the facade builds §4.4 without parsing the activity stream. The existing activity and
stream-bus events stay unchanged for nax.

### 5.5 `TranscriptStore` port (R4)

```ts
interface TranscriptStore {
  load(sessionId: string): Promise<TranscriptDoc | null>;
  save(sessionId: string, doc: TranscriptDoc): Promise<void>;
  retainFailed(sessionId: string, doc: TranscriptDoc): Promise<void>;
  delete(sessionId: string): Promise<void>;
}
interface TranscriptDoc {
  schemaVersion: 1;
  owner?: string;
  model?: string;
  savedAt: string;
  messages: ConversationMessage[];
  turn?: { turnId: string; state: "running" | "ended" };   // written by the facade only
}
```

- `createFileTranscriptStore(dir)` reproduces today's layout exactly: `<dir>/<name>.transcript.json`, the
  `.transcript.failed-<stamp>.json` rename and the prune to 50
  (`packages/nax-agent/src/native/session/transcript-store.ts`). `OpenSessionOpts.transcriptDir` stays as shorthand
  that builds it; a file without `schemaVersion` reads as version 1, so existing transcripts load.
- `createMemoryTranscriptStore()` ships for tests and simple embedders.
- The store is a snapshot, not an append log: the loop loads the whole history and saves at turn end and on abort,
  which this matches. Chat history for display comes from the events the embedder persists.
- New `OpenSessionOpts.retainOnClose`: the facade sets it so `close()` keeps the document; nax keeps
  delete-on-clean-close.
- A throwing store fails the turn (`errored`): history must not fork silently.
- `turn` is facade bookkeeping: it saves `{turnId, state: "running"}` before calling `sendTurn` and `"ended"` after
  `turn_end`. The native loop preserves the field on its own saves. nax never sets it.

## 6. Approvals, host ports and the write policy

### 6.1 Approvals (R5)

The facade's `AskResolver` is `chainAskLinks([sessionAskLink])`. `sessionAskLink`:
1. emits `approval_requested` with `expiresAt = now + approvalTimeoutMs`;
2. settles on the first of `answer()` (`decidedBy: "human"`), the deadline (deny, `"timeout"`) or the turn signal
   (deny, `"cancelled"`);
3. emits `approval_resolved`.

Embedder tools with `approval: "always"` pass through the same link before `run`. Questions (`ask_human`) use the
same table and deadline and are raced against the signal; a timeout answers with the existing no-operator text
(`packages/nax-agent/src/native/session/turn-ask-human.ts:48-56`) rather than a deny. Asks are serial per session.

The deadline and signal race for questions live in nax-agent but apply only when the caller sets them, so nax's
`dispatch-ask` path is unchanged. There is no remembered-approval cache in the facade; the `AskLink` chain stays
public, so an embedder can put its own link in front.

### 6.2 Host ports for embedders

| Port | S1 behaviour when absent | Facade default |
|---|---|---|
| `runDeclaredCommand` | RunCommand answers exit 1 | RunCommand is not advertised unless a runner is passed |
| `protectedPaths` | GitCommit refuses every path; the sandbox requires it | An embedder default policy: no git exclusions, `projectStateDir: null`, the credential directory and trust-store file from the session's credentials source |
| `commandInterceptor` | pass-through | pass-through |

### 6.3 Security floor

The threat model is agent mistakes only (arc decision D8).
- `full` without a usable sandbox fails at creation with `SANDBOX_UNAVAILABLE`, unless `bashApproval` is `gated` and
  `allowUnsandboxed: true` is passed.
- `read` and `none` need no sandbox.
- The credential directory is never readable through Read, Grep or Glob in any profile.
- Event payloads are redacted with the existing redaction. `command` on `approval_requested` is the full text, so a
  person never approves unseen text; the embedder keeps it behind its own auth.

### 6.4 Restart

Pending asks die with the process. `resumeAgentSession` finds `turn.state === "running"` in the loaded document,
marks it `"ended"`, and exposes it as `session.lastTurn = { turnId, status: "interrupted" }` so the embedder can show
it. The next `send` starts a normal turn on the saved history.

### 6.5 Owned-writes policy (arc decision D16)

`packages/nax-agent/src/tools/nax-owned-writes.ts` (the `.nax` entries, queue-control files and opt-ins) moves to nax.
nax-agent gains a neutral port:

```ts
interface OwnedWritesPolicy {
  deniedEntries: readonly string[];
  ownedWriteRefusal(path: string): string | null;
  bashRefusal(command: string): string | null;
}
```

nax injects today's policy through `buildCodingToolSupport`; tests pin byte-identical refusals. The facade default is
an empty policy that still always denies the credential directory and trust-store file.

## 7. Errors

| Code | When |
|---|---|
| `INVALID_SESSION_OPTIONS` | option validation fails, or reserved `mcpServers` is set |
| `SESSION_BUSY` / `SESSION_CLOSED` | `send` misuse |
| `ASK_NOT_PENDING` | `answer` with an unknown or settled id |
| `SESSION_NOT_FOUND` / `TRANSCRIPT_SCHEMA_UNSUPPORTED` | resume |
| `SANDBOX_UNAVAILABLE` | §6.3 |
| `TOOL_NAME_RESERVED` | embedder tool name collides with a built-in |

All are `NaxError`. Turn-level failures map to `turn_end.status`: provider and transport faults `errored`, the
per-turn deadline `timed_out`, `cancel()` `cancelled`.

## 8. Tests

- TDD per unit with bun:test; the facade and new ports meet the package coverage gate (80% overall and per file,
  empty baseline).
- The Node contract suite (vitest, Node 22 and 24) gains facade cases against a stub streaming client: multi-turn
  chat; deltas and `stream_reset`; embedder tool with `always` approval allowed, denied and timed out; question
  answered and timed out; cancel during a tool; resume after a simulated restart (`interrupted`); `none` and `read`
  tool sets; two sessions with different catalog overrides in one process.
- The packed-tarball smoke grows into the chat round-trip of §1.
- Behaviour-neutral PRs keep the nax suites green and pin nax-visible outputs (refusal texts, transcript files,
  stream-bus events).

## 9. Delivery

Small PRs to main; behaviour-neutral work first.

| PR | Content | nax behaviour |
|---|---|---|
| S3-0 | Per-session native state; per-session `credentials` and `catalogOverrides` | unchanged |
| S3-1 | `TranscriptStore` port, file store identical to today, memory store, `retainOnClose` | unchanged |
| S3-2 | `OwnedWritesPolicy` port; `nax-owned-writes.ts` moves to nax and is injected | unchanged (pinned) |
| S3-3 | Streaming model calls and the `onTurnEvent` sink | model-call path changes; billed S1-recipe smoke |
| S3-4 | Question and approval deadlines with the signal race, caller-opt-in | unchanged |
| S3-5 | The facade: create, events, `answer`, embedder tools, profiles, host-port defaults, security floor | unchanged (new API) |
| S3-6 | `resumeAgentSession` and `interrupted`; API snapshot; README and CHANGELOG; Node contract cases; 0.2.0 release (approval) | unchanged |

Each PR gets a just-in-time plan against the latest main.

## 10. Acceptance

1. The packed-tarball chat smoke of §1 passes on Node 22 and 24 against a stub provider.
2. A real-provider chat smoke on Node: two turns and one embedder tool with an approval (billed; approval at launch).
3. `nax run` unchanged: the billed S1-recipe smoke passes with identical tool-audit and cost-row shapes (approval at
   launch).

## 11. Carried to S4

- Map profiles to ACP client capabilities (`fs.readTextFile`, `fs.writeTextFile`, terminal).
- Route ACP permission requests through the same ask link and deadline.
- Expose embedder tools to the external agent as an MCP server nax-agent starts for the session.
- Then the deferred MCP client (`mcpServers`).
