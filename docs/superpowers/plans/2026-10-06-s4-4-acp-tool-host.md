# S4-4: ACP tool host and adapter pre-approval: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `acpBackend()` serves embedder tools (`createAgentSession({ tools })`). A per-session MCP server on `127.0.0.1` exposes them to the agent, and Claude's adapter pre-approves them, so the host is their only approval point (spec §6.6, R12).

**Architecture:**
- Three new modules under `packages/nax-agent-acp/src/client/`:

  | Module | Role |
  |---|---|
  | `tool-calls.ts` | what `tools/list` and `tools/call` mean: the turn check, the 8-call cap, the `approval: "always"` ask, the run under the turn's signal, results as MCP tool results |
  | `tool-host.ts` | the HTTP server: `127.0.0.1`, ephemeral port, `POST /mcp`, the gate (Host, Origin, bearer token, 1 MiB body), one stateless MCP server per request; `start()`, `drain()`, `stop()` |
  | `pre-approval.ts` | the server name `nax`, the rule `mcp__nax__<tool>`, and the `_meta` that pre-approves the tools at Claude's adapter |

- `open.ts` starts the host after the capability check and before `session/new`, and sends its server entry plus the pre-approval `_meta` (§6.3 steps 3 and 4).
- `inbound.ts` gains `activeSignal()`: the running turn's binding signal. A tool call runs under it, so it aborts on cancel, timeout, close, turn end and agent process exit.
- `backend.ts` drops the S4-2 tools refusal. When the session has tools it creates the token before anything is spawned, adds it to the session's redaction set, waits for in-flight tool calls when a turn's binding is released, and stops the host on close and on a failed open.
- The fake ACP agent gains an `mcpCall` step: it calls a tool through the recorded `mcpServers` entry as a real MCP client over HTTP.
- No nax-agent change. No new export on `./client`.

**Tech Stack:**
- `@modelcontextprotocol/sdk` 1.30.0: `Server` (`/server/index.js`), `StreamableHTTPServerTransport` (`/server/streamableHttp.js`), `ListToolsRequestSchema`, `CallToolRequestSchema`, `CallToolResult`, `Tool` (`/types.js`); in tests and the fake agent, `Client` and `StreamableHTTPClientTransport`
- `@agentclientprotocol/sdk` 1.7.0: `McpServer` (the `session/new` entry)
- `@nathapp/nax-agent` public `.`: `EmbedderTool`, `EmbedderToolContext`, `EmbedderToolResult`, `SessionAskPort`, `ApprovalRequest`, `ApprovalDecidedBy`, `redactSecrets`, `capStrings`, `ASK_*_REASON`
- `node:http`, `node:crypto`
- bun:test (unit), vitest on Node 22/24 (contract)

**Spec:** `docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md`. Sections used:
- §6.6 MCP tool host (the whole section)
- §6.3 open steps 2 to 4, close step 4 ("stop the tool host and revoke its token"), "Inbound requests with no active turn" (MCP `tools/call` → MCP tool error)
- §7 "Agent text in errors": the redaction set includes the tool-host token
- §9 "MCP host security tests" and "pre-approval `_meta` capture"
- §10 S4-4 row: "`tool-host` and pre-approval (§6.6)"
- §12 risk "The pre-approval rule string differs: verified against the live adapter in the S4-4 plan"

## Global Constraints

- nax-agent-acp imports nax-agent only as `@nathapp/nax-agent` (public `.`), never `./internal` or a deep path, in `src/` or `test/` (§4).
- `src/` imports only `@agentclientprotocol/sdk` (root, never `/experimental` or `/v2`), `@modelcontextprotocol/sdk` (subpaths through its `./*` export, as `packages/nax/src/mcp/client.ts` does), `zod` and `node:` builtins. No Bun API in `src/` (`check:no-bun-apis`).
- `src/` imports its own modules as `#src/client/<module>`.
- No `throw new Error(` in `src/` (`check-nax-error`, baseline 0).
- The host binds `127.0.0.1` explicitly, never `localhost`, on port 0 (ephemeral), path `/mcp` (§6.6).
- Token: 32 random bytes per host, sent as `Authorization: Bearer <token>`, compared in constant time; missing or wrong → 401 (§6.6).
- `Host` must be `127.0.0.1:<port>`; any `Origin` header → 403. No CORS headers. Bodies over 1 MiB → 413. At most 8 concurrent `tools/call`; beyond that an MCP tool error (§6.6).
- The token joins the redaction set for events, errors and the stderr tail. It is never written to `env` or the transcript document (§6.6, §7).
- `tools/list` is exactly the session's embedder tools (`name`, `description`, `inputSchema`); the agent sees them as `mcp__nax__<name>` (§6.6).
- A `tools/call` with no turn → MCP tool error. A run gets `{ sessionId, toolCallId: "mcp-<n>", signal }`. `{ content, isError }` → `CallToolResult`; a throw → `isError: true` with the message (§6.6).
- `approval: "always"` → `asks.requestApproval` under every profile; `"never"` runs under every profile (§6.6, §5.4).
- Stopped, and the token revoked, on close (§6.6, §6.3 close step 4).
- Resume stays refused before spawning (S4-2 D-b) until S4-6.
- Gates (from `packages/nax-agent-acp`):
  - file sizes: 600 lines per src file, 800 per test file
  - complexity: 20 per function
  - coverage: 80% overall and per src file; the per-file baseline stays empty
  - import cycles: none
  - test satellites: a test file is named `<module>.test.ts` or `<module>-<concern>.test.ts`, never after a ticket; each new `src/client/<m>.ts` gets `test/unit/client/<m>.test.ts`
  - no `as unknown as`, `as any` or `@ts-ignore` in tests: build malformed input with `JSON.parse`, as the S4-2 tests do
- Nothing is released in S4-4: no tag, no publish (§10).
- `packages/nax/` and `packages/nax-agent/` do not change.
- Never run bare `bun test` (no path) and never `bun run nax`. Package commands run from the package directory.
- Code in this plan is not pre-formatted: run `bun run lint:fix` in the package before every `check:all`.
- No emojis in code, comments or docs. Edit `.nax/**/context.md` only, then regenerate. Never hand-edit `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` or `codex.md`.
- Where this plan changes an existing file, it gives the whole new file or an exact old/new edit. Nothing is elided: do not merge from fragments (the S4-3 Task 4 lesson).

## Review Focus

1. **A tool call that outlives its turn must answer, not hang, and must not run on.** The turn can stop while a call is waiting for approval, or while a run ignores its signal: the caller cancels, the turn times out, or the agent process dies. In each case the call answers the agent at once with an MCP tool error, the run's `ctx.signal` is aborted, `approval_resolved` precedes `turn_end`, and `send()` returns. A call whose run finishes after that is ignored. Pinned in Task 1 (abort before and during the run and the ask) and Task 4 (cancel during the approval, cancel during a slow run, crash during a slow run).
2. **Anything else on the local machine reaching the port.** Without the right bearer token a request gets 401. A DNS-rebinding page (wrong `Host`) or any browser request (`Origin`) gets 403 even with the token. A request for another path or method never reaches MCP. A body over 1 MiB gets 413, whether it is declared up front or streamed. A ninth concurrent call gets a tool error and does not run. No response carries a CORS header. Pinned in Task 2.
3. **The token leaking.** The token must never appear in the transcript document, in any event, or in an error excerpt, including an agent error message that echoes the `Authorization` header back. After `close()` the port refuses connections, and a failed open leaves no listening port behind. Pinned in Task 4.
4. **Calls outside a turn.** A call before the first turn, between turns, or after the turn's binding is released gets "No active turn" and the tool does not run. An unknown tool name (including `__proto__` and `constructor`) gets an error and nothing runs. Pinned in Task 1 and Task 4.
5. **Hostile or odd tool input in an approval.** The summary is the tool's `describe(input)` or the JSON input. Secret values, both the session's own (env secrets and the token) and pattern secrets, show as `[REDACTED]`. Control and invisible characters are stripped, newlines collapse, and it is capped at 1024 bytes. A throwing `describe` falls back to the input. An input that cannot be serialized still yields a summary. Pinned in Task 1.

## Decisions taken in this plan (for review)

- **D4-a. The pre-approval rule is one exact rule per tool, `mcp__nax__<tool>`.** The spec left the exact string to this plan (§6.6, §12). Verified by reading `@agentclientprotocol/claude-agent-acp` 0.85.1 (the registry pin) and `@anthropic-ai/claude-agent-sdk` 0.3.286 (the SDK it pins):
  - `dist/acp-agent.js` 6664-6688: each ACP `http` server becomes `mcpServers[server.name] = { type, url, headers }`. Our entry's name `nax` is therefore the Claude server key, and its tools are `mcp__nax__<tool>`.
  - `dist/acp-agent.js` 6718-6720 and the `options` object below it: `_meta.claudeCode.options` is copied and spread into the Claude Agent SDK `Options`, so `allowedTools` reaches the SDK unchanged.
  - SDK `sdk.d.ts` 1575-1582: `allowedTools` lists "tool names that are auto-allowed without prompting for permission".

  We list exact per-tool rules, not the server-wide `mcp__nax`, so only the session's own tools are allowed, the same closed-catalog choice paperclip makes (`mcp__paperclip__<name>`, research report 06). Tool names are already restricted by the facade to `^[A-Za-z][A-Za-z0-9_-]{0,63}$`, so a rule never needs escaping. The `_meta` is exactly `{ claudeCode: { options: { allowedTools: [...] } } }`, and nothing else is set there.
- **D4-b. What is not verified statically: an allow rule under `plan` mode.** The Claude CLI ships as a native binary, so whether `allowedTools` still auto-allows an MCP tool while the session is in `plan` mode (profiles `none` and `read`) cannot be read from the source. The fake agent cannot answer it either. Task 6 adds it to the S4-6 billed live smoke (§11.2): "under `read`, an embedder tool (`approval: "never"`) runs through MCP without a permission prompt". Until then the README states it as unverified on `none`/`read`.
- **D4-c. A permission request for an `mcp__nax__*` tool is not special-cased.** Pre-approval means the adapter does not ask. If an adapter asks anyway, the request is decided by profile like any other (S4-3): denied under `none`/`read`, put to the caller under `ask`, allowed under `full`. The agent's tool title is display data and never decides (§6.4), so the host cannot trust a title that says `mcp__nax__`. The README says so.
- **D4-d. One stateless MCP server per request, JSON responses, `POST` only.** Each `POST /mcp` gets a fresh `Server` and `StreamableHTTPServerTransport({ enableJsonResponse: true })` with no session id generator. The SDK refuses to reuse a stateless transport ("Stateless transport cannot be reused across requests"), and per-request servers mean a reconnecting client never meets "already initialized". `GET` (the optional SSE stream) and every other method get 405 with `Allow: POST`; the SDK client tolerates a 405 on its `GET`. A narrow probe while planning (the SDK client against this exact server shape, under Bun 1.4.2 and Node 22.22.2) passed both: `initialize`, `tools/list` and `tools/call` round-tripped. A raw `tools/list` with no `initialize` also returned 200, and no response carried an `access-control-*` header.
- **D4-e. Gate order:** path → 404; method → 405; `Host` or `Origin` → 403; token (constant time, both sides SHA-256 hashed so the lengths match) or a revoked host → 401; a declared `content-length` over 1 MiB → 413 at once (with `Connection: close`); then the body is read. A streamed body past 1 MiB is drained and discarded, so memory stays bounded and the 413 is still delivered; invalid JSON → 400. `Host`/`Origin` come before the token, so a rebinding page never reaches the token compare. Every refusal is `text/plain` and carries no CORS header.
- **D4-f. A call runs under the turn's binding signal, not the bare facade turn signal.** The facade does not abort a turn's signal when the turn completes normally (`agent-session-turn.ts` `claimTurn` aborts only on cancel, timeout and stall). The router's binding signal (S4-3 D3-d) already combines the binding scope (aborted when `sendTurn` releases it), the facade turn signal and the process-gone signal. `inbound.ts` exposes it as `activeSignal()`, and the host reads it at call time together with `ctx.currentTurnId()`. Either missing → "No active turn". The call's signal is `AbortSignal.any([binding signal, request signal])`, where the request signal aborts when the HTTP response closes (the agent hung up, or `stop()` dropped the connection). `sendTurn` awaits the binding release, then `host.drain()`, which resolves once every in-flight call has answered. Aborted calls answer at once, so the drain is bounded, and `approval_resolved` for an `always` tool is emitted before `turn_end`.
- **D4-g. Approval, denial and results.**
  - `approval: "never"` runs without asking. Any other value asks (fail closed).
  - The ask is `requestApproval({ callId: "mcp-<n>", tool: <name>, summary, reason: '"<name>" asks before every run', signal })`, the same reason text as the native backend's.
  - A deny answers `isError: true` with `Denied: <reason>`. The reason maps `decidedBy` to nax-agent's public `ASK_*_REASON` constants exactly as nax-agent's internal `askDenyReason` does: timeout, human, cancelled, unshowable, profile, else the no-channel reason. A throw from the port (its `no-turn`) answers "No active turn". Unlike native, a deny here is a tool error, so the agent sees that the tool did not run.
  - The run is raced against the signal, as native's `invoke` is. On abort the answer is `Tool "<name>" was abandoned: the turn ended.` and the late result is ignored. A throw answers `Tool "<name>" failed: <message>`. A result answers one text block with `content`, plus `isError: true` when the tool set it.
  - The input is `arguments`, or `{}` when absent. It is not validated against `inputSchema`, as on the native backend (nax-agent has no schema validator); a tool checks its own input.
  - `tools/list` sends `inputSchema` as given, with `type: "object"` set, because MCP requires an object schema.
  - `toolCallId` counts accepted calls per host: `mcp-1`, `mcp-2`, ...
- **D4-h. The approval summary.** The summary is `describe(input)` when the tool has one (a throw falls back), else the JSON of the input. The scan is first capped at 16 KiB and `redactSecrets` runs over it, as native's `summaryFor`/`defaultSummary` do. Then control and invisible characters are stripped, the session's secret values (env secrets and the token) are scrubbed, newlines and tabs collapse to one space, and the result is capped at 1024 bytes. There is no `maskForPrompt`, as on the native backend: the summary is not a shell command.
- **D4-i. The token exists before the agent does.** When the session has tools, `openBackend` creates the token first, then derives the session's options with `secrets: [...env secrets, token]`. Every consumer of `options.secrets` gets it from the start: the open-step stderr excerpts, the turn's error excerpts, the permission display and the tool summaries. The host listens only after the capability check (§6.3 step 3). A failed open stops the host. A crash does not stop it: the session is disconnected, and `close()` stops it (§6.3 close step 4, after the agent is terminated).
- **D4-j. Refusal timing changes for tools.** Until now tools were refused before spawning (S4-2 D-b). Now an agent that cannot take tools (no HTTP MCP, or no registry pre-approval: codex, gemini, opencode, pi, any custom agent) is refused after `initialize` by the existing check in `capabilities.ts` (`AGENT_SESSION_CAPABILITY_UNSUPPORTED`, `capability: "tools"`), and the host never listens.
- **D4-k. The fake agent's `mcpCall` step.** The fake records `session/new`'s `mcpServers`. An `mcpCall` step connects an SDK `Client` over `StreamableHTTPClientTransport` to the first `http` entry with its headers, calls the tool, and records `mcp-result` `{ tool, result }` or `mcp-error` `{ tool, message }`. `detached: true` sends it without waiting, and `settled` waits for it, as with detached permission requests. The `fail` step gains `echoMcpAuth`, which appends the entry's `Authorization` value to the JSON-RPC error message (leak tests).

---

## File structure

**Create (package `packages/nax-agent-acp/`):**

