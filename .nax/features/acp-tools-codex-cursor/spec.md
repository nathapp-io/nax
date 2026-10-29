# SPEC: acp-tools-codex-cursor — Codex and Cursor receive nax's embedder tools

## Summary

Today only Claude Code can receive nax's embedder tools over ACP: every other agent is refused
(`unmetRequirement` in `packages/nax-agent-acp/src/client/capabilities.ts`, the throw in
`sessionSetup` in `src/client/open.ts`), and `nax run` silently drops provider tools for them
(`finalizeAcpSurface` in `packages/nax/src/agents/acp/provider-embedder.ts`, skip reason
`mcp-pre-approval-unsupported`). This feature lets Codex and Cursor receive the tools, approves
Cursor's permission requests for nax's own tools automatically when they are provably for the
session's own tool host, and gives every session's tool host a random server name so a
look-alike MCP server in an agent's or a repo's config cannot pass itself off as nax.

It is feature F1 of the design `docs/superpowers/specs/2026-10-29-nax-chat-acp-agents-design.md`
(nax chat on ACP agents). F2 (chat ACP brain) and F3 (history carry and resume) follow.

## Motivation

- The user wants `nax chat` to run on Claude Code, Codex and Cursor with nax's plan / run / bot
  tools available to all three (design §2 G2, G5). Codex and Cursor cannot receive any embedder
  tool today.
- `nax run` on Codex or Cursor loses its provider tools (for example the codebase-memory MCP
  tools) for the same reason. The user accepted (2026-10-29) that this fix also delivers them
  to Codex and Cursor runs.
- Codex and Cursor have no pre-approval channel like Claude's `allowedTools`. A live probe on
  2026-10-29 (design §5.5) showed:
  - **Codex** (`@agentclientprotocol/codex-acp` ~2.1.1, codex 0.159.3, default mode) calls a
    `readOnlyHint` MCP tool with NO permission request, then reports a `tool_call` whose
    `rawInput` is `{ server, tool, arguments }`.
  - **Cursor** (`cursor-agent acp`) first sends a `tool_call_update` whose `rawInput` is
    `{ providerIdentifier, toolName, args }`, then `session/request_permission` for the SAME
    `toolCallId` (title `"<server>-<tool>: <tool>"`, options allow-once / allow-always /
    reject-once), and calls the MCP server only after the answer.
- The request title is agent-controlled display data (S4-4 D4-c) and must never be trusted. The
  structured `rawInput` fields are set by the adapter's MCP routing. With a fixed server name
  (`"nax"`), a repo's own MCP config could declare a server named `nax` and have its tool calls
  auto-approved; a per-session random name closes that. A second probe (2026-10-29) with the
  server named `nax-0badc0de` showed both agents report the hyphenated name verbatim
  (Codex `rawInput.server`, Cursor `rawInput.providerIdentifier`).
- Limit, accepted: nax's own Cursor permission file for profiles `none` / `read` / `review`
  (`cursorCliConfig` in `src/client/rule-policy.ts`) denies `Mcp(*:*)`, so Cursor receives the
  tools there but cannot call them. Tools are usable on Cursor under `ask` and `full` (what
  `nax chat` uses) and in `nax run` stages that open Cursor under `full`.

## Design

### Approach

1. **Per-session server name.** The tool host's ACP MCP server name becomes
   `nax-<8 lowercase hex>`, generated once per backend session by `newToolHostServerName()`
   and kept across a reconnect after the agent process dies. Claude's pre-approval rules use
   it (`mcp__<serverName>__<tool>`). `parseToolHostToolName` recognises the agent-visible
   name `mcp__nax-<8 hex>__<tool>` so nax's tool audit keeps attributing loopback calls.
   `TOOL_HOST_SERVER_NAME` stays exported with value `"nax"` and now documents the name's
   prefix; the MCP `initialize` `serverInfo` name stays `"nax"`.
2. **Codex and Cursor accept tools.** The registry gains `mcpCallIdentity`: the structured
   shape an agent reports MCP calls in (`"codex"`, `"cursor"`, else undefined). The
   capability record gains `ownToolCalls`. The tools requirement becomes HTTP MCP **and**
   (pre-approval **or** `ownToolCalls`). For an agent without pre-approval, `sessionSetup`
   sends the tool host entry with no `_meta` instead of throwing.
3. **Own-tool auto-allow.** A turn-scoped ledger records, per `toolCallId`, the identity read
   from the agent's structured `rawInput` (shape chosen by `mcpCallIdentity`). A permission
   request whose `toolCallId` the ledger marks as the session's own (server name equals the
   session's, tool name is one of the session's embedder tools, no conflicting identity seen)
   is answered with the agent's allow-once option before the profile decision, in every
   profile, and recorded as an auto decision with `OWN_TOOL_REASON`. Anything else goes
   through the profile decision unchanged (the user ruled 2026-10-29: a card per call is
   acceptable when nothing matches).
4. **nax run delivers.** `finalizeAcpSurface` delivers provider tools to any agent whose
   registry entry has a pre-approval channel or an `mcpCallIdentity`; others keep today's skip.

### Integration (extends existing code)

The **Baseline** lines exist only to locate the code; they are never the interface to
implement. Implement the **Target**.

Read only (verified at main `cf987b22f`):

