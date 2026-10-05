# S4: ACP backend for nax-agent (`@nathapp/nax-agent-acp`)

**Status:** design approved in brainstorm 2026-10-05; spec awaiting maintainer review.
**Master plan:** `nax-agent-master-plan.md`, row S4 (maintainer workspace), decisions D24 and D25.
**Research:** maintainer workspace `projects/nax/s4-research/`, six reports:
- 01: nax's ACP client today
- 02: the S3 backend seam
- 03: acpx 0.19.4
- 04: pi 0.87.1
- 05: the ACP SDK and adapters
- 06: paperclip

**Baseline:** main `57ed87c17`, `@nathapp/nax-agent` 0.2.0.

## 1. Goal

Let the S3 conversational session API drive external coding agents over ACP (Agent Client Protocol), with the same `send()` / `answer()` / `cancel()` / `close()` contract the native backend has. Claude Code is the first-class agent. Codex, Gemini CLI, OpenCode and pi are registered and capability-checked.

S4 delivers:

- `@nathapp/nax-agent` **0.3.0**: a backend seam (`SessionBackend`), the native backend behind it (`nativeBackend()`), and four profiles `none | read | ask | full`. This is a deliberate breaking change; nax-agent has no external consumers yet.
- `@nathapp/nax-agent-acp` **0.3.0** (new package, versioned in step with nax-agent): `./client` = `acpBackend()`, nax-agent's own ACP client on the official SDK. `./server` is reserved for S5 and is empty in S4.

## 2. Context and decisions

### 2.1 What exists today

- nax's ACP path (`packages/nax/src/agents/acp/`, 23 files, 4.3k lines) is not a protocol client. It spawns the `acpx` CLI once per turn and parses its NDJSON output.
- Its permissions are all-or-nothing (`--approve-all`); nax never sees `session/request_permission`.
- Tool calls surface as names only, with no inputs, results or tool-audit.
- It has no MCP support.
- After `sessions close`, a resume silently starts a fresh, context-less session.
- The S3 facade reaches its backend only through the S1 `AgentSessionAdapter` contract, but it is hard-wired to `NativeSessionAdapter` in `createAdapter` / `assemble` (`packages/nax-agent/src/session/agent-session.ts`).

### 2.2 Decisions (brainstorm 2026-10-05)

| # | Decision |
|---|---|
| R1 | **Own ACP client on `@agentclientprotocol/sdk`** (stable protocol v1, builder API), not the acpx CLI and not `acpx/runtime`. Reasons (D25): acpx's runtime events are lossy (paperclip carries about 1k lines of patches and still lacks tool content); owning the client routes ACP `fs/*` and `terminal/*` through nax-agent's policy and sandbox; S5 needs the same SDK. Ideas, not code, are taken from acpx's registry and session handling. |
| R2 | **Separate package `@nathapp/nax-agent-acp`**, `./client` (S4) and `./server` (reserved for S5). Core nax-agent never imports ACP. |
| R3 | **Split S4 / S4b.** S4 = the library backend. S4b (its own spec) moves `nax run`'s ACP path onto it, moves pricing, maps nax permission modes, and deletes the acpx wrapper. nax's acpx wrapper is untouched in S4. |
| R4 | **Agent coverage:** Claude first-class (billed live smoke + conformance suite). Codex, Gemini, OpenCode and pi are registered with a capability matrix and an initialize-only smoke. Adapters authenticate themselves; S4 passes the environment through and reports typed auth errors. |
| R5 | **Clean 0.3.0 contract break**, no compatibility layer. nax does not use the facade. |
| R6 | **Profiles `none \| read \| ask \| full`.** `ask` = every risky action approved by the caller; `full` = no prompts. Same meaning on both backends (§5). |
| R7 | **`acpBackend` always requires `allowUnsandboxed: true`**: the agent process runs on the host. |
| R8 | **MCP tool host is HTTP-only in S4**; a stdio bridge is deferred. |
| R9 | **Elicitation:** message-only and single-field forms become `question` events; richer forms are declined. |
| R10 | **Versioning:** nax-agent-acp starts at 0.3.0, in step with nax-agent. Both are released together. Everything goes 1.0.0 together after S6. |

## 3. Out of scope

