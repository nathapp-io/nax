# SPEC: memory smoke-test fixes

Closes: #2775, #2776, #2777, #2778, #2779

## Summary

Five fixes found by the v0.91.8-canary.1 smoke test of the memory slice. With the
local provider in proposal mode, a `forget` is now recorded as a pending retire that
the index and `nax memory list` mark `(forget pending)` and that
`nax memory approve <slug>` carries out (#2775). The `nax memory` CLI prints the
path and reason a memory warn carries instead of a bare message (#2776). A
repository-committed note (`.nax/memory/<slug>.md`) needs only `slug`, `type` and
`description`; the other frontmatter keys get fixed defaults (#2777). A tool can
declare plain fields its approval line shows, and the memory tools declare theirs,
so the `nax chat` approval card for `nax-memory__save` names the note it saves
(#2778). `nax memory list` prints `no memory notes` when it has nothing to list
(#2779).

Design: `docs/superpowers/specs/2026-11-02-nax-memory-design.md` §6.7 (the local
provider keeps the proposal UX identical without koda).

## Motivation

The smoke test (2026-11-03, `v0.91.8-canary.1`, scratch repository) exercised the
`nax memory` commands, proposal mode, repo notes and three `nax chat` turns. All
paths worked except:

- **#2775** — `nax memory forget a --reason r` under `memory.writeMode: "proposal"`
  printed `forgot project/a (pending)`, then `nax memory approve a` printed
  `approved project/a` and the note stayed `active`. The local provider answers a
  proposal forget `pending` and leaves the note (`local-provider.ts:71-75`); the
  operation removes the outbox entry on that acceptance; `approveMemoryNote`
  returns an active note unchanged and approves no queued forget
  (`operations.ts` header). Nothing anywhere records that the retire is waiting.
- **#2776** — a repo note with a missing key printed `[memory] repo note skipped`
  with no file and no reason: `cliMemoryLogger` (`cli/memory-cli-deps.ts:100-103`)
  writes `[stage] message` and drops the data argument that carries them.
- **#2777** — a repo note is accepted only with all eight frontmatter keys,
  including an invented `id`, a `source` and an ISO `updatedAt`, although
  `scope`, `status` and `source` can hold only one value for a repo note
  (`repo-notes.ts:201-205`).
- **#2778** — the guarded-mode approval card read `MCP tool nax-memory__save` /
  `nax-memory__save` / `matched ask rule ...`: `askSummary`
  (`tools/ask-request.ts:39`) builds the line from a scope's command, argv, verb
  and path fields, and `adaptProviderTool` gives every provider tool
  `scope: { pathFields: [] }`, so the summary is the tool name alone and
  `memory.askOnSave` cannot be judged.
- **#2779** — `nax memory list` on an empty mirror printed nothing.

## Design

### Approach

**Pending forgets (#2775).** The mirror gains one record file,
`<projectDir>/pending-forgets.jsonl`, one JSON object per line:

```json
{"clientId":"5b0c2f4e-7c1d-4a8e-9f3a-2d6b8e1c4a70","scope":"project","slug":"replay-budget","reason":"the budget changed"}
```

An entry is valid when `clientId` matches `MEMORY_CLIENT_ID_RE`, `scope` is one of
`MEMORY_SCOPES`, `slug` matches `MEMORY_SLUG_RE` and `reason` is a string; a forget
request with no `reason` is recorded with `reason: ""`. A proposal forget whose slug fails
`MEMORY_SLUG_RE` is refused by the local provider as `MEMORY_PUSH_REJECTED` and records
nothing, as a direct forget of that slug already is.

It is written only by the local provider and by an approval, and it is read by the
index refresh, the memory host and the approval. Every writer runs while the mirror
lock is held: the local provider's `push` is called from inside the forget and save
operations' locked sections and from sync's drain, and the approval takes the lock
itself, so no new lock is needed. One caveat is accepted: a push abandoned by
`raceTimeout` is not cancelled, so a local push that outlived its deadline could still be
finishing its record write after the lock holder moved on. The local provider's push is
a few small file operations, far inside `MEMORY_OP_TIMEOUT_MS`.

- Every local-provider change to the record reads it, filters it, and writes it back
  only when the list changed; a save or direct forget of a key the record does not hold
  leaves the file untouched (absent stays absent).
- Local provider, forget under `proposal`: the entries for other keys are kept in
  order, any entry for the same `scope/slug` is dropped, and the new entry is
  appended. The answer stays `{ id: clientId, status: "pending" }` and the note is
  left in place.
- Local provider, forget under `direct`: the note is deleted (as today) and any
  entry for that key is dropped.
- Local provider, save (either mode): after the note is written, any entry for that
  key is dropped, because saving the slug again means it is wanted.
- `refreshMemoryIndex` marks a note `(forget pending)` when its key is in the
  caller's `heldForgets` **or** in the store's pending-forget record.
- `approveMemoryNote`, inside its locked section: a slug the mirror does not hold,
  or holds retired, is `MEMORY_NOTE_NOT_FOUND` as today. If the record holds an
  entry for the key, the approval retires the note: delete the note, write the
  record without that entry, refresh the index, and return the note as it was with
  `status: "deleted"`. A pending forget wins over a pending save. Otherwise the
  existing behaviour stands (active returned unchanged; pending made active).
  The return type stays `Promise<MemoryNote>`.

koda and MCP providers never write the record (their approval is server-side), so
for them the record is always empty and nothing changes.

**CLI messages (#2775, #2779).** `nax memory approve` reads the note through
`host.getNote` before it approves. It prints `forgot <scope>/<slug> (forget approved)`
when the result's status is `deleted`, and
`<scope>/<slug> is already active; nothing to approve` when the note was `active`
before and the result is `active`. Otherwise it prints `approved <scope>/<slug>` as
today. When `host.getNote` resolves to `null` (an absent slug), the command still calls
`host.approve`, whose `MEMORY_NOTE_NOT_FOUND` or `MEMORY_NOTE_READ_ONLY` refusal is
reported as today. `--json` is unchanged. `nax memory list` appends ` (forget pending)` to a
row whose key the host reports as pending a forget. With no rows to print it logs
`no memory notes`, or `no memory notes match` when `--type` or `--scope` was given.

**CLI warn data (#2776).** `cliMemoryLogger` renders a non-empty data object after
the message as `: key=value` pairs separated by one space, in the object's key
order. A string is used as is, a number or boolean through `String`, anything else
through `JSON.stringify`, and every line break (`\r\n`, `\n`, `\r`) in a rendered
value becomes one space. Example:
`[memory] repo note skipped: path=/r/.nax/memory/a.md reason=invalid note: memory note invalid: type: Invalid option`.

**Repo note defaults (#2777).** Before parsing, `readRepoNotes` fills in each of
these keys that the frontmatter does not set: `id` = the file's slug (its name
without `.md`), `scope` = `project`, `status` = `active`, `source` = `repo`,
`updatedAt` = the file's modification time (the `lstat` measurement the reader
already takes) as an ISO-8601 string. A key the file does set keeps its value and
the existing rules (`scope` must be `project`, `status` must be `active`) still
reject a wrong one. `source` is still overwritten to `repo` on acceptance. A
missing `slug`, `type` or `description` still rejects the note. A minimal repo
note:

```markdown
---
slug: staging-db
type: project
description: the staging database is shared; never reset it
---

Ask in #infra before running migrations against staging.
```

The non-normative implementation is to insert `key: value` lines for the absent
keys just before the closing `---` and hand the result to `parseMemoryNote`
unchanged.

**Approval line fields (#2778).** `ToolScope` gains an optional `summaryFields`:
plain input fields shown on the approval line, never checked or granted. After the
existing command, argv, verb and path parts, `askSummary` appends `field=value` for
each `summaryFields` entry whose input value is a string, number or boolean. Line
breaks in a value become one space, and any other value type is skipped. The line is
still masked and then capped at `MAX_ASK_SUMMARY_CHARS` (200), exactly as today.
`ProviderTool` gains the same optional `summaryFields`, and `adaptProviderTool`
copies it into the adapted tool's scope when it is set, leaving the scope exactly
`{ pathFields: [] }` when it is not. The memory tool provider declares
`["scope", "slug", "type", "description"]` on `save` and
`["scope", "slug", "reason"]` on `forget`. `get` and `search` declare none. The note
body is never a summary field. `summaryFields` does not count as a field for the
policy's `isFieldlessScope` (`policy.ts:91`), so an unconditional ask rule on a memory
tool keeps asking exactly as today.

### Integration

Read-only symbols (verified 2026-11-03 on main `bd8a00df7`):

- `createMemoryStore(input)` — `packages/nax-agent/src/memory/store.ts`; record files are read through `readRecordText(path)` (pinned to the project directory) and written through `writeRecordFile(path, text)`; `readDecisions` / `writeDecisions` (lines 507-527) are the pattern to mirror, including the skip-and-warn of a bad line.
- `createMemoryOutbox` / `MemoryOutbox.heldKeys(kind?)` — `packages/nax-agent/src/memory/outbox.ts:82`.
- `memoryNoteKey(scope, slug)` — `packages/nax-agent/src/memory/types.ts`, the `"<scope>/<slug>"` key.
- `MEMORY_CLIENT_ID_RE`, `MEMORY_SCOPES` — `packages/nax-agent/src/memory/types.ts`.
- `maskForPrompt(text)` — `packages/nax-agent/src/permissions/secret-spans.ts:85`.
- `createCodingToolRuntime({ policy, askResolver, extraTools })` — `packages/nax-agent/src/tools/runtime.ts:156`; `compileToolPolicy(grants, root, { askRules })`.
- `formatMemoryNoteLine(note)` — `packages/nax/src/memory/format.ts:61`, renders `<scope>/<slug> [<type>] <description> (<status>; <source>)`.
- `MemoryHost.getNote(scope, slug)` — `packages/nax/src/memory/host.ts:100`.
- `parseMemoryNote(text)` — `packages/nax-agent/src/memory/note.ts`.

Changed symbols. The baseline exists only to locate the code; it is never the
interface to implement.

- `MemoryStorePaths` (`packages/nax-agent/src/memory/store.ts:101`). Baseline: `{ projectDir, userDir, index, notesDir, decisions, syncState, lock, outboxDir, userIndex, userNotesDir }`. Target: the same plus `readonly pendingForgets: string` = `join(projectDir, "pending-forgets.jsonl")`.
- `MemoryStore` (`store.ts:123`). Target: adds `readPendingForgets(): Promise<MemoryPendingForget[]>` and `writePendingForgets(entries: readonly MemoryPendingForget[]): Promise<void>`.
- New exported type `MemoryPendingForget` (`packages/nax-agent/src/memory/types.ts`): `{ readonly clientId: string; readonly scope: MemoryScope; readonly slug: string; readonly reason: string }`.
- `createLocalMemoryProvider(store)` (`packages/nax-agent/src/memory/local-provider.ts:64`). Signature unchanged; `push` behaviour per Approach.
- `refreshMemoryIndex(store, options)` (`packages/nax-agent/src/memory/index-render.ts:197`). Signature unchanged; the marker set is `options.heldForgets` ∪ the record's keys.
- `approveMemoryNote(input)` (`packages/nax-agent/src/memory/operations.ts`). Signature unchanged (`Promise<MemoryNote>`); behaviour per Approach.
- `ToolScope` (`packages/nax-agent/src/tools/types.ts:76`). Target: adds `readonly summaryFields?: readonly string[]`.
- `ProviderTool` (`packages/nax-agent/src/tools/provider-types.ts:20`). Target: adds `readonly summaryFields?: readonly string[]`.
- `askSummary(tool, scope, input)` (`packages/nax-agent/src/tools/ask-request.ts:39`). Signature unchanged.
- `adaptProviderTool(providerId, tool)` (`packages/nax-agent/src/tools/provider-adapt.ts:26`). Signature unchanged.
- `MemoryHost` (`packages/nax/src/memory/host.ts:95`). Target: adds the optional `forgetPendingKeys?(): Promise<ReadonlySet<string>>`. It is optional for the same reason `close?` is, so a hand-built test double stays valid; `createMemoryHost` always sets it to the union of `outbox.heldKeys("forget")` and the store record's keys. The host's index (`readIndex`, `host.ts:355`) uses the same union as its `heldForgets`.
- `cliMemoryLogger(deps)` (`packages/nax/src/cli/memory-cli-deps.ts:100`). Signature unchanged.
- `memoryListCommand` (`packages/nax/src/cli/memory.ts:111`), `memoryApproveCommand` (`packages/nax/src/cli/memory-write.ts:257`). Signatures unchanged.
- `readRepoNotes(input)` (`packages/nax/src/memory/repo-notes.ts`). Signature unchanged; defaults per Approach.
- `createMemoryToolProvider(host)` (`packages/nax/src/memory/tool-provider.ts:355`). Signature unchanged; `save` and `forget` gain `summaryFields`.

### Failure Handling

| Situation | Behaviour |
|:---|:---|
| A `pending-forgets.jsonl` line is not JSON, or fails the entry shape | Skipped; one warn `"skipping a pending-forgets line that is not a pending forget"` with `{ path, line }`; the other lines are returned |
| `pending-forgets.jsonl` does not exist | `readPendingForgets` returns `[]` |
| Any local-provider record write (proposal forget, direct forget, save) throws an I/O error | `push` rejects with that error unchanged (not `MEMORY_PUSH_REJECTED`), so the operation keeps the write queued and a later sync replays it |
| An approval's note delete throws | The approval rejects with that error and the record still holds the entry |
| An approval names a slug the record holds but the mirror does not | `MEMORY_NOTE_NOT_FOUND`; the record is left as it is |

## Out of Scope

- No command rejects a pending forget without retiring the note; saving the slug again clears it.
- A user-scope pending forget is recorded in the project mirror where the forget ran; other projects' mirrors do not mark it.
- koda and MCP providers never write the pending-forget record; their approval flow is koda #380 and is not part of this feature.
- `nax memory status` does not count pending forgets.
- `nax memory list --json` gains no forget-pending field; only the text row is marked.
- A pending-forget entry whose note has gone some other way is not cleaned up.
- The note body is never shown on an approval line.
- No other provider tool besides the memory tools declares `summaryFields` in this feature.
- The user guide `docs/guides/memory.md` (the memory config block, the `nax memory` commands and the minimal repo note) is written by hand on this branch before the run, not by a story.

## Stories

**US-001: Pending-forget record.** No dependencies. Workdir: `packages/nax-agent`. Adds `MemoryPendingForget` to `src/memory/types.ts`, `paths.pendingForgets` plus `readPendingForgets` / `writePendingForgets` to `src/memory/store.ts`, makes the local provider write and clear entries (`src/memory/local-provider.ts`), and makes `refreshMemoryIndex` mark recorded keys `(forget pending)` (`src/memory/index-render.ts`); exports the type from `src/index.ts` and refreshes the API snapshot.

**US-002: Approval retires a pending forget.** Depends on US-001. Workdir: `packages/nax-agent`. Changes `approveLocked` in `src/memory/operations.ts` per Design, and updates both the file header's description of `approveMemoryNote` and the doc comment on `approveMemoryNote` itself.

**US-003: Approval line fields.** No dependencies. Workdir: `packages/nax-agent`. Adds `summaryFields` to `ToolScope` (`src/tools/types.ts`) and `ProviderTool` (`src/tools/provider-types.ts`), renders them in `askSummary` (`src/tools/ask-request.ts`), and copies them in `adaptProviderTool` (`src/tools/provider-adapt.ts`).

**US-004: Memory host, list and approve.** Depends on US-002. Workdir: `packages/nax`. Adds `forgetPendingKeys` to the memory host and uses it for the host index (`src/memory/host.ts`), marks and empty-states `nax memory list` (`src/cli/memory.ts`), and gives `nax memory approve` its three messages (`src/cli/memory-write.ts`, including its doc comment, which today says no command approves a queued forget).

**US-005: Repo note defaults.** No dependencies. Workdir: `packages/nax`. Fills absent `id`, `scope`, `status`, `source` and `updatedAt` in `src/memory/repo-notes.ts` before the note is parsed.

**US-006: Warn data and memory approval fields.** Depends on US-003. Workdir: `packages/nax`. Renders warn data in `cliMemoryLogger` (`src/cli/memory-cli-deps.ts`) and declares `summaryFields` on the memory `save` and `forget` tools (`src/memory/tool-provider.ts`).

### Context Files

**US-001**
- `packages/nax-agent/src/memory/store.ts` — the record-file pattern (`readDecisions`, `writeDecisions`, `readRecordText`, `writeRecordFile`).
- `packages/nax-agent/src/memory/local-provider.ts` — `save` and `forget` push handlers.
- `packages/nax-agent/src/memory/index-render.ts` — `refreshMemoryIndex` and the `(forget pending)` marker.
- `packages/nax-agent/src/memory/types.ts` — `memoryNoteKey`, `MEMORY_CLIENT_ID_RE`, `MEMORY_SCOPES`.
- `packages/nax-agent/test/unit/memory/local-provider.test.ts` — the request-builder pattern to copy (its builders are file-private).

**US-002**
- `packages/nax-agent/src/memory/operations.ts` — `approveLocked`, `refreshIndex`, `noteNotFound`.
- `packages/nax-agent/test/unit/memory/operations-approve.test.ts` — the approval harness pattern to copy.
- `packages/nax-agent/test/unit/memory/operations-forget.test.ts` — the forget harness pattern to copy for the end-to-end case.

**US-003**
- `packages/nax-agent/src/tools/ask-request.ts` — `askSummary`.
- `packages/nax-agent/src/tools/provider-adapt.ts` — `adaptProviderTool`.
- `packages/nax-agent/test/unit/tools/ask-request.test.ts` — the `GHP` secret fixture.
- `packages/nax-agent/test/unit/tools/runtime.test.ts` — the `createCodingToolRuntime` ask-resolver pattern.

**US-004**
- `packages/nax/src/memory/host.ts` — `readIndex`, the host's composition of store and outbox.
- `packages/nax/src/cli/memory.ts` — `memoryListCommand`.
- `packages/nax/src/cli/memory-write.ts` — `memoryApproveCommand`.
- `packages/nax/test/unit/cli/memory-forget.test.ts` — the approve host double (changed per Modifies).

**US-005**
- `packages/nax/src/memory/repo-notes.ts` — `readCandidate`, `acceptedNote`.
- `packages/nax/test/unit/memory/repo-notes.test.ts` — the note-file helpers and the skip-warn reader.

**US-006**
- `packages/nax/src/cli/memory-cli-deps.ts` — `cliMemoryLogger`.
- `packages/nax/src/memory/tool-provider.ts` — `memoryTools`, `createMemoryToolProvider`.
- `packages/nax/test/unit/memory/tool-provider.test.ts` — the provider harness pattern to copy.
- `packages/nax-agent/test/unit/tools/runtime.test.ts` — the `createCodingToolRuntime` ask-resolver pattern.

### Creates

**US-001**
- `packages/nax-agent/test/unit/memory/store-pending-forgets.test.ts`
- `packages/nax-agent/test/unit/memory/local-provider-pending-forgets.test.ts`

**US-002**
- `packages/nax-agent/test/unit/memory/operations-approve-forget.test.ts`

**US-003**
- `packages/nax-agent/test/unit/tools/ask-summary-fields.test.ts`

**US-004**
- `packages/nax/test/unit/cli/memory-smoke-fixes.test.ts`
- `packages/nax/test/unit/memory/host-pending-forgets.test.ts`

**US-005**
- `packages/nax/test/unit/memory/repo-notes-defaults.test.ts`

**US-006**
- `packages/nax/test/unit/cli/memory-cli-logger.test.ts`
- `packages/nax/test/unit/memory/tool-provider-summary.test.ts`

### Modifies

**US-001**
- `packages/nax-agent/src/index.ts` — add `type MemoryPendingForget` to the memory exports.
- `packages/nax-agent/api/nax-agent.api.txt` — regenerate with `bun run api:update` so `check:api` sees the new `type MemoryPendingForget` line.
- `packages/nax-agent/src/memory/index.ts` — add `type MemoryPendingForget` to the memory barrel exports that the package entry re-exports.

**US-002**
None.

**US-003**
None.

**US-004**
- `packages/nax/test/unit/cli/memory-forget.test.ts` — `fakeHost` sets `getNote: unread`, which throws, and `REPLAY_BUDGET` (the note its `approve` returns) is `active`; `nax memory approve` now reads the note through `host.getNote` first and prints "already active" when it was active before and after. Add an optional `before?: MemoryNote` to `HostFixture`, and make the double's `getNote(scope, slug)` return `fixture.before ?? { ...REPLAY_BUDGET, scope, slug, status: "pending" }`, so AC-9 (expects the line "approved project/replay-budget"), the `--scope user` case (expects "approved user/pref") and every other expectation in the file stay as they are.

**US-005**
None.

**US-006**
None.

### Seams

- US-001 → US-002: `approveMemoryNote` reads and rewrites the record through `MemoryStore.readPendingForgets` / `writePendingForgets`; US-002's end-to-end AC drives `forgetMemoryNote` over a real store and `createLocalMemoryProvider`, so the record it consumes is the one US-001's provider wrote.
- US-001 → US-004: the host's `forgetPendingKeys` and index read the record through the real `createMemoryStore`; US-004's host ACs build the host over a real mirror directory.
- US-003 → US-006: the memory tools' `summaryFields` reach the approval line only through `adaptProviderTool` and `askSummary`; US-006's seam AC runs the real memory `save` tool through `createCodingToolRuntime` and asserts on the summary the ask resolver receives.

## Acceptance Criteria

### US-001

- [unit] `createMemoryStore({ projectDir })` returns a store whose `paths.pendingForgets` equals `join(projectDir, "pending-forgets.jsonl")`.
- [unit] `readPendingForgets()` on a store whose project directory has no `pending-forgets.jsonl` resolves to `[]`.
- [unit] `writePendingForgets([a, b])` followed by `readPendingForgets()` resolves to `[a, b]`, in that order, for two valid `MemoryPendingForget` values.
- [unit] `writePendingForgets([])` followed by `readPendingForgets()` resolves to `[]`.
- [unit] A `pending-forgets.jsonl` whose second of three lines is `not json` reads as the first and third entries only.
- [unit] Reading that file logs exactly one warn with stage `memory`, message `skipping a pending-forgets line that is not a pending forget` and data `{ path: paths.pendingForgets, line: 2 }`.
- [unit] A line whose `clientId` is `has space` is skipped by `readPendingForgets`.
- [unit] A line whose `scope` is `team` is skipped by `readPendingForgets`.
- [unit] Pushing a `proposal` forget with slug `Bad_Slug` to the local provider rejects with `NaxError` code `MEMORY_PUSH_REJECTED`, and `readPendingForgets()` stays `[]`.
- [unit] Pushing a `proposal` forget request that has no `reason` records an entry whose `reason` is `""`.
- [unit] Pushing a `proposal` forget request (`clientId` C, `scope` `project`, `slug` `a`, `reason` R) to `createLocalMemoryProvider(store)` leaves `readPendingForgets()` resolving to `[{ clientId: C, scope: "project", slug: "a", reason: R }]`.
- [unit] A second `proposal` forget of `project/a` with a new `clientId` and reason leaves exactly one entry for `project/a`, carrying the new `clientId` and reason.
- [unit] A `proposal` forget of `project/a` when the record already holds `project/b` leaves the record as `[b-entry, a-entry]`.
- [unit] A `direct` forget of `project/a` when the record holds entries for `project/a` and `project/b` leaves the record holding only the `project/b` entry.
- [unit] A `direct` save of `project/a` through the local provider when the record holds `project/a` leaves the record without a `project/a` entry.
- [unit] A `proposal` save of `project/a` through the local provider when the record holds `project/a` leaves the record without a `project/a` entry.
- [unit] A save of `project/a` when the record holds only `project/b` leaves the record equal to `[b-entry]`.
- [unit] A `direct` save through the local provider on a mirror with no `pending-forgets.jsonl` leaves that file absent.
- [unit] When `writePendingForgets` throws `Error("disk full")`, pushing a `proposal` forget to the local provider rejects with that same error, and `isMemoryPushRejected` returns `false` for it.
- [unit] `refreshMemoryIndex(store)` with no `heldForgets` option, on a store holding an active note `project/a` and a record entry for `project/a`, writes a project index whose line for `a` ends with `(forget pending)`.
- [unit] `refreshMemoryIndex(store, { heldForgets: new Set(["project/b"]) })` on a store holding active notes `a` and `b` and a record entry for `project/a` writes a project index whose lines for both `a` and `b` end with `(forget pending)`.
- [unit] On a store with a user directory, a record entry for `user/u` makes the user index line for note `u` end with `(forget pending)`.

Verification note: `bun run check:api` passes after `bun run api:update`.

### US-002

- [unit] With an active note `project/a` and a record entry for `project/a`, `approveMemoryNote` resolves to a note whose `slug` is `a` and whose `status` is `deleted`.
- [unit] After that approval, `store.readNote("project", "a")` resolves to `null`.
- [unit] The note that approval resolves to carries the `updatedAt` the note had before the approval.
- [unit] After that approval, `readPendingForgets()` holds no entry for `project/a`.
- [unit] An approval of `project/a` when the record holds entries for `project/a` and `project/b` leaves the `project/b` entry in the record.
- [unit] After that approval, the project index written by the store no longer lists the slug `a`.
- [unit] With a `pending` note `project/a` and a record entry for `project/a`, `approveMemoryNote` resolves to a note whose `status` is `deleted`, and the note is gone from the mirror.
- [unit] With a record entry for `project/gone` and no note `gone` in the mirror, `approveMemoryNote` for `gone` rejects with `NaxError` code `MEMORY_NOTE_NOT_FOUND`.
- [unit] After that rejected approval, `readPendingForgets()` still holds the `project/gone` entry.
- [unit] When the store's `deleteNote` throws `Error("delete failed")`, approving `project/a` with a record entry for it rejects with that error.
- [unit] After that failed approval, `readPendingForgets()` still holds the `project/a` entry.
- [integration] Over a real store and `createLocalMemoryProvider`: `saveMemoryNote` (`direct`) of `a`, then `forgetMemoryNote` (`proposal`, reason `wrong`) of `a`, leaves `store.readNote("project", "a")` with `status` `active` and the project index line for `a` ending with `(forget pending)`.
- [integration] Continuing that sequence, `approveMemoryNote` for `a` then leaves `store.readNote("project", "a")` resolving to `null`.

### US-003

- [unit] `askSummary("T", { pathFields: [], summaryFields: ["slug", "scope"] }, { slug: "a", scope: "project" })` returns the summary `T slug=a scope=project` with `unshowable` `false`.
- [unit] A `summaryFields` entry absent from the input adds nothing: `summaryFields: ["slug", "type"]` with input `{ slug: "a" }` returns `T slug=a`.
- [unit] A number value renders through `String`: `summaryFields: ["n"]` with `{ n: 3 }` returns `T n=3`.
- [unit] A boolean value renders through `String`: `summaryFields: ["f"]` with `{ f: true }` returns `T f=true`.
- [unit] An object value is skipped: `summaryFields: ["o"]` with `{ o: { k: 1 } }` returns `T`.
- [unit] An array value is skipped: `summaryFields: ["xs"]` with `{ xs: ["a"] }` returns `T`.
- [unit] Line breaks in a value become one space each: `summaryFields: ["d"]` with `{ d: "one\ntwo\r\nthree" }` returns `T d=one two three`.
- [unit] Summary fields follow the path parts: scope `{ pathFields: ["path"], summaryFields: ["slug"] }` with `{ path: "x", slug: "a" }` returns `T path=x slug=a`.
- [unit] A summary field whose value contains `ghp_abcdefghijklmnop1234` yields a summary that does not include `ghp_abcdefghijklmnop1234`.
- [unit] A summary field value of 500 characters yields a summary no longer than `MAX_ASK_SUMMARY_CHARS`.
- [unit] `adaptProviderTool("p", tool)` for a `ProviderTool` with `summaryFields: ["slug"]` returns a tool whose `scope.summaryFields` equals `["slug"]`.
- [unit] `adaptProviderTool("p", tool)` for a `ProviderTool` without `summaryFields` returns a tool whose `scope` equals `{ pathFields: [] }`.
- [integration] `createCodingToolRuntime` with `extraTools: [adaptProviderTool("p", saveTool)]` (`saveTool.summaryFields` `["slug"]`), `policy: compileToolPolicy([{ tool: "p__save", patterns: ["*"] }], root, { askRules: [{ tool: "p__save", patterns: ["*"] }] })`, and `askResolver` set to an `AskResolver` that records its request and allows: `callTool("p__save", { slug: "a" })` hands the resolver a request whose `summary` is `p__save slug=a`.

### US-004

- [integration] A host from `createMemoryHost` over a mirror whose `pending-forgets.jsonl` holds an entry for `project/a` resolves `forgetPendingKeys()` to a set containing `project/a`.
- [integration] That host's `forgetPendingKeys()` also contains `project/q` when the outbox holds a queued forget entry for `project/q`.
- [integration] That host's `renderIndex()` text has its line for the active note `a` ending with `(forget pending)`.
- [unit] `memoryListCommand` with a host whose `notes` returns note `a` and whose `forgetPendingKeys` resolves to `{ "project/a" }` logs `formatMemoryNoteLine(a) + " (forget pending)"`.
- [unit] `memoryListCommand` with a host that has no `forgetPendingKeys` member logs each row as `formatMemoryNoteLine(note)` and returns `0`.
- [unit] `memoryListCommand` with a host holding no notes and no `--type` or `--scope` logs exactly `no memory notes` and returns `0`.
- [unit] `memoryListCommand` with `--type feedback` over a host holding only a `project`-type note logs exactly `no memory notes match` and returns `0`.
- [unit] `memoryListCommand` with `--json` over a host holding no notes logs exactly `{"notes":[]}`.
- [unit] `memoryApproveCommand("a")` with a host whose `getNote` returns an `active` note and whose `approve` returns that note logs `project/a is already active; nothing to approve` and returns `0`.
- [unit] `memoryApproveCommand("a")` with a host whose `getNote` returns an `active` note and whose `approve` returns it with `status` `deleted` logs `forgot project/a (forget approved)` and returns `0`.
- [unit] `memoryApproveCommand("a")` with a host whose `getNote` returns a `pending` note and whose `approve` returns it `active` logs `approved project/a`.
- [unit] `memoryApproveCommand` calls `host.getNote` with the scope and slug before it calls `host.approve`.
- [unit] `memoryApproveCommand("absent")` with a host whose `getNote` resolves to `null` and whose `approve` throws `NaxError` code `MEMORY_NOTE_NOT_FOUND` still calls `host.approve`, logs `Error: no memory note project/absent` to stderr and returns `1`.
### US-005

- [unit] `readRepoNotes` accepts `.nax/memory/staging-db.md` holding the minimal note in Design (only `slug`, `type`, `description`) and returns one note with `slug` `staging-db`.
- [unit] That accepted note has `id` `staging-db`.
- [unit] That accepted note has `scope` `project` and `status` `active`.
- [unit] That accepted note has `source` `repo`.
- [unit] When the file's modification time is set to `2026-11-01T10:00:00.000Z`, that accepted note has `updatedAt` `2026-11-01T10:00:00.000Z`.
- [unit] A minimal note that also sets `id: team-1` is accepted with `id` `team-1`.
- [unit] A minimal note that also sets `updatedAt: 2026-01-01T00:00:00Z` is accepted with `updatedAt` `2026-01-01T00:00:00Z`.
- [unit] A minimal note that also sets `scope: user` is skipped with reason `scope is not project`.
- [unit] A minimal note that also sets `status: pending` is skipped with reason `status is not active`.
- [unit] A note with `slug` and `description` but no `type` is skipped with a reason that starts with `invalid note:` and names `type`.
- [unit] A note with `slug` and `type` but no `description` is skipped with a reason that starts with `invalid note:` and names `description`.
- [unit] A note with `type` and `description` but no `slug` is skipped, and `readRepoNotes` returns no note for it.
- [unit] A minimal note whose frontmatter has an opening `---` but no closing `---` is skipped with a reason that starts with `invalid note:`.
- [unit] A minimal note with no blank line between the closing `---` and the body is skipped with a reason that starts with `invalid note:`.

### US-006

- [unit] `cliMemoryLogger(deps).warn("memory", "repo note skipped", { path: "/r/.nax/memory/a.md", reason: "invalid note: x" })` hands `deps.logErr` the line `[memory] repo note skipped: path=/r/.nax/memory/a.md reason=invalid note: x`.
- [unit] `cliMemoryLogger(deps).warn("memory", "m")` with no data hands `deps.logErr` exactly `[memory] m`.
- [unit] `cliMemoryLogger(deps).warn("memory", "m", {})` hands `deps.logErr` exactly `[memory] m`.
- [unit] `cliMemoryLogger(deps).warn("memory", "m", { skipped: 3, ok: false, list: ["a"] })` hands `deps.logErr` `[memory] m: skipped=3 ok=false list=["a"]`.
- [unit] `cliMemoryLogger(deps).error("memory", "m", { reason: "one\ntwo" })` hands `deps.logErr` `[memory] m: reason=one two`.
- [unit] The `save` tool of `await createMemoryToolProvider(host).tools(repoRoot)` has `summaryFields` equal to `["scope", "slug", "type", "description"]`.
- [unit] The `forget` tool of that provider has `summaryFields` equal to `["scope", "slug", "reason"]`.
- [unit] The `get` tool of that provider has no `summaryFields`.
- [unit] The `search` tool of that provider has no `summaryFields`.
- [integration] `createCodingToolRuntime` with `extraTools` holding `adaptProviderTool("nax-memory", <the save tool from await provider.tools(repoRoot)>)`, `policy: compileToolPolicy([{ tool: "nax-memory__save", patterns: ["*"] }], root, { askRules: [{ tool: "nax-memory__save", patterns: ["*"] }] })`, and `askResolver` set to an `AskResolver` that records its request and denies: `callTool("nax-memory__save", { scope: "project", slug: "chat-smoke", type: "feedback", description: "Chat smoke note", body: "b" })` hands the resolver the summary `nax-memory__save scope=project slug=chat-smoke type=feedback description=Chat smoke note`.