- `packages/nax-agent-acp/src/client/backend.ts` — `connect(base, ctx, restore, retiredTokens)`
  makes the token, `routerFor(ctx, options)` and `toolHostFor(ctx, router, secrets, token)`;
  reconnect calls `connect` again. `_acpBackendDeps: { launch, createToolHost }` is the seam.
- `packages/nax-agent-acp/src/client/inbound.ts` — `onUpdate` forwards the active binding's
  updates to `collector.onUpdate`; `onPermission` calls `decide(request, admitted.signal)`.
- `packages/nax-agent-acp/test/fixtures/fake-agent/script.ts` — `update` step (any
  `SessionUpdate`), `permission` step, `mcpCall` step; the fake records `session/new` params.
- `packages/nax/src/agents/acp/open-context.ts` — `openContext(input)` calls
  `finalizeAcpSurface(input.agent, opts, profile)` and puts `delivery.tools` on the context.

Changed:

- `src/client/tool-host.ts`
  - Baseline: `createToolHost(calls: ToolCalls, token = newToolHostToken(), opts: ToolHostOptions = {})`;
    `ToolHost { token; start(); drain(); stop() }`; `start()` returns `name: TOOL_HOST_SERVER_NAME`.
  - Target: `ToolHostOptions` gains `readonly serverName?: string`; `ToolHost` gains
    `readonly serverName: string` (the option, else `newToolHostServerName()`); `start()`
    returns `name: host.serverName`. New export
    `newToolHostServerName(): string` (`"nax-"` + 8 lowercase hex from 4 random bytes).
- `src/client/pre-approval.ts`
  - Baseline: `mcpToolRule(toolName: string): string`;
    `claudeSessionMeta(kind, toolNames, readOnly, extras = {})`.
  - Target: `mcpToolRule(serverName: string, toolName: string): string` returns
    `mcp__<serverName>__<toolName>`;
    `claudeSessionMeta(kind, serverName: string, toolNames, readOnly, extras = {})`.
    New export `parseToolHostToolName(name: string): string | undefined`: for
    `mcp__nax-<8 lowercase hex>__<rest>` with non-empty `<rest>`, returns `<rest>`; else
    undefined. Re-exported from `src/client/index.ts`.
- `src/client/backend.ts`
  - Baseline: `connect(base, ctx, restore, retiredTokens)`; `routerFor(ctx, options)`;
    `toolHostFor(ctx, router, secrets, token)` passes `toolHostOptions(ctx)` (`{ instructions }`
    or `undefined`) to `_acpBackendDeps.createToolHost`.
  - Target: `_acpBackendDeps` gains `newToolHostServerName: () => string` (production:
    `newToolHostServerName`). The backend session calls it once, at open, only when
    `ctx.tools.length > 0`, and keeps the name on the session.
    `connect(base, ctx, restore, retiredTokens, serverName?: string)`: the first open passes the
    session's name; `reconnect` passes the same stored name.
    `toolHostFor(ctx, router, secrets, token, serverName?: string)`: when `serverName` is
    undefined it passes exactly `toolHostOptions(ctx)` as today; otherwise it passes
    `{ ...(toolHostOptions(ctx) ?? {}), serverName }`.
    `routerFor(ctx, options, serverName?: string)`: passes the own-tool ledger factory
    (US-004) only when the entry has an `mcpCallIdentity`, `serverName` is defined and
    `ctx.tools.length > 0`, and its decider becomes
    `(request, signal, isOwnToolCall) => decidePermission(request, { ...base, signal, ...(isOwnToolCall === undefined ? {} : { isOwnToolCall }) })`.
- `src/client/registry.ts`
  - Baseline: `AgentRegistryEntry { name; launch; readOnly; defaultMode; preApproval; authEnv }`.
  - Target: gains `readonly mcpCallIdentity: "codex" | "cursor" | undefined` — the structured
    `rawInput` shape the agent reports MCP tool calls in; undefined means none is known.
    `codex` → `"codex"`, `cursor` → `"cursor"`, every other agent undefined. The `entry()`
    helper's `policy` parameter type becomes
    `Pick<AgentRegistryEntry, "readOnly" | "defaultMode" | "preApproval" | "mcpCallIdentity">`
    and the frozen entry it returns carries `mcpCallIdentity: policy?.mcpCallIdentity`.
- `src/client/capabilities.ts`
  - Baseline: `CapabilityRecord { …; mcpHttp; readOnlyMode; preApproval }`;
    `unmetRequirement` refuses `toolCount > 0` unless `mcpHttp && preApproval`.
  - Target: `CapabilityRecord` gains `readonly ownToolCalls: boolean`
    (`entry?.mcpCallIdentity !== undefined`); tools are refused unless
    `mcpHttp && (preApproval || ownToolCalls)`, reason
    `"embedder tools need HTTP MCP support and adapter pre-approval or a known MCP call identity"`.
- `src/client/open.ts` `sessionSetup`
  - Baseline: throws `capabilityUnsupported("tools", "the agent has no way to pre-approve embedder tools")`
    when a host exists and `claudeSessionMeta` returns undefined.
  - Target: passes `o.host?.serverName ?? ""` to `claudeSessionMeta` (with no host the session has no tools, so no rule uses the name); when the meta is undefined and
    the entry has an `mcpCallIdentity`, returns `{ mcpServers: [server] }` with no `_meta`;
    keeps the throw otherwise.
