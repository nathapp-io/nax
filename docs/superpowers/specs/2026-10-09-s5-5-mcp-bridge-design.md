# S5-5: MCP bridge for the nax-agent ACP server

**Status:** design approved section by section in brainstorm 2026-10-09. Final-reviewed 2026-10-09 (1 read-only reviewer: C1-C2, I1-I9 and minors applied; see §11).

**Addendum to:** `docs/superpowers/specs/2026-10-08-s5-acp-server-design.md` (the S5 spec). It replaces ruling R7 ("ignored with a notice in v1") and the S5-5 row of §9 with the design below. Everything not named here keeps the S5 spec's behaviour.

**Baseline:** main `833280ee3`. All four published packages at `0.84.0` (lockstep). `@nathapp/nax-agent-acp` depends on `@modelcontextprotocol/sdk` `^1.30.0` (1.30.0 installed; used by its ACP client's loopback tool host); `@nathapp/nax-agent` does not (no `@modelcontextprotocol` under `packages/nax-agent/node_modules`). `@agentclientprotocol/sdk` 1.7.

## 1. Goal

Any ACP client that sends `mcpServers` on `session/new`, `session/load` or `session/resume` gets those servers' tools in the nax-agent session, under the session mode's approval rules, surviving mode and model switches.

**Consumers:** every ACP client (Zed, acpx, JetBrains, Neovim plugins, scripts and custom embedders). Nothing in this design depends on one client's behaviour (user ruling R5-5.0).

**Done means:**
- A client that sends a stdio or HTTP MCP server sees its tools called by the agent; in `ask` mode each call raises a permission request, and "Always allow" is honoured for the rest of the session.
- A failed, unsupported or misconfigured server never blocks the session; the client is told which server and why. Only a structurally invalid request fails (§6).
- Switching mode or model keeps the connections; closing, deleting or shutting down ends them, with no orphan processes.
- Verified live in one editor and one headless client (§8.3).

## 2. Rulings (user, brainstorm 2026-10-09)

| # | Question | Ruling |
|---|---|---|
| R5-5.0 | Consumers | Any ACP client; do not assume Zed. |
| R5-5.1 | Approval by mode | `none` and `read`: no MCP tools offered. `ask`: a permission request before every call; "Always allow" / "Always reject" remembered per tool for the session. `full`: runs without asking. A server's `readOnlyHint` is never trusted. |
| R5-5.2 | Transports | stdio and streamable HTTP. `initialize` advertises `mcpCapabilities: { http: true, sse: false }`. `sse` and `acp` entries are skipped with a notice. |
| R5-5.3 | A server that cannot be reached at open | The session opens anyway; one notice names each failed server and the reason (secret-free); its tools are absent; nothing retries in the background. |
| R5-5.4 | Where the code lives | Approach A: a bridge inside the ACP server, over a shareable MCP connection layer in nax-agent (`@nathapp/nax-agent/mcp`). The facade does not change. |
| R5-5.5 | nax run's own MCP client | Out of scope. Moving `packages/nax/src/mcp/client.ts` onto the shared layer is a follow-up issue (#2416). |

Approaches rejected (R5-5.4):
- **B: implement the facade's reserved `mcpServers` option in nax-agent.** Grows the facade's public API and options validation for a need only the ACP server has. The shared layer (§3.1) keeps that door open.
- **C: lift nax's `packages/nax/src/mcp/` (client, pool, lock) into a shared package.** That code is shaped by nax config, the stage model and `mcp-lock.json`, none of which apply to client-supplied servers; it drags nax run behaviour into S5.

## 3. Architecture

```
ACP client ──session/new|load|resume { mcpServers }──► nax-agent-acp src/server/
                                                         │
     registry.ts openEntry ── connectSessionMcp() ──► src/server/mcp/  (bridge, §3.2)
                │                                        │  per ACP session: McpSessionTools (on Entry)
                │  OpenSessionRequest.tools (by mode)    │
                ▼                                        ▼
       createAgentSession / resume              @nathapp/nax-agent/mcp  (shared layer, §3.1)
       (S3 facade, unchanged)                            │
                                                         ▼
                                           @modelcontextprotocol/sdk (stdio | streamable HTTP)
```

### 3.1 Shared connection layer: `@nathapp/nax-agent/mcp`

A new subpath export in `@nathapp/nax-agent` (`"./mcp": "./src/mcp/index.ts"` in the workspace manifest; `scripts/lib/stage-manifest.ts` maps it to `dist/mcp/index.{js,d.ts}` in `exports` and `STAGE_INPUTS`). No module reachable from the root entry (`src/index.ts`) imports `src/mcp/`; a test pins that, so `@nathapp/nax-agent` alone never loads the MCP SDK. nax-agent gains `@modelcontextprotocol/sdk` (`^1.30.0`, the range both other packages already use) in `dependencies` (a regular dependency, not an optional peer: nax-agent-acp needs it unconditionally, and nax already bundles it); `bun install` updates the lockfile.

Surface (names indicative; the plan fixes them):

```ts
type McpTransportConfig =
  | { kind: "stdio"; command: string; args: readonly string[]; env: Readonly<Record<string, string>>; cwd: string }
  | { kind: "http"; url: string; headers: Readonly<Record<string, string>> };

interface McpToolInfo { name: string; description: string; inputSchema: JSONSchema }
interface McpCallResult { text: string; isError: boolean; bytesBeforeCap: number }

interface McpConnection {
  readonly kind: "stdio" | "http";
  readonly tools: readonly McpToolInfo[];           // from tools/list at connect, all pages
  call(name: string, input: unknown, opts: { signal: AbortSignal; timeoutMs: number; maxBytes: number }): Promise<McpCallResult>;
  onClose(listener: (reason: string) => void): void; // stdio only: the process exited unexpectedly
  close(): Promise<void>;                            // idempotent; resolves when the transport (and process) is gone
}

function connectMcp(config: McpTransportConfig, opts: {
  signal: AbortSignal; timeoutMs: number; clientInfo: { name: string; version: string };
}): Promise<McpConnection>;   // rejects with McpConnectError { message, stderrTail? }
```

Behaviour the layer owns, once:
- **stdio env is an overlay** on `getDefaultEnvironment()`. SDK 1.30.0 already spawns with `{ ...getDefaultEnvironment(), ...env }` (`client/stdio.js:66-70`); the layer passes the overlay explicitly anyway, so a future SDK change cannot drop `PATH`.
- **stdio stderr is piped**, never inherited (the ACP server's stdout carries ACP frames; nax's TUI has the same need). The layer keeps a bounded tail (the last **512 bytes**) for connect-failure messages and discards the rest.
- **Connect** (spawn or HTTP handshake + `initialize` + every `tools/list` page) is bounded by `timeoutMs` and aborted by `signal`.
- **Calls** honour `signal` (the SDK sends `notifications/cancelled`) and pass `timeoutMs` as the SDK request timeout with `resetTimeoutOnProgress: true` (the SDK default would fail any call at 60 s).
- **Close.** The SDK's stdio close ends stdin, waits 2 s, sends SIGTERM, waits 2 s, then SIGKILL, on `unref()`'d timers (`client/stdio.js:145-170`), so a process exiting in between could orphan the child. The layer's `close()` therefore also watches the pid: if the child has not exited within `closeGraceMs` (default **3000**, below the server's `SHUTDOWN_WAIT_MS` 5000) it sends SIGKILL itself on a ref'd timer and resolves once the child is gone. HTTP close terminates the MCP session (`DELETE`) best effort.
- **Result to text** (§5.4), capped at the caller's `maxBytes`.