- The `nax run` cutover, the ACP rate card and pricing, the permission-mode mapping, and deleting `packages/nax/src/agents/acp/`: all S4b.
- The ACP server (S5): the `./server` subpath is reserved only.
- A stdio MCP bridge, the MCP-over-ACP draft, and an MCP client for embedder-supplied servers (`mcpServers` option).
- Sandboxing the agent process (for example under sandbox-runtime).
- Images and resources in prompts or replies; `plan`, available-commands, mode and config updates; `allow_always` decisions; full support for Codex, Gemini, OpenCode or pi.
- Switching releases to `npm stage publish` (tracked separately in the master plan).

## 4. Architecture

```
@nathapp/nax-ai            providers, pricing                       (unchanged)
        ▲
@nathapp/nax-agent 0.3.0   contract + native backend
  session facade: createAgentSession / resumeAgentSession (backend injected)
  SessionBackend, SessionAskPort, events, error codes, TranscriptStore
  nativeBackend(): loop, tools, permissions, sandbox, OwnedPathsPolicy
        ▲ peer dependency
@nathapp/nax-agent-acp 0.3.0
  ./client  acpBackend(): SessionBackend over @agentclientprotocol/sdk
  ./server  reserved (S5)
        ▲
consumers: koda (S6); nax CLI after S4b
```

Dependency direction is one way. nax-agent-acp imports only nax-agent's public entry (`.`), `@agentclientprotocol/sdk`, `@modelcontextprotocol/sdk` and `zod`. A boundary gate enforces this (§10, S4-1).

## 5. nax-agent 0.3.0: the backend seam

### 5.1 `SessionBackend`

```ts
export interface SessionBackend {
  /** Recorded in the transcript document; "native" or "acp:<agent>". */
  readonly kind: string;
  open(ctx: BackendOpenContext): Promise<OpenedBackend>;
}

export interface BackendOpenContext {
  readonly sessionId: string;
  readonly workdir: string;                 // the facade's resolved root (a scratch root for profile "none" without workdir)
  readonly profile: AgentSessionProfile;
  readonly instructions: string | undefined;
  readonly tools: readonly EmbedderTool[];
  readonly transcriptStore: TranscriptStore;
  readonly resume: { readonly doc: TranscriptDoc } | undefined;
  readonly asks: SessionAskPort;
  readonly turnSignal: () => AbortSignal;
  readonly currentTurnId: () => string | undefined;
  readonly turnTimeoutSeconds: number;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface OpenedBackend {
  readonly adapter: AgentSessionAdapter;    // the existing S1 contract
  readonly handle: SessionHandle;
  /** Per-turn SendTurnOpts the backend contributes (codingTools, interactionHandler, loopHandlers, ...). */
  turnOpts(): Partial<SendTurnOpts>;
  /** Releases backend resources after adapter.closeSession. Idempotent. */
  close(): Promise<void>;
}
```

`SessionAskPort` is the existing ask plumbing made public: the pending-ask table, the `approval_requested` / `approval_resolved` / `question` emission, the deadline, and settlement on `answer()` or the turn signal.

```ts
export interface SessionAskPort {
  requestApproval(req: {
    callId?: string; tool: string; summary: string; command?: string; reason: string;
  }): Promise<{ decision: "allow" | "deny"; decidedBy: ApprovalDecidedBy }>;
  /** Emits approval_requested and approval_resolved without waiting (profile auto-decisions). */
  recordAutoDecision(req: { callId?: string; tool: string; summary: string; reason: string }, decision: "allow" | "deny"): void;
  askQuestion(text: string): Promise<string | null>;   // null = deadline, cancel or unavailable
}
```

The facade keeps:
- the single-flight guard, `claimTurn` / `runTurn`, `markTurn(running|ended)` and `turn_end`
- the event channel, the error codes and the deadlines

`assemble()` shrinks to: resolve the root, build the ask port, call `backend.open(ctx)`, and build `TurnRunContext` from the result.

### 5.2 `nativeBackend()`

Everything native moves unchanged into `nativeBackend(opts)` (new module `session/native-backend.ts`):
- the sandbox launcher and floor
- `protectedPaths` merging
- `buildSessionToolSupport` and the interaction handler with built-in tools
- `NativeSessionAdapter` construction (`createAdapter`)
- the spin breaker, `SESSION_TRANSPORT_RETRY`, loop handlers
- resume via `TranscriptDoc.messages`