- `src/client/inbound.ts`
  - Baseline: `createInboundRouter(decide: PermissionDecider, elicit?)`;
    `PermissionDecider = (request, signal) => Promise<RequestPermissionResponse>`.
  - Target: `createInboundRouter(decide, elicit?, ownTools?: () => OwnToolLedger)`. Each
    `attach` creates a fresh ledger from `ownTools` (none when absent); `onUpdate` for the
    active binding calls `ledger.observe(update)` before `collector.onUpdate`; `onPermission`
    calls `decide(request, signal, (toolCallId) => ledger?.isOwn(toolCallId) ?? false)`.
    `PermissionDecider` gains the optional third parameter
    `isOwnToolCall?: (toolCallId: string) => boolean`.
- `src/client/permissions.ts`
  - Baseline: `PermissionContext { profile; asks; secrets; signal; … }`; `decidePermission`
    checks the abort, then the sandbox network request, then the profile.
  - Target: `PermissionContext` gains `readonly isOwnToolCall?: (toolCallId: string) => boolean`.
    New export `OWN_TOOL_REASON = "nax's own tool host call"`. After the abort check and before
    the network check: when `ctx.isOwnToolCall?.(request.toolCall.toolCallId)` is true and the
    agent offered an allow-once option, record an auto decision (`OWN_TOOL_REASON`, `"allow"`)
    and select that option. Otherwise continue exactly as today.
- `packages/nax/src/agents/acp/provider-embedder.ts`
  - Baseline: `registryCapable(agent)` is `registryEntry(agent)?.preApproval !== undefined`.
  - Target: true when the entry has a `preApproval` **or** an `mcpCallIdentity`. The skip
    reason for other agents stays `"mcp-pre-approval-unsupported"`.
- `packages/nax/src/agents/acp/tool-audit.ts`
  - Baseline: `loopbackIdentityOf` matches the prefix `` `mcp__${TOOL_HOST_SERVER_NAME}__` ``.
  - Target: uses `parseToolHostToolName(name)` for the namespaced identity; the provider is
    the part before the first `__` as today.

### New module: `packages/nax-agent-acp/src/client/own-tool-calls.ts`

```ts
import type { SessionUpdate } from "@agentclientprotocol/sdk";

export type McpCallIdentityKind = "codex" | "cursor";

export interface McpCallIdentity {
  readonly toolCallId: string;
  readonly server: string;
  readonly tool: string;
}

/**
 * The identity a tool_call / tool_call_update reports in its structured rawInput:
 * codex `{ server, tool }`, cursor `{ providerIdentifier, toolName }` (both string).
 * Never reads the title. Undefined for any other update or shape.
 */
export function mcpCallIdentityOf(kind: McpCallIdentityKind, update: SessionUpdate): McpCallIdentity | undefined;

export interface OwnToolLedger {
  observe(update: SessionUpdate): void;
  /** True only when every identity seen for this id names serverName and a tool in toolNames. */
  isOwn(toolCallId: string): boolean;
}

export function createOwnToolLedger(input: {
  readonly kind: McpCallIdentityKind;
  readonly serverName: string;
  readonly toolNames: readonly string[];
}): OwnToolLedger;
```

`backend.ts` passes `() => createOwnToolLedger({ kind: entry.mcpCallIdentity, serverName, toolNames: ctx.tools.map((t) => t.name) })`
to `createInboundRouter` only when the entry has an `mcpCallIdentity` and the session has tools.

### Failure Handling

| Situation | Behaviour |
|:---|:---|
| A permission request whose `toolCallId` was never reported with structured fields | Profile decision, as today (a card under `ask`, a reject under `none`/`read`). |
| The structured server name is not the session's (e.g. `"nax"` from a repo config) | Profile decision. |
| The structured tool name is not one of the session's embedder tools | Profile decision. |
| One `toolCallId` reported with two different identities | Never own; profile decision. |
| The identity was reported in an earlier turn | Not own (the ledger is turn-scoped); profile decision. |
| Own tool call but the agent offered no allow-once option | Profile decision; allow-always is never selected. |
| The turn is aborted when the request arrives | `cancelled`, as today. |
| Codex or Cursor without HTTP MCP support, handed tools | `AGENT_SESSION_CAPABILITY_UNSUPPORTED` (`capability: "tools"`), as today. |
| Gemini, OpenCode or pi handed tools | Refused as today; `nax run` keeps dropping their provider tools with `mcp-pre-approval-unsupported`. |

## Out of Scope