Not in the shared layer: naming, approval, limits, notices, secrets, per-session lifecycle — ACP-bridge policy (§3.2). nax run's pool, lock file and stage wiring stay in nax.

The layer covers what `packages/nax/src/mcp/client.ts` does today (stdio connect with env overlay and piped stderr, `tools/list`, `tools/call`, close), so the follow-up migration (#2416) is a swap, not a redesign.

### 3.2 ACP bridge: `packages/nax-agent-acp/src/server/mcp/`

| Unit | Role |
|---|---|
| `parse.ts` | ACP `McpServer[]` -> entries: stdio (an entry with no `type`: `name`, `command`, `args`, `env: EnvVariable[]`), `http` (`name`, `url`, `headers: HttpHeader[]`); `sse` / `acp` -> skipped; semantic problems -> skipped (§6). |
| `secrets.ts` | The session's MCP secret values (§6.1). |
| `naming.ts` | Model-facing names `<server>__<tool>` that satisfy the facade rule (§5.1); collisions; reverse map; title lookup. |
| `connect.ts` | Connects all entries in parallel through the shared layer; applies limits (§5.3); collects the open notice lines. |
| `session-tools.ts` | `McpSessionTools`: the live connections of ONE ACP session, the name map, the secret values; `embedderTools(mode)` -> `EmbedderTool[]`; `titleFor(name)`; `closeAll()`. |
| `notices.ts` | Open, mode and disconnect notice texts: control characters stripped, secrets scrubbed. |

Changes to existing server units (named so the plan does not have to discover them):
- `open-session.ts`: `OpenSessionRequest` gains `tools: readonly EmbedderTool[]`, passed through to `createAgentSession` / `resumeAgentSession` (both take `CreateAgentSessionOptions`, `tools` included).
- `registry.ts`: `Entry` gains `mcp: McpSessionTools` (the `{ ...entry, meta }` spreads keep it); `openEntry` connects and builds the request with `entry.mcp.embedderTools(mode)`; `switchTo`'s `target()` and its restore path build the request with the target mode's tools; `closeEntry` closes MCP (§4.3).
- `server-session.ts` / `translate/events.ts`: `createEventTranslator` takes an optional `titleFor(name)`; `translate/replay.ts` `replayTranscript` takes the same lookup.
- `capabilities.ts`: `mcpCapabilities`. `registry.ts` / `registry-open.ts`: `MCP_NOTICE` and its two call sites removed.
- `options.ts` / `cli.ts`: one new option `mcpConnectTimeoutSeconds` (§4.1), resolved like the others (flag `--mcp-connect-timeout`, env `NAX_AGENT_MCP_CONNECT_TIMEOUT`, `agentServer.mcpConnectTimeoutSeconds`).

## 4. Lifecycle

### 4.1 Open

`session/new` and the reopen path of `session/load` / `session/resume` all go through `registry.ts` `openEntry`. Order: parse `mcpServers` (structural failure fails here; nothing started) -> credential pre-flight (`ensureCredentials`) -> `acquireLock` -> **connect MCP servers** -> `openSession` with `tools` -> respond.

- Connecting after the credential check and lock means a request that fails `auth_required` or loses the lock never spawns a server.
- All servers connect in parallel, each bounded by the connect timeout: default **30 s** (cold `npx -y` servers routinely exceed 10 s), configurable through `mcpConnectTimeoutSeconds` (1-300). The response waits for all of them, so the first prompt already sees the tools.
- Connect also takes the registry's shutdown signal: shutdown during connect aborts it, and anything already connected is closed.
- stdio servers start in the session's stored cwd (`meta.cwd`: for `session/new` the request's `cwd`; for load/resume the cwd recorded at creation, which `reopen` already uses).

