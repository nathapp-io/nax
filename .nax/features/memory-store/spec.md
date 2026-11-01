# SPEC: nax-agent memory store

## Summary

`@nathapp/nax-agent` gains a memory library under `src/memory/`: a Markdown
note model with frontmatter and validation (including secret refusal), a
file-backed mirror store with path confinement and atomic writes, a generated
`MEMORY.md` index under a byte and line cap, keyword search over the mirror, a
`MemoryProvider` seam with the built-in local provider, an outbox of
unacknowledged writes, a sync routine that drains the outbox and pulls the
provider's changes under a lock, and host-facing save / forget / approve
operations honouring the `direct | proposal` write mode. It ships no tools, no
CLI and no network provider: those are the next features (`memory-chat`,
`memory-koda-provider`, `memory-run-stages`, `memory-mcp-provider`). Every
public export is reachable from the package's `.` entry; the one `_*Deps`
seam from `./internal`.

Design: `docs/superpowers/specs/2026-11-02-nax-memory-design.md` (§6.1–6.5,
6.7, 6.11, 6.12; feature 1 of §8).

## Motivation

The native agent starts every session blank. The design makes koda the source
of truth for memory and has nax keep a per-project mirror so recall is file
based, works inside sandboxed run stages and survives koda being unreachable.
Everything that touches the mirror (note format, confinement, index, outbox,
sync, write policy) is pure library code that nax, the ACP server and koda's
runner all need, so it lands in nax-agent first, fully testable with an
injectable provider and no nax code.

## Design

### Approach

One new directory `packages/nax-agent/src/memory/` with one module per
concern and a barrel `index.ts`. Everything is Node-compatible
(`node:fs/promises`, `node:crypto`, `node:path`; no Bun API). Every
`NaxError` thrown here carries `{ stage: "memory" }` in its context; every
logger call uses stage `"memory"`. Every whole-file write in this feature
goes through `writeFileAtomic(path, text)` from `#src/internal/atomic-write`
(stages `<path>.<uuid>.tmp` beside the target, then `rename`; its
`_atomicWriteDeps` seam injects failures), so no module here names a temp
file itself; every directory listing ignores names ending in `.tmp`.
Containment checks use `isInside(root, path)` from `#src/internal/realpath`
(symlink-tolerant, never throws, a missing path compares by its raw
spelling).

#### Note model (`types.ts`, `note.ts`, `validate.ts`)

```ts
export type MemoryNoteType = "user" | "feedback" | "project" | "reference";
export type MemoryScope = "project" | "user";
export type MemoryNoteStatus = "active" | "pending" | "superseded" | "rejected" | "deleted";
export interface MemoryNote {
  readonly id: string;           // provider id, or the clientId of the write until synced
  readonly slug: string;         // MEMORY_SLUG_RE
  readonly type: MemoryNoteType;
  readonly scope: MemoryScope;
  readonly description: string;  // one line, <= MEMORY_DESCRIPTION_MAX_CHARS
  readonly source: string;       // one line, <= 64 chars: "nax-chat" | "nax-run" | "koda-thread" | "human" | "import" | any label
  readonly updatedAt: string;    // ISO 8601
  readonly status: MemoryNoteStatus;
  readonly body: string;         // Markdown, <= MEMORY_NOTE_BODY_MAX_BYTES (UTF-8)
}
export interface MemoryDecision {
  readonly id: string; readonly subject: string; readonly predicate: string;
  readonly object: string; readonly updatedAt: string; readonly status: "active" | "superseded" | "rejected";
}
export interface MemoryHit {
  readonly slug: string; readonly scope: MemoryScope; readonly type: MemoryNoteType;
  readonly description: string; readonly status: MemoryNoteStatus; readonly score: number; readonly snippet: string;
}
export interface MemoryNoteWrite { slug; type; scope; description; body }
export interface MemoryWriteRefusal { readonly field: "slug" | "type" | "description" | "body" | "source"; readonly reason: string }
export interface MemoryTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}
export const MEMORY_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MEMORY_CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const MEMORY_NOTE_BODY_MAX_BYTES = 8192;
export const MEMORY_DESCRIPTION_MAX_CHARS = 200;
export const MEMORY_SOURCE_MAX_CHARS = 64;
export const MEMORY_INDEX_MAX_BYTES = 24_576;
export const MEMORY_INDEX_MAX_LINES = 200;
export const MEMORY_INDEX_MIN_LINES = 16;
export const MEMORY_INDEX_MIN_BYTES = 512;
export const MEMORY_PROBE_TIMEOUT_MS = 2000;
export const MEMORY_OP_TIMEOUT_MS = 10_000;
export const MEMORY_PULL_PAGE_SIZE = 200;
export const MEMORY_PULL_MAX_PAGES = 50;
```

A note file is frontmatter between two `---` lines, one `key: value` per
line (the `MemoryNote` keys other than `body`, in any order; a value is
everything after the first `: `, so a description may itself contain `: `;
values are single-line plain scalars, no quoting, no nesting; an unknown key
is ignored), then one blank line, then the body. `parseMemoryNote(text)`
validates with a zod schema and throws `NaxError` code `MEMORY_NOTE_INVALID`
(message names the first bad key) on a missing, unknown-enum or
line-break-carrying field; `serializeMemoryNote(note)` writes the keys in the
order `id, slug, type, scope, description, source, updatedAt, status`, then
`---`, then a blank line, then the body (for an empty body the file ends
with `---\n`). The two round-trip. Example:

```markdown
---
id: mem_01J9X2
slug: replay-budget
type: project
scope: project
description: replay budget stays 2,048 MiB
source: nax-chat
updatedAt: 2026-11-02T08:11:00.000Z
status: active
---

The replay budget stays at 2,048 MiB. Next export append is due ~11-23.
```

`validateMemoryNoteWrite(write, source)` (`validate.ts`) returns `null` or a
`MemoryWriteRefusal`, checking in this order and stopping at the first
refusal: slug matches `MEMORY_SLUG_RE`; type is one of the four; description
non-empty, no line break or control character, within
`MEMORY_DESCRIPTION_MAX_CHARS`; source non-empty, no line break or control
character, within `MEMORY_SOURCE_MAX_CHARS`; body within
`MEMORY_NOTE_BODY_MAX_BYTES`; then secrets: `findSecret(text)` runs every
`SECRET_VALUE_PATTERNS` entry (from `#src/internal/redact`) over the
description and then the body, resetting `re.lastIndex = 0` before each use
of the global regex (so repeated calls never skip a match) and applying
`acceptMatch` to every match when present; the first accepted match refuses
with `field` naming the text and `reason` `secret (<kind>) must not be
stored`, never the matched text.

#### Mirror store (`store.ts`)

`createMemoryStore({ projectDir, userDir?, logger })` returns a `MemoryStore`:

```
<projectDir>/MEMORY.md        generated project index
<projectDir>/notes/<slug>.md  project-scope notes
<projectDir>/decisions.jsonl  one MemoryDecision JSON per line, read-only mirror
<projectDir>/sync.json        MemorySyncState
<projectDir>/sync.lock        sync lock
<projectDir>/outbox/          outbox entries
<userDir>/MEMORY.md           generated user index
<userDir>/notes/<slug>.md     user-scope notes (only when userDir is set)
```

```ts
export interface MemoryStorePaths {
  readonly projectDir: string; readonly userDir: string | null;
  readonly index: string; readonly notesDir: string; readonly decisions: string;
  readonly syncState: string; readonly lock: string; readonly outboxDir: string;
  readonly userIndex: string | null; readonly userNotesDir: string | null;
}
export interface MemorySyncState {
  readonly provider: string | null;
  readonly cursor: { readonly project: string | null; readonly user: string | null };
  readonly lastPullAt: string | null; readonly lastError: string | null;
}
export interface MemoryStore {
  readonly paths: MemoryStorePaths;
  readNote(scope, slug): Promise<MemoryNote | null>;
  writeNote(note): Promise<void>;
  deleteNote(scope, slug): Promise<void>;
  listNotes(scope): Promise<MemoryNote[]>;
  readDecisions(): Promise<MemoryDecision[]>;
  writeDecisions(decisions): Promise<void>;
  readSyncState(): Promise<MemorySyncState>;
  writeSyncState(state): Promise<void>;
  writeIndex(scope, text): Promise<void>;   // MEMORY.md of that scope
}
```

Rules: a slug failing `MEMORY_SLUG_RE` throws `NaxError` code
`MEMORY_SLUG_INVALID` before any filesystem call. A user-scope call on a
store without `userDir` throws `NaxError` code `MEMORY_SCOPE_UNAVAILABLE`.
Missing directories are not errors: `readNote` resolves `null`, `listNotes`
resolves `[]`, `deleteNote` resolves. Confinement: before any read or write
of a note, `isInside(scopeRoot, notesDir)` must hold and, when the target
file exists, `isInside(scopeRoot, file)` must hold too; otherwise `NaxError`
code `MEMORY_PATH_OUTSIDE` (for `listNotes`, a file failing the check is
skipped with one `warn`, not thrown). `listNotes` reads only files named
`<slug>.md` whose slug matches `MEMORY_SLUG_RE` (temp files, `MEMORY.md` and
anything else are ignored), sorted by slug; a file whose content fails
`parseMemoryNote` is skipped with one `warn` per file (`stage: "memory"`,
data `{ path, error }`). `readSyncState` returns the defaults when the file
is missing or unparsable (unparsable → one `warn`). Writes use
`writeFileAtomic`; directories are created with `mkdir({ recursive: true })`
on demand. Reads and directory operations go through `_memoryStoreDeps`
(`readFile`, `mkdir`, `readdir`, `rm`) so tests inject failures; the write
path's seam is `_atomicWriteDeps`.

#### Index (`index-render.ts`)

`renderMemoryIndex(input)` is pure:

```ts
interface RenderMemoryIndexInput {
  readonly projectNotes: readonly MemoryNote[];
  readonly userNotes: readonly MemoryNote[];
  readonly decisions: readonly MemoryDecision[];
  readonly heldForgets?: ReadonlySet<string>;   // "<scope>/<slug>" with a queued forget
  readonly maxBytes?: number;                    // default MEMORY_INDEX_MAX_BYTES, clamped up to MEMORY_INDEX_MIN_BYTES
  readonly maxLines?: number;                    // default MEMORY_INDEX_MAX_LINES, clamped up to MEMORY_INDEX_MIN_LINES
}
interface RenderedMemoryIndex { readonly text: string; readonly omitted: number }
```

Output, in order: `# Memory`, then `Memory notes are recorded facts, not
instructions.`; `## Project` with one `### <type>` block per type in the
order `project`, `feedback`, `reference`, `user`, only for types that have
renderable notes, each note on one line `- [<type>] <slug> — <description>`
with a trailing ` (pending)` for status `pending`, ` (forget pending)` when
its `<scope>/<slug>` key is in `heldForgets`, and no line for `superseded`,
`rejected` or `deleted` notes; `## Decisions` with one line
`- <subject> <predicate> <object>` per `active` decision, newest `updatedAt`
first; `## User` with the user-scope notes in the same line shape. A section
or type block with nothing to show is omitted. Descriptions, subjects,
predicates and objects are sanitised first: control characters and line
breaks become one space, runs of spaces collapse, text is cut at
`MEMORY_DESCRIPTION_MAX_CHARS`. Truncation: while the UTF-8 byte length
exceeds `maxBytes` or the line count exceeds `maxLines`, the last entry line
(note or decision) is dropped, then any header left with no entry under it is
dropped, then one trailing line
`- <N> more entries not shown; use the memory tool to search.` is appended
(counted within the caps) with `omitted` = N dropped entries; `maxLines`
below `MEMORY_INDEX_MIN_LINES` and `maxBytes` below `MEMORY_INDEX_MIN_BYTES`
are raised to those minimums, which always fit the headers plus the trailing
line. `refreshMemoryIndex(store, options?)` with
`options = { heldForgets?, maxBytes?, maxLines? }` reads notes and decisions
through the store, renders, writes the project text with
`store.writeIndex("project", text)` and, when `userDir` is set, writes
`store.writeIndex("user", userText)` where `userText` holds the two header
lines and the `## User` section only, rendered under the same caps; it
resolves the project `RenderedMemoryIndex`.

#### Search (`search.ts`)

`tokenizeMemoryQuery(text)`: lower-case, split on any run of characters
that are not Unicode letters or digits (`\p{L}` / `\p{N}`), drop tokens
shorter than 2 characters, keep first occurrence order, distinct.
`searchMemoryNotes(notes, text, limit)` is pure: the note's `slug` +
`description` and its `body` are tokenised the same way; a query token
matches a field group only as a whole token (`replay` does not match
`replays`). Score = 2 × distinct query tokens present in the
slug/description group + 1 × distinct query tokens present in the body
group. Notes with score 0 and notes whose status is not `active` or
`pending` are excluded. Order: score descending, `updatedAt` descending, slug
ascending; at most `limit`. `snippet` = the first body line containing any
query token as a whole token, cut at 160 characters, else `""`. An empty or
token-less query returns `[]`.

#### Provider seam (`provider-types.ts`, `local-provider.ts`)

```ts
export interface MemoryWriteRequest {
  readonly kind: "save" | "forget";
  readonly clientId: string;          // MEMORY_CLIENT_ID_RE; idempotency key
  readonly scope: MemoryScope;
  readonly slug: string;
  readonly writeMode: "direct" | "proposal";
  readonly note?: MemoryNote;         // present for "save"
  readonly reason?: string;           // present for "forget"
}
export interface MemoryPushResult { readonly id: string; readonly status: MemoryNoteStatus }
export interface MemoryPage {
  readonly notes: readonly MemoryNote[];       // tombstones carry status superseded | rejected | deleted
  readonly decisions?: readonly MemoryDecision[];  // honoured on project pages only
  readonly nextCursor?: string;
  readonly done: boolean;
}
export interface MemoryProvider {
  readonly id: string;
  pull(input: { scope: MemoryScope; cursor: string | null; take: number }): Promise<MemoryPage>;
  push(request: MemoryWriteRequest): Promise<MemoryPushResult>;
  search?(input: { scope: MemoryScope; text: string; limit: number }): Promise<readonly MemoryHit[]>;
  reachable(): Promise<boolean>;
}
```

A provider that refuses a write for a reason retrying cannot fix throws
`NaxError` code `MEMORY_PUSH_REJECTED` (message = the reason);
`isMemoryPushRejected(error)` recognises it. Any other throw or a timeout is
transient. `createLocalMemoryProvider(store)` has `id: "local"`; `pull`
resolves `{ notes: [], done: true }`; `push` of a `save` writes the note with
`status: "active"` under `direct` and `"pending"` under `proposal`, resolving
`{ id: request.note.id, status }`; `push` of a `forget` deletes the note under
`direct` and leaves it in place under `proposal`, resolving
`{ id: request.clientId, status: "deleted" | "pending" }`; a `save` without a
`note` throws `MEMORY_PUSH_REJECTED`; `reachable` resolves `true`; no `search`.

#### Outbox (`outbox.ts`)

`createMemoryOutbox({ dir, now? })` (dir = `store.paths.outboxDir`) returns:

```ts
interface MemoryOutbox {
  enqueue(request: Omit<MemoryWriteRequest, "clientId"> & { clientId?: string }): Promise<MemoryOutboxEntry>;
  list(): Promise<MemoryOutboxEntry[]>;
  listInvalid(): Promise<string[]>;
  remove(clientId: string): Promise<void>;
  markRejected(clientId: string, reason: string): Promise<void>;
  heldKeys(kind?: "save" | "forget"): Promise<ReadonlySet<string>>;   // "<scope>/<slug>" of queued entries
}
type MemoryOutboxEntry = MemoryWriteRequest & { seq: number; enqueuedAt: string; state: "queued" | "rejected"; reason?: string };
```

`enqueue` assigns `clientId` with `randomUUID()` when absent and otherwise
validates it against `MEMORY_CLIENT_ID_RE` (`NaxError` code
`MEMORY_CLIENT_ID_INVALID`). Enqueues on one outbox instance are serialised
through an internal promise chain, so `seq` = 1 + the highest `seq` among
existing entry files (0 when none) is unique even for concurrent callers;
the file is `<dir>/<seq padded to 8 digits>-<clientId>.json` written with
`writeFileAtomic`. `list` reads only files matching
`^\d{8}-[A-Za-z0-9_-]+\.json$`, orders by `seq` ascending then `clientId`
ascending; a matching file that is not valid JSON or fails the entry schema
is excluded from `list` and returned by `listInvalid` (file names). `remove`
deletes the entry file (no-op when absent). `markRejected` rewrites the entry
with `state: "rejected"` and `reason`. `heldKeys(kind)` returns the keys of
`queued` entries, filtered by `kind` when given. Directory operations go
through `_memoryStoreDeps` (`mkdir`, `readdir`, `readFile`, `rm`).

#### Sync (`sync.ts`)

`syncMemory(input)` with
`{ store, outbox, provider, logger, now?, timers?: MemoryTimers, pid?, isAlive?, pageSize? }`
(defaults: `now` = `() => new Date()`, `timers` = the globals, `pid` =
`process.pid`, `isAlive` = `isProcessAlive` from `#src/internal/process-alive`,
`pageSize` = `MEMORY_PULL_PAGE_SIZE`) returns
`MemorySyncResult = { outcome: "synced" | "unreachable" | "locked" | "failed"; pushed: number; rejected: number; pulled: number; skipped: number; error?: string }`
and never throws. Steps:

1. **Lock.** Synchronously, before the first `await`, check a module-level
   in-flight set keyed by `store.paths.lock`: a key already present returns
   `outcome: "locked"` without touching the filesystem; otherwise the key is
   added. Then `mkdir(projectDir, { recursive: true })`, then
   `acquireSessionLock(store.paths.lock, { dir: projectDir, pid, now, logger, isAlive }, isAlive)`
   from `#src/session-store/index` (re-exported from the lock module by
   US-011). It throws `NaxError` code `SESSION_LOCKED` when another process
   holds the lock live; that is caught and returned as `outcome: "locked"`.
   A stale holder is taken over by the call itself.
2. **Probe.** `provider.reachable()` through `raceTimeout(.., MEMORY_PROBE_TIMEOUT_MS, timers)`
   (the race clears its timer when either side settles, so a fake clock has
   no pending timer afterwards). `false`, a throw or a timeout → write
   `sync.json` with only `lastError: "unreachable"` changed (cursors kept) →
   `outcome: "unreachable"`, outbox untouched.
3. **Drain.** For each `queued` entry from `outbox.list()` in order: `push`
   through `raceTimeout(.., MEMORY_OP_TIMEOUT_MS)`. Success → for a `save`,
   rewrite the mirrored note with the returned `id` and `status`; for a
   `forget`, delete the mirrored note only when the returned `status` is
   `"deleted"`; then `remove(clientId)`, `pushed++`. `MEMORY_PUSH_REJECTED` →
   `markRejected(clientId, message)`, `rejected++`, mirror untouched,
   continue. Any other error or timeout → stop draining (the entry stays
   `queued`), write `lastError` = the message, skip step 4, go to step 5 with
   `outcome: "failed"`.