| Path | Responsibility |
|---|---|
| `src/client/tool-calls.ts` | `createToolCalls(deps): ToolCalls`; `MAX_CONCURRENT_TOOL_CALLS`, `TOOL_SUMMARY_BYTES`, `NO_TURN_TEXT`, `TOO_MANY_TEXT`, `approvalReason`, `denyReason`, `toolSummary` |
| `src/client/pre-approval.ts` | `TOOL_HOST_SERVER_NAME`, `mcpToolRule`, `preApprovalMeta` |
| `src/client/tool-host.ts` | `createToolHost(calls, token?)`, `newToolHostToken`, `ToolHost`, `HttpMcpServer`, `TOOL_HOST_PATH`, `MAX_BODY_BYTES` |
| `test/unit/client/tool-calls.test.ts` | call semantics against a stub ask port, no HTTP |
| `test/unit/client/pre-approval.test.ts` | rule string and `_meta` |
| `test/unit/client/tool-host.test.ts` | the HTTP gate and MCP over real loopback HTTP (spec §9 security tests) |
| `test/unit/client/backend-tools.test.ts` | embedder tools through the facade, in process |
| `test/fixtures/fake-agent/mcp.ts` | the fake agent's MCP client |
| `test/helpers/http.ts` | `rawRequest`: HTTP an MCP client never sends |
| `test/helpers/mcp-client.ts` | `mcpClient(url, token)` |

**Modify:**

| Path | Change |
|---|---|
| `src/client/inbound.ts` | `InboundRouter.activeSignal()` |
| `src/client/open.ts` | `openAcpSession(..., host?)`; host start and `session/new` `mcpServers` + `_meta` |
| `src/client/backend.ts` | token first, session secrets, host wiring, drain on release, stop on close and failed open; tools refusal removed |
| `src/client/index.ts` | header comment |
| `test/fixtures/fake-agent/script.ts` | `McpCallStep`; `fail.echoMcpAuth` |
| `test/fixtures/fake-agent/agent.ts` | records `mcpServers`; runs `mcpCall`; `echoMcpAuth` |
| `test/unit/client/inbound.test.ts` | `activeSignal` |
| `test/unit/client/open.test.ts` | host start, `session/new` params, refusals |
| `test/unit/client/backend.test.ts` | the S4-2 "tools refused before spawning" test is removed |
| `test/node/acp-backend.test.ts` | a tool call over a Node agent process |
| `README.md`, `CHANGELOG.md` | embedder tools on ACP |
| `.nax/mono/packages/nax-agent-acp/context.md` (repo root) | status and module map |
| `docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md` | §6.6 rule string; §11.2 acceptance line (D4-a, D4-b) |

---

### Task 1: Tool-call semantics (`tool-calls.ts`)

**Files:**
- Create: `packages/nax-agent-acp/src/client/tool-calls.ts`
- Test: `packages/nax-agent-acp/test/unit/client/tool-calls.test.ts`

