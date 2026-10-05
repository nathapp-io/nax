# S4: ACP backend for nax-agent (`@nathapp/nax-agent-acp`)

**Status:** design approved in brainstorm 2026-10-05. Final-reviewed 2026-10-05 by two read-only reviewers (codebase/protocol accuracy; feasibility/security), both "ready after fixes". This revision is the single fix round.

**Master plan:** `nax-agent-master-plan.md` (maintainer workspace), row S4, decisions D24 and D25.

**Research:** maintainer workspace `projects/nax/s4-research/`, six reports:
- 01: nax's ACP client today
- 02: the S3 backend seam
- 03: acpx 0.19.4
- 04: pi 0.87.1
- 05: the ACP SDK and adapters
- 06: paperclip

**Baseline:** main `57ed87c17`, `@nathapp/nax-agent` 0.2.0, `@agentclientprotocol/sdk` 1.7.0, `@agentclientprotocol/claude-agent-acp` 0.85.1.

## 1. Goal

Let the S3 conversational session API drive external coding agents over ACP (Agent Client Protocol), with the same `send()` / `answer()` / `cancel()` / `close()` contract the native backend has. Claude Code is the first-class agent. Codex, Gemini CLI, OpenCode and pi are registered and capability-checked.

S4 delivers:

- `@nathapp/nax-agent` **0.3.0**:
  - a backend seam (`SessionBackend`), and the native backend behind it (`nativeBackend()`)
  - four profiles, `none | read | ask | full`
  - a public "backend kit" of helpers a second backend needs

  This is a deliberate breaking change; nax-agent has no external consumers yet.
- `@nathapp/nax-agent-acp` **0.3.0** (new package, versioned in step with nax-agent):
  - `./client` = `acpBackend()`, nax-agent's own ACP client on the official SDK
  - `./server` is reserved for S5 and empty in S4

## 2. Context and decisions

### 2.1 What exists today

- nax's ACP path (`packages/nax/src/agents/acp/`, 23 files, 4.3k lines) is not a protocol client. It spawns the `acpx` CLI once per turn and parses its NDJSON output.
- Permissions are all-or-nothing (`--approve-all`); nax never sees `session/request_permission`.
- Tool calls surface as names only; there is no MCP support.
- After `sessions close`, a resume silently starts a fresh, context-less session.
- The S3 facade reaches its backend only through the S1 `AgentSessionAdapter` contract, but it is hard-wired to `NativeSessionAdapter` in `createAdapter` / `assemble` (`packages/nax-agent/src/session/agent-session.ts`).

**Adapter fact (verified in `claude-agent-acp` 0.85.1 and `codex-acp` 2.1.1):** neither adapter ever calls the client's `fs/*` or `terminal/*` methods. Claude's Read/Edit/Write/Bash and Codex's tools run inside the adapter process. Client fs and terminal capabilities would therefore change nothing for the agents S4 targets. S4 does not advertise them (§6.4).

### 2.2 Decisions (brainstorm and final review, 2026-10-05)

| # | Decision |
|---|---|
| R1 | **Own ACP client on `@agentclientprotocol/sdk`** (stable protocol v1, `ClientApp` builder), not the acpx CLI and not `acpx/runtime`. Reasons (D25): acpx's runtime events are lossy (paperclip carries about 1k lines of patches and still lacks tool content); an own client answers each `request_permission` itself, keeps full tool-call content and usage, and controls `mcpServers` and session options; S5 needs the same SDK. Ideas, not code, are taken from acpx's registry and session handling. |
| R2 | **Separate package `@nathapp/nax-agent-acp`**: `./client` (S4), `./server` (reserved for S5). Core nax-agent never imports ACP. |
| R3 | **Split S4 / S4b.** S4 = the library backend. S4b (its own spec) moves `nax run`'s ACP path onto it, moves pricing, maps nax permission modes, and deletes the acpx wrapper. nax's acpx wrapper is untouched in S4. |
| R4 | **Agent coverage:** Claude first-class (billed live smoke and conformance suite). Codex, Gemini, OpenCode and pi are registered with a capability matrix and an initialize-only smoke. Adapters authenticate themselves; S4 passes their auth variables through (§6.2) and reports typed auth errors. |
| R5 | **Clean 0.3.0 contract break**, no compatibility layer. nax does not use the facade. |
| R6 | **Profiles `none \| read \| ask \| full`: the same contract on both backends; enforcement differs.** Native enforces in its own tool runtime. ACP enforces through the agent's mode and the permission gate, so its guarantees cover only actions the agent routes through `request_permission` (§6.4). |
| R7 | **`acpBackend` always requires `allowUnsandboxed: true`**: the agent process runs on the host, unsandboxed. |
| R8 | **MCP tool host is HTTP-only in S4**; a stdio bridge is deferred. |
| R9 | **Elicitation:** message-only and single-field forms become `question` events; richer forms are declined. |
| R10 | **Versioning:** nax-agent-acp starts at 0.3.0, in step with nax-agent. Both are released together and always bump together (the `^0.3.0` peer range admits only 0.3.x). Everything goes 1.0.0 together after S6. |
| R11 | **No client fs/terminal in S4** (final review): no targeted adapter calls them. The handlers are out of scope until an agent that uses them becomes first-class. |
| R12 | **Embedder tools are pre-approved at the adapter** (final review, paperclip pattern). Their `request_permission` would otherwise break `none` and `read` and double-prompt under `ask`. Our tool host is the only approval point for them (§6.6). |

