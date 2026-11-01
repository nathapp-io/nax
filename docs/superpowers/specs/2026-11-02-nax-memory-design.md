# nax memory (cross-project, koda-backed, pluggable) — design

Status: DRAFT 2026-11-02, builder check DONE (5 corrections + 7 questions
folded, none needed the user), awaiting user approval.
Owner: nax (`packages/nax-agent`, `packages/nax`). Companion koda issues:
nathapp-io/koda #376 (note kind), #377 (full-text search), #378 (user scope),
#379 (export cursor), #380 (proposal write mode).

## 1. Intent

Give the nax agent a real memory: facts, feedback, project state and
references that survive the session, are the SAME in `nax chat` on the user's
machine and in koda threads on the fleet, and reach every nax surface
(chat, `nax run` stages, bot review, subagents). koda is the source of truth;
nax keeps a local mirror so recall is file based, fast, offline-safe and
visible inside the sandbox. The storage behind the agent is a pluggable
provider so a repo without koda still has memory, and third-party memory
servers (any MCP server with search/add tools) plug in with configuration.

Why now: the interactive TUI (slice 1), workflow dispatch (slice 2), ACP
brains, `@` mentions and images are in. The agent still starts every session
blank: on 2026-10-27 the in-TUI agent could not find what "slice 2" was, which
is why the TUI acceptance gate was dropped. The user re-raised memory on
2026-11-02 after deferring it on 2026-10-29.

## 2. What already exists (build on it, do not rebuild)

- **Tool provider seam** — `packages/nax-agent/src/tools/provider-types.ts`
  `ToolProvider { id, kind, stages, tools(workdir), instructions?(workdir) }`.
  Chat attaches static providers with reserved ids `nax-skills`, `nax-agents`,
  `nax-workflow`, `nax-jobs`, `nax-tasks` (`packages/nax/src/chat/chat-mcp.ts`
  `RESERVED_SERVER_IDS`); `nax run` attaches providers per stage
  (`packages/nax/src/runtime/index.ts`, `toolProviders`). Example of a
  file-backed static provider with path confinement:
  `packages/nax/src/resources/skills-provider.ts`.
- **Loop events** — `packages/nax-agent/src/native/session/loop-events/`:
  `before_tool`, `after_tool`, `before_turn` (payload `{ prompt, history,
  sessionName, boundary }`, patch `promptContext` added by the agent-hooks
  design), `before_compaction` (dispatched by `turn-compaction-step.ts:132`
  and `:191`, can replace the summary), `before_turn_end`. External handlers
  are wrapped with a 10 s deadline and never rethrow.
- **Chat instructions** — `packages/nax/src/prompts/builders/chat-builder.ts`
  `buildChatInstructions({ mode, rulesIndex })` adds a rules index section
  (`buildRulesIndexSection`, bodies read on demand). Session open:
  `packages/nax/src/chat/open-chat-session.ts:184-219` (`resolveRuleSet`,
  `loopHandlerRole: "tui"`).
- **Run context** — `packages/nax/src/context/builder.ts buildContext()`
  (called from `execution/story-context/index.ts`) selects `ContextElement`s
  by `priority` against the budget; `ContextElement.type` is a free string
  (`context/types.ts:50`), not an enum. Rules are NOT context elements: they
  go through their own index + on-demand delivery (rule-delivery). Pipeline
  stage names are `plan | run | setup | verify | review | rectification |
  regression | acceptance` (`McpStageSchema`, `config/schemas-mcp.ts`); there
  is no `implement` stage, and planner / implementer / test-writer / reviewer
  are ROLES inside stages, not stages.
- **Curator** — `packages/nax/src/plugins/builtin/curator/` turns run
  observations into RULE proposals accepted with `nax curator commit`
  (procedural memory). Rollup keyed by `projectKey`
  (`packages/nax/src/config/project-key.ts`: `config.name` or the directory
  basename). Out of scope here; memory is the semantic/episodic sibling.
- **Approval memory** — `packages/nax-agent/src/permissions/approval-memory.ts`
  remembers allow/deny per command. Unrelated to this design; name clash only.