**Interfaces:**
- Consumes: `capBytes`, `scrubSecrets`, `stripControl`, `stripInvisible` from `#src/client/text` (S4-3).
- Produces:
  ```ts
  export const MAX_CONCURRENT_TOOL_CALLS = 8;
  export const TOOL_SUMMARY_BYTES = 1024;
  export const NO_TURN_TEXT: string;
  export const TOO_MANY_TEXT: string;
  export function approvalReason(name: string): string;
  export function denyReason(decidedBy: ApprovalDecidedBy): string;
  export function toolSummary(tool: EmbedderTool, input: unknown, secrets: readonly string[]): string;
  export interface ToolCallDeps {
    readonly sessionId: string;
    readonly tools: readonly EmbedderTool[];
    readonly asks: SessionAskPort;
    readonly currentTurnId: () => string | undefined;
    readonly turnSignal: () => AbortSignal | undefined;
    readonly secrets: readonly string[];
  }
  export interface ToolCalls {
    list(): Tool[];
    call(name: string, args: unknown, requestSignal: AbortSignal): Promise<CallToolResult>;
    drain(): Promise<void>;
  }
  export function createToolCalls(deps: ToolCallDeps): ToolCalls;
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/nax-agent-acp/test/unit/client/tool-calls.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  ASK_CANCELLED_REASON,
  ASK_DENIED_REASON,
  ASK_NO_CHANNEL_REASON,
  ASK_PROFILE_REASON,
  ASK_TIMEOUT_REASON,
  ASK_UNSHOWABLE_REASON,
  type ApprovalDecidedBy,
  type ApprovalRequest,
  type EmbedderTool,
  type EmbedderToolContext,
  type SessionAskPort,
} from "@nathapp/nax-agent";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import {
  approvalReason,
  createToolCalls,
  denyReason,
  MAX_CONCURRENT_TOOL_CALLS,
  NO_TURN_TEXT,
  TOO_MANY_TEXT,
  TOOL_SUMMARY_BYTES,
  type ToolCallDeps,
  toolSummary,
} from "#src/client/tool-calls";

type Verdict = { readonly decision: "allow" | "deny"; readonly decidedBy: ApprovalDecidedBy };

interface Ran {
  readonly input: unknown;
  readonly ctx: EmbedderToolContext;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function askPort(answer: (req: ApprovalRequest) => Promise<Verdict> = async () => ({ decision: "allow", decidedBy: "human" })) {
  const asked: ApprovalRequest[] = [];
  const port: SessionAskPort = {
    requestApproval: async (req) => {
      asked.push(req);
      return answer(req);
    },
    recordAutoDecision: () => {},
    askQuestion: async () => null,
    noteQuestion: () => {},
  };
  return { asked, port };
}

function tool(overrides: Partial<EmbedderTool> = {}, ran: Ran[] = []): EmbedderTool {
  return {
    name: "lookup",
    description: "Look a word up",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
    approval: "never",
    run: async (input, ctx) => {
      ran.push({ input, ctx });
      return { content: `found: ${JSON.stringify(input)}` };
    },
    ...overrides,
  };
}

const IDLE = new AbortController().signal;

function deps(overrides: Partial<ToolCallDeps> = {}): ToolCallDeps {
  const turn = new AbortController();
  return {
    sessionId: "s-1",
    tools: [tool()],
    asks: askPort().port,
    currentTurnId: () => "turn-1",
    turnSignal: () => turn.signal,
    secrets: [],
    ...overrides,
  };
}

const text = (t: string) => [{ type: "text", text: t }];

describe("tools/list", () => {
  test("exactly the session's tools, in order, with an object input schema", () => {
    const calls = createToolCalls(
      deps({ tools: [tool(), tool({ name: "fetch_page", description: "Fetch", inputSchema: {} })] }),
    );
    expect(calls.list()).toEqual([
      {
        name: "lookup",
        description: "Look a word up",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
      { name: "fetch_page", description: "Fetch", inputSchema: { type: "object" } },
    ]);
  });
});

describe("tools/call: turn and name checks (spec §6.3, §6.6)", () => {
  test("no current turn id: a no-turn tool error and nothing runs", async () => {
    const ran: Ran[] = [];
    const calls = createToolCalls(deps({ tools: [tool({}, ran)], currentTurnId: () => undefined }));
    expect(await calls.call("lookup", {}, IDLE)).toEqual({ content: text(NO_TURN_TEXT), isError: true });
    expect(ran).toEqual([]);
  });

  test("no bound turn signal: a no-turn tool error and nothing runs", async () => {
    const ran: Ran[] = [];
    const calls = createToolCalls(deps({ tools: [tool({}, ran)], turnSignal: () => undefined }));
    expect(await calls.call("lookup", {}, IDLE)).toEqual({ content: text(NO_TURN_TEXT), isError: true });
    expect(ran).toEqual([]);
  });

  test.each(["missing", "__proto__", "constructor", "toString"])("unknown name %p: a tool error", async (name) => {
    const ran: Ran[] = [];
    const calls = createToolCalls(deps({ tools: [tool({}, ran)] }));
    const result = await calls.call(name, {}, IDLE);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(text(`Unknown tool "${name}"`));
    expect(ran).toEqual([]);
  });

  test("an unknown name with control characters is shown stripped and capped", async () => {
    const calls = createToolCalls(deps());
    const result = await calls.call(`bad\u001b[31m${"x".repeat(200)}`, {}, IDLE);
    // \u001b is stripped; the remaining "bad[31m" is 7 characters, so 57 x's make the 64-character cap.
    expect(result.content).toEqual(text(`Unknown tool "bad[31m${"x".repeat(57)}"`));
  });
});

describe("tools/call: approval never", () => {
  test("runs with the session id, an mcp-<n> call id and a live signal; ids count up", async () => {
    const ran: Ran[] = [];
    const { asked, port } = askPort();
    const calls = createToolCalls(deps({ tools: [tool({}, ran)], asks: port }));
    expect(await calls.call("lookup", { q: "a" }, IDLE)).toEqual({ content: text('found: {"q":"a"}') });
    expect(await calls.call("lookup", undefined, IDLE)).toEqual({ content: text("found: {}") });
    expect(ran.map((r) => [r.input, r.ctx.sessionId, r.ctx.toolCallId, r.ctx.signal.aborted])).toEqual([
      [{ q: "a" }, "s-1", "mcp-1", false],
      [{}, "s-1", "mcp-2", false],
    ]);
    expect(asked).toEqual([]);
  });

  test("a result with isError stays an error; a non-string content is stringified", async () => {
    const calls = createToolCalls(
      deps({ tools: [tool({ run: async () => JSON.parse('{"content": 42, "isError": true}') })] }),
    );
    expect(await calls.call("lookup", {}, IDLE)).toEqual({ content: text("42"), isError: true });
  });

  test("a throw: 'Tool <name> failed: <message>'", async () => {
    const calls = createToolCalls(
      deps({
        tools: [
          tool({
            run: async () => {
              throw new Error("boom");
            },
          }),
        ],
      }),
    );
    expect(await calls.call("lookup", {}, IDLE)).toEqual({ content: text('Tool "lookup" failed: boom'), isError: true });
  });

  test("a non-Error throw is stringified", async () => {
    const calls = createToolCalls(deps({ tools: [tool({ run: () => Promise.reject("plain") })] }));
    expect(await calls.call("lookup", {}, IDLE)).toEqual({ content: text('Tool "lookup" failed: plain'), isError: true });
  });
});

describe("tools/call: approval always (spec §6.6)", () => {
  test("asks with the call id, tool, summary and reason; allow runs the tool", async () => {
    const ran: Ran[] = [];
    const { asked, port } = askPort();
    const calls = createToolCalls(
      deps({ tools: [tool({ approval: "always", describe: (i) => `look up ${JSON.stringify(i)}` }, ran)], asks: port }),
    );
    expect(await calls.call("lookup", { q: "a" }, IDLE)).toEqual({ content: text('found: {"q":"a"}') });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      callId: "mcp-1",
      tool: "lookup",
      summary: 'look up {"q":"a"}',
      reason: approvalReason("lookup"),
    });
    expect(asked[0]?.signal?.aborted).toBe(false);
    expect(ran).toHaveLength(1);
  });

  test.each<[ApprovalDecidedBy, string]>([
    ["human", ASK_DENIED_REASON],
    ["timeout", ASK_TIMEOUT_REASON],
    ["cancelled", ASK_CANCELLED_REASON],
    ["unshowable", ASK_UNSHOWABLE_REASON],
    ["profile", ASK_PROFILE_REASON],
    ["unavailable", ASK_NO_CHANNEL_REASON],
  ])("deny decided by %p: 'Denied: <reason>' and the tool does not run", async (decidedBy, reason) => {
    const ran: Ran[] = [];
    const { port } = askPort(async () => ({ decision: "deny", decidedBy }));
    const calls = createToolCalls(deps({ tools: [tool({ approval: "always" }, ran)], asks: port }));
    expect(denyReason(decidedBy)).toBe(reason);
    expect(await calls.call("lookup", {}, IDLE)).toEqual({ content: text(`Denied: ${reason}`), isError: true });
    expect(ran).toEqual([]);
  });

  test("an approval value other than never asks (fail closed)", async () => {
    const { asked, port } = askPort(async () => ({ decision: "deny", decidedBy: "human" }));
    const odd = tool(JSON.parse('{"approval": "sometimes"}'));
    const calls = createToolCalls(deps({ tools: [odd], asks: port }));
    expect((await calls.call("lookup", {}, IDLE)).isError).toBe(true);
    expect(asked).toHaveLength(1);
  });

  test("the port throws (turn ended before the ask): a no-turn error and nothing runs", async () => {
    const ran: Ran[] = [];
    const { port } = askPort(() => Promise.reject(new Error("no-turn")));
    const calls = createToolCalls(deps({ tools: [tool({ approval: "always" }, ran)], asks: port }));
    expect(await calls.call("lookup", {}, IDLE)).toEqual({ content: text(NO_TURN_TEXT), isError: true });
    expect(ran).toEqual([]);
  });
});

describe("tools/call: abort (Review Focus 1)", () => {
  test("the turn signal already aborted: abandoned, nothing runs, no ask", async () => {
    const ran: Ran[] = [];
    const { asked, port } = askPort();
    const turn = new AbortController();
    turn.abort();
    const calls = createToolCalls(
      deps({ tools: [tool({ approval: "always" }, ran)], asks: port, turnSignal: () => turn.signal }),
    );
    expect(await calls.call("lookup", {}, IDLE)).toEqual({
      content: text('Tool "lookup" was abandoned: the turn ended.'),
      isError: true,
    });
    expect(ran).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("a run that ignores its signal answers at once when the turn aborts; its signal is aborted", async () => {
    const turn = new AbortController();
    const seen: AbortSignal[] = [];
    const calls = createToolCalls(
      deps({
        turnSignal: () => turn.signal,
        tools: [
          tool({
            run: (_input, ctx) => {
              seen.push(ctx.signal);
              return new Promise(() => {});
            },
          }),
        ],
      }),
    );
    const pending = calls.call("lookup", {}, IDLE);
    await waitForCondition(() => seen.length === 1);
    turn.abort();
    expect(await pending).toEqual({ content: text('Tool "lookup" was abandoned: the turn ended.'), isError: true });
    expect(seen[0]?.aborted).toBe(true);
  });

  test("the request signal aborting (the agent hung up) abandons the run too", async () => {
    const request = new AbortController();
    const calls = createToolCalls(deps({ tools: [tool({ run: () => new Promise(() => {}) })] }));
    const pending = calls.call("lookup", {}, request.signal);
    request.abort();
    expect((await pending).content).toEqual(text('Tool "lookup" was abandoned: the turn ended.'));
  });

  test("the ask gets the call's signal: aborting it settles a pending ask", async () => {
    const turn = new AbortController();
    const { port } = askPort(
      (req) =>
        new Promise((resolve) => {
          req.signal?.addEventListener("abort", () => resolve({ decision: "deny", decidedBy: "cancelled" }));
        }),
    );
    const calls = createToolCalls(
      deps({ tools: [tool({ approval: "always" })], asks: port, turnSignal: () => turn.signal }),
    );
    const pending = calls.call("lookup", {}, IDLE);
    turn.abort();
    expect(await pending).toEqual({ content: text(`Denied: ${ASK_CANCELLED_REASON}`), isError: true });
  });
});

describe("tools/call: concurrency cap (spec §6.6)", () => {
  test(`at most ${MAX_CONCURRENT_TOOL_CALLS} in flight; the next is refused and does not run; then one frees a slot`, async () => {
    const gate = deferred<void>();
    let started = 0;
    const calls = createToolCalls(
      deps({
        tools: [
          tool({
            run: async () => {
              started += 1;
              await gate.promise;
              return { content: "done" };
            },
          }),
        ],
      }),
    );
    const first = Array.from({ length: MAX_CONCURRENT_TOOL_CALLS }, () => calls.call("lookup", {}, IDLE));
    await waitForCondition(() => started === MAX_CONCURRENT_TOOL_CALLS);
    expect(await calls.call("lookup", {}, IDLE)).toEqual({ content: text(TOO_MANY_TEXT), isError: true });
    expect(started).toBe(MAX_CONCURRENT_TOOL_CALLS);
    gate.resolve();
    await Promise.all(first);
    expect(await calls.call("lookup", {}, IDLE)).toEqual({ content: text("done") });
  });
});

describe("drain", () => {
  test("resolves at once with nothing in flight", async () => {
    await createToolCalls(deps()).drain();
  });

  test("resolves only after every in-flight call has answered", async () => {
    const gate = deferred<void>();
    const calls = createToolCalls(
      deps({
        tools: [
          tool({
            run: async () => {
              await gate.promise;
              return { content: "late" };
            },
          }),
        ],
      }),
    );
    void calls.call("lookup", {}, IDLE);
    let drained = false;
    const draining = calls.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    gate.resolve();
    await draining;
    expect(drained).toBe(true);
  });
});

describe("toolSummary (Review Focus 5)", () => {
  const SESSION_SECRET = "session-secret-value-0123";

  test("describe wins; the JSON input otherwise", () => {
    expect(toolSummary(tool({ describe: () => "custom" }), { q: "a" }, [])).toBe("custom");
    expect(toolSummary(tool(), { q: "a" }, [])).toBe('{"q":"a"}');
    expect(toolSummary(tool(), undefined, [])).toBe("null");
  });

  test("a throwing describe falls back to the input", () => {
    const throwing = tool({
      describe: () => {
        throw new Error("nope");
      },
    });
    expect(toolSummary(throwing, { q: "a" }, [])).toBe('{"q":"a"}');
  });

  test("an input that cannot be serialized", () => {
    expect(toolSummary(tool(), { n: 1n }, [])).toBe("[input not serializable]");
  });

  test("the session's secrets and pattern secrets are redacted; secret-named keys too", () => {
    expect(toolSummary(tool({ describe: () => `use ${SESSION_SECRET}` }), {}, [SESSION_SECRET])).toBe("use [REDACTED]");
    expect(toolSummary(tool({ describe: () => "fetch ghp_abcdefghijklmnopqrst" }), {}, [])).toBe("fetch [REDACTED]");
    expect(toolSummary(tool(), { q: "x", token: "plainvalue123" }, [])).toBe('{"q":"x","token":"[REDACTED]"}');
  });

  test("control and invisible characters stripped; newlines and tabs collapse; trimmed", () => {
    const odd = tool({ describe: () => "  a\u0007b‮c\nd\t\te  " });
    expect(toolSummary(odd, {}, [])).toBe("abc d e");
  });

  test(`capped at ${TOOL_SUMMARY_BYTES} bytes without splitting a character`, () => {
    const long = tool({ describe: () => "é".repeat(TOOL_SUMMARY_BYTES) });
    const shown = toolSummary(long, {}, []);
    expect(Buffer.byteLength(shown, "utf8")).toBeLessThanOrEqual(TOOL_SUMMARY_BYTES);
    expect(shown).toBe("é".repeat(TOOL_SUMMARY_BYTES / 2));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `packages/nax-agent-acp`): `bun test ./test/unit/client/tool-calls.test.ts --timeout=60000`
Expected: FAIL with `Cannot find module '#src/client/tool-calls'`.

- [ ] **Step 3: Write the implementation**

Create `packages/nax-agent-acp/src/client/tool-calls.ts`:

```ts
/**
 * Embedder tools as the MCP tool host serves them (S4 spec §6.6: tools/list and
 * tools/call). A call runs only while a turn runs, at most
 * MAX_CONCURRENT_TOOL_CALLS at once, under the turn's binding signal (cancel,
 * timeout, close, turn end, agent process exit) combined with its HTTP request's
 * (D4-f). `approval: "never"` runs under every profile, as on the native backend;
 * anything else asks the caller first. Adapter pre-approval (R12) makes this the
 * tools' only approval point. Every failure reaches the agent as an MCP tool error
 * (isError), never as a protocol error.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ASK_CANCELLED_REASON,
  ASK_DENIED_REASON,
  ASK_NO_CHANNEL_REASON,
  ASK_PROFILE_REASON,
  ASK_TIMEOUT_REASON,
  ASK_UNSHOWABLE_REASON,
  type ApprovalDecidedBy,
  capStrings,
  type EmbedderTool,
  type EmbedderToolContext,
  type EmbedderToolResult,
  redactSecrets,
  type SessionAskPort,
} from "@nathapp/nax-agent";
import { capBytes, scrubSecrets, stripControl, stripInvisible } from "#src/client/text";

export const MAX_CONCURRENT_TOOL_CALLS = 8;
/** Byte cap of an approval summary (native: EMBEDDER_SUMMARY_BYTES). */
export const TOOL_SUMMARY_BYTES = 1024;
/** Redaction scans at most this many bytes of a tool input (native: 16x the summary cap). */
const SCAN_BYTES = TOOL_SUMMARY_BYTES * 16;
const SHOWN_NAME_CHARS = 64;

export const NO_TURN_TEXT = "No active turn: embedder tools run only while a turn is running.";
export const TOO_MANY_TEXT = `Too many concurrent tool calls: at most ${MAX_CONCURRENT_TOOL_CALLS} run at once.`;

export interface ToolCallDeps {
  readonly sessionId: string;
  readonly tools: readonly EmbedderTool[];
  readonly asks: SessionAskPort;
  readonly currentTurnId: () => string | undefined;
  /** The running turn's binding signal (inbound.ts activeSignal), or undefined between turns. */
  readonly turnSignal: () => AbortSignal | undefined;
  /** The session's secret values (env secrets and the host token), scrubbed from approval summaries. */
  readonly secrets: readonly string[];
}

export interface ToolCalls {
  /** tools/list: exactly the session's embedder tools. */
  list(): Tool[];
  /** tools/call. `requestSignal` aborts when the HTTP request goes away. */
  call(name: string, args: unknown, requestSignal: AbortSignal): Promise<CallToolResult>;
  /** Resolves once every call in flight has answered. */
  drain(): Promise<void>;
}

function textResult(text: string, isError: boolean): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/** The native backend's reason for an embedder approval. */
export function approvalReason(name: string): string {
  return `"${name}" asks before every run`;
}

/** nax-agent's askDenyReason, over its public reason constants. */
export function denyReason(decidedBy: ApprovalDecidedBy): string {
  switch (decidedBy) {
    case "timeout":
      return ASK_TIMEOUT_REASON;
    case "human":
      return ASK_DENIED_REASON;
    case "cancelled":
      return ASK_CANCELLED_REASON;
    case "unshowable":
      return ASK_UNSHOWABLE_REASON;
    case "profile":
      return ASK_PROFILE_REASON;
    default:
      return ASK_NO_CHANNEL_REASON;
  }
}

function describeInput(tool: EmbedderTool, input: unknown): string {
  if (tool.describe !== undefined) {
    try {
      return String(redactSecrets(capStrings(String(tool.describe(input)), SCAN_BYTES)));
    } catch {
      // A throwing describe falls back to the input, as on the native backend.
    }
  }
  try {
    return JSON.stringify(redactSecrets(capStrings(input, SCAN_BYTES))) ?? "null";
  } catch {
    return "[input not serializable]";
  }
}

/** The approval summary (D4-h): described or JSON input, redacted, stripped, the session's secrets scrubbed, one line, capped. */
export function toolSummary(tool: EmbedderTool, input: unknown, secrets: readonly string[]): string {
  const visible = scrubSecrets(stripInvisible(stripControl(describeInput(tool, input))), secrets);
  return capBytes(visible.replace(/[\n\t]+/g, " ").trim(), TOOL_SUMMARY_BYTES);
}

function abandoned(name: string): CallToolResult {
  return textResult(`Tool "${name}" was abandoned: the turn ended.`, true);
}

function runSafely(tool: EmbedderTool, input: unknown, ctx: EmbedderToolContext): Promise<CallToolResult> {
  return Promise.resolve()
    .then(() => tool.run(input, ctx))
    .then(
      (result: EmbedderToolResult) => textResult(String(result.content), result.isError === true),
      (err: unknown) => textResult(`Tool "${tool.name}" failed: ${err instanceof Error ? err.message : String(err)}`, true),
    );
}

/** Answers at once when the signal aborts: a run that ignores its signal is abandoned and its late result ignored. */
async function invoke(tool: EmbedderTool, input: unknown, ctx: EmbedderToolContext): Promise<CallToolResult> {
  if (ctx.signal.aborted) return abandoned(tool.name);
  let onAbort = (): void => {};
  const aborted = new Promise<CallToolResult>((resolve) => {
    onAbort = () => resolve(abandoned(tool.name));
    ctx.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([runSafely(tool, input, ctx), aborted]);
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
  }
}

/** undefined: go ahead. Otherwise the answer that replaces the run. */
async function approve(
  deps: ToolCallDeps,
  tool: EmbedderTool,
  input: unknown,
  ctx: EmbedderToolContext,
): Promise<CallToolResult | undefined> {
  if (tool.approval === "never") return undefined;
  try {
    const outcome = await deps.asks.requestApproval({
      callId: ctx.toolCallId,
      tool: tool.name,
      summary: toolSummary(tool, input, deps.secrets),
      reason: approvalReason(tool.name),
      signal: ctx.signal,
    });
    return outcome.decision === "allow" ? undefined : textResult(`Denied: ${denyReason(outcome.decidedBy)}`, true);
  } catch {
    // The turn ended between the turn check and the ask (the port's "no-turn"): fail closed.
    return textResult(NO_TURN_TEXT, true);
  }
}

export function createToolCalls(deps: ToolCallDeps): ToolCalls {
  const byName: ReadonlyMap<string, EmbedderTool> = new Map(deps.tools.map((tool) => [tool.name, tool]));
  const inFlight = new Set<Promise<CallToolResult>>();
  let accepted = 0;

  const run = async (tool: EmbedderTool, args: unknown, signal: AbortSignal): Promise<CallToolResult> => {
    accepted += 1;
    const input = args ?? {};
    const ctx: EmbedderToolContext = { sessionId: deps.sessionId, toolCallId: `mcp-${accepted}`, signal };
    if (signal.aborted) return abandoned(tool.name);
    const denied = await approve(deps, tool, input, ctx);
    return denied ?? invoke(tool, input, ctx);
  };

  return {
    list: () =>
      deps.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: { ...tool.inputSchema, type: "object" },
      })),
    async call(name, args, requestSignal) {
      const tool = byName.get(name);
      if (tool === undefined) {
        return textResult(`Unknown tool "${stripControl(name).slice(0, SHOWN_NAME_CHARS)}"`, true);
      }
      const turnSignal = deps.turnSignal();
      if (deps.currentTurnId() === undefined || turnSignal === undefined) return textResult(NO_TURN_TEXT, true);
      if (inFlight.size >= MAX_CONCURRENT_TOOL_CALLS) return textResult(TOO_MANY_TEXT, true);
      const pending = run(tool, args, AbortSignal.any([turnSignal, requestSignal]));
      inFlight.add(pending);
      try {
        return await pending;
      } finally {
        inFlight.delete(pending);
      }
    },
    async drain() {
      await Promise.allSettled([...inFlight]);
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test ./test/unit/client/tool-calls.test.ts --timeout=60000`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

Run (from `packages/nax-agent-acp`): `bun run lint:fix && bun run typecheck && bun run check:all`
Expected: exit 0.

```bash
git add packages/nax-agent-acp/src/client/tool-calls.ts packages/nax-agent-acp/test/unit/client/tool-calls.test.ts
git commit -m "feat(nax-agent-acp): embedder tool-call semantics for the MCP tool host"
```

---

### Task 2: Pre-approval and the HTTP tool host

**Files:**
- Create: `packages/nax-agent-acp/src/client/pre-approval.ts`
- Create: `packages/nax-agent-acp/src/client/tool-host.ts`
- Create: `packages/nax-agent-acp/test/helpers/http.ts`
- Create: `packages/nax-agent-acp/test/helpers/mcp-client.ts`
- Test: `packages/nax-agent-acp/test/unit/client/pre-approval.test.ts`
- Test: `packages/nax-agent-acp/test/unit/client/tool-host.test.ts`

**Interfaces:**
- Consumes: `createToolCalls`, `ToolCalls`, `ToolCallDeps`, `NO_TURN_TEXT`, `TOO_MANY_TEXT`, `MAX_CONCURRENT_TOOL_CALLS` (Task 1); `AgentRegistryEntry` (`registry.ts`).
- Produces:
  ```ts
  // pre-approval.ts
  export const TOOL_HOST_SERVER_NAME = "nax";
  export function mcpToolRule(toolName: string): string;
  export function preApprovalMeta(
    kind: AgentRegistryEntry["preApproval"],
    toolNames: readonly string[],
  ): Readonly<Record<string, unknown>> | undefined;
  // tool-host.ts
  export type HttpMcpServer = Extract<McpServer, { type: "http" }>;
  export const TOOL_HOST_PATH = "/mcp";
  export const MAX_BODY_BYTES = 1048576;
  export function newToolHostToken(): string;
  export interface ToolHost {
    readonly token: string;
    start(): Promise<HttpMcpServer>;
    drain(): Promise<void>;
    stop(): Promise<void>;
  }
  export function createToolHost(calls: ToolCalls, token?: string): ToolHost;
  // test/helpers/http.ts
  export function rawRequest(input: RawRequest): Promise<RawResponse>;
  // test/helpers/mcp-client.ts
  export function mcpClient(url: string, token: string): Promise<Client>;
  ```

- [ ] **Step 1: Write the test helpers**

Create `packages/nax-agent-acp/test/helpers/http.ts`:

```ts
/** Raw HTTP to the tool host: what an MCP client never sends (wrong Host, Origin, oversized or invalid bodies). */
import { request } from "node:http";

export interface RawRequest {
  readonly port: number;
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Written in order, then the request ends. Omitted: headers only, and the request stays open. */
  readonly body?: readonly (string | Buffer)[];
}

export interface RawResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

/** Resolves on the response; a reset after it (an early refusal of a body still being sent) is ignored. */
export function rawRequest(input: RawRequest): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: input.port,
        method: input.method ?? "POST",
        path: input.path ?? "/mcp",
        headers: { ...input.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
          req.destroy();
        });
      },
    );
    req.on("error", reject);
    if (input.body === undefined) {
      req.flushHeaders();
      return;
    }
    for (const part of input.body) req.write(part);
    req.end();
  });
}
```

Create `packages/nax-agent-acp/test/helpers/mcp-client.ts`:

```ts
/** An MCP client on the tool host, as the agent's adapter would connect. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export async function mcpClient(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  return client;
}
```

- [ ] **Step 2: Write the failing tests**

Create `packages/nax-agent-acp/test/unit/client/pre-approval.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mcpToolRule, preApprovalMeta, TOOL_HOST_SERVER_NAME } from "#src/client/pre-approval";
import { registryEntry } from "#src/client/registry";

describe("pre-approval (spec R12, §6.6; D4-a)", () => {
  test("the server is named nax and each tool gets one exact rule", () => {
    expect(TOOL_HOST_SERVER_NAME).toBe("nax");
    expect(mcpToolRule("fetch_page")).toBe("mcp__nax__fetch_page");
  });

  test("claude: _meta.claudeCode.options.allowedTools, one rule per tool, nothing else", () => {
    expect(preApprovalMeta(registryEntry("claude")?.preApproval, ["lookup", "fetch-page"])).toEqual({
      claudeCode: { options: { allowedTools: ["mcp__nax__lookup", "mcp__nax__fetch-page"] } },
    });
  });

  test("an agent without a pre-approval mechanism: none", () => {
    expect(preApprovalMeta(registryEntry("codex")?.preApproval, ["lookup"])).toBeUndefined();
    expect(preApprovalMeta(undefined, ["lookup"])).toBeUndefined();
  });
});
```

Create `packages/nax-agent-acp/test/unit/client/tool-host.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import type { EmbedderTool, EmbedderToolContext, SessionAskPort } from "@nathapp/nax-agent";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import {
  createToolCalls,
  MAX_CONCURRENT_TOOL_CALLS,
  NO_TURN_TEXT,
  TOO_MANY_TEXT,
  type ToolCallDeps,
} from "#src/client/tool-calls";
import { createToolHost, MAX_BODY_BYTES, newToolHostToken, type ToolHost } from "#src/client/tool-host";
import { rawRequest } from "#test/helpers/http";
import { mcpClient } from "#test/helpers/mcp-client";

const hosts: ToolHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

const NO_ASK: SessionAskPort = {
  requestApproval: async () => ({ decision: "deny", decidedBy: "profile" }),
  recordAutoDecision: () => {},
  askQuestion: async () => null,
  noteQuestion: () => {},
};

const echo: EmbedderTool = {
  name: "echo",
  description: "Echo the input",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  approval: "never",
  run: async (input) => ({ content: JSON.stringify(input) }),
};

interface Started {
  readonly host: ToolHost;
  readonly url: string;
  readonly port: number;
  readonly token: string;
  /** Set to undefined to end the turn. */
  readonly turn: { id: string | undefined };
}