## 3. Out of scope

- The `nax run` cutover, the ACP rate card and pricing, the permission-mode mapping, and deleting `packages/nax/src/agents/acp/` (all S4b).
- The ACP server (S5): the `./server` subpath is reserved only.
- Client `fs/*` and `terminal/*` handlers (R11).
- A stdio MCP bridge, the MCP-over-ACP draft, and an MCP client for embedder-supplied servers.
- Sandboxing the agent process.
- Images and resources in prompts or replies.
- `plan`, available-commands, mode and config updates as events.
- `allow_always` decisions.
- Full support for Codex, Gemini, OpenCode or pi.
- Switching releases to `npm stage publish` (tracked separately).

## 4. Architecture

```
@nathapp/nax-ai            providers, pricing                       (unchanged)
        ▲
@nathapp/nax-agent 0.3.0   contract + native backend + backend kit
  session facade: createAgentSession / resumeAgentSession (backend injected)
  SessionBackend, SessionAskPort, events, error codes, TranscriptStore
  nativeBackend(): loop, tools, permissions, sandbox
  backend kit (public): redaction/caps, process-group kill, stderr tail, AgentSessionError
        ▲ peer dependency
@nathapp/nax-agent-acp 0.3.0
  ./client  acpBackend(): SessionBackend over @agentclientprotocol/sdk
  ./server  reserved (S5)
        ▲
consumers: koda (S6); nax CLI after S4b
```

Dependency direction is one way. nax-agent-acp imports only:
- nax-agent's public entry `.`; never `./internal`, which stays nax's coupling surface
- `@agentclientprotocol/sdk`, `@modelcontextprotocol/sdk` and `zod`

A boundary gate enforces this (S4-1). Every nax-agent symbol the ACP client needs is exported from `.` in S4-0, listed in §5.6.

## 5. nax-agent 0.3.0: the backend seam

### 5.1 `SessionBackend` and `SessionAskPort`

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
  readonly resume: { readonly doc: TranscriptDoc } | undefined;   // the facade loads and schema-checks it first
  readonly asks: SessionAskPort;
  readonly turnSignal: () => AbortSignal;   // re-read at use time; aborts on cancel, timeout and close
  readonly currentTurnId: () => string | undefined;
  readonly turnTimeoutSeconds: number;
  readonly metadata: Readonly<Record<string, string>>;
  readonly openSignal: AbortSignal;         // aborted when close() runs during open or reconnect
}

export interface OpenedBackend {
  readonly adapter: AgentSessionAdapter;    // the existing S1 contract
  readonly handle: SessionHandle;
  readonly info: BackendInfo;
  /** Per-turn SendTurnOpts the backend contributes (codingTools, interactionHandler, loopHandlers, ...). */
  turnOpts(): Partial<SendTurnOpts>;
  /** Releases backend resources after adapter.closeSession. Idempotent. */
  close(): Promise<void>;
}