### 4.2 Mode and model switches

Switches close and reopen the facade session (S5 spec §3.3). `McpSessionTools` lives on the registry `Entry` (the ACP session), not on the facade session, so connections survive. The reopened facade session gets `embedderTools(targetMode)`; the restore path (switch failed, old session reopened) gets the old mode's tools. Permission always-memory already lives per ACP session (S5 spec §4.3) and survives too.

### 4.3 Close and cleanup

Every path that discards an entry or a half-built one closes its MCP connections:
- `closeEntry` (used by `session/close`, `session/delete`, shutdown, and today's failure paths: `create`'s metadata-write failure, replay failure on load) closes the facade session first (it awaits the running turn), then `mcp.closeAll()`.
- `openEntry`'s failure handling (facade open throws; the `closing` branch after `openSession`) closes the connections before rethrowing, alongside the lock release.
- `closeAll()` closes connections in parallel; each `close()` is bounded by `closeGraceMs` (§3.1). Shutdown's existing `SHUTDOWN_WAIT_MS` race covers it.
- A client that disconnects mid-`session/new` is a server shutdown (stdio closed) and takes the shutdown path.

### 4.4 Reload and resume

`mcpServers` are **never persisted** (env values, headers and URLs can carry secrets). A `session/load` / `session/resume` that reopens a session connects fresh from the list in that request. A reopened session whose list lacks an earlier server keeps that server's past calls as transcript history; the model no longer has the tool.

