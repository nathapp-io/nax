# SPEC: generic MCP memory provider

## Summary

Feature 5 of the nax memory slice (design `docs/superpowers/specs/2026-11-02-nax-memory-design.md`,
sections 6.4 and 8). Features 1, 2 and 4 (`memory-store` #2769, `memory-chat` #2771,
`memory-run-stages` #2772) shipped the mirror, the `local` provider, the memory host, the
`nax-memory` tools and the chat, CLI and run surfaces. This feature adds a second provider,
`memory.provider: "mcp"`, that backs the mirror with any MCP server exposing memory tools (the
defaults match OpenMemory: `search_memory`, `add_memories`):

- config: `memory.provider` accepts `"mcp"`; a new `memory.mcp` block names a server from
  `mcp.servers`, the tool names and the argument names; cross-section validation;
- an MCP memory provider: `pull` returns nothing (no cursor), `push` of a save calls the add tool
  (write-through), `push` of a forget calls an optional forget tool once per remote id, `search`
  calls the search tool, `reachable` asks whether the server is connected;
- the memory host picks the provider from config, merges the provider's search hits ahead of the
  local keyword hits, and gains a `close()` that releases the MCP connection;
- chat, `nax run` and `nax memory` close the host when they are done with it;
- the `nax-memory` tool instructions say which search hits are remote.

## Motivation

A project without koda can only keep memory in the local mirror on one machine. Many users already
run a memory server reachable over MCP (OpenMemory, mem0-compatible servers). The design's provider
seam was built for this: a generic MCP provider lets those servers hold nax's notes and answer
nax's searches, with configuration and no code per server. It is also the first provider that is
not always reachable, so it is the first real use of the outbox and the reachability probe that
feature 1 built and the local provider never exercises, and the first provider to implement the
seam's optional `search` (nothing calls `provider.search` today; this feature wires it into the host).

## Design

### Behaviour

`memory.provider: "mcp"` makes the host compose an MCP memory provider over one entry of
`mcp.servers`. The mirror stays the store every surface reads (design 6.2): the index, `get` and
local keyword search are unchanged. What the provider adds:

| Operation | MCP provider behaviour |
|---|---|
| `pull` | `{ notes: [], done: true }`. MCP memory tools expose no change cursor; nothing is faked (design call 3). |
| `push` save | calls the add tool with one argument, `{ [args.text]: "<slug>: <description>\n\n<body>" }`; resolves `{ id: note.id, status: "active" }`; the remote ids parsed from the result are recorded in the id map under the note's scope and slug. |
| `push` forget, `tools.forget` unset | no `call` and no `listTools`, whatever the server's state; drops the id-map entry; resolves `{ id: clientId, status: "deleted" }`. The remote copies stay. |
| `push` forget, `tools.forget` set, no recorded ids | no `call` and no `listTools`; resolves `{ id: clientId, status: "deleted" }` (there is nothing remote to delete). |
| `push` forget, `tools.forget` set, recorded ids | calls the forget tool once per recorded remote id with `{ [args.id]: <id> }`; drops the id-map entry; resolves `{ id: clientId, status: "deleted" }`. A per-id error is a warning, not a failure (best effort). |
| `search` | calls the search tool with `{ [args.query]: text }`; maps the parsed items to `MemoryHit`s; keeps at most `limit`. |
| `reachable` | `true` when the pool lists at least one tool for the server; `false` when it lists none or throws. |

The provider id is `mcp:<server>` (design 6.3), so `nax memory status` prints `provider: mcp:openmemory`.

`proposal` write mode is refused with provider `mcp` at config load: an MCP memory server has no
pending state, so a proposal could only be faked locally (user decision 2026-11-03).

### Config

```jsonc
"memory": {
  "provider": "mcp",
  "mcp": {
    "server": "openmemory",                                  // a key of mcp.servers
    "tools": {
      "search": "search_memory",                             // default
      "add": "add_memories",                                 // default
      "forget": "delete_memory"                              // optional; no default; server-specific
    },
    "args": {
      "query": "query",                                      // default
      "text": "text",                                        // default
      "id": "memory_id"                                      // no default; required when tools.forget is set
    }
  }
},
"mcp": { "servers": { "openmemory": { "url": "http://localhost:8765/mcp/nax/sse/me" } } }
```

`MemoryMcpConfigSchema` (new, in `src/config/schemas-memory.ts`) is `.strict()` like the rest of the
block: `server` matches `MCP_SERVER_ID_RE` and contains no `__` (the rules an `mcp.servers` key
already follows, `schemas-mcp.ts`); every tool name and argument name is a non-empty string.
`tools.search` defaults to `search_memory`, `tools.add` to `add_memories`, `args.query` to `query` and
`args.text` to `text` (OpenMemory's names, design 6.4). The `tools` and `args` objects themselves
default to `{}`, so `{ server: "om" }` parses to the full defaults. `tools.forget` and `args.id` have no default:
OpenMemory exposes no single-memory delete tool, so the forget tool and its id argument are whatever
the user's server provides. `memory.mcp` has no default and is absent from `NaxConfigSchema.parse({}).memory`.

Cross-section rules, in `validateMemoryProvider(data, ctx)` exported from `src/config/schemas-memory.ts`
and called from the `NaxConfigSchema` `superRefine` in `src/config/schemas.ts` (594 of 600 lines: the
import and the call are the only additions):

| Condition | Issue path | Message |
|---|---|---|
| `memory.provider` is `"mcp"` and `memory.mcp` is absent | `["memory", "mcp"]` | `memory.provider "mcp" needs a memory.mcp block naming the server` |
| `memory.mcp.server` is not a key of `mcp.servers` | `["memory", "mcp", "server"]` | `memory.mcp.server "<id>" is not defined in mcp.servers` |
| `memory.provider` is `"mcp"` and `memory.writeMode` is `"proposal"` | `["memory", "writeMode"]` | `memory.writeMode "proposal" needs a provider that holds pending writes; provider "mcp" does not` |
| `memory.mcp.tools.forget` is set and `memory.mcp.args.id` is absent | `["memory", "mcp", "args", "id"]` | `memory.mcp.args.id is required when memory.mcp.tools.forget is set` |

`NaxConfig.mcp` is optional on the hand-written interface; `validateMemoryProvider` treats an absent
`mcp` block as having no servers. The four rules are checked independently, so one config can raise
more than one issue. `schemas.ts` is at 594 of 600 lines, which leaves 6 lines of headroom; this
feature uses 2 of them.

A `memory.mcp` block with `provider: "local"` is valid and unused. The server's own `stages`,
`enabled` and `allowedTools` are not memory settings: `stages` decides whether chat or run sessions
also see the server's raw tools, and a disabled server makes the memory provider unreachable.

### Result parsing (`src/memory/mcp-results.ts`)

MCP tool results reach nax as text (`McpCallResult.content`). `parseMcpMemoryItems(text)` returns
`readonly McpMemoryItem[]` (`{ id?: string; text: string; score?: number }`):

1. the text is parsed as JSON; text that is not JSON yields `[]`;
2. a JSON array is the item list; an object with an array `results` is the item list; anything else yields `[]`;
3. per item: `text` is the first string-valued field among `memory`, `text`, `content`; an item with none is dropped; `id` is the item's `id` when it is a string; `score` is the item's `score` when it is a finite number.

`parseMcpMemoryIds(text)` returns the ids of an add result: the same JSON and item-list rules as
`parseMcpMemoryItems`, but every item whose `id` is a string contributes its id, with or without a
text field (an add answer such as `[{"id":"r1","event":"ADD"}]` carries no memory text). The save
push records ids through this function, never through `parseMcpMemoryItems`.

`mcpHitOf(item, index, scope)` maps one item to a `MemoryHit`:

| `MemoryHit` field | Value |
|---|---|
| `slug` | `mcp-` + the id lowercased with every character outside `[a-z0-9]` replaced by `-`, cut to 60 characters; `mcp-<index + 1>` when the item has no id |
| `scope` | the scope the search was asked for |
| `type` | `"reference"` |
| `status` | `"active"` |
| `description` | the first line of `text`, cut to `MCP_HIT_DESCRIPTION_MAX_CHARS` (160) characters |
| `snippet` | `text` cut to `MCP_HIT_SNIPPET_MAX_CHARS` (1000) characters |
| `score` | `score`, or `0` when absent |

### Id map (`src/memory/mcp-id-map.ts`)

A forget request carries only the slug, and under `direct` the note is already deleted from the
mirror when the provider is asked (`forgetLocked`, feature 1). So the provider keeps its own record
of the remote ids each save produced. `createMcpIdMap({ dirs, server })`, with `dirs: MemoryDirs`,
returns `{ ids(scope, slug), add(scope, slug, ids), drop(scope, slug) }` over one file per scope:
`<dirs.projectDir>/mcp-ids.json` for `"project"` and `<dirs.userDir>/mcp-ids.json` for `"user"`:

```json
{ "version": 1, "server": "openmemory", "notes": { "replay-budget": ["a1b2", "c3d4"] } }
```

- `add` appends ids not already recorded (a re-save of one slug adds to its list, so a later forget deletes every copy).
- A missing file, a file that is not valid JSON, a file whose `version` is not `1`, and a file whose `server` differs from the configured one all read as empty; the next `add` or `drop` rewrites the file for the configured server.
- Writes go to a temporary file in the same directory and are renamed into place.

### Host (`src/memory/host.ts`)

`composeMemory` chooses the provider:

- `provider: "local"` → `createLocalMemoryProvider(store)` (unchanged);
- `provider: "mcp"` → with `server = memory.mcp.server` and `serverConfig = config.mcp?.servers[server]` (present: config load guarantees it): `pool = _memoryHostDeps.createMcpPool({ servers: { [server]: serverConfig } })`, `idMap = _memoryHostDeps.createMcpIdMap({ dirs, server })` over the host's own `MemoryDirs`, then `_memoryHostDeps.createMcpMemoryProvider({ pool, serverId: server, workdir: repoRoot, mcp: memory.mcp, idMap, logger, callTimeoutMs: serverConfig.timeoutMs })`.

`MemoryHost` gains `close?(): Promise<void>`. `createMemoryHost` always sets it: it closes the MCP
pool when there is one and resolves otherwise; calling it twice is safe. It is optional on the
interface so hand-built hosts (test doubles) stay valid.

`host.search(query)`:

1. local hits as today (`searchMemoryNotes` over the mirror plus repo notes);
2. when `provider.search` exists and `query.scope` is `"project"` or absent, remote hits from `provider.search({ scope: "project", text, limit })`. An MCP search tool takes no scope, so its results are project memories, and a `scope: "user"` search asks no remote. The call is raced against `cancellableDelay(_memoryHostDeps.remoteSearchTimeoutMs)` (`@/utils/bun-deps`; default `MEMORY_OP_TIMEOUT_MS`), and the delay is cancelled when the race settles. A throw or a timeout is a `warn("memory", "memory remote search failed", { provider, error })` and no remote hits;
3. the result is the remote hits, then the local hits whose slug no remote hit has, cut to `query.limit`.

### Tool instructions

`buildMemoryToolInstructions(options?: { remoteServer?: string })` appends one line when
`remoteServer` is set: ``Search results whose slug starts with `mcp-` come from the memory server
`<server>`: the snippet is the whole memory, and `nax-memory__get` cannot read it.`` With no
argument the text is unchanged. `createMemoryToolProvider(host)` passes `remoteServer` when
`host.providerId` starts with `MEMORY_MCP_PROVIDER_PREFIX` (`"mcp:"`).

### Surfaces close the host

| Surface | Where | When |
|---|---|---|
| chat | `createHostMemory(...).closeSync()` (`src/chat/host-memory.ts`) | after its one sync, in a `finally`, so a sync failure still closes |
| `nax run` | `closeOnce` in `src/memory/run-memory.ts` | after the end sync and the summary line |
| `nax memory` | `withMemoryHost(context, deps, run)` (new, `src/cli/memory-cli-deps.ts`) opens the host through `openMemoryHost`, runs `run(host)` and awaits `host.close?.()` in a `finally`; the seven subcommands (`status`, `list`, `show`, `sync`, `save`, `forget`, `approve`) call it in place of `openMemoryHost` | after the command's output, on success and on failure |

A close that throws is a warning (chat, run) or ignored after the command's own result (CLI); it
never changes an exit code or a result.

### Integration

Read, unchanged:

- `MemoryProvider`, `MemoryWriteRequest`, `MemoryPushResult`, `MemoryPage` — `packages/nax-agent/src/memory/provider-types.ts`.
- `MemoryHit`, `MemoryNote`, `MemoryScope`, `MEMORY_OP_TIMEOUT_MS` — `packages/nax-agent/src/memory/types.ts`, exported from `@nathapp/nax-agent`.
- `isMemoryPushRejected`, `raceTimeout` — exported from `@nathapp/nax-agent`. A provider refuses a write permanently by throwing `NaxError` code `MEMORY_PUSH_REJECTED`; any other throw is retried by the outbox.
- `createMcpPool(opts: { servers; pidRegistry?; retry?; storyId? }): McpPool` and `McpPool.listTools(serverId, workdir)`, `McpPool.call(serverId, workdir, tool, input, { timeoutMs, maxBytes })`, `McpPool.close()` — `packages/nax/src/mcp/pool.ts`, from `@/mcp`. `call` never throws for an unavailable server: it answers `{ content, isError: true }`. The pool asserts the repository is trusted before it connects; an untrusted repository makes `listTools` and `call` reject.
- `McpServerConfig` — `packages/nax/src/config/runtime-types-mcp.ts`, from `@/config`; `MCP_SERVER_ID_RE` — `packages/nax/src/config/schemas-mcp.ts`.
- `cancellableDelay(ms, signal?)` — `packages/nax/src/utils/bun-deps.ts` (the pool's own deadline race uses it).
- `MemoryDirs` (`projectDir`, `userDir`) — `packages/nax/src/memory/paths.ts`.

Changed (baseline locates the code; the target is the interface to implement):

- `MemoryConfigSchema.provider` — Baseline: `z.enum(["local"]).default("local")`. Target: `z.enum(["local", "mcp"]).default("local")`, plus optional `mcp: MemoryMcpConfigSchema`.
- `MemoryConfig.provider` — Baseline: `provider: "local"`. Target: `provider: "local" | "mcp"`; new optional `mcp?: MemoryMcpConfig` with `server: string`, `tools: { search: string; add: string; forget?: string }`, `args: { query: string; text: string; id?: string }`.
- `MemoryHost` — Baseline: no `close`. Target: adds `close?(): Promise<void>`.
- `_memoryHostDeps` — Baseline: `memoryDirs`, `readRepoNotes`, `createMemoryStore`, `createMemoryOutbox`, `createLocalMemoryProvider`, `syncMemory`, `saveMemoryNote`, `forgetMemoryNote`, `approveMemoryNote`. Target: adds `createMcpPool`, `createMcpIdMap`, `createMcpMemoryProvider` and `remoteSearchTimeoutMs` (a number, default `MEMORY_OP_TIMEOUT_MS`).
- `openMemoryHost` call sites in `memoryStatusCommand`, `memoryListCommand` (`src/cli/memory.ts`), `memoryShowCommand`, `memorySyncCommand` (`src/cli/memory-read.ts`), `memorySaveCommand`, `memoryForgetCommand`, `memoryApproveCommand` (`src/cli/memory-write.ts`) — Baseline: `const host = await openMemoryHost(await memoryContext(opts.dir, deps), deps)` inside `withMemoryErrors`. Target: `return withMemoryHost(await memoryContext(opts.dir, deps), deps, async (host) => { ... })` inside `withMemoryErrors`, where `withMemoryHost(context: MemoryCliContext, deps: MemoryCliDeps, run: (host: MemoryHost | null) => Promise<number>): Promise<number>`.
- `buildMemoryToolInstructions` — Baseline: `buildMemoryToolInstructions(): string`. Target: `buildMemoryToolInstructions(options?: { remoteServer?: string }): string`.

New:

- `createMcpMemoryProvider(input: CreateMcpMemoryProviderInput): MemoryProvider` in `src/memory/mcp-provider.ts`, with `CreateMcpMemoryProviderInput = { pool: Pick<McpPool, "listTools" | "call">; serverId: string; workdir: string; mcp: MemoryMcpConfig; idMap: McpIdMap; logger: MemoryLogger; callTimeoutMs: number }` and `MEMORY_MCP_PROVIDER_PREFIX = "mcp:"`, `MCP_MEMORY_RESULT_MAX_BYTES = 65_536`. Exported from the `@/memory` barrel.
- `NaxError` codes `MEMORY_MCP_UNAVAILABLE` (the server lists no tools; retryable) and `MEMORY_MCP_CALL_FAILED` (a tool answered `isError`; retryable), thrown by `createMcpMemoryProvider`.
- `parseMcpMemoryItems`, `parseMcpMemoryIds`, `mcpHitOf`, `McpMemoryItem`, `MCP_HIT_DESCRIPTION_MAX_CHARS`, `MCP_HIT_SNIPPET_MAX_CHARS` in `src/memory/mcp-results.ts`; `createMcpIdMap`, `McpIdMap` in `src/memory/mcp-id-map.ts`. Internal to `src/memory/` (not in the barrel).

Patterns to follow: `createLocalMemoryProvider` (`packages/nax-agent/src/memory/local-provider.ts`) for
the provider shape and the `MEMORY_PUSH_REJECTED` refusal; `createChatMcp` (`src/chat/chat-mcp.ts`)
for building a pool over a subset of `mcp.servers`; `validateProtocolGate` (`src/config/schemas-protocol-gate.ts`)
for a cross-section check called from `superRefine`.

### Failure Handling

| Situation | Behaviour |
|---|---|
| server not connected (connect failed, server `enabled: false`, repository not trusted) | `reachable()` is `false`; saves, and forgets with `tools.forget` set, stay queued in the outbox (feature 1); a forget with `tools.forget` unset still resolves `deleted`; `host.search` returns local hits |
| add tool not in the server's tool list while the server is connected | `push` save throws `MEMORY_PUSH_REJECTED` naming the server and the tool |
| forget tool configured but not in the server's tool list while connected | `push` forget throws `MEMORY_PUSH_REJECTED` naming the server and the tool |
| `push` save, or `push` forget with `tools.forget` set, while `listTools` returns `[]` or rejects | throws `NaxError` code `MEMORY_MCP_UNAVAILABLE` (retryable); no `call` is made |
| remote search does not settle within `_memoryHostDeps.remoteSearchTimeoutMs` | the host warns `memory remote search failed` and returns local hits |
| add tool answers `isError: true` | throws `NaxError` code `MEMORY_MCP_CALL_FAILED` (retryable) with the server, the tool and the answer text |
| add result has no parseable ids | the save is delivered; nothing is recorded in the id map |
| forget tool answers `isError: true` for one id | `warn("memory", "memory mcp forget failed", { server, id, error })`; the other ids are still tried; the push resolves `deleted` |
| search tool answers `isError: true` | `search` throws `MEMORY_MCP_CALL_FAILED`; the host warns `memory remote search failed` and returns local hits |
| search result is not JSON or has no item list | `search` resolves `[]`; the host returns local hits |
| `mcp-ids.json` unreadable, invalid, other version or other server | read as empty; rewritten on the next `add` / `drop` |
| `host.close()` throws in chat or run | warned; the close path continues |

## Out of Scope

- `pull` from an MCP memory server: the provider never pulls, so the mirror holds only notes this machine saved and remote memories reach a session only through `nax-memory__search`.
- `memory.writeMode: "proposal"` with `memory.provider: "mcp"`: refused at config load; no local pending fallback is built.
- A remote memory found by search cannot be read with `nax-memory__get`, listed by `nax memory list`, or shown in the index; the search hit's snippet (up to 1000 characters) is the whole view of it.
- A re-save of an existing slug does not delete the remote copies of the earlier save; they stay until a forget with `tools.forget` configured deletes every recorded id.
- Without `memory.mcp.tools.forget`, a forget removes the note from the mirror only; the remote copies remain and can still be returned by search.
- Remote ids lost before they are recorded (a crash between the add call and the id-map write, or two processes writing one user-scope `mcp-ids.json` at the same time) are not recovered; a later forget cannot delete those copies.
- A save whose add call succeeded on the server but reached nax as an error or a timeout is retried by the outbox and may create a second remote copy; deduplication is left to the server.
- Remote search runs only for project-scope and unscoped searches; a `scope: "user"` search returns local user notes only.
- No default forget tool or id argument is shipped; OpenMemory has no single-memory delete tool, so `tools.forget` and `args.id` must be set for the user's own server.
- Search argument shapes beyond one query argument (a limit argument, user or agent ids, filters) are not configurable; the result is cut to `limit` locally.
- Per-server result parsing beyond the documented shapes (a JSON array, or an object with a `results` array, of items with `memory` / `text` / `content`) is not built.
- The memory host's MCP stdio process is not registered with a run's pid registry; a hard kill of nax can leave it running until its stdin closes.
- A server whose connection failed is not reconnected for the life of one host (the pool caches the failure); a chat must be restarted after the server comes up.
- When the memory server is also attached to chat or run sessions through its own `mcp.servers.<id>.stages`, the session's MCP pool and the memory host's pool open two separate connections.
- The koda provider (design feature 3) is not built; `memory.provider` still refuses `"koda"`.
- No change to `packages/nax-agent`.

## Stories

Feature size: 5 stories, one capability (an MCP-backed memory provider). Every story runs in
`packages/nax`.

**US-001: Config for the MCP memory provider.** No dependencies. Workdir: `packages/nax`. Widens `memory.provider` to `"local" | "mcp"`, adds the optional `memory.mcp` block (`MemoryMcpConfigSchema`, `MemoryMcpConfig`), adds `validateMemoryProvider` and calls it from the `NaxConfigSchema` `superRefine`, and adds `FIELD_DESCRIPTIONS` entries for every new key.

**US-002: MCP result parsing and the remote id map.** No dependencies. Workdir: `packages/nax`. Creates `src/memory/mcp-results.ts` (`parseMcpMemoryItems`, `parseMcpMemoryIds`, `mcpHitOf`) and `src/memory/mcp-id-map.ts` (`createMcpIdMap`).

**US-003: The MCP memory provider.** Depends on US-001, US-002. Workdir: `packages/nax`. Creates `src/memory/mcp-provider.ts` with `createMcpMemoryProvider` and `MEMORY_MCP_PROVIDER_PREFIX`, exported from the `@/memory` barrel.

**US-004: Host composition, remote search and close.** Depends on US-003. Workdir: `packages/nax`. Chooses the provider in `createMemoryHost`, adds `createMcpPool` and `createMcpMemoryProvider` to `_memoryHostDeps`, merges remote search hits in `host.search`, adds `MemoryHost.close`, and adds the `remoteServer` line to `buildMemoryToolInstructions` and its use in `createMemoryToolProvider`.

**US-005: Surfaces close the memory host.** Depends on US-004. Workdir: `packages/nax`. Calls `host.close` from the chat close-time sync and the run memory's close, and adds `withMemoryHost`, which the seven `nax memory` subcommands use in place of `openMemoryHost`.

### Context Files

**US-001**
- `packages/nax/src/config/schemas-memory.ts` — `MemoryConfigSchema`, `memoryConfigOf`
- `packages/nax/src/config/runtime-types-memory.ts` — `MemoryConfig`
- `packages/nax/src/config/schemas.ts` — the `NaxConfigSchema` `superRefine`; 594 of 600 lines
- `packages/nax/src/config/schemas-mcp.ts` — `MCP_SERVER_ID_RE`, `McpConfigSchema`
- `packages/nax/src/cli/config-descriptions.ts` — the `memory.*` entries

**US-002**
- `packages/nax-agent/src/memory/types.ts` — `MemoryHit`, `MemoryScope`
- `packages/nax/src/memory/paths.ts` — `MemoryDirs`

**US-003**
- `packages/nax-agent/src/memory/provider-types.ts` — `MemoryProvider`, `MemoryWriteRequest`, `MemoryPushResult`
- `packages/nax-agent/src/memory/local-provider.ts` — provider shape and the `MEMORY_PUSH_REJECTED` refusal
- `packages/nax/src/mcp/pool.ts` — `McpPool`, `createMcpPool`
- `packages/nax/src/memory/mcp-results.ts` — created by US-002, used here
- `packages/nax/src/memory/mcp-id-map.ts` — created by US-002, used here

**US-004**
- `packages/nax/src/memory/host.ts` — `createMemoryHost`, `composeMemory`, `searchNotes`, `MemoryHost`, `_memoryHostDeps`
- `packages/nax/src/memory/tool-provider.ts` — `createMemoryToolProvider`
- `packages/nax/src/prompts/builders/memory-builder.ts` — `buildMemoryToolInstructions`
- `packages/nax/src/memory/mcp-provider.ts` — created by US-003, composed here
- `packages/nax/src/chat/chat-mcp.ts` — building a pool over a subset of `mcp.servers`

**US-005**
- `packages/nax/src/chat/host-memory.ts` — `createHostMemory`, `closeSync`
- `packages/nax/src/memory/run-memory.ts` — `createRunMemory`, `closeOnce`
- `packages/nax/src/cli/memory-cli-deps.ts` — `withMemoryErrors`, `openMemoryHost`, `MemoryCliContext`
- `packages/nax/src/cli/memory-write.ts` — `memorySaveCommand`, `memoryForgetCommand`, `memoryApproveCommand`

### Creates

**US-002**
- `packages/nax/src/memory/mcp-results.ts`
- `packages/nax/src/memory/mcp-id-map.ts`
- `packages/nax/test/unit/memory/mcp-results.test.ts`
- `packages/nax/test/unit/memory/mcp-id-map.test.ts`

**US-003**
- `packages/nax/src/memory/mcp-provider.ts`
- `packages/nax/test/unit/memory/mcp-provider.test.ts`

**US-004**
- `packages/nax/test/unit/memory/host-mcp.test.ts`

**US-005**
- `packages/nax/test/unit/memory/memory-host-close.test.ts`

### Modifies

**US-001**
- `packages/nax/src/config/schemas-memory.ts` — widen `provider` to `z.enum(["local", "mcp"])`, add `MemoryMcpConfigSchema` and the optional `mcp` key, add `validateMemoryProvider`; the schema stays `.strict()`.
- `packages/nax/src/config/runtime-types-memory.ts` — widen `MemoryConfig.provider` to `"local" | "mcp"` and add `mcp?: MemoryMcpConfig` with the `MemoryMcpConfig` interface.
- `packages/nax/src/config/schemas.ts` — import `validateMemoryProvider` from the memory schema module and call it in the `NaxConfigSchema` `superRefine` after `validateProtocolGate`; the file must end at no more than 600 lines.
- `packages/nax/src/cli/config-descriptions.ts` — change the `memory.provider` description (it says only "local" is accepted) and add entries for `memory.mcp.server`, `memory.mcp.tools.search`, `memory.mcp.tools.add`, `memory.mcp.tools.forget`, `memory.mcp.args.query`, `memory.mcp.args.text` and `memory.mcp.args.id`.

**US-003**
- `packages/nax/src/memory/index.ts` — export `createMcpMemoryProvider`, `MEMORY_MCP_PROVIDER_PREFIX` and the type `CreateMcpMemoryProviderInput`.

**US-004**
- `packages/nax/src/memory/host.ts` — add `createMcpPool`, `createMcpIdMap`, `createMcpMemoryProvider` and `remoteSearchTimeoutMs` to `_memoryHostDeps`, choose the provider in `composeMemory`, merge remote hits in `searchNotes`, add `close?(): Promise<void>` to `MemoryHost` and set it in `createMemoryHost`.
- `packages/nax/src/memory/tool-provider.ts` — pass `remoteServer` to `buildMemoryToolInstructions` when `host.providerId` starts with `MEMORY_MCP_PROVIDER_PREFIX`.
- `packages/nax/src/prompts/builders/memory-builder.ts` — `buildMemoryToolInstructions` takes `options?: { remoteServer?: string }` and appends the remote-hit line when it is set.

**US-005**
- `packages/nax/src/chat/host-memory.ts` — `closeSync` awaits `memory.close?.()` in a `finally` after its sync, warning when it throws.
- `packages/nax/src/memory/run-memory.ts` — `closeOnce` awaits `host.close?.()` after the summary line, warning when it throws.
- `packages/nax/src/cli/memory-cli-deps.ts` — add `withMemoryHost(context, deps, run)`: opens the host through `openMemoryHost`, returns `run(host)`'s result, and awaits `host.close?.()` in a `finally` when the host is not `null`; a close that throws is ignored and does not change the result or turn a success into a failure.
- `packages/nax/src/cli/memory.ts` — `memoryStatusCommand` and `memoryListCommand` call `withMemoryHost` in place of `openMemoryHost`; their output and exit codes are unchanged.
- `packages/nax/src/cli/memory-read.ts` — `memoryShowCommand` and `memorySyncCommand` call `withMemoryHost` in place of `openMemoryHost`; their output and exit codes are unchanged.
- `packages/nax/src/cli/memory-write.ts` — `memorySaveCommand`, `memoryForgetCommand` and `memoryApproveCommand` call `withMemoryHost` in place of `openMemoryHost`; their output and exit codes are unchanged.

### Seams

- US-001 `MemoryConfig.mcp` → US-003 `createMcpMemoryProvider`: the provider reads tool and argument names from its `mcp` input; asserted through the calls the fake pool receives.
- US-002 `parseMcpMemoryItems` / `mcpHitOf` / `createMcpIdMap` → US-003: internal to `src/memory/`; asserted through `search` hits and the forget calls the fake pool receives.
- US-003 `createMcpMemoryProvider` → US-004 `createMemoryHost`: entry point `createMemoryHost` with `provider: "mcp"` config and stubbed `_memoryHostDeps.createMcpPool` / `_memoryHostDeps.createMcpMemoryProvider`; asserted through the stub's received input and `host.providerId`.
- US-004 `MemoryHost.close` → US-005: entry points `createHostMemory(...).closeSync()`, `createRunMemory(...).close()`, and `memoryStatusCommand` / `memoryListCommand` / `memoryShowCommand` / `memorySaveCommand` with `deps.createMemoryHost` stubbed to return a host whose `close` is a spy.

## Acceptance Criteria

### US-001

- [unit] `NaxConfigSchema.parse({ memory: { provider: "mcp", mcp: { server: "om" } }, mcp: { servers: { om: { url: "http://localhost:8765/mcp" } } } }).memory.provider` is `"mcp"`.
- [unit] With the config of the previous AC, the parsed `memory.mcp` equals `{ server: "om", tools: { search: "search_memory", add: "add_memories" }, args: { query: "query", text: "text" } }`.
- [unit] `NaxConfigSchema.safeParse` of the first AC's config with `memory.mcp.tools.forget: "delete_memory"` and no `memory.mcp.args.id` fails with an issue whose path is `["memory", "mcp", "args", "id"]` and whose message is `memory.mcp.args.id is required when memory.mcp.tools.forget is set`.
- [unit] `NaxConfigSchema.safeParse` of the first AC's config with `memory.mcp.tools.forget: "delete_memory"` and `memory.mcp.args.id: "memory_id"` succeeds.
- [unit] `NaxConfigSchema.parse({}).memory` has no `mcp` key.
- [unit] `NaxConfigSchema.safeParse({ memory: { provider: "mcp" } })` fails with an issue whose path is `["memory", "mcp"]` and whose message is `memory.provider "mcp" needs a memory.mcp block naming the server`.
- [unit] `NaxConfigSchema.safeParse({ memory: { provider: "mcp", mcp: { server: "om" } } })` with no `mcp.servers.om` fails with an issue whose path is `["memory", "mcp", "server"]` and whose message is `memory.mcp.server "om" is not defined in mcp.servers`.
- [unit] `NaxConfigSchema.safeParse` of the first AC's config plus `memory.writeMode: "proposal"` fails with an issue whose path is `["memory", "writeMode"]` and whose message is `memory.writeMode "proposal" needs a provider that holds pending writes; provider "mcp" does not`.
- [unit] `NaxConfigSchema.safeParse` of the first AC's config with `memory.provider: "local"` succeeds (an unused `memory.mcp` block is valid).
- [unit] `NaxConfigSchema.safeParse({ memory: { mcp: { server: "om", extra: 1 } }, mcp: { servers: { om: { url: "http://localhost:8765/mcp" } } } })` fails because `memory.mcp` accepts no unknown key.
- [unit] `NaxConfigSchema.safeParse` with `memory.mcp.server` set to `"Bad Id"` fails with an issue whose path starts with `["memory", "mcp", "server"]`.
- [unit] `NaxConfigSchema.safeParse` with `memory.mcp.tools.add` set to `""` fails with an issue whose path starts with `["memory", "mcp", "tools", "add"]`.
- [unit] `NaxConfigSchema.safeParse({ memory: { provider: "koda" } })` still fails with an issue whose path is `["memory", "provider"]`.
- [unit] `FIELD_DESCRIPTIONS["memory.mcp.server"]`, `FIELD_DESCRIPTIONS["memory.mcp.tools.forget"]` and `FIELD_DESCRIPTIONS["memory.mcp.args.id"]` are each a non-empty string.

Verification note: `bun run typecheck` passes with `MemoryConfig.provider` widened, and `bun run check:file-sizes` passes with `src/config/schemas.ts` at no more than 600 lines.

### US-002

- [unit] `parseMcpMemoryItems('[{"id":"a1","memory":"uses bun","score":0.9}]')` returns `[{ id: "a1", text: "uses bun", score: 0.9 }]`.
- [unit] `parseMcpMemoryItems('{"results":[{"id":"a1","memory":"uses bun"}]}')` returns `[{ id: "a1", text: "uses bun" }]`.
- [unit] `parseMcpMemoryItems('[{"text":"t1"},{"content":"t2"}]')` returns `[{ text: "t1" }, { text: "t2" }]`.
- [unit] `parseMcpMemoryItems('[{"id":"a1"},{"id":"a2","memory":"kept"}]')` returns only the item with `text` `"kept"` (an item with no text field is dropped).
- [unit] `parseMcpMemoryItems("not json")` returns `[]`.
- [unit] `parseMcpMemoryItems('{"memories":[{"memory":"x"}]}')` returns `[]`.
- [unit] `parseMcpMemoryIds('{"results":[{"id":"r1","event":"ADD"},{"memory":"no id"},{"id":"r2","memory":"m"}]}')` returns `["r1", "r2"]`.
- [unit] `parseMcpMemoryIds("ok")` returns `[]`.
- [unit] `mcpHitOf({ id: "AB_12", text: "line one\nline two", score: 0.5 }, 0, "project")` returns `{ slug: "mcp-ab-12", scope: "project", type: "reference", status: "active", description: "line one", snippet: "line one\nline two", score: 0.5 }`.
- [unit] `mcpHitOf({ text: "x" }, 2, "user")` returns a hit whose `slug` is `"mcp-3"`, whose `scope` is `"user"` and whose `score` is `0`.
- [unit] `mcpHitOf` of an item whose `text` is 2000 characters returns a `snippet` of `MCP_HIT_SNIPPET_MAX_CHARS` (1000) characters.
- [unit] `mcpHitOf` of an item whose id is 100 lowercase letters returns a `slug` of exactly 64 characters: `mcp-` followed by the first 60 letters.
- [unit] `mcpHitOf` of an item whose `text` is a single line of 300 characters returns a `description` of `MCP_HIT_DESCRIPTION_MAX_CHARS` (160) characters.
- [unit] After `createMcpIdMap({ dirs, server: "om" }).add("project", "s1", ["a", "b"])`, with `dirs` a `MemoryDirs` over temporary directories, a second `createMcpIdMap({ dirs, server: "om" })` over the same `dirs` returns `["a", "b"]` from `ids("project", "s1")`.
- [unit] `add("project", "s1", ["b", "c"])` after `add("project", "s1", ["a", "b"])` makes `ids("project", "s1")` return `["a", "b", "c"]`.
- [unit] After `drop("project", "s1")`, `ids("project", "s1")` returns `[]`.
- [unit] An id recorded under scope `"user"` is written to `<dirs.userDir>/mcp-ids.json` and is not returned by `ids("project", ...)` for the same slug.
- [unit] When `<dirs.projectDir>/mcp-ids.json` holds `{"version":2,"server":"om","notes":{"s1":["a"]}}`, `ids("project", "s1")` on a map for server `"om"` returns `[]`.
- [unit] A map created with `server: "other"` over a directory whose `mcp-ids.json` was written for `"om"` returns `[]` from `ids("project", "s1")`.
- [unit] When `<dirs.projectDir>/mcp-ids.json` holds text that is not JSON, `ids("project", "s1")` returns `[]` and a following `add("project", "s1", ["z"])` makes `ids` return `["z"]`.

### US-003

- [unit] `createMcpMemoryProvider` with `serverId: "om"` returns a provider whose `id` is `"mcp:om"`.
- [unit] `provider.pull({ scope: "project", cursor: null, take: 50 })` resolves `{ notes: [], done: true }` without calling the pool.
- [unit] `provider.reachable()` resolves `true` when the fake pool's `listTools("om", workdir)` returns at least one tool.
- [unit] `provider.reachable()` resolves `false` when `listTools` returns `[]`.
- [unit] `provider.reachable()` resolves `false` when `listTools` rejects.
- [unit] `provider.push` of a save request for the note with slug `"s1"`, description `"d"` and body `"b"` calls `pool.call("om", workdir, "add_memories", { text: "s1: d\n\nb" }, { timeoutMs: callTimeoutMs, maxBytes: MCP_MEMORY_RESULT_MAX_BYTES })`.
- [unit] With `mcp.tools.add: "remember"` and `mcp.args.text: "content"`, a save push calls the pool with tool `"remember"` and input `{ content: "s1: d\n\nb" }`.
- [unit] A save push whose add call answers `{ content: '{"results":[{"id":"r1","event":"ADD"}]}', isError: false }` resolves `{ id: <the note's id>, status: "active" }` and makes `idMap.ids("project", "s1")` return `["r1"]`.
- [unit] A save push whose add call answers `isError: true` rejects with a `NaxError` whose code is `MEMORY_MCP_CALL_FAILED`, and `isMemoryPushRejected` of that error is `false`.
- [unit] A save push while `listTools` returns tools that do not include `add_memories` rejects with an error for which `isMemoryPushRejected` is `true`, and its message names `om` and `add_memories`.
- [unit] A save push whose add call answers `{ content: "ok", isError: false }` (no parseable ids) resolves `{ id: <the note's id>, status: "active" }` and leaves `idMap.ids("project", "s1")` returning `[]`.
- [unit] A save push while `listTools` returns `[]` rejects with a `NaxError` whose code is `MEMORY_MCP_UNAVAILABLE`, and the pool's `call` is not invoked.
- [unit] A save push while `listTools` rejects rejects with a `NaxError` whose code is `MEMORY_MCP_UNAVAILABLE`, and the pool's `call` is not invoked.
- [unit] With `mcp.tools.forget` unset and `listTools` returning `[]`, a forget push for slug `"s1"` (recorded ids `["r1"]`) calls neither `pool.call` nor `pool.listTools`, resolves `{ id: <the request's clientId>, status: "deleted" }`, and leaves `idMap.ids("project", "s1")` returning `[]`.
- [unit] With `mcp.tools.forget: "delete_memory"` and `mcp.args.id: "memory_id"`, a forget push for slug `"s1"` with recorded ids `["r1", "r2"]` calls `pool.call` with tool `"delete_memory"` and input `{ memory_id: "r1" }`, then with input `{ memory_id: "r2" }`, and resolves status `"deleted"`.
- [unit] With `mcp.tools.forget: "delete_memory"` and `mcp.args.id: "memory_id"`, a forget push for a slug with recorded ids `["r1"]` rejects with a `NaxError` whose code is `MEMORY_MCP_UNAVAILABLE` and makes no `pool.call`, both when `listTools` returns `[]` and when `listTools` rejects.
- [unit] With `mcp.tools.forget: "delete_memory"` and `mcp.args.id: "memory_id"`, a forget push for a slug with no recorded ids calls neither `pool.call` nor `pool.listTools` and resolves status `"deleted"`.
- [unit] With `mcp.tools.forget: "delete_memory"` and `mcp.args.id: "memory_id"`, when the call for `"r1"` answers `isError: true`, the call for `"r2"` is still made, the logger receives a warn whose message is `memory mcp forget failed`, and the push resolves status `"deleted"`.
- [unit] With `mcp.tools.forget: "delete_memory"` while `listTools` returns tools that do not include `delete_memory`, a forget push rejects with an error for which `isMemoryPushRejected` is `true`.
- [unit] `provider.search({ scope: "project", text: "bun", limit: 5 })` calls `pool.call` with tool `"search_memory"` and input `{ query: "bun" }`.
- [unit] When the search call answers `'[{"id":"a","memory":"m1"},{"id":"b","memory":"m2"},{"id":"c","memory":"m3"}]'`, `provider.search` with `limit: 2` resolves two hits whose slugs are `"mcp-a"` and `"mcp-b"`.
- [unit] When the search call answers `isError: true`, `provider.search` rejects with a `NaxError` whose code is `MEMORY_MCP_CALL_FAILED`.
- [unit] When the search call answers text that is not JSON, `provider.search` resolves `[]`.
- [unit] `createMcpMemoryProvider` and `MEMORY_MCP_PROVIDER_PREFIX` are importable from `@/memory`, and `MEMORY_MCP_PROVIDER_PREFIX` is `"mcp:"`.

### US-004

- [unit] `createMemoryHost` with `memory.provider: "local"` returns a host whose `providerId` is `"local"` and does not call `_memoryHostDeps.createMcpPool`.
- [unit] `createMemoryHost` with `memory.provider: "mcp"`, `memory.mcp.server: "om"` and `mcp.servers.om` set calls the stubbed `_memoryHostDeps.createMcpPool` once with `servers` holding exactly the key `"om"` bound to the configured `mcp.servers.om`.
- [unit] With that config, the stubbed `_memoryHostDeps.createMcpMemoryProvider` receives `serverId: "om"`, `workdir` equal to the host's `repoRoot`, `mcp` equal to the parsed `memory.mcp`, and `callTimeoutMs` equal to `mcp.servers.om.timeoutMs`; the host's `providerId` is the stub provider's `id`.
- [unit] With a stub provider whose `search` resolves one hit with slug `"mcp-r1"` and a mirror holding a note with slug `"local-1"` that matches the query, `host.search({ text, limit: 10 })` resolves the remote hit first, then the local hit.
- [unit] When the stub provider's `search` resolves a hit whose slug equals a matching local note's slug, `host.search` returns that slug once (the remote hit).
- [unit] `host.search` with `limit: 1` and one remote hit plus one matching local note resolves only the remote hit.
- [unit] `host.search({ text })` with no scope calls the stub provider's `search` with `scope: "project"`.
- [unit] `host.search({ text, scope: "user", limit: 10 })` does not call the stub provider's `search` and resolves the local user-scope hits.
- [unit] When the stub provider's `search` rejects, `host.search` resolves the local hits and the host logger receives a warn whose message is `memory remote search failed`.
- [unit] With `_memoryHostDeps.remoteSearchTimeoutMs` set to `20` and a stub provider whose `search` never settles, `host.search` resolves the local hits and the host logger receives a warn whose message is `memory remote search failed`.
- [unit] When the stub provider has no `search` (the local provider), `host.search` resolves exactly the local hits.
- [unit] `host.close()` on an MCP-provider host calls the stubbed pool's `close` once; a second `host.close()` resolves without throwing.
- [unit] `host.close()` on a local-provider host resolves.
- [unit] `buildMemoryToolInstructions({ remoteServer: "om" })` contains ``Search results whose slug starts with `mcp-` come from the memory server `om`: the snippet is the whole memory, and `nax-memory__get` cannot read it.``
- [unit] `buildMemoryToolInstructions()` contains no line mentioning `mcp-`.
- [unit] `createMemoryToolProvider` over a host whose `providerId` is `"mcp:om"` has `instructions()` resolving `buildMemoryToolInstructions({ remoteServer: "om" })`.
- [unit] `createMemoryToolProvider` over a host whose `providerId` is `"local"` has `instructions()` resolving `buildMemoryToolInstructions()`.

Verification note: `bun run check:import-cycles` passes with `src/memory/host.ts` importing `createMcpPool` from `@/mcp`.

### US-005

- [unit] `createHostMemory({ memory: host, ... }).closeSync()` calls `host.sync()` and then `host.close()`, in that order.
- [unit] When `host.sync()` rejects, `closeSync()` still calls `host.close()` and resolves.
- [unit] When `host.close()` rejects, `closeSync()` resolves and the logger receives a warn.
- [unit] `createRunMemory(...).close()` calls the host's `close()` once, after the end sync, and a second `close()` call does not call it again.
- [unit] When the host's `close()` rejects, `createRunMemory(...).close()` resolves and the summary line is still logged.
- [unit] `memoryStatusCommand` with a stubbed `createMemoryHost` returning a host whose `close` is a spy calls `close` once and returns `0`.
- [unit] `memoryListCommand` with a host whose `notes()` rejects calls the host's `close` once and returns `1`.
- [unit] `memoryStatusCommand` with a host whose `close` rejects still returns `0`.
- [unit] `memoryStatusCommand` with `memory.enabled: false` (the stubbed `createMemoryHost` resolves `null`) returns `0` and makes no close call.
- [unit] `memoryShowCommand` for a slug the stubbed host holds calls the host's `close` once, after the note is written to `deps.log`.
- [unit] `memorySaveCommand` with a stubbed host whose `save` resolves calls the host's `close` once and returns `0`.
- [unit] `withMemoryHost(context, deps, run)` with a `run` that rejects calls the host's `close` once and rejects with `run`'s error.