```ts
nativeBackend({
  model: string;                       // required
  credentials?; catalogOverrides?; loopHandlers?; hostPorts?;
  bashApproval?: BashApprovalMode;     // profiles ask/full only
  allowUnsandboxed?: boolean;          // profiles ask/full only
}): SessionBackend                     // kind "native"
```

The model check (`AGENT_SESSION_MODEL_MISMATCH`) moves inside the native backend's resume.

### 5.3 Facade options (breaking)

```ts
createAgentSession({
  backend: SessionBackend;             // required; replaces backend: "native"
  sessionId?; profile; workdir?; instructions?; tools?;
  transcriptStore; approvalTimeoutMs?; turnTimeoutSeconds?; metadata?;
})
resumeAgentSession(sessionId, { backend, ...same shared options })
```

These fields move from the top level into `nativeBackend()`: `model`, `credentials`, `catalogOverrides`, `loopHandlers`, `hostPorts`, `bashApproval`, `allowUnsandboxed`. No compatibility layer.

### 5.4 Profiles

The shared type becomes `AgentSessionProfile = "none" | "read" | "ask" | "full"`.

| Profile | Meaning | Native backend |
|---|---|---|
| `none` | no permitted side effects | embedder tools and the scratchpad trio (unchanged) |
| `read` | read-only | plus Read, Glob, Grep, read-only Git (unchanged) |
| `ask` | everything; every risky action approved by the caller | 0.2.0 `full` tool set, but Write, Edit, Delete and Bash each require `approval_requested` → `answer()`. New. |
| `full` | everything, no prompts | 0.2.0 `full` unchanged: `bashApproval` and the sandbox floor apply |

- Embedder tools declared `approval: "always"` still ask under every profile.
- `workdir` is required for every profile except `none`, as before.
- **Native `ask` implementation risk:** the plan must confirm that the tool runtime's existing grant tiers can force the ask tier for Write, Edit, Delete and Bash without changing the policy engine. If they cannot, native `ask` becomes its own task in S4-0, not a policy-engine redesign.

### 5.5 Contract additions

- **Error codes** (`AgentSessionErrorCode`):
  - `AGENT_SESSION_BACKEND_UNAVAILABLE`: the agent cannot be launched, or exits during initialize.
  - `AGENT_SESSION_AUTH_REQUIRED`: the backend reports an authentication failure.
  - `AGENT_SESSION_CAPABILITY_UNSUPPORTED`: the backend cannot meet a requirement (profile, tools, resume).
  - `AGENT_SESSION_BACKEND_MISMATCH`: resuming with a backend whose `kind` differs from the stored one.
- **`ApprovalDecidedBy`** gains `"profile"` (an automatic decision by profile).
- **`usage` event** gains `costSource?: "computed" | "reported" | "unpriced"`:
  - native sets `computed`
  - ACP sets `reported` when the agent reports a cost, else `unpriced` with `costUsd: 0`
  - absent means `computed`, for 0.2.0 compatibility of readers
- **`TranscriptDoc`** gains optional fields:
  - `backend?: string`: absent means `"native"`
  - `acp?: { agentSessionId: string; agent: string; agentVersion?: string; cwd: string }`

  `schemaVersion` stays 1 (additive optional fields).
- **Public redaction and cap helpers** for event payloads. Today they are internal to the native sink; they are promoted so a second backend applies the same rules (`tool_call.input` 8192 bytes, `tool_result.preview` 4096 bytes, best-effort redaction).

## 6. `@nathapp/nax-agent-acp/client`

### 6.1 Modules (`packages/nax-agent-acp/src/client/`)

| Module | Responsibility |
|---|---|
| `backend.ts` | `acpBackend(opts)`: implements `SessionBackend` and `AgentSessionAdapter` |
| `registry.ts` | launch data per agent: command candidates (installed binary first, else `npx -y <pkg>@<pinned range>`), mode ids, known quirks; caller override of `command` / `args` / `env`; custom agents |
| `launch.ts` | spawn as a process-group leader, stdio → SDK `ndJsonStream` (via `Readable.toWeb` / `Writable.toWeb`), 64 KB stderr tail, process-group kill using nax-agent's kill helpers |
| `connection.ts` | SDK client builder: initialize, session new/resume/load, prompt, cancel, close; registers the inbound handlers |
| `capabilities.ts` | capability record from `initialize` plus registry quirks; requirement checks |
| `permissions.ts` | `session/request_permission` handling per profile (§6.4) |
| `fs-terminal.ts` | `fs/*` and `terminal/*` handlers through nax-agent's runtime (§6.5) |
| `tool-host.ts` | HTTP MCP server for embedder tools (§6.6) |
| `events.ts` | `session/update` → `TurnEvent` (§6.7) |
| `elicitation.ts` | elicitation → `question` (§6.8) |
| `resume.ts` | resume / load and the reconnect path (§6.9) |