- **MCP servers** — `packages/nax/src/config/schemas-mcp.ts`: `command` or
  `url` (streamable HTTP, static `headers`, no `${VAR}` expansion), `stages`,
  `enabled`. Chat connects them through `createChatMcp` with the lock file;
  `RESERVED_SERVER_IDS` is chat-only and not exported (`nax run` has no such
  guard).
- **Provider tools and declaration** — `declaredToolsFor()`
  (`nax-agent/src/session/session-tool-support.ts:34-44`) covers built-in
  coding tools only; provider tools are appended from `providerTools` and
  granted through `providerTools.grants` (same file ~:204). A static provider
  carries no `readOnly` flag (discovered MCP tools do); asking is driven by
  `askRules` / `denyRules` on `NativeBackendOptions`.
- **Global state** — `~/.nax/` (`packages/nax/src/runtime/paths.ts`
  `globalOutputDir()`, `projectOutputDir(projectKey, override)`).
- **Sandbox** — tool execution runs inside the sandbox; network may be
  disabled or domain-limited per `sandbox.network`
  (`packages/nax-agent/src/sandbox/messages.ts`), so a run stage cannot assume
  it can reach koda. A run's stories execute in parallel worktrees.
- **koda** (private, separate repo) — `MemoryItem` triples per project with
  kinds FACT | DECISION | PREFERENCE | CONSTRAINT | INCIDENT_PATTERN,
  confidence, TTL, supersession by `activeKey`, retire, governance;
  `koda_memory_search` / `koda_add_memory` / `koda_record_decision` /
  `koda_retire_decision` / `koda_kb_search` over streamable-HTTP MCP at
  `POST /mcp` with agent-key auth; REST `GET projects/:slug/memory`,
  `POST memory`; `findActiveAfterId(projectId, afterId, take)` cursor.
  Runner threads embed `@nathapp/nax-agent` (`session-factory.ts`) and pass
  `instructions` + `tools`.

## 3. Goals

1. One memory per project, authoritative in koda, visible in nax chat and
   koda threads; user-scope memory visible in every project.
2. Recall is file based: an index injected at session open under a byte cap,
   bodies read on demand, keyword search. Works inside sandboxed run stages.
3. Sessions open and work when koda is unreachable; changes made offline
   reach koda automatically on the next successful contact.
4. Write policy per project: `direct` (lands immediately, audited as the
   agent) or `proposal` (pending until a human approves in koda).
5. Pluggable: one provider seam in nax-agent; built-in local file provider;
   koda provider; generic MCP provider. nax never names koda in code.
6. Explicit writes only. The agent saves memory through a tool it can see;
   nothing is extracted silently from transcripts.

## 4. Non-goals

- Embeddings or vector search in nax. koda's knowledge base stays the
  semantic layer; nax does keyword search over the mirror.
- Background consolidation ("dreaming", sleep-time agents). A later slice may
  add a consolidation pass that PROPOSES through the proposal path.
- Auto-extraction of memories from conversations (Cursor removed theirs in
  2.1.17 for the trust cost; Codex gates it behind 6 h idle plus redaction).
- Memory for ACP brains (Claude Code, Codex, Cursor run their own memory);
  they only get the nax memory tools as MCP-style tools like `nax-workflow__*`.
- Org-wide / multi-user shared memory beyond koda's project scope.
- Changing the curator or rules delivery.

## 5. Anti-goals (failure even if it "works")

- Session open that blocks or fails because koda is down or slow.
- Memory that silently diverges: two stores that both think they are the
  truth. The mirror is disposable; koda wins every conflict.
- Secrets in memory files or in koda (the write path must refuse them).
- Unbounded injection: a memory index that eats the context window.
- A memory tool that can read or write outside the memory root.

## 6. Design

### 6.1 Memory unit

A **note**: Markdown body with YAML frontmatter.

```markdown
---
id: mem_01J...            # koda item id, or local ulid until synced
slug: rs-stock-replay-budget
type: project             # user | feedback | project | reference
scope: project            # project | user
description: replay budget stays 2,048 MiB; next export append ~11-23
source: nax-chat          # nax-chat | nax-run | koda-thread | human | import
updatedAt: 2026-11-02T08:11:00Z
status: active            # active | pending | superseded | rejected
---
body (<= 8 KiB; the builder sets the exact cap as a constant)
```