A `session/load` / `session/resume` for a session **already open** in this server returns the existing state (`registry-open.ts` today) and **ignores the request's `mcpServers`**: the session keeps its current connections. No notice (the client asked to attach, not to reconfigure).

### 4.5 A server that dies mid-session

No reconnect.
- **stdio:** when the process exits unexpectedly (`onClose`), the bridge marks the connection dead and sends ONE warning notice immediately ("MCP server `x` disconnected: <reason>; reopen the session to reconnect", §6.2). Its tools stay in the facade's tool list until the next reopen (the facade's tool set is fixed per open); every call returns an error result with that text.
- **HTTP:** there is no liveness signal. Each failed call returns an error result naming the server and the (scrubbed) reason; no disconnect notice.

A cancelled turn aborts in-flight MCP calls through the embedder tool context's `signal`. The tool list is read once per connection: `notifications/tools/list_changed` is ignored in this slice.

## 5. Tools

### 5.1 Names

The model sees `<server>__<tool>`. The facade requires `^[A-Za-z][A-Za-z0-9_-]{0,63}$` and rejects reserved built-in names and duplicates (`agent-session-options.ts` `TOOL_NAME`, `checkToolNames`).

- Each part: characters outside `[A-Za-z0-9_-]` become `_`; a server part not starting with a letter gets an `m` prefix (the tool part follows `__`).
- Full name over 64 characters: cut to 55 and append `_` + the first 8 hex characters of SHA-256 over `server\0tool`.
- Names that still collide (across servers, or after cutting): every colliding name gets the hash suffix; a collision that survives the hash drops the later tool with a notice line. Hash suffixes make a name depend on the session's full tool set; names are stable within a session because the tool set is fixed per open, and "Always allow" memory is per session.
- Built-in names never collide: they contain no `__`.
- The bridge keeps `modelName -> { server, originalToolName }` for calls and titles.

### 5.2 Descriptions and schemas