export interface BackendInfo {
  readonly kind: string;
  /** Read-only, JSON-safe capability summary (ACP: from initialize); {} for native. */
  readonly capabilities: Readonly<Record<string, unknown>>;
}
```

`AgentSession` gains `readonly backend: BackendInfo`, so S6 (koda) can show what a session can do without provoking an error.

`SessionAskPort` is the existing ask plumbing made public: the pending-ask table, `approval_requested` / `approval_resolved` / `question` emission, the deadline, and settlement on `answer()`, deadline or turn signal.

```ts
export interface SessionAskPort {
  /** Throws AGENT_SESSION_TURN_FAILED (detail "no-turn") when no turn is active. */
  requestApproval(req: { callId?: string; tool: string; summary: string; command?: string; reason: string }):
    Promise<{ decision: "allow" | "deny"; decidedBy: ApprovalDecidedBy }>;
  /** Emits approval_requested then approval_resolved (decidedBy "profile") with a fresh requestId; never enters the pending table. No-op when no turn is active. */
  recordAutoDecision(req: { callId?: string; tool: string; summary: string; reason: string }, decision: "allow" | "deny"): void;
  /** null on deadline, cancel or no active turn. */
  askQuestion(text: string): Promise<string | null>;
  /** Informational question event with a fresh requestId; answer() on it returns "cancelled". */
  noteQuestion(text: string): void;
}
```

The facade keeps:
- the single-flight guard, `claimTurn` / `runTurn`, `markTurn(running|ended)`, and `turn_end` derivation
- the event channel, the error codes and the deadlines

`assemble()` shrinks to: resolve the root, build the ask port, call `backend.open(ctx)`, and build `TurnRunContext` from the result.

### 5.2 `nativeBackend()`

Everything native moves unchanged into `nativeBackend(opts)` (new module `session/native-backend.ts`):
- the sandbox launcher and floor
- `protectedPaths` merging
- `buildSessionToolSupport` and the interaction handler with built-in tools
- `NativeSessionAdapter` construction
- the spin breaker, `SESSION_TRANSPORT_RETRY`, loop handlers
- resume via `TranscriptDoc.messages`

```ts
nativeBackend({
  model: string;                       // required
  credentials?; catalogOverrides?; loopHandlers?; hostPorts?;
  bashApproval?: BashApprovalMode;     // profiles ask/full only; ask forces "gated" (raw → INVALID_OPTIONS)
  allowUnsandboxed?: boolean;          // profiles ask/full only
}): SessionBackend                     // kind "native"
```

The facade-level `loadResumable` keeps only the presence, schema and corruption checks. The model check (`AGENT_SESSION_MODEL_MISMATCH`) and the `messages` handling move into the native backend's resume.

### 5.3 Facade options (breaking)

```ts
createAgentSession({
  backend: SessionBackend;             // required; replaces backend: "native"
  sessionId?; profile; workdir?; instructions?; tools?;
  transcriptStore; approvalTimeoutMs?; turnTimeoutSeconds?; metadata?;
})
resumeAgentSession(sessionId, { backend, ...same shared options })
```

- **Moved into `nativeBackend()`:** every field of 0.2.0 `CreateAgentSessionOptions` not in the shared list above. That is `model`, `credentials`, `catalogOverrides`, `loopHandlers`, `hostPorts`, `bashApproval`, `allowUnsandboxed`.
- **Proof of completeness:** S4-0 derives the list from the 0.2.0 options type, and the API-snapshot diff in the PR is the evidence.
- **Validation:** the facade checks that `backend` has `kind` and `open`, and that `profile` is one of the four. Backend-specific options are validated (zod) by their factory. A native-only field next to an ACP backend is impossible by type.

### 5.4 Profiles

The shared type becomes `AgentSessionProfile = "none" | "read" | "ask" | "full"`.

| Profile | Meaning | Native backend |
|---|---|---|
| `none` | no permitted side effects | embedder tools and the scratchpad trio (unchanged) |
| `read` | read-only | plus Read, Glob, Grep, read-only Git (unchanged) |
| `ask` | everything; every mutating action approved by the caller | the `full` tool set, with `askRules` (`patterns: ["*"]`) forcing the ask tier for Write, Edit, Delete and GitCommit; Bash asks via `bashApproval: "gated"`, which `ask` forces. The sandbox launcher and floor apply as for `full`. New. |
| `full` | everything, no prompts | 0.2.0 `full` unchanged: `bashApproval` and the sandbox floor apply |

- Feasibility is verified: `askRules` reach the path tools (`policy.ts`, `policy-paths-branch.ts`), and the runtime routes ask verdicts to the resolver (`runtime.ts`). Under `raw` the command branch returns before ask rules, which is why `ask` forces `gated`.
- `checkProfileRules` (`agent-session-options.ts`) moves into `nativeBackend` and treats `ask` like `full` for `bashApproval` / `allowUnsandboxed`.
- Embedder tools declared `approval: "always"` ask under every profile.
- `workdir` is required for every profile except `none`, as before.

### 5.5 Contract additions

- **Error codes** (added to the `AgentSessionErrorCode` union and the API snapshot):
  - `AGENT_SESSION_BACKEND_UNAVAILABLE`: the agent cannot be launched, exits during initialize, or initialize times out.
  - `AGENT_SESSION_AUTH_REQUIRED`: the backend reports an authentication failure.
  - `AGENT_SESSION_CAPABILITY_UNSUPPORTED`: the backend cannot meet a requirement (profile, tools, resume, model); `details.capability` names it.
  - `AGENT_SESSION_BACKEND_MISMATCH`: resuming with a backend whose `kind` differs from the stored one.
- **`ApprovalDecidedBy`** gains `"profile"`.
- **Usage cost source:** `costSource?: "computed" | "reported" | "unpriced"` is added to the `usage` body of both `SessionEventBody` and `TurnEvent`, and to `TurnResult`.
  - native sets `computed`
  - ACP sets `reported` when the agent reports a cost, else `unpriced` with `costUsd: 0`
  - absent means `computed`
  - readers that sum `costUsd` must skip `unpriced` rows; this is documented in the README
- **`TranscriptDoc`** gains optional fields:
  - `backend?: string`: absent means `"native"`
  - `acp?: { agentSessionId: string; agent: string; agentVersion?: string; cwd: string }`

  `schemaVersion` stays 1 (additive). The file store spreads unknown fields, so `markTurn` preserves them.
- **Old documents:**
  - A 0.2.0 document has no `backend`, reads as native, and resuming it with `acpBackend` → `AGENT_SESSION_BACKEND_MISMATCH`.
  - A 0.2.0 reader opening an ACP document would see empty `messages`. Accepted, because 0.2.0 has no consumers; documented.

### 5.6 Backend kit (public exports added to `.`)

- `redactSecrets` and `capStrings`, plus the event byte caps (`TOOL_CALL_INPUT_CAP` 8192, `TOOL_RESULT_PREVIEW_CAP` 4096). Today they are on `./internal` and the native sink.
- `killProcessGroup` and `isProcessAlive` (today `./internal`).
- A bounded `StderrTail` (rolling buffer, control-character stripping, redaction on read).
- `AgentSessionError` and the error-code union (already public).

S4-0 lists exact export names in its plan, and the API snapshot pins them. Nothing else moves; `./internal` stays as is for nax.

### 5.7 How a backend ends a turn

The facade derives `turn_end` from the adapter's `TurnResult` or thrown error. `cancelled` / `timed_out` are reported only when the turn signal aborted. A backend therefore:
- returns a `TurnResult` for a completed turn
- throws an `AgentSessionError` or `NaxError` whose code becomes `turn_end.error.code` for everything else

ACP stop-reason codes are `NaxError` codes owned by nax-agent-acp (not members of `AgentSessionErrorCode`):
- `ACP_STOP_MAX_TOKENS`
- `ACP_STOP_MAX_TURN_REQUESTS`
- `ACP_STOP_REFUSAL`
- `ACP_STOP_CANCELLED` (agent-initiated cancel without our abort)

## 6. `@nathapp/nax-agent-acp/client`

### 6.1 Modules (`packages/nax-agent-acp/src/client/`)

| Module | Responsibility |
|---|---|
| `backend.ts` | `acpBackend(opts)`: implements `SessionBackend`; owns its internal `AgentSessionAdapter` |
| `registry.ts` | launch data per agent (§6.10): command candidates, mode ids, auth env vars, pre-approval support |
| `launch.ts` | spawn as a process-group leader; `ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))`; stderr into a `StderrTail`; kill via `killProcessGroup` |
| `connection.ts` | `ClientApp` built once per process and attached with `connect(stream)` (long-lived, not `connectWith`). Methods: `initialize`; `session/new`, `session/resume`, `session/load`, `session/close`, `session/set_config_option {sessionId, configId, value}` and `session/cancel` via the connection's request API; inbound handlers |
| `capabilities.ts` | capability record from `initialize` plus registry data; requirement checks; fail closed for unknown agents |
| `permissions.ts` | inbound `session/request_permission` (§6.4) |
| `tool-host.ts` | HTTP MCP server for embedder tools (§6.6) |
| `events.ts` | `session/update` → `TurnEvent`; per-turn usage (§6.7) |
| `elicitation.ts` | inbound elicitation → `question` (§6.8) |
| `resume.ts` | resume/load and the reconnect path (§6.9) |

### 6.2 `acpBackend` options (validated with zod)

```ts
acpBackend({
  agent: "claude" | "codex" | "gemini" | "opencode" | "pi" | { name: string; command: string; args?: string[] };
  allowUnsandboxed: true;              // required (R7); anything else → AGENT_SESSION_SANDBOX_UNAVAILABLE
  model?: string;                      // applied via session/set_config_option (category "model") before open returns
  env?: Record<string, string>;        // added to the agent's environment
  inheritEnv?: boolean;                // default false: allowlist only (below)
  command?: string; args?: string[];   // override the registry's launch command
  cancelGraceMs?: number;              // default 10_000
  initializeTimeoutMs?: number;        // default 60_000 (covers an npx download)
}): SessionBackend                     // kind "acp:<agent name>"
```

**Agent environment:** by default, an allowlist:
- `PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR`, `LANG`, `LC_*`, `TERM`
- the agent's auth variables from the registry (for example `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`)
- `env`

`inheritEnv: true` passes the whole `process.env` instead (documented as handing the embedder's credentials to the agent). Values of any `env` key matching `KEY|TOKEN|SECRET|PASSWORD` join the redaction set for the stderr tail and events.

**Custom agents** (`{ name, command }`) have no registry data: no mode ids, no pre-approval, no auth variables. Their requirements fail closed: `none`/`read`/tools → `CAPABILITY_UNSUPPORTED` unless the agent's `initialize` proves them.

### 6.3 Lifecycle

1. **Open** (abortable via `openSignal`; `close()` during open kills the process group and rejects with `AGENT_SESSION_CLOSED`):
   1. spawn; `initialize` (protocol v1, client capabilities: no fs, no terminal; `elicitation.form` under `ask`/`full`)
   2. build the capability record and check requirements: the profile is enforceable (§6.4), tools need `mcpCapabilities.http` and registry pre-approval, resume needs `session/resume` or `loadSession`, and `model` needs a model config option. A failure → `AGENT_SESSION_CAPABILITY_UNSUPPORTED` before any prompt.
   3. start the tool host if there are tools
   4. `session/new { cwd: workdir, mcpServers, _meta }` (pre-approval, §6.6), or the resume path (§6.9)
   5. apply the profile's mode, then `model`, via `set_config_option`
   6. write the initial document `{ backend, acp: { agentSessionId, agent, agentVersion, cwd }, messages: [], savedAt }` with `transcriptStore.save`, then return

   The facade's `AGENT_SESSION_EXISTS` check runs before step 1. A crash between `session/new` and the save loses the agent session id; the next `createAgentSession` with the same id starts fresh. This is documented.

   Error mapping:
   - spawn failure, exit during initialize, or `initializeTimeoutMs` elapsing → `AGENT_SESSION_BACKEND_UNAVAILABLE`, with a redacted, capped (4 KB) stderr excerpt
   - an ACP auth error, or `authMethods` with no usable session → `AGENT_SESSION_AUTH_REQUIRED`
2. **Turn:**
   - `session/prompt` with the message; `instructions` is prepended to the first prompt only (ACP has no system-prompt field; documented)
   - updates stream through `events.ts`
   - stop reasons: `end_turn` → `TurnResult` (`completed`); others → the `ACP_STOP_*` errors (§5.7)
   - `cancelled` after our own abort → the facade reports `cancelled` / `timed_out` from the signal
3. **Abort** (the turn signal aborts on `cancel()`, on the facade's turn timeout, and on `close()`, all handled identically):
   1. `session/cancel`
   2. wait up to `cancelGraceMs` for the prompt to settle
   3. otherwise kill the process group and mark the session disconnected

   A kill means the next `send()` must reconnect (step 5). For an agent without resume/load, that `send()` throws `AGENT_SESSION_CLOSED`; this is a documented consequence of a hard cancel.
4. **Close:** bounded overall by `cancelGraceMs × 2`:
   1. abort any turn as in step 3
   2. `session/close` if advertised (within the bound)
   3. close stdin; SIGTERM the group, then SIGKILL after the grace
   4. stop the tool host and revoke its token
   5. `transcriptStore.save` the document with its final `savedAt`

   Idempotent.
5. **Crash and reconnect** (process exit outside close):
   - the running turn throws `AGENT_SESSION_BACKEND_UNAVAILABLE`, so `turn_end` is `errored`
   - pending asks and questions settle as `cancelled` at once
   - the session is marked disconnected
   - the next `send()` claims the turn slot, writes `markTurn(running)`, then attempts one reconnect via §6.9 before prompting
   - if the reconnect fails, the turn ends `errored` and later `send()`s throw `AGENT_SESSION_CLOSED`

   Writing `markTurn(running)` before the reconnect means a crash during reconnect resumes as `interrupted`. `close()` during a reconnect aborts it via `openSignal`.

**Inbound requests with no active turn:**
- `request_permission` → reject (`reject_once`, else `cancelled`), logged, no event
- elicitation → `cancel`
- MCP `tools/call` → MCP tool error "no active turn"
- any inbound request during `session/load` replay → the same

### 6.4 Profiles on ACP and permissions

ACP enforcement has two layers. Client fs/terminal are never advertised (R11).

| Layer | `none` | `read` | `ask` | `full` |
|---|---|---|---|---|
| 1. Agent mode (registry mode ids; Claude: config option `mode`) | `plan` | `plan` | `default` | `default` |
| 2. `request_permission` (embedder tools excluded, §6.6) | reject locally | reject locally | `asks.requestApproval` → `answer()` | allow locally |

- **Enforceability:** `none` and `read` require a registry mode id for a read-only mode. Agents without one (codex, gemini, opencode, pi, custom) → `AGENT_SESSION_CAPABILITY_UNSUPPORTED` for `none` and `read`. `ask` and `full` need only the permission gate.
- **Options:** only options the agent offered are used. `allow` → its `allow_once`; `deny` → its `reject_once`.
  - When `allow_once` is absent: under `ask`/`full` the request is denied with `reject_once`, the reason "agent offered no allow-once option", and `decidedBy` "profile". `allow_always` is never chosen, because it would persist beyond the session.
  - When `reject_once` is absent: respond `cancelled`, recorded as a deny.
- **Auto-decisions:** under `full`, `allow_once` plus `asks.recordAutoDecision(..., "allow")`. Under `none` / `read`, `reject_once` plus `recordAutoDecision(..., "deny")`. Both emit `approval_requested` and `approval_resolved` with `decidedBy: "profile"`.
- **Untrusted fields:** the agent-supplied `kind`, `title` and `rawInput` are display data only (redacted and capped into `summary` / `command`). They never decide.
- **Expiry:** deadline → `reject_once` (`decidedBy: "timeout"`); turn abort or process death → `cancelled`.

**Guarantees** (documented contract, R6):
- **`none` / `read` on Claude:** `plan` mode plus rejection of every permission request. The agent may still run tools it does not ask about (reads, search). `none` means no permitted side effects, not no reads.
- **`ask` on ACP:** every action the agent routes through `request_permission` is approved by the caller. Actions the agent's own mode allows without asking are not seen. For Claude `default` this means reads and other non-mutating tools.
- **The agent process is unsandboxed** (R7): its tools run on the host with the agent's own permissions.

### 6.5 (Removed) Client fs/terminal handlers

Out of scope (R11). Never advertised in S4.

### 6.6 MCP tool host (HTTP only)

- **Start:** only when `tools` is non-empty. Requires `mcpCapabilities.http` and registry pre-approval support, else `AGENT_SESSION_CAPABILITY_UNSUPPORTED` (`details.capability: "tools"`).
- **Server:** an in-process `@modelcontextprotocol/sdk` streamable-HTTP server, bound explicitly to `127.0.0.1` (not `localhost`), on an ephemeral port, path `/mcp`.
- **Token:** a random 32-byte bearer token per host, passed as `{ type: "http", name: "nax", url, headers: [{ name: "Authorization", value: "Bearer <token>" }] }`.
- **Request checks:**
  - token compared in constant time; missing or wrong → 401
  - the `Host` header must be `127.0.0.1:<port>` (DNS rebinding) and any `Origin` header is rejected → 403
  - no CORS headers
  - bodies over 1 MiB → 413
  - at most 8 concurrent `tools/call` → MCP tool error beyond that
- **Token secrecy:** the token joins the redaction set for events, errors and the stderr tail. It is never written to `env` or the transcript document.
- **Accepted threat:** a local process of the same user could reach the port but not pass the token check.
- **Pre-approval (R12):** for Claude, `session/new._meta.claudeCode.options.allowedTools` includes the server's rule (`mcp__nax`; the exact rule string is verified in the S4-4 plan), so the adapter never asks permission for embedder tools. The host is their only approval point:
  - `approval: "always"` → `asks.requestApproval`
  - `"never"` → runs under every profile, matching native `none`
- **`tools/list`:** exactly the session's embedder tools (`name`, `description`, `inputSchema`). The agent sees them as `mcp__nax__<name>`.
- **`tools/call`:**
  - reads `currentTurnId()` and `turnSignal()` at call time; with no turn, an MCP tool error
  - otherwise runs `run(input, { sessionId, toolCallId: "mcp-<n>", signal })`, where `signal` is the turn signal, so a call that outlives its turn aborts
  - `{ content, isError }` → MCP `CallToolResult`; a throw → `isError: true` with the message
- **Close and resume:** stopped, and the token revoked, on close. Reconnect and resume start a new host with a new token and re-supply `mcpServers` and `_meta`.
- **Events:** none of its own; the agent's updates for `mcp__nax__*` carry `tool_call` / `tool_result`.

### 6.7 Event mapping and usage (`events.ts`)

| ACP `session/update` | Event |
|---|---|
| `agent_message_chunk` text | `text_delta { round: 0, text }` |
| `agent_message_chunk` non-text | dropped |
| `agent_thought_chunk` | `thinking_delta { round: 0, text }` |
| `tool_call` | `tool_call { callId: toolCallId, name, input }`: `name` is the first title seen for that id that is non-empty and not a placeholder (`"tool call"`, `"Tool"`, case-insensitive), capped at 200 characters, else `kind`; `input` is `rawInput`, redacted and capped |
| `tool_call_update` status completed or failed | `tool_result { callId, isError: status === "failed", preview }`: the preview is built from content (text; a diff as `edit <path> (+a -b)`; terminal output), redacted and capped |
| `tool_call_update` other | updates title memory only |
| `plan`, `available_commands_update`, `current_mode_update`, `config_option_update` | dropped |
| `user_message_chunk`, and any update during `session/load` | suppressed |

`round` is always 0. `stream_reset` and `compaction` are never emitted by the ACP backend. `turn_end.output` is the turn's concatenated agent message text.

**Usage** (per turn; one `usage` event at turn end):
- **Tokens:** `PromptResponse.usage` (`inputTokens`, `outputTokens`, `thoughtTokens?`, `cachedReadTokens?`, `cachedWriteTokens?`) is session-cumulative. The per-turn value is the delta against the cumulative totals recorded after the previous turn.
- **Baseline:** taken at open, resume and reconnect from the first reported value; the agent may restart its counters at zero. A delta that goes negative resets the baseline and reports that turn's raw values.
- **Mapping:** output tokens = `outputTokens + thoughtTokens`; cache read and write map to `cacheRead` / `cacheWrite`.
- **Cost:** the delta of `usage_update.cost.amount` (session-cumulative, USD only) with `costSource: "reported"`. With no cost reported: `costUsd: 0`, `costSource: "unpriced"`.
- **No usage reported at all:** zeros with `unpriced`.

### 6.8 Elicitation → `question`

Advertised under `ask` and `full` (`elicitation.form`). Responses use the protocol's actions `accept`, `decline` and `cancel`.
- **Message-only form:** `asks.askQuestion(message)`. A reply → `accept` with empty content; `null` → `cancel`.
- **Single string field:** a reply → `accept` with that field.
- **Single enum field:** the question lists the choices. The reply matches a choice after trimming, case-insensitively → `accept`; no match → `decline`.
- **Any other schema:** `asks.noteQuestion("declined: <message>")`, then `decline`.

### 6.9 Resume and reconnect (`resume.ts`)

1. **Validate the stored document** (the facade already checked presence and schema):
   - `backend` equals this backend's `kind`, else `AGENT_SESSION_BACKEND_MISMATCH`
   - `acp` is present, else `TRANSCRIPT_CORRUPT`
   - `acp.agent` matches
   - `acp.cwd` equals `workdir`, else `AGENT_SESSION_INVALID_OPTIONS`
2. **Spawn and initialize, then choose:**
   - `session/resume` if advertised (no replay)
   - else `session/load`, with all updates suppressed and inbound requests refused until it returns
   - else `AGENT_SESSION_CAPABILITY_UNSUPPORTED`

   The backend never silently creates a fresh session. An agent "session not found" → `AGENT_SESSION_NOT_FOUND`.
3. **Identity:** the session the agent resumes must be `acp.agentSessionId`. A mismatch → `AGENT_SESSION_TURN_FAILED`, detail `identity`.
4. **Re-supply:** `mcpServers` and `_meta` (new tool host), then the mode and `model`; reset the usage baseline.

The document's `messages` stay empty; the agent's own store holds history. The facade's `markTurn` handling is unchanged, so a turn left `running` by a dead process reports `interrupted`.

### 6.10 Registry entries (initial)

| Agent | Launch | Read-only mode | Pre-approval | Auth env |
|---|---|---|---|---|
| claude | `claude-agent-acp`, else `npx -y @agentclientprotocol/claude-agent-acp@~0.85.1` | `plan` (config `mode`) | `_meta.claudeCode.options.allowedTools` | `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` |
| codex | `codex-acp`, else `npx -y @agentclientprotocol/codex-acp@~2.1.1` | none | none | `OPENAI_API_KEY` |
| gemini | `gemini --acp` | none | none | `GEMINI_API_KEY` |
| opencode | `opencode acp` | none | none | none |
| pi | `pi-acp`, else `npx -y pi-acp@0.0.34` (exact: tilde does not pin 0.0.x) | none | none | none |

- Only Claude supports `none`/`read`/tools in S4. The others support `ask`/`full` text sessions. That is what the initialize-only smoke records.
- Versions are bumped deliberately.
- The capability record is authoritative at runtime, and only narrows what the registry allows.

## 7. Errors

| Situation | Result |
|---|---|
| launch fails, exits during initialize, or initialize times out | `AGENT_SESSION_BACKEND_UNAVAILABLE` |
| auth required | `AGENT_SESSION_AUTH_REQUIRED` |
| requirement unmet (profile, tools, resume, model) | `AGENT_SESSION_CAPABILITY_UNSUPPORTED` (`details.capability`) |
| `allowUnsandboxed !== true` | `AGENT_SESSION_SANDBOX_UNAVAILABLE` |
| resume with another backend | `AGENT_SESSION_BACKEND_MISMATCH` |
| agent lost the session | `AGENT_SESSION_NOT_FOUND` |
| resumed identity differs | `AGENT_SESSION_TURN_FAILED` (`identity`) |
| crash mid-turn | turn `errored`; next `send()` reconnects once, else `AGENT_SESSION_CLOSED` |
| non-`end_turn` stop | turn `errored` with an `ACP_STOP_*` code |
| ACP JSON-RPC error on prompt | turn `errored`, `AGENT_SESSION_TURN_FAILED` |

**Agent text in errors:**
- Classification (auth, limit, not-found) runs on the raw agent text inside the backend.
- Only the classified code and a redacted, control-stripped excerpt of at most 4 KB escape into `details` or events.
- The redaction set includes known secret patterns, the tool-host token and secret-named `env` values.

## 8. Package and release

`packages/nax-agent-acp/package.json`:
- name `@nathapp/nax-agent-acp`, version `0.3.0`, ESM
- exports `./client` and `./server` (an empty module with a doc comment)
- dependencies: `@agentclientprotocol/sdk ~1.7.0`, `@modelcontextprotocol/sdk ^1.30.0` (the range nax uses), `zod ^4.3.6`
- peer dependency `@nathapp/nax-agent ^0.3.0`; in the workspace `workspace:*`, rewritten to `^0.3.0` by its `stage-publish`
- private in the workspace; npm publishes a staged `.publish/` manifest, as nax-agent does; `files`: dist and docs
- built by tsc; gates mirror nax-agent's: complexity, boundary (§4), API snapshot, per-file coverage floor, Node 22/24 contract, packed-tarball smoke

**Release machinery (S4-1):**
- `release.yml`: the `nax-agent-acp-v*` tag trigger, the resolve-package case, and pre-publish checks keyed on the package name (gates, the nax-agent peer published check, stage-publish).
- The release helper learns the tag.
- A package `RELEASING.md` (first publish and later releases).
- The root `.nax/context.md` and a package `context.md` record the new package. Run `nax generate` after.

Release order: nax-ai → nax-agent → nax-agent-acp → nax. nax does not depend on nax-agent-acp until S4b.

**Releases (maintainer-run, approval at each gate):**
1. nax-agent 0.3.0.
2. nax-agent-acp 0.3.0, first publish. npm trusted publishing needs an existing package, so the first publish is manual with maintainer 2FA, then a trust entry with `--allow-publish` (the D23 procedure).
3. Later releases go through `release.yml` and OIDC.

## 9. Testing

- **Fake ACP agent** (`test/fixtures/fake-agent/`), built on the SDK's agent side and scriptable per test. It runs over in-memory paired streams (unit) and as a subprocess (launch, abort, kill, crash). Scripts cover:
  - streaming text and thoughts
  - tool calls with each content type
  - permission requests with each option set
  - pre-approval `_meta` capture
  - elicitation shapes
  - cumulative usage including a counter reset
  - the resume/load capability matrix
  - a session that has disappeared
  - identity mismatch
  - auth errors
  - hangs, crashes, malformed JSON-RPC and oversized frames
  - inbound requests with no active turn
- **Conformance suite** parameterised by target: the fake agent always; Claude only with `NAX_AGENT_ACP_LIVE=1` (billed).
- **MCP host security tests:** missing or wrong token, wrong `Host`, an `Origin` header, an oversized body, the concurrency cap, a call after turn end, a call after close.
- **nax-agent 0.3.0:**
  - the S3 suites move to `nativeBackend()` with unchanged assertions
  - new tests: native `ask` (each tool kind, Bash forced `gated`), the facade with a stub `SessionBackend` (open abort, close during open, reconnect ordering), `costSource`, `decidedBy: "profile"`
- **Node 22/24 contract and packed-tarball smoke** for both packages, against the fake agent. The acp smoke installs both local tarballs.

## 10. Delivery

| PR | Scope |
|---|---|
| S4-0 | nax-agent 0.3.0 contract: `SessionBackend`, `SessionAskPort`, `BackendInfo`, `nativeBackend()`, options break, profiles incl. native `ask`, §5.5 additions, the §5.6 backend kit, README and CHANGELOG. **Done when:** the nax-agent gates pass; the nax suite and `bun run typecheck` pass; if any change touches nax-agent `native/`, `tools/`, `permissions/`, `session/` or `internal/` (expected), the billed `nax run` S1-recipe smoke passes (approval at launch). |
| S4-1 | `packages/nax-agent-acp` scaffold: workspace, tsc build, gates incl. the boundary gate, API snapshot, coverage, CI job, release machinery (§8), context files, and the agent registry data (§6.10, `src/client/registry.ts`, not exported) |
| S4-2 | `launch` (on the S4-1 registry), `connection`, `capabilities`, the lifecycle (§6.3), the fake agent, and a minimal `acpBackend()` end to end for text-only `full` sessions |
| S4-3 | `permissions` (§6.4), all four profiles end to end |
| S4-4 | `tool-host` and pre-approval (§6.6) |
| S4-5 | `events` and usage, `elicitation` (§6.7, §6.8) |
| S4-6 | `resume` and reconnect (§6.9), docs, packed smoke, the live-smoke fixture, RELEASING "S4 acceptance" |

Nothing is released before S4-6, so partial `./client` states are never published. Each PR has its own plan, final-reviewed before execution. S4-3 to S4-6 build on S4-2's fake agent and lifecycle.

## 11. Acceptance

1. **CI** is green on the S4-6 merge commit: unit, conformance (fake agent), MCP security tests, Node 22/24 and packed smoke for both packages.
2. **Billed live Claude smoke** (maintainer approval at launch), on the packed tarballs in a fresh Node project:
   - under `ask`: the agent is asked to edit a file; an `approval_requested` is answered `allow` via `answer()`, and the edit lands on disk
   - an embedder tool (`approval: "never"`) called through MCP without any permission prompt
   - a `question` round trip, if Claude emits an elicitation for a prompted AskUserQuestion. If it does not, this is recorded as not observed, not failed.
   - turn 1 states a random nonce; `close()`; `resumeAgentSession` from a new process (asserting `session/resume` was used) and the agent returns the nonce
   - under `read`: a write attempt is rejected (`decidedBy: "profile"`)
   - a `usage` event with non-zero tokens
   - Record the model, cost and commit.
3. **Initialize-only smoke** for codex, gemini, opencode and pi where installed: `initialize` plus `session/new`, no prompt. The capability matrix is recorded in the master plan.
4. **nax unaffected:** `git diff --exit-code origin/main -- packages/nax/` is empty (aside from the lockfile); the nax suite and typecheck pass; the S4-0 billed smoke result (§10) is recorded.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Adapter churn (claude-agent-acp ships often) | pinned ranges; capability record authoritative; live conformance catches drift |
| The pre-approval rule string differs | verified against the live adapter in the S4-4 plan |
| SDK churn (1.x moving fast) | `~1.7.0` pin; `ClientApp` builder only; no `/experimental` or v2 |
| Users read ACP `read`/`ask` as a hard sandbox | the documented guarantees (§6.4); the required `allowUnsandboxed: true` |
| Bun stream interop with the SDK | Node and Bun matrix over real subprocess pipes with the fake agent |
| Cumulative usage semantics differ per adapter | delta with reset handling; conformance asserts per-turn values |

## 13. Handoff to S4b and S5 (not designed here)

**S4b:**
- Map nax `permissionProfile` / `bashApproval` / stage modes onto `none|read|ask|full`.
- One-shot `complete()` over ACP.
- Context-pull tools.
- The idle watchdog.
- NO_SESSION recovery.
- Pricing for `unpriced` rows.
- tool-audit from ACP events.
- Cutover behind config, the billed `nax run` smoke on an ACP agent.
- Delete `packages/nax/src/agents/acp/` and the `acpx` PATH dependency.

**S5:**
- Map ACP session ids to `AgentSession` ids.
- Serve `send()` events as `session/update` and `approval_requested` as `request_permission`.
- `OpenedBackend.turnOpts` stays internal and is not part of the server surface.

**Later:**
- Client fs/terminal handlers (R11), when an agent that uses them becomes first-class.
- A stdio MCP bridge for agents without HTTP MCP.