### 6.2 `acpBackend` options

```ts
acpBackend({
  agent: "claude" | "codex" | "gemini" | "opencode" | "pi" | { name: string; command: string; args?: string[] };
  allowUnsandboxed: true;              // required (R7); anything else → AGENT_SESSION_SANDBOX_UNAVAILABLE
  model?: string;                      // applied via session/set_config_option (category model) when offered
  env?: Record<string, string>;        // merged over process.env for the agent process
  command?: string; args?: string[];   // override the registry's launch command
  cancelGraceMs?: number;              // default 10_000
  initializeTimeoutMs?: number;        // default 60_000 (covers an npx download)
}): SessionBackend                     // kind "acp:<agent name>"
```

### 6.3 Lifecycle

1. **Open:**
   1. spawn; `initialize` (protocol v1) advertising client capabilities from the profile (§6.4)
   2. build the capability record and check requirements: the profile is enforceable, tools need `mcpCapabilities.http`, and resume needs resume or load. A failure → `AGENT_SESSION_CAPABILITY_UNSUPPORTED` before any prompt.
   3. start the tool host if there are tools
   4. `session/new { cwd: workdir, mcpServers }`, or the resume path
   5. apply the profile's mode and `model` via config options when offered. Asking for `model` on an agent that does not offer a model option → `AGENT_SESSION_CAPABILITY_UNSUPPORTED`.

   Spawn failure or exit during initialize → `AGENT_SESSION_BACKEND_UNAVAILABLE`, with the stderr tail. An ACP auth error, or `authMethods` with no usable session → `AGENT_SESSION_AUTH_REQUIRED`.
2. **Turn:** `session/prompt` with the message, and `instructions` prepended on the first turn only. ACP has no system-prompt field; this is documented. Updates stream through `events.ts`. Stop reason mapping:
   - `end_turn` → `completed`
   - `cancelled` → `cancelled`
   - `max_tokens`, `max_turn_requests`, `refusal` → `errored`, with `error.code` naming the stop reason
   - The facade's `turnTimeoutSeconds` keeps applying.
3. **Cancel:** send `session/cancel`, then wait `cancelGraceMs`. If the prompt has not settled, kill the process group. The turn ends `cancelled`, the session is marked disconnected, and the next `send()` reconnects (step 5).
4. **Close:**
   - `session/close` if advertised
   - close stdin, SIGTERM the group, SIGKILL after the grace
   - stop the tool host and revoke its token
   - idempotent
5. **Crash** (process exit outside close):
   - the running turn ends `errored` (`AGENT_SESSION_BACKEND_UNAVAILABLE`)
   - pending asks expire with `cancelled`
   - the session is marked disconnected
   - on the next `send()`, one reconnect attempt via §6.9; if that is impossible or fails, `send()` throws `AGENT_SESSION_CLOSED`

### 6.4 Profiles on ACP (three layers) and permissions

| Layer | `none` | `read` | `ask` | `full` |
|---|---|---|---|---|
| 1. Client capabilities advertised | no fs, no terminal | `fs.readTextFile` only | fs read and write, terminal | fs read and write, terminal |
| 2. Agent mode, where the registry maps one (Claude) | `plan` | `plan` | `default` | `default` |
| 3. `request_permission` | reject locally | reject locally | `asks.requestApproval` → `answer()` | allow locally |

`elicitation.form` is advertised under `ask` and `full` only.

Permission rules:
- **Options:** only options the agent offered are used. `allow` → its `allow_once` option; `deny` → its `reject_once`. When an option of the needed kind is absent, fall back to the same-direction `*_always` option. If neither exists, respond `cancelled` and record a deny.
- **Under `full`:** choose `allow_once` (else `allow_always`) and call `asks.recordAutoDecision(..., "allow")`.
- **Under `none` and `read`:** choose `reject_once` (else `reject_always`) and record a deny. Both auto-decisions emit `approval_requested` and `approval_resolved` with `decidedBy: "profile"`.
- **Untrusted input:** agent-supplied `kind`, `title` and `rawInput` are display data only (redacted and capped into `summary` / `command`). They are never used to decide. Under `read` nothing is approved because the agent labels it a read.
- **Expiry:** deadline → `reject_once` (`decidedBy: "timeout"`, S3 rule); turn cancel or process death → `cancelled`.