- Description: control characters stripped, capped at **2 KiB** (`MCP_DESCRIPTION_BYTES`), prefixed `[<server>] ` so the model sees the source. (The approval prompt shows the source through the title, §5.6, and the model-facing name; the facade's approval reason text is unchanged.)
- Input schema: must be a JSON object with `type: "object"` (MCP requires it); `$schema` is removed; a missing `properties` becomes `{}`, a non-object `properties` drops the tool. A schema whose JSON is over **32 KiB** (`MCP_SCHEMA_BYTES`) drops the tool. Dropped tools get a notice line.
- Not contained: a schema the model provider rejects for other reasons (for example `$ref` or keywords the provider does not support) can still fail turns. The notice and README say to remove such a server.

### 5.3 Limits

At most **20 servers** per session (`MCP_MAX_SERVERS`) and **200 MCP tools** in total (`MCP_MAX_TOOLS`). Entries past the limits are dropped in list order (servers after the 20th are not started; tools are taken server by server in list order until 200) and named in the open notice.

### 5.4 Results

The shared layer turns a `tools/call` result into text:
- `text` items joined with a blank line;
- `resource` items with `text` kept (prefixed by their URI); binary resources, `image`, `audio` and `resource_link` items become a one-line placeholder (`[image omitted: image/png]`, `[resource link: <uri>]`);
- `structuredContent` printed as JSON only when there is no text item;
- capped at the caller's `maxBytes` with a truncation line naming the original size.

**The facade also caps.** Every tool result, embedder tools included, passes the native loop's `after_tool` truncation (`native/session/turn-tool-batch.ts`, `truncation-handler.ts`): 40,000 bytes (`MODEL_MAX_BYTES`) and 1,000 lines, with the full body spilled to the session's scratchpad. The bridge passes `maxBytes` = **1 MiB** (`MCP_RESULT_BYTES`) as a memory bound only; what the model sees is the facade's 40 KB view. So a large MCP result can be written (after secret scrubbing, §6.1) to the scratchpad under the workdir; the README says so.

`isError: true` -> `EmbedderToolResult { isError: true }` (reaches the model as an error result). A protocol error, timeout or dead connection -> an error result with a scrubbed reason. Call timeout: the turn's own deadline governs; the layer's `timeoutMs` is **10 minutes** (`MCP_CALL_TIMEOUT_MS`) with reset on progress, so a slow tool is not cut at the SDK's 60 s default.

### 5.5 Approval by mode (R5-5.1)

| Mode | MCP tools passed to the facade | `approval` |
|---|---|---|
| `none` | none | — |
| `read` | none | — |
| `ask` | all live and dead-marked | `"always"` |
| `full` | all live and dead-marked | `"never"` |

Servers connect in every mode, so a switch to `ask` or `full` offers their tools without reconnecting. Opening or switching into `none` or `read` with at least one connected MCP server sends one info notice that MCP tools are off in this mode (§6.2).

`approval: "always"` already flows end to end: the facade emits `approval_requested` with `tool` = the model-facing name, and the permission broker sends `session/request_permission` with the four options. **No change to the broker:** `memoryKey()` (`permissions.ts:112-113`) returns `event.tool` for every non-`execute` tool, and `toolKind()` returns `other` for unknown names (`translate/tool-kind.ts:31-33`), so "Always allow" / "Always reject" are remembered per `<server>__<tool>`. The plan adds a test that pins this.

### 5.6 Display

`toolKind(name)` -> `other` (unchanged default). Titles: the event translator and transcript replay take `titleFor(name)` from the session's `McpSessionTools`; a model-facing name in its map shows as `<server>: <tool>` (original names, control characters stripped). The `tool_call` event already carries the model-facing name (`turn-event-emitter.ts`), so the lookup works live. A name not in the map (a past call to a server absent on reload) keeps `toolTitle`'s current behaviour. Input summary: the facade's default (redacted, 1 KiB-capped JSON); `describe` is left unset.

## 6. Errors, notices and secrets

| Situation | Outcome |
|---|---|
| `mcpServers` structurally invalid (not an array; an entry not an object; `name` missing or not a string; stdio `command` / `args` / `env` items, or http `url` / `headers` items, of the wrong JSON type) | The request fails `invalid_params`, naming the entry index. Nothing is started. (The ACP SDK's schema validation may reject these first; either way the request fails.) |
| Semantic problems: empty `command`, `url` not `http(s)` or unparseable, duplicate server `name` (later one) | Server skipped; a line in the open notice. |
| `sse` or `acp` entry | Skipped; a line in the open notice. |
| Connect fails or times out | Server skipped; a line in the open notice with the reason and, for stdio, the scrubbed stderr tail. |
| Server or tool limit reached; tool dropped (name, schema) | A line in the open notice. |
| stdio server dies mid-session | One warning notice (§4.5); its calls return error results. |
| HTTP call fails | Error result only. |
| Mode `none` / `read` with connected servers | One info notice. |

### 6.1 Secrets

The session's MCP secret values are:
- stdio `env` values whose **name** matches the existing secret-key pattern (`client/env.ts` `SECRET_KEY`, used by `secretValues`);
- every HTTP header value, plus the token after an auth scheme (`Bearer abc` -> also `abc`);
- for every http `url`: the userinfo password and every query-parameter value.

They are replaced with the existing value scrubber (`client/text.ts` `scrubSecrets`, which ignores values shorter than `MIN_SECRET_LENGTH` = 8) in every notice, every error result, every MCP result text and every connect-failure message (including the stderr tail), on top of the pattern-based `redactSecrets`. Values shorter than 8 characters are not scrubbed by value (pattern redaction still applies); the README says so. `mcpServers` are never logged raw, never written to `*.session.json`, and server names and notice text are control-stripped.

### 6.2 Notice delivery

All notices go through `announce()` (agent text for a client without notice support, S5 spec §4.1):
- **Open notice** (one per open, all lines together): queued with `ServerSession.queueNotice`, delivered with the first updates of the next turn — the path the removed MCP notice uses today.
- **Mode notice:** sent immediately through the session port, the way `announceConfig` sends `config_option_update` after a switch.
- **Disconnect notice:** sent immediately through the session port (ACP `session/update` notifications are valid between turns).

## 7. Capabilities, packaging and docs

- `initialize`: `agentCapabilities.mcpCapabilities = { http: true, sse: false }`. `acp` is not advertised.
- The S5-2 notice "MCP servers are not supported yet; ignored" and `MCP_NOTICE` are removed.
- nax-agent-acp README: a "MCP servers" subsection under the ACP server — transports, approval by mode, limits, the connect timeout option, that servers are not saved with the session, the scratchpad spill (§5.4), the secret-scrubbing rule (§6.1), unsupported schemas (§5.2), the notices.
- nax-agent README: the `./mcp` subpath (the connection layer only; the facade has no `mcpServers` option).
- `check:package-boundaries` (`packages/nax/scripts/check-package-boundaries.ts`): nax-agent-acp may import `@nathapp/nax-agent` and `@nathapp/nax-agent/mcp` (today only the root, line ~187); still never `/internal` or deep paths. `ACP_SRC_DEPS` is unchanged (the bridge reaches the MCP SDK only through `./mcp`). nax does not import `./mcp` in this slice.
- nax-agent packaging: `stage-manifest.ts` `exports` + `STAGE_INPUTS`, `test/node/pack-smoke.test.ts` and the packaging unit tests import `./mcp` from the packed tarball.
- API snapshots: `api/nax-agent.api.txt` gains a `[./mcp]` section (`api:update`); nax-agent-acp's changes only if exported types change.
- The nax bundle size is measured before and after in S5-5a (expected unchanged: nax already bundles the SDK).

## 8. Testing

No billed calls in CI.

### 8.1 Shared layer (nax-agent)

- In-memory MCP server through the SDK's `InMemoryTransport`: list (with pagination), call, `isError`, every content type to text, byte cap, cancellation via `signal`, call timeout with progress reset, connect timeout.
- stdio fixture server run as a subprocess (`test/fixtures/`): env overlay keeps `PATH` and adds the configured vars; stderr never reaches stdout and its tail is kept on connect failure; `close()` resolves only after the child exits, SIGKILLs a child that ignores SIGTERM within `closeGraceMs`; `onClose` fires on unexpected exit.
- In-process streamable-HTTP fixture server: headers arrive; a down server fails connect within the timeout.
- The root entry never reaches `src/mcp/` (import-graph test).
- vitest on Node 22/24 for the subpath (`test:node`), including the packed-tarball smoke.

### 8.2 Bridge (nax-agent-acp), over the in-memory ACP connection

- parse: valid stdio (no `type`) / http; `sse` / `acp` skipped; structural cases -> `invalid_params`, nothing started; semantic cases -> skipped with notice lines.
- naming: sanitising, the 64-character cut + hash, cross-server collisions, reverse map, titles live and on replay.
- tools by mode (none/read/ask/full) and the mode notice; `ask` permission round trip; "Always allow" reused for the same `<server>__<tool>` and not for a sibling tool.
- switch mode/model keeps the same connections (same process); restore path after a failed switch; close/delete/shutdown close them; failed facade open, the `closing` branch, `create` metadata failure and replay failure close them; shutdown during connect.
- failed server -> session opens, one notice with the stderr tail; limits; dropped tools.
- stdio server dies -> one immediate notice, error results; HTTP call failure -> error result only.
- secrets: a secret-named env value, a header value, a bearer token, a URL password and a query value never appear in notices, errors, results, logs or the session file.
- load/resume of a closed session reconnects from the request's list; of an open session ignores it; nothing persisted.
- `initialize` advertises `{ http: true, sse: false }`; the connect-timeout option resolves from flag, env and config.

### 8.3 Live checks (maintainer, approval-gated, billed)

- **Editor:** one ACP editor with an MCP server configured (for example Zed with a context server): a tool call in `ask` mode with a permission prompt, then "Always allow" honoured.
- **Headless:** a short script on `@agentclientprotocol/sdk` (or acpx, if its config passes `mcpServers`) that sends `session/new` with a stdio fixture server and one prompt that calls its tool.

## 9. Slices

| Slice | Contents | Depends on |
|---|---|---|
| S5-5a | Shared layer `@nathapp/nax-agent/mcp` (§3.1, §5.4), manifests, lockfile, boundary rule, API snapshot, bundle measurement, §8.1. | main |
| S5-5b | ACP bridge (§3.2, §4-§7), capabilities, connect-timeout option, notice removal, READMEs, §8.2. | S5-5a |
| — | Live checks (§8.3), then a lockstep `0.85.0` release (approval at launch). | S5-5b |

One plan document covers both slices; S5-5a and S5-5b are separate PRs.

## 10. Out of scope

- nax run's MCP (`packages/nax/src/mcp/`), #2408 (global `mcp-lock.json`) and #2410: follow-up issue #2416 (R5-5.5).
- `sse` and ACP-tunnelled (`acp`) MCP transports.
- Reconnecting a dead server mid-session; HTTP liveness detection; honouring `tools/list_changed`.
- MCP prompts, resources (as a browsable surface), sampling, roots and elicitation from MCP servers.
- A `mcpServers` option on the facade (`createAgentSession`).
- Server-side config of MCP servers (`~/.nax/config.json`); only client-supplied servers are bridged.

## 11. Final review (2026-10-09)

One read-only reviewer. Applied:
- **C1** — the facade's `after_tool` truncation caps every tool result at 40 KB / 1,000 lines and spills to the scratchpad; the bridge's cap is now a 1 MiB memory bound (§5.4).
- **C2** — the secret rule is explicit: key-name-filtered env values, header values and bearer tokens, URL password and query values, scrubbed with `scrubSecrets` (min 8) (§6.1).
- **I1** — SDK 1.30.0 already overlays env and escalates close on unref'd timers; the layer adds a ref'd pid-watch SIGKILL within `closeGraceMs` (§3.1).
- **I2** — `OpenSessionRequest.tools`, `Entry.mcp`, `target()`/restore, translator/replay lookups named (§3.2, §4.2).
- **I3** — every cleanup path closes MCP; facade first, then MCP; shutdown aborts connect (§4.1, §4.3).
- **I4** — delivery path per notice (§6.2).
- **I5** — load/resume of an open session ignores `mcpServers`; stdio cwd = stored `meta.cwd` (§4.1, §4.4).
- **I6** — 10-minute call timeout with progress reset; HTTP has no liveness signal, so no disconnect notice for HTTP (§4.5, §5.4).
- **I7** — connect timeout 30 s, configurable; stderr tail kept for failure notices (§3.1, §4.1). **Changes the brainstorm's 10 s.**
- **I8** — only structural problems fail the request; semantic ones skip the server with a notice (§6). **Changes the brainstorm's "malformed entry -> invalid_params".**
- **I9** — schema normalisation; provider rejection documented as not contained (§5.2).
- Minors: `openEntry` in `registry.ts` is the open path; approval reason unchanged; packaging, boundary-rule, API-snapshot and lockfile steps; root-entry isolation test; stdio entries have no `type`; control-stripped names; hash-suffix stability.
