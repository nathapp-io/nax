# SPEC: nax memory in chat and on the command line

## Summary

Feature 2 of the nax memory slice (design `docs/superpowers/specs/2026-11-02-nax-memory-design.md`,
section 8). Feature 1 (`memory-store`, merged #2769) built the mirror store, index renderer, keyword
search, outbox, sync loop and the `local` provider in `@nathapp/nax-agent`. This feature puts that
library to work in `packages/nax`, with the `local` provider only:

- a `memory` config block (`enabled`, `provider`, `writeMode`, `indexBytes`, `askOnSave`);
- the per-project mirror directory `~/.nax/memory/projects/<projectKey>-<hash8>` and the user
  directory `~/.nax/memory/user`;
- read-only, repo-committed team notes under `.nax/memory/*.md`, merged into the index and search;
- a memory host that composes store, outbox, provider and repo notes for every nax surface;
- the `nax-memory` static tool provider (`get`, `search`, `save`, `forget`) in `nax chat`, its ACP
  brains and its subagents;
- a `## Memory` section carrying the memory index in the chat, ACP and subagent instructions;
- sync at every session open, before compaction and at chat close;
- `askRules` for `save` / `forget` in guarded native chat when `memory.askOnSave` is true;
- the `/memory` slash command (status plus index; `/memory sync`);
- the `nax memory status | list | show | sync | save | forget | approve` CLI with `--json`.

## Motivation

The chat agent starts every session blank: on 2026-10-27 the in-TUI agent could not find what
"slice 2" was. Feature 1 shipped the storage but nothing in nax reads or writes it yet. This feature
is the first surface: the agent sees an index of what earlier sessions saved, reads notes on demand,
saves what a future session would need, and the user can inspect and edit memory from the terminal.
The koda provider (feature 3) and run stages (feature 4) build on the host and config added here.

## Design

### Approach

New nax module `packages/nax/src/memory/` with a barrel `index.ts` (created by US-002; every later
story that adds a `src/memory/` export appends it there):

| File | Owns |
|---|---|
| `paths.ts` | `memoryDirs()`, `memoryProjectSegment()`, `MemoryLogger`, `_memoryPathsDeps` |
| `repo-notes.ts` | `readRepoNotes()`, `RepoNotes`, `REPO_NOTE_MAX_FILE_BYTES`, `REPO_NOTES_MAX`, `_repoNotesDeps` |
| `host.ts` | `createMemoryHost()`, `MemoryHost`, `MemoryStatus`, `_memoryHostDeps` |
| `host-writes.ts` | the save / forget / approve methods `host.ts` composes (keeps `host.ts` under 400 lines) |
| `tool-provider.ts` | `createMemoryToolProvider()`, `MEMORY_TOOL_PROVIDER_ID` (`"nax-memory"`) |
| `format.ts` | `formatMemoryStatus()`, `formatMemorySyncResult()`, `formatMemoryNoteLine()` |

Config: `packages/nax/src/config/schemas-memory.ts` (`MemoryConfigSchema`, `memoryConfigOf`) and
`packages/nax/src/config/runtime-types-memory.ts` (`MemoryConfig`). Prompt text:
`packages/nax/src/prompts/builders/memory-builder.ts` (`buildMemoryToolInstructions`,
`buildMemorySection`), exported from `src/prompts/index.ts`. Chat glue:
`packages/nax/src/chat/host-memory.ts` and `packages/nax/src/chat/context-window-cache.ts`. CLI:
`packages/nax/src/cli/memory.ts` (registration, repo-root resolution, `status`, `list`),
`packages/nax/src/cli/memory-read.ts` (`show`, `sync`) and `packages/nax/src/cli/memory-write.ts`
(`save`, `forget`, `approve`).

With the `local` provider, `pull` returns nothing and `reachable` is always true, so the syncs this
feature wires (open, compaction, close) only drain the outbox; they still take the mirror lock and
may return `locked` while another chat holds it. They are wired now so feature 3's remote provider
needs no new call sites.

`MemoryLogger` (declared in `paths.ts`, re-exported by the barrel) is
`Pick<Logger, "warn" | "debug" | "info" | "error">` from `@/logger`; it is structurally assignable
to nax-agent's `AgentLogger`, which feature 1's functions take, and the plain-object fallback
logger in `src/cli/chat.ts` satisfies it.

#### Config (`memory`)

```jsonc
"memory": {
  "enabled": true,          // false: no host, no tools, no section, no sync
  "provider": "local",      // only "local" is accepted in this feature
  "writeMode": "direct",    // "direct" | "proposal"
  "indexBytes": 24576,      // integer, 512..262144; the injected index's byte cap
  "askOnSave": true         // guarded native chat asks before nax-memory__save / __forget
}
```

`MemoryConfigSchema` is a `.strict()` zod object (like `schemas-mcp.ts`): an unknown key such as
`stages` or `koda` fails validation until the feature that owns it widens the schema. `provider` is
`z.enum(["local"])`. It is wired into `NaxConfigSchema` as `memory: MemoryConfigSchema.default(() =>
MemoryConfigSchema.parse({}))`; `src/config/schemas.ts` is at 591 of 600 lines and gains about three.

`NaxConfig` is a hand-written interface (`src/config/runtime-types.ts:513`, 599 of 600 lines).
Following the `mcp` precedent (`mcp?: import("./runtime-types-mcp").McpConfig`), the type lives in
`src/config/runtime-types-memory.ts` (`MemoryConfig { enabled: boolean; provider: "local";
writeMode: "direct" | "proposal"; indexBytes: number; askOnSave: boolean }`) and `NaxConfig` gains one
line, `memory?: import("./runtime-types-memory").MemoryConfig;`, bringing the file to exactly 600.
`MemoryConfig` is re-exported from `src/config/types.ts` and `src/config/index.ts`. Because the
field is optional on the type, every reader goes through `memoryConfigOf(config: Pick<NaxConfig,
"memory">): MemoryConfig` (in `schemas-memory.ts`, exported from `@/config`), which returns
`config.memory` or the schema default. The rest of this spec writes `memoryConfigOf(config).x`.

`memory` is a repository-wide setting read from the resolved config (global then project);
per-package `.nax/mono/<pkg>/config.json` files do not change it. `FIELD_DESCRIPTIONS`
(`src/cli/config-descriptions.ts`) gains `memory`, `memory.enabled`, `memory.provider`,
`memory.writeMode`, `memory.indexBytes`, `memory.askOnSave`.

#### Directories (`paths.ts`)

```ts
export type MemoryLogger = Pick<Logger, "warn" | "debug" | "info" | "error">;
export interface MemoryDirs {
  readonly root: string;       // <globalConfigDir()>/memory
  readonly projectDir: string; // <root>/projects/<segment>-<hash8>
  readonly userDir: string;    // <root>/user
}
export function memoryProjectSegment(projectKey: string): string; // [A-Za-z0-9._-] kept, every other char -> "-"
export async function memoryDirs(input: { readonly config: Pick<NaxConfig, "name">; readonly repoRoot: string }): Promise<MemoryDirs>;
export const _memoryPathsDeps: { realpath: (path: string) => Promise<string> };
```

`hash8` is the first 8 lowercase hex characters of the SHA-256 of `realpath(repoRoot)` (UTF-8),
so two repositories with the same basename get different mirrors and a symlinked checkout shares the
real one's mirror. The project key is `getProjectKey(config, repoRoot)` (`src/config/project-key.ts`)
passed through `memoryProjectSegment`. `globalConfigDir()` (`src/config/paths/index.ts`) is the only
way to reach `~/.nax` (the `check:no-real-global-nax` gate). A `realpath` failure throws `NaxError`
code `MEMORY_REPO_ROOT_UNRESOLVED` with context `{ stage: "memory", repoRoot, cause }`.

#### Repo-committed team notes (`repo-notes.ts`)

```ts
export const REPO_NOTE_MAX_FILE_BYTES = 16_384;
export const REPO_NOTES_MAX = 200;
export interface RepoNotes {
  readonly notes: readonly MemoryNote[];   // accepted, source "repo", sorted by slug
  readonly skipped: number;                // candidates rejected by a rule below
}
export async function readRepoNotes(input: { readonly repoRoot: string; readonly logger: MemoryLogger }): Promise<RepoNotes>;
export const _repoNotesDeps: { lstat; readdir; readFile };   // node:fs/promises signatures
```

A repo note is a feature-1 note file, so it has every frontmatter key `parseMemoryNote` requires and
one blank line between the closing `---` and the body. Example `.nax/memory/staging-db.md`:

```markdown
---
id: staging-db
slug: staging-db
type: project
scope: project
description: the staging database is shared; never reset it
source: human
updatedAt: 2026-11-02T08:00:00Z
status: active
---

Ask in #infra before running migrations against staging.
```

Rules, applied in this order:

1. If `<repoRoot>/.nax` or `<repoRoot>/.nax/memory` is a symlink (`lstat`), no note is read, one
   warn `"repo notes directory is a symlink"` with `{ path }` is logged and the result is
   `{ notes: [], skipped: 0 }`. A missing directory returns `{ notes: [], skipped: 0 }` with no log.
   A `readdir` error other than a missing directory logs one warn `"repo notes unreadable"` with
   `{ path, error }` and returns `{ notes: [], skipped: 0 }`.
2. Only top-level names ending `.md` are candidates; subdirectories and other names are ignored
   (not counted as skipped). Candidates are taken in file-name order.
3. A candidate is skipped when: it is not a regular file by `lstat` (a symlink is never followed);
   it is larger than `REPO_NOTE_MAX_FILE_BYTES` (checked from `lstat` before reading); reading it
   fails; `parseMemoryNote` throws; its `slug` differs from the file name without `.md`; its `scope`
   is not `project`; its `status` is not `active`; or `findSecret` finds a secret in the description
   or the body. Each skip logs one `warn("memory", "repo note skipped", { path, reason })`; for a
   secret `reason` is `secret (<kind>)` and never contains the matched text.
4. After `REPO_NOTES_MAX` accepted notes the remaining candidates are not read; one warn
   `"repo notes over limit"` with `{ skipped }` (their count) is logged and they count as skipped.

Accepted notes are returned with `source` replaced by `"repo"`. Repo notes are never written by any
tool or command.

#### Memory host (`host.ts`, `host-writes.ts`)

```ts
export interface MemoryStatus {
  readonly enabled: true;
  readonly provider: string;                 // "local"
  readonly writeMode: "direct" | "proposal";
  readonly projectDir: string;
  readonly userDir: string;
  readonly lastPullAt: string | null;        // from sync.json
  readonly lastError: string | null;
  readonly queued: number;                   // outbox entries in state "queued"
  readonly rejected: number;                 // outbox entries in state "rejected"
  readonly notes: { readonly project: number; readonly user: number; readonly repo: number };
  readonly repoSkipped: number;              // RepoNotes.skipped
}

export interface MemoryHost {
  readonly dirs: MemoryDirs;
  readonly providerId: string;
  readonly writeMode: "direct" | "proposal";
  notes(scope: MemoryScope): Promise<readonly MemoryNote[]>;
  getNote(scope: MemoryScope, slug: string): Promise<MemoryNote | null>;
  search(input: { readonly text: string; readonly scope?: MemoryScope; readonly limit: number }): Promise<readonly MemoryHit[]>;
  renderIndex(): Promise<RenderedMemoryIndex>;
  sync(): Promise<MemorySyncResult>;
  status(): Promise<MemoryStatus>;
  save(write: MemoryNoteWrite): Promise<MemorySaveResult>;
  forget(input: { readonly scope: MemoryScope; readonly slug: string; readonly reason: string }): Promise<MemoryForgetResult>;
  approve(input: { readonly scope: MemoryScope; readonly slug: string }): Promise<MemoryNote>;
}

export async function createMemoryHost(input: {
  readonly config: NaxConfig;
  readonly repoRoot: string;
  readonly source: string;   // "nax-chat" for chat, "human" for the CLI
  readonly logger: MemoryLogger;
}): Promise<MemoryHost | null>;   // null when memoryConfigOf(config).enabled is false
```

Composition: `memoryDirs` → `createMemoryStore({ projectDir, userDir, logger })` →
`createMemoryOutbox({ dir: store.paths.outboxDir })` → `createLocalMemoryProvider(store)`. Repo
notes are read on each call of `notes`, `getNote`, `search`, `renderIndex` and `status` (no cache).
The host hands `readRepoNotes` a wrapper of its logger that drops a `warn` whose `message`, `path`
and `reason` it has already passed on, so one bad repo note warns once per host, not once per call.

- `notes("project")` = the mirror's project notes plus every repo note whose slug the mirror's
  project notes do not hold (the agent's own note shadows the team note), sorted by slug in code-point
  order; `notes("user")` = the mirror's user notes, sorted the same way.
- `getNote(scope, slug)` = the matching element of `notes(scope)` or `null`.
- `search` = `searchMemoryNotes(notes, text, limit)` over `notes("project")` + `notes("user")`
  when `scope` is absent, else over `notes(scope)`.
- `renderIndex` = `renderMemoryIndex({ projectNotes: await notes("project"), userNotes: await
  notes("user"), decisions: await store.readDecisions(), heldForgets: await
  outbox.heldKeys("forget"), maxBytes: memoryConfigOf(config).indexBytes })`.
- `sync` = `syncMemory({ store, outbox, provider, logger })` (never throws by feature 1's contract).
- `status`: `notes.project` and `notes.user` count the mirror's notes of that scope as
  `store.listNotes` returns them; `notes.repo` counts repo notes that are not shadowed;
  `lastPullAt` / `lastError` come from `store.readSyncState()`; `queued` / `rejected` from
  `outbox.list()`.
- `save(write)` = `saveMemoryNote({ store, outbox, provider, logger, write, writeMode, source })`.
- `forget` and `approve` refuse a project slug that only a repo note holds with `NaxError` code
  `MEMORY_NOTE_READ_ONLY`, context `{ stage: "memory", slug }`, message
  `memory note "<slug>" is a repository note; edit .nax/memory/<slug>.md in the repository`;
  otherwise `forgetMemoryNote({ store, outbox, provider, logger, scope, slug, reason, writeMode })`
  and `approveMemoryNote({ store, scope, slug, logger })`.

`_memoryHostDeps = { memoryDirs, readRepoNotes, createMemoryStore, createMemoryOutbox,
createLocalMemoryProvider, syncMemory, saveMemoryNote, forgetMemoryNote, approveMemoryNote }`.

#### Tool provider (`tool-provider.ts`)

`createMemoryToolProvider(host: MemoryHost): ToolProvider` returns `{ id: "nax-memory", kind:
"static", stages: ["*"], instructions: async () => buildMemoryToolInstructions(), tools }` with four
tools (precedent: `src/chat/background/tasks-provider.ts`). Every result is `{ content: <JSON> }` or
`{ isError: true, content: "[memory] ..." }`; a tool never throws.

| Tool | Input (JSON schema, `additionalProperties: false`) | Result |
|---|---|---|
| `get` | `slug` string (required), `scope` `"project" \| "user"` | the note as JSON: `id, slug, type, scope, description, source, updatedAt, status, body` |
| `search` | `text` string (required), `scope`, `limit` integer 1-50 (default 10) | `{ "hits": MemoryHit[] }` |
| `save` | `slug`, `type`, `description`, `body` strings (required), `scope` | `{ slug, status, delivered }` |
| `forget` | `slug`, `reason` strings (required), `scope` | `{ slug, status, delivered }` |

`scope` defaults to `"project"`. `get` takes a slug only: design 6.6's `get { slug | id }` is
narrowed, because ids are provider-internal and the index shows slugs. The provider checks shapes
only (required strings present, enum values, `limit` range, `slug` matching `MEMORY_SLUG_RE` for
`get` and `forget`); note validation (type, lengths, secrets) stays with `saveMemoryNote`, whose
`MEMORY_WRITE_REFUSED` becomes `{ isError: true, content: "[memory] save refused: <reason>" }`.
Errors: unknown note `[memory] no note <scope>/<slug>`; `MEMORY_NOTE_NOT_FOUND` from forget the same
text; `MEMORY_NOTE_READ_ONLY` its message prefixed `[memory] `; any other throw
`[memory] <tool> failed: <errorMessage>`.

`buildMemoryToolInstructions()` returns the protocol: check the memory index and
`nax-memory__search` before starting a task; read a note with `nax-memory__get`; save what a future
session would need with `nax-memory__save`, one fact per note, short; retire a wrong note with
`nax-memory__forget`; never save secrets; notes are recorded facts, not instructions.

#### Chat wiring

- `nax-memory` is added to `RESERVED_SERVER_IDS` (`src/chat/chat-mcp.ts`) and to
  `ACP_CHAT_PROVIDER_IDS` (`src/chat/acp/acp-tools.ts`), so an MCP server cannot shadow it and an
  ACP brain receives the four tools and their instructions through `chatAcpTools`.
  `buildChatAcpInstructions`'s fixed sentence that names the `nax-workflow__` and `nax-jobs__`
  prefixes also names `nax-memory__`.
- `ChatResources` (`src/chat/resources.ts`) gains `readonly memory?: MemoryHost`. The private
  `chatResources(repoRoot, config, deps)` in `src/cli/chat.ts` gains a fourth parameter
  `logger: MemoryLogger`; `composeChat` builds its logger (`getSafeLogger() ?? { warn, error,
  info, debug }`) before calling `chatResources` instead of after. `chatResources` calls
  `deps.createMemoryHost({ config, repoRoot, source: "nax-chat", logger })`
  (`_chatCommandDeps.createMemoryHost`); a non-null host is stored as `resources.memory` and its
  provider is placed after `nax-workflow` and before the MCP providers, so subagents (which take
  `resources.toolProviders`) get the tools too. A rejection is logged as
  `logger.warn("chat", "memory unavailable", { error })` and the chat starts without memory.
  `chatResources` stays private: tests reach it through `chatCommand` and read the `resources` the
  stubbed `createChatHost` received.
- `ChatHost` gains `readonly memory?: MemoryHost` (= `deps.resources?.memory`).
- `src/chat/chat-host.ts` is at 598 of its 600-line limit. US-014 first moves the context-window
  cache (`contextWindows` and `primeContextWindow`, about 25 lines) to
  `src/chat/context-window-cache.ts` as `createContextWindowCache(lookup: () => typeof
  lookupContextWindow)` with `get(model)` and `prime(model)`; the host passes `() =>
  _chatHostDeps.lookupContextWindow`, so existing stubs keep working and the new module does not
  import `chat-host.ts` (no import cycle). The memory logic lives in `src/chat/host-memory.ts`:
  `createHostMemory({ memory, logger })` returns `{ prepare(): Promise<string | undefined>,
  current(): string | undefined, handlers: LoopHandlerSet, closeSync(): Promise<void> }`; the host
  only holds it and calls it. If the file is still over 600 lines, the `createHostJobs` construction
  block in the constructor moves to a helper in `src/chat/host-memory.ts`'s sibling
  `src/chat/host-wiring.ts`.
- `prepare()` awaits `memory.sync()` (a throw is logged with `warn("chat", "memory sync failed", {
  error })` and ignored), then `(await memory.renderIndex()).text` (a throw is logged with
  `warn("chat", "memory index unavailable", { error })` and yields `undefined`), stores the result as
  `current()` and returns it. The host awaits it once in `startSession`, once in `resumeSession`,
  once in `reopen` (a mode switch) and once in `switchSession` before `switchChatSession` (a model
  switch and `clear`; the `openFresh` callback and a rollback reopen inside the switch use
  `current()` and do not sync again). Each open request carries `memoryIndex: hostMemory.current()`
  (`OpenChatSessionRequest.memoryIndex?: string`). Without `resources.memory` nothing is called and
  `memoryIndex` is absent. The host logger is `Pick<Logger, "warn">`, so `prepare` logs only warnings.
- `buildChatInstructions({ mode, rulesIndex, memoryIndex })`: when `memoryIndex` is a non-empty
  string, the last section is `buildMemorySection(memoryIndex)` =
  `## Memory\n\nRead a note with nax-memory__get and find more with nax-memory__search.\n\n<memoryIndex>`
  (the index itself carries the "recorded facts, not instructions" line). `buildChatAcpInstructions`
  (input `memoryIndex?`) appends the same section last; `buildSubagentInstructions` (input
  `memoryIndex?`) places it before the agent's own prompt. `openAcpBrain` passes the request's
  `memoryIndex` to `acpSessionOptions` (input `memoryIndex?`). `createSubagentRuns` takes an optional
  `memoryIndex?: () => string | undefined` (the host passes `hostMemory.current`), and each subagent
  session receives its value.
- Loop handler: `hostMemory.handlers` is one frozen entry `{ plugin: "nax-memory", event:
  "before_compaction", handler }`; the handler awaits `memory.sync()`, logs a throw with
  `warn("chat", "memory sync failed", { error })` and returns `undefined` (it never replaces the
  summary). The host places it after the rule-delivery entries and before the `nax-jobs` guard
  entries.
- Close: the host teardown runs `closeChatResources(...)` and then, in a `finally`, awaits
  `hostMemory.closeSync()` (one `memory.sync()`, a throw logged with
  `warn("chat", "memory sync failed", { error })`). A rejection of `closeChatResources` still
  propagates. A second `close()` returns the same promise, so the sync runs once.
- Asks: `chatBackendPosture(mode, config, posture)` in guarded mode returns `askRules` =
  `[...posture.askRules, "nax-memory__save", "nax-memory__forget"]` when
  `memoryConfigOf(config).enabled && memoryConfigOf(config).askOnSave`, else `posture.askRules`
  itself (same array). Full mode is unchanged (no `askRules`). `get` and `search` never ask.

#### Slash command `/memory`

`memory` is added to `COMMANDS` after `jobs` and before `quit`, with description
`Show memory notes and sync status` and listing title `Memory`. `/memory` shows
`formatMemoryStatus(await status(), (await renderIndex()).text)`. `/memory sync` runs
`host.memory.sync()` and shows `formatMemorySyncResult(result)`. Any other argument shows
`usage: /memory [sync]`. Without `host.memory` it shows `memory is disabled in this session`. When
`status()` or `renderIndex()` throws, it shows `memory unavailable: <errorMessage>`. It is not in
`ACP_OWN_FEATURES`: an ACP brain uses nax memory through the same tools.

`formatMemoryStatus(status, index?)` lines, in order:

```
provider: local
write mode: direct
mirror: /home/u/.nax/memory/projects/nax-monorepo-1a2b3c4d
user notes: /home/u/.nax/memory/user
last sync: 2026-11-02T08:11:00.000Z        (or "never" when lastPullAt is null)
last error: <lastError>                     (only when lastError is not null)
outbox: 0 queued, 0 rejected
notes: 3 project, 1 user, 2 repo
repo notes skipped: 1                       (only when repoSkipped > 0)
```

followed, when `index` is given, by one blank line and the index text.

`formatMemorySyncResult`: `memory sync: synced (pushed P, rejected R, pulled N, skipped S)`,
`memory sync: unreachable`, `memory sync: locked`, or `memory sync: failed: <error>`.

`formatMemoryNoteLine(note)`: `<scope>/<slug> [<type>] <description> (<status>; <source>)`.

### CLI Behavior

`registerMemoryCommand(program, deps = _memoryCliDeps)` in `src/cli/memory.ts` adds the `memory`
group; `bin/nax.ts` calls it beside `registerCostCommand(program)` and `src/cli/index.ts` exports
it. Every subcommand takes `-d, --dir <path>` (default `process.cwd()`, the only `process.cwd()`
read) and `--json`. Like `nax cost` it takes no trust gate and does not call `initLogger`: it writes
only under `~/.nax/memory`. The repo root is resolved as `nax chat` resolves it: `naxDir =
deps.findProjectDir(dir)`, `repoRoot = naxDir ? dirname(naxDir) : dir`, config `deps.loadConfig(naxDir
?? undefined)`. The host is created with `source: "human"` and a logger whose `warn` and `error`
write `[memory] <message>` lines to stderr (`debug` and `info` are dropped), so a skipped repo note
is visible at the terminal.

| Command | stdout (text) | `--json` stdout | Exit |
|---|---|---|---|
| `status` | `formatMemoryStatus(status)` (no index); `enabled: false` when disabled | `MemoryStatus`, or `{"enabled":false}` | 0 |
| `list [--type <t>] [--scope <s>]` | one `formatMemoryNoteLine` per note, project then user, each by slug | `{"notes":[...]}` (entries without `body`) | 0 |
| `show <slug> [--scope <s>]` | `serializeMemoryNote(note)` | the note | 0; 1 when absent |
| `sync` | `formatMemorySyncResult` | the `MemorySyncResult` | 0; 1 when outcome is `failed` |
| `save --slug --type --description (--body <text> \| --body-file <path>) [--scope]` | `saved <scope>/<slug> (<status>)`, plus ` — queued for sync` when not delivered | `{slug,status,delivered}` | 0; 1 on refusal |
| `forget <slug> --reason <text> [--scope]` | `forgot <scope>/<slug> (<status>)` | `{slug,status,delivered}` | 0; 1 when absent or read-only |
| `approve <slug> [--scope]` | `approved <scope>/<slug>` | the note | 0; 1 when absent or read-only |

Errors go to stderr as `Error: <message>` (also under `--json`) with exit 1: an unloadable config,
a host creation failure, an invalid `--type` / `--scope`, a usage error (`--body` and
`--body-file` both or neither given: `Error: give exactly one of --body or --body-file`), a refusal
(an invalid `--type` on `save` surfaces as feature 1's refusal), an absent note
(`Error: no memory note <scope>/<slug>`), a read-only note (its message), and every subcommand except
`status` when memory is disabled (`Error: memory is disabled (memory.enabled is false)`).
`_memoryCliDeps = { findProjectDir, loadConfig, createMemoryHost, readFile, log, logErr, exit }`.

### Integration

Read-only symbols (verified 2026-11-02 on `main` `675e385a4`):

- `@nathapp/nax-agent`: `createMemoryStore`, `createMemoryOutbox`, `createLocalMemoryProvider`,
  `syncMemory` (`MemorySyncResult.outcome: "synced" | "unreachable" | "locked" | "failed"`),
  `saveMemoryNote` (`MemorySaveResult { slug, status, delivered }`, throws `MEMORY_WRITE_REFUSED`),
  `forgetMemoryNote` (throws `MEMORY_NOTE_NOT_FOUND`), `approveMemoryNote` (throws
  `MEMORY_NOTE_NOT_FOUND`), `renderMemoryIndex` (`{ projectNotes, userNotes, decisions,
  heldForgets?, maxBytes?, maxLines? }` → `{ text, omitted }`), `searchMemoryNotes(notes, text,
  limit)`, `parseMemoryNote` (requires the blank line before the body), `serializeMemoryNote`,
  `findSecret`, `MEMORY_SLUG_RE`, types `MemoryNote`, `MemoryNoteWrite`, `MemoryScope`, `MemoryHit`,
  `AgentLogger`, `ToolProvider`, `ProviderTool`, `ToolResult`, `LoopHandlerSet`.
- `MemoryStore.paths.outboxDir`, `store.listNotes()`, `store.readDecisions()`,
  `store.readSyncState()`, `outbox.list()`, `outbox.heldKeys("forget")` (async).
- nax: `getProjectKey(config, projectDir)` (`src/config/project-key.ts`), `globalConfigDir()` and
  `findProjectDir(startDir)` (`src/config/paths/index.ts`), `loadConfig` (`@/config`),
  `closeChatResources` (`src/chat/session-hygiene.ts`), `switchChatSession`
  (`src/chat/session-switch.ts`), `errorMessage` (`@nathapp/nax-agent/internal`).

Mutated symbols. The baseline locates the code only; the target is the interface to implement.

- `NaxConfigSchema` (`src/config/schemas.ts`). Baseline: no `memory` key. Target: `memory` with the
  schema default.
- `NaxConfig` (`src/config/runtime-types.ts:513`). Baseline: no `memory` field. Target: `memory?:
  import("./runtime-types-memory").MemoryConfig;`.
- `RESERVED_SERVER_IDS` (`src/chat/chat-mcp.ts`). Baseline: five ids ending `"nax-tasks"`. Target:
  those five plus `"nax-memory"`.
- `ACP_CHAT_PROVIDER_IDS` (`src/chat/acp/acp-tools.ts:17`). Baseline: `["nax-workflow",
  "nax-jobs"]`. Target: `["nax-workflow", "nax-jobs", "nax-memory"]`.
- `ChatResources` (`src/chat/resources.ts`). Target: adds `readonly memory?: MemoryHost`.
- `chatResources(repoRoot, config, deps)` (`src/cli/chat.ts:185`, private). Baseline: three
  parameters, `toolProviders: [skills, workflow, ...mcp.providers]`. Target: `chatResources(repoRoot,
  config, deps, logger)`, `toolProviders: [skills, workflow, memoryProvider?, ...mcp.providers]`,
  `memory` set when the host exists.
- `composeChat` (`src/cli/chat.ts:259`). Target: the logger is built before `chatResources`.
- `OpenChatSessionRequest` (`src/chat/open-chat-session.ts`). Target: adds `readonly memoryIndex?:
  string`, forwarded to `buildChatInstructions` (native `sessionOptions`) and to `acpSessionOptions`
  (`openAcpBrain`).
- `buildChatInstructions(input)` / `buildChatAcpInstructions(input)`
  (`src/prompts/builders/chat-builder.ts:24`, `:46`). Target inputs add `memoryIndex?`; the ACP
  sentence also names `nax-memory__`.
- `buildSubagentInstructions(input)` (`src/prompts/builders/agents-builder.ts:29`). Target input
  adds `memoryIndex?`.
- `AcpSessionOptionsInput` (`src/chat/acp/acp-session-options.ts`). Target adds `memoryIndex?`.
- `RunSubagentInput` (`src/chat/subagent-session.ts`) and `SubagentRunsDeps`
  (`src/chat/subagent-runs.ts`). Target: `memoryIndex?: string` on the session input and an optional
  `memoryIndex?: () => string | undefined` on the runs deps.
- `chatBackendPosture(mode, config, posture)` (`src/chat/chat-mode.ts`). Target: as in Chat wiring.
- `NativeChatHost` (`src/chat/chat-host.ts`). Target: `memory?` field, `prepare()` before every
  open, memory loop handler, close-time sync, context-window cache moved out.
- `COMMANDS`, `COMMAND_DESCRIPTIONS`, `LISTING_TITLES`, `runSlashCommand`
  (`src/tui/chat/slash-commands.ts`). Target: the `memory` built-in.

Patterns to mirror: static provider `src/chat/background/tasks-provider.ts`; CLI group registration
and exit handling `src/cli/cost.ts` (`registerCostCommand`, `costCommand`); prompt builders
`src/prompts/builders/chat-builder.ts`; repo-root resolution `composeChat` in `src/cli/chat.ts`;
split-out config type `src/config/runtime-types-mcp.ts`.

### Failure Handling

| Failure | Behaviour | Story |
|---|---|---|
| `realpath(repoRoot)` fails | `memoryDirs` throws `MEMORY_REPO_ROOT_UNRESOLVED`; chat logs `memory unavailable` and starts without memory; CLI prints `Error:` and exits 1 | US-002, US-011, US-016 |
| Repo note directory is a symlink or unreadable | no repo note read; one warn | US-004 |
| Repo note unreadable, oversized, malformed, wrong slug, scope or status, secret, symlink | skipped with one warn (once per host) naming path and reason; counted in `repoSkipped` | US-003, US-005 |
| `memory.enabled` false | host is `null`: no tools, no section, no sync, `/memory` disabled message, CLI exit 1 (status exit 0) | US-005, US-011, US-015, US-016 |
| Sync throws at session open | open proceeds with the mirror's index; warn | US-013 |
| Index render throws at open | open proceeds without the `## Memory` section; warn | US-013 |
| Sync throws in `before_compaction` or at close | warn; compaction and close proceed | US-014 |
| `status()` / `renderIndex()` throws in `/memory` | shows `memory unavailable: <message>` | US-015 |
| Save refused (validation, secret) | tool `isError` with the reason; CLI exit 1; nothing written (feature 1) | US-007, US-009, US-018 |
| Forget or approve of a repo-only note | `MEMORY_NOTE_READ_ONLY`; tool `isError`; CLI exit 1 | US-007, US-009, US-019 |
| Note absent for get / show / forget / approve | tool `isError` `[memory] no note <scope>/<slug>`; CLI exit 1 | US-008, US-009, US-017, US-019 |

## Out of Scope

- The koda remote provider, the `memory.koda` config block, `nax memory link` and provider-side search merging are the `memory-koda-provider` feature; `memory.provider` accepts only `local` here.
- `nax memory reset` is not built: with the `local` provider the mirror is the only copy of every note, so deleting it would destroy memory; it arrives with the remote provider.
- `nax memory sync --retry-rejected` and requeueing a rejected outbox entry are not built.
- A chat notice for a rejected outbox entry is not built; rejections show in the `/memory` and `nax memory status` counts only.
- Completing a proposal-mode forget is not built: under `writeMode: proposal` the local provider leaves the note in place with a pending forget, and no command approves a forget.
- Run-stage delivery (`memory.stages`, the memory context element, run-host sync, the reporter line) and bot review / fix surfaces are the `memory-run-stages` feature; `nax run` gets no memory tools or index from this feature.
- The generic MCP memory provider is the `memory-mcp-provider` feature.
- The `nax-agent` ACP server bin does not declare memory tools in this feature.
- An ACP brain's `nax-memory__save` and `nax-memory__forget` calls do not ask in guarded mode: `askRules` reach native sessions only, and the ACP agent applies its own permission handling.
- The memory index in a session's instructions is rendered when the session opens and is not refreshed mid-session; notes saved during a session reach the next open's index, and `nax-memory__search` sees them at once.
- An ACP brain keeps the index it was opened with for the life of its ACP session.
- A subagent whose `allowedTools` exclude the `nax-memory` tools still receives the memory index section as data.
- Repo notes are read from the top level of `.nax/memory/` only; nested directories, a per-package `.nax/memory`, notes with a status other than `active`, and writing or deleting repo notes are not supported.
- No change to `packages/nax-agent`: concurrency, locking, outbox ordering, index sanitising and secret detection are feature 1's and are used as they are.
- `memory` is not read from per-package `.nax/mono/<pkg>/config.json` files.
- Memory tool calls are not rate limited; the agent may call them as often as any other static tool.

## Stories

Feature size: 19 stories, one capability (nax memory surfaces over the feature 1 store), sized to
the 24-assertion gate with one assertion per AC. The user confirmed the scope (repo notes included,
CLI kept in this feature) on 2026-11-02; the count rose from 10 to 19 only to fit the gate. Every
story runs in `packages/nax`.

**US-001: Memory config.** No dependencies. Workdir: `packages/nax`. Creates `src/config/schemas-memory.ts` (`MemoryConfigSchema`, `memoryConfigOf`) and `src/config/runtime-types-memory.ts` (`MemoryConfig`); wires `memory` into `NaxConfigSchema` and `NaxConfig`, re-exports from `src/config/types.ts` and `src/config/index.ts`, adds the six `FIELD_DESCRIPTIONS` entries and adds `memory` to the defaults test's key list.

**US-002: Memory directories.** Depends on US-001. Workdir: `packages/nax`. Creates `src/memory/paths.ts` (`memoryDirs`, `memoryProjectSegment`, `MemoryLogger`, `_memoryPathsDeps`) and the `src/memory/index.ts` barrel.

**US-003: Repo notes: per-file rules.** Depends on US-002. Workdir: `packages/nax`. Creates `src/memory/repo-notes.ts` (`readRepoNotes`, `RepoNotes`, `REPO_NOTE_MAX_FILE_BYTES`, `REPO_NOTES_MAX`, `_repoNotesDeps`) with rules 2 and 3 of the repo-note design; exports from the barrel.

**US-004: Repo notes: directory safety and limit.** Depends on US-003. Workdir: `packages/nax`. Adds rule 1 (symlinked, missing or unreadable directory) and rule 4 (`REPO_NOTES_MAX`) to `src/memory/repo-notes.ts`.

**US-005: Memory host: notes, get and search.** Depends on US-004. Workdir: `packages/nax`. Creates `src/memory/host.ts` (`createMemoryHost`, `MemoryHost`, `MemoryStatus`, `_memoryHostDeps`) with composition, the once-per-host warn wrapper, `dirs`, `providerId`, `writeMode`, `notes`, `getNote` and `search`; `renderIndex`, `sync`, `status`, `save`, `forget` and `approve` throw `NaxError` `MEMORY_NOT_IMPLEMENTED` until US-006 and US-007; exports from the barrel.

**US-006: Memory host: index, sync and status.** Depends on US-005. Workdir: `packages/nax`. Replaces the `renderIndex`, `sync` and `status` placeholders in `src/memory/host.ts`.

**US-007: Memory host: save, forget and approve.** Depends on US-006. Workdir: `packages/nax`. Creates `src/memory/host-writes.ts` and replaces the remaining placeholders in `src/memory/host.ts`, including the `MEMORY_NOTE_READ_ONLY` refusals.

**US-008: Memory tool provider: get and search.** Depends on US-007. Workdir: `packages/nax`. Creates `src/memory/tool-provider.ts` (`createMemoryToolProvider`, `MEMORY_TOOL_PROVIDER_ID`) with the provider shape, its instructions and the `get` and `search` tools, and `src/prompts/builders/memory-builder.ts` (`buildMemoryToolInstructions`); `save` and `forget` are present with their schemas and return `isError` `[memory] not implemented` until US-009; exports from both barrels.

**US-009: Memory tool provider: save and forget.** Depends on US-008. Workdir: `packages/nax`. Implements the `save` and `forget` tools in `src/memory/tool-provider.ts` and the generic failure mapping.

**US-010: Memory tools reach chat, ACP brains and subagents.** Depends on US-009. Workdir: `packages/nax`. Reserves `nax-memory` in `src/chat/chat-mcp.ts`, delivers it to ACP brains in `src/chat/acp/acp-tools.ts`, adds `memory` to `ChatResources`, and builds the host and provider in `chatResources()` with the new `logger` parameter (`src/cli/chat.ts`).

**US-011: Chat resources degrade without memory.** Depends on US-010. Workdir: `packages/nax`. Covers the disabled and failing `createMemoryHost` paths of `chatResources()` and makes the chat CLI test fixtures stub `createMemoryHost`.

**US-012: Memory section in instructions.** Depends on US-011. Workdir: `packages/nax`. Adds `buildMemorySection` to `memory-builder.ts`; adds `memoryIndex` to `buildChatInstructions`, `buildChatAcpInstructions` (and `nax-memory__` to its prefix sentence), `buildSubagentInstructions`, `OpenChatSessionRequest` (native and ACP paths) and `AcpSessionOptionsInput`.

**US-013: Chat host: memory on every open.** Depends on US-012. Workdir: `packages/nax`. Creates `src/chat/context-window-cache.ts` (moving the cache out of `chat-host.ts`) and `src/chat/host-memory.ts` (`createHostMemory` with `prepare`, `current`, `handlers`, `closeSync`); the host exposes `memory`, prepares the index before every open and passes it to subagents.

**US-014: Chat host: compaction and close sync, guarded asks.** Depends on US-013. Workdir: `packages/nax`. Registers the compaction handler in the host, adds the close-time sync to the host teardown, and adds the memory `askRules` to `chatBackendPosture`.

**US-015: The /memory slash command.** Depends on US-014. Workdir: `packages/nax`. Creates `src/memory/format.ts` (`formatMemoryStatus`, `formatMemorySyncResult`, `formatMemoryNoteLine`) and adds the `memory` built-in to `src/tui/chat/slash-commands.ts`.

**US-016: nax memory CLI: status and list.** Depends on US-015. Workdir: `packages/nax`. Creates `src/cli/memory.ts` (`registerMemoryCommand`, `_memoryCliDeps`, repo-root resolution, the CLI logger) with `status` and `list`; registers it in `bin/nax.ts` and exports it from `src/cli/index.ts`.

**US-017: nax memory CLI: show and sync.** Depends on US-016. Workdir: `packages/nax`. Creates `src/cli/memory-read.ts` with `show` and `sync` and adds them to the group.

**US-018: nax memory CLI: save.** Depends on US-017. Workdir: `packages/nax`. Creates `src/cli/memory-write.ts` with `save` and adds it to the group.

**US-019: nax memory CLI: forget and approve.** Depends on US-018. Workdir: `packages/nax`. Adds `forget` and `approve` to `src/cli/memory-write.ts` and the group.

### Context Files

**US-001**
- `packages/nax/src/config/schemas-mcp.ts` — a strict sub-schema file and its default wiring
- `packages/nax/src/config/schemas.ts` — `NaxConfigSchema`, 591 of 600 lines
- `packages/nax/src/config/runtime-types.ts` — `NaxConfig`, 599 of 600 lines
- `packages/nax/src/config/runtime-types-mcp.ts` — the split-out config type precedent
- `packages/nax/test/unit/config/defaults.test.ts` — `NAX_CONFIG_KEYS`

**US-002**
- `packages/nax/src/config/project-key.ts` — `getProjectKey`
- `packages/nax/src/config/paths/index.ts` — `globalConfigDir`
- `packages/nax/src/logger/logger.ts` — `Logger`

**US-003**
- `packages/nax/src/memory/paths.ts` — created by US-002, `MemoryLogger`
- `packages/nax-agent/src/memory/note.ts` — `parseMemoryNote`, required frontmatter and blank line
- `packages/nax-agent/src/memory/validate.ts` — `findSecret`
- `packages/nax/src/resources/skills-provider.ts` — file reads confined to one directory

**US-004**
- `packages/nax/src/memory/repo-notes.ts` — created by US-003, extended here

**US-005**
- `packages/nax/src/memory/paths.ts` — created by US-002
- `packages/nax/src/memory/repo-notes.ts` — created by US-003
- `packages/nax-agent/src/memory/store.ts` — `createMemoryStore`, `MemoryStorePaths`
- `packages/nax-agent/src/memory/search.ts` — `searchMemoryNotes`
- `packages/nax/src/config/schemas-memory.ts` — created by US-001, `memoryConfigOf`

**US-006**
- `packages/nax/src/memory/host.ts` — created by US-005, extended here
- `packages/nax-agent/src/memory/index-render.ts` — `renderMemoryIndex` input
- `packages/nax-agent/src/memory/sync.ts` — `syncMemory` input and result
- `packages/nax-agent/src/memory/outbox.ts` — `list`, `heldKeys`

**US-007**
- `packages/nax/src/memory/host.ts` — created by US-005
- `packages/nax-agent/src/memory/operations.ts` — save / forget / approve inputs and refusal codes

**US-008**
- `packages/nax/src/memory/host.ts` — created by US-005
- `packages/nax/src/chat/background/tasks-provider.ts` — static provider precedent
- `packages/nax/src/prompts/builders/chat-builder.ts` — prompt builder style

**US-009**
- `packages/nax/src/memory/tool-provider.ts` — created by US-008, extended here
- `packages/nax/src/memory/host.ts` — created by US-005

**US-010**
- `packages/nax/src/chat/chat-mcp.ts` — `RESERVED_SERVER_IDS`
- `packages/nax/src/chat/acp/acp-tools.ts` — `ACP_CHAT_PROVIDER_IDS`, `chatAcpTools`
- `packages/nax/src/cli/chat.ts` — `chatResources`, `composeChat`
- `packages/nax/src/chat/resources.ts` — `ChatResources`
- `packages/nax/test/unit/cli/chat-resources.test.ts` — reaching `resources` through `chatCommand`

**US-011**
- `packages/nax/src/cli/chat.ts` — `chatResources`
- `packages/nax/test/unit/cli/chat-resources.test.ts` — the resources fixture
- `packages/nax/test/unit/cli/chat.test.ts` — the chat command fixture

**US-012**
- `packages/nax/src/prompts/builders/chat-builder.ts` — `buildChatInstructions`, `buildChatAcpInstructions`
- `packages/nax/src/prompts/builders/agents-builder.ts` — `buildSubagentInstructions`
- `packages/nax/src/chat/open-chat-session.ts` — `sessionOptions`, `openAcpBrain`
- `packages/nax/src/chat/acp/acp-session-options.ts` — `acpSessionOptions`

**US-013**
- `packages/nax/src/chat/chat-host.ts` — opens, `openArgs`, `contextWindows`, `primeContextWindow`, 598 of 600 lines
- `packages/nax/src/chat/session-switch.ts` — `switchChatSession`, `openFresh`, rollback reopen
- `packages/nax/src/chat/subagent-runs.ts` — `createSubagentRuns`, `SubagentRunsDeps`
- `packages/nax/src/chat/subagent-session.ts` — `RunSubagentInput`, `buildSubagentInstructions` call
- `packages/nax/test/unit/chat/chat-host-resources.test.ts` — host test fixtures

**US-014**
- `packages/nax/src/chat/host-memory.ts` — created by US-013, extended here
- `packages/nax/src/context/rules/rule-delivery/index.ts` — a `before_compaction` entry
- `packages/nax/src/chat/session-hygiene.ts` — `closeChatResources`
- `packages/nax/src/chat/chat-mode.ts` — `chatBackendPosture`
- `packages/nax/src/chat/chat-host.ts` — loop handler set and teardown

**US-015**
- `packages/nax/src/tui/chat/slash-commands.ts` — `COMMANDS`, `runSlashCommand`
- `packages/nax/src/memory/host.ts` — `MemoryStatus`, created by US-005
- `packages/nax/test/ui/chat/slash-commands.test.tsx` — the help-text assertion

**US-016**
- `packages/nax/src/cli/cost.ts` — `registerCostCommand` / `costCommand` exit-code pattern
- `packages/nax/src/memory/format.ts` — created by US-015
- `packages/nax/src/cli/chat.ts` — repo-root resolution in `composeChat`
- `packages/nax/bin/nax.ts` — command registration

**US-017**
- `packages/nax/src/cli/memory.ts` — created by US-016, extended here
- `packages/nax/src/memory/format.ts` — created by US-015

**US-018**
- `packages/nax/src/cli/memory.ts` — created by US-016, extended here

**US-019**
- `packages/nax/src/cli/memory.ts` — created by US-016, extended here
- `packages/nax/src/cli/memory-write.ts` — created by US-018, extended here

### Creates

**US-001**
- `packages/nax/src/config/schemas-memory.ts`
- `packages/nax/src/config/runtime-types-memory.ts`
- `packages/nax/test/unit/config/schemas-memory.test.ts`

**US-002**
- `packages/nax/src/memory/paths.ts`
- `packages/nax/src/memory/index.ts`
- `packages/nax/test/unit/memory/paths.test.ts`

**US-003**
- `packages/nax/src/memory/repo-notes.ts`
- `packages/nax/test/unit/memory/repo-notes.test.ts`

**US-004**
- `packages/nax/test/unit/memory/repo-notes-dir.test.ts`

**US-005**
- `packages/nax/src/memory/host.ts`
- `packages/nax/test/unit/memory/host.test.ts`

**US-006**
- `packages/nax/test/unit/memory/host-index.test.ts`

**US-007**
- `packages/nax/src/memory/host-writes.ts`
- `packages/nax/test/unit/memory/host-writes.test.ts`

**US-008**
- `packages/nax/src/memory/tool-provider.ts`
- `packages/nax/src/prompts/builders/memory-builder.ts`
- `packages/nax/test/unit/memory/tool-provider.test.ts`

**US-009**
- `packages/nax/test/unit/memory/tool-provider-writes.test.ts`

**US-010**
- `packages/nax/test/unit/cli/chat-resources-memory.test.ts`

**US-011**
- `packages/nax/test/unit/cli/chat-resources-memory-degrade.test.ts`

**US-012**
- `packages/nax/test/unit/prompts/memory-builder.test.ts`

**US-013**
- `packages/nax/src/chat/context-window-cache.ts`
- `packages/nax/src/chat/host-memory.ts`
- `packages/nax/test/unit/chat/chat-host-memory.test.ts`

**US-014**
- `packages/nax/test/unit/chat/chat-host-memory-close.test.ts`

**US-015**
- `packages/nax/src/memory/format.ts`
- `packages/nax/test/unit/memory/format.test.ts`
- `packages/nax/test/unit/tui/chat/slash-memory.test.ts`

**US-016**
- `packages/nax/src/cli/memory.ts`
- `packages/nax/test/unit/cli/memory.test.ts`

**US-017**
- `packages/nax/src/cli/memory-read.ts`
- `packages/nax/test/unit/cli/memory-read.test.ts`

**US-018**
- `packages/nax/src/cli/memory-write.ts`
- `packages/nax/test/unit/cli/memory-save.test.ts`

**US-019**
- `packages/nax/test/unit/cli/memory-forget.test.ts`

### Modifies

Files created by an earlier story of this feature (the memory barrel and modules, the tool provider,
the memory builder, the host-memory glue, the formatters, the memory CLI modules) are extended by
later stories without an entry here; they are listed under Context Files. US-002 to US-007, US-009,
US-017, US-018 and US-019 change only such files.

**US-001**
- `packages/nax/src/config/schemas.ts` — add the `memory` key to `NaxConfigSchema` with its schema default; stay within 600 lines.
- `packages/nax/src/config/runtime-types.ts` — add one optional `memory` field typed by an inline import of the new memory runtime-types module to `NaxConfig`, the same pattern as `mcp`; the file must end at no more than 600 lines.
- `packages/nax/src/config/types.ts` — re-export `MemoryConfig`.
- `packages/nax/src/config/index.ts` — export `MemoryConfig`, `MemoryConfigSchema` and `memoryConfigOf`.
- `packages/nax/src/cli/config-descriptions.ts` — add `FIELD_DESCRIPTIONS` entries for `memory`, `memory.enabled`, `memory.provider`, `memory.writeMode`, `memory.indexBytes` and `memory.askOnSave`.
- `packages/nax/test/unit/config/defaults.test.ts` — `NAX_CONFIG_KEYS` is a closed list every `DEFAULT_CONFIG` key must appear in; add `memory` to it (the invariant stays "every default key is listed").

**US-008**
- `packages/nax/src/prompts/index.ts` — export `buildMemoryToolInstructions`.

**US-010**
- `packages/nax/src/chat/chat-mcp.ts` — add `"nax-memory"` to `RESERVED_SERVER_IDS`.
- `packages/nax/src/chat/acp/acp-tools.ts` — add `"nax-memory"` to `ACP_CHAT_PROVIDER_IDS`.
- `packages/nax/test/unit/chat/acp/acp-tools.test.ts` — its assertions pin the delivered provider ids to the workflow and jobs providers; the invariant is the `ACP_CHAT_PROVIDER_IDS` list, which now also contains `nax-memory`.
- `packages/nax/src/chat/resources.ts` — add `readonly memory?: MemoryHost` to `ChatResources`.
- `packages/nax/src/cli/chat.ts` — `chatResources` takes a `logger` parameter, creates the memory host through `deps.createMemoryHost`, stores it as `memory` and places its provider after `nax-workflow`; `composeChat` builds the logger before calling it; `_chatCommandDeps` gains `createMemoryHost`.

**US-011**
- `packages/nax/test/unit/cli/chat.test.ts` — its fixture spreads the real `_chatCommandDeps`, which would now create a real memory host under the test's repo root; the fixture stubs `createMemoryHost` to resolve `null` (the invariant is that chat command tests touch no real global nax directory).
- `packages/nax/test/unit/cli/chat-resources.test.ts` — its fixtures spread the real `_chatCommandDeps`, and its temp-dir cases would create real memory hosts; the fixture stubs `createMemoryHost` to resolve `null`, so its provider-id and resource assertions keep describing the chat without memory.

**US-012**
- `packages/nax/src/prompts/builders/chat-builder.ts` — `buildChatInstructions` and `buildChatAcpInstructions` take `memoryIndex?` and append `buildMemorySection` last; the ACP prefix sentence also names `nax-memory__`.
- `packages/nax/src/prompts/builders/agents-builder.ts` — `buildSubagentInstructions` takes `memoryIndex?` and places the memory section before the agent prompt.
- `packages/nax/src/prompts/index.ts` — export `buildMemorySection`.
- `packages/nax/src/chat/open-chat-session.ts` — `OpenChatSessionRequest.memoryIndex?` reaches `buildChatInstructions` in `sessionOptions` and `acpSessionOptions` in `openAcpBrain`.
- `packages/nax/src/chat/acp/acp-session-options.ts` — `AcpSessionOptionsInput.memoryIndex?` reaches `buildChatAcpInstructions`.
- `packages/nax/test/unit/prompts/chat-handoff.test.ts` — its exact-text assertion on the ACP instructions pins the sentence naming only the workflow and jobs tool prefixes; the invariant is the same instructions with that sentence also naming the memory tool prefix.

**US-013**
- `packages/nax/src/chat/chat-host.ts` — move the context-window cache into the new cache module; add the `memory` field, await `prepare()` once per open path, pass `hostMemory.current` to subagent runs; stay within 600 lines.
- `packages/nax/src/chat/subagent-runs.ts` — take an optional `memoryIndex?: () => string | undefined` and hand its value to each subagent session.
- `packages/nax/src/chat/subagent-session.ts` — take `memoryIndex?` and pass it to `buildSubagentInstructions`.

**US-014**
- `packages/nax/src/chat/chat-host.ts` — register the memory handler after rule delivery and before the jobs guard; after `closeChatResources` in teardown, await `closeSync()` in a `finally`; stay within 600 lines.
- `packages/nax/src/chat/chat-mode.ts` — guarded `chatBackendPosture` appends the two memory ask rules when memory is enabled and `askOnSave` is true.
- `packages/nax/test/unit/chat/chat-mode.test.ts` — it asserts the guarded `askRules` is the posture's array by identity under a default config, where memory asks are now on; its fixture config sets `memory.askOnSave` false so the identity invariant (rules pass through untouched when memory asks are off) still holds.
- `packages/nax/test/unit/chat/open-chat-session.test.ts` — same identity assertion on the options passed to the native backend; its fixture config sets `memory.askOnSave` false for that test.
- `packages/nax/test/unit/chat/subagent-session.test.ts` — same identity assertion through `chatBackendPosture` in the subagent session; its fixture config sets `memory.askOnSave` false for that test.

**US-015**
- `packages/nax/src/tui/chat/slash-commands.ts` — add the `memory` built-in, its description and listing title, and its `runSlashCommand` case.
- `packages/nax/test/ui/chat/slash-commands.test.tsx` — the help-text assertion pins the built-in list ending with the jobs line followed by the quit line; the invariant is the COMMANDS order, now with the line "/memory  Show memory notes and sync status" between the jobs line and the quit line.

**US-016**
- `packages/nax/bin/nax.ts` — call `registerMemoryCommand(program)` next to `registerCostCommand(program)`.
- `packages/nax/src/cli/index.ts` — export `registerMemoryCommand`.

### Seams

- US-002 `memoryDirs` → US-005 `createMemoryHost`: US-005 asserts `host.dirs` equals what `memoryDirs` returns for the same config and repo root.
- US-003/US-004 `readRepoNotes` → US-005: US-005 asserts a real `.nax/memory/*.md` fixture reaches `notes("project")`.
- US-005 to US-007 `createMemoryHost` → US-010 (stubbed `_chatCommandDeps.createMemoryHost`, entry point `chatCommand`, observed through the `resources` the stubbed `createChatHost` receives) and → US-016 CLI (stubbed `_memoryCliDeps.createMemoryHost`, entry point `nax memory status` parsed by a program `registerMemoryCommand` built).
- US-008/US-009 `createMemoryToolProvider` → US-010 `chatResources` and `chatAcpTools`.
- US-010 `ChatResources.memory` → US-013 host: entry points `host.start`, `host.resume`, `host.switchTo`, `host.clear`.
- US-012 `memoryIndex` on `OpenChatSessionRequest` → US-013: entry point `host.start`; native and ACP forwarding entry point `openChatSession`.
- US-013 `createHostMemory` → US-014 compaction handler and close sync; US-015 formatters → US-016 to US-019 CLI output.

## Acceptance Criteria

### US-001

- [unit] `NaxConfigSchema.parse({}).memory` equals `{ enabled: true, provider: "local", writeMode: "direct", indexBytes: 24576, askOnSave: true }`.
- [unit] `NaxConfigSchema.safeParse({ memory: { provider: "koda" } })` fails with an issue whose path is `["memory", "provider"]`.
- [unit] `NaxConfigSchema.safeParse({ memory: { writeMode: "auto" } })` fails with an issue whose path is `["memory", "writeMode"]`.
- [unit] `NaxConfigSchema.safeParse({ memory: { indexBytes: 100 } })` fails with an issue whose path is `["memory", "indexBytes"]`.
- [unit] `NaxConfigSchema.safeParse({ memory: { indexBytes: 300000 } })` fails with an issue whose path is `["memory", "indexBytes"]`.
- [unit] `NaxConfigSchema.safeParse({ memory: { stages: ["run"] } })` fails because `memory` accepts no unknown key.
- [unit] `NaxConfigSchema.parse({ memory: { writeMode: "proposal" } }).memory.askOnSave` is `true`.
- [unit] `memoryConfigOf({})` returns the schema default memory config.
- [unit] `memoryConfigOf({ memory: { enabled: false, provider: "local", writeMode: "direct", indexBytes: 4096, askOnSave: false } })` returns that object.
- [unit] `FIELD_DESCRIPTIONS["memory"]` is a non-empty string.
- [unit] `FIELD_DESCRIPTIONS["memory.enabled"]` is a non-empty string.
- [unit] `FIELD_DESCRIPTIONS["memory.provider"]` is a non-empty string.
- [unit] `FIELD_DESCRIPTIONS["memory.writeMode"]` is a non-empty string.
- [unit] `FIELD_DESCRIPTIONS["memory.indexBytes"]` is a non-empty string.
- [unit] `FIELD_DESCRIPTIONS["memory.askOnSave"]` is a non-empty string.
- [unit] Importing `memoryConfigOf` and `MemoryConfigSchema` from `@/config` succeeds.

Verification note: `bun run typecheck` passes with `NaxConfig.memory` declared; `bun run check:file-sizes` passes with `src/config/schemas.ts` and `src/config/runtime-types.ts` at or under 600 lines.

### US-002

- [unit] With the global config directory pointed at a temp dir, `memoryDirs({ config: { name: "api" }, repoRoot })` returns `projectDir` `<globalDir>/memory/projects/api-<h>` where `<h>` is the first 8 lowercase hex characters of the SHA-256 of `realpath(repoRoot)`.
- [unit] `memoryDirs` returns `userDir` equal to `<globalDir>/memory/user`.
- [unit] `memoryDirs` returns `root` equal to `<globalDir>/memory`.
- [unit] Two temp repositories both named `api` in different parents get different `projectDir` values from `memoryDirs` with `config: {}`.
- [unit] `memoryDirs` called with a symlink to a repository returns the same `projectDir` as with the repository's real path.
- [unit] `memoryDirs` with `config: {}` uses the repository directory's basename as the project key segment.
- [unit] `memoryProjectSegment("team/api v2")` returns `team-api-v2`.
- [unit] `memoryProjectSegment("nax-monorepo.v1_x")` returns `nax-monorepo.v1_x`.
- [unit] When `_memoryPathsDeps.realpath` rejects, `memoryDirs` throws `NaxError` with code `MEMORY_REPO_ROOT_UNRESOLVED`.
- [unit] That `NaxError`'s `context.cause` is the rejection.
- [unit] That `NaxError`'s `context.stage` is `memory`.
- [unit] Importing `memoryDirs` and `memoryProjectSegment` from `@/memory` succeeds.

### US-003

- [unit] `readRepoNotes({ repoRoot, logger })` on a repository holding the Design's example `.nax/memory/staging-db.md` returns `notes` with one note whose `slug` is `staging-db`.
- [unit] That returned note's `source` is `repo`.
- [unit] A file `.nax/memory/other.md` whose frontmatter `slug` is `staging-db` is not returned.
- [unit] Skipping `other.md` logs one warn `repo note skipped` whose data `path` ends with `other.md`.
- [unit] A file `.nax/memory/bad.md` with no frontmatter is not returned.
- [unit] With only `bad.md` present, `skipped` is 1.
- [unit] A note whose frontmatter `scope` is `user` is not returned.
- [unit] A note whose frontmatter `status` is `pending` is not returned.
- [unit] A symlink `.nax/memory/link.md` pointing at a valid note file is not returned.
- [unit] A file larger than `REPO_NOTE_MAX_FILE_BYTES` (16384) is not returned.
- [unit] For that oversized file, `_repoNotesDeps.readFile` is not called.
- [unit] When `_repoNotesDeps.readFile` rejects for a candidate, that candidate is not returned and is counted in `skipped`.
- [unit] A note whose body contains `AKIAABCDEFGHIJKLMNOP` is not returned.
- [unit] The warn for that note has `reason` equal to `secret (aws)`.
- [unit] A `notes.txt` file and a valid note inside `.nax/memory/sub/` produce no returned note.
- [unit] With only those two present, `skipped` is 0.
- [unit] Three valid notes with slugs `zeta`, `alpha`, `mid` are returned in the order `alpha`, `mid`, `zeta`.
- [unit] Importing `readRepoNotes` from `@/memory` succeeds.

### US-004

- [unit] `readRepoNotes` on a repository with no `.nax/memory` directory returns `{ notes: [], skipped: 0 }`.
- [unit] That call logs nothing.
- [unit] When `.nax/memory` is a symlink to a directory holding a valid note, `readRepoNotes` returns no note.
- [unit] That call logs one warn `repo notes directory is a symlink`.
- [unit] When `.nax` itself is a symlink to a directory holding `memory/staging-db.md`, `readRepoNotes` returns no note.
- [unit] When `_repoNotesDeps.readdir` rejects with an `EACCES` error, `readRepoNotes` returns `{ notes: [], skipped: 0 }`.
- [unit] That call logs one warn `repo notes unreadable`.
- [unit] With `REPO_NOTES_MAX + 2` valid notes present, `readRepoNotes` returns `REPO_NOTES_MAX` notes.
- [unit] That call returns `skipped` equal to 2.
- [unit] That call logs one warn `repo notes over limit` with `skipped` 2.

### US-005

- [unit] `createMemoryHost({ config, repoRoot, source: "nax-chat", logger })` with memory disabled returns `null`.
- [unit] With memory disabled, `_memoryHostDeps.memoryDirs` is not called.
- [unit] With memory enabled (temp global dir, temp repo), `host.dirs` equals what `memoryDirs` returns for the same config and repo root.
- [unit] `host.providerId` is `local`.
- [unit] `host.writeMode` equals `memoryConfigOf(config).writeMode`.
- [unit] A note written with `createMemoryStore({ projectDir: host.dirs.projectDir, ... }).writeNote` is returned by `host.notes("project")`.
- [unit] `host.notes("project")` includes the repo note `staging-db` from the repository's `.nax/memory/staging-db.md`.
- [unit] When the mirror also holds a project note `staging-db`, `host.notes("project")` returns exactly one note with that slug.
- [unit] In that case the returned `staging-db` note's `source` is not `repo`.
- [unit] `host.notes("project")` returns mirror note `b-note` and repo note `a-note` in the order `a-note`, `b-note`.
- [unit] `host.notes("user")` contains no note whose `source` is `repo`.
- [unit] `host.getNote("project", "staging-db")` returns the repo note when only the repository holds it.
- [unit] `host.getNote("project", "absent")` returns `null`.
- [unit] `host.search({ text: "staging", limit: 10 })` returns a hit whose `slug` is the repo note's.
- [unit] The same search returns a hit for a user note whose description contains `staging`.
- [unit] `host.search({ text: "staging", scope: "user", limit: 10 })` returns only hits whose `scope` is `user`.
- [unit] With one invalid repo note present, calling `host.notes("project")` twice logs exactly one warn `repo note skipped`.
- [unit] Importing `createMemoryHost` from `@/memory` succeeds.

### US-006

- [unit] `host.renderIndex()` returns text containing the line `- [project] staging-db — the staging database is shared; never reset it` for the repo note.
- [unit] `host.renderIndex()` text contains a `## User` section listing a saved user note's slug.
- [unit] With `memory.indexBytes` 512 and 60 project notes, `host.renderIndex()` returns `omitted` greater than 0.
- [unit] In that case the returned text is at most 512 UTF-8 bytes.
- [unit] With a queued outbox `forget` entry for `project/old-fact` and a mirror note `old-fact`, the `old-fact` line of `host.renderIndex()` ends with `(forget pending)`.
- [unit] `host.sync()` with `_memoryHostDeps.syncMemory` stubbed calls it once.
- [unit] That call's input `provider.id` is `local`.
- [unit] `host.sync()` returns the stubbed `syncMemory` result.
- [unit] `host.status()` on a mirror with 2 project notes, 1 user note and 1 unshadowed repo note returns `notes` `{ project: 2, user: 1, repo: 1 }`.
- [unit] `host.status()` with 1 queued and 1 rejected outbox entry returns `queued` 1.
- [unit] The same `host.status()` returns `rejected` 1.
- [unit] `host.status()` with one skipped repo note returns `repoSkipped` 1.
- [unit] `host.status()` on a fresh mirror returns `lastPullAt` `null`.
- [unit] `host.status()` returns `provider` `local`.
- [unit] `host.status()` returns `enabled` `true`.

### US-007

- [unit] `host.save({ slug: "replay-budget", type: "project", scope: "project", description: "replay budget", body: "2048 MiB" })` with `writeMode` `direct` returns `{ slug: "replay-budget", status: "active", delivered: true }`.
- [unit] After that save, `host.getNote("project", "replay-budget")` returns a note whose `source` is `nax-chat`.
- [unit] With `memory.writeMode` `proposal`, the same save returns `status` `pending`.
- [unit] A save whose body contains `AKIAABCDEFGHIJKLMNOP` throws `NaxError` with code `MEMORY_WRITE_REFUSED`.
- [unit] After that refused save, `host.getNote` for its slug returns `null`.
- [unit] A save with `scope` `user` is returned by `host.notes("user")`.
- [unit] A save of slug `staging-db` while only the repository holds `staging-db` makes `host.getNote("project", "staging-db")` return a note whose `source` is `nax-chat`.
- [unit] `host.forget({ scope: "project", slug: "replay-budget", reason: "stale" })` under `direct` returns `status` `deleted`.
- [unit] After that forget, `host.getNote("project", "replay-budget")` returns `null`.
- [unit] `host.forget` of `staging-db` while only the repository holds it throws `NaxError` with code `MEMORY_NOTE_READ_ONLY`.
- [unit] That error's message names `.nax/memory/staging-db.md`.
- [unit] After that refusal the repository file `.nax/memory/staging-db.md` still exists with its original content.
- [unit] `host.forget` of a slug no scope holds throws `NaxError` with code `MEMORY_NOTE_NOT_FOUND`.
- [unit] `host.approve({ scope: "project", slug })` of a `pending` note returns a note with `status` `active`.
- [unit] `host.approve` of `staging-db` while only the repository holds it throws `NaxError` with code `MEMORY_NOTE_READ_ONLY`.
- [unit] `host.approve` of a slug the mirror does not hold throws `NaxError` with code `MEMORY_NOTE_NOT_FOUND`.
- [unit] With `_memoryHostDeps.saveMemoryNote` stubbed, `host.save(write)` calls it with `writeMode` equal to `host.writeMode`.
- [unit] That stubbed call receives `source` `nax-chat`.

### US-008

- [unit] `createMemoryToolProvider(host)` returns a provider with `id` `nax-memory`.
- [unit] The provider's `kind` is `static`.
- [unit] The provider's `stages` is `["*"]`.
- [unit] The provider's `tools()` resolves to tools with local names `get`, `search`, `save`, `forget` in that order.
- [unit] The `get` tool run with `{ slug: "staging-db" }` on a host holding that note returns content that parses as JSON with `slug` `staging-db`.
- [unit] That `get` result's parsed `body` equals the note's body.
- [unit] The `get` tool run with `{ slug: "absent" }` returns `isError` with content `[memory] no note project/absent`.
- [unit] The `get` tool run with `{ slug: "../x" }` returns `isError`.
- [unit] For that invalid slug, `host.getNote` is not called.
- [unit] The `get` tool run with `{ slug: "pref", scope: "user" }` calls `host.getNote("user", "pref")`.
- [unit] The `search` tool run with `{ text: "staging" }` calls `host.search` with `limit` 10.
- [unit] That `search` result's content parses as an object with a `hits` array.
- [unit] The `search` tool run with `limit` 0 returns `isError` without calling `host.search`.
- [unit] The `search` tool run with `limit` 51 returns `isError` without calling `host.search`.
- [unit] The provider's `instructions()` resolves to the same text `buildMemoryToolInstructions()` returns.
- [unit] `buildMemoryToolInstructions()` names `nax-memory__search`.
- [unit] `buildMemoryToolInstructions()` names `nax-memory__save`.
- [unit] `buildMemoryToolInstructions()` has a sentence beginning `Never` that mentions secrets.
- [unit] Importing `createMemoryToolProvider` from `@/memory` and `buildMemoryToolInstructions` from `@/prompts` succeeds.

### US-009

- [unit] The `save` tool run with `slug`, `type`, `description` and `body` calls `host.save` with those fields and `scope` `project`.
- [unit] That `save` result's content parses as `{ slug, status, delivered }` equal to what `host.save` resolved.
- [unit] The `save` tool run without `description` returns `isError`.
- [unit] For that missing description, `host.save` is not called.
- [unit] When `host.save` throws `NaxError` `MEMORY_WRITE_REFUSED` with message `secret (aws) must not be stored`, the `save` tool returns `isError` with content `[memory] save refused: secret (aws) must not be stored`.
- [unit] The `forget` tool run with `{ slug: "old", reason: "stale" }` calls `host.forget({ scope: "project", slug: "old", reason: "stale" })`.
- [unit] That `forget` result's content parses as `{ slug, status, delivered }`.
- [unit] When `host.forget` throws `MEMORY_NOTE_READ_ONLY`, the `forget` tool returns `isError` whose content starts with `[memory] ` and contains `.nax/memory/`.
- [unit] When `host.forget` throws `MEMORY_NOTE_NOT_FOUND`, the `forget` tool returns `isError` with content `[memory] no note project/old`.
- [unit] The `forget` tool run without `reason` returns `isError` without calling `host.forget`.
- [unit] When `host.search` throws a plain `Error("disk full")`, the `search` tool returns `isError` with content `[memory] search failed: disk full`.
- [unit] When `host.save` throws a plain `Error("disk full")`, the `save` tool's promise resolves (does not reject).

### US-010

- [unit] `createChatMcp` with a configured MCP server whose id is `nax-memory` attaches no provider with id `nax-memory`.
- [unit] That call reports the diagnostic `[resources] mcp server id nax-memory is reserved`.
- [unit] `chatAcpTools([createMemoryToolProvider(host)], cwd)` returns tools whose names include the memory `get`, `search`, `save` and `forget` tools.
- [unit] That `chatAcpTools` call returns `instructions` containing `nax-memory__search`.
- [integration] `chatCommand` with `_chatCommandDeps.createMemoryHost` stubbed to resolve a fake host (and `createChatHost` stubbed as in the existing chat resources tests) calls the stub once with `source` `nax-chat`.
- [integration] That stubbed call receives `repoRoot` equal to the chat's repo root.
- [integration] That stubbed call receives a `logger` with a `warn` function.
- [integration] The `resources` the stubbed `createChatHost` receives has `memory` equal to the fake host.
- [integration] Those `resources` list provider ids with `nax-memory` directly after `nax-workflow`.

### US-011

- [integration] `chatCommand` with `createMemoryHost` stubbed to resolve `null` hands `createChatHost` resources with no `memory`.
- [integration] In that case no provider in those resources has id `nax-memory`.
- [integration] When `createMemoryHost` rejects with `NaxError` `MEMORY_REPO_ROOT_UNRESOLVED`, `chatCommand` still calls `createChatHost`.
- [integration] In that case the resources it receives carry no `memory`.
- [integration] In that case `memory unavailable` is written through the chat's logger (the `writeErr` fallback when no logger is initialised).
- [integration] The existing assertions of `test/unit/cli/chat.test.ts` and `test/unit/cli/chat-resources.test.ts` pass with their fixtures stubbing `createMemoryHost` to resolve `null`.

### US-012

- [unit] `buildChatInstructions({ mode: "guarded", rulesIndex: [], memoryIndex: "# Memory\n- [project] a — b" })` returns text ending with `buildMemorySection` of that index.
- [unit] `buildChatInstructions` without `memoryIndex` returns text with no `## Memory` heading.
- [unit] `buildChatInstructions` with `memoryIndex` `""` returns text with no `## Memory` heading.
- [unit] `buildMemorySection(index)` starts with `## Memory`.
- [unit] `buildMemorySection(index)` names `nax-memory__get` and `nax-memory__search`.
- [unit] `buildMemorySection(index)` ends with `index` verbatim.
- [unit] `buildChatAcpInstructions({ agentLabel: "Codex", memoryIndex })` returns text ending with `buildMemorySection(memoryIndex)`.
- [unit] `buildChatAcpInstructions` without `memoryIndex` returns text with no `## Memory` heading.
- [unit] `buildChatAcpInstructions({ agentLabel: "Codex" })` names the `nax-memory__` prefix.
- [unit] `buildSubagentInstructions` with `memoryIndex` returns text where `buildMemorySection(memoryIndex)` appears before the agent's prompt.
- [unit] `buildSubagentInstructions` without `memoryIndex` returns the same text as before this feature for the same input.
- [integration] `openChatSession` for a native model with `memoryIndex` set creates the agent session with `instructions` containing `## Memory` followed by that index.
- [integration] `openChatSession` for an `acp:` model with `memoryIndex` set creates the agent session with `instructions` containing `## Memory` followed by that index.
- [integration] `acpSessionOptions({ ..., memoryIndex })` returns options whose `instructions` contain that index.

### US-013

- [integration] `host.start({ mode: "guarded", model })` on a chat host whose `resources.memory` is a fake host calls `memory.sync` once.
- [integration] In that start the `memory.sync` call happens before the open call.
- [integration] That start's open request carries `memoryIndex` equal to the fake host's rendered `text`.
- [integration] `host.resume({ id })` calls `memory.sync` before its open.
- [integration] That resume's open request carries `memoryIndex`.
- [integration] `host.switchTo({ mode: "full" })` after a start (the reopen path) passes `memoryIndex` to its open.
- [integration] `host.switchTo({ model })` with a different model after a start (the `openFresh` path) passes `memoryIndex` to its open.
- [integration] That model switch calls `memory.sync` exactly once.
- [integration] `host.clear()` after a start passes `memoryIndex` to its open.
- [integration] When the fake host's `sync` rejects, `host.start` opens a session whose request carries the rendered `memoryIndex`.
- [integration] In that case the host logger receives warn `memory sync failed`.
- [integration] When the fake host's `sync` resolves with outcome `unreachable`, `host.start` logs no warn.
- [integration] When the fake host's `renderIndex` rejects, `host.start` opens a session whose request has no `memoryIndex`.
- [integration] In that case the host logger receives warn `memory index unavailable`.
- [integration] A chat host with no `resources.memory` opens with no `memoryIndex`.
- [integration] A subagent run started through the host after `host.start` opens a session whose instructions contain the memory index the parent session was opened with.
- [unit] `host.memory` equals `deps.resources.memory`.
- [unit] `createContextWindowCache(() => lookup).prime("openai/gpt-x")` calls `lookup` with `openai` and `gpt-x`, and `get("openai/gpt-x")` then returns its result.

Verification note: `bun run check:file-sizes` and `bun run check:import-cycles` pass with `src/chat/chat-host.ts` at or under 600 lines.

### US-014

- [integration] After `host.start`, the open request's `loopHandlers` contain exactly one entry with `plugin` `nax-memory`.
- [integration] That entry's `event` is `before_compaction`.
- [integration] That memory entry comes after every `nax-rules` entry.
- [integration] A chat host with no `resources.memory` has no loop handler entry with `plugin` `nax-memory`.
- [unit] The handler of `createHostMemory({ memory, logger }).handlers[0]` calls `memory.sync` once.
- [unit] That handler returns `undefined`.
- [unit] When `memory.sync` rejects, that handler resolves to `undefined`.
- [unit] In that case the handler logs warn `memory sync failed`.
- [integration] `host.close()` after `host.start(...)` calls `memory.sync` once more than the open did.
- [integration] That close-time sync happens after the resources' `teardown` was called.
- [integration] Calling `host.close()` twice results in one close-time `memory.sync` call.
- [integration] When the close-time `memory.sync` rejects, `host.close()` resolves.
- [integration] In that case the host logger receives warn `memory sync failed`.
- [unit] `chatBackendPosture("guarded", config, posture)` with memory enabled and `askOnSave` true returns `askRules` equal to `[...posture.askRules, "nax-memory__save", "nax-memory__forget"]`.
- [unit] `chatBackendPosture("guarded", ...)` with `askOnSave` false returns `askRules` that is the posture's array itself.
- [unit] `chatBackendPosture("guarded", ...)` with memory disabled returns `askRules` that is the posture's array itself.
- [unit] `chatBackendPosture("full", ...)` returns no `askRules`.
- [integration] `openChatSession` in guarded mode with memory enabled and `askOnSave` true passes `askRules` containing `nax-memory__save` to `_openChatSessionDeps.nativeBackend`.

### US-015

- [unit] `COMMANDS` contains `memory` directly after `jobs`.
- [unit] `COMMANDS` contains `memory` directly before `quit`.
- [unit] `COMMAND_DESCRIPTIONS.memory` is `Show memory notes and sync status`.
- [unit] `LISTING_TITLES.get("memory")` is `Memory`.
- [unit] `runSlashCommand` for `/memory` on a host with `memory` shows exactly the text `formatMemoryStatus(status, index)` for that host's status and index.
- [unit] `runSlashCommand` for `/memory` on a host without `memory` shows `memory is disabled in this session`.
- [unit] `runSlashCommand` for `/memory` when `memory.status` rejects with `Error("disk full")` shows `memory unavailable: disk full`.
- [unit] `runSlashCommand` for `/memory sync` shows `memory sync: synced (pushed 1, rejected 0, pulled 0, skipped 0)` for that sync result.
- [unit] `runSlashCommand` for `/memory purge` shows `usage: /memory [sync]`.
- [unit] On a host whose current model is an ACP brain, `/memory` shows the status listing.
- [unit] `formatMemorySyncResult` returns `memory sync: unreachable` for outcome `unreachable`.
- [unit] `formatMemorySyncResult` returns `memory sync: failed: lock busy` for outcome `failed` with `error` `lock busy`.
- [unit] `formatMemoryStatus` with `lastPullAt` `null` contains the line `last sync: never`.
- [unit] `formatMemoryStatus` with `lastError` `null` contains no line starting `last error:`.
- [unit] `formatMemoryStatus` contains the line `outbox: 2 queued, 1 rejected` for those counts.
- [unit] `formatMemoryStatus` with `repoSkipped` 1 contains the line `repo notes skipped: 1`.
- [unit] `formatMemoryStatus(status)` without an index ends with the last status line.
- [unit] `formatMemoryNoteLine` for a project note `staging-db` of type `project`, description `shared staging db`, status `active`, source `repo` returns `project/staging-db [project] shared staging db (active; repo)`.
- [unit] Importing `formatMemoryStatus`, `formatMemorySyncResult` and `formatMemoryNoteLine` from `@/memory` succeeds.

### US-016

- [cli] `nax memory status` run through a program built by `registerMemoryCommand` with `_memoryCliDeps.createMemoryHost` stubbed calls the stub once with `source` `human`.
- [cli] With `--dir` set to `<repo>/packages/app` inside a repository whose `.nax` is at `<repo>/.nax`, the stub receives `repoRoot` `<repo>`.
- [cli] With `--dir` set to a directory that has no `.nax` above it, the stub receives `repoRoot` equal to `--dir`.
- [cli] `nax memory status` prints the `formatMemoryStatus(status)` text and exits 0.
- [cli] `nax memory status --json` prints one JSON document equal to the host's `MemoryStatus`.
- [cli] With memory disabled (stub resolves `null`), `nax memory status` prints `enabled: false` and exits 0.
- [cli] With memory disabled, `nax memory status --json` prints `{"enabled":false}`.
- [cli] The logger handed to `createMemoryHost` writes a `warn("memory", "repo note skipped", ...)` call to stderr as a line starting `[memory] repo note skipped`.
- [cli] `nax memory list` prints one `formatMemoryNoteLine` per note, project notes first then user notes, each group ordered by slug.
- [cli] `nax memory list --type feedback` prints only notes whose type is `feedback`.
- [cli] `nax memory list --scope user` prints only user notes.
- [cli] `nax memory list --json` prints `{"notes":[...]}` whose entries carry `slug` and `source` and no `body`.
- [cli] `nax memory list --type nope` writes a line starting `Error:` and naming `nope` to stderr and exits 1.
- [cli] With memory disabled, `nax memory list` writes `Error: memory is disabled (memory.enabled is false)` to stderr and exits 1.
- [cli] When `_memoryCliDeps.loadConfig` rejects with `Error("bad json")`, `nax memory status` writes `Error: bad json` to stderr and exits 1.
- [cli] When `createMemoryHost` rejects with `NaxError` `MEMORY_REPO_ROOT_UNRESOLVED`, `nax memory list` exits 1.
- [unit] `registerMemoryCommand(program)` adds a `memory` command whose subcommands include `status` and `list`.
- [unit] `registerMemoryCommand` is importable from `@/cli`.

Verification note: `bin/nax.ts` calls `registerMemoryCommand(program)`; check by hand with `bun bin/nax.ts memory --help` from `packages/nax`.

### US-017

- [cli] `nax memory show staging-db` prints `serializeMemoryNote` of the note and exits 0.
- [cli] `nax memory show absent` writes `Error: no memory note project/absent` to stderr and exits 1.
- [cli] `nax memory show absent` prints nothing to stdout.
- [cli] `nax memory show pref --scope user` asks the host for the user note `pref`.
- [cli] `nax memory show staging-db --json` prints the note as one JSON document whose `body` is the note's body.
- [cli] `nax memory sync` prints `formatMemorySyncResult` of the host's result and exits 0 for outcome `synced`.
- [cli] `nax memory sync` exits 0 for outcome `unreachable`.
- [cli] `nax memory sync` exits 1 for outcome `failed`.
- [cli] For outcome `failed`, `nax memory sync` still prints the result line.
- [cli] `nax memory sync --json` prints the `MemorySyncResult` as one JSON document.
- [cli] With memory disabled, `nax memory show x` writes `Error: memory is disabled (memory.enabled is false)` and exits 1.
- [cli] With memory disabled, `nax memory sync` writes the same error and exits 1.
- [unit] After registration, the `memory` command's subcommands include `show` and `sync`.

### US-018

- [cli] `nax memory save --slug replay-budget --type project --description "replay budget" --body "2048 MiB"` calls `host.save` with those fields and `scope` `project`.
- [cli] For a `host.save` result `{ status: "active", delivered: true }`, that command prints `saved project/replay-budget (active)` and exits 0.
- [cli] `nax memory save ... --body-file note.md` calls `host.save` with `body` equal to the file's text.
- [cli] `nax memory save` with both `--body` and `--body-file` writes `Error: give exactly one of --body or --body-file` to stderr and exits 1.
- [cli] In that case `host.save` is not called.
- [cli] `nax memory save` with neither `--body` nor `--body-file` writes the same error and exits 1.
- [cli] When `host.save` throws `MEMORY_WRITE_REFUSED` with message `secret (aws) must not be stored`, the command writes `Error: secret (aws) must not be stored` to stderr and exits 1.
- [cli] `nax memory save ... --scope user` calls `host.save` with `scope` `user`.
- [cli] When `host.save` resolves `{ status: "pending", delivered: true }`, the output is `saved project/<slug> (pending)`.
- [cli] When `host.save` resolves `delivered: false`, the output line ends with ` — queued for sync`.
- [cli] `nax memory save ... --json` prints the save result as one JSON document.
- [cli] With memory disabled, `nax memory save ...` writes `Error: memory is disabled (memory.enabled is false)` and exits 1.

### US-019

- [cli] `nax memory forget old --reason stale` calls `host.forget({ scope: "project", slug: "old", reason: "stale" })`.
- [cli] For a forget result with `status` `deleted`, that command prints `forgot project/old (deleted)` and exits 0.
- [cli] `nax memory forget old` without `--reason` exits 1.
- [cli] In that case `host.forget` is not called.
- [cli] When `host.forget` throws `MEMORY_NOTE_READ_ONLY`, `nax memory forget staging-db --reason x` writes a line starting `Error:` with that error's message to stderr and exits 1.
- [cli] When `host.forget` throws `MEMORY_NOTE_NOT_FOUND`, the command writes `Error: no memory note project/<slug>` and exits 1.
- [cli] `nax memory forget old --reason stale --json` prints the forget result as one JSON document.
- [cli] `nax memory approve replay-budget` calls `host.approve({ scope: "project", slug: "replay-budget" })`.
- [cli] That command prints `approved project/replay-budget` and exits 0.
- [cli] When `host.approve` throws `MEMORY_NOTE_NOT_FOUND`, `nax memory approve absent` writes `Error: no memory note project/absent` and exits 1.
- [cli] When `host.approve` throws `MEMORY_NOTE_READ_ONLY`, `nax memory approve staging-db` exits 1.
- [cli] With memory disabled, `nax memory forget x --reason y` writes `Error: memory is disabled (memory.enabled is false)` and exits 1.
- [cli] With memory disabled, `nax memory approve x` writes the same error and exits 1.
- [unit] After registration, the `memory` command's subcommands include `save`, `forget` and `approve`.