- Gemini, OpenCode and pi receiving embedder tools; they were not probed and keep today's refusal and today's `nax run` skip.
- Any `nax chat` change: the chat ACP brain, adapting chat's workflow tool providers to embedder tools, and history carry-over are features F2 and F3 of the design.
- Workflow tools on the `nax-agent` ACP server that koda connects to; a separate later feature.
- Keeping a session's tool host server name across a resume in a new process; a resumed session gets a new name.
- A size cap on the per-turn own-tool ledger; it lives for one turn only.
- Attributing Codex or Cursor loopback calls in nax's tool audit; their tool events carry names other than `mcp__<server>__<tool>`, and those rows keep the raw name.
- Changing the MCP `initialize` `serverInfo` name, which stays `"nax"`.
- Changing the value of `TOOL_HOST_SERVER_NAME` or removing the export.
- Selecting an allow-always option for any permission request.
- A Codex permission request for an MCP call that arrives before any structured report of that call; it is decided by the profile as today.
- Running the real codex-acp or cursor-agent in CI; live verification stays a maintainer-run probe.
- Updating `.nax/mono/packages/nax-agent-acp/context.md` (the module map), which is read-only to the run; a manual follow-up after merge.
- Updating `docs/guides/mcp-and-interception.md` (it says only `claude` receives provider tools); a manual follow-up after merge, outside both story workdirs.
- Letting Cursor call MCP tools under profiles `none`, `read` and `review`: `cursorCliConfig` keeps denying `Mcp(*:*)` there, so Cursor's tools are usable only under `ask` and `full`.
- Probing Codex in its `read-only` mode (profiles `none`, `read`, `review`); whatever it does there is decided by the profile as today.

## Stories

Five stories, one capability. Four are in `packages/nax-agent-acp`, one in `packages/nax`.

### US-001 — a per-session tool host server name

Workdir: packages/nax-agent-acp. No dependencies.

`newToolHostServerName`, `ToolHost.serverName`, the `serverName` option, the
`_acpBackendDeps.newToolHostServerName` seam (one name per backend session, kept on the session
and passed to `connect` on reconnect, `toolHostFor` adding it to the host options only when
defined), Claude's rules on that name (`mcpToolRule`, `claudeSessionMeta`), and
`parseToolHostToolName` exported from `./client`.

### US-002 — Codex and Cursor accept embedder tools

Workdir: packages/nax-agent-acp. Depends on US-001.

`AgentRegistryEntry.mcpCallIdentity` (through the `entry()` helper), `CapabilityRecord.ownToolCalls`,
the relaxed tools requirement, and `sessionSetup` sending the tool host entry without `_meta` for
an agent with an `mcpCallIdentity`.

### US-003 — reading an MCP call's identity and the own-tool ledger

Workdir: packages/nax-agent-acp. No dependencies.

New `src/client/own-tool-calls.ts`: `mcpCallIdentityOf` reads the structured `rawInput` of a
`tool_call` or `tool_call_update` (either update type, for either kind) and `createOwnToolLedger`
records identities per `toolCallId`.

### US-004 — nax's own tool calls are approved automatically

Workdir: packages/nax-agent-acp. Depends on US-001, US-002, US-003.

The router's turn-scoped ledger (`createInboundRouter`'s third parameter, `routerFor` wiring),
`PermissionContext.isOwnToolCall`, `OWN_TOOL_REASON`, and the auto-allow in `decidePermission`.
Integration ACs run Cursor and Codex under profile `ask`, the profile where an unmatched request
becomes a card.

### US-005 — `nax run` delivers provider tools to Codex and Cursor

Workdir: packages/nax. Depends on US-001, US-002.

`finalizeAcpSurface` delivers to agents with a pre-approval channel or an `mcpCallIdentity`;
the tool audit recognises loopback calls through `parseToolHostToolName`.

### Context Files

**US-001**
- `packages/nax-agent-acp/src/client/tool-host.ts`
- `packages/nax-agent-acp/src/client/pre-approval.ts`
- `packages/nax-agent-acp/src/client/backend.ts`
- `packages/nax-agent-acp/src/client/open.ts`
- `packages/nax-agent-acp/src/client/index.ts`

**US-002**
- `packages/nax-agent-acp/src/client/registry.ts`
- `packages/nax-agent-acp/src/client/capabilities.ts`
- `packages/nax-agent-acp/src/client/open.ts`
- `packages/nax-agent-acp/test/unit/client/backend-tools.test.ts`
- `packages/nax-agent-acp/test/fixtures/fake-agent/script.ts`

**US-003**
- `packages/nax-agent-acp/src/client/registry.ts`
- `packages/nax-agent-acp/src/client/tool-events.ts`

**US-004**
- `packages/nax-agent-acp/src/client/inbound.ts`
- `packages/nax-agent-acp/src/client/permissions.ts`
- `packages/nax-agent-acp/src/client/backend.ts`
- `packages/nax-agent-acp/src/client/own-tool-calls.ts` — created by US-003, wired here
- `packages/nax-agent-acp/test/fixtures/fake-agent/script.ts`

**US-005**
- `packages/nax/src/agents/acp/provider-embedder.ts`
- `packages/nax/src/agents/acp/tool-audit.ts`
- `packages/nax/src/agents/acp/open-context.ts`

### Creates

**US-001**
- `packages/nax-agent-acp/test/unit/client/tool-host-server-name.test.ts`

**US-002**
- `packages/nax-agent-acp/test/unit/client/backend-own-tools.test.ts`

**US-003**
- `packages/nax-agent-acp/src/client/own-tool-calls.ts`
- `packages/nax-agent-acp/test/unit/client/own-tool-calls.test.ts`

**US-004**
- `packages/nax-agent-acp/test/unit/client/permissions-own-tool.test.ts`
- `packages/nax-agent-acp/test/unit/client/backend-own-tool-approval.test.ts`

**US-005**