Types follow Claude Code's four (user, feedback, project, reference); they
are what practice shows agents actually use. `scope: user` notes live under
the user's global dir and are injected in every project. koda stores a note
as a `NOTE` memory item (#376): `subject` = slug, `predicate` = type,
`object` = body, `description` = description. While koda cannot store notes
yet (#376 not deployed) a saved note stays in the outbox with `status:
pending` and reason "provider cannot store notes yet", shown by `nax memory
status`; it is not `rejected` (my call). koda's existing triples
(DECISION etc.) are NOT notes; they are surfaced read-only in the index as
"decisions" lines (see 6.6) and never written through the note tool.

### 6.2 Storage layout (the mirror)

```
~/.nax/memory/
  user/                       # scope: user (koda #378), one file per note
    MEMORY.md                 # generated index
    <slug>.md
  projects/<projectKey>/
    MEMORY.md                 # generated index: notes + decisions lines
    notes/<slug>.md
    decisions.jsonl           # read-only mirror of koda DECISION items
    sync.json                 # { provider, cursor, lastPullAt, lastError }
    outbox/<ulid>.json        # writes not yet acknowledged by the provider
```

The mirror directory is `<projectKey>-<hash8>` where `hash8` is the first 8
hex chars of sha256 of the realpath of the repo root: `getProjectKey()` falls
back to the directory basename, so two repos named `api` would otherwise share
one mirror (my call, same idea as Claude Code's sanitised-cwd directories).
`nax memory status` prints the directory. The koda provider maps the project
to a koda project through config (6.9), not by guessing from the git remote
(my call: explicit beats inferred; `nax memory link` may set it from the
remote).

**Concurrency.** One mirror is shared by an open chat, a run host and the
run's parallel worktrees. Every outbox entry is its own file written with
temp + rename; `MEMORY.md` and `decisions.jsonl` are regenerated with temp +
rename; `sync.json` and the pull/drain routine are guarded by a lock file
using the nax-agent session-lock pattern (`session-store/session-lock.ts`:
nonce + heartbeat, stale detection). Stages inside the sandbox only append
outbox files and read; they never pull. (My call.)

Optional **repo-committed** notes: `.nax/memory/*.md` in the repository are
read-only project notes shared through git (team facts). They are merged into
the index with `source: repo` and never written by the tool. (My call; cheap
and matches Letta's git-backed direction.)

### 6.3 Provider seam (nax-agent)

New in `packages/nax-agent/src/memory/`:

```ts
export interface MemoryProvider {
  readonly id: string;                       // "local" | "koda" | "mcp:<server>"
  /** One page of changes after `cursor`, oldest first; includes tombstones. */
  pull(input: { scope: MemoryScope; cursor?: string; take: number }): Promise<MemoryPage>;
  /** Idempotent by clientId; returns the stored note (id, status). */
  push(note: MemoryNoteWrite): Promise<MemoryPushResult>;
  /** Keyword search; a provider may answer from its own index. */
  search?(input: { scope: MemoryScope; text: string; limit: number }): Promise<readonly MemoryHit[]>;
  /** Health probe; cheap; used to decide whether to sync now. */
  reachable(): Promise<boolean>;
}
```

`MemoryPage = { notes: MemoryNote[]; decisions?: MemoryDecision[]; nextCursor?: string; done: boolean }`.
Tombstones are notes with `status: superseded | rejected | deleted`.

The seam is deliberately pull/push, not search-only, because the mirror is
what every surface reads. `search` is optional and used by the tool when the
provider is reachable and claims better ranking than local keyword search.

A **MemoryStore** (nax-agent) owns the mirror directory: index generation,
cursor, outbox, path confinement (same rules as skills-provider: realpath,
`relative()` check, no absolute, no NUL), size caps, secret refusal (reuse
the credential masking patterns from S3; a write containing a string that
matches the command-safety secret detectors is refused with the reason).

### 6.4 Providers

- **local** (always available, built in): `pull` returns nothing (the mirror
  IS the store), `push` writes the note file directly, `reachable` = true.
  Used when a project has no remote provider configured or as the user-scope
  store when koda #378 is not deployed.
- **koda** (`packages/nax/src/memory/koda-provider.ts`, config-driven, the
  code calls it a "remote http provider"): `pull` = `GET
  projects/:slug/memory/export?since=&take=` (#379) mapped to notes and
  decisions; `push` = `POST memory` with kind NOTE (#376) and the write mode
  honoured server-side (#380); `search` = `koda_memory_search`-equivalent REST
  with full-text (#377); `reachable` = a HEAD/GET on the export route with a
  2 s timeout. Auth: a static bearer header from config, same carrying rules
  as MCP `headers` (literal, no expansion). Until #376-#379 land, the koda
  provider degrades: `pull` uses the existing list route and maps triples to
  decisions lines only; `push` is refused with "koda note kind not available"
  and the note stays in the outbox. (So the nax slice can ship first.)
- **mcp** (generic): wraps a configured MCP server that exposes tools matching
  `memory.mcp.tools = { search, add, get? }` (names configurable, defaults
  `search_memory`, `add_memories`, matching OpenMemory). `pull` is not
  supported (no cursor in the MCP shape): the provider is **search-only** and
  the mirror holds only what the agent saved locally; the index gets a line
  "remote memory: use `nax-memory__search`". (My call: do not fake a cursor
  over a search API.)

### 6.5 Sync: pull mirror plus outbox, auto when reachable

Sync is one routine, `syncMemory(projectKey)`, run opportunistically:

| Trigger | What |
|---|---|
| session open (chat, run, subagent root) | `reachable()` with the 2 s cap; if yes: drain outbox, then pull to `done`; if no: open from the mirror, note `lastError` |
| `before_compaction` | drain outbox (writes made this session must survive) |
| after each successful tool write | push now (direct) or enqueue + push (proposal); on failure enqueue |
| session close | drain outbox once, best effort |
| `nax memory sync` | manual, prints the result |

Rules:
- Pull applies koda's view over the mirror: a note with the same `id` is
  replaced; a tombstone removes the file; a local note still in the outbox is
  never overwritten by a pull (the push settles it).
- The outbox is idempotent: each entry carries a `clientId`; the provider
  dedupes on it (koda: `sourceId` = clientId, which the existing upsert
  dedup supports via `activeKey`).
- A `proposal` write lands in the mirror as `status: pending` so the agent
  sees its own note immediately with a "pending approval" marker; the next
  pull flips it to active or removes it on reject.
- Never block a turn on sync. All network work has the 2 s probe plus a 10 s
  operation cap and runs off the turn's critical path except the explicit
  drain at compaction (bounded by the same caps).
- The mirror is disposable: `nax memory reset` deletes it and pulls again.

### 6.6 Recall

**Index injection.** `MEMORY.md` is generated from the mirror: one line per
note `- [type] slug — description (status)` grouped by type, then
`## Decisions` with one line per active koda decision (subject predicate
object, newest first, capped), then user-scope notes. The injected copy is
capped (default 24 KiB / 200 lines, matching Claude Code; config
`memory.indexBytes`) with a trailing "N more, use the memory tool" line.
Delivery:
- chat: a `## Memory` section in `buildChatInstructions` (new input
  `memoryIndex`), same shape as the rules index section.