async function started(tools: readonly EmbedderTool[] = [echo]): Promise<Started> {
  const turn: { id: string | undefined } = { id: "turn-1" };
  const scope = new AbortController();
  const deps: ToolCallDeps = {
    sessionId: "s-1",
    tools,
    asks: NO_ASK,
    currentTurnId: () => turn.id,
    turnSignal: () => (turn.id === undefined ? undefined : scope.signal),
    secrets: [],
  };
  const host = createToolHost(createToolCalls(deps));
  hosts.push(host);
  const server = await host.start();
  return { host, url: server.url, port: Number(new URL(server.url).port), token: host.token, turn };
}

const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const LIST = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
const withToken = (token: string) => ({ ...MCP_HEADERS, authorization: `Bearer ${token}` });
const corsHeaders = (headers: Readonly<Record<string, unknown>>) =>
  Object.keys(headers).filter((name) => name.startsWith("access-control-"));

describe("start(): the session/new server entry (spec §6.6)", () => {
  test("127.0.0.1 on an ephemeral port, path /mcp, a 43-character base64url token", async () => {
    const s = await started();
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(s.port).toBeGreaterThan(0);
    expect(s.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("the entry carries the token as an Authorization header", async () => {
    const host = createToolHost(createToolCalls({ ...baseDeps(), tools: [echo] }));
    hosts.push(host);
    expect(await host.start()).toEqual({
      type: "http",
      name: "nax",
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
      headers: [{ name: "Authorization", value: `Bearer ${host.token}` }],
    });
  });

  test("each host gets its own 32-byte token", () => {
    const a = newToolHostToken();
    const b = newToolHostToken();
    expect(Buffer.from(a, "base64url")).toHaveLength(32);
    expect(a).not.toBe(b);
  });
});

function baseDeps(): ToolCallDeps {
  const scope = new AbortController();
  return {
    sessionId: "s-1",
    tools: [],
    asks: NO_ASK,
    currentTurnId: () => "turn-1",
    turnSignal: () => scope.signal,
    secrets: [],
  };
}

describe("MCP over the host", () => {
  test("tools/list is exactly the session's tools; tools/call round-trips", async () => {
    const s = await started();
    const client = await mcpClient(s.url, s.token);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toEqual(["echo"]);
      expect(await client.callTool({ name: "echo", arguments: { text: "hi" } })).toMatchObject({
        content: [{ type: "text", text: '{"text":"hi"}' }],
      });
    } finally {
      await client.close();
    }
  });

  test("a call after the turn ended: the no-turn tool error", async () => {
    const s = await started();
    s.turn.id = undefined;
    const client = await mcpClient(s.url, s.token);
    try {
      expect(await client.callTool({ name: "echo", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: NO_TURN_TEXT }],
        isError: true,
      });
    } finally {
      await client.close();
    }
  });

  test(`the ${MAX_CONCURRENT_TOOL_CALLS + 1}th concurrent call is refused and does not run`, async () => {
    let begun = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocking: EmbedderTool = {
      ...echo,
      name: "block",
      run: async () => {
        begun += 1;
        await gate;
        return { content: "done" };
      },
    };
    const s = await started([blocking]);
    const client = await mcpClient(s.url, s.token);
    try {
      const first = Array.from({ length: MAX_CONCURRENT_TOOL_CALLS }, () =>
        client.callTool({ name: "block", arguments: {} }),
      );
      await waitForCondition(() => begun === MAX_CONCURRENT_TOOL_CALLS, 3_000);
      expect(await client.callTool({ name: "block", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: TOO_MANY_TEXT }],
        isError: true,
      });
      expect(begun).toBe(MAX_CONCURRENT_TOOL_CALLS);
      release();
      await Promise.all(first);
    } finally {
      await client.close();
    }
  });
});

describe("the gate (spec §6.6 request checks; Review Focus 2)", () => {
  test("a raw tools/list with the token passes the gate (200) and carries no CORS header", async () => {
    const s = await started();
    const res = await rawRequest({ port: s.port, headers: withToken(s.token), body: [LIST] });
    expect(res.status).toBe(200);
    expect(res.body).toContain('"echo"');
    expect(corsHeaders(res.headers)).toEqual([]);
  });

  test.each([
    ["no Authorization header", {}],
    ["a wrong token", { authorization: "Bearer not-the-token" }],
    ["another scheme", { authorization: "Basic abc" }],
    ["an empty bearer", { authorization: "Bearer " }],
  ])("%s: 401, no CORS header", async (_label, extra) => {
    const s = await started();
    const res = await rawRequest({ port: s.port, headers: { ...MCP_HEADERS, ...extra }, body: [LIST] });
    expect(res.status).toBe(401);
    expect(corsHeaders(res.headers)).toEqual([]);
  });

  test("another host's token: 401", async () => {
    const a = await started();
    const b = await started();
    expect((await rawRequest({ port: a.port, headers: withToken(b.token), body: [LIST] })).status).toBe(401);
  });

  test("a Host other than 127.0.0.1:<port> (DNS rebinding): 403 even with the token", async () => {
    const s = await started();
    const res = await rawRequest({
      port: s.port,
      headers: { ...withToken(s.token), host: `localhost:${s.port}` },
      body: [LIST],
    });
    expect(res.status).toBe(403);
  });

  test("any Origin header: 403 even with the token", async () => {
    const s = await started();
    const res = await rawRequest({
      port: s.port,
      headers: { ...withToken(s.token), origin: `http://127.0.0.1:${s.port}` },
      body: [LIST],
    });
    expect(res.status).toBe(403);
  });

  test("another path: 404; GET: 405 with Allow: POST", async () => {
    const s = await started();
    expect((await rawRequest({ port: s.port, path: "/other", headers: withToken(s.token), body: [LIST] })).status).toBe(
      404,
    );
    const get = await rawRequest({ port: s.port, method: "GET", headers: withToken(s.token), body: [] });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe("POST");
  });

  test("a query string does not change the path check", async () => {
    const s = await started();
    expect((await rawRequest({ port: s.port, path: "/mcp?x=1", headers: withToken(s.token), body: [LIST] })).status).toBe(
      200,
    );
  });

  test("a declared content-length over 1 MiB: 413 before any body is read", async () => {
    const s = await started();
    const res = await rawRequest({
      port: s.port,
      headers: { ...withToken(s.token), "content-length": String(MAX_BODY_BYTES + 1) },
    });
    expect(res.status).toBe(413);
  });

  test("a streamed body over 1 MiB: 413", async () => {
    const s = await started();
    const half = Buffer.alloc(MAX_BODY_BYTES / 2 + 1, 0x20);
    const res = await rawRequest({
      port: s.port,
      headers: { ...withToken(s.token), "transfer-encoding": "chunked" },
      body: [half, half],
    });
    expect(res.status).toBe(413);
  });

  test("a body just under 1 MiB reaches MCP", async () => {
    const s = await started();
    const prefix = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_pad":"';
    const suffix = '"}}';
    const pad = "x".repeat(MAX_BODY_BYTES - prefix.length - suffix.length - 16);
    const res = await rawRequest({ port: s.port, headers: withToken(s.token), body: [prefix, pad, suffix] });
    expect(res.status).toBe(200);
  });

  test("invalid JSON: 400", async () => {
    const s = await started();
    expect((await rawRequest({ port: s.port, headers: withToken(s.token), body: ["{not json"] })).status).toBe(400);
  });
});