**Guarantees, stated as documented contract:**
- Agents without client fs (pi) cannot enforce `none` or `read` → `AGENT_SESSION_CAPABILITY_UNSUPPORTED` at open.
- Under `none` and `read`, Claude may still run internal read-only tools (for example search) without asking. `none` means no permitted side effects, not no reads.
- The agent process is not sandboxed; its unprompted internal tools are not wrapped. This is why `allowUnsandboxed: true` is required.

### 6.5 File and terminal handlers

They run through nax-agent's existing tool runtime:
- `fs/readTextFile` → the Read implementation; `fs/writeTextFile` → the Write implementation.
- Both with workdir containment and `OwnedPathsPolicy`, including the credential-directory and trust-store read-deny.
- `terminal/*` (`ask` / `full` only) runs commands through the same launcher and sandbox floor as native Bash, and enforces output byte limits.

A refusal returns an ACP error to the agent and no event. The agent's own `tool_call_update` reports the failure.

These handlers produce no extra session events; the agent's `tool_call` / `tool_call_update` stream already describes the operation.

### 6.6 MCP tool host (HTTP only)

- Started only when `tools` is non-empty.
- An in-process `@modelcontextprotocol/sdk` streamable-HTTP server on `127.0.0.1`, ephemeral port, path `/mcp`.
- Each session gets a random 32-byte bearer token. It is passed as `{ type: "http", name: "nax", url, headers: [{ name: "Authorization", value: "Bearer <token>" }] }`.
- Requests without the token → 401. Request bodies over 1 MiB → 413.
- `tools/list` is exactly the session's embedder tools: `name`, `description`, `inputSchema`. The agent sees them as `mcp__nax__<name>`.
- `tools/call`:
  - Rejected with an MCP tool error when no turn is active.
  - Otherwise runs the native embedder-tool path: `approval: "always"` → `asks.requestApproval`; then `run(input, { sessionId, toolCallId: "mcp-<n>", signal: turnSignal() })`; then `{ content, isError }` → MCP `CallToolResult`. A throw → `isError: true` with the message.
- On close: stopped and the token revoked. A reconnect or resume starts a new host with a new token and re-supplies `mcpServers`.
- No `tool_call` / `tool_result` events of its own: the agent's updates for `mcp__nax__*` carry them.

### 6.7 Event mapping (`events.ts`)

| ACP | Event |
|---|---|
| `agent_message_chunk` text | `text_delta { round: 0, text }` |
| `agent_message_chunk` non-text | dropped |
| `agent_thought_chunk` | `thinking_delta { round: 0, text }` |
| `tool_call` | `tool_call { callId: toolCallId, name, input }`: `name` is the first non-placeholder title seen for that id, else `kind`; `input` is `rawInput`, redacted and capped |
| `tool_call_update` status completed or failed | `tool_result { callId, isError: status === "failed", preview }`: the preview is built from content (text; a diff as `edit <path> (+a -b)`; terminal output), redacted and capped |
| `tool_call_update` other | updates title memory only |
| prompt-result `_meta.usage`, else the last `usage_update` | one `usage` event per turn, round 0: input/output/cache in nax-ai's vocabulary; `costUsd` and `costSource` per §5.5 |
| `plan`, `available_commands_update`, `current_mode_update`, `config_option_update` | dropped |
| `user_message_chunk` and any update during `session/load` | suppressed |

- `round` is always 0: ACP has no round concept visible to the client.
- `stream_reset` and `compaction` are never emitted by the ACP backend.
- Reasoning tokens are counted inside output tokens.
- `turn_end.output` is the concatenated agent message text of the turn.

### 6.8 Elicitation → `question`

Advertised under `ask` and `full`.
- **Message-only or single-field forms** (one string field, or one enum field): `asks.askQuestion(text)`, where the text includes the enum choices.
- **The reply:**
  - a string becomes the field value; an enum reply must match a choice, else decline
  - message-only forms accept with empty content
  - `null` (deadline, cancel) → decline
- **Any other schema:** emit a `question` event noting the decline, then decline.