- run stages: a `ContextElement` of type `memory` with a priority just below
  the story spec, emitted by the story-context builder for the stages listed
  in `memory.stages` (pipeline stage names). Default index delivery: `plan`,
  `run` (every role in it, including the test-writer), `rectification`,
  `acceptance`; `review`, `verify`, `regression` get the index too but never
  the tool. The builder verifies which stages reach `buildContext()`; a stage
  that does not (the planner may not) gets the same section appended to its
  prompt by its own prompt builder.
- subagents: inherit the parent's index.
- ACP brains: the index is appended to `buildChatAcpInstructions` tool
  instructions once per session (they cannot be re-sent on resume). A stale
  index for the life of an ACP session is accepted; `nax-memory__search` is
  the fresh channel and the tool instructions say so. (My call.)

**Tool.** One static provider `nax-memory` (add to `RESERVED_SERVER_IDS`)
with tools:
- `nax-memory__get { slug | id }` → body with frontmatter.
- `nax-memory__search { text, scope?, limit? }` → hits (slug, type,
  description, snippet). Local keyword search over the mirror (case-folded
  token match over description + body, ranked by hits then recency); when the
  provider is reachable and has `search`, its results are merged first.
- `nax-memory__save { slug, type, scope?, description, body }` → creates or
  supersedes; honours write mode; returns status (`active` | `pending`) and
  whether it reached the provider or sits in the outbox.