describe("drain and stop (spec §6.6 close; Review Focus 1, 3)", () => {
  test("stop(): the port refuses connections; stop() is idempotent; stop() before start() resolves", async () => {
    const s = await started();
    await s.host.stop();
    await s.host.stop();
    await expect(rawRequest({ port: s.port, headers: withToken(s.token), body: [LIST] })).rejects.toThrow();
    await createToolHost(createToolCalls(baseDeps())).stop();
  });

  test("stop() during a call: the call's signal aborts (the connection is dropped)", async () => {
    const seen: EmbedderToolContext[] = [];
    const hang: EmbedderTool = {
      ...echo,
      name: "hang",
      run: (_input, ctx) => {
        seen.push(ctx);
        return new Promise(() => {});
      },
    };
    const s = await started([hang]);
    const client = await mcpClient(s.url, s.token);
    void client.callTool({ name: "hang", arguments: {} }).catch(() => undefined);
    await waitForCondition(() => seen.length === 1, 3_000);
    await s.host.stop();
    await waitForCondition(() => seen[0]?.signal.aborted === true, 3_000);
    await s.host.drain();
    await client.close().catch(() => undefined);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test ./test/unit/client/pre-approval.test.ts ./test/unit/client/tool-host.test.ts --timeout=60000`
Expected: FAIL with `Cannot find module '#src/client/pre-approval'` and `'#src/client/tool-host'`.

- [ ] **Step 4: Write `pre-approval.ts`**

Create `packages/nax-agent-acp/src/client/pre-approval.ts`:

```ts
/**
 * Adapter pre-approval of embedder tools (S4 spec R12, §6.6; D4-a). Claude's
 * adapter (claude-agent-acp 0.85.1) keys an ACP MCP server by its `name` and
 * passes `_meta.claudeCode.options` through to the Claude Agent SDK, whose
 * `allowedTools` rules allow a tool without a permission request. One exact rule
 * per tool, `mcp__nax__<tool>`, so only the session's own tools are allowed. Tool
 * names are already restricted by the facade, so a rule never needs escaping.
 */
import type { AgentRegistryEntry } from "#src/client/registry";

/** The ACP MCP server name; the agent sees the tools as `mcp__nax__<tool>`. */
export const TOOL_HOST_SERVER_NAME = "nax";

export function mcpToolRule(toolName: string): string {
  return `mcp__${TOOL_HOST_SERVER_NAME}__${toolName}`;
}

/** The session/new `_meta` that pre-approves the tools, or undefined when the agent has no mechanism. */
export function preApprovalMeta(
  kind: AgentRegistryEntry["preApproval"],
  toolNames: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  if (kind !== "claudeCode.allowedTools") return undefined;
  return { claudeCode: { options: { allowedTools: toolNames.map(mcpToolRule) } } };
}
```

- [ ] **Step 5: Write `tool-host.ts`**

Create `packages/nax-agent-acp/src/client/tool-host.ts`:

```ts
/**
 * The MCP tool host (S4 spec §6.6): an HTTP server on 127.0.0.1, an ephemeral
 * port, path /mcp, serving the session's embedder tools to the agent. Before a
 * request reaches MCP it passes the gate (D4-e): path, method, Host (DNS
 * rebinding), Origin, the bearer token (constant time) and the 1 MiB body cap.
 * Each POST then gets a fresh stateless MCP server and transport (D4-d): the SDK
 * refuses to reuse a stateless transport. The token exists before the host
 * listens, so it joins the session's redaction set from the start (D4-i). stop()
 * revokes the token, drops open connections and closes the port.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { McpServer } from "@agentclientprotocol/sdk";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_HOST_SERVER_NAME } from "#src/client/pre-approval";
import type { ToolCalls } from "#src/client/tool-calls";

export type HttpMcpServer = Extract<McpServer, { type: "http" }>;

export const TOOL_HOST_PATH = "/mcp";
export const MAX_BODY_BYTES = 1024 * 1024;
const LOOPBACK = "127.0.0.1";
const BEARER = "Bearer ";
/** MCP-level server identity shown to the agent; not the package version. */
const SERVER_INFO = { name: TOOL_HOST_SERVER_NAME, version: "1.0.0" };

export interface ToolHost {
  /** Known before start(), so every redaction set can include it. */
  readonly token: string;
  /** Listens on 127.0.0.1, an ephemeral port; returns the session/new server entry. */
  start(): Promise<HttpMcpServer>;
  /** Resolves once every call in flight has answered. */
  drain(): Promise<void>;
  /** Revokes the token, drops open connections, closes the port. Idempotent; safe before start(). */
  stop(): Promise<void>;
}

interface HostState {
  readonly token: string;
  readonly calls: ToolCalls;
  port: number;
  revoked: boolean;
}

interface Refusal {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
}

type Body =
  | { readonly kind: "json"; readonly value: unknown }
  | { readonly kind: "too-large" }
  | { readonly kind: "invalid" };

export function newToolHostToken(): string {
  return randomBytes(32).toString("base64url");
}

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

/** Constant time: both sides are hashed to the same length first. */
function tokenMatches(header: string | undefined, token: string): boolean {
  const presented = header?.startsWith(BEARER) === true ? header.slice(BEARER.length) : "";
  return timingSafeEqual(digest(presented), digest(token));
}

function pathOf(url: string | undefined): string {
  return (url ?? "").split("?")[0] ?? "";
}

/** Everything checked before the body is read, in order (D4-e). */
function refusalFor(state: HostState, req: IncomingMessage): Refusal | undefined {
  if (pathOf(req.url) !== TOOL_HOST_PATH) return { status: 404 };
  if (req.method !== "POST") return { status: 405, headers: { allow: "POST" } };
  if (req.headers.host !== `${LOOPBACK}:${state.port}` || req.headers.origin !== undefined) return { status: 403 };
  if (state.revoked || !tokenMatches(req.headers.authorization, state.token)) return { status: 401 };
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
    return { status: 413, headers: { connection: "close" } };
  }
  return undefined;
}

function reply(res: ServerResponse, refusal: Refusal): void {
  res.writeHead(refusal.status, { "content-type": "text/plain; charset=utf-8", ...refusal.headers });
  res.end(`${refusal.status}\n`);
}

function parseJson(bytes: Buffer): Body {
  try {
    return { kind: "json", value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    return { kind: "invalid" };
  }
}

/** At most MAX_BODY_BYTES kept; past that the rest is drained and discarded, so the 413 is still delivered. */
function readBody(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("end", () => resolve(size > MAX_BODY_BYTES ? { kind: "too-large" } : parseJson(Buffer.concat(chunks))));
    req.on("error", () => resolve({ kind: "invalid" }));
    req.on("close", () => resolve({ kind: "invalid" }));
  });
}

/** One stateless MCP server per request (D4-d). Its calls abort when the response closes. */
async function serveMcp(calls: ToolCalls, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  const gone = new AbortController();
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: calls.list() }));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    calls.call(request.params.name, request.params.arguments, gone.signal),
  );
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  res.on("close", () => {
    gone.abort();
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

async function handle(state: HostState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const refusal = refusalFor(state, req);
  if (refusal !== undefined) return reply(res, refusal);
  const body = await readBody(req);
  if (body.kind === "too-large") return reply(res, { status: 413, headers: { connection: "close" } });
  if (body.kind === "invalid") return reply(res, { status: 400 });
  await serveMcp(state.calls, req, res, body.value);
}

function failed(res: ServerResponse): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  reply(res, { status: 500 });
}

function listen(http: HttpServer): Promise<number> {
  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, LOOPBACK, () => {
      http.off("error", reject);
      const address = http.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
}

function close(http: HttpServer): Promise<void> {
  if (!http.listening) return Promise.resolve();
  return new Promise((resolve) => {
    http.close(() => resolve());
    http.closeAllConnections();
  });
}

export function createToolHost(calls: ToolCalls, token: string = newToolHostToken()): ToolHost {
  const state: HostState = { token, calls, port: 0, revoked: false };
  const http = createServer((req, res) => {
    void handle(state, req, res).catch(() => failed(res));
  });
  let stopping: Promise<void> | undefined;
  return {
    token,
    async start() {
      state.port = await listen(http);
      return {
        type: "http",
        name: TOOL_HOST_SERVER_NAME,
        url: `http://${LOOPBACK}:${state.port}${TOOL_HOST_PATH}`,
        headers: [{ name: "Authorization", value: `${BEARER}${token}` }],
      };
    },
    drain: () => calls.drain(),
    stop() {
      state.revoked = true;
      stopping ??= close(http);
      return stopping;
    },
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test ./test/unit/client/pre-approval.test.ts ./test/unit/client/tool-host.test.ts --timeout=60000`
Expected: PASS.

If the streamed-413 test sees a reset before the response on this runtime, keep the server as written and make the client resolve on the response only: the server behaviour under test is "drained, then 413".

- [ ] **Step 7: Lint, typecheck, commit**

Run: `bun run lint:fix && bun run typecheck && bun run check:all`
Expected: exit 0.

```bash
git add packages/nax-agent-acp/src/client/pre-approval.ts packages/nax-agent-acp/src/client/tool-host.ts packages/nax-agent-acp/test/helpers/http.ts packages/nax-agent-acp/test/helpers/mcp-client.ts packages/nax-agent-acp/test/unit/client/pre-approval.test.ts packages/nax-agent-acp/test/unit/client/tool-host.test.ts
git commit -m "feat(nax-agent-acp): loopback MCP tool host with token, Host/Origin and body gates; pre-approval rules"
```

---

### Task 3: The open sequence starts the host; the router exposes the turn's signal

**Files:**
- Modify: `packages/nax-agent-acp/src/client/open.ts` (whole file below)
- Modify: `packages/nax-agent-acp/src/client/inbound.ts` (two exact edits)
- Test: `packages/nax-agent-acp/test/unit/client/open.test.ts` (append a describe)
- Test: `packages/nax-agent-acp/test/unit/client/inbound.test.ts` (append a describe)

**Interfaces:**
- Consumes: `ToolHost`, `HttpMcpServer` (Task 2); `preApprovalMeta` (Task 2).
- Produces:
  ```ts
  // open.ts
  export async function openAcpSession(
    options: ResolvedAcpOptions,
    ctx: BackendOpenContext,
    handlers: InboundHandlers,
    launch: LaunchFn,
    host?: ToolHost,
  ): Promise<OpenedAcp>;
  // inbound.ts, on InboundRouter
  activeSignal(): AbortSignal | undefined;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `packages/nax-agent-acp/test/unit/client/inbound.test.ts`:

```ts
describe("activeSignal (S4-4: what an embedder tool call runs under)", () => {
  test("undefined between turns; the binding's signal during one; aborted by release", async () => {
    const router = createInboundRouter(recordingDecider().decide);
    expect(router.activeSignal()).toBeUndefined();
    const release = router.attach("agent-1", createTurnCollector(undefined), IDLE);
    const signal = router.activeSignal();
    expect(signal?.aborted).toBe(false);
    await release();
    expect(signal?.aborted).toBe(true);
    expect(router.activeSignal()).toBeUndefined();
  });

  test("the turn signal aborting aborts it", () => {
    const router = createInboundRouter(recordingDecider().decide);
    const turn = new AbortController();
    void router.attach("agent-1", createTurnCollector(undefined), turn.signal);
    turn.abort();
    expect(router.activeSignal()?.aborted).toBe(true);
  });
});
```

Append to `packages/nax-agent-acp/test/unit/client/open.test.ts`. First add these imports at the top of the file, next to the existing ones:

```ts
import type { EmbedderTool } from "@nathapp/nax-agent";
import type { HttpMcpServer, ToolHost } from "#src/client/tool-host";
```

Then append:

```ts
describe("openAcpSession: the tool host (spec §6.3 steps 3-4, §6.6)", () => {
  const SERVER: HttpMcpServer = {
    type: "http",
    name: "nax",
    url: "http://127.0.0.1:1/mcp",
    headers: [{ name: "Authorization", value: "Bearer test-token-0123456789" }],
  };
  const tool = (name: string): EmbedderTool => ({
    name,
    description: name,
    inputSchema: { type: "object" },
    approval: "never",
    run: async () => ({ content: "" }),
  });
  const HTTP_CLAUDE: FakeScript = { ...CLAUDE_SCRIPT, capabilities: { mcpCapabilities: { http: true } } };

  function stubHost(start: () => Promise<HttpMcpServer> = async () => SERVER) {
    const counts = { starts: 0 };
    const host: ToolHost = {
      token: "test-token-0123456789",
      start: () => {
        counts.starts += 1;
        return start();
      },
      drain: async () => {},
      stop: async () => {},
    };
    return { host, counts };
  }

  async function openWithTools(script: FakeScript, host: ToolHost, extra: Partial<AcpBackendOptions> = {}) {
    const fake = inMemoryAgent(script);
    const ctx = openContext(dir, { tools: [tool("lookup"), tool("fetch_page")] });
    const opened = openAcpSession(
      options(extra),
      ctx,
      createInboundRouter(async (r) => rejectLocally(r)).handlers,
      fake.launch,
      host,
    );
    return { fake, opened };
  }

  test("session/new carries the host's server entry and one pre-approval rule per tool", async () => {
    const { host, counts } = stubHost();
    const { fake, opened } = await openWithTools(HTTP_CLAUDE, host);
    await opened;
    expect(counts.starts).toBe(1);
    expect(fake.callsTo("session/new")).toEqual([
      {
        cwd: dir,
        mcpServers: [SERVER],
        _meta: { claudeCode: { options: { allowedTools: ["mcp__nax__lookup", "mcp__nax__fetch_page"] } } },
      },
    ]);
  });

  test("no HTTP MCP support: CAPABILITY_UNSUPPORTED tools after initialize; the host never starts; killed", async () => {
    const { host, counts } = stubHost();
    const { fake, opened } = await openWithTools(CLAUDE_SCRIPT, host);
    const err = sessionError(await rejection(opened));
    expect(err.code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
    expect(err.context).toMatchObject({ capability: "tools" });
    expect(counts.starts).toBe(0);
    expect(fake.callsTo("initialize")).toHaveLength(1);
    expect(fake.callsTo("session/new")).toEqual([]);
    expect(fake.kills()).toBe(1);
  });

  test("an agent without pre-approval (codex): CAPABILITY_UNSUPPORTED tools; the host never starts", async () => {
    const { host, counts } = stubHost();
    const { opened } = await openWithTools({ capabilities: { mcpCapabilities: { http: true } } }, host, {
      agent: "codex",
    });
    expect(sessionError(await rejection(opened)).context).toMatchObject({ capability: "tools" });
    expect(counts.starts).toBe(0);
  });

  test("a host that cannot start: BACKEND_UNAVAILABLE and the agent is killed", async () => {
    const { host } = stubHost(() => Promise.reject(new Error("EADDRNOTAVAIL")));
    const { fake, opened } = await openWithTools(HTTP_CLAUDE, host);
    const err = sessionError(await rejection(opened));
    expect(err.code).toBe("AGENT_SESSION_BACKEND_UNAVAILABLE");
    expect(err.message).toContain("the tool host could not start: EADDRNOTAVAIL");
    expect(fake.callsTo("session/new")).toEqual([]);
    expect(fake.kills()).toBe(1);
  });
});
```

`options({ agent: "codex" })` keeps `command: "fake-claude"` from the existing `options` helper (it spreads `extra` last), so the registry agent launches the in-memory fake.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ./test/unit/client/inbound.test.ts ./test/unit/client/open.test.ts --timeout=60000`
Expected: FAIL: `router.activeSignal is not a function`, and the tool-host open tests fail (the host is ignored; `session/new` has `mcpServers: []`).

- [ ] **Step 3: `inbound.ts`: two exact edits**

Edit 1, in the `InboundRouter` interface. Replace:

```ts
  attach(agentSessionId: string, collector: TurnCollector, turnSignal: AbortSignal): () => Promise<void>;
}
```

with:

```ts
  attach(agentSessionId: string, collector: TurnCollector, turnSignal: AbortSignal): () => Promise<void>;
  /**
   * The running turn's binding signal, or undefined between turns: what an
   * embedder tool call runs under (S4-4 D4-f). It aborts on cancel, timeout,
   * close and process exit, and when the binding is released.
   */
  activeSignal(): AbortSignal | undefined;
}
```

Edit 2, in `createInboundRouter`'s returned object. Replace:

```ts
    attach(sessionId, collector, turnSignal) {
```

with:

```ts
    activeSignal: () => active?.signal,
    attach(sessionId, collector, turnSignal) {
```

- [ ] **Step 4: `open.ts`: the whole new file**

Replace `packages/nax-agent-acp/src/client/open.ts` with:

```ts
/**
 * Opening an ACP session (S4 spec §6.3 step 1): spawn, initialize, capability
 * check, the tool host when the session has tools, session/new (with the host's
 * server entry and the pre-approval _meta, §6.6), the profile's mode, then the
 * model, then the initial transcript document. Every failure after the spawn
 * kills the agent's process group before it propagates, so a failed open leaves
 * no process behind; the caller stops the tool host. Each agent request is
 * bounded by initializeTimeoutMs (D-c) and by openSignal: close() during open
 * rejects AGENT_SESSION_CLOSED.
 */
import { type McpServer, PROTOCOL_VERSION, type SessionConfigOption } from "@agentclientprotocol/sdk";
import { type BackendOpenContext, NaxError, type TranscriptDoc } from "@nathapp/nax-agent";
import {
  buildCapabilityRecord,
  type CapabilityRecord,
  modeFor,
  modelOptionId,
  offersValue,
  unmetRequirement,
} from "#src/client/capabilities";
import { type AcpLink, type InboundHandlers, openConnection } from "#src/client/connection";
import {
  backendUnavailable,
  capabilityUnsupported,
  closedDuringOpen,
  EXCERPT_BYTES,
  openRequestError,
  rpcErrorOf,
} from "#src/client/errors";
import { agentGoneError, type LaunchedAgent, type LaunchFn, pickCandidate } from "#src/client/launch";
import type { ResolvedAcpOptions } from "#src/client/options";
import { preApprovalMeta } from "#src/client/pre-approval";
import { race } from "#src/client/race";
import type { LaunchCandidate } from "#src/client/registry";
import type { ToolHost } from "#src/client/tool-host";

/** An agent session id longer than this is not trusted (Review Focus 5). */
const MAX_SESSION_ID_CHARS = 512;

export interface OpenedAcp {
  readonly launched: LaunchedAgent;
  readonly link: AcpLink;
  readonly record: CapabilityRecord;
  readonly agentSessionId: string;
}

interface Opening {
  readonly options: ResolvedAcpOptions;
  readonly ctx: BackendOpenContext;
  readonly launched: LaunchedAgent;
  readonly link: AcpLink;
  readonly host: ToolHost | undefined;
}

/** What session/new adds to `cwd`: the tool host's entry and the pre-approval `_meta` (§6.6). */
interface SessionSetup {
  readonly mcpServers: McpServer[];
  readonly _meta?: Record<string, unknown>;
}

function chooseLaunch(options: ResolvedAcpOptions): LaunchCandidate {
  if (options.launch.kind === "explicit") return options.launch.candidate;
  const found = pickCandidate(options.launch.candidates, options.env.PATH);
  if (found !== undefined) return found;
  const tried = options.launch.candidates.map((candidate) => candidate.command);
  throw backendUnavailable(
    `no launch command for "${options.agentName}" was found on PATH (tried ${tried.join(", ")})`,
    {
      tried,
    },
  );
}

export async function openAcpSession(
  options: ResolvedAcpOptions,
  ctx: BackendOpenContext,
  handlers: InboundHandlers,
  launch: LaunchFn,
  host?: ToolHost,
): Promise<OpenedAcp> {
  if (ctx.openSignal.aborted) throw closedDuringOpen(ctx.sessionId);
  const candidate = chooseLaunch(options);
  const launched = launch({ command: candidate.command, args: candidate.args, cwd: ctx.workdir, env: options.env });
  const link = openConnection(launched.target, handlers);
  void launched.exited.then(() =>
    link.close(new NaxError("The ACP agent process exited", "ACP_AGENT_EXITED", { stage: "acp" })),
  );
  try {
    return await establish({ options, ctx, launched, link, host });
  } catch (err) {
    launched.kill();
    link.close();
    throw err;
  }
}

async function step<T>(o: Opening, label: string, request: Promise<T>): Promise<T> {
  const result = await race(request, { timeoutMs: o.options.initializeTimeoutMs, signal: o.ctx.openSignal });
  switch (result.kind) {
    case "ok":
      return result.value;
    case "aborted":
      throw closedDuringOpen(o.ctx.sessionId);
    case "timeout":
      throw backendUnavailable(`${label} timed out after ${o.options.initializeTimeoutMs} ms`, {
        during: label,
        stderr: o.launched.stderr.excerpt({ maxBytes: EXCERPT_BYTES, secrets: o.options.secrets }),
      });
    case "failed": {
      const rpc = rpcErrorOf(result.error);
      if (rpc !== undefined) throw openRequestError(label, rpc, o.options.secrets);
      throw await agentGoneError(label, o.launched, o.options.secrets);
    }
  }
}

async function establish(o: Opening): Promise<OpenedAcp> {
  const init = await step(
    o,
    "initialize",
    o.link.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
  );
  if (init.protocolVersion !== PROTOCOL_VERSION) {
    throw backendUnavailable(
      `the agent speaks ACP protocol version ${String(init.protocolVersion)}; this client speaks ${PROTOCOL_VERSION}`,
      { protocolVersion: String(init.protocolVersion).slice(0, 32) },
    );
  }
  const record = buildCapabilityRecord(init, o.options.entry);
  const unmet = unmetRequirement(record, {
    profile: o.ctx.profile,
    toolCount: o.ctx.tools.length,
    resume: o.ctx.resume !== undefined,
  });
  if (unmet !== undefined) throw capabilityUnsupported(unmet.capability, unmet.reason);
  const setup = await sessionSetup(o);
  const created = await step(o, "session/new", o.link.newSession({ cwd: o.ctx.workdir, ...setup }));
  const agentSessionId = created.sessionId;
  if (typeof agentSessionId !== "string" || agentSessionId === "" || agentSessionId.length > MAX_SESSION_ID_CHARS) {
    throw backendUnavailable("session/new returned no usable session id");
  }
  await applyConfig(o, agentSessionId, created.configOptions ?? []);
  await o.ctx.transcriptStore.save(o.ctx.sessionId, initialDoc(o, record, agentSessionId));
  return { launched: o.launched, link: o.link, record, agentSessionId };
}

/** §6.3 step 3: start the tool host when the session has tools; its entry and the pre-approval `_meta` (§6.6). */
async function sessionSetup(o: Opening): Promise<SessionSetup> {
  if (o.host === undefined) return { mcpServers: [] };
  const meta = preApprovalMeta(
    o.options.entry?.preApproval,
    o.ctx.tools.map((tool) => tool.name),
  );
  if (meta === undefined) throw capabilityUnsupported("tools", "the agent has no way to pre-approve embedder tools");
  const server = await o.host.start().catch((err: unknown) => {
    throw backendUnavailable(`the tool host could not start: ${err instanceof Error ? err.message : String(err)}`);
  });
  return { mcpServers: [server], _meta: { ...meta } };
}

/** §6.3 step 5: the profile's mode, then the model. Only values the agent offered are set. */
async function applyConfig(o: Opening, sessionId: string, offered: readonly SessionConfigOption[]): Promise<void> {
  const mode = modeFor(o.ctx.profile, o.options.entry);
  if (mode !== undefined && !offersValue(offered, mode.configId, mode.value)) {
    throw capabilityUnsupported("profile", `the agent does not offer ${mode.configId} "${mode.value}"`);
  }
  const afterMode =
    mode === undefined
      ? offered
      : ((await step(o, "session/set_config_option", o.link.setConfigOption({ sessionId, ...mode }))).configOptions ??
        offered);
  const model = o.options.model;
  if (model === undefined) return;
  const configId = modelOptionId(afterMode, model);
  if (configId === undefined) throw capabilityUnsupported("model", `the agent offers no model option "${model}"`);
  await step(o, "session/set_config_option", o.link.setConfigOption({ sessionId, configId, value: model }));
}

function initialDoc(o: Opening, record: CapabilityRecord, agentSessionId: string): TranscriptDoc {
  return {
    backend: o.options.kind,
    acp: {
      agentSessionId,
      agent: o.options.agentName,
      ...(record.agentVersion === undefined ? {} : { agentVersion: record.agentVersion }),
      cwd: o.ctx.workdir,
    },
    messages: [],
    savedAt: new Date().toISOString(),
  };
}
```

What changed against the S4-3 file, for review: the header, the `McpServer` and `preApprovalMeta`/`ToolHost` imports, `Opening.host`, `SessionSetup`, the `host` parameter of `openAcpSession` passed into `establish`, `sessionSetup()` and the `...setup` spread in `session/new`. Everything else is byte-for-byte the S4-3 code.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test ./test/unit/client/inbound.test.ts ./test/unit/client/open.test.ts --timeout=60000`
Expected: PASS, including every existing open test (`session/new` is still exactly `{ cwd, mcpServers: [] }` without a host).

- [ ] **Step 6: Lint, typecheck, commit**

Run: `bun run lint:fix && bun run typecheck && bun run check:all`
Expected: exit 0.

```bash
git add packages/nax-agent-acp/src/client/open.ts packages/nax-agent-acp/src/client/inbound.ts packages/nax-agent-acp/test/unit/client/open.test.ts packages/nax-agent-acp/test/unit/client/inbound.test.ts
git commit -m "feat(nax-agent-acp): open starts the tool host and sends its server and pre-approval; router exposes the turn signal"
```

---

### Task 4: `acpBackend()` serves embedder tools, end to end in process

**Files:**
- Create: `packages/nax-agent-acp/test/fixtures/fake-agent/mcp.ts`
- Modify: `packages/nax-agent-acp/test/fixtures/fake-agent/script.ts` (two exact edits)
- Modify: `packages/nax-agent-acp/test/fixtures/fake-agent/agent.ts` (exact edits below)
- Modify: `packages/nax-agent-acp/src/client/backend.ts` (whole file below)
- Modify: `packages/nax-agent-acp/test/unit/client/backend.test.ts` (one test removed)
- Test: `packages/nax-agent-acp/test/unit/client/backend-tools.test.ts`

**Interfaces:**
- Consumes: `createToolCalls` (Task 1); `createToolHost`, `newToolHostToken`, `ToolHost` (Task 2); `openAcpSession(..., host)`, `router.activeSignal()` (Task 3).
- Produces: `acpBackend()` accepting `tools`. The fake agent's `McpCallStep` (`{ kind: "mcpCall"; tool; input?; detached? }`) and `fail.echoMcpAuth`; records `mcp-result` `{ tool, result }` and `mcp-error` `{ tool, message }`.

- [ ] **Step 1: Extend the fake agent**

Edit `packages/nax-agent-acp/test/fixtures/fake-agent/script.ts`.

Edit 1. Replace:

```ts
  /** The prompt request fails with this JSON-RPC error. */
  | { readonly kind: "fail"; readonly failure: RpcFailure };
```

with:

```ts
  /** Calls an embedder tool through the session's HTTP MCP server, as an MCP client (S4-4 D4-k). */
  | McpCallStep
  /** The prompt request fails with this JSON-RPC error; `echoMcpAuth` appends the MCP server's Authorization value (leak tests). */
  | { readonly kind: "fail"; readonly failure: RpcFailure; readonly echoMcpAuth?: boolean };

/** Records `mcp-result` `{ tool, result }` or `mcp-error` `{ tool, message }`. */
export interface McpCallStep {
  readonly kind: "mcpCall";
  readonly tool: string;
  readonly input?: Readonly<Record<string, unknown>>;
  /** Sent without waiting for the result; `settled` waits for it. */
  readonly detached?: boolean;
}
```

Edit 2. In the `FakeStep` doc for `settled`, replace:

```ts
  /** Waits until every detached permission request of this prompt has been answered. */
```

with:

```ts
  /** Waits until every detached permission request and MCP call of this prompt has been answered. */
```

Create `packages/nax-agent-acp/test/fixtures/fake-agent/mcp.ts`:

```ts
/**
 * The fake ACP agent's MCP client (S4-4 D4-k): calls one tool on the session's
 * HTTP MCP server (the `mcpServers` session/new received), as Claude's adapter
 * would. Erasable TypeScript only: Node runs it with type stripping.
 */
import type { McpServer } from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FakeHooks, McpCallStep } from "./script.ts";

interface HttpTarget {
  readonly url: string;
  readonly headers: Record<string, string>;
}

export function httpServerOf(servers: readonly McpServer[]): HttpTarget | undefined {
  for (const server of servers) {
    if ("type" in server && server.type === "http") {
      return { url: server.url, headers: Object.fromEntries(server.headers.map((h) => [h.name, h.value])) };
    }
  }
  return undefined;
}

export async function callMcpTool(step: McpCallStep, servers: readonly McpServer[], hooks: FakeHooks): Promise<void> {
  const target = httpServerOf(servers);
  if (target === undefined) {
    hooks.record("mcp-error", { tool: step.tool, message: "no HTTP MCP server" });
    return;
  }
  const client = new Client({ name: "fake-agent", version: "0.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(target.url), { requestInit: { headers: target.headers } }),
    );
    const result = await client.callTool({ name: step.tool, arguments: { ...step.input } });
    hooks.record("mcp-result", { tool: step.tool, result });
  } catch (error) {
    hooks.record("mcp-error", { tool: step.tool, message: String(error) });
  } finally {
    await client.close().catch(() => undefined);
  }
}
```

Edit `packages/nax-agent-acp/test/fixtures/fake-agent/agent.ts`:

Edit A, the imports. Replace:

```ts
import {
  type AgentApp,
  type AgentContext,
  agent,
  methods,
  type PermissionOption,
  PROTOCOL_VERSION,
  type PromptResponse,
  RequestError,
  type StopReason,
} from "@agentclientprotocol/sdk";
import type { FakeHooks, FakeScript, FakeStep, FakeTurn, PermissionStep, RpcFailure } from "./script.ts";
```

with:

```ts
import {
  type AgentApp,
  type AgentContext,
  agent,
  type McpServer,
  methods,
  type PermissionOption,
  PROTOCOL_VERSION,
  type PromptResponse,
  RequestError,
  type StopReason,
} from "@agentclientprotocol/sdk";
import { callMcpTool, httpServerOf } from "./mcp.ts";
import type { FakeHooks, FakeScript, FakeStep, FakeTurn, McpCallStep, PermissionStep, RpcFailure } from "./script.ts";
```

Edit B, `PromptState` and `newPromptState`. Replace:

```ts
interface PromptState {
  readonly cancelled: Promise<void>;
  readonly markCancelled: () => void;
  /** Detached permission requests of this prompt, settled when answered. */
  readonly detached: Promise<void>[];
}

function newPromptState(): PromptState {
  let mark: () => void = () => {};
  const cancelled = new Promise<void>((resolve) => {
    mark = resolve;
  });
  return { cancelled, markCancelled: () => mark(), detached: [] };
}
```

with:

```ts
interface PromptState {
  readonly cancelled: Promise<void>;
  readonly markCancelled: () => void;
  /** Detached permission requests and MCP calls of this prompt, settled when answered. */
  readonly detached: Promise<void>[];
  /** The mcpServers session/new received. */
  readonly mcpServers: readonly McpServer[];
}

function newPromptState(mcpServers: readonly McpServer[]): PromptState {
  let mark: () => void = () => {};
  const cancelled = new Promise<void>((resolve) => {
    mark = resolve;
  });
  return { cancelled, markCancelled: () => mark(), detached: [], mcpServers };
}

function withMcpAuth(failure: RpcFailure, servers: readonly McpServer[]): RpcFailure {
  return { ...failure, message: `${failure.message} ${httpServerOf(servers)?.headers.Authorization ?? ""}` };
}

function mcpStep(step: McpCallStep, state: PromptState, hooks: FakeHooks): Promise<void> {
  const call = callMcpTool(step, state.mcpServers, hooks);
  if (step.detached !== true) return call;
  state.detached.push(call);
  return Promise.resolve();
}
```

Edit C, in `runStep`. Replace:

```ts
    case "exit":
      return hooks.exit(step.code, step.stderr);
    case "fail":
      throw rpcError(step.failure);
```

with:

```ts
    case "mcpCall":
      await mcpStep(step, state, hooks);
      return undefined;
    case "exit":
      return hooks.exit(step.code, step.stderr);
    case "fail":
      throw rpcError(step.echoMcpAuth === true ? withMcpAuth(step.failure, state.mcpServers) : step.failure);
```

Edit D, in `buildFakeAgent`. Replace:

```ts
  let promptCount = 0;
  let prompt: PromptState | undefined;
```

with:

```ts
  let promptCount = 0;
  let prompt: PromptState | undefined;
  let mcpServers: readonly McpServer[] = [];
```

Replace:

```ts
      hooks.record("session/new", ctx.params);
      if (script.newSessionFailure !== undefined) throw rpcError(script.newSessionFailure);
```

with:

```ts
      hooks.record("session/new", ctx.params);
      mcpServers = ctx.params.mcpServers;
      if (script.newSessionFailure !== undefined) throw rpcError(script.newSessionFailure);
```

Replace:

```ts
      prompt = newPromptState();
```

with:

```ts
      prompt = newPromptState(mcpServers);
```

- [ ] **Step 2: Write the failing end-to-end tests**

Create `packages/nax-agent-acp/test/unit/client/backend-tools.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ASK_DENIED_REASON,
  type AgentSession,
  type AgentSessionProfile,
  createAgentSession,
  createMemoryTranscriptStore,
  type EmbedderTool,
  type EmbedderToolContext,
  type SessionEvent,
  type TranscriptStore,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import { z } from "zod";
import { _acpBackendDeps, acpBackend } from "#src/client/backend";
import type { AcpBackendOptions } from "#src/client/options";
import { approvalReason, NO_TURN_TEXT } from "#src/client/tool-calls";
import { CLAUDE_CONFIG_OPTIONS, type FakeScript, type FakeStep } from "#test/fixtures/fake-agent/script";
import { rejection, sessionError } from "#test/helpers/errors";
import { type InMemoryAgent, inMemoryAgent } from "#test/helpers/in-memory-launch";
import { mcpClient } from "#test/helpers/mcp-client";
import { driveTurn, endOf, indexOfType } from "#test/helpers/session-events";

const realLaunch = _acpBackendDeps.launch;
const sessions: AgentSession[] = [];
let workdir: string;

beforeEach(() => {
  workdir = makeTempDir("acp-tools-");
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  _acpBackendDeps.launch = realLaunch;
  cleanupTempDir(workdir);
});

/** Claude as the fake offers it, with HTTP MCP. */
const HTTP_CLAUDE: FakeScript = {
  agentInfo: { name: "claude-agent-acp", version: "0.85.1" },
  configOptions: CLAUDE_CONFIG_OPTIONS,
  capabilities: { mcpCapabilities: { http: true } },
};

interface Ran {
  readonly input: unknown;
  readonly ctx: EmbedderToolContext;
}

function lookupTool(approval: "never" | "always", ran: Ran[]): EmbedderTool {
  return {
    name: "lookup",
    description: "Look a word up",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
    approval,
    describe: (input) => `look up ${JSON.stringify(input)}`,
    run: async (input, ctx) => {
      ran.push({ input, ctx });
      return { content: `found: ${JSON.stringify(input)}` };
    },
  };
}

function hangingTool(seen: EmbedderToolContext[]): EmbedderTool {
  return {
    name: "slow",
    description: "Never finishes and ignores its signal",
    inputSchema: { type: "object" },
    approval: "never",
    run: (_input, ctx) => {
      seen.push(ctx);
      return new Promise(() => {});
    },
  };
}

interface Opened {
  readonly fake: InMemoryAgent;
  readonly session: AgentSession;
  readonly store: TranscriptStore;
}

async function open(
  profile: AgentSessionProfile,
  steps: readonly FakeStep[],
  tools: readonly EmbedderTool[],
  script: FakeScript = {},
  agent: AcpBackendOptions["agent"] = "claude",
): Promise<Opened> {
  const fake = inMemoryAgent({ ...HTTP_CLAUDE, turns: [{ steps }], ...script });
  _acpBackendDeps.launch = fake.launch;
  const store = createMemoryTranscriptStore();
  const session = await createAgentSession({
    backend: acpBackend({ agent, allowUnsandboxed: true, command: "fake-agent" }),
    profile,
    ...(profile === "none" ? {} : { workdir }),
    tools,
    transcriptStore: store,
    sessionId: "s-1",
  });
  sessions.push(session);
  return { fake, session, store };
}

const NEW_SESSION = z.object({
  mcpServers: z.array(
    z.object({
      type: z.literal("http"),
      name: z.string(),
      url: z.string(),
      headers: z.array(z.object({ name: z.string(), value: z.string() })),
    }),
  ),
});

/** The host's url and token, as the agent received them in session/new. */
function hostOf(fake: InMemoryAgent): { url: string; token: string } {
  const server = NEW_SESSION.parse(fake.callsTo("session/new")[0]).mcpServers[0];
  if (server === undefined) throw new Error("session/new carried no MCP server");
  const auth = server.headers.find((h) => h.name === "Authorization")?.value ?? "";
  return { url: server.url, token: auth.replace(/^Bearer /, "") };
}

const results = (o: Opened) => o.fake.callsTo("mcp-result");
const find = (events: readonly SessionEvent[], type: SessionEvent["type"]) => events.find((e) => e.type === type);
const approvals = (events: readonly SessionEvent[]) => events.filter((e) => e.type.startsWith("approval_"));
const call = (input: Record<string, unknown> = { q: "acp" }): FakeStep => ({ kind: "mcpCall", tool: "lookup", input });

describe("approval never (spec §6.6)", () => {
  test("full: session/new carries the host and the pre-approval rule; the agent's call runs the tool", async () => {
    const ran: Ran[] = [];
    const o = await open("full", [call(), { kind: "text", text: "done" }], [lookupTool("never", ran)]);
    expect(o.fake.callsTo("session/new")[0]).toMatchObject({
      cwd: workdir,
      mcpServers: [
        {
          type: "http",
          name: "nax",
          url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
          headers: [{ name: "Authorization", value: expect.stringMatching(/^Bearer [A-Za-z0-9_-]{43}$/) }],
        },
      ],
      _meta: { claudeCode: { options: { allowedTools: ["mcp__nax__lookup"] } } },
    });
    const events = await driveTurn(o.session, "look it up");
    expect(ran.map((r) => [r.input, r.ctx.sessionId, r.ctx.toolCallId])).toEqual([[{ q: "acp" }, "s-1", "mcp-1"]]);
    expect(results(o)).toMatchObject([
      { tool: "lookup", result: { content: [{ type: "text", text: 'found: {"q":"acp"}' }] } },
    ]);
    expect(approvals(events)).toEqual([]);
    expect(endOf(events).status).toBe("completed");
  });

  test("read: plan mode, and the tool still runs without any approval event", async () => {
    const ran: Ran[] = [];
    const o = await open("read", [call()], [lookupTool("never", ran)]);
    expect(o.fake.callsTo("session/set_config_option")).toEqual([
      { sessionId: "fake-session-1", configId: "mode", value: "plan" },
    ]);
    const events = await driveTurn(o.session, "x");
    expect(ran).toHaveLength(1);
    expect(approvals(events)).toEqual([]);
  });
});

describe("approval always: the caller decides under every profile (spec §6.6)", () => {
  test("none: approval_requested names mcp-1, the tool and the summary; allow runs it", async () => {
    const ran: Ran[] = [];
    const o = await open("none", [call()], [lookupTool("always", ran)]);
    const events = await driveTurn(o.session, "x", (event) => {
      if (event.type === "approval_requested") o.session.answer(event.requestId, { decision: "allow" });
    });
    expect(find(events, "approval_requested")).toMatchObject({
      callId: "mcp-1",
      tool: "lookup",
      summary: 'look up {"q":"acp"}',
      reason: approvalReason("lookup"),
    });
    expect(find(events, "approval_resolved")).toMatchObject({ decision: "allow", decidedBy: "human" });
    expect(ran).toHaveLength(1);
  });

  test("ask, denied: the agent gets a denied tool error and the tool does not run", async () => {
    const ran: Ran[] = [];
    const o = await open("ask", [call()], [lookupTool("always", ran)]);
    await driveTurn(o.session, "x", (event) => {
      if (event.type === "approval_requested") o.session.answer(event.requestId, { decision: "deny" });
    });
    expect(ran).toEqual([]);
    expect(results(o)).toMatchObject([
      { result: { content: [{ type: "text", text: `Denied: ${ASK_DENIED_REASON}` }], isError: true } },
    ]);
  });
});

describe("a call that outlives its turn (Review Focus 1)", () => {
  test("cancel while the approval is pending: resolved cancelled before turn_end; the tool never runs", async () => {
    const ran: Ran[] = [];
    const o = await open(
      "ask",
      [{ kind: "mcpCall", tool: "lookup", input: {}, detached: true }, { kind: "waitForCancel" }],
      [lookupTool("always", ran)],
    );
    const events = await driveTurn(o.session, "x", (event) => {
      if (event.type === "approval_requested") o.session.cancel();
    });
    expect(find(events, "approval_resolved")).toMatchObject({ decidedBy: "cancelled" });
    expect(indexOfType(events, "approval_resolved")).toBeLessThan(indexOfType(events, "turn_end"));
    expect(endOf(events).status).toBe("cancelled");
    expect(ran).toEqual([]);
    await waitForCondition(() => results(o).length === 1, 3_000);
    expect(results(o)[0]).toMatchObject({ result: { isError: true } });
  });

  test("cancel during a run that ignores its signal: the turn ends; the run's signal aborts; the agent gets abandoned", async () => {
    const seen: EmbedderToolContext[] = [];
    const o = await open(
      "full",
      [{ kind: "mcpCall", tool: "slow", input: {}, detached: true }, { kind: "waitForCancel" }],
      [hangingTool(seen)],
    );
    const turn = driveTurn(o.session, "x");
    await waitForCondition(() => seen.length === 1, 3_000);
    o.session.cancel();
    const events = await turn;
    expect(endOf(events).status).toBe("cancelled");
    expect(seen[0]?.signal.aborted).toBe(true);
    await waitForCondition(() => results(o).length === 1, 3_000);
    expect(results(o)[0]).toMatchObject({
      result: { content: [{ type: "text", text: 'Tool "slow" was abandoned: the turn ended.' }], isError: true },
    });
  });

  test("the agent process dies during a run: the turn errors and the run's signal aborts", async () => {
    const seen: EmbedderToolContext[] = [];
    const o = await open(
      "full",
      [{ kind: "mcpCall", tool: "slow", input: {}, detached: true }, { kind: "hang" }],
      [hangingTool(seen)],
    );
    const turn = driveTurn(o.session, "x");
    await waitForCondition(() => seen.length === 1, 3_000);
    o.fake.crash();
    const events = await turn;
    expect(endOf(events).status).toBe("errored");
    expect(seen[0]?.signal.aborted).toBe(true);
  });
});

describe("outside a turn, and after close (Review Focus 3, 4)", () => {
  test("between turns: no-turn error, nothing runs; after close the port refuses connections", async () => {
    const ran: Ran[] = [];
    const o = await open("full", [{ kind: "text", text: "ok" }], [lookupTool("never", ran)]);
    await driveTurn(o.session, "x");
    const { url, token } = hostOf(o.fake);
    const client = await mcpClient(url, token);
    try {
      expect(await client.callTool({ name: "lookup", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: NO_TURN_TEXT }],
        isError: true,
      });
    } finally {
      await client.close();
    }
    expect(ran).toEqual([]);
    await o.session.close();
    await expect(fetch(url, { method: "POST", body: "{}" })).rejects.toThrow();
  });
});

describe("the token stays secret (Review Focus 3)", () => {
  test("never in the transcript or an event; an agent error echoing the header is redacted", async () => {
    const o = await open(
      "full",
      [{ kind: "fail", failure: { code: -32603, message: "agent saw" }, echoMcpAuth: true }],
      [lookupTool("never", [])],
    );
    const { token } = hostOf(o.fake);
    const events = await driveTurn(o.session, "x");
    const end = endOf(events);
    expect(end.status).toBe("errored");
    expect(end.error?.message).toContain("[REDACTED]");
    expect(JSON.stringify(events)).not.toContain(token);
    expect(JSON.stringify(await o.store.load("s-1"))).not.toContain(token);
  });
});

describe("agents that cannot take tools (D4-j)", () => {
  async function refused(agent: AcpBackendOptions["agent"], script: FakeScript) {
    const fake = inMemoryAgent(script);
    _acpBackendDeps.launch = fake.launch;
    const err = sessionError(
      await rejection(
        createAgentSession({
          backend: acpBackend({ agent, allowUnsandboxed: true, command: "fake-agent" }),
          profile: "full",
          workdir,
          tools: [lookupTool("never", [])],
          transcriptStore: createMemoryTranscriptStore(),
        }),
      ),
    );
    return { fake, err };
  }

  test("claude without HTTP MCP: CAPABILITY_UNSUPPORTED tools after initialize, no session/new", async () => {
    const { fake, err } = await refused("claude", { ...HTTP_CLAUDE, capabilities: {} });
    expect(err.code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
    expect(err.context).toMatchObject({ capability: "tools" });
    expect(fake.callsTo("initialize")).toHaveLength(1);
    expect(fake.callsTo("session/new")).toEqual([]);
  });

  test("codex (no pre-approval): CAPABILITY_UNSUPPORTED tools", async () => {
    const { err } = await refused("codex", { capabilities: { mcpCapabilities: { http: true } } });
    expect(err.context).toMatchObject({ capability: "tools" });
  });

  test("a failed open leaves no listening host behind", async () => {
    const fake = inMemoryAgent({ ...HTTP_CLAUDE, newSessionFailure: { code: -32603, message: "no" } });
    _acpBackendDeps.launch = fake.launch;
    await rejection(
      createAgentSession({
        backend: acpBackend({ agent: "claude", allowUnsandboxed: true, command: "fake-agent" }),
        profile: "full",
        workdir,
        tools: [lookupTool("never", [])],
        transcriptStore: createMemoryTranscriptStore(),
      }),
    );
    const { url } = hostOf(fake);
    await expect(fetch(url, { method: "POST", body: "{}" })).rejects.toThrow();
  });
});
```

In `packages/nax-agent-acp/test/unit/client/backend.test.ts`, remove the S4-2 refusal that no longer holds. Delete, inside `describe("acpBackend: stages not built yet are refused before spawning (D-b)", ...)`, the `const tool: EmbedderTool = { ... };` declaration and the whole `test("embedder tools -> CAPABILITY_UNSUPPORTED tools", ...)` block (lines 274-298 at `e11840968`). Remove `type EmbedderTool,` from the `@nathapp/nax-agent` import at the top of the file. The `resume` refusal test in that describe stays.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test ./test/unit/client/backend-tools.test.ts --timeout=60000`
Expected: FAIL: every open with tools rejects with `AGENT_SESSION_CAPABILITY_UNSUPPORTED` ("embedder tools on ACP arrive in S4-4").

- [ ] **Step 4: `backend.ts`: the whole new file**

Replace `packages/nax-agent-acp/src/client/backend.ts` with:

```ts
/**
 * acpBackend(): nax-agent's SessionBackend over ACP (S4 spec §6). It serves all
 * four profiles: the agent's mode is set at open (§6.4 layer 1), and each
 * session/request_permission is decided by profile (layer 2, permissions.ts),
 * through the caller under `ask`. Embedder tools are served by a per-session MCP
 * tool host (§6.6, tool-host.ts) and pre-approved at the adapter (R12); the
 * host's token joins the session's redaction set before the agent starts (D4-i).
 * A turn's permission decisions and tool calls are cancelled when the turn is
 * cancelled, times out, ends or loses its process (D3-d, D4-f). Until its stage
 * lands it refuses resume (S4-6) before spawning anything. A crashed or killed
 * agent leaves the session disconnected; reconnect is S4-6, so until then later
 * turns end AGENT_SESSION_CLOSED (D-f).
 */
import {
  type AgentSessionAdapter,
  AgentSessionError,
  type BackendOpenContext,
  NO_OP_INTERACTION_HANDLER,
  type OpenedBackend,
  type SendTurnOpts,
  type SessionBackend,
  type SessionHandle,
  type TranscriptStore,
  type TurnResult,
} from "@nathapp/nax-agent";
import { capabilityUnsupported } from "#src/client/errors";
import { createTurnCollector } from "#src/client/events";
import { createInboundRouter, type InboundRouter } from "#src/client/inbound";
import { type LaunchFn, launchAgent } from "#src/client/launch";
import { type OpenedAcp, openAcpSession } from "#src/client/open";
import { type AcpBackendOptions, type ResolvedAcpOptions, resolveAcpOptions } from "#src/client/options";
import { decidePermission } from "#src/client/permissions";
import { race } from "#src/client/race";
import { createToolCalls } from "#src/client/tool-calls";
import { createToolHost, newToolHostToken, type ToolHost } from "#src/client/tool-host";
import { runPromptTurn, type TurnState } from "#src/client/turn";

/** Test seam: the process launcher. Production always uses launchAgent. */
export const _acpBackendDeps: { launch: LaunchFn } = { launch: launchAgent };

interface SessionFlags {
  disconnected: boolean;
  closing: Promise<void> | undefined;
  instructionsSent: boolean;
}

interface Live {
  readonly options: ResolvedAcpOptions;
  readonly ctx: BackendOpenContext;
  readonly acp: OpenedAcp;
  readonly router: InboundRouter;
  readonly flags: SessionFlags;
  readonly state: TurnState;
  /** Aborted when the agent process exits: the running turn's permission decisions settle cancelled (§6.3 step 5). */
  readonly gone: AbortController;
  /** The embedder tools' MCP host; undefined when the session has no tools. */
  readonly host: ToolHost | undefined;
}

export function acpBackend(input: AcpBackendOptions): SessionBackend {
  const options = resolveAcpOptions(input);
  return Object.freeze({ kind: options.kind, open: (ctx: BackendOpenContext) => openBackend(options, ctx) });
}

function refuseUnbuilt(ctx: BackendOpenContext): void {
  if (ctx.resume !== undefined) throw capabilityUnsupported("resume", "resuming an ACP session arrives in S4-6");
}

/** The session's options: the tool host's token joins the redaction set (D4-i). */
function withToken(options: ResolvedAcpOptions, token: string | undefined): ResolvedAcpOptions {
  if (token === undefined) return options;
  return Object.freeze({ ...options, secrets: Object.freeze([...options.secrets, token]) });
}

function toolHostFor(
  ctx: BackendOpenContext,
  router: InboundRouter,
  secrets: readonly string[],
  token: string | undefined,
): ToolHost | undefined {
  if (token === undefined) return undefined;
  const calls = createToolCalls({
    sessionId: ctx.sessionId,
    tools: ctx.tools,
    asks: ctx.asks,
    currentTurnId: ctx.currentTurnId,
    turnSignal: () => router.activeSignal(),
    secrets,
  });
  return createToolHost(calls, token);
}

async function openBackend(base: ResolvedAcpOptions, ctx: BackendOpenContext): Promise<OpenedBackend> {
  refuseUnbuilt(ctx);
  const token = ctx.tools.length > 0 ? newToolHostToken() : undefined;
  const options = withToken(base, token);
  const gone = new AbortController();
  const router = createInboundRouter((request, signal) =>
    decidePermission(request, { profile: ctx.profile, asks: ctx.asks, secrets: options.secrets, signal }),
  );
  const host = toolHostFor(ctx, router, options.secrets, token);
  const acp = await openAcpSession(options, ctx, router.handlers, _acpBackendDeps.launch, host).catch(
    async (err: unknown) => {
      await host?.stop();
      throw err;
    },
  );
  const flags: SessionFlags = { disconnected: false, closing: undefined, instructionsSent: false };
  void acp.launched.exited.then(() => {
    flags.disconnected = true;
    gone.abort();
  });
  const state: TurnState = {
    link: acp.link,
    launched: acp.launched,
    agentSessionId: acp.agentSessionId,
    cancelGraceMs: options.cancelGraceMs,
    secrets: options.secrets,
    disconnect: () => {
      flags.disconnected = true;
    },
  };
  return assemble({ options, ctx, acp, router, flags, state, gone, host });
}

function assemble(live: Live): OpenedBackend {
  const handle: SessionHandle = Object.freeze({ id: live.ctx.sessionId, agentName: live.options.kind });
  const adapter: AgentSessionAdapter = {
    openSession: async () => handle,
    sendTurn: (_handle, prompt, opts) => sendTurn(live, prompt, opts),
    // The agent session closes in OpenedBackend.close(), within the §6.3 step 4 bound (D-j).
    closeSession: async () => {},
  };
  return {
    adapter,
    handle,
    info: Object.freeze({ kind: live.options.kind, capabilities: live.acp.record }),
    turnOpts: () => ({ interactionHandler: NO_OP_INTERACTION_HANDLER }),
    close: () => {
      live.flags.closing ??= shutdown(live);
      return live.flags.closing;
    },
  };
}

async function sendTurn(live: Live, prompt: string, opts: SendTurnOpts): Promise<TurnResult> {
  const { ctx, flags } = live;
  if (flags.disconnected || flags.closing !== undefined) {
    throw new AgentSessionError(
      `ACP session "${ctx.sessionId}" has lost its agent process; reconnect arrives in S4-6`,
      "AGENT_SESSION_CLOSED",
      { sessionId: ctx.sessionId },
    );
  }
  const instructions = flags.instructionsSent ? undefined : ctx.instructions;
  flags.instructionsSent = true;
  const text = instructions === undefined || instructions === "" ? prompt : `${instructions}\n\n${prompt}`;
  const collector = createTurnCollector(opts.onTurnEvent);
  const signal = opts.signal ?? ctx.turnSignal();
  const release = live.router.attach(live.acp.agentSessionId, collector, AbortSignal.any([signal, live.gone.signal]));
  try {
    return await runPromptTurn(live.state, { text, signal, collector });
  } finally {
    await release();
    // The release aborted this turn's tool calls; wait for their answers (D4-f).
    await live.host?.drain();
  }
}

async function shutdown(live: Live): Promise<void> {
  const { acp, options, flags } = live;
  if (!flags.disconnected && acp.record.close) {
    await race(acp.link.closeSession(acp.agentSessionId), { timeoutMs: options.cancelGraceMs });
  }
  await acp.launched.terminate(options.cancelGraceMs);
  acp.link.close();
  // §6.3 close step 4: stop the tool host and revoke its token.
  await live.host?.stop();
  await saveFinal(live.ctx.transcriptStore, live.ctx.sessionId);
}

/** §6.3 step 4.5: the document with its final savedAt. Load-merge keeps the facade's turn marker. */
async function saveFinal(store: TranscriptStore, sessionId: string): Promise<void> {
  const doc = await store.load(sessionId);
  if (doc !== null) await store.save(sessionId, { ...doc, savedAt: new Date().toISOString() });
}
```

What changed against the S4-3 file, for review: the header; the `tool-calls`/`tool-host` imports; `Live.host`; `refuseUnbuilt` keeps only resume; new `withToken` and `toolHostFor`; `openBackend` (token first, `options` derived from `base`, host passed to `openAcpSession`, stopped on a failed open, `host` into `assemble`); the drain after `release()` in `sendTurn`; `host.stop()` in `shutdown`. Everything else is the S4-3 code unchanged.

- [ ] **Step 5: Run the package suite**

Run: `bun test ./test/unit/client/backend-tools.test.ts --timeout=60000`
Expected: PASS.

Run: `bun run test`
Expected: PASS (all unit tests, including `backend.test.ts` without the removed refusal and the S4-3 permission suites).

- [ ] **Step 6: Lint, typecheck, commit**

Run: `bun run lint:fix && bun run typecheck && bun run check:all`
Expected: exit 0.

```bash
git add packages/nax-agent-acp/src/client/backend.ts packages/nax-agent-acp/test/fixtures/fake-agent/ packages/nax-agent-acp/test/unit/client/backend-tools.test.ts packages/nax-agent-acp/test/unit/client/backend.test.ts
git commit -m "feat(nax-agent-acp): acpBackend serves embedder tools through the MCP tool host"
```

---

### Task 5: A tool call over a real Node agent process

**Files:**
- Modify: `packages/nax-agent-acp/test/node/acp-backend.test.ts` (append one test, add imports)

**Interfaces:**
- Consumes: the fake agent's `mcpCall` step (Task 4), `FAKE_MAIN`, `fakeEnv`, `readRecords` (`test/helpers/fake-process.ts`).

- [ ] **Step 1: Write the test**

Add to the imports of `packages/nax-agent-acp/test/node/acp-backend.test.ts`:

```ts
import { CLAUDE_CONFIG_OPTIONS } from "#test/fixtures/fake-agent/script";
```

and add `type EmbedderTool` to the existing `@nathapp/nax-agent` import.

Append:

```ts
test("an embedder tool call from a Node agent process, over loopback HTTP MCP", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "acp-node-tools-"));
  dirs.push(workdir);
  const record = join(workdir, "record.jsonl");
  const ran: unknown[] = [];
  const lookup: EmbedderTool = {
    name: "lookup",
    description: "Look a word up",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
    approval: "never",
    run: async (input) => {
      ran.push(input);
      return { content: "found" };
    },
  };
  const session = await createAgentSession({
    // A registry agent with an explicit command: claude's pre-approval, the fake's process.
    backend: acpBackend({
      agent: "claude",
      allowUnsandboxed: true,
      command: process.execPath,
      args: [FAKE_MAIN],
      env: fakeEnv(
        {
          configOptions: CLAUDE_CONFIG_OPTIONS,
          capabilities: { mcpCapabilities: { http: true } },
          turns: [{ steps: [{ kind: "mcpCall", tool: "lookup", input: { q: "node" } }, { kind: "text", text: "done" }] }],
        },
        record,
      ),
    }),
    profile: "full",
    workdir,
    tools: [lookup],
    transcriptStore: createMemoryTranscriptStore(),
  });
  const events: SessionEvent[] = [];
  for await (const event of session.send("look it up")) events.push(event);
  expect(events.at(-1)).toMatchObject({ type: "turn_end", status: "completed", output: "done" });
  expect(ran).toEqual([{ q: "node" }]);
  expect(readRecords(record).filter((r) => r.method === "mcp-result")).toMatchObject([
    { params: { tool: "lookup", result: { content: [{ type: "text", text: "found" }] } } },
  ]);
  await session.close();
});
```

- [ ] **Step 2: Run it on Node**

Run (from `packages/nax-agent-acp`): `bun run test:node`
Expected: PASS, every test (the new one included) under Node 22+. The tool host runs on Node here and the fake agent's MCP client in a separate Node process.

- [ ] **Step 3: Lint, typecheck, commit**

Run: `bun run lint:fix && bun run typecheck && bun run check:all`
Expected: exit 0.

```bash
git add packages/nax-agent-acp/test/node/acp-backend.test.ts
git commit -m "test(nax-agent-acp): embedder tool call over a Node agent process"
```

---

### Task 6: Docs, context and the spec amendment

**Files:**
- Modify: `packages/nax-agent-acp/src/client/index.ts:1-9`
- Modify: `packages/nax-agent-acp/README.md`
- Modify: `packages/nax-agent-acp/CHANGELOG.md`
- Modify: `.nax/mono/packages/nax-agent-acp/context.md` (repo root)
- Modify: `docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md` (§6.6, §11.2)
- Regenerated: `packages/nax-agent-acp/CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `codex.md`

**Interfaces:** none.

- [ ] **Step 1: `index.ts` header**

Replace the header comment with:

```ts
/**
 * `@nathapp/nax-agent-acp/client`: the ACP backend for nax-agent sessions.
 *
 * S4-4 serves text sessions under all four profiles, with permission requests
 * decided by profile (approved through answer() under `ask`), and embedder tools
 * through a per-session loopback MCP tool host that Claude's adapter pre-approves.
 * Tool and usage events (S4-5) and resume (S4-6) are refused with
 * AGENT_SESSION_CAPABILITY_UNSUPPORTED until their stage lands. Nothing is
 * released before S4-6.
 */
```

- [ ] **Step 2: README**

Replace the status paragraph with:

```md
**Status: pre-release.** The package is built in stages (S4-1 to S4-6) and is not
published yet. Today `acpBackend()` serves text sessions under all four profiles,
and embedder tools on Claude. Tool and usage events (S4-5) and resume (S4-6) are
refused with `AGENT_SESSION_CAPABILITY_UNSUPPORTED` until their stage lands.
`./server` is reserved for a later ACP server.
```

After the "Profiles on ACP" section, add:

```md
## Embedder tools on ACP

Tools you pass as `createAgentSession({ tools })` reach the agent through a small
MCP server this client runs for the session.

- **Claude only.** The agent needs HTTP MCP support and a way to pre-approve the
  tools. Other agents fail with `AGENT_SESSION_CAPABILITY_UNSUPPORTED`
  (`capability: "tools"`) after `initialize`.
- **Loopback only, token-protected.** The server listens on `127.0.0.1` on a random
  port. Every request needs the session's bearer token; requests with another
  `Host`, any `Origin`, or a body over 1 MiB are refused. The token is redacted from
  events, errors and the agent's stderr, and is never stored in the transcript.
  It stops when the session closes.
- **Pre-approved at the agent.** Claude is told to allow exactly `mcp__nax__<tool>`
  for each of your tools, so it never asks permission for them. Your tool's own
  `approval` is the only gate: `"always"` asks you through `approval_requested` and
  `answer()` under every profile; `"never"` runs under every profile.
- **Not yet verified on `none` and `read`.** Those profiles put Claude in plan mode.
  Whether Claude honours the pre-approval while in plan mode is checked in the
  live acceptance smoke before release.
- **Calls run inside a turn.** A call outside a running turn gets an error and the
  tool does not run. When the turn is cancelled, times out, ends or loses the agent
  process, the call's signal aborts and the agent is told the call was abandoned.
  At most 8 calls run at once.
- **Tool input is not validated** against your `inputSchema`, as on the native
  backend. Check it in `run`.
- **A permission request that names one of your tools is not trusted as such.** The
  agent's tool title is display data. If an agent asks permission for an MCP tool
  anyway, it is decided by profile like any other request.
```

- [ ] **Step 3: CHANGELOG**

Under `[Unreleased]`, append:

```md
- Embedder tools on `acpBackend()` (S4-4). A per-session MCP server on `127.0.0.1`
  (ephemeral port, path `/mcp`) serves the session's tools to the agent: bearer
  token compared in constant time, `Host` and `Origin` checks, a 1 MiB body cap,
  at most 8 concurrent calls, no CORS. Claude's adapter pre-approves each tool with
  an exact `mcp__nax__<tool>` rule, so the tool's own `approval` is its only gate.
  Calls run only during a turn, under the turn's signal, and are abandoned when it
  stops. The token is redacted everywhere and never stored; the server stops on
  close. Agents without HTTP MCP or pre-approval refuse tools after `initialize`.
```

- [ ] **Step 4: context.md**

In `.nax/mono/packages/nax-agent-acp/context.md`, replace the Status paragraph with:

```md
Built in stages S4-1 to S4-6. S4-2 added `acpBackend()`: launch, connection,
capabilities, the session lifecycle and text turns. S4-3 added all four profiles:
mode by profile and permission requests decided by profile (`permissions.ts`), with
`ask` going to the caller through the facade's ask port. S4-4 adds embedder tools:
a per-session loopback MCP tool host (`tool-host.ts`, `tool-calls.ts`) and Claude
pre-approval (`pre-approval.ts`). Tested against a fake ACP agent
(`test/fixtures/fake-agent/`, in process and as a subprocess; its `mcpCall` step is
a real MCP client). Full events and usage (S4-5) and resume (S4-6) are refused with
`AGENT_SESSION_CAPABILITY_UNSUPPORTED` until then. `./server` is reserved for S5.
Nothing is released before S4-6.
```

In the module map, add these rows before the `backend.ts` row:

```md
| `tool-host.ts` | loopback MCP server for embedder tools: gate (Host, Origin, token, body cap), one stateless MCP server per request |
| `tool-calls.ts` | tools/list and tools/call: turn check, 8-call cap, `always` approval, run under the turn signal |
| `pre-approval.ts` | server name `nax`, rule `mcp__nax__<tool>`, Claude `_meta` |
```

and change the `backend.ts` row's role to `` `acpBackend()`, adapter, tool host wiring, close; `_acpBackendDeps.launch` test seam ``.

- [ ] **Step 5: Spec amendment (D4-a, D4-b)**

In `docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md` §6.6, replace:

```md
- **Pre-approval (R12):** for Claude, `session/new._meta.claudeCode.options.allowedTools` includes the server's rule (`mcp__nax`; the exact rule string is verified in the S4-4 plan), so the adapter never asks permission for embedder tools. The host is their only approval point:
```

with:

```md
- **Pre-approval (R12):** for Claude, `session/new._meta.claudeCode.options.allowedTools` lists one exact rule per embedder tool, `mcp__nax__<tool>` (verified in the S4-4 plan, D4-a, against claude-agent-acp 0.85.1 and claude-agent-sdk 0.3.286), so the adapter never asks permission for embedder tools. The host is their only approval point:
```

In §11.2, after the line `- an embedder tool (`approval: "never"`) called through MCP without any permission prompt`, add:

```md
   - under `read` (Claude plan mode), the same embedder tool runs through MCP without a permission prompt (S4-4 D4-b: not provable from the source)
```

- [ ] **Step 6: Regenerate and check**

Run (repo root):
```bash
bun packages/nax/bin/nax.ts generate --all-packages
git status --short
```
Expected: only `packages/nax-agent-acp/{CLAUDE,AGENTS,GEMINI,codex}.md` change among generated files. If other packages' generated files change, the generator picked up unrelated drift; revert those and note it in the PR body.

Run (from `packages/nax-agent-acp`): `bun run check:api`
Expected: PASS with no snapshot change. S4-4 adds no export to `./client`.

- [ ] **Step 7: Commit**

```bash
git add packages/nax-agent-acp/src/client/index.ts packages/nax-agent-acp/README.md packages/nax-agent-acp/CHANGELOG.md .nax/mono/packages/nax-agent-acp/context.md packages/nax-agent-acp/CLAUDE.md packages/nax-agent-acp/AGENTS.md packages/nax-agent-acp/GEMINI.md packages/nax-agent-acp/codex.md docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md
git commit -m "docs(nax-agent-acp): S4-4 embedder tools on ACP; spec pre-approval rule and plan-mode acceptance line"
```

---

### Task 7: Whole-repo gates, review, PR

- [ ] **Step 1: Run the repo-wide gates**

Run (repo root):
```bash
bun run typecheck
bun run check:all
bun run build
bun run test
```
Expected: all exit 0.

Run from `packages/nax-agent-acp` as CI does:
```bash
bun run check:api && bun run test:coverage && bun run test:node
```
Expected: all exit 0. Each new src file (`tool-calls.ts`, `tool-host.ts`, `pre-approval.ts`) is at or above 80%, and the per-file coverage baseline stays empty.

- [ ] **Step 2: Confirm the scope fence**

Run:
```bash
git diff --stat origin/main...HEAD -- packages/nax/ | cat
git diff --stat origin/main...HEAD -- packages/nax-agent/ | cat
```
Expected: both empty. No billed smoke is triggered (no nax-agent change).

- [ ] **Step 3: Review before push**

Dispatch one code-review subagent (sonnet) over `git diff origin/main...HEAD`. Give it:
- spec §6.3 (open steps 2-4, close step 4, inbound with no active turn), §6.6 and §7 "Agent text in errors"
- this plan's Decisions and Review Focus

Fix CRITICAL and HIGH findings, with at most two fix rounds.

- [ ] **Step 4: Push and open the PR (maintainer approval first)**

After approval:
```bash
git push -u origin feat/s4-4-acp-tool-host
gh pr create --base main --title "feat(nax-agent-acp): S4-4 MCP tool host and adapter pre-approval" --body-file <body>
```

The body covers:
- the S4-4 scope (spec §10 row)
- decisions D4-a to D4-k, with the D4-a evidence (adapter and SDK file references) and the D4-b open item carried to the S4-6 live smoke
- the README "Embedder tools on ACP" guarantees
- the test plan: CI jobs `nax-agent-acp`, `nax-agent-acp: node 22/24`, `nax-agent`, `nax`, `tooling`
- a statement that nothing is released and that nax and nax-agent are untouched

---

## Self-review notes

- **Spec coverage, §6.6:**
  - start only with tools; requires HTTP MCP and pre-approval: Task 3 (open refusals), Task 4 (claude without HTTP, codex)
  - server: `@modelcontextprotocol/sdk` streamable HTTP, `127.0.0.1`, ephemeral port, `/mcp`: Task 2
  - token: 32 random bytes per host, the `http` entry with the `Authorization` header: Task 2 (entry, token length, per-host), Task 4 (`session/new` params)
  - request checks: token constant time → 401; `Host` → 403; `Origin` → 403; no CORS; body > 1 MiB → 413; > 8 concurrent → tool error: Task 2 (each one), Task 1 (cap semantics)
  - token secrecy (events, errors, stderr tail, never env or document): Task 4 (transcript, events, echoed error); the stderr tail uses the same `options.secrets` (Task 4 `withToken`)
  - pre-approval rule: Task 2 (`preApprovalMeta`), Task 3 (`session/new` `_meta`), Task 4 (end to end); the exact string is decided in D4-a, and the plan-mode question is carried to S4-6 (D4-b, Task 6 spec line)
  - `approval: "always"` → `requestApproval`; `"never"` under every profile: Task 1, Task 4 (`none`, `ask`, `read`, `full`)
  - `tools/list` exactly the tools: Task 1, Task 2
  - `tools/call`: no turn → tool error; `run(input, { sessionId, toolCallId: "mcp-<n>", signal })`; result mapping; throw → `isError` with the message: Task 1, Task 4
  - close: stopped and revoked: Task 2 (`stop()`), Task 4 (port refuses after `close()`; failed open leaves none)
  - reconnect and resume start a new host: S4-6 (resume is still refused here)
  - events: none of its own (S4-5 maps `mcp__nax__*` updates)
- **§6.3:** step 3 (start the host after the capability check) and step 4 (`mcpServers`, `_meta`): Task 3. Close step 4: Task 4 `shutdown`. Inbound MCP `tools/call` with no turn → tool error: Task 1, Task 2, Task 4.
- **§9 MCP host security tests** (missing or wrong token, wrong `Host`, an `Origin` header, an oversized body, the concurrency cap, a call after turn end, a call after close): all in Task 2; the after-close and after-turn cases also end to end in Task 4. "Pre-approval `_meta` capture": Task 3 and Task 4.
- **Type consistency:**
  - `ToolCallDeps.turnSignal: () => AbortSignal | undefined` matches `InboundRouter.activeSignal()` (Tasks 1, 3, 4)
  - `ToolHost.start(): Promise<HttpMcpServer>` is spread into `session/new`'s `mcpServers: McpServer[]` (Tasks 2, 3)
  - `openAcpSession(options, ctx, handlers, launch, host?)` matches its call in `backend.ts` (Tasks 3, 4)
  - `createToolHost(calls, token?)` and `newToolHostToken()` match (Tasks 2, 4)
  - the fake's `McpCallStep` fields match the tests (Tasks 4, 5)
- **Placeholder scan:** none.