None; US-005 extends existing test files.

### Modifies

**US-001**
- `packages/nax-agent-acp/test/unit/client/pre-approval.test.ts` — asserts `mcpToolRule("fetch_page")` is `"mcp__nax__fetch_page"` and calls `claudeSessionMeta(kind, toolNames, readOnly, extras)` at every one of its nine call sites, expecting `mcp__nax__<tool>` rules. `mcpToolRule` now takes `(serverName, toolName)` and `claudeSessionMeta` takes the server name as its second argument; pass `"nax-0badc0de"` and expect `mcp__nax-0badc0de__<tool>` rules. The `TOOL_HOST_SERVER_NAME` is `"nax"` assertion is unchanged.
- `packages/nax-agent-acp/test/unit/client/tool-host.test.ts` — the start test expects the returned server entry's `name` to be `"nax"`. The name is now the host's `serverName`; create that host with `{ serverName: "nax-0badc0de" }` and expect `name: "nax-0badc0de"`. Every other field of the entry is unchanged.
- `packages/nax-agent-acp/test/unit/client/backend-tools.test.ts` — the Claude open test expects session/new `mcpServers[0].name` `"nax"` and `allowedTools: ["mcp__nax__lookup"]`. Set `_acpBackendDeps.newToolHostServerName` to return `"nax-0badc0de"` in that test (restored after) and expect `name: "nax-0badc0de"` and `allowedTools: ["mcp__nax-0badc0de__lookup"]`.
- `packages/nax-agent-acp/test/unit/client/open.test.ts` — the `SERVER` fixture has `name: "nax"` and `stubHost` returns a `ToolHost` without `serverName`, and the Claude test expects `allowedTools: ["mcp__nax__lookup", "mcp__nax__fetch_page"]`. Give `stubHost` `serverName: "nax-0badc0de"` and `SERVER` the same name, and expect `["mcp__nax-0badc0de__lookup", "mcp__nax-0badc0de__fetch_page"]`.
- `packages/nax-agent-acp/test/unit/client/backend.test.ts` — the public-entry test lists exactly the ./client entry runtime exports. Insert `"parseToolHostToolName"` into the sorted list; the other names are unchanged.
- `packages/nax-agent-acp/api/nax-agent-acp.api.txt` — the ./client entry snapshot gains the runtime export `parseToolHostToolName`; regenerate with `bun run api:update`. No other line changes.
- `packages/nax-agent-acp/test/unit/client/tool-host-instructions.test.ts` — its stubbed `createToolHost` returns `ToolHost` objects without `serverName`, which no longer satisfy the interface. Add `serverName: "nax-0badc0de"` to each stub; no assertion changes.
- `packages/nax-agent-acp/README.md` — documents embedder tools as `mcp__nax__<tool>`. Document the per-session name `mcp__nax-<8 hex>__<tool>`; no other text changes.