### 6.9 Resume and reconnect (`resume.ts`)

1. **Validate the stored document:**
   - `backend` equals this backend's `kind`, else `AGENT_SESSION_BACKEND_MISMATCH`
   - `acp` is present, else `TRANSCRIPT_CORRUPT`
   - `acp.agent` matches
   - `acp.cwd` equals `workdir`, else `AGENT_SESSION_INVALID_OPTIONS`
2. **Spawn and initialize, then choose:**
   - `session/resume` if advertised (no replay)
   - else `session/load` with all updates suppressed until it returns
   - else `AGENT_SESSION_CAPABILITY_UNSUPPORTED`

   The backend never silently creates a fresh session. An agent "session not found" → `AGENT_SESSION_NOT_FOUND`.
3. **Identity:** the agent's session id must equal `acp.agentSessionId`, else `AGENT_SESSION_TURN_FAILED` with detail `identity`.
4. **Re-supply** `mcpServers` (new tool host), the mode and `model`.

The document's `messages` stay empty; the agent's own store holds history. The facade's `markTurn` handling is unchanged, so a turn left `running` by a dead process reports `interrupted`.

### 6.10 Registry entries (initial)

| Agent | Launch | Mode ids | Notes |
|---|---|---|---|
| claude | `claude-agent-acp`, else `npx -y @agentclientprotocol/claude-agent-acp@~0.85` | `plan`, `default` | first-class |
| codex | `codex-acp`, else `npx -y @agentclientprotocol/codex-acp@~2.1` | none (layer 2 skipped) | fs routing unverified |
| gemini | `gemini --acp` | none | MCP stdio only → tools unsupported in S4 |
| opencode | `opencode acp` | none | |
| pi | `pi-acp`, else `npx -y pi-acp@~0.0.34` | none | no client fs → `none`/`read` unsupported; no MCP |

Versions are pinned in the registry and bumped deliberately. The capability record, not the registry, is authoritative at runtime.

## 7. Errors

| Situation | Result |
|---|---|
| launch fails, exits or hangs past `initializeTimeoutMs` | `AGENT_SESSION_BACKEND_UNAVAILABLE` (stderr tail in `details`, redacted) |
| auth required | `AGENT_SESSION_AUTH_REQUIRED` |
| requirement unmet (profile, tools, resume, model) | `AGENT_SESSION_CAPABILITY_UNSUPPORTED` with `details.capability` |
| `allowUnsandboxed !== true` | `AGENT_SESSION_SANDBOX_UNAVAILABLE` |
| resume with another backend | `AGENT_SESSION_BACKEND_MISMATCH` |
| agent lost the session | `AGENT_SESSION_NOT_FOUND` |
| crash mid-turn | turn `errored`; next `send()` reconnects once, else `AGENT_SESSION_CLOSED` |
| ACP JSON-RPC error on prompt | turn `errored`, `error.code` = `AGENT_SESSION_TURN_FAILED` |

Agent error text is classified (auth, limit, not-found) before redaction, so the classification survives redaction.

## 8. Package and release

`packages/nax-agent-acp/package.json`:
- name `@nathapp/nax-agent-acp`, version `0.3.0`, ESM
- exports `./client` and `./server` (the latter an empty module with a doc comment)
- dependencies: `@agentclientprotocol/sdk ~1.7`, `@modelcontextprotocol/sdk ^1.30.0` (the range nax already uses), `zod ^4`
- peer dependencies: `@nathapp/nax-agent ^0.3.0`
- `files`: dist and docs only
- private in the workspace; npm publishes a staged `.publish/` manifest, exactly as nax-agent does (`stage-publish`)
- built by tsc (as nax-agent); gates mirror nax-agent's: complexity, boundary, API snapshot, per-file coverage floor, Node 22/24 contract, packed-tarball smoke

**Release (maintainer-run, approval at each gate):**
1. nax-agent 0.3.0.
2. nax-agent-acp 0.3.0, first publish. npm trusted publishing needs an existing package, so the first publish is manual with maintainer 2FA, then a trust entry with `--allow-publish` (D23 procedure).
3. Later releases go through `release.yml` and OIDC, unless the stage-publish switch lands first.

`release.yml` and the release helper learn the `nax-agent-acp-v*` tag and the shared nax-agent pin check.

## 9. Testing