- `nax-memory__forget { slug, reason }` → retire (koda retire route) or
  local delete; proposal mode makes it pending too.

Permission posture: `get`/`search` never ask. `save`/`forget` never ask in
full mode and never ask inside a `nax run` stage (nobody can answer; the
write mode is the control there). In guarded chat they ask when
`memory.askOnSave` is true, implemented by adding `nax-memory__save` and
`nax-memory__forget` to the session's `askRules` (existing
`NativeBackendOptions.askRules`), not by a new flag. (My call.) Same provider
instructions as Codex/Claude: "check
memory before starting a task; save what a future session would need; keep
notes short, one fact per note; never save secrets".

**Prompting.** The provider `instructions()` carries the protocol (view index
→ get what matters → save as you learn). No auto "always read all memory"
prefix: the index is enough to decide.

### 6.7 Write policy

`memory.writeMode: "direct" | "proposal"` per project (project config wins
over global). koda enforces it server-side (#380) so a misconfigured client
cannot bypass it; nax mirrors the mode locally so offline writes are marked
pending when the project is in proposal mode. The local provider has no
approval flow: in proposal mode local notes are written `status: pending`
and `nax memory approve <slug>` flips them (my call, keeps the UX identical
without koda).

### 6.8 Surfaces

- **nax chat**: sync at open, index in instructions, tool attached, `/memory`
  slash command lists the index with provider/sync status, `/memory sync`.
- **nax run**: sync once at run start and once at run end (outside the
  sandbox, in the host process, which already holds config and network),
  index injected per stage, tool attached to the stages listed in
  `memory.stages` (default `plan`, `run`, `rectification`, `acceptance`).
  Tool writes from a stage only append outbox files; the host drains them at
  run end; the run reporter mentions "N memories saved (M pending)".
- **bot review / fix**: index only (read), no tool by default.
- **subagents**: inherit index; tool attached only when the parent has it.
- **koda threads**: nothing to pull; koda's own `koda_memory_search` /
  `koda_add_memory` are the tools, and koda injects the same index shape
  from its database (koda-side follow-up, filed with #376-#380 as needed).
- **nax-agent ACP server** (`nax-agent` bin): the memory tools are declared
  like other coding tools so koda ACP threads can use them when #368 lands.

### 6.9 Config

```jsonc
// ~/.nax/config.json (global) or <repo>/.nax/config.json (project)
"memory": {
  "enabled": true,
  "provider": "koda",                 // "local" | "koda" | "mcp"
  "writeMode": "direct",              // "direct" | "proposal"
  "indexBytes": 24576,
  "stages": ["plan", "run", "rectification", "acceptance"],   // pipeline stage names
  "askOnSave": true,                  // guarded mode only
  "koda": {
    "url": "https://koda.example/api",
    "project": "rs-stock",            // koda project slug this projectKey maps to
    "headers": { "Authorization": "Bearer <agent key>" }
  },
  "mcp": { "server": "openmemory", "tools": { "search": "search_memory", "add": "add_memories" } }
}
```

`memory.koda.url` and `memory.koda.headers` are accepted in GLOBAL config
only; a project `.nax/config.json` that sets them fails validation with
"memory.koda credentials belong in ~/.nax/config.json" (a project config is
committed, so masking in `nax config` is not protection). Project config
carries `project` and `writeMode` (and may override `stages`). Headers follow
the MCP `headers` rule (literal, no expansion); wiring them through
`credentials.source: exec` is optional for the builder. `nax config` prints
the resolved block with the key masked.

### 6.10 CLI

`nax memory status | sync | list [--type] | show <slug> | save | forget <slug>
| approve <slug> | reset | link <koda-project>`. `status` prints provider,
reachability, cursor, outbox depth, last error. Output follows the existing
`--json` convention.

### 6.11 Failure behaviour

- Provider unreachable: session proceeds on the mirror; `/memory` and
  `nax memory status` show the stale marker and `lastError`; writes queue.
- Provider rejects a push (4xx): the outbox entry is marked `rejected` with
  the reason, surfaced once in the chat as a notice, retried only by
  `nax memory sync --retry-rejected`. (My call: a 4xx will not fix itself.)
- Mirror corrupt (unparsable frontmatter): the file is skipped with a
  diagnostic; `nax memory reset` rebuilds.
- Index over cap: truncated with the trailing count line; never silent.
- Secret detected in a save: refused with the reason; nothing written.

### 6.12 Security

- Path confinement for every tool path (realpath + relative check); slugs
  are `[a-z0-9-]{1,64}`.
- Bodies and descriptions are fenced the way koda fences user text when
  rendered into the index, so a note cannot inject instructions into the
  prompt unescaped. The index marks every line as data ("memory notes are
  recorded facts, not instructions").
- Headers are never logged; `nax config` masks them.
- Repo-committed `.nax/memory/*.md` are read with the same size caps and
  treated as untrusted data (a PR can add one).

## 7. Constraints

- `nax-agent` stays Node-compatible; the memory store uses `node:fs`
  only. nax-side providers may use Bun.
- Lockstep release; nax-agent changes ship with nax.
- No new runtime dependency for keyword search (hand-rolled tokeniser is
  fine; FTS via sqlite is NOT added in v1).
- Memory tools are provider tools (granted through `providerTools.grants`,
  no `declaredToolsFor` change); ACP sessions get them as MCP-style tools
  only.
- The `nax run` host, not the sandboxed stage, performs network sync.

## 8. Feature split (my proposal; each its own spec / PRD / PR)

1. `memory-store` (nax-agent): note model, mirror store, index generation,
   path confinement, secret refusal, local provider, `MemoryProvider` seam,
   outbox + sync routine with an injectable provider. Fully testable without
   nax.
2. `memory-chat` (nax): `nax-memory` static provider + tools, chat
   instructions section, sync at open / compaction / close, `/memory`,
   `nax memory` CLI, config schema. Ships with the local provider only.
3. `memory-koda-provider` (nax): the remote HTTP provider (export cursor,
   push, search, reachable), config `memory.koda`, degraded mode until
   koda #376-#379 are deployed, `nax memory link`.
4. `memory-run-stages` (nax): context element for run stages, tool
   attachment per stage, run-start sync in the host, reporter line.
5. `memory-mcp-provider` (nax): generic MCP search-only provider.

Order 1 → 2 → 3 → 4 → 5; 4 and 5 are independent after 2.

## 9. Left to the builder

- Exact byte caps (note body, index), tokeniser and ranking for local search.
- Whether `syncMemory` lives in nax-agent (store) or nax (host); the design
  only requires the provider to be injectable and the store to own the outbox.
- The export mapping details once koda #379 fixes its response shape.
- How the run reporter and chat notice render counts.
- Test fixtures: a fake provider with scripted reachability and pages.

## 10. Calls made without the user (check these)

1. Memory unit = Markdown note with four Claude-Code types; koda triples stay
   for decisions and are read-only in nax.
2. projectKey → koda project is explicit config (`memory.koda.project`), not
   inferred from the git remote.
3. The generic MCP provider is search-only (no fake cursor).
4. Repo-committed `.nax/memory/*.md` notes are read-only team facts.
5. 4xx push rejections are not retried automatically.
6. Proposal mode without koda = local `pending` + `nax memory approve`.
7. Default run stages for the tool: `plan`, `run`, `rectification`,
   `acceptance`; `review`/`verify`/`regression` and bot review get the index
   only.
8. Index cap 24 KiB / 200 lines by default.
9. No background consolidation in v1.
10. Mirror directory = `<projectKey>-<hash8(repo root)>`; lock file around
    sync; stages never pull.
11. `save`/`forget` ask only in guarded chat via `askRules`; never in a run.
12. koda url + headers are global-config only.
13. Stale index for the life of an ACP session is accepted.
14. Degraded koda (no note kind yet) shows `pending`, not `rejected`.

## 11. Decision log (from the 2026-11-02 brainstorm)

- Same memory in nax chat and koda; koda authoritative. (user)
- Pull architecture: nax mirrors per project, koda never pushes. (user agreed
  to the recommendation)
- Write mode configurable `direct | proposal`; sync automatic when koda is
  reachable. (user)
- Pluggable provider seam with local, koda and MCP providers. (user: "pluginable")
- koda changes filed as #376-#380; koda arc not scheduled. (user)

## 12. koda companion changes (private repo nathapp-io/koda; summarised here so this document stands alone)

| Issue | Change | nax depends on it for |
|---|---|---|
| #376 | `NOTE` memory kind: `subject` = slug, `predicate` = type, `object` = Markdown body (capped), plus `description`; reuses `activeKey` supersession; `koda_add_memory` accepts it, listing returns the description, body on explicit get | koda provider `push` of notes |
| #377 | Postgres full-text search (`tsvector` + GIN, rank ordering) replacing the case-insensitive substring match; TTL term stays an `AND` | koda provider `search` |
| #378 | `scope: user` memory items (owner = User, no project), returned alongside project items for the caller | user-scope notes in the mirror |
| #379 | `GET projects/:slug/memory/export?since=<cursor>&take=<n>`: changes ordered by a monotonic key (`updatedAt,id`), includes tombstones (superseded / rejected / deleted), returns `nextCursor`; agent-key auth, `memory.read` key, user text fenced | koda provider `pull` |
| #380 | Project setting `memory.writeMode: direct | proposal`; proposal creates `status: pending` plus an approval under the existing gate; pending items hidden from search/list/export until approved | server-side enforcement of 6.7 |

Until they are deployed the koda provider runs in the degraded mode of 6.4
(decisions mirrored from the existing list route, note pushes held in the
outbox as `pending`).

## 13. Builder check record (2026-11-02)

A fresh reviewer read the first draft as the builder. Corrections folded:
`declaredToolsFor` covers built-ins only (provider tools are granted through
`providerTools.grants`); run stages are pipeline names and roles are not
stages; `ContextElement.type` is a free string selected by priority;
`RESERVED_SERVER_IDS` is chat-only; sandbox messages path. Questions raised
and settled as calls 10-14 in section 10: stage mapping, projectKey
collisions, ask semantics for provider tools, where the koda secret may live,
concurrent writers to one mirror, stale index for ACP sessions, degraded
koda status. None required the user.

## 14. Glossary

- **note** — one memory: Markdown body with frontmatter (6.1).
- **index** — generated `MEMORY.md`: one line per note plus decisions lines,
  injected under a byte cap (6.6).
- **mirror** — the per-project copy of the provider's memory under
  `~/.nax/memory/` that every surface reads (6.2).
- **outbox** — local files holding writes the provider has not acknowledged;
  drained whenever the provider is reachable (6.5).
- **cursor** — opaque position in the provider's change stream used by `pull`;
  stored in `sync.json`.
- **provider** — an implementation of `MemoryProvider` (6.3): local, koda,
  mcp.
- **write mode** — `direct` (lands immediately) or `proposal` (pending until
  a human approves) (6.7).
- **projectKey** — `getProjectKey()`: `config.name` or the repo directory
  basename; namespaced with a path hash for the mirror directory.
- **pipeline stages** — `plan | run | setup | verify | review | rectification
  | regression | acceptance`; roles such as planner, implementer, test-writer
  and reviewer run inside them.
- **loop events** — nax-agent's in-process hook points (`before_turn`,
  `before_tool`, `after_tool`, `before_compaction`, `before_turn_end`).
- **ACP brain** — an external coding agent (Claude Code, Codex, Cursor)
  driving a nax chat session over the Agent Client Protocol.
- **decision** — a koda `DECISION` memory item (review ruling); mirrored
  read-only, never written through the note tool.

## 15. Pointers

- Research digest: Claude Code auto memory (index ≤ 25 KiB injected, topic
  files on demand), Anthropic memory tool `memory_20250818` (client-side file
  ops under `/memories`), Codex Memories (summary injected, grep for detail,
  30-day pruning, no vectors), OpenClaw (`memory-core` plugin slot,
  `memory_search`/`memory_get`, pre-compaction flush), Hermes (two small files
  fully injected, one external provider at a time), Letta (memory blocks →
  git-backed MemFS), Cursor memories removed in 2.1.17, mem0 OpenMemory MCP
  (search/add/list/delete).
- Related designs: `2026-11-01-nax-agent-hooks-design.md` (loop events),
  `2026-10-24-nax-interactive-tui-slice1-design.md`,
  `2026-10-27-nax-chat-workflow-dispatch-slice2-design.md`.
