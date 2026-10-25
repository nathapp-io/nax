# SPEC: chat-mcp-servers — Claude Code MCP servers in nax chat, through the existing MCP pool and lock

## Summary

`nax chat` gains MCP tools. The servers come from two places: the `mcp.servers` block nax
already has, and the MCP entries the F4 resource catalog parses from Claude Code (the
repo's `.mcp.json`, every enabled Claude Code plugin's `.mcp.json`, and the user and local
scopes of `~/.claude.json`, which `claude mcp add` writes). One pure merge turns the
catalog entries into ordinary `McpServerConfig` entries: it gives each a provider-safe id,
expands `${VAR}`, `${VAR:-default}` and a plugin's `${CLAUDE_PLUGIN_ROOT}`, and lets an
explicit `mcp.servers` entry win a name clash. The merged servers reach the chat session
through the existing `createMcpPool`, `createMcpProviders`, the `.nax/mcp-lock.json` lock and
the trust check, as `discovered` tool providers. `McpServerConfig` gains an HTTP transport
(`url` plus `headers`), which the shared nax-agent MCP layer already speaks. In guarded mode
an MCP tool asks before it runs unless its server marks it read-only
(`annotations.readOnlyHint`); full mode never asks. `/mcp` lists every server with its
source, transport, connection state and withheld tools. `nax mcp lock` locks catalog servers
too. `nax run` attaches catalog servers only when the new `resources.mcpInRun` is set
(default off).