- **Fake ACP agent** (`test/fixtures/fake-agent/`), built on the SDK's agent side and scriptable per test. It runs over in-memory paired streams (unit tests) and as a subprocess (launch, cancel, kill, crash tests). Scripts cover:
  - streaming text and thoughts
  - tool calls with each content type
  - permission requests with each option set
  - fs and terminal requests
  - elicitation shapes
  - the resume/load capability matrix
  - a session that has disappeared
  - auth errors
  - hangs and crashes
- **Conformance suite** parameterised by target: the fake agent always; Claude only with `NAX_AGENT_ACP_LIVE=1` (billed).
- **nax-agent 0.3.0:** the existing S3 suites move to `nativeBackend()`, unchanged in assertions. New tests cover native `ask` and the facade with a stub `SessionBackend`.
- **Node 22/24 contract and packed-tarball smoke** for both packages, against the fake agent.

## 10. Delivery

| PR | Scope |
|---|---|
| S4-0 | nax-agent 0.3.0 contract: `SessionBackend`, `SessionAskPort`, `nativeBackend()`, options break, profiles incl. native `ask`, contract additions (§5.5), README / CHANGELOG |
| S4-1 | `packages/nax-agent-acp` scaffold: workspace, tsc build, gates incl. boundary gate, API snapshot, coverage, CI job, release wiring; root `.nax/context.md` layout table and dependency direction (`nax-ai` → `nax-agent` → `nax-agent-acp`; nax gains it in S4b) plus a package `context.md`, then `nax generate` |
| S4-2 | `launch`, `registry`, `connection`, `capabilities`, lifecycle (§6.3), fake agent |
| S4-3 | `permissions`, `fs-terminal` (§6.4, §6.5) |
| S4-4 | `tool-host` (§6.6) |
| S4-5 | `events`, `elicitation` (§6.7, §6.8) |
| S4-6 | `resume` and reconnect (§6.9), `acpBackend()` end to end, docs, packed smoke, live-smoke fixture, RELEASING "S4 acceptance" |

Each PR has its own plan, which is final-reviewed before execution.

## 11. Acceptance

1. **CI** is green on the S4-6 merge commit: unit, conformance (fake agent), Node 22/24 and packed smoke for both packages.
2. **Billed live Claude smoke** (maintainer approval at launch), on the packed tarballs in a fresh Node project:
   - under `ask`: an approval round trip via `answer()`, and a file edit through our fs handler (the change is visible on disk)
   - an embedder tool called through MCP
   - a `question` round trip
   - `close()`, then `resumeAgentSession` from a new process, and the agent recalls the earlier turn
   - under `read`: a write attempt is rejected (`decidedBy: "profile"`)
   - a `usage` event recorded
   - Record the model, cost and commit.
3. **Initialize-only smoke** for codex, gemini, opencode and pi where installed: `initialize` plus `session/new`, no prompt. The resulting capability matrix is recorded in the master plan.
4. **nax unchanged:** `git diff --exit-code origin/main -- packages/nax/` is empty (aside from the lockfile), and the nax test suite passes. If S4-0 changes anything under `packages/nax-agent/src/native/` or `src/tools/`, the billed `nax run` S1-recipe smoke is also required (approval at launch).

## 12. Risks

| Risk | Mitigation |
|---|---|
| Adapter churn (claude-agent-acp ships often) | pinned ranges in the registry; capability record authoritative; the live conformance suite catches drift |
| SDK churn (1.x moving fast) | `~1.7` pin; builder API only; no `/experimental` or v2 |
| Native `ask` needs policy-engine changes | spike in the S4-0 plan; isolated task if needed |
| Bun stream interop with the SDK | the Node and Bun test matrix covers the fake agent over real subprocess pipes |
| Users read `profile: "read"` as a hard sandbox on ACP | the documented guarantees (§6.4) and the required `allowUnsandboxed: true` |

## 13. Handoff to S4b (not designed here)

- Map nax `permissionProfile` / `bashApproval` / stage modes onto `none|read|ask|full`.
- One-shot `complete()` over ACP.
- Context-pull tools rendered as text vs MCP.
- The idle watchdog.
- NO_SESSION recovery.
- Rate card and catalog pricing for `costSource: "unpriced"` rows.
- tool-audit records from ACP tool events.
- Cutover behind config, the billed `nax run` smoke on an ACP agent, then deleting `packages/nax/src/agents/acp/` and the `acpx` PATH dependency.