4. **Pull.** For `scope: "project"` then, when `userDir` is set, `"user"`:
   starting from `syncState.cursor[scope]`, call
   `provider.pull({ scope, cursor, take: pageSize })` until `done`, at most
   `MEMORY_PULL_MAX_PAGES` pages per scope (the limit reached → `lastError`
   `"pull page limit reached"`, `outcome: "failed"`, cursor kept at the last
   page). Each call goes through `raceTimeout(.., MEMORY_OP_TIMEOUT_MS)`.
   After each page returns, `outbox.heldKeys()` is read afresh. For each
   returned note: a slug failing `MEMORY_SLUG_RE` or a note failing the
   `MemoryNote` schema → `skipped++` with one `warn`; a key in the held set
   → skipped silently (not counted); a tombstone
   (`superseded | rejected | deleted`) → `deleteNote`; otherwise `writeNote`,
   `pulled++`. `decisions` on a project page replace `decisions.jsonl`;
   `decisions` on a user page are ignored. After each page `sync.json` is
   written with `cursor[scope] = nextCursor ?? previous`, `lastPullAt = now`,
   `lastError: null`, `provider = provider.id`. A throw or timeout mid-pull
   keeps the last written cursor, writes `lastError`, and yields
   `outcome: "failed"` (the other scope is not pulled).
5. **Finish.** `refreshMemoryIndex(store, { heldForgets: await outbox.heldKeys("forget") })`,
   release the lock and remove the in-flight key (always, in `finally`),
   return. Any unexpected throw in steps 2–5 is caught, logged at `warn`,
   and returned as `outcome: "failed"` with `error` = the message.

`raceTimeout(promise, ms, timers)` lives in `sync.ts`: it resolves with the
promise's value when it settles first and clears the timer, and rejects with
`NaxError` code `MEMORY_TIMEOUT` when the timer fires first. `setTimeout`
here is the cancellable kind (documented at the call site, the
forbidden-patterns exception). There is no `_memorySyncDeps` seam: every
external dependency is an input.

#### Operations (`operations.ts`)

Shared inputs: `{ store, outbox, provider, logger, now?, timers? }`.

- `saveMemoryNote(input & { write: MemoryNoteWrite; writeMode; source })`:
  `validateMemoryNoteWrite(write, source)` refusal → throw `NaxError` code
  `MEMORY_WRITE_REFUSED` (message = reason), nothing written. Read the
  existing note for `(scope, slug)` (`previous`). Build the note: `id` =
  `randomUUID()`, `status` = `active` under `direct` / `pending` under
  `proposal`, `updatedAt` = `now()`. Write it to the mirror. If the outbox
  already holds a `queued` entry for the same key, enqueue behind it and
  return `{ slug, status, delivered: false }` (ordering is preserved). Else
  probe (`reachable` through `raceTimeout(.., MEMORY_PROBE_TIMEOUT_MS)`),
  then `push` through `raceTimeout(.., MEMORY_OP_TIMEOUT_MS)` with a `save`
  request whose `clientId` is the note's `id`. Success → rewrite the mirrored
  note with the returned `id` and `status` → `{ slug, status, delivered: true }`.
  `MEMORY_PUSH_REJECTED` → restore `previous` (delete the note when there was
  none) and rethrow. Unreachable (`false`, a throw or a timeout), a push
  timeout or any other push error → enqueue the request →
  `{ slug, status, delivered: false }`. Always
  `refreshMemoryIndex(store, { heldForgets: await outbox.heldKeys("forget") })`
  before returning.
- `forgetMemoryNote(input & { scope; slug; reason; writeMode })`: missing
  note → `NaxError` code `MEMORY_NOTE_NOT_FOUND`. Under `direct` the mirrored
  note is deleted first (kept as `previous`); under `proposal` it stays. A
  `queued` entry for the key → enqueue behind it, `delivered: false`. Else
  probe + `push` of a `forget` request (`clientId` = `randomUUID()`,
  `reason`). Success → `{ slug, status: result.status, delivered: true }`.
  `MEMORY_PUSH_REJECTED` → restore `previous` under `direct`, rethrow.
  Unreachable, timeout or other error → enqueue → `delivered: false`. Always
  refresh the index with the current forget keys.
- `approveMemoryNote({ store, scope, slug, now? })`: `pending` → rewritten
  `active` with `updatedAt` = `now()`, index refreshed, returned; `active` →
  returned unchanged; missing, or status `superseded | rejected | deleted` →
  `NaxError` code `MEMORY_NOTE_NOT_FOUND`.

### Integration

Read-only symbols the feature builds on (verified 2026-11-02):

- `SECRET_VALUE_PATTERNS: readonly SecretValuePattern[]`,
  `{ kind; re: RegExp (global flag); acceptMatch? }` —
  `packages/nax-agent/src/internal/redact.ts:36-43,118-121` (the
  `url-credentials` entry matches any word and relies on `acceptMatch`).
- `writeFileAtomic(path, content, options?)` and `_atomicWriteDeps`
  (`writeFile`, `rename`, `rm`) — `packages/nax-agent/src/internal/atomic-write.ts:23-45`
  (stages `<path>.<uuid>.tmp`, renames, removes the stage on failure).
- `isInside(root, filePath)` and `realOrRaw(p)` —
  `packages/nax-agent/src/internal/realpath.ts:31,49` (never throw).
- `acquireSessionLock(path, deps: SessionStorageDeps, isAlive): () => Promise<void>`
  throwing `NaxError` code `SESSION_LOCKED` for a live holder
  (`session-lock.ts:62-63,101,109`); `SessionStorageDeps { dir; pid; now; logger; setInterval?; isAlive? }`
  (`:10-17`); `holderState` returns `"own"` for the same pid (`:88`), which is
  why the in-flight set exists.
- `isProcessAlive(pid)` — `packages/nax-agent/src/internal/process-alive.ts:43`.
- `NaxError` — `#src/infra/nax-error`; `errorMessage` — `#src/infra/errors`;
  `AgentLogger` — `#src/infra/agent-logger.ts:11-16`.
- Test helpers: `makeFakeClock` (`advance(ms)`, `pending()`) and
  `waitForCondition(predicate, timeoutMs, pollMs)` from
  `@nathapp/nax-test-kit/bun/*`, re-exported by `packages/nax-agent/test/helpers/index.ts:6-7,22`;
  `makeTempDir` / `cleanupTempDir` from `@nathapp/nax-test-kit/bun/temp`;
  `makeLogger` from `#test/helpers/agent-logger`.

Mutated files (baseline only locates the code; the target is the interface):

- `packages/nax-agent/src/index.ts` — Baseline: named exports, none starting
  with `_`. Target: additionally exports every public symbol listed in each
  story's Creates (types with `export type`).
- `packages/nax-agent/src/internal.ts` — Baseline: re-exports the `_*Deps`
  seams. Target: additionally re-exports `_memoryStoreDeps` (US-003).
- `packages/nax-agent/src/session-store/index.ts` — Baseline: exports lock
  constants, meta and storage names. Target: additionally exports
  `acquireSessionLock` from `./session-lock.ts` (US-011).
- `packages/nax-agent/api/nax-agent.api.txt` — regenerated with
  `bun run api:update` by every story that adds a public or internal export.

Fake-clock test pattern for the timeout ACs (US-012 and later): the timer is
armed only after real awaits (lock, `mkdir`, outbox reads), so a test first
`await waitForCondition(() => clock.pending() > 0)`, then
`await clock.advance(ms)`, then awaits the sync or operation promise itself
(`advance` drains microtasks only; the rest is real filesystem I/O); after
the race settles, `clock.pending()` is 0 again. `makeFakeClock()` satisfies
`MemoryTimers` directly.

### Failure Handling

| Situation | Behaviour |
|---|---|
| Note file with malformed frontmatter in the mirror | `listNotes` skips it with one `warn` per file; `readNote` throws `MEMORY_NOTE_INVALID` |
| Slug outside `MEMORY_SLUG_RE`; notes dir or existing file outside the scope root | `MEMORY_SLUG_INVALID` / `MEMORY_PATH_OUTSIDE`, nothing touched; a file outside the root is skipped by `listNotes` with one `warn` |
| Notes directory, decisions file, sync state or outbox directory missing | reads resolve `null` / `[]` / defaults; deletes and removes resolve; writes create the directory |
| Secret, bad slug, bad description, bad source or oversized body in a save | `validateMemoryNoteWrite` refusal → `MEMORY_WRITE_REFUSED`, nothing written |
| Provider unreachable (`false`, throw or timeout), or a transient push/pull error or timeout | sync returns `unreachable` / `failed`, entries stay queued, cursors kept; save/forget enqueue and report `delivered: false` |
| Provider rejects a push (`MEMORY_PUSH_REJECTED`) | sync marks the entry `rejected`, mirror untouched; save/forget restore the previous note and rethrow |
| Lock held live by another process, or a sync already in flight in this process | sync returns `locked`, does nothing |
| Pulled note with an invalid slug or an invalid shape | skipped with one `warn`, counted in `skipped`, cursor advances |
| Provider never reports `done` | stop after `MEMORY_PULL_MAX_PAGES`, `failed`, cursor kept |
| Index over the byte or line cap | entries dropped from the end, empty headers dropped, trailing "N more" line, `omitted` reported; caps below the minimums are raised |
| Unparsable outbox file or `sync.json` | outbox: excluded from `list`, named by `listInvalid`; sync state: defaults with one `warn` |
| Unexpected throw inside sync after the lock | caught, `warn`, `outcome: "failed"` with `error`, lock released |

## Out of Scope

