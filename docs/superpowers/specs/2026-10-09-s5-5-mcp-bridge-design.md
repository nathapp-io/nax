# S5-5: MCP bridge for the nax-agent ACP server

**Status:** design approved section by section in brainstorm 2026-10-09. Not yet final-reviewed.

**Addendum to:** `docs/superpowers/specs/2026-10-08-s5-acp-server-design.md` (the S5 spec). It replaces ruling R7 ("ignored with a notice in v1") and the S5-5 row of §9 with the design below. Everything not named here keeps the S5 spec's behaviour.

**Baseline:** main `833280ee3`. All four published packages at `0.84.0` (lockstep). `@nathapp/nax-agent-acp` depends on `@modelcontextprotocol/sdk` `^1.30.0` (used by its ACP client's loopback tool host); `@nathapp/nax-agent` does not. `@agentclientprotocol/sdk` 1.7.

## 1. Goal

Any ACP client that sends `mcpServers` on `session/new`, `session/load` or `session/resume` gets those servers' tools in the nax-agent session, under the session mode's approval rules, surviving mode and model switches.

**Consumers:** every ACP client (Zed, acpx, JetBrains, Neovim plugins, scripts and custom embedders). Nothing in this design depends on one client's behaviour (user ruling R5-5.0).

**Done means:**
- A client that sends a stdio or HTTP MCP server sees its tools called by the agent; in `ask` mode each call raises a permission request, and "Always allow" is honoured for the rest of the session.
- A failed or unsupported server never blocks the session; the client is told which server and why.
- Switching mode or model keeps the connections; closing, deleting or shutting down ends them.
- Verified live in one editor and one headless client (§8.3).

## 2. Rulings (user, brainstorm 2026-10-09)

| # | Question | Ruling |
|---|---|---|
| R5-5.0 | Consumers | Any ACP client; do not assume Zed. |
| R5-5.1 | Approval by mode | `none` and `read`: no MCP tools offered. `ask`: a permission request before every call; "Always allow" / "Always reject" remembered per tool for the session. `full`: runs without asking. A server's `readOnlyHint` is never trusted. |
| R5-5.2 | Transports | stdio and streamable HTTP. `initialize` advertises `mcpCapabilities: { http: true, sse: false }`. `sse` and `acp` entries are skipped with a notice. |
| R5-5.3 | A server that cannot be reached at open | The session opens anyway; one notice names each failed server and the reason (secret-free); its tools are absent; nothing retries in the background. |
| R5-5.4 | Where the code lives | Approach A: a bridge inside the ACP server, over a shareable MCP connection layer in nax-agent (`@nathapp/nax-agent/mcp`). The facade does not change. |
| R5-5.5 | nax run's own MCP client | Out of scope. Moving `packages/nax/src/mcp/client.ts` onto the shared layer is a follow-up issue. |

Approaches rejected (R5-5.4):
- **B: implement the facade's reserved `mcpServers` option in nax-agent.** Grows the facade's public API and options validation for a need only the ACP server has. The shared layer (§3.1) keeps that door open.
- **C: lift nax's `packages/nax/src/mcp/` (client, pool, lock) into a shared package.** That code is shaped by nax config, the stage model and `mcp-lock.json`, none of which apply to client-supplied servers; it drags nax run behaviour into S5.

## 3. Architecture

```
ACP client ──session/new|load|resume { mcpServers }──► nax-agent-acp src/server/
                                                         │
          registry-open ── connectMcpServers(list) ──► src/server/mcp/  (bridge, §3.2)
                │                                        │  per ACP session: McpSessionTools
                │  tools: EmbedderTool[] (by mode)       │
                ▼                                        ▼
       createAgentSession / resume              @nathapp/nax-agent/mcp  (shared layer, §3.1)
       (S3 facade, unchanged)                            │
                                                         ▼
                                           @modelcontextprotocol/sdk (stdio | streamable HTTP)
```

### 3.1 Shared connection layer: `@nathapp/nax-agent/mcp`

A new subpath export in `@nathapp/nax-agent` (`"./mcp": "./src/mcp/index.ts"` in the workspace manifest; the staged manifest maps it to `dist/`). The root entry never imports it, so `@nathapp/nax-agent` alone never loads the MCP SDK. nax-agent gains `@modelcontextprotocol/sdk` (`^1.30.0`, the version both other packages already pin) as a dependency.

Surface (names indicative; the plan fixes them):

```ts
type McpTransportConfig =
  | { kind: "stdio"; command: string; args: readonly string[]; env: Readonly<Record<string, string>>; cwd: string }
  | { kind: "http"; url: string; headers: Readonly<Record<string, string>> };

interface McpToolInfo { name: string; description: string; inputSchema: JSONSchema }
interface McpCallResult { text: string; isError: boolean; bytesBeforeCap: number }

interface McpConnection {
  readonly tools: readonly McpToolInfo[];          // from one tools/list at connect
  call(name: string, input: unknown, opts: { signal: AbortSignal; maxBytes: number }): Promise<McpCallResult>;
  readonly closed: boolean;                         // the transport ended (process exit, HTTP failure)
  onClose(listener: (reason: string) => void): void;
  close(): Promise<void>;                           // idempotent; stdio: SIGTERM, then SIGKILL after a grace
}

function connectMcp(config: McpTransportConfig, opts: { signal: AbortSignal; timeoutMs: number; clientInfo: { name: string; version: string } }): Promise<McpConnection>;
```

It owns, once, the behaviour every MCP consumer needs:
- **stdio env is an overlay** on the SDK's `getDefaultEnvironment()`, never a replacement (the SDK uses the default only when `env` is absent; a replacement drops `PATH`). Same trap nax's client handles today.
- **stdio stderr is piped and drained**, never inherited (the ACP server's stdout carries ACP frames; nax's TUI has the same need).
- **Timeouts and cancellation:** connect (spawn or HTTP handshake + `initialize` + `tools/list`) is bounded by `timeoutMs`; a call honours `signal` (the SDK sends `notifications/cancelled`).
- **Result to text** (§5.4) and the byte cap.
- Tool list pagination (`nextCursor`) is followed to the end at connect.

Not in the shared layer: naming, approval, limits, notices, lifecycle per session — those are ACP-bridge policy (§3.2). nax run's pool, lock file and stage wiring stay in nax.

The layer must cover what `packages/nax/src/mcp/client.ts` does today (stdio connect with env overlay and piped stderr, `tools/list`, `tools/call`, close), so the follow-up migration (R5-5.5) is a swap, not a redesign.

### 3.2 ACP bridge: `packages/nax-agent-acp/src/server/mcp/`

| Unit | Role |
|---|---|
| `parse.ts` | ACP `McpServer[]` -> validated entries: `stdio` (`name`, `command`, `args`, `env: EnvVariable[]`), `http` (`name`, `url`, `headers: HttpHeader[]`); `sse` / `acp` -> skipped. Malformed -> `invalid_params` (§6). |
| `naming.ts` | Model-facing names `<server>__<tool>` that satisfy the facade rule (§5.1); collision handling; reverse map. |
| `connect.ts` | Connects all entries in parallel through the shared layer; applies limits (§5.3); collects one open notice. |
| `session-tools.ts` | `McpSessionTools`: the live connections of ONE ACP session, the name map, the secret values; `embedderTools(mode)` -> `EmbedderTool[]`; `closeAll()`. |
| `notices.ts` | Open, mode and disconnect notice texts, secret-scrubbed. |

## 4. Lifecycle

### 4.1 Open (`session/new`, `session/load`, `session/resume`)

Order in `registry-open`: validate `cwd` -> parse `mcpServers` (malformed fails here, before anything starts) -> credential pre-flight and lock (S5 spec §6.3, unchanged) -> **connect MCP servers** -> open the facade session with `tools: mcpTools.embedderTools(mode)` -> respond.

- Connecting after the credential check and lock means a request that will fail `auth_required` or lose the lock never spawns a server.
- All servers connect in parallel, each bounded by **10 s** (`MCP_CONNECT_TIMEOUT_MS`). The response waits for all of them, so the first prompt already sees the tools.
- stdio servers start with the session's `cwd`.
- If the facade open fails after servers connected, the bridge closes them before the error is returned (no orphan processes).

### 4.2 Mode and model switches

Switches close and reopen the facade session (S5 spec §3.3). The `McpSessionTools` belongs to the **ACP session** (the registry entry), not the facade session, so connections survive. The reopened facade session gets `embedderTools(newMode)`. Permission always-memory already lives per ACP session (S5 spec §4.3) and survives too.

### 4.3 Close, delete, shutdown

`session/close`, `session/delete` and server shutdown call `closeAll()`. Shutdown's existing bounded wait (`SHUTDOWN_WAIT_MS`) covers it; a stdio server that ignores SIGTERM is killed when the grace ends.

### 4.4 Reload and resume

`mcpServers` are **never persisted** (env values and headers can carry secrets). Every `session/load` / `session/resume` connects fresh from the list in that request. A reopened session whose list lacks an earlier server keeps that server's past calls as transcript history; the model simply no longer has the tool.

### 4.5 A server that dies mid-session

No reconnect. When a connection's transport ends, the bridge marks it closed and sends ONE warning notice ("MCP server `x` disconnected: <reason>; reopen the session to reconnect"). Its tools stay in the facade's tool list until the next reopen (the facade's tool set is fixed per open), and every call returns an error result with that same text. A cancelled turn aborts in-flight MCP calls through the tool context's signal.

The tool list is read once per connection: a server's `notifications/tools/list_changed` is ignored in this slice.

## 5. Tools

### 5.1 Names

The model sees `<server>__<tool>`. The facade requires `^[A-Za-z][A-Za-z0-9_-]{0,63}$` and rejects reserved built-in names and duplicates (`agent-session-options.ts` `checkToolNames`).

- Each part: characters outside `[A-Za-z0-9_-]` become `_`; a part not starting with a letter gets an `m` prefix (server part only; the tool part follows `__`).
- Full name over 64 characters: cut to 55 and append `_` + the first 8 hex characters of SHA-256 over `server\0tool`.
- Two tools that still collide (across servers, or after cutting): every colliding name gets the hash suffix; a collision that survives the hash drops the later tool with a notice line.
- Built-in names never collide: they contain no `__`.
- The bridge keeps `modelName -> { server, originalToolName }` for calls.

### 5.2 Descriptions and schemas

- Description: control characters stripped, capped at **2 KiB** (`MCP_DESCRIPTION_BYTES`), prefixed `[<server>] ` so the model and the approval reason show the source.
- Input schema: must be a JSON object with `type: "object"` (MCP requires it). A schema that fails that, or whose JSON is over **32 KiB** (`MCP_SCHEMA_BYTES`), drops the tool with a notice line.

### 5.3 Limits

At most **20 servers** per session (`MCP_MAX_SERVERS`) and **200 MCP tools** in total (`MCP_MAX_TOOLS`). Entries past the limits are dropped in list order (servers after the 20th are not started; tools are taken server by server in list order until 200) and named in the open notice. Tool lists cost context on every turn, so the cap protects the model as well as the host.

### 5.4 Results

The shared layer turns a `tools/call` result into text:
- `text` items joined with a blank line;
- `resource` items with `text` kept (prefixed by their URI); binary resources, `image`, `audio` and `resource_link` items become a one-line placeholder (`[image omitted: image/png]`, `[resource link: <uri>]`);
- `structuredContent` printed as JSON only when there is no text item;
- capped at **64 KiB** (`MCP_RESULT_BYTES`) with a truncation line naming the original size. The cap is the bridge's own: the facade does not cap embedder tool results.

`isError: true` -> `EmbedderToolResult { isError: true }` (reaches the model as an error result). A protocol error, timeout or closed transport -> an error result with a secret-free reason.

### 5.5 Approval by mode (R5-5.1)

| Mode | MCP tools passed to the facade | `approval` |
|---|---|---|
| `none` | none | — |
| `read` | none | — |
| `ask` | all | `"always"` |
| `full` | all | `"never"` |

Servers connect in every mode, so a switch to `ask` or `full` offers their tools without reconnecting. When the session opens (or switches) into `none` or `read` with at least one connected MCP server, one info notice says MCP tools are off in this mode.

`approval: "always"` already flows end to end: the facade emits `approval_requested` with `tool` = the model-facing name, and the server's permission broker sends `session/request_permission` with the four options. **No change to the broker is needed:** `memoryKey()` (`permissions.ts`) returns `event.tool` for every non-`execute` tool, and `toolKind()` returns `other` for any unknown name, so "Always allow" / "Always reject" are already remembered per `<server>__<tool>`. The plan adds a test that pins this.

### 5.6 Display

`toolKind(name)` -> `other` (unchanged default). Titles: the event translator (`translate/events.ts`) and transcript replay (`translate/replay.ts`) take an optional title lookup from the session's `McpSessionTools`; a model-facing name in its map is shown as `<server>: <tool>` (original names). A name not in the map (for example a past call to a server absent on reload) keeps `toolTitle`'s current behaviour. Input summary: the facade's default (redacted, 1 KiB-capped JSON). Facade fact relied on: `resumeAgentSession` takes the same `CreateAgentSessionOptions`, `tools` included.

### 5.7 `describe`

Each MCP `EmbedderTool` leaves `describe` unset, so the approval summary is the facade default; `reason` reads `"<server>__<tool>" asks before every run` (facade text, unchanged).

## 6. Errors and notices

| Situation | Outcome |
|---|---|
| `mcpServers` entry malformed (missing `name`, stdio without `command`, http without valid `http(s)` `url`, env/header items not `{name, value}` strings, duplicate server `name`) | The request fails `invalid_params`, naming the entry index. Nothing is spawned. |
| `sse` or `acp` entry | Skipped; a line in the open notice. |
| Connect fails or times out | Server skipped; a line in the open notice with the reason. |
| Server or tool limit reached; tool dropped (name, schema) | A line in the open notice. |
| Server dies mid-session | One warning notice (§4.5); its calls return error results. |
| Mode `none` / `read` with connected servers | One info notice (§5.5). |

All lines for one open go in **one** warning notice (`announce()`, so a client without notice support gets agent text, S5 spec §4.1).

**Secrets.** The values of every stdio `env` item and HTTP header of the session are collected (values of at least 8 characters, as the ACP client's `secretValues` does) and replaced with `[REDACTED]` in every notice, every error result text and every MCP result text, on top of the pattern-based `redactSecrets`. They are never logged, never written to `*.session.json`, and the stderr logger never prints raw `mcpServers`.

## 7. Capabilities and docs

- `initialize`: `agentCapabilities.mcpCapabilities = { http: true, sse: false }`. `acp` is not advertised.
- The S5-2 notice "MCP servers are not supported yet; ignored" and `MCP_NOTICE` are removed.
- nax-agent-acp README: a "MCP servers" subsection under the ACP server — transports, approval by mode, limits, that servers are not saved with the session, the notices.
- nax-agent README: the `./mcp` subpath (the connection layer only; the facade has no `mcpServers` option).
- `check:package-boundaries` (packages/nax): nax-agent-acp may import `@nathapp/nax-agent` and `@nathapp/nax-agent/mcp`; still never `/internal` or deep paths. nax itself does not import `./mcp` in this slice.
- API snapshots: nax-agent gains the `./mcp` entry; nax-agent-acp `./server` changes only if exported types change.
- Staged manifests: nax-agent's `exports` gains `./mcp`; its `dependencies` gain `@modelcontextprotocol/sdk`. The nax bundle size is measured before and after in S5-5a (expected unchanged: nax already bundles the SDK).

## 8. Testing

No billed calls in CI.

### 8.1 Shared layer (nax-agent)

- In-memory MCP server through the SDK's `InMemoryTransport`: list (with pagination), call, `isError`, every content type to text, byte cap, cancellation via `signal`, connect timeout.
- stdio fixture server run as a subprocess (`test/fixtures/`): env overlay keeps `PATH` and adds the configured vars; stderr is drained and never reaches stdout; `close()` ends the process (SIGKILL after the grace for one that ignores SIGTERM); `onClose` fires on unexpected exit.
- In-process streamable-HTTP fixture server: headers arrive; a down server fails connect within the timeout.
- vitest on Node 22/24 for the subpath (`test:node`).

### 8.2 Bridge (nax-agent-acp), over the in-memory ACP connection

- parse: valid stdio/http; `sse`/`acp` skipped; each malformed case -> `invalid_params`, nothing spawned.
- naming: sanitising, the 64-character cut + hash, cross-server collisions, reverse map.
- tools by mode (none/read/ask/full) and the mode notice; `ask` permission round trip; "Always allow" reused for the same `<server>__<tool>` and not for a sibling tool.
- switch mode/model keeps the same connections (no reconnect, same process); close/delete/shutdown close them; failed facade open closes them.
- failed server -> session opens, one notice; limits; dropped tools.
- server dies mid-session -> one notice, error results.
- secrets: an env value and a header value never appear in notices, errors, results, logs or the session file.
- load/resume reconnect from the request's list; nothing persisted.
- `initialize` advertises `{ http: true, sse: false }`.

### 8.3 Live checks (maintainer, approval-gated, billed)

- **Editor:** one ACP editor with an MCP server configured (for example Zed with a context server): a tool call in `ask` mode with a permission prompt, then "Always allow" honoured.
- **Headless:** a short script on `@agentclientprotocol/sdk` (or acpx, if its config passes `mcpServers`) that sends `session/new` with a stdio fixture server and one prompt that calls its tool.

## 9. Slices

| Slice | Contents | Depends on |
|---|---|---|
| S5-5a | Shared layer `@nathapp/nax-agent/mcp` (§3.1, §5.4), manifests, boundary rule, API snapshot, bundle measurement, §8.1. | main |
| S5-5b | ACP bridge (§3.2, §4-§7), capabilities, notice removal, READMEs, §8.2. | S5-5a |
| — | Live checks (§8.3), then a lockstep `0.85.0` release (approval at launch). | S5-5b |

One plan document covers both slices; S5-5a and S5-5b are separate PRs.

## 10. Out of scope

- nax run's MCP (`packages/nax/src/mcp/`), #2408 (global `mcp-lock.json`) and #2410: follow-up issue (R5-5.5).
- `sse` and ACP-tunnelled (`acp`) MCP transports.
- Reconnecting a dead server mid-session; honouring `tools/list_changed`.
- MCP prompts, resources (as a browsable surface), sampling, roots and elicitation from MCP servers.
- A `mcpServers` option on the facade (`createAgentSession`).
- Server-side config of MCP servers (`~/.nax/config.json`); only client-supplied servers are bridged.