**US-002**
- `packages/nax-agent-acp/test/unit/client/registry.test.ts` — the `toEqual` assertions on the full `cursor` and `codex` entries lack `mcpCallIdentity`. Add `mcpCallIdentity: "cursor"` to the cursor expectation and `mcpCallIdentity: "codex"` to the codex expectation; the claude, pi, gemini and opencode expectations are unchanged (the field is undefined there).
- `packages/nax-agent-acp/test/unit/client/capabilities.test.ts` — the two `buildCapabilityRecord` `toEqual` expectations (Claude's full initialize, and an empty initialize with a custom agent) are full records without `ownToolCalls`. Add `ownToolCalls: false` to both (neither Claude nor a custom agent has an MCP call identity). The "tools need HTTP MCP and pre-approval" refusal builds its record from the custom one and is unchanged.
- `packages/nax-agent-acp/test/unit/client/resume.test.ts` — its `CapabilityRecord` fixture lacks `ownToolCalls`, so it no longer type-checks. Add `ownToolCalls: false`; no assertion changes.
- `packages/nax-agent-acp/test/unit/client/backend-codex.test.ts` — asserts Codex with tools under `read` fails `AGENT_SESSION_CAPABILITY_UNSUPPORTED` (`capability: "tools"`). Codex now accepts tools. Replace with: the session opens, and session/new carries one `http` MCP server and no `_meta`.
- `packages/nax-agent-acp/test/unit/client/backend-tools.test.ts` — "codex (no pre-approval): CAPABILITY_UNSUPPORTED tools" now opens. Run the same refusal against `gemini` instead; the expectation (`capability: "tools"`) is unchanged.
- `packages/nax-agent-acp/test/unit/client/open.test.ts` — "an agent without pre-approval (codex): CAPABILITY_UNSUPPORTED tools; the host never starts" now opens. Run it with `agent: "gemini"`; the expectations (capability `tools`, zero host starts) are unchanged.

**US-003**

None. The module is new and nothing imports it yet.

**US-004**

None. The router's third parameter and `PermissionContext.isOwnToolCall` are optional, so existing callers and fakes keep compiling and behaving as before.

**US-005**
- `packages/nax/test/unit/agents/acp/provider-embedder.test.ts` — "codex: no pre-approval channel — tools dropped, the skip recorded, advertised emptied" now delivers. Run that test with `"gemini"` and expect the skip `{ id: "gemini", reason: "mcp-pre-approval-unsupported" }`; the other expectations are unchanged.
- `packages/nax/test/unit/agents/acp/open-context.test.ts` — "codex with provider tools: degrades to a tool-less open" now delivers tools. Run it with `agent: "gemini"`; the expectation `ctx.tools` equals `[]` is unchanged.
- `packages/nax/test/unit/agents/acp/tool-audit.test.ts` — the loopback test uses the agent-visible name `"mcp__nax__codegraph__search_graph"`, which no session produces now. Use `"mcp__nax-0badc0de__codegraph__search_graph"`; the expected `provider` `"codegraph"` and `tool` `"codegraph__search_graph"` are unchanged.
- `packages/nax/src/agents/acp/provider-embedder.ts` — the `toEmbedderTools` doc comment says the agent calls a provider tool as `mcp__nax__<name>` and the module comment says delivery is Claude-only. Say `mcp__<session server name>__<name>` and that delivery covers agents with a pre-approval channel or an MCP call identity; no code change beyond `registryCapable`.
- `packages/nax/test/unit/mcp/provider-instructions.test.ts` — the `test.each` row `["AC-21", "codex", false]` asserts `openContext` for codex delivers no tools and no `providerInstructions`; codex now receives both. Change that row's agent to `"gemini"`; the `false` expectation and the claude row are unchanged.

### Seams

- US-001 → US-004: the server name reaches the ledger through `backend.ts` (US-004 integration ACs pin `_acpBackendDeps.newToolHostServerName` and match on it).
- US-001 → US-005: `parseToolHostToolName` is called by `createAuditRecorder` (US-005 ACs drive `onEvent` with a session-named tool).
- US-002 → US-004: `mcpCallIdentity` selects the ledger shape (US-004 integration ACs open real `cursor` and `codex` backends).
- US-003 → US-004: `createOwnToolLedger` is built by `routerFor` and consulted by `decidePermission` (US-004 integration ACs observe the permission answers).
- US-002 → US-005: `mcpCallIdentity` makes `finalizeAcpSurface` deliver (US-005 ACs at `openContext`, the `nax run` ACP open path).

## Acceptance Criteria

### US-001

1. [unit] `newToolHostServerName()` returns a string made of `"nax-"` followed by exactly 8 lowercase hexadecimal characters.
2. [unit] Two calls to `newToolHostServerName()` return different strings.
3. [unit] `createToolHost(calls, token, { serverName: "nax-0badc0de" }).serverName` equals `"nax-0badc0de"`.
4. [unit] `start()` on that host resolves to a server entry whose `name` is `"nax-0badc0de"`.
5. [unit] `createToolHost(calls, token)` with no `serverName` option has a `serverName` of `"nax-"` followed by 8 lowercase hexadecimal characters.
6. [unit] `mcpToolRule("nax-0badc0de", "lookup")` returns `"mcp__nax-0badc0de__lookup"`.
7. [unit] `claudeSessionMeta("claudeCode.allowedTools", "nax-0badc0de", ["lookup"], undefined)` returns `{ claudeCode: { options: { allowedTools: ["mcp__nax-0badc0de__lookup"] } } }`.
8. [integration] With `_acpBackendDeps.newToolHostServerName` returning `"nax-0badc0de"`, opening an `acpBackend({ agent: "claude" })` session with one embedder tool `lookup` against the fake agent sends `session/new` whose `mcpServers[0].name` is `"nax-0badc0de"`.
9. [integration] That `session/new` carries `_meta.claudeCode.options.allowedTools` equal to `["mcp__nax-0badc0de__lookup"]`.
10. [integration] When that session's fake agent process exits and the next prompt reconnects, the reconnect's `session/resume` or `session/load` request names the MCP server `"nax-0badc0de"`.
11. [integration] Across that open and reconnect, `_acpBackendDeps.newToolHostServerName` is called exactly once.
12. [integration] Opening a `claude` session with no embedder tools never calls `_acpBackendDeps.newToolHostServerName`.
13. [unit] `toolHostFor(ctx, router, [], "token-1", "nax-0badc0de")` for a context whose provider instructions are `"X"` calls `_acpBackendDeps.createToolHost` with the options `{ instructions: "X", serverName: "nax-0badc0de" }`.
14. [unit] `parseToolHostToolName("mcp__nax-0badc0de__codegraph__search_graph")` returns `"codegraph__search_graph"`.
15. [unit] `parseToolHostToolName("mcp__nax__lookup")` returns `undefined`.
16. [unit] `parseToolHostToolName("mcp__nax-0BADC0DE__lookup")` returns `undefined`.
17. [unit] `parseToolHostToolName("mcp__nax-0badc0de__")` returns `undefined`.
18. [unit] `parseToolHostToolName("Bash")` returns `undefined`.
19. [unit] `parseToolHostToolName` imported from the `./client` entry (`src/client/index.ts`) returns `"lookup"` for `"mcp__nax-0badc0de__lookup"`.

### US-002

1. [unit] `registryEntry("codex")?.mcpCallIdentity` is `"codex"`.
2. [unit] `registryEntry("cursor")?.mcpCallIdentity` is `"cursor"`.
3. [unit] `registryEntry("claude")?.mcpCallIdentity` is `undefined`.
4. [unit] `registryEntry("gemini")?.mcpCallIdentity` is `undefined`.
5. [unit] `registryEntry("opencode")?.mcpCallIdentity` is `undefined`.
6. [unit] `registryEntry("pi")?.mcpCallIdentity` is `undefined`.
7. [unit] `buildCapabilityRecord` for an initialize response advertising HTTP MCP and `registryEntry("cursor")` returns a record with `ownToolCalls: true`.
8. [unit] `buildCapabilityRecord` for the same response and `registryEntry("gemini")` returns a record with `ownToolCalls: false`.
9. [unit] `unmetRequirement` for a record with `mcpHttp: true`, `preApproval: false`, `ownToolCalls: true` and requirements `{ profile: "full", toolCount: 1, resume: false }` returns `undefined`.
10. [unit] `unmetRequirement` for a record with `mcpHttp: false`, `preApproval: false`, `ownToolCalls: true` and one tool returns `capability: "tools"`.
11. [unit] `unmetRequirement` for a record with `mcpHttp: true`, `preApproval: false`, `ownToolCalls: false` and one tool returns `capability: "tools"`.
12. [integration] An `acpBackend({ agent: "codex" })` session under profile `read` with embedder tool `lookup`, against a fake agent advertising HTTP MCP, opens without error.
13. [integration] That session's `session/new` has exactly one `mcpServers` entry, of type `http`, whose `name` is `"nax-"` followed by 8 lowercase hexadecimal characters.
14. [integration] That `session/new` carries no `_meta` field.
15. [integration] An `acpBackend({ agent: "cursor" })` session under profile `full` with embedder tool `lookup` opens, and a fake-agent `mcpCall` step for `lookup` records an `mcp-result` for `lookup`.
16. [integration] An `acpBackend({ agent: "gemini" })` session with an embedder tool fails with `AGENT_SESSION_CAPABILITY_UNSUPPORTED` and `capability: "tools"`.
17. [integration] An `acpBackend({ agent: "codex" })` session with an embedder tool, against a fake agent that does not advertise HTTP MCP, fails with `AGENT_SESSION_CAPABILITY_UNSUPPORTED` and `capability: "tools"`.

### US-003

1. [unit] `mcpCallIdentityOf("cursor", update)` for a `tool_call_update` with `toolCallId: "t1"` and `rawInput: { providerIdentifier: "nax-0badc0de", toolName: "lookup", args: {} }` returns `{ toolCallId: "t1", server: "nax-0badc0de", tool: "lookup" }`.
2. [unit] `mcpCallIdentityOf("cursor", update)` for a `tool_call` with `toolCallId: "t1"` and `rawInput: { providerIdentifier: "nax-0badc0de", toolName: "lookup", args: {} }` returns `{ toolCallId: "t1", server: "nax-0badc0de", tool: "lookup" }`.
3. [unit] `mcpCallIdentityOf("codex", update)` for a `tool_call` with `toolCallId: "t2"` and `rawInput: { server: "nax-0badc0de", tool: "lookup", arguments: {} }` returns `{ toolCallId: "t2", server: "nax-0badc0de", tool: "lookup" }`.
4. [unit] `mcpCallIdentityOf("codex", update)` for a `tool_call_update` with `toolCallId: "t2"` and `rawInput: { server: "nax-0badc0de", tool: "lookup", arguments: {} }` returns `{ toolCallId: "t2", server: "nax-0badc0de", tool: "lookup" }`.
5. [unit] `mcpCallIdentityOf("codex", update)` for a `tool_call_update` with `toolCallId: "t1"` and `rawInput: { providerIdentifier: "nax-0badc0de", toolName: "lookup", args: {} }` returns `undefined`.
6. [unit] `mcpCallIdentityOf("cursor", update)` for a `tool_call_update` whose `rawInput.providerIdentifier` is the number `7` returns `undefined`.
7. [unit] `mcpCallIdentityOf("cursor", update)` for a `tool_call_update` whose `rawInput.providerIdentifier` is the empty string returns `undefined`.
8. [unit] `mcpCallIdentityOf("cursor", update)` for a `tool_call_update` whose `rawInput` is the string `"lookup"` returns `undefined`.
9. [unit] `mcpCallIdentityOf("cursor", update)` for a `tool_call_update` whose `rawInput` is `{ providerIdentifier: "nax-0badc0de" }` (no `toolName`) returns `undefined`.
10. [unit] `mcpCallIdentityOf("codex", update)` for a `tool_call` whose `rawInput` is `{ server: "nax-0badc0de", tool: "" }` returns `undefined`.
11. [unit] `mcpCallIdentityOf("cursor", update)` for a `tool_call_update` with `title: "nax-0badc0de-lookup: lookup"` and no `rawInput` returns `undefined`.
12. [unit] `mcpCallIdentityOf("cursor", update)` for an `agent_message_chunk` update returns `undefined`.
13. [unit] A ledger from `createOwnToolLedger({ kind: "cursor", serverName: "nax-0badc0de", toolNames: ["lookup"] })` that observed a `tool_call_update` with `toolCallId: "t1"` and `rawInput: { providerIdentifier: "nax-0badc0de", toolName: "lookup", args: {} }` returns `true` from `isOwn("t1")`.
14. [unit] That ledger returns `false` from `isOwn("t9")`, an id it never observed.
15. [unit] A cursor ledger for `"nax-0badc0de"` that observed `t1` with `providerIdentifier: "nax"` returns `false` from `isOwn("t1")`.
16. [unit] A cursor ledger for `"nax-0badc0de"` with `toolNames: ["lookup"]` that observed `t1` with `toolName: "other"` returns `false` from `isOwn("t1")`.
17. [unit] A cursor ledger that observed `t1` first with `toolName: "lookup"` and then with `toolName: "other"` (same server) returns `false` from `isOwn("t1")`.
18. [unit] A cursor ledger for `"nax-0badc0de"` that observed `t1` first with `providerIdentifier: "nax"` and then with `providerIdentifier: "nax-0badc0de"` (same tool) returns `false` from `isOwn("t1")`.

### US-004

1. [unit] `decidePermission` under profile `read`, with `isOwnToolCall` returning `true` for the request's `toolCallId` and options allow-once and reject-once, returns the allow-once option's `optionId` as selected.
2. [unit] In that decision, `asks.recordAutoDecision` is called with reason `OWN_TOOL_REASON` and decision `"allow"`.
3. [unit] `decidePermission` under profile `ask`, with `isOwnToolCall` returning `true` and an allow-once option offered, never calls `asks.requestApproval`.
4. [unit] `decidePermission` under profile `read`, with `isOwnToolCall` returning `true` and only allow-always and reject-once offered, selects the reject-once option.
5. [unit] `decidePermission` under profile `ask`, with `isOwnToolCall` returning `false`, calls `asks.requestApproval` once.
6. [unit] `decidePermission` with an aborted `signal` and `isOwnToolCall` returning `true` returns the outcome `cancelled`.
7. [unit] `createInboundRouter(decide, undefined, () => ledger)` passes `decide` a third argument that returns `true` for `t1` after the router's `onUpdate` handler received, during the attached turn, a `tool_call_update` the ledger counts as own for `t1`.
8. [integration] With `_acpBackendDeps.newToolHostServerName` returning `"nax-0badc0de"`, an `acpBackend({ agent: "cursor" })` session under profile `ask` with embedder tool `lookup`, whose fake agent sends a `tool_call_update` for `t1` with `rawInput: { providerIdentifier: "nax-0badc0de", toolName: "lookup", args: {} }` and then a permission request for `t1` offering allow-once and reject-once, answers the request with the allow-once option.
9. [integration] In that turn the session emits no `approval_requested` event with `answerable: true`.
10. [integration] In that turn the session emits one `approval_requested` event with `answerable: false` and `reason` equal to `OWN_TOOL_REASON`.
11. [integration] The same Cursor session, when the update's `providerIdentifier` is `"nax"`, emits one `approval_requested` event with `answerable: true` and `reason` equal to `ASK_REASON`.
12. [integration] The same Cursor session, when the update for `t1` is sent in the first prompt and the permission request for `t1` in the second prompt, emits one `approval_requested` event with `answerable: true` and `reason` equal to `ASK_REASON` in the second prompt.
13. [integration] With `_acpBackendDeps.newToolHostServerName` returning `"nax-0badc0de"`, an `acpBackend({ agent: "codex" })` session under profile `ask` with embedder tool `lookup`, whose fake agent sends a `tool_call` for `t2` with `rawInput: { server: "nax-0badc0de", tool: "lookup", arguments: {} }` and then a permission request for `t2` offering allow-once and reject-once, answers with the allow-once option.
14. [integration] That Codex turn emits no `approval_requested` event with `answerable: true`.
15. [integration] An `acpBackend({ agent: "claude" })` session under profile `ask` with embedder tool `lookup`, whose fake agent sends a Cursor-shaped `tool_call_update` for `t1` naming the session's server and then a permission request for `t1`, emits one `approval_requested` event with `answerable: true` and `reason` equal to `ASK_REASON` (Claude has no `mcpCallIdentity`, so no ledger is built).

### US-005

1. [unit] `finalizeAcpSurface("codex", opts, "full")`, with one provider tool `context7__query-docs` and a tool-surface draft, returns `tools` whose names are `["context7__query-docs"]`.
2. [unit] That result's `surface.skippedProviders` has no entry with `id` `"codex"`.
3. [unit] `finalizeAcpSurface("cursor", opts, "full")` with the same opts returns `tools` whose names are `["context7__query-docs"]`.
4. [unit] `finalizeAcpSurface("gemini", opts, "full")` with the same opts returns `tools` equal to `[]`.
5. [unit] That gemini result's `surface.skippedProviders` contains `{ id: "gemini", reason: "mcp-pre-approval-unsupported" }`.
6. [integration] `openContext` for `agent: "codex"` with one provider tool returns a context whose `tools` names are that provider tool's name.
7. [unit] A recorder from `createAuditRecorder` given a `tool_call` event named `"mcp__nax-0badc0de__codegraph__search_graph"` and its `tool_result` writes a row whose `provider` is `"codegraph"`.
8. [unit] That row's `tool` is `"codegraph__search_graph"`.
9. [unit] A recorder given a `tool_call` event named `"mcp__nax__codegraph__search_graph"` and its result writes a row whose `tool` is `"mcp__nax__codegraph__search_graph"`.
10. [unit] That row has no `provider` field.