- The `nax-memory` tool provider, its tools and the chat `## Memory` instructions section are the `memory-chat` feature, not this one.
- The koda HTTP provider, the generic MCP provider and any network code are the `memory-koda-provider` and `memory-mcp-provider` features; this feature ships only the `local` provider and an injectable `MemoryProvider` interface.
- Run-stage context injection and run-host sync are the `memory-run-stages` feature.
- The `nax memory` CLI, `/memory` slash command and the `memory` config schema belong to nax (`memory-chat`); nax-agent takes `projectDir` / `userDir` as plain arguments and computes no `~/.nax` path and no project key.
- Repo-committed `.nax/memory/*.md` team notes are read by nax (`memory-chat`), not by this store.
- No background consolidation, no auto-extraction from transcripts, no embeddings or vector search: search is keyword only, whole-token matching.
- Automatic retry of a `rejected` outbox entry is out of scope; a later CLI may requeue it.
- A `forget` under `proposal` mode does not change the note's `status`; it is shown as `(forget pending)` from the outbox only.
- Multi-line or quoted frontmatter values and YAML nesting are not supported; values are single-line scalars.
- `search` on the local provider is not implemented; keyword search runs over the mirror through `searchMemoryNotes`.
- The decisions mirror is read-only here: only sync writes it, and only from project pages.
- The timeout, page-size, page-limit and index-minimum constants are not configurable in this feature.
- A rejected `save` found by sync leaves the mirrored note as it is (the next pull brings the provider's view); only the direct save path restores the previous note.
- Cross-process serialisation of `enqueue` is not provided: two processes enqueueing at once may produce equal `seq` values, which `list` orders by `clientId`.

## Stories

Feature size: 19 stories, one capability (the memory store library), sized
to the 24-assertion gate. All run in `packages/nax-agent`. Every story
appends its exports to the `src/memory/index.ts` barrel created by US-001.

**US-001: Note format.** No dependencies. Workdir: `packages/nax-agent`. Creates `src/memory/types.ts` (all types and constants above, including `MemoryHit` and `MemoryTimers`), `src/memory/note.ts` (`parseMemoryNote`, `serializeMemoryNote`, `isMemoryPushRejected`) and the `src/memory/index.ts` barrel; exports them from `src/index.ts` and refreshes the API snapshot.

**US-002: Write validation and secret refusal.** Depends on US-001. Workdir: `packages/nax-agent`. Creates `src/memory/validate.ts` (`validateMemoryNoteWrite`, `findSecret`); exports from `src/index.ts`, refreshes the API snapshot.

**US-003: Mirror store: paths and notes.** Depends on US-001. Workdir: `packages/nax-agent`. Creates `src/memory/store.ts` (`createMemoryStore`, `MemoryStore`, `MemoryStorePaths`, `_memoryStoreDeps`) with `paths`, `readNote`, `writeNote`, `deleteNote`, `listNotes` (slug validation, user scope, missing directories, malformed-file skipping, temp-file and index-file filtering, writes through `writeFileAtomic`); exports the public names from `src/index.ts`, the seam from `src/internal.ts`, refreshes the API snapshot and the public-surface seam list. Confinement is US-004.

**US-004: Mirror store: confinement.** Depends on US-003. Workdir: `packages/nax-agent`. Adds to `src/memory/store.ts` the `isInside` confinement of the notes directory and of an existing target file (`MEMORY_PATH_OUTSIDE`, skip-with-warn in `listNotes`) and the pre-filesystem slug check (`MEMORY_SLUG_INVALID`), plus the atomic-write failure behaviour through `_atomicWriteDeps`.

**US-005: Mirror store: decisions, sync state, index file.** Depends on US-004. Workdir: `packages/nax-agent`. Adds `readDecisions`, `writeDecisions`, `readSyncState`, `writeSyncState`, `writeIndex` and `MemorySyncState` to `src/memory/store.ts`; exports the type from `src/index.ts`, refreshes the API snapshot.

**US-006: Index rendering: order and line format.** Depends on US-005. Workdir: `packages/nax-agent`. Creates `src/memory/index-render.ts` with `renderMemoryIndex` (sections, type order, line shape, pending and forget markers, status filtering, decisions ordering, user section, sanitising) and `RenderMemoryIndexInput` / `RenderedMemoryIndex`; truncation is a stub that returns the full text with `omitted: 0` until US-007; exports from `src/index.ts`, refreshes the API snapshot.

**US-007: Index truncation and refresh.** Depends on US-006. Workdir: `packages/nax-agent`. Adds truncation (byte and line caps, minimum clamps, empty-header dropping, trailing line, `omitted`) and `refreshMemoryIndex` to `src/memory/index-render.ts`; exports `refreshMemoryIndex` from `src/index.ts`, refreshes the API snapshot.

**US-008: Keyword search over notes.** Depends on US-001. Workdir: `packages/nax-agent`. Creates `src/memory/search.ts` (`searchMemoryNotes`, `tokenizeMemoryQuery`); exports from `src/index.ts`, refreshes the API snapshot.

**US-009: Provider seam and the local provider.** Depends on US-003. Workdir: `packages/nax-agent`. Creates `src/memory/provider-types.ts` (`MemoryProvider`, `MemoryWriteRequest`, `MemoryPushResult`, `MemoryPage`) and `src/memory/local-provider.ts` (`createLocalMemoryProvider`); exports from `src/index.ts`, refreshes the API snapshot.

**US-010: Outbox of unacknowledged writes.** Depends on US-009. Workdir: `packages/nax-agent`. Creates `src/memory/outbox.ts` (`createMemoryOutbox`, `MemoryOutbox`, `MemoryOutboxEntry`); exports from `src/index.ts`, refreshes the API snapshot.

**US-011: Sync: lock, in-flight guard and never-throws shell.** Depends on US-007, US-010. Workdir: `packages/nax-agent`. Creates `src/memory/sync.ts` (`syncMemory`, `MemorySyncResult`) implementing step 1 and step 5 of the sync design with steps 2, 3 and 4 as placeholders (step 2 treats the provider as reachable) that US-012, US-013 and US-014 fill, plus the scripted fake provider helper `test/helpers/memory-provider.ts` (`makeMemoryProvider(overrides?)`); re-exports `acquireSessionLock` from the session-store barrel; exports from `src/index.ts`, refreshes the API snapshot.

**US-012: Sync: timeout race and probe.** Depends on US-011. Workdir: `packages/nax-agent`. Adds `raceTimeout` to `src/memory/sync.ts` and fills step 2 (probe through the race, `unreachable` outcome, cursors kept); exports `raceTimeout` from `src/index.ts`, refreshes the API snapshot.

**US-013: Sync: outbox drain.** Depends on US-012. Workdir: `packages/nax-agent`. Fills step 3 in `src/memory/sync.ts`: pushes in `seq` order, save and forget application, rejection marking, transient failure stopping the drain and skipping the pull, forget keys reaching the index.

**US-014: Sync: pull cursors and paging.** Depends on US-013. Workdir: `packages/nax-agent`. Fills step 4 in `src/memory/sync.ts` for the cursor and paging behaviour: page sequence, cursor persistence, page limit, drain-then-pull order, timeout and mid-pull failure.

**US-015: Sync: applying pulled notes.** Depends on US-014. Workdir: `packages/nax-agent`. Completes step 4 in `src/memory/sync.ts`: tombstones, held keys read after each page, invalid notes skipped, decisions on project pages only, the user scope.

**US-016: Save: delivered path and validation.** Depends on US-002, US-015. Workdir: `packages/nax-agent`. Creates `src/memory/operations.ts` with `saveMemoryNote` and `MemorySaveResult` for the validated, delivered and proposal cases; exports from `src/index.ts`, refreshes the API snapshot.

**US-017: Save: undelivered and rejected paths.** Depends on US-016. Workdir: `packages/nax-agent`. Adds to `saveMemoryNote` in `src/memory/operations.ts` the unreachable, timeout, transient-error, queued-behind and rejected branches.

**US-018: Forget operation.** Depends on US-017. Workdir: `packages/nax-agent`. Adds `forgetMemoryNote` and `MemoryForgetResult` to `src/memory/operations.ts`; exports from `src/index.ts`, refreshes the API snapshot.

**US-019: Approve operation and offline round trips.** Depends on US-018. Workdir: `packages/nax-agent`. Adds `approveMemoryNote` to `src/memory/operations.ts` and the integration tests that take an offline save and an offline forget through `syncMemory`; exports from `src/index.ts`, refreshes the API snapshot.

### Context Files

**US-001**
- `packages/nax-agent/src/infra/nax-error.ts` — `NaxError` with codes and context
- `packages/nax-agent/src/session-store/session-meta.ts` — zod schema style for a small on-disk record
- `packages/nax-agent/src/index.ts` — the public entry, named exports only
- `packages/nax-agent/test/unit/session-store/storage.test.ts` — test style (`makeTempDir`, `makeLogger`, `#src/index`)

**US-002**
- `packages/nax-agent/src/memory/types.ts` — created by US-001
- `packages/nax-agent/src/internal/redact.ts` — `SECRET_VALUE_PATTERNS`, global flag, `acceptMatch`, `url-credentials`
- `packages/nax-agent/src/index.ts`

**US-003**
- `packages/nax-agent/src/memory/note.ts` — created by US-001, parse/serialize used here
- `packages/nax-agent/src/internal/atomic-write.ts` — `writeFileAtomic`
- `packages/nax-agent/src/internal.ts` — seam re-exports
- `packages/nax-agent/src/infra/agent-logger.ts` — `AgentLogger`
- `packages/nax-agent/test/unit/packaging/public-surface.test.ts` — the `SEAMS` list

**US-004**
- `packages/nax-agent/src/memory/store.ts` — created by US-003, extended here
- `packages/nax-agent/src/internal/realpath.ts` — `isInside`
- `packages/nax-agent/src/internal/atomic-write.ts` — `_atomicWriteDeps`

**US-005**
- `packages/nax-agent/src/memory/store.ts` — created by US-003, extended here
- `packages/nax-agent/src/memory/types.ts` — created by US-001
- `packages/nax-agent/src/index.ts`

**US-006**
- `packages/nax-agent/src/memory/types.ts` — created by US-001
- `packages/nax-agent/src/index.ts`

**US-007**
- `packages/nax-agent/src/memory/index-render.ts` — created by US-006, extended here
- `packages/nax-agent/src/memory/store.ts` — created by US-003, `writeIndex` from US-005
- `packages/nax-agent/src/index.ts`

**US-008**
- `packages/nax-agent/src/memory/types.ts` — created by US-001 (`MemoryHit`)
- `packages/nax-agent/src/index.ts`

**US-009**
- `packages/nax-agent/src/memory/store.ts` — created by US-003
- `packages/nax-agent/src/memory/note.ts` — created by US-001 (`isMemoryPushRejected`)
- `packages/nax-agent/src/index.ts`

**US-010**
- `packages/nax-agent/src/memory/provider-types.ts` — created by US-009 (`MemoryWriteRequest`)
- `packages/nax-agent/src/memory/store.ts` — created by US-003 (`_memoryStoreDeps`)
- `packages/nax-agent/src/internal/atomic-write.ts` — `writeFileAtomic`
- `packages/nax-agent/src/index.ts`

**US-011**
- `packages/nax-agent/src/memory/outbox.ts` — created by US-010
- `packages/nax-agent/src/memory/index-render.ts` — created by US-006
- `packages/nax-agent/src/memory/local-provider.ts` — created by US-009
- `packages/nax-agent/src/session-store/session-lock.ts` — `acquireSessionLock`, `SESSION_LOCKED`, same-pid holder
- `packages/nax-agent/src/internal/process-alive.ts` — `isProcessAlive`

**US-012**
- `packages/nax-agent/src/memory/sync.ts` — created by US-011
- `packages/nax-agent/test/helpers/memory-provider.ts` — created by US-011
- `packages/nax-agent/src/index.ts`

**US-013**
- `packages/nax-agent/src/memory/sync.ts` — created by US-011
- `packages/nax-agent/src/memory/outbox.ts` — created by US-010
- `packages/nax-agent/test/helpers/memory-provider.ts` — created by US-011

**US-014**
- `packages/nax-agent/src/memory/sync.ts` — created by US-011
- `packages/nax-agent/src/memory/store.ts` — created by US-003
- `packages/nax-agent/test/helpers/memory-provider.ts` — created by US-011

**US-015**
- `packages/nax-agent/src/memory/sync.ts` — created by US-011
- `packages/nax-agent/src/memory/outbox.ts` — created by US-010
- `packages/nax-agent/test/helpers/memory-provider.ts` — created by US-011

**US-016**
- `packages/nax-agent/src/memory/sync.ts` — created by US-011 (`raceTimeout`)
- `packages/nax-agent/src/memory/validate.ts` — created by US-002
- `packages/nax-agent/src/memory/index-render.ts` — created by US-006
- `packages/nax-agent/test/helpers/memory-provider.ts` — created by US-011

**US-017**
- `packages/nax-agent/src/memory/operations.ts` — created by US-016
- `packages/nax-agent/src/memory/outbox.ts` — created by US-010
- `packages/nax-agent/test/helpers/memory-provider.ts` — created by US-011

**US-018**
- `packages/nax-agent/src/memory/operations.ts` — created by US-016
- `packages/nax-agent/src/memory/outbox.ts` — created by US-010
- `packages/nax-agent/test/helpers/memory-provider.ts` — created by US-011

**US-019**
- `packages/nax-agent/src/memory/operations.ts` — created by US-016
- `packages/nax-agent/src/memory/sync.ts` — created by US-011
- `packages/nax-agent/test/helpers/memory-provider.ts` — created by US-011

### Creates

**US-001**
- `packages/nax-agent/src/memory/types.ts`
- `packages/nax-agent/src/memory/note.ts`
- `packages/nax-agent/src/memory/index.ts`
- `packages/nax-agent/test/unit/memory/note.test.ts`

**US-002**
- `packages/nax-agent/src/memory/validate.ts`
- `packages/nax-agent/test/unit/memory/validate.test.ts`

**US-003**
- `packages/nax-agent/src/memory/store.ts`
- `packages/nax-agent/test/unit/memory/store.test.ts`

**US-004**
- `packages/nax-agent/test/unit/memory/store-confinement.test.ts`

**US-005**
- `packages/nax-agent/test/unit/memory/store-records.test.ts`

**US-006**
- `packages/nax-agent/src/memory/index-render.ts`
- `packages/nax-agent/test/unit/memory/index-render.test.ts`

**US-007**
- `packages/nax-agent/test/unit/memory/index-render-truncation.test.ts`

**US-008**
- `packages/nax-agent/src/memory/search.ts`
- `packages/nax-agent/test/unit/memory/search.test.ts`

**US-009**
- `packages/nax-agent/src/memory/provider-types.ts`
- `packages/nax-agent/src/memory/local-provider.ts`
- `packages/nax-agent/test/unit/memory/local-provider.test.ts`

**US-010**
- `packages/nax-agent/src/memory/outbox.ts`
- `packages/nax-agent/test/unit/memory/outbox.test.ts`

**US-011**
- `packages/nax-agent/src/memory/sync.ts`
- `packages/nax-agent/test/helpers/memory-provider.ts`
- `packages/nax-agent/test/unit/memory/sync.test.ts`

**US-012**
- `packages/nax-agent/test/unit/memory/sync-probe.test.ts`

**US-013**
- `packages/nax-agent/test/unit/memory/sync-drain.test.ts`

**US-014**
- `packages/nax-agent/test/unit/memory/sync-pull.test.ts`

**US-015**
- `packages/nax-agent/test/unit/memory/sync-apply.test.ts`

**US-016**
- `packages/nax-agent/src/memory/operations.ts`
- `packages/nax-agent/test/unit/memory/operations.test.ts`

**US-017**
- `packages/nax-agent/test/unit/memory/operations-undelivered.test.ts`

**US-018**
- `packages/nax-agent/test/unit/memory/operations-forget.test.ts`

**US-019**
- `packages/nax-agent/test/unit/memory/operations-approve.test.ts`
- `packages/nax-agent/test/integration/memory-offline-roundtrip.test.ts`

### Modifies

**US-001**
- `packages/nax-agent/src/index.ts` — add the named exports of the memory barrel created by this story (types via `export type`); no underscore-prefixed name on the public entry.
- `packages/nax-agent/api/nax-agent.api.txt` — regenerate with `bun run api:update` so `check:api` sees the new public names.

**US-002**
- `packages/nax-agent/src/index.ts` — add `validateMemoryNoteWrite` and `findSecret`.
- `packages/nax-agent/api/nax-agent.api.txt` — regenerate with `bun run api:update`.

**US-003**
- `packages/nax-agent/src/index.ts` — add `createMemoryStore` and the `MemoryStore` / `MemoryStorePaths` types.
- `packages/nax-agent/src/internal.ts` — add `_memoryStoreDeps` to the seam re-exports.
- `packages/nax-agent/api/nax-agent.api.txt` — regenerate with `bun run api:update`; both the public and the internal sections change.
- `packages/nax-agent/test/unit/packaging/public-surface.test.ts` — the `SEAMS` array and its `toHaveLength(20)` assertion pin the seam count; add `_memoryStoreDeps` and change the expected length to 21 (the invariant is "every seam in the list is exported from the internal entry", not the number 20).

**US-005**
- `packages/nax-agent/src/index.ts` — add `MemorySyncState`.
- `packages/nax-agent/api/nax-agent.api.txt` — regenerate with `bun run api:update`.

**US-006**
- `packages/nax-agent/src/index.ts` — add `renderMemoryIndex` and its types.
- `packages/nax-agent/api/nax-agent.api.txt` — regenerate with `bun run api:update`.

**US-007**
- `packages/nax-agent/src/index.ts` — add `refreshMemoryIndex`.
- `packages/nax-agent/api/nax-agent.api.txt` — regenerate with `bun run api:update`.

**US-008**
- `packages/nax-agent/src/index.ts` — add `searchMemoryNotes` and `tokenizeMemoryQuery`.
- `packages/nax-agent/api/nax-agent.api.txt` — regenerate with `bun run api:update`.

**US-009**
- `packages/nax-agent/src/index.ts` — add `createLocalMemoryProvider` and the provider types.
- `packages/nax-agent/api/nax-agent.api.txt` — regenerate with `bun run api:update`.

**US-010**
- `packages/nax-agent/src/index.ts` — add `createMemoryOutbox` and the outbox types.
- `packages/nax-agent/api/nax-agent.api.txt` — regenerate with `bun run api:update`.

**US-011**
- `packages/nax-agent/src/session-store/index.ts` — add `acquireSessionLock` to the names exported from the lock module, so sync imports it through the barrel.
- `packages/nax-agent/src/index.ts` — add `syncMemory` and `MemorySyncResult`.
- `packages/nax-agent/api/nax-agent.api.txt` — regenerate with `bun run api:update`.
- `packages/nax-agent/test/helpers/index.ts` — export `makeMemoryProvider` from the new helper file.

**US-012**
- `packages/nax-agent/src/index.ts` — add `raceTimeout`.
- `packages/nax-agent/api/nax-agent.api.txt` — regenerate with `bun run api:update`.

**US-016**
- `packages/nax-agent/src/index.ts` — add `saveMemoryNote` and `MemorySaveResult`.
- `packages/nax-agent/api/nax-agent.api.txt` — regenerate with `bun run api:update`.

**US-018**
- `packages/nax-agent/src/index.ts` — add `forgetMemoryNote` and `MemoryForgetResult`.
- `packages/nax-agent/api/nax-agent.api.txt` — regenerate with `bun run api:update`.

**US-019**
- `packages/nax-agent/src/index.ts` — add `approveMemoryNote`.
- `packages/nax-agent/api/nax-agent.api.txt` — regenerate with `bun run api:update`.

US-004, US-005, US-007, US-012 to US-015, US-017, US-018 and US-019 also
change files created by earlier stories of this feature (`src/memory/store.ts`,
`src/memory/index-render.ts`, `src/memory/sync.ts`, `src/memory/operations.ts`);
those files do not exist at plan time, so they are named in the story text
rather than here.

### Seams

- US-003 → US-001: the store reads and writes files through `parseMemoryNote` / `serializeMemoryNote` (US-003 round-trip AC).
- US-007 → US-005: `refreshMemoryIndex` writes through `store.writeIndex` (US-007 AC stubbing `writeIndex` and asserting its arguments).
- US-009 → US-003: the local provider's `push` lands in the store (US-009 AC reading back through `store.readNote`).
- US-011 → US-007: `syncMemory` ends by rewriting `store.paths.index` (US-011 AC on the file).
- US-012 → US-009: `syncMemory` calls `provider.reachable` through `raceTimeout` (US-012 ACs).
- US-013 → US-009/US-010: `syncMemory` calls `provider.push`, `outbox.list/remove/markRejected` (US-013 ACs).
- US-014 → US-009/US-005: `syncMemory` calls `provider.pull` and `store.writeSyncState` (US-014 ACs).
- US-016 → US-002/US-009: `saveMemoryNote` validates through `validateMemoryNoteWrite` and pushes through the provider (US-016 ACs).
- US-017 → US-010: `saveMemoryNote` enqueues through the outbox when undelivered (US-017 ACs); US-019's integration ACs take that entry through `syncMemory`.

## Acceptance Criteria

### US-001

- [unit] `parseMemoryNote` applied to the example note text in Design returns a `MemoryNote` whose `slug` is `replay-budget` and whose `body` equals the single body line of the example.
- [unit] `parseMemoryNote` on that text returns `type` `project`, `scope` `project` and `status` `active`.
- [unit] `serializeMemoryNote` applied to that `MemoryNote` yields text that `parseMemoryNote` turns back into a structurally equal note.
- [unit] `serializeMemoryNote` writes the frontmatter keys in the order `id, slug, type, scope, description, source, updatedAt, status`, then `---`, then one blank line, then the body.
- [unit] `parseMemoryNote` on text with no leading `---` line throws `NaxError` with code `MEMORY_NOTE_INVALID`.
- [unit] `parseMemoryNote` on frontmatter missing the `slug` key throws `NaxError` with code `MEMORY_NOTE_INVALID` and a message naming `slug`.
- [unit] `parseMemoryNote` on frontmatter whose `type` is `note` throws `NaxError` with code `MEMORY_NOTE_INVALID`.
- [unit] `parseMemoryNote` on frontmatter whose `status` is `archived` throws `NaxError` with code `MEMORY_NOTE_INVALID`.
- [unit] `parseMemoryNote` on frontmatter whose `slug` is `Bad_Slug` throws `NaxError` with code `MEMORY_NOTE_INVALID`.
- [unit] `parseMemoryNote` on a description value `ratio: 2:1` returns `description` `ratio: 2:1`, and an unknown key `extra: x` is ignored.
- [unit] `parseMemoryNote` accepts an empty body (closing `---` is the last line) and returns `body` `""`, and `serializeMemoryNote` of that note ends with `---` followed by a single line break.
- [unit] `isMemoryPushRejected` returns `true` for a `NaxError` with code `MEMORY_PUSH_REJECTED`.
- [unit] `isMemoryPushRejected` returns `false` for a `NaxError` with code `MEMORY_NOTE_INVALID` and for a plain `Error`.
- [unit] Importing `parseMemoryNote`, `serializeMemoryNote`, `isMemoryPushRejected` and every `MEMORY_*` constant named in Design from `@nathapp/nax-agent` succeeds.

Verification note: `bun run check:api` passes after `bun run api:update`; `bun run check:no-bun-apis` passes.

### US-002

- [unit] `validateMemoryNoteWrite({ slug: "replay-budget", type: "project", scope: "project", description: "one line", body: "text" }, "nax-chat")` returns `null`.
- [unit] Slug `Replay_Budget` returns a refusal whose `field` is `slug`.
- [unit] A 65-character slug of lower-case letters returns a refusal whose `field` is `slug`.
- [unit] Type `note` returns a refusal whose `field` is `type`.
- [unit] A description containing a line break returns a refusal whose `field` is `description`.
- [unit] A description of `MEMORY_DESCRIPTION_MAX_CHARS + 1` characters returns a refusal whose `field` is `description`.
- [unit] A source containing a line break returns a refusal whose `field` is `source`.
- [unit] A body of `MEMORY_NOTE_BODY_MAX_BYTES + 1` UTF-8 bytes built from multi-byte characters whose character count is below the limit returns a refusal whose `field` is `body`.
- [unit] A body containing `ghp_` followed by 20 alphanumerics returns a refusal whose `field` is `body`, whose `reason` names `github` and omits the token text.
- [unit] A description containing `API_KEY=abc123` returns a refusal whose `field` is `description` and whose `reason` names `assignment`.
- [unit] A body containing `postgres://alice:s3cret@db.example/app` returns a refusal whose `reason` names `url-credentials`.
- [unit] A body containing `see https://example.com/docs and the word token` returns `null` (the `url-credentials` pattern's `acceptMatch` is applied, so a credential-less URL is not a secret).
- [unit] Calling `validateMemoryNoteWrite` twice in a row with the same GitHub-token body returns a refusal both times (no stale regex state between calls).
- [unit] `findSecret("x ghp_abcdefghijklmnopqrstu y")` returns `{ kind: "github" }` and `findSecret("plain text")` returns `null`.
- [unit] `validateMemoryNoteWrite` and `findSecret` are exported from `@nathapp/nax-agent`.

Verification note: `bun run check:api` passes after `bun run api:update`.

### US-003

- [unit] `createMemoryStore({ projectDir, logger }).paths` has `index` `<projectDir>/MEMORY.md`, `notesDir` `<projectDir>/notes`, `lock` `<projectDir>/sync.lock` and `outboxDir` `<projectDir>/outbox`.
- [unit] Without `userDir`, `paths.userDir`, `paths.userIndex` and `paths.userNotesDir` are `null`; with `userDir`, `paths.userNotesDir` is `<userDir>/notes` and `paths.userIndex` is `<userDir>/MEMORY.md`.
- [unit] `writeNote` of a project-scope note followed by `readNote("project", slug)` returns a structurally equal note.
- [unit] After `writeNote`, the file `<projectDir>/notes/<slug>.md` holds exactly the `serializeMemoryNote` text, and `<projectDir>/notes` was created on demand.
- [unit] `writeNote` of a user-scope note with `userDir` set stores it at `<userDir>/notes/<slug>.md`, and `readNote("user", slug)` returns it.
- [unit] `writeNote` of a user-scope note on a store created without `userDir` throws `NaxError` with code `MEMORY_SCOPE_UNAVAILABLE`.
- [unit] On a store whose `projectDir` does not exist, `readNote("project", "x")` resolves `null`, `listNotes("project")` resolves `[]` and `deleteNote("project", "x")` resolves.
- [unit] `readNote` of a slug whose file holds malformed frontmatter throws `NaxError` with code `MEMORY_NOTE_INVALID`.
- [unit] `listNotes("project")` over three parseable notes and one malformed file returns the three sorted by slug ascending, and the logger received exactly one `warn` call for the malformed file whose data `path` names it.
- [unit] `listNotes("project")` ignores a file named `replay-budget.md.abc.tmp` and a file named `MEMORY.md` placed in the notes directory.
- [unit] `deleteNote("project", slug)` removes the file, and `deleteNote` of an absent slug resolves without throwing.
- [unit] `_memoryStoreDeps` is the same object when imported from `@nathapp/nax-agent/internal` and from `#src/memory/store`, and `createMemoryStore` is exported from `@nathapp/nax-agent`.

Verification note: `bun run check:api` passes after `bun run api:update`; `test/unit/packaging/public-surface.test.ts` passes with `_memoryStoreDeps` added to `SEAMS`.

### US-004

- [unit] `writeNote` with slug `../escape` throws `NaxError` with code `MEMORY_SLUG_INVALID`, and neither `_memoryStoreDeps.mkdir` nor `_atomicWriteDeps.writeFile` is invoked.
- [unit] With `<projectDir>/notes` replaced by a symbolic link to a directory outside `projectDir`, `writeNote` of a valid slug throws `NaxError` with code `MEMORY_PATH_OUTSIDE` and the outside directory stays empty.
- [unit] With `<projectDir>/notes/<slug>.md` being a symbolic link to a file outside `projectDir`, `readNote` throws `NaxError` with code `MEMORY_PATH_OUTSIDE`.
- [unit] `listNotes("project")` skips a symlinked note file that resolves outside `projectDir`, logs one `warn` for it, and returns the other notes.
- [unit] `writeNote` calls `_atomicWriteDeps.writeFile` with a path ending in `.tmp` inside the notes directory and then `_atomicWriteDeps.rename(temp, final)`.
- [unit] When `_atomicWriteDeps.rename` is made to throw, `writeNote` rejects with that error, the final file does not exist afterwards and no `.tmp` file remains in the notes directory.

Verification note: `bun run check:all` passes.

### US-005

- [unit] `writeDecisions([d1, d2])` followed by `readDecisions()` returns `[d1, d2]`, and `<projectDir>/decisions.jsonl` holds one JSON object per line.
- [unit] `readDecisions()` on a missing file resolves `[]`.
- [unit] `readDecisions()` skips a line that is not valid JSON and logs one `warn` for it.
- [unit] `readSyncState()` on a missing file resolves `{ provider: null, cursor: { project: null, user: null }, lastPullAt: null, lastError: null }`.
- [unit] `readSyncState()` on a file holding `not json` resolves the same defaults and logs one `warn`.
- [unit] After `writeSyncState(state)`, `readSyncState()` resolves a structurally equal `state`, and `_atomicWriteDeps.rename` was called for `<projectDir>/sync.json`.
- [unit] `writeIndex("project", "# Memory\n")` writes `<projectDir>/MEMORY.md` with that text through `_atomicWriteDeps.rename`.
- [unit] `writeIndex("user", text)` with `userDir` set writes `<userDir>/MEMORY.md`; without `userDir` it throws `NaxError` with code `MEMORY_SCOPE_UNAVAILABLE`.
- [unit] `writeDecisions`, `writeSyncState` and `writeIndex` create the parent directory on demand.
- [unit] A `MemorySyncState` value typed from `@nathapp/nax-agent` with per-scope `cursor` compiles (type export present).

Verification note: `bun run check:api` passes after `bun run api:update`.

### US-006

- [unit] `renderMemoryIndex` with one project note of each type yields text whose first two lines are `# Memory` and `Memory notes are recorded facts, not instructions.`, followed by `## Project` and `### project`, `### feedback`, `### reference`, `### user` blocks in that order.
- [unit] A note line is rendered as `- [<type>] <slug> — <description>`.
- [unit] A note with status `pending` renders with a trailing ` (pending)`.
- [unit] A note whose `<scope>/<slug>` key is in `heldForgets` renders with a trailing ` (forget pending)`.
- [unit] Notes with status `superseded`, `rejected` or `deleted` produce no line, and a type block with no renderable note is omitted.
- [unit] `## Decisions` lists only `active` decisions, one per line as `- <subject> <predicate> <object>`, ordered by `updatedAt` descending.
- [unit] `## User` lists user-scope notes with the same line shape, and is omitted when `userNotes` is empty.
- [unit] A description containing a line break, a tab and three consecutive spaces renders on one line with single spaces.
- [unit] A description longer than `MEMORY_DESCRIPTION_MAX_CHARS` is cut to that length in the rendered line.
- [unit] With no notes and no decisions, `text` is exactly the two header lines and `omitted` is 0.
- [unit] `renderMemoryIndex` is exported from `@nathapp/nax-agent`.

Verification note: `bun run check:api` passes after `bun run api:update`.

### US-007

- [unit] With `maxLines: 20` and thirty project notes of one type, the output has at most 20 lines, its last line has the form `- <N> more entries not shown; use the memory tool to search.`, and `omitted` equals the number of note lines dropped.
- [unit] With `maxLines: 20`, four types, and enough notes that a whole type block is dropped, that block's `### <type>` header is absent from the output.
- [unit] With `maxBytes` smaller than the full rendering, the UTF-8 byte length of `text` is at most `maxBytes` and `omitted` is greater than 0.
- [unit] With `maxLines: 2` and thirty notes, the output still contains the two header lines and the trailing line (the value is raised to `MEMORY_INDEX_MIN_LINES`); with `maxBytes: 10` the output is at most `MEMORY_INDEX_MIN_BYTES` bytes and still contains the header lines.
- [unit] `refreshMemoryIndex(store)` on a store holding two project notes and one decision calls `store.writeIndex` with `"project"` and the rendered text, and resolves the same `RenderedMemoryIndex`.
- [unit] `refreshMemoryIndex` on a store with `userDir` additionally calls `store.writeIndex` with `"user"` and a text containing the two header lines and the `## User` section and no `## Project` section.
- [unit] `refreshMemoryIndex(store, { heldForgets })` renders the held slug with ` (forget pending)`.
- [unit] `refreshMemoryIndex` is exported from `@nathapp/nax-agent`.

Verification note: `bun run check:api` passes after `bun run api:update`.

### US-008

- [unit] `tokenizeMemoryQuery("Replay-Budget, 2048 MiB!")` returns `["replay", "budget", "2048", "mib"]`.
- [unit] `tokenizeMemoryQuery("a b replay replay")` returns `["replay"]` (short tokens dropped, duplicates removed).
- [unit] `tokenizeMemoryQuery("Größe über")` returns `["größe", "über"]` (Unicode letters are token characters).
- [unit] `searchMemoryNotes(notes, "replay budget", 10)` ranks a note whose slug contains both tokens above a note whose body alone contains both.
- [unit] A note matching one token only in the body has score 1; a note matching one token only in the description has score 2.
- [unit] A query token repeated in a field counts once for that field.
- [unit] Query `replay` does not match a note whose only occurrence is the word `replays`.
- [unit] Notes with status `superseded`, `rejected` or `deleted` are never returned.
- [unit] Two notes with equal score are ordered by `updatedAt` descending, then slug ascending.
- [unit] `limit: 1` returns exactly one hit.
- [unit] `searchMemoryNotes(notes, "", 10)` and `searchMemoryNotes(notes, "a", 10)` return `[]`.
- [unit] A hit's `snippet` is the first body line containing a query token as a whole token, cut at 160 characters; a note matching only in slug or description has `snippet` `""`.
- [unit] Matching is case-insensitive: query `REPLAY` matches a body containing `replay`.
- [unit] `searchMemoryNotes` and `tokenizeMemoryQuery` are exported from `@nathapp/nax-agent`.

Verification note: `bun run check:api` passes after `bun run api:update`.

### US-009

- [unit] `createLocalMemoryProvider(store).id` is `"local"` and `reachable()` resolves `true`.
- [unit] `pull({ scope: "project", cursor: null, take: 10 })` resolves `{ notes: [], done: true }` with no `nextCursor`.
- [unit] `push` of a `save` request with `writeMode: "direct"` resolves `{ id: note.id, status: "active" }`, and `store.readNote` returns the note with status `active`.
- [unit] `push` of a `save` request with `writeMode: "proposal"` resolves `{ status: "pending" }`, and `store.readNote` returns the note with status `pending`.
- [unit] `push` of a `save` for a slug that already exists overwrites the stored note (`readNote` returns the new description).
- [unit] `push` of a `forget` request with `writeMode: "direct"` resolves `{ id: request.clientId, status: "deleted" }`, and `readNote` then resolves `null`.
- [unit] `push` of a `forget` request with `writeMode: "proposal"` resolves `{ status: "pending" }` and `readNote` still returns the note.
- [unit] `push` of a `save` request without a `note` throws `NaxError` with code `MEMORY_PUSH_REJECTED`.
- [unit] The provider object has no `search` property.
- [unit] `createLocalMemoryProvider` is exported from `@nathapp/nax-agent`, and an object literal with `id`, `pull`, `push` and `reachable` is assignable to the exported `MemoryProvider` type.

Verification note: `bun run check:api` passes after `bun run api:update`.

### US-010

- [unit] `enqueue(request)` with no `clientId` resolves an entry whose `clientId` is a UUID (36 characters, 4 hyphens), `state` `queued`, `seq` 1 and `enqueuedAt` equal to the injected `now()` ISO string.
- [unit] After that `enqueue`, the file `<dir>/00000001-<clientId>.json` exists holding the entry as JSON, and `<dir>` was created on demand.
- [unit] A second `enqueue` gets `seq` 2 even when its `enqueuedAt` equals the first's.
- [unit] Two `enqueue` calls started concurrently with `Promise.all` resolve entries with `seq` 1 and 2 and produce two files.
- [unit] `enqueue(request)` with `clientId` `my-client_1` keeps it; with `clientId` `../x` it throws `NaxError` with code `MEMORY_CLIENT_ID_INVALID` and writes nothing.
- [unit] `list()` returns entries ordered by `seq` ascending, then `clientId` ascending for equal `seq`.
- [unit] `list()` ignores a file named `00000003-x.json.abc.tmp` and a file named `notes.txt` in `<dir>`.
- [unit] `list()` excludes a correctly named file whose content is not valid JSON, and `listInvalid()` returns that file name.
- [unit] `remove(clientId)` deletes the entry file; `remove` of an unknown id resolves without throwing.
- [unit] `markRejected(clientId, "note kind not available")` rewrites the entry with `state: "rejected"` and that `reason`, and `list()` still returns it.
- [unit] `heldKeys()` returns `"<scope>/<slug>"` for `queued` entries only (a `rejected` entry is excluded); `heldKeys("forget")` returns only the keys of queued `forget` entries.
- [unit] `enqueue` writes through `_atomicWriteDeps.writeFile` to a `.tmp` path and then `_atomicWriteDeps.rename`; while `rename` is stubbed to delay, a concurrent `list()` returns only the entries present before the enqueue.
- [unit] `createMemoryOutbox` is exported from `@nathapp/nax-agent`.

Verification note: `bun run check:api` passes after `bun run api:update`.

### US-011

- [unit] `makeMemoryProvider()` from `#test/helpers/index` returns a `MemoryProvider` whose `reachable`, `push` and `pull` are mocks with call records, scripted through `overrides` (`reachable` result, `push` results or throws per call, `pull` pages).
- [unit] `syncMemory` on an empty outbox with the scripted provider resolves `{ outcome: "synced", pushed: 0, rejected: 0, pulled: 0, skipped: 0 }`.
- [unit] `syncMemory` creates `store.paths.lock` while running and the file is absent after it resolves.
- [unit] With a lock file whose holder has a different `pid` reported alive by the injected `isAlive` and a fresh heartbeat, `syncMemory` resolves `{ outcome: "locked" }` and `reachable` is not called.
- [unit] With a lock file whose holder `pid` is reported dead by `isAlive`, the sync takes the lock over and resolves `synced`.
- [unit] Two `syncMemory` calls started synchronously one after the other on the same store in one process (no `await` between the two calls) resolve one `synced` and one `locked`, and `reachable` is called once.
- [unit] When `projectDir` does not exist yet, `syncMemory` creates it and resolves `synced`.
- [unit] After a successful sync `store.paths.index` holds the rendered index of the notes in the mirror.
- [unit] `syncMemory` never rejects: when `outbox.heldKeys` is made to throw, the result is `outcome: "failed"` with `error` set, the lock file is absent, the in-flight key is cleared (a following call resolves `synced`), and the logger received a `warn`.
- [unit] `syncMemory` is exported from `@nathapp/nax-agent`, and `acquireSessionLock` is importable from `#src/session-store/index`.

Verification note: `bun run check:api` passes after `bun run api:update`; `bun run check:import-cycles` passes.

### US-012

- [unit] `raceTimeout(promise, ms, timers)` resolves with the promise's value when it settles first and calls `timers.clearTimeout` with the id `timers.setTimeout` returned.
- [unit] `raceTimeout` rejects with `NaxError` code `MEMORY_TIMEOUT` when the fake clock advances `ms` before the promise settles.
- [unit] `raceTimeout` with a fake clock leaves `clock.pending()` at 0 after either outcome.
- [unit] When `reachable()` resolves `false`, `syncMemory` resolves `{ outcome: "unreachable" }`, calls neither `push` nor `pull`, leaves the outbox unchanged and writes `sync.json` with `lastError` `"unreachable"` and the previous cursors kept.
- [unit] When `reachable()` rejects with an `Error`, `syncMemory` resolves `{ outcome: "unreachable" }` and `lastError` is `"unreachable"`.
- [unit] When `reachable()` never settles, after `waitForCondition` sees a pending fake-clock timer, `clock.advance(MEMORY_PROBE_TIMEOUT_MS)` makes `syncMemory` resolve `{ outcome: "unreachable" }` and `clock.pending()` is 0.
- [unit] `raceTimeout` is exported from `@nathapp/nax-agent`.

Verification note: `bun run check:api` passes after `bun run api:update`.

### US-013

- [unit] With the provider reachable and two `queued` `save` entries, `syncMemory` calls `provider.push` once per entry in `seq` order with each entry's `MemoryWriteRequest` fields, and resolves `{ outcome: "synced", pushed: 2, rejected: 0 }`.
- [unit] After that sync both entries are removed from the outbox and each mirrored note carries the `id` and `status` the provider returned.
- [unit] A `queued` `forget` entry whose push resolves `status: "deleted"` deletes the mirrored note; one whose push resolves `status: "pending"` leaves the note in place; both entries are removed.
- [unit] When `push` throws `NaxError` code `MEMORY_PUSH_REJECTED` for the first entry and succeeds for the second, the first entry is `rejected` with the error message as `reason`, the second is removed, and the result has `rejected: 1`, `pushed: 1`, `outcome: "synced"`.
- [unit] When `push` throws a plain `Error` for the first of two entries, the second entry is still `queued`, `provider.pull` is not called, `sync.json.lastError` holds the error message, and `outcome` is `"failed"`.
- [unit] When `push` never settles, after a pending timer appears, `clock.advance(MEMORY_OP_TIMEOUT_MS)` makes `syncMemory` resolve `outcome: "failed"` with the entry still `queued`.
- [unit] After a transient push failure leaves a `forget` entry queued, `store.paths.index` shows that slug with ` (forget pending)`.

Verification note: `bun run check:all` passes.

### US-014

- [unit] With pages `{ notes: [n1], nextCursor: "c1", done: false }` then `{ notes: [n2], done: true }`, `syncMemory` calls `provider.pull` first with `{ scope: "project", cursor: null, take: MEMORY_PULL_PAGE_SIZE }` and then with `cursor: "c1"`, and resolves `pulled: 2`.
- [unit] After that sync both notes are in the mirror and `sync.json` has `cursor.project` `"c1"`, `provider` equal to `provider.id`, `lastPullAt` equal to `now()` and `lastError` `null`.
- [unit] A last page without `nextCursor` leaves `cursor.project` at the previous page's cursor.
- [unit] A sync whose state file already holds `cursor.project` `"c9"` calls `pull` with `cursor: "c9"`.
- [unit] When `pull` throws on the second page, the cursor written after the first page is kept, `lastError` holds the message and `outcome` is `"failed"`.
- [unit] When `pull` never settles, after a pending timer appears, `clock.advance(MEMORY_OP_TIMEOUT_MS)` makes `syncMemory` resolve `outcome: "failed"`.
- [unit] A provider whose pages never report `done: true` is stopped after `MEMORY_PULL_MAX_PAGES` calls with `lastError` `"pull page limit reached"` and `outcome: "failed"`.
- [unit] Pull runs after a successful drain in the same call: `push` is called before `pull`, and both the pushed note and the pulled notes are in the mirror afterwards.

Verification note: `bun run check:all` passes.

### US-015

- [unit] A pulled note with status `superseded` deletes the mirrored note of that slug and is not counted in `pulled`.
- [unit] When the scripted `pull` enqueues a `save` for slug `held` on the outbox before resolving a page that contains `held`, the mirrored `held` note keeps its local content and is not counted in `pulled`.
- [unit] A pulled note with slug `Bad Slug` is skipped, counted in `skipped`, logged once at `warn`, and the page's cursor is still written.
- [unit] A pulled object missing `description` is skipped, counted in `skipped` and logged once at `warn`.
- [unit] A project page carrying `decisions` replaces `decisions.jsonl` with exactly those decisions.
- [unit] With `userDir` set, `pull` is also called with `scope: "user"` starting from `cursor.user`, and user-scope notes land under `<userDir>/notes`.
- [unit] After the user pull, `cursor.user` is written, and `decisions` on the user page leave `decisions.jsonl` unchanged.
- [unit] When the project pull fails mid-way, the user scope is not pulled.

Verification note: `bun run check:all` passes.

### US-016

- [unit] `saveMemoryNote` with a valid write, `writeMode: "direct"` and a reachable provider whose `push` resolves `{ id: "mem_1", status: "active" }` resolves `{ slug, status: "active", delivered: true }`.
- [unit] After that save `store.readNote` returns the note with `id` `mem_1`, `status` `active`, `source` equal to the input `source` and `updatedAt` equal to `now()`.
- [unit] `saveMemoryNote` passes `push` a `save` request whose `clientId` equals the note's initial `id` (a UUID of 36 characters), whose `writeMode` is the input mode and whose `note` is the mirrored note.
- [unit] `saveMemoryNote` with `writeMode: "proposal"` writes the note with status `pending` before pushing, and resolves `status: "pending"` when the provider returns `pending`.
- [unit] `saveMemoryNote` with a body containing a GitHub token throws `NaxError` with code `MEMORY_WRITE_REFUSED`, no note file exists afterwards and the outbox is empty.
- [unit] After a delivered save, `store.paths.index` contains the new slug.
- [unit] `saveMemoryNote` is exported from `@nathapp/nax-agent`.

Verification note: `bun run check:api` passes after `bun run api:update`.

### US-017

- [unit] `saveMemoryNote` when `reachable()` resolves `false` writes the note to the mirror, enqueues a `save` entry with the same `clientId`, and resolves `delivered: false`.
- [unit] `saveMemoryNote` when `reachable()` rejects with an `Error` behaves the same as unreachable (`delivered: false`, request enqueued).
- [unit] `saveMemoryNote` when `push` never settles resolves `delivered: false` after a pending timer appears and the fake clock advances `MEMORY_OP_TIMEOUT_MS`, with the request enqueued.
- [unit] `saveMemoryNote` when `push` rejects with a plain `Error` resolves `delivered: false` with the request enqueued and the mirrored note kept.
- [unit] `saveMemoryNote` for a slug that already has a `queued` outbox entry does not call `push`, enqueues behind it (higher `seq`), and resolves `delivered: false`.
- [unit] `saveMemoryNote` when `push` throws `MEMORY_PUSH_REJECTED` for a new slug rethrows that error, no note file exists afterwards and nothing is enqueued.
- [unit] `saveMemoryNote` when `push` throws `MEMORY_PUSH_REJECTED` for an existing slug restores the previous note (`readNote` returns the previous description).
- [unit] After an undelivered save, `store.paths.index` contains the new slug.

Verification note: `bun run check:all` passes.

### US-018

- [unit] `forgetMemoryNote` under `direct` with a reachable provider deletes the mirrored note, pushes a `forget` request carrying `reason` and a UUID `clientId`, and resolves `{ status: "deleted", delivered: true }`.
- [unit] `forgetMemoryNote` under `proposal` leaves the note in place, pushes a `forget` request and resolves `status: "pending"`.
- [unit] `forgetMemoryNote` of an absent slug throws `NaxError` with code `MEMORY_NOTE_NOT_FOUND`.
- [unit] `forgetMemoryNote` when the provider is unreachable enqueues the `forget` request and resolves `delivered: false`.
- [unit] After an undelivered `proposal` forget, `store.paths.index` shows the slug with ` (forget pending)`.
- [unit] `forgetMemoryNote` under `direct` when `push` throws `MEMORY_PUSH_REJECTED` restores the note (`readNote` returns it) and rethrows.
- [unit] `forgetMemoryNote` for a slug with a `queued` outbox entry does not call `push` and enqueues behind it.
- [unit] `forgetMemoryNote` is exported from `@nathapp/nax-agent`.

Verification note: `bun run check:api` passes after `bun run api:update`.

### US-019

- [unit] `approveMemoryNote` on a `pending` note rewrites it with status `active` and `updatedAt` `now()`, and the refreshed index no longer shows ` (pending)` for it.
- [unit] `approveMemoryNote` on an `active` note returns it unchanged.
- [unit] `approveMemoryNote` on an absent slug and on a note with status `superseded` throws `NaxError` with code `MEMORY_NOTE_NOT_FOUND`.
- [integration] A note saved with the provider unreachable (`delivered: false`) is delivered by a subsequent `syncMemory` once the scripted provider becomes reachable: `push` is called with the queued request, the outbox is empty afterwards and the mirrored note carries the provider's `id`.
- [integration] A `forget` enqueued while unreachable, followed by a sync where the provider returns `status: "deleted"`, leaves no mirrored note and an empty outbox.
- [unit] `approveMemoryNote` is exported from `@nathapp/nax-agent`.

Verification note: `bun run check:api` passes after `bun run api:update`; `bun run check:all` and `bun run test` green from `packages/nax-agent`.