This is feature F5a of the nax interactive coding agent, slice 1
(`docs/superpowers/specs/2026-10-24-nax-interactive-tui-slice1-design.md` §4.3, §4.5, §5.1
row F5), split from F5 by the user on 2026-10-25. F5b `chat-subagents` (the `Agent`
provider, nested sessions, `agent.modelAliases`, `/agents`) follows it. It builds on F3
`nax-chat-shell` (#2695) and F4 `resource-catalog-and-skills` (#2698). It changes
`packages/nax-agent` and `packages/nax`.

## Motivation

- **Chat has no MCP at all.** F4 wired only the skills provider into `nax chat`
  (`packages/nax/src/cli/chat.ts` `chatResources`). Even servers configured in
  `mcp.servers` for `nax run` never reach a chat session, so the slice-1 acceptance test
  (brainstorm and spec-review inside the nax TUI) runs without the codebase-memory graph
  the user relies on in Claude Code.
- **The catalog parses MCP entries and drops the useful half.** `McpServerResource` keeps a
  name and a transport only (`packages/nax/src/resources/types.ts`); the command, args, env,
  url and headers are discarded, and `/plugins` prints `mcp N (not delivered yet)`.
- **Most of the user's servers live in `~/.claude.json`.** `claude mcp add` writes the local
  scope (`projects[<repo>].mcpServers`) and the user scope (top-level `mcpServers`) there;
  F4 reads neither (its Out of Scope says so). The user ruled on 2026-10-25 to read both.
- **The session API refuses MCP providers.** `nativeBackend` accepts only `kind: "static"`
  providers (`packages/nax-agent/src/session/native-backend-options.ts`), and every provider
  tool is granted with no ask (`expandProviderGrants`), so an MCP tool would run in guarded
  mode without the human seeing it. Design §4.3 says guarded asks for every MCP tool the
  server does not mark read-only.
- **One MCP client, not two.** Design §4.5 and the user's 2026-10-25 catalog ruling require
  catalog servers to go through the existing pool, lock and trust check. The user ruled on
  2026-10-25 that catalog servers are subject to the lock (withheld until `nax mcp lock`
  pins them), and that catalog MCP is chat-only unless `resources.mcpInRun` is set.

## Design

### Approach

**1. nax-agent: read-only hints, discovered providers, guarded asks (US-001).**

- `McpToolInfo` (`packages/nax-agent/src/mcp/types.ts`) gains `readonly readOnly?: true`.
  `toolInfo(raw)` in `src/mcp/connect.ts` sets `readOnly: true` exactly when
  `raw.annotations` is an object whose `readOnlyHint` is the boolean `true`; in every other
  case the property is absent (not `undefined`), so a tool with no annotations keeps today's
  exact shape.
- `ProviderTool` (`src/tools/provider-types.ts`) gains `readonly readOnly?: boolean`.
  `sanitizeProviderTools` already spreads the tool, so the hint survives sanitisation.
- `ResolvedProviderTools` (`src/tools/provider-advertise.ts`) gains
  `readonly askTools?: readonly string[]`: the advertised (namespaced) names of tools that
  came from a `discovered` provider and whose `readOnly` is not `true`, in advertise order.
  Absent when the list would be empty. A `static` provider's tools never appear in it: their
  schemas are authored in this repo, and the skills tool must not ask on every load.
- `NativeBackendOptions.toolProviders` accepts `kind: "discovered"` as well as `"static"`;
  the zod check becomes `provider.kind === "static" || provider.kind === "discovered"`, and
  its message becomes `must be an array of tool providers with id, kind, stages and tools()`.
  Sanitisation of discovered tools already happens inside `resolveProviderTools` by kind.
- `buildSessionToolSupport` (`src/session/session-tool-support.ts`): when `args.profile` is
  `"ask"`, the ask rules passed to `buildCodingToolSupport` are `askRulesFor(...)` followed by
  one `{ tool: name, patterns: ["*"] }` per name in `args.providerTools?.askTools`. Every
  other profile adds none, so `full` (chat full mode) never asks for an MCP tool.
- The ask that results is an ordinary `approval_requested` event whose `tool` is the
  namespaced name. `approvalMemoryKey` already returns the tool name for a non-execute tool,
  so the chat's "allow for this session" remembers an MCP tool by name with no change.

**2. HTTP transport and the read-only hint in nax's MCP layer (US-002).**

- `McpToolDescriptor` (`packages/nax/src/mcp/types.ts`) gains `readonly readOnly?: true`.
  `connectMcpServer` already returns the shared layer's tool objects unchanged, so the hint
  set by US-001 arrives with no mapping. `createMcpProviders` (`src/mcp/provider.ts`) maps
  each admitted tool to a `ProviderTool` that carries `readOnly: true` only when the
  descriptor has `readOnly: true` AND the resolved lock lists the tool under
  `readOnly[serverId]`; otherwise the tool has no `readOnly` key. The hint is server-stated
  and untrusted, so it counts only after a human locked it: a hint that appears or flips
  after locking makes the tool ask again until `nax mcp lock` is re-run (security review
  2026-10-25). Without this mapping every MCP tool would land in `askTools`.
- `McpLockFile` (`src/mcp/lock.ts`) gains
  `readonly readOnly?: Readonly<Record<string, readonly string[]>>` (server id -> names of
  tools locked as read-only). A lock whose `readOnly` is not an object of string arrays is
  read as having no `readOnly` entries. The lock stays `version: 1`; a lock written before
  this feature has no `readOnly` and so marks nothing read-only.
- Connect-failure reasons are redacted before the pool records or logs them
  (`redactMcpReason(reason, server)` in `src/mcp/pool.ts`): for a server with a `url`, every
  occurrence of the configured url is replaced by its origin plus pathname (no userinfo,
  query or fragment), and every non-empty `headers` value is replaced by `***`. The
  `connect-failed` event's `reason`, the warn log's `error` field and `/mcp` all see the
  redacted text.
- `McpServerSchema` (`packages/nax/src/config/schemas-mcp.ts`): `command` becomes optional;
  new `url: z.string().url().optional()` and `headers: z.record(z.string(), z.string()).default({})`.
  The object keeps `.strict()` and gains a refinement: exactly one of `command` and `url` is
  set, with the message `set exactly one of command or url`.
- `McpServerConfig` (`src/config/runtime-types-mcp.ts`): `command?: string`, `url?: string`,
  `headers?: Record<string, string>` (optional in the interface so existing typed literals
  still compile; the schema always fills it). `args` and `env` keep their defaults and are
  ignored for an HTTP server.
- `connectMcpServer` (`src/mcp/client.ts`) takes `command?`, `url?` and `headers?`; a `url`
  builds `{ kind: "http", url, headers: headers ?? {} }`, otherwise today's stdio config.
- `createMcpPool` (`src/mcp/pool.ts`) passes `url` and `headers` through. An HTTP connection
  has `pid` null, so `onSpawn` never fires and the pid registry is untouched.
- `nax mcp lock`'s empty-server hint names the url for an HTTP server instead of
  `undefined`.
- Config descriptions (`src/cli/config-descriptions.ts`) gain `mcp.servers.<id>.url` and
  `mcp.servers.<id>.headers`, and `mcp.servers.<id>.command` says it is the stdio form.

**3. Catalog MCP entries keep their connection spec (US-003 parsing, US-004 discovery).**

`McpServerResource` (`packages/nax/src/resources/types.ts`) target:

```ts
export type McpServerSpec =
  | {
      readonly transport: "stdio";
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
    }
  | {
      readonly transport: "http" | "sse";
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    };

export type McpServerScope = "local" | "project" | "user" | "plugin";

export interface McpServerResource {
  readonly kind: "mcp";
  readonly name: string;
  readonly transport: "stdio" | "http" | "sse";
  readonly scope: McpServerScope;
  readonly server: McpServerSpec;
  readonly path: string;
  readonly origin: ResourceOrigin;
}
```

- `parseMcpJson(path, text, origin, scope)` (`src/resources/parse-mcp.ts`) gains the scope
  parameter. Per entry: `type` `"http"` or `"sse"` needs a string `url` (headers default to
  `{}`); otherwise a string `command` makes a stdio entry (`args` default `[]`, `env`
  default `{}`). `args` that is not an array of strings, `env` or `headers` that is not an
  object of strings, or an http/sse entry with no string `url` yields a `warn` diagnostic
  `[resources] Unsupported MCP entry <name> in <path>` and no resource (today's message).
- A new `parseMcpServers(path, servers, origin, scope)` holds the per-entry loop so that
  `~/.claude.json` reuses it on an already-parsed object; `parseMcpJson` parses the text and
  calls it.
- `claudeJsonPath(env)` (`src/resources/claude-paths.ts`): `<CLAUDE_CONFIG_DIR>/.claude.json`
  when `CLAUDE_CONFIG_DIR` is set, otherwise `<homedir>/.claude.json`. This is Claude Code's
  own location for the file.
- `discoverClaudeCodePackages({ repoRoot, claudeDir, claudeJson })`
  (`src/resources/claude-sources.ts`) reads `claudeJson` once. Its top-level `mcpServers`
  become the user package's `mcpServers` with scope `user`. Its
  `projects[repoRoot].mcpServers` (exact key match) come first in the project package's
  `mcpServers` with scope `local`, followed by the repo `.mcp.json` entries with scope
  `project`. A plugin's `.mcp.json` entries have scope `plugin`. Entries read from
  `claudeJson` carry `path` equal to the `claudeJson` path; user-scope entries have origin
  `claude-user` and local-scope entries origin `claude-project`. A missing file adds nothing
  and no diagnostic; a file that does not parse as a JSON object adds one `error` diagnostic
  to the user package; a `projects` or `mcpServers` value that is not an object adds one
  `error` diagnostic and nothing from that value.
- `loadResourceCatalog` passes `claudeJson: claudeJsonPath(env)`.
- `src/resources/index.ts` exports `parseMcpServers`, `claudeJsonPath` and the types
  `McpServerSpec` and `McpServerScope` (US-003, US-004).
- `formatPluginsListing` prints `mcp N` without `(not delivered yet)`; agents keep it until
  F5b.

**4. The merge (US-005 ids and expansion, US-006 merge).** New `packages/nax/src/resources/mcp-merge.ts`:

```ts
export type McpServerSource = "config" | McpServerScope;

export interface MergedMcpServers {
  readonly config: McpConfig;
  /** Server id -> where the entry came from; plugin entries also carry the plugin name. */
  readonly sources: ReadonlyMap<string, { readonly source: McpServerSource; readonly plugin?: string }>;
  readonly diagnostics: readonly ResourceDiagnostic[];
}

export function mergeCatalogMcpServers(input: {
  readonly mcp: McpConfig | undefined;
  readonly catalog: ResourceCatalog;
  readonly env: Readonly<Record<string, string | undefined>>;
}): MergedMcpServers;
```

- Order: every `input.mcp.servers` entry first (source `config`, copied unchanged), then the
  catalog's packages in package order (project, user, plugins) and each package's
  `mcpServers` in order. The first entry to claim an id wins. A later catalog entry with
  the same id is dropped with a `warn` diagnostic
  `[resources] mcp server <id> from <path> is shadowed by <winner>`, where `<winner>` is
  `config`, `local`, `project`, `user` or `plugin <name>`.
- Configured `mcp.servers` entries are not expanded; only catalog entries are.
- Id: the base is the entry `name`, or `<plugin>-<name>` for an entry whose origin is
  `claude-plugin`. `mcpServerId(base)` lowercases it, replaces every run of characters
  outside `[a-z0-9_-]` with `-`, replaces every run of two or more `_` with one `_`, and
  strips leading characters that are not `[a-z0-9]`. An empty result drops the entry with
  an `error` diagnostic `[resources] mcp server name <name> in <path> yields no usable id`.
  The result always satisfies `MCP_SERVER_ID_RE` and contains no `__`.
- Expansion (`expandMcpValue(value: string, vars: Readonly<Record<string, string | undefined>>):
  { readonly value: string } | { readonly missing: string }` in
  `src/resources/mcp-expand.ts`; `missing` names the first unset variable): every
  `${NAME}` becomes `vars[NAME]` (an empty string is a value); every `${NAME:-default}`
  becomes `vars[NAME]` when it is set and non-empty, otherwise `default` (shell `:-`
  semantics; the default runs to the first `}` and may be empty, nesting is not supported,
  and an unterminated `${` is copied literally). `NAME` matches `[A-Za-z_][A-Za-z0-9_]*`; any other text,
  including a `$` not followed by `{`, is copied literally. `vars` is `input.env` plus, for a
  `claude-plugin` entry, `CLAUDE_PLUGIN_ROOT` set to that package's `root` (overriding the
  environment). It applies to `command`, each of `args`, each `env` value, `url` and each
  `headers` value; keys are never expanded. A `${NAME}` with no value and no default drops
  the entry with an `error` diagnostic
  `[resources] mcp server <id>: ${NAME} is not set`.
- An `sse` entry is dropped with a `warn` diagnostic
  `[resources] mcp server <id>: transport sse is not supported`.
- A kept catalog entry becomes `McpServerConfig` with `stages: ["*"]`,
  `timeoutMs: MCP_DEFAULT_TIMEOUT_MS`, `enabled: true`, `headers: {}` for stdio, and
  `args: []`, `env: {}` for http.
- `MCP_DEFAULT_TIMEOUT_MS` and `MCP_SERVER_ID_RE` are added to the `@/config` barrel
  (`src/config/index.ts`) so `src/resources` imports them without an internal path
  (`check:alias-internals`). `mcpServerId` and `expandMcpValue` (US-005) and
  `mergeCatalogMcpServers` with its types (US-006) are exported from `src/resources/index.ts`.

**5. Chat wiring (US-007) and `/mcp` (US-008).** New `packages/nax/src/chat/chat-mcp.ts`:

```ts
export interface ChatMcpServerRow {
  readonly id: string;
  readonly source: McpServerSource;
  readonly plugin?: string;
  readonly transport: "stdio" | "http";
  /** False for a catalog server the lock does not list; it is not connected. */
  readonly locked: boolean;
}

export interface ChatMcpState {
  readonly servers: readonly ChatMcpServerRow[];
  readonly diagnostics: readonly ResourceDiagnostic[];
  /** Pool connection events, read live for /mcp. */
  events(): readonly McpServerEvent[];
  /** Tools the lock withheld so far, read live for /mcp. */
  withheld(): readonly McpWithheldEntry[];
}

export interface ChatMcp {
  readonly state: ChatMcpState;
  readonly providers: readonly ToolProvider[];
  close(): Promise<void>;
}

/**
 * One attempt per server. Session open resolves providers one after another, so with the
 * run default (3 attempts, 2 s and 4 s backoff, 15 s connect deadline) each dead server
 * would hold the chat's start for up to ~51 s; with one attempt, up to 15 s each.
 */
export const CHAT_MCP_RETRY = { maxAttempts: 1, baseDelayMs: 0 } as const;

export function createChatMcp(input: {
  readonly config: NaxConfig;
  readonly catalog: ResourceCatalog;
  readonly repoRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<ChatMcp>;

export function formatMcpListing(state: ChatMcpState | undefined): string;
```

- `chat-mcp.ts` exports `_chatMcpDeps = { createMcpPool, createMcpProviders, readLock }`, the seam
  `createChatMcp` builds through.
- `createChatMcp` is async (it reads the lock). Catalog servers (any source other than
  `config`) whose id has no entry in the resolved lock (`_chatMcpDeps.readLock`, default
  `resolveMcpLock(repoRoot)`) are neither passed to the pool nor attached: a repo- or
  plugin-supplied server is never spawned or contacted, and its expanded `${VAR}` values never
  leave the machine, until a human has run `nax mcp lock`, which is the explicit per-server
  approval (security review 2026-10-25; Claude Code asks per project `.mcp.json` server for
  the same reason). They still get a `state.servers` row with `locked: false`. Configured
  `mcp.servers` entries are not gated (today's behaviour).
- `createChatMcp` merges (Approach 4), keeps every enabled server, and sets each server's
  `stages` to `["*"]`: `stages` decides which `nax run` stages a server attaches to, and a
  chat session is not a pipeline stage. It builds the pool with
  `createMcpPool({ servers, retry: CHAT_MCP_RETRY })` and the providers with
  `createMcpProviders({ config: { servers }, pool, projectRoot: repoRoot, onWithheld })`,
  where `onWithheld` records the entry keyed by `serverId` plus `name`, replacing an earlier
  entry with the same key: `createMcpProviders` reports withheld tools on every `tools()`
  call and the chat resolves providers again on every session reopen (mode switch, model
  switch, `/clear`, resume), so `withheld()` returns each withheld tool once. `close()`
  closes the pool. With no enabled server it builds no pool and returns no providers.
- A server whose id is `nax-skills` (the skills provider's id) is not attached; `createChatMcp`
  drops it with an `error` diagnostic `[resources] mcp server id nax-skills is reserved`.
- `state.servers` has one row per attached server: `id`, `source` and `plugin` from the
  merge's `sources`, and `transport` `http` when the server has a `url`, otherwise `stdio`.
  `state.events()` returns the pool's `events()` (an empty list when no pool was built).
- `state.diagnostics` is the merge diagnostics followed by the catalog diagnostics whose
  `path` ends in `.mcp.json` or `.claude.json`; `/skills` and `/plugins` do not show
  them for the project and user packages, so `/mcp` is where they are seen (a Claude Code
  plugin's `.mcp.json` diagnostic shows in both `/plugins` and `/mcp`).
- `src/chat/index.ts` exports `createChatMcp`, `formatMcpListing`, `CHAT_MCP_RETRY`,
  `_chatMcpDeps` and the types `ChatMcp`, `ChatMcpState` and `ChatMcpServerRow`.
- `_chatCommandDeps` gains `env` (default `process.env`); `chatResources` passes it to both
  `loadResourceCatalog` and `createChatMcp`, so tests isolate the Claude config directory
  without touching the process environment.
- `chatResources` (`src/cli/chat.ts`) calls `deps.createChatMcp` after loading the catalog,
  appends its providers after the skills provider, sets `ChatResources.mcp` to its state,
  and makes `teardown` close the MCP pool and then tear down the plugin registry; a pool
  close that rejects still lets the registry tear down. `createChatMcp` throwing tears the
  registry down and rethrows, as a catalog failure does today.
- `ChatResources` (`src/chat/resources.ts`) gains `readonly mcp?: ChatMcpState`; `ChatHost`
  gains `readonly mcp?: ChatMcpState`, set from `deps.resources?.mcp`.
- `/mcp` is a built-in slash command (after `/plugins` in the help list) that shows
  `formatMcpListing(host.mcp)`. One line per server:
  `<id>  <source label>  <transport>  <status>`, where the source label is `config`,
  `local`, `project`, `user` or `plugin <name>`; status is `connected, <n> tools` after the
  server's last `connected` event, `failed: <reason>` after a `connect-failed` event, and
  `not connected` before any event, and `not locked (run nax mcp lock)` for a row with
  `locked: false`. When the lock withheld any of that server's tools the
  line ends `, <k> withheld (run nax mcp lock)`. Diagnostics follow, one per line, as
  `<severity>  <path>  <message>`. With no state or no servers it prints
  `(no MCP servers)`.
- Connection is lazy, as in `nax run`: the pool connects a server the first time the
  session resolves its tools, at session open. A mode switch reopens the session on the same
  pool, whose memoised entries (including a failed one) are reused.

**6. `nax mcp lock` and the `nax run` opt-in (US-009).**

- `ResourcesConfigSchema` gains `mcpInRun: z.boolean().default(false)` with a config
  description `resources.mcpInRun`.
- New `resolveCatalogMcpConfig(input: { config: NaxConfig; repoRoot: string; env; load })`
  in `src/resources/mcp-merge.ts` returns `config.mcp` unchanged when
  `config.resources?.claudeCode === false`, and otherwise loads the catalog through `load`
  with `{ repoRoot, config, env, naxPluginPackages: [] }` and returns
  `mergeCatalogMcpServers({ mcp: config.mcp, catalog, env }).config`, logging each merge
  diagnostic through the project logger at `warn` (stage `resources`). `load` has
  `loadResourceCatalog`'s signature. `setupRun` calls it with `repoRoot` = its `workdir` and
  `env` = `process.env`; `runMcpLockCommand` with its `workdir` and the seam's `env`.
- `runMcpLockCommand(workdir, opts)` (`src/cli/mcp.ts`) gets a `_mcpLockCommandDeps` seam
  (`loadConfig`, `loadResourceCatalog`, `createMcpPool`, `env`) and locks every enabled
  server of `resolveCatalogMcpConfig(...)`, so catalog servers are pinned beside configured
  ones, for both the project lock and `--global`. For each server it also records
  `readOnly[id]` = the sorted names of the listed tools whose descriptor has `readOnly: true`
  (omitted when none), and `writeMcpLockAt` serialises `readOnly` (servers and names
  sorted) when present. It loads the catalog with
  `naxPluginPackages: []` and `env` from the seam (default `process.env`).
  `resolveCatalogMcpConfig` is exported from `src/resources/index.ts`.
- `resolveCatalogMcpConfig` takes `lockedOnly?: boolean` and `readLock?` (default
  `resolveMcpLock`); with `lockedOnly` true it drops every catalog server whose id the lock
  does not list. `runMcpLockCommand` calls it without `lockedOnly` (it is the approval step);
  `setupRun` calls it with `lockedOnly: true` and `readLock: _runSetupDeps.readMcpLock`.
- `setupRun` (`src/execution/lifecycle/run-setup.ts`): when `config.resources?.mcpInRun` is
  `true`, the config passed to `createRuntime` is `{ ...config, mcp: await
  resolveCatalogMcpConfig(...) }`; otherwise `createRuntime` gets `config` unchanged. The
  merge loads through a new `_runSetupDeps.loadResourceCatalog`. Catalog servers then carry
  `stages: ["*"]` and attach at every run stage.

### Integration (extends existing code)

Read and called, unchanged:

- `createMcpProviders({ config, pool, projectRoot, storyId?, readLock?, onWithheld? })` ->
  `readonly ToolProvider[]` of `kind: "discovered"`, one per enabled server, filtering by
  the lock (`applyLock`) and `allowedTools`, calling `onWithheld` on every `tools()` call —
  `packages/nax/src/mcp/provider.ts` (only its per-tool mapping changes, Approach 2).
- `McpWithheldEntry` (`serverId`, `name`, `reason`, `lockSource`) — same file.
- `McpServerEvent` (`connected` with `toolCount`, `connect-failed` with `reason`, `closed`)
  and `McpPool.events()` — `packages/nax/src/mcp/pool.ts`.
- `createMcpPool({ servers, pidRegistry?, retry?, storyId? })`; `open()` calls
  `assertTrusted(workdir, "mcp")` before connecting — `packages/nax/src/mcp/pool.ts`.
- `MCP_SERVER_ID_RE`, `MCP_DEFAULT_TIMEOUT_MS` — `packages/nax/src/config/schemas-mcp.ts`.
- `McpTransportConfig` (`stdio` | `http` with `url`, `headers`) and the HTTP transport —
  `packages/nax-agent/src/mcp/types.ts`, `src/mcp/transport.ts`.
- `resolveProviderTools(providers, stage, workdir, options?)` sanitises `discovered` tools
  by kind (`sanitizeProviderTools`) — `packages/nax-agent/src/tools/provider-advertise.ts`.
- `askRulesFor(declared, bashApproval, profile)` — `packages/nax-agent/src/session/session-tool-support.ts`.
- `approvalMemoryKey(request)` returns `request.tool` for a non-execute tool —
  `packages/nax-agent/src/permissions/approval-memory.ts:68`.
- `createSkillsProvider(load)` (provider id `nax-skills`) and `loadResourceCatalog(options)`
  — `packages/nax/src/resources/`.
- `chatCommand(options, deps)` / `_chatCommandDeps` and `chatResources(repoRoot, config,
  deps)` — `packages/nax/src/cli/chat.ts`.
- `runSlashCommand(command, { host, show })` and the `COMMANDS` help list —
  `packages/nax/src/tui/chat/slash-commands.ts`.
- `setupRun(options)` and `_runSetupDeps.createRuntime` —
  `packages/nax/src/execution/lifecycle/run-setup.ts:237`; both run modes reach it through
  `runSetupPhase`.

Changed. The baseline locates the code; the target is the interface to implement (Approach
names each target).

- `toolInfo(raw)` — baseline returns `{ name, description, inputSchema }`; target adds
  `readOnly: true` per Approach 1.
- `ProviderTool` — baseline has no `readOnly`; target per Approach 1.
- `ResolvedProviderTools` — baseline has no `askTools`; target per Approach 1.
- `NativeBackendOptions.toolProviders` schema — baseline accepts `kind === "static"` only;
  target per Approach 1.
- `buildSessionToolSupport(args)` — baseline ask rules are `askRulesFor(...)` only; target
  per Approach 1.
- `McpServerSchema` / `McpServerConfig` — baseline `command` required, no `url`/`headers`;
  target per Approach 2.
- `McpToolDescriptor` and the tool mapping inside `createMcpProviders` — baseline maps to
  `{ localName, description, inputSchema, run }`; target adds `readOnly` per Approach 2.
- `connectMcpServer(args)` — baseline `command: string` required; target per Approach 2.
- `McpServerResource` and `parseMcpJson(path, text, origin)` — baseline has no `scope`,
  no `server`; target per Approach 3.
- `discoverClaudeCodePackages({ repoRoot, claudeDir })` — baseline does not read
  `~/.claude.json`; target per Approach 3.
- `formatPluginsListing` — baseline prints `mcp N (not delivered yet)`; target per
  Approach 3.
- `ChatResources`, `ChatHost`, `chatResources`, the slash `COMMANDS` list — target per
  Approach 5.
- `ResourcesConfigSchema`, `runMcpLockCommand`, `setupRun` — target per Approach 6.

### Failure Handling

| Situation | Behaviour |
|---|---|
| A discovered provider passed to `nativeBackend` | Accepted (it was refused before this feature). |
| A server's `readOnlyHint` absent, false or not a boolean | The tool is not read-only: it asks in guarded mode. |
| An MCP server entry with both `command` and `url`, or neither | Config parse fails with `set exactly one of command or url`. |
| A catalog MCP entry with malformed `args`, `env` or `headers`, or an http/sse entry with no `url` | `warn` diagnostic `Unsupported MCP entry <name> in <path>`; no resource. |
| `~/.claude.json` missing | No user or local MCP entries; no diagnostic. |
| `~/.claude.json` not a JSON object, or its `projects` / `mcpServers` not an object | One `error` diagnostic; nothing from that value. |
| A catalog server name that normalises to an empty id | Entry dropped; `error` diagnostic `yields no usable id`. |
| Two entries map to one id | First wins; later catalog entry dropped with a `warn` shadowing diagnostic. A configured `mcp.servers` entry always wins. |
| `${NAME}` unset with no default | Entry dropped; `error` diagnostic `${NAME} is not set`. |
| An `sse` catalog entry | Entry dropped; `warn` diagnostic `transport sse is not supported`. |
| A server that fails to connect in chat | One attempt; the session opens without its tools; `/mcp` shows `failed: <reason>`. |
| A server tool absent from the lock or with a changed schema | Withheld (existing lock behaviour); `/mcp` shows the withheld count and `run nax mcp lock`. |
| The MCP pool close rejects at chat teardown | The plugin registry still tears down. |
| `createChatMcp` throws at chat start | The plugin registry is torn down and the error reaches `chatCommand` (exit 1, message on stderr). |
| `resources.claudeCode` false | `nax mcp lock` and the `nax run` opt-in see configured servers only. |
| A tool the lock withholds again after a session reopen | `withheld()` lists it once. |
| A catalog server with no lock entry | Not connected, not attached (chat and `mcpInRun`); `/mcp` shows `not locked (run nax mcp lock)`. |
| A server marks a tool `readOnlyHint: true` that the lock does not list as read-only | The tool asks in guarded mode until `nax mcp lock` is re-run. |
| A lock whose `readOnly` is malformed | Read as no read-only tools; every MCP tool asks in guarded mode. |
| An HTTP server fails to connect with its url or a header value in the error | The recorded and logged reason has userinfo, query and header values removed. |
| A server whose id is `nax-skills` in chat | Not attached; `error` diagnostic `mcp server id nax-skills is reserved`. |

## Out of Scope

- F5b `chat-subagents` delivers subagents, the `Agent` tool, `/agents` and `agent.modelAliases`; this feature leaves `/plugins` printing `agents N (not delivered yet)`.
- SSE MCP transport is not supported anywhere; an `sse` catalog entry is listed as a diagnostic and dropped.
- OAuth for remote MCP servers is not supported; an HTTP server gets only its static `headers`.
- Claude Code's per-server approval settings for project `.mcp.json` servers (`enableAllProjectMcpServers`, `enabledMcpjsonServers`, `disabledMcpjsonServers` in `settings.json` / `settings.local.json`) are not read; the nax trust gate plus the MCP lock replace them.
- MCP servers declared inside a Claude Code plugin's `plugin.json` (`mcpServers` field) are not read; only the plugin's `.mcp.json` is.
- MCP resources, prompts and sampling are not supported; only tools.
- Per-project enable or disable lists that Claude Code keeps in `~/.claude.json` (for example `disabledMcpServers`, `enabledMcpjsonServers`, `disabledMcpjsonServers` under `projects[<repo>]`) are not read; only `mcpServers` is.
- Configured `mcp.servers` entries get no `${VAR}` expansion; an HTTP server configured there carries its headers literally, and the existing config secret scan still applies to them.
- A global lock (`nax mcp lock --global`) approves catalog servers by id for every project on the machine, exactly as it does for configured servers; a different repo's server with the same id is treated as approved.
- Configured `mcp.servers` entries (global or project `.nax/config.json`) are not gated on the lock at connect time; only their tools are, as today.
- The interactive system prompt does not list MCP tools beyond what the tool list and each server's own instructions (the existing provider-instructions path) already carry.
- A per-server enable or disable toggle inside chat is not added; `mcp.servers.<id>.enabled` and removing the catalog entry are the switches.
- MCP servers are not hot-reloaded; a changed `.mcp.json` or `~/.claude.json` takes effect at the next `nax chat` start.
- Catalog MCP servers do not attach to `nax run` unless `resources.mcpInRun` is true (user ruling 2026-10-25).
- With `resources.mcpInRun` true, the end-of-run MCP adoption rollup (`summarizeMcpAdoptionPhase`, which reads the run's original `config.mcp`) still covers configured servers only; catalog servers are attached but absent from `mcpAdoption` and its zero-adoption warning.
- The design doc `docs/superpowers/specs/2026-10-24-nax-interactive-tui-slice1-design.md` §4.5/§5.1 update for the F5a/F5b split is committed by hand with this spec, not by a story.
- Updating `.nax/mono/packages/nax/context.md` and `.nax/mono/packages/nax-agent/context.md` for chat MCP and `askTools`, then running `nax generate`, is a manual step after merge; `.nax/` is read-only to the run.
- No release and no version bump.

## Stories

Paths below are repo-relative. Nine stories, one capability: MCP servers from config and
from the Claude Code catalog reach `nax chat`. The count grew from six to nine when
spec-review pass 1 counted assertions against the 24-AC cap and split three stories; the
feature is still one capability (the user split subagents out as F5b on 2026-10-25).
US-001 is the nax-agent seam; US-002 is nax's MCP layer; US-003 to US-006 make a catalog
entry into a connectable `McpServerConfig`; US-007 and US-008 wire chat; US-009 is the lock
command and the `nax run` opt-in.

### US-001 — nax-agent: MCP read-only hints, discovered providers on sessions, guarded asks

Workdir: packages/nax-agent. No dependencies.

- Add `McpToolInfo.readOnly` from `annotations.readOnlyHint` in `toolInfo`, `ProviderTool.readOnly`, and `ResolvedProviderTools.askTools`; let `nativeBackend` accept `discovered` providers; under the `ask` profile, ask before every `askTools` call (Design §Approach 1).

### US-002 — nax MCP layer: HTTP transport and the read-only hint

Workdir: packages/nax. Depends on US-001.

- Add `McpToolDescriptor.readOnly` and `McpLockFile.readOnly`, and carry the hint into each `ProviderTool` in `createMcpProviders` only when the lock lists it; redact HTTP connect-failure reasons in the pool; make `command` optional and add `url` and `headers` to `McpServerSchema` / `McpServerConfig` with an exactly-one refinement; build an `http` transport in `connectMcpServer` and the pool; fix the lock command's hint; add the config descriptions (Design §Approach 2).

### US-003 — Catalog MCP entries keep their connection spec

Workdir: packages/nax. No dependencies.

- Add `McpServerSpec`, `McpServerScope` and the `scope` / `server` fields to `McpServerResource`; add the `scope` parameter to `parseMcpJson` and the shared `parseMcpServers`; parse stdio, http and sse specs; pass scope `project` or `plugin` from `claude-sources.ts` (Design §Approach 3).

### US-004 — `~/.claude.json` user and local scopes; `/plugins` wording

Workdir: packages/nax. Depends on US-003.

- Add `claudeJsonPath`; read `~/.claude.json` in `discoverClaudeCodePackages` (user scope into the user package, local scope ahead of `.mcp.json` in the project package); pass it from `loadResourceCatalog`; drop `(not delivered yet)` after the mcp count in `formatPluginsListing` (Design §Approach 3).

### US-005 — MCP server ids and variable expansion

Workdir: packages/nax. No dependencies.

- Create `src/resources/mcp-expand.ts` with `expandMcpValue` and `mcpServerId`, exported from the resources barrel (Design §Approach 4).

### US-006 — Merge catalog MCP entries into `McpConfig`

Workdir: packages/nax. Depends on US-002, US-004, US-005.

- Create `src/resources/mcp-merge.ts` with `mergeCatalogMcpServers`, `MergedMcpServers` and `McpServerSource`; export `MCP_DEFAULT_TIMEOUT_MS` and `MCP_SERVER_ID_RE` from the `@/config` barrel (Design §Approach 4).

### US-007 — Chat: MCP providers and teardown

Workdir: packages/nax. Depends on US-001, US-006.

- Create `src/chat/chat-mcp.ts` (async `createChatMcp`, `_chatMcpDeps`, `CHAT_MCP_RETRY`, the state types, the reserved `nax-skills` id, no connection to a catalog server the lock does not list); add `_chatCommandDeps.createChatMcp` and `_chatCommandDeps.env`; wire it into `chatResources`; add `mcp` to `ChatResources` and `ChatHost`; export from `src/chat/index.ts` (Design §Approach 5).

### US-008 — Chat: `/mcp`

Workdir: packages/nax. Depends on US-007.

- Fill `createChatMcp`'s state (server rows, live `events()`, deduplicated `withheld()`, merge plus catalog MCP diagnostics); add `formatMcpListing` to `src/chat/chat-mcp.ts` and the `/mcp` built-in slash command after `/plugins` (Design §Approach 5).

### US-009 — `nax mcp lock` includes catalog servers; `resources.mcpInRun`

Workdir: packages/nax. Depends on US-006.

- Add `resources.mcpInRun` and `resolveCatalogMcpConfig` (with `lockedOnly`); lock catalog servers and record read-only tools in `runMcpLockCommand` through `_mcpLockCommandDeps` (project lock and `--global`); serialise `readOnly` in `writeMcpLockAt`; add `_runSetupDeps.readMcpLock`; merge catalog servers into the runtime config in `setupRun` when `mcpInRun` is true (Design §Approach 6).

### Context Files

**US-001**
- `packages/nax-agent/src/mcp/types.ts`
- `packages/nax-agent/src/tools/provider-types.ts`
- `packages/nax-agent/src/tools/provider-advertise.ts`
- `packages/nax-agent/src/session/native-backend-options.ts`
- `packages/nax-agent/src/session/session-tool-support.ts`

**US-002**
- `packages/nax/src/mcp/types.ts`
- `packages/nax/src/mcp/provider.ts`
- `packages/nax/src/config/schemas-mcp.ts`
- `packages/nax/src/mcp/client.ts`
- `packages/nax/src/mcp/pool.ts`

**US-003**
- `packages/nax/src/resources/types.ts`
- `packages/nax/src/resources/parse-mcp.ts`
- `packages/nax/src/resources/claude-sources.ts`
- `packages/nax/test/unit/resources/parse-mcp.test.ts`

**US-004**
- `packages/nax/src/resources/claude-sources.ts`
- `packages/nax/src/resources/claude-paths.ts`
- `packages/nax/src/resources/catalog.ts`
- `packages/nax/src/resources/listing.ts`
- `packages/nax/test/unit/resources/claude-sources.test.ts`

**US-005**
- `packages/nax/src/config/schemas-mcp.ts`
- `packages/nax/src/resources/index.ts`

**US-006**
- `packages/nax/src/resources/types.ts`
- `packages/nax/src/resources/catalog.ts`
- `packages/nax/src/resources/mcp-expand.ts` — created by US-005, consumed here
- `packages/nax/src/config/index.ts`
- `packages/nax/src/config/runtime-types-mcp.ts`

**US-007**
- `packages/nax/src/cli/chat.ts`
- `packages/nax/src/chat/resources.ts`
- `packages/nax/src/chat/chat-host.ts`
- `packages/nax/src/mcp/provider.ts`
- `packages/nax/src/resources/mcp-merge.ts` — created by US-006, consumed here

**US-008**
- `packages/nax/src/chat/chat-mcp.ts` — created by US-007, extended here
- `packages/nax/src/tui/chat/slash-commands.ts`
- `packages/nax/src/mcp/pool.ts`
- `packages/nax/test/ui/chat/slash-commands.test.tsx`

**US-009**
- `packages/nax/src/cli/mcp.ts`
- `packages/nax/src/config/schemas-resources.ts`
- `packages/nax/src/execution/lifecycle/run-setup.ts`
- `packages/nax/src/resources/mcp-merge.ts` — created by US-006, extended here

### Creates

**US-001**
None. Changes to existing files only.

**US-002**
None. Changes to existing files only.

**US-003**
None. Changes to existing files only.

**US-004**
None. Changes to existing files only.

**US-005**
- `packages/nax/src/resources/mcp-expand.ts`
- `packages/nax/test/unit/resources/mcp-expand.test.ts`

**US-006**
- `packages/nax/src/resources/mcp-merge.ts`
- `packages/nax/test/unit/resources/mcp-merge.test.ts`

**US-007**
- `packages/nax/src/chat/chat-mcp.ts`
- `packages/nax/test/unit/chat/chat-mcp.test.ts`

**US-008**
- `packages/nax/test/unit/chat/chat-mcp-listing.test.ts`

**US-009**
- `packages/nax/test/unit/cli/mcp-lock.test.ts`
- `packages/nax/test/unit/execution/lifecycle/run-setup-mcp-in-run.test.ts`

### Modifies

**US-001**
- `packages/nax-agent/test/unit/session/native-backend-providers.test.ts` — the case "AC-10: discovered providers are rejected at construction with the providers path" asserted that nativeBackend throws for kind "discovered"; it now asserts nativeBackend constructs without throwing for a discovered provider, and the malformed-provider case (AC-11) keeps asserting AGENT_SESSION_INVALID_OPTIONS.

**US-002**
- `packages/nax/test/unit/config/schemas-mcp.test.ts` — the default-shape case that parses a server with only command "x" and compares the full parsed server gains headers {} in its expected object; every rejection case (empty command, unknown stage, bad id, unknown key) keeps its verdict.

**US-003**
- `packages/nax/test/unit/resources/parse-mcp.test.ts` — every parseMcpJson call gains the scope argument "project"; the table cases compare whole resources with toEqual, so each expected resource gains scope "project" and its server spec (stdio case: transport stdio, command npx, args ["x"], env {}; http case: transport http, url https://h, headers {}); the case "sse wins over command" changes its entry to type sse with url https://s because an sse entry now needs a url; the invariant is that the transport each entry resolves to is unchanged.
- `packages/nax/test/unit/resources/listing.test.ts` — the fixture package's mcpServers literal is typed McpServerResource, so it gains scope "plugin" and server (transport stdio, command x, args [], env {}); no expected text changes in this story.

**US-004**
- `packages/nax/test/unit/resources/listing.test.ts` — the expected /plugins text for package sp@m changes "mcp 1 (not delivered yet)" to "mcp 1"; agents and hooks wording is unchanged.
- `packages/nax/test/unit/resources/claude-sources.test.ts` — discoverClaudeCodePackages now requires claudeJson, so the file's discover helper passes a claudeJson path to a missing file inside the fixture; every existing expectation (which assumes no ~/.claude.json) stays true.

**US-005**
None. New files plus barrel exports in `src/resources/index.ts`; no test pins that barrel's export list.

**US-006**
None. New files plus barrel exports in `src/resources/index.ts` and `src/config/index.ts`; no test pins either barrel's export list.

**US-007**
- `packages/nax/test/unit/cli/chat-resources.test.ts` — its _chatCommandDeps fakes gain createChatMcp resolving to a state with no servers, no diagnostics, empty events() and withheld(), no providers and a resolving close(), plus env pointing CLAUDE_CONFIG_DIR at an empty temp dir, so the existing case asserting toolProviders[0]?.id is nax-skills stays true.
- `packages/nax/test/unit/cli/chat.test.ts` — its _chatCommandDeps fakes gain the same createChatMcp stub and env so every existing compose case still reaches createChatHost; the invariant is that every existing case keeps its asserted behaviour.

**US-008**
- `packages/nax/test/ui/chat/slash-commands.test.tsx` — the file's COMMANDS list (used by "AC-16 help lists every command" as one contiguous run, and by "AC-19 blocks /%s during turn") gains "mcp" between "plugins" and "quit"; AC-19 then also covers /mcp, which is blocked during a turn like every other built-in.

**US-009**
- `packages/nax/test/unit/config/schemas-resources.test.ts` — the cases "AC-1 defaults to Claude Code on and run skills off" and "AC-3 defaults claudeCode on when skillsInRun is enabled" compare the whole resources object with toEqual; each expected object gains mcpInRun false.
- `packages/nax/test/unit/resources/catalog.test.ts` — its load helper's config parameter type is the full resources shape, so the helper type and both resources literals (cases AC-10 and AC-11) gain mcpInRun false; the asserted catalogs are unchanged.
- `packages/nax/test/integration/mcp/stdio-server.test.ts` — the case that calls runMcpLockCommand(dir) now also loads the Claude Code catalog, so it points the lock command's env seam (or CLAUDE_CONFIG_DIR, restored after the case) at an empty temp dir; the asserted lock contents are unchanged and the developer's real ~/.claude.json and plugins are never connected.
- `packages/nax/test/integration/cli/cli-mcp-global-lock.test.ts` — every runMcpLockCommand case points the lock command's env seam (or CLAUDE_CONFIG_DIR, restored after each case) at an empty temp dir, for the same reason; the asserted global and project lock contents are unchanged.

### Seams

- US-001 -> US-007: `discovered` providers on `nativeBackend`; US-007 asserts, through `createChatHost({ ..., resources })` built without an `open` override and `start({ mode: "guarded", model })`, with `_openChatSessionDeps.nativeBackend` stubbed to capture its options, that the captured `toolProviders` contain a provider whose `kind` is `discovered` and whose id is the fixture server id.
- US-001 -> US-002: `ProviderTool.readOnly`; US-002 asserts `createMcpProviders` over a fake pool listing a tool with `readOnly: true` yields a provider tool whose `readOnly` is `true`, and US-002 asserts, through `resolveProviderTools` over that provider, that the tool is absent from `askTools`.
- US-002 -> US-006: `McpServerConfig` with `url` / `headers`; US-006 asserts a merged http entry passes `McpConfigSchema.safeParse`.
- US-003, US-004 -> US-006: `McpServerResource.server` and `scope`; US-006 asserts, through `mergeCatalogMcpServers` over a catalog built by `buildResourceCatalog`, the merged command and source.
- US-005 -> US-006: `expandMcpValue` and `mcpServerId`; US-006 asserts an expanded argument and a normalised id in the merged config.
- US-006 -> US-007: `mergeCatalogMcpServers`; US-007 asserts, through `chatCommand` with `_chatCommandDeps.env` pointing `CLAUDE_CONFIG_DIR` at a fixture whose `.claude.json` holds one user-scope stdio server `docs`, the real `loadResourceCatalog` and the real `createChatMcp` with `_chatMcpDeps.readLock` returning a lock that lists `docs` and `_chatMcpDeps.createMcpPool` stubbed to capture its options, that the pool receives a server `docs` whose `stages` is `["*"]`.
- US-007 -> US-008: `host.mcp`; US-008 asserts, through `runSlashCommand` for `/mcp` with a host whose `mcp` is a fixture state, that `show` receives that state's server line.
- US-006 -> US-009: `mergeCatalogMcpServers`; US-009 asserts, through `runMcpLockCommand(workdir)` with `_mcpLockCommandDeps.createMcpPool` stubbed and a fixture `.mcp.json`, that the written lock contains the catalog server id, and, through `setupRun` with `resources.mcpInRun: true`, `_runSetupDeps.readMcpLock` returning a lock that lists the catalog server and `_runSetupDeps.createRuntime` stubbed, that the config `createRuntime` receives contains the catalog server.

## Acceptance Criteria

### US-001 — nax-agent: MCP read-only hints, discovered providers on sessions, guarded asks

- [unit] `connectMcp` against an in-memory server that lists tool `get` with `annotations: { readOnlyHint: true }` yields `connection.tools[0].readOnly` equal to `true`.
- [unit] `connectMcp` against a server that lists tool `put` with `annotations: { readOnlyHint: false }` yields a `connection.tools[0]` with no `readOnly` key.
- [unit] `connectMcp` against a server that lists tool `put` with `annotations: { readOnlyHint: "yes" }` yields a `connection.tools[0]` with no `readOnly` key.
- [unit] `connectMcp` against a server that lists a tool with no `annotations` yields a tool object equal to `{ name, description, inputSchema }`.
- [unit] `sanitizeProviderTools("discovered", [tool])` for a tool with `readOnly: true` returns a tool whose `readOnly` is `true`.
- [unit] `resolveProviderTools([provider], "session", workdir)` for a `discovered` provider `acme` whose tools are `get` (`readOnly: true`) and `put` (no `readOnly`) returns `askTools` equal to `["acme__put"]`.
- [unit] `resolveProviderTools` for a `discovered` provider whose only tool has `readOnly: true` returns a result with no `askTools` key.
- [unit] `resolveProviderTools` for a `static` provider whose tool has no `readOnly` returns a result with no `askTools` key.
- [unit] `nativeBackend({ model, toolProviders: [provider] })` with a provider of `kind: "discovered"` returns a backend without throwing.
- [unit] `nativeBackend({ model, toolProviders: [{ id: "x", kind: "other", stages: ["*"], tools: async () => [] }] })` throws `AgentSessionError` with code `AGENT_SESSION_INVALID_OPTIONS`.
- [unit] Opening a native backend with profile `read` and the discovered provider `acme` yields `codingTools` names containing `acme__put`.
- [unit] Opening with profile `ask`, the discovered provider `acme` and an ask port whose `emit` records events and whose `turn` returns a turn id, a `coding-tool` interaction for `acme__put` emits an `approval_requested` event whose `tool` is `acme__put`.
- [unit] In that `ask`-profile session, the `acme__put` tool's `run` has not been invoked when the `approval_requested` event is emitted.
- [unit] In that `ask`-profile session, a `coding-tool` interaction for `acme__get` invokes `get`'s `run`.
- [unit] In that `ask`-profile session, a `coding-tool` interaction for `acme__get` emits no `approval_requested` event.
- [unit] Opening with profile `full` and the discovered provider `acme`, a `coding-tool` interaction for `acme__put` emits no `approval_requested` event.
- [unit] Opening with profile `ask` and a `static` provider `skills` with tool `load`, a `coding-tool` interaction for `skills__load` emits no `approval_requested` event.

### US-002 — nax MCP layer: HTTP transport and the read-only hint

- [unit] `createMcpProviders` for server `docs` over a fake pool whose `listTools` returns tool `get` with `readOnly: true`, and a lock that pins `get` and lists it under `readOnly.docs`, yields a provider whose `tools("/w")` result has `readOnly` `true` for `get`.
- [unit] `createMcpProviders` for server `docs` whose tool `get` has `readOnly: true` but whose lock pins `get` with no `readOnly` entry yields a provider tool `get` with no `readOnly` key.
- [unit] `createMcpProviders` for server `docs` whose lock lists `put` under `readOnly.docs` but whose live tool `put` has no `readOnly` yields a provider tool `put` with no `readOnly` key.
- [unit] `createMcpProviders` with a lock whose `readOnly` is the string `"x"` yields provider tools with no `readOnly` key.
- [unit] `createMcpProviders` over a fake pool whose tool `put` has no `readOnly` yields a provider tool with no `readOnly` key.
- [unit] `resolveProviderTools` over that `createMcpProviders` provider (id `docs`, tools `get` read-only in both the live hint and the lock, and `put`) returns `askTools` equal to `["docs__put"]`.
- [unit] `McpConfigSchema.parse({ servers: { a: { url: "https://h/mcp" } } }).servers.a.url` is `https://h/mcp`.
- [unit] `McpConfigSchema.parse({ servers: { a: { url: "https://h/mcp" } } }).servers.a.headers` equals `{}`.
- [unit] `McpConfigSchema.parse({ servers: { a: { url: "https://h/mcp", headers: { Authorization: "Bearer t" } } } }).servers.a.headers.Authorization` is `Bearer t`.
- [unit] `McpConfigSchema.safeParse({ servers: { a: { command: "x", url: "https://h" } } })` fails with an issue message `set exactly one of command or url`.
- [unit] `McpConfigSchema.safeParse({ servers: { a: { args: ["x"] } } })` fails with an issue message `set exactly one of command or url`.
- [unit] `McpConfigSchema.safeParse({ servers: { a: { url: "not a url" } } }).success` is `false`.
- [unit] `McpConfigSchema.parse({ servers: { a: { command: "x" } } }).servers.a.headers` equals `{}`.
- [unit] `connectMcpServer({ serverId: "a", workdir: "/w", url: "https://h/mcp", headers: { k: "v" }, args: [], env: {}, connectTimeoutMs })` calls `_mcpClientDeps.connect` with config `{ kind: "http", url: "https://h/mcp", headers: { k: "v" } }`.
- [unit] `connectMcpServer` with `command: "fake"` and no `url` calls `_mcpClientDeps.connect` with config `{ kind: "stdio", command: "fake", args: [], env: {}, cwd: "/w" }`.
- [unit] A pool over server `a` with `url` `https://h/mcp` connecting `a` passes `url` `https://h/mcp` to the client connect seam.
- [unit] A pool connection to an HTTP server whose connection `pid` is null records a `connected` event with `pid` null.
- [unit] A pool connection to an HTTP server never calls the pid registry's `register`.
- [unit] `runMcpLockCommand` for an enabled HTTP server that advertises no tools prints a hint containing the server's url.
- [unit] A pool over HTTP server `a` with `url` `https://u:p@h/mcp?key=s3cret`, whose connect seam rejects with a message containing that url, records a `connect-failed` event whose `reason` does not include `s3cret`.
- [unit] In that case the recorded `reason` does not include `u:p@`.
- [unit] A pool over HTTP server `a` with `headers` `{ Authorization: "Bearer tok123" }`, whose connect seam rejects with a message containing `Bearer tok123`, records a `connect-failed` event whose `reason` does not include `tok123`.

### US-003 — Catalog MCP entries keep their connection spec

- [unit] `parseMcpJson(path, '{"mcpServers":{"ctx":{"command":"npx","args":["x"],"env":{"K":"v"}}}}', origin, "project")` returns one resource whose `server` equals `{ transport: "stdio", command: "npx", args: ["x"], env: { K: "v" } }`.
- [unit] That resource's `scope` is `project`.
- [unit] `parseMcpJson` for `{"mcpServers":{"ctx":{"command":"npx"}}}` returns a resource whose `server.args` equals `[]`.
- [unit] `parseMcpJson` for `{"mcpServers":{"ctx":{"command":"npx"}}}` returns a resource whose `server.env` equals `{}`.
- [unit] `parseMcpJson` for `{"mcpServers":{"r":{"type":"http","url":"https://h","headers":{"A":"b"}}}}` returns a resource whose `server` equals `{ transport: "http", url: "https://h", headers: { A: "b" } }`.
- [unit] `parseMcpJson` for `{"mcpServers":{"r":{"type":"http","url":"https://h"}}}` returns a resource whose `server.headers` equals `{}`.
- [unit] `parseMcpJson` for `{"mcpServers":{"s":{"type":"sse","url":"https://s"}}}` returns a resource whose `transport` is `sse`.
- [unit] `parseMcpJson` for `{"mcpServers":{"r":{"type":"http"}}}` returns no resource.
- [unit] `parseMcpJson` for `{"mcpServers":{"r":{"type":"http"}}}` returns one `warn` diagnostic containing `Unsupported MCP entry r`.
- [unit] `parseMcpJson` for `{"mcpServers":{"c":{"command":"npx","args":"x"}}}` returns one `warn` diagnostic containing `Unsupported MCP entry c` and no resource.
- [unit] `parseMcpJson` for `{"mcpServers":{"c":{"command":"npx","env":{"K":1}}}}` returns one `warn` diagnostic containing `Unsupported MCP entry c` and no resource.
- [unit] `parseMcpServers(path, { ctx: { command: "npx" } }, origin, "user")` returns one resource whose `scope` is `user`.
- [unit] `discoverClaudeCodePackages` over a repo `.mcp.json` holding stdio server `ctx` returns a project package whose `ctx` entry has `scope` `project`.
- [unit] An enabled plugin's `.mcp.json` entry is returned in that plugin package with `scope` `plugin`.

### US-004 — `~/.claude.json` user and local scopes; `/plugins` wording

- [unit] `claudeJsonPath({ CLAUDE_CONFIG_DIR: "/c" })` returns `/c/.claude.json`.
- [unit] `claudeJsonPath({})` with `_claudePathsDeps.homedir` returning `/home/u` returns `/home/u/.claude.json`.
- [unit] `discoverClaudeCodePackages` with a `claudeJson` fixture whose top-level `mcpServers` holds stdio server `docs` returns a user package (`id` `claude-user`) whose `mcpServers` names include `docs`.
- [unit] In that result the `docs` entry has `scope` `user`.
- [unit] In that result the `docs` entry's `path` is the `claudeJson` path.
- [unit] `discoverClaudeCodePackages` with a `claudeJson` fixture whose `projects[<repoRoot>].mcpServers` holds `local1`, and a repo `.mcp.json` holding `proj1`, returns a project package whose `mcpServers` names are `["local1", "proj1"]` in that order.
- [unit] In that result `local1` has `scope` `local`.
- [unit] In that result `local1` has origin kind `claude-project`.
- [unit] `discoverClaudeCodePackages` with a `claudeJson` fixture whose `projects` key is a different path returns a project package with no MCP entry from that path.
- [unit] `discoverClaudeCodePackages` with `claudeJson` pointing at a missing file returns no diagnostic whose `path` is that file.
- [unit] `discoverClaudeCodePackages` with a `claudeJson` file holding `[]` returns a user package with one `error` diagnostic whose `path` is the `claudeJson` path.
- [unit] `discoverClaudeCodePackages` with a `claudeJson` file whose `mcpServers` is `"x"` returns a user package with no MCP entry.
- [unit] `discoverClaudeCodePackages` with a `claudeJson` file whose `mcpServers` is `"x"` returns a user package with one `error` diagnostic whose `path` is the `claudeJson` path.
- [unit] `loadResourceCatalog({ repoRoot, config, env: { CLAUDE_CONFIG_DIR: dir }, naxPluginPackages: [] })` over a fixture `dir/.claude.json` with user server `docs` returns a catalog whose user package lists `docs`.
- [unit] `formatPluginsListing` for a plugin package with one MCP entry prints a line containing `mcp 1, hooks`.

### US-005 — MCP server ids and variable expansion

- [unit] `expandMcpValue("${HOME}/bin", { HOME: "/h" })` returns `{ value: "/h/bin" }`.
- [unit] `expandMcpValue("${PORT:-8080}", {})` returns `{ value: "8080" }`.
- [unit] `expandMcpValue("${PORT:-8080}", { PORT: "9" })` returns `{ value: "9" }`.
- [unit] `expandMcpValue("${PORT:-8080}", { PORT: "" })` returns `{ value: "8080" }`.
- [unit] `expandMcpValue("${EMPTY}x", { EMPTY: "" })` returns `{ value: "x" }`.
- [unit] `expandMcpValue("$HOME and ${1X}", {})` returns `{ value: "$HOME and ${1X}" }`.
- [unit] `expandMcpValue("${A:-}x", {})` returns `{ value: "x" }`.
- [unit] `expandMcpValue("${MISSING}", {})` returns `{ missing: "MISSING" }`.
- [unit] `expandMcpValue("${A}-${B}", { A: "1" })` returns `{ missing: "B" }`.
- [unit] `mcpServerId("Codebase Memory.MCP")` returns `codebase-memory-mcp`.
- [unit] `mcpServerId("a__b")` returns `a_b`.
- [unit] `mcpServerId("--x")` returns `x`.
- [unit] `mcpServerId("!!!")` returns an empty string.
- [unit] For every input in `["Codebase Memory.MCP", "a__b", "--x", "chrome-devtools"]`, the result of `mcpServerId` matches `MCP_SERVER_ID_RE`.

### US-006 — Merge catalog MCP entries into `McpConfig`

- [unit] `mergeCatalogMcpServers` over a catalog whose project package has stdio server `ctx` (`command` `npx`, `args` `["${ROOT}/s"]`) with `env: { ROOT: "/r" }` returns `config.servers.ctx.args` equal to `["/r/s"]`.
- [unit] In that result `config.servers.ctx.stages` equals `["*"]`.
- [unit] In that result `config.servers.ctx.timeoutMs` equals `MCP_DEFAULT_TIMEOUT_MS`.
- [unit] In that result `sources.get("ctx")` equals `{ source: "project" }`.
- [unit] `mergeCatalogMcpServers` with `mcp.servers.ctx` configured as `command: "mine"` and a catalog server `ctx` keeps `config.servers.ctx.command` equal to `mine`.
- [unit] In that case `diagnostics` contains one `warn` diagnostic whose message contains `mcp server ctx` and `is shadowed by config`.
- [unit] `mergeCatalogMcpServers` with a configured server whose `args` contain `${HOME}` keeps that argument literally.
- [unit] `mergeCatalogMcpServers` with a `local` entry `ctx` and a `project` entry `ctx` in the same project package keeps the `local` entry's command.
- [unit] A `claude-plugin` entry `server` from plugin `chrome` whose `command` is `${CLAUDE_PLUGIN_ROOT}/bin/run` and package `root` `/p` merges as `config.servers["chrome-server"].command` equal to `/p/bin/run`.
- [unit] That plugin entry's `sources.get("chrome-server")` equals `{ source: "plugin", plugin: "chrome" }`.
- [unit] A `claude-plugin` entry expands `${CLAUDE_PLUGIN_ROOT}` to the package root even when `env.CLAUDE_PLUGIN_ROOT` is `/elsewhere`.
- [unit] With plugin package `a` (entry `b-c`) before plugin package `a-b` (entry `c`), both mapping to id `a-b-c`, `diagnostics` holds a `warn` whose message contains `is shadowed by plugin a`.
- [unit] An http catalog entry `r` with `url` `https://h/${P}` and `headers` `{ A: "${T}" }` under `env: { P: "mcp", T: "tok" }` merges with `config.servers.r.url` equal to `https://h/mcp`.
- [unit] In that result `config.servers.r.headers.A` is `tok`.
- [unit] In that result `McpConfigSchema.safeParse({ servers: { r: config.servers.r } }).success` is `true`.
- [unit] A catalog entry whose `env` value is `${NOPE}` with `NOPE` unset is absent from `config.servers`.
- [unit] In that case `diagnostics` holds an `error` whose message contains `${NOPE} is not set`.
- [unit] An `sse` catalog entry `s` is absent from `config.servers`, and `diagnostics` holds a `warn` whose message contains `mcp server s: transport sse is not supported`.
- [unit] A catalog entry named `!!!` is absent from `config.servers`, and `diagnostics` holds an `error` whose message contains `yields no usable id`.
- [unit] `mergeCatalogMcpServers` with `mcp` undefined and an empty catalog returns `config.servers` equal to `{}`.

### US-007 — Chat: MCP providers and teardown

- [unit] `createChatMcp` with `config.mcp.servers.docs` (`command` `docs-mcp`, `stages` `["run"]`) and an empty catalog creates a pool through `_chatMcpDeps.createMcpPool` whose `servers.docs.stages` equals `["*"]`.
- [unit] That pool is created with `retry` equal to `CHAT_MCP_RETRY`.
- [unit] `CHAT_MCP_RETRY.maxAttempts` is `1`.
- [unit] `createChatMcp` with `config.mcp.servers.off` having `enabled: false` returns no provider with id `off`.
- [unit] `createChatMcp` with one enabled server `docs` returns one provider with id `docs`.
- [unit] That provider's `kind` is `discovered`.
- [unit] `createChatMcp` with no enabled server returns `providers` equal to `[]`.
- [unit] `createChatMcp` with no enabled server never calls `_chatMcpDeps.createMcpPool`.
- [unit] `createChatMcp(...).close()` calls the pool's `close` once.
- [unit] `createChatMcp` with a project catalog server `ctx` and `_chatMcpDeps.readLock` returning a lock with no `ctx` entry returns no provider with id `ctx`.
- [unit] In that case the pool created through `_chatMcpDeps.createMcpPool` has no server `ctx`.
- [unit] `createChatMcp` with configured server `docs` and `_chatMcpDeps.readLock` returning `undefined` returns a provider with id `docs`.
- [unit] `createChatMcp` with a configured server `nax-skills` returns no provider with id `nax-skills`.
- [unit] In that case `state.diagnostics` holds an `error` whose message contains `mcp server id nax-skills is reserved`.
- [unit] `chatCommand` with a fake `createChatMcp` returning provider `docs` passes `createChatHost` resources whose `toolProviders` ids are `["nax-skills", "docs"]` in that order.
- [unit] `chatCommand` with `_chatCommandDeps.env` pointing `CLAUDE_CONFIG_DIR` at a fixture whose `.claude.json` holds user stdio server `docs`, the real `loadResourceCatalog` and the real `createChatMcp` with `_chatMcpDeps.readLock` returning a lock that lists `docs` and `_chatMcpDeps.createMcpPool` stubbed, creates the pool with a server `docs` whose `stages` equals `["*"]`.
- [unit] The chat resources' `teardown()` calls the MCP `close` before the plugin registry's `teardownAll`.
- [unit] When the MCP `close` rejects, `teardown()` still calls the plugin registry's `teardownAll`.
- [unit] When `createChatMcp` throws, `chatCommand` calls the plugin registry's `teardownAll`.
- [unit] When `createChatMcp` throws, `chatCommand` writes the error message to stderr.
- [unit] When `createChatMcp` throws, `chatCommand` sets exit code 1.
- [unit] `createChatHost({ ..., resources })` built without an `open` override, after `start({ mode: "guarded", model })` with `_openChatSessionDeps.nativeBackend` stubbed to capture its options, passes `toolProviders` containing a provider whose `kind` is `discovered` and id is the fixture server id.
- [unit] A host created with `resources.mcp` set exposes the same object as `host.mcp`.

### US-008 — Chat: `/mcp`

- [unit] `createChatMcp(...).state.withheld()` returns the entry passed to `createMcpProviders`' `onWithheld` for a tool the lock withheld.
- [unit] When `onWithheld` is called twice for server `docs` and tool `t` (two `tools()` calls), `state.withheld()` has length `1`.
- [unit] `createChatMcp(...).state.diagnostics` contains a catalog diagnostic whose `path` ends in `.claude.json`.
- [unit] `createChatMcp(...).state.diagnostics` contains a merge diagnostic for a shadowed server.
- [unit] `createChatMcp` with a configured server `remote` that has a `url` returns a `state.servers` row `{ id: "remote", source: "config", transport: "http" }`.
- [unit] `createChatMcp` with a configured server `docs` that has a `command` returns a `state.servers` row whose `transport` is `stdio`.
- [unit] `createChatMcp` with a plugin catalog server from plugin `chrome` returns a `state.servers` row whose `plugin` is `chrome`.
- [unit] `createChatMcp(...).state.events()` returns the events of the pool created through `_chatMcpDeps.createMcpPool`.
- [unit] `createChatMcp` with a project catalog server `ctx` that the lock does not list returns a `state.servers` row for `ctx` whose `locked` is `false`.
- [unit] `formatMcpListing` for a row with `locked: false` prints a line ending `not locked (run nax mcp lock)`.
- [unit] `formatMcpListing` for a state with server `docs` (source `user`, transport `stdio`) whose last pool event is `connected` with `toolCount` 3 prints the line `docs  user  stdio  connected, 3 tools`.
- [unit] `formatMcpListing` for a server whose last event is `connect-failed` with reason `spawn ENOENT` prints a line ending `failed: spawn ENOENT`.
- [unit] `formatMcpListing` for a server whose events are `connect-failed` then `connected` with `toolCount` 2 prints a line ending `connected, 2 tools`.
- [unit] `formatMcpListing` for a server with no pool event prints a line ending `not connected`.
- [unit] `formatMcpListing` for a connected server with two withheld tools prints a line ending `, 2 withheld (run nax mcp lock)`.
- [unit] `formatMcpListing` for a plugin server from plugin `chrome` prints the source label `plugin chrome`.
- [unit] `formatMcpListing` for a configured server prints the source label `config`.
- [unit] `formatMcpListing` for a state with one `warn` diagnostic at `/r/.mcp.json` with message `m` prints a line `warn  /r/.mcp.json  m`.
- [unit] `formatMcpListing(undefined)` prints `(no MCP servers)`.
- [unit] `formatMcpListing` for a state with no servers and no diagnostics prints `(no MCP servers)`.
- [unit] `runSlashCommand` for `/mcp` with a host whose `mcp` lists server `docs` calls `show` with text containing `docs`.
- [unit] `runSlashCommand` for `/mcp` with a host that has no `mcp` calls `show` with `(no MCP servers)`.
- [unit] Typing `/help` in `ChatApp` shows `/plugins` followed on the next line by `/mcp`.

### US-009 — `nax mcp lock` includes catalog servers; `resources.mcpInRun`

- [unit] `NaxConfigSchema.parse({}).resources.mcpInRun` is `false`.
- [unit] `NaxConfigSchema.safeParse({ resources: { mcpInRun: "yes" } }).success` is `false`.
- [unit] `resolveCatalogMcpConfig` with `resources.claudeCode` `false` never calls `load`.
- [unit] `resolveCatalogMcpConfig` with `resources.claudeCode` `false` returns `config.mcp`.
- [unit] `resolveCatalogMcpConfig` with a catalog holding project server `ctx` returns a config whose `servers.ctx` is defined.
- [unit] `resolveCatalogMcpConfig` logs each merge diagnostic at `warn` with stage `resources`.
- [unit] `runMcpLockCommand(workdir)` with a fixture `.mcp.json` holding server `ctx`, no configured servers, `_mcpLockCommandDeps.env` pointing `CLAUDE_CONFIG_DIR` at an empty dir, and `_mcpLockCommandDeps.createMcpPool` returning a pool that lists tool `t` for `ctx`, writes a project lock whose `servers.ctx.t` equals `schemaHash` of `t`'s input schema.
- [unit] `runMcpLockCommand(workdir)` for server `ctx` whose pool lists tool `r` with `readOnly: true` and tool `w` without writes a lock whose `readOnly.ctx` equals `["r"]`.
- [unit] `writeMcpLockAt(path, { version: 1, servers: { a: {} }, readOnly: { a: ["z", "b"] } })` writes JSON whose `readOnly.a` is `["b", "z"]`.
- [unit] `runMcpLockCommand(workdir, { global: true })` under the same fixtures and a temp global config dir writes a global lock whose `servers.ctx` is defined.
- [unit] `runMcpLockCommand(workdir)` with configured server `a` and catalog server `ctx` lists tools for both `a` and `ctx` through the pool.
- [unit] `setupRun` with `config.resources.mcpInRun` `true`, a catalog holding project server `ctx` (through `_runSetupDeps.loadResourceCatalog`) and `_runSetupDeps.readMcpLock` returning a lock that lists `ctx` calls `_runSetupDeps.createRuntime` with a config whose `mcp.servers.ctx` is defined.
- [unit] `setupRun` with `config.resources.mcpInRun` `true`, the same catalog and `_runSetupDeps.readMcpLock` returning a lock with no `ctx` entry calls `_runSetupDeps.createRuntime` with a config that has no `mcp.servers.ctx`.
- [unit] `setupRun` with `config.resources.mcpInRun` `false` calls `_runSetupDeps.createRuntime` with the same `config` object it was given.
- [unit] `setupRun` with `config.resources.mcpInRun` `false` never calls `_runSetupDeps.loadResourceCatalog`.
