# SPEC: Memory forget and record integrity (2026-11-09 review, F3)

## Summary

Close four findings from the 2026-11-09 whole-repo review (`docs/reviews/20261109-review-nax.md`): M12, M13, M14
and M23, and record why a fifth (L31) needs no code. Two make a forget lie: an MCP forget whose remote delete fails
reports `deleted` and drops the remote ids, so the outbox never retries it (M12), and an MCP forget on a server with
no forget tool reports `deleted` while nax search still returns the remote copy first (M13). One loses records: an
unreadable `koda-approvals.json` or `mcp-ids.json` reads as empty and the next write replaces it, dropping every
record it held (M14). One leaks retired notes: koda memory search maps rejected and deleted rows to `active` hits
(M23).

This is feature F3 of five cut from that review (user ruling 2026-11-09). F1 and F2 are merged. F4 (gates and
config) and F5 (LOW sweep) follow as separate specs.

## Motivation

- **M12** (`src/memory/mcp-provider.ts:107-135`). `forgetRemote` only warns when a delete answers `isError` or
  throws, and `forget` then drops every id it tried and resolves `{ status: "deleted" }`. The outbox treats the
  forget as delivered and never retries it, and the remote copy stays searchable. Re-run proof: a pool whose `call`
  throws gave `push result: {"id":"c1","status":"deleted"}` and `idMap.drop` was called with `["remote-1"]`.
- **M13** (`src/memory/mcp-provider.ts:118-124`). With no `memory.mcp.tools.forget` (optional in
  `config/schemas-memory.ts`, because OpenMemory has no delete tool), `forget` drops the ids and resolves `deleted`.
  `host-remote-search.ts` `mergeRemoteFirst` puts remote hits ahead of local ones, so the note the user just forgot
  comes back as the first search hit.
- **M14** (`src/memory/koda-approvals.ts:148-165`, `:253-254`; `src/memory/mcp-id-map.ts:84-99`, `:144-150`). A
  read error other than ENOENT (EACCES, EIO, a directory at the path) reads as "unusable", the same as corrupt JSON,
  and the next `record`, `add` or `drop` writes a file holding only the new state. Re-run proof: three approval
  records, `chmod 000`, one new record, and the file then held only `["apr_3"]`.
- **M23** (`src/memory/koda-mapping.ts:466-477`). `kodaHitOf` always returns `status: "active"` and never reads the
  row's `status` or `deletedAt`, and the search request (`koda-provider.ts:336-341`) sends no status filter, while
  the lookup path (`koda-lookup.ts:143`) sends `status: "active"`. A rejected or deleted note can come back as an
  active hit.
- **L31** (`src/memory/koda-approvals.ts:198-231`). The review flagged the per-instance serialisation as letting
  two processes lose a record. Grounding found every caller already runs under the memory mirror's cross-process
  lock (see Design), so no code changes; the remaining gap is recorded in Out of Scope.

## Design

Each fix stays inside the module the finding names. Two rules run through all of them:

- **A read error is not an empty file.** Only ENOENT means "no records yet". Any other read error is thrown as a
  retryable `NaxError`, so the operation that needed the file fails and the outbox retries it, and nothing is
  written over a file nax could not read. Content that was read but does not parse as the expected version-1 shape
  (not JSON, another version, another MCP server, a malformed entry) keeps today's behaviour: it reads as empty and
  the next write replaces it.
- **A forget reports `deleted` only for what it actually removed or hid.** A delete that failed stays recorded and
  makes the push fail as retryable. A server with no delete tool gets the note hidden from nax's own search instead.

**L31 needs no code.** `KodaApprovals.record` is called only from the koda provider's `push` (a `202` save), and
`list` and `drop` only from the koda pull (`koda-pull.ts:388`, `:423`). `provider.push` runs from
`nax-agent/src/memory/operations.ts` inside `withMirrorLock` (`:359` save, `:411` forget) and from the outbox drain,
and `provider.pull` from the sync; both the drain and the pull run under the sync's `acquireMirrorLocks`. Each of
these takes `storeLockTargets(store)`, the project and user `sync.lock` files, which a second process (`nax run` next
to `nax chat`) also has to take. The one gap is a save push that outlives `MEMORY_OP_TIMEOUT_MS`: the operation stops
waiting and releases the lock while the push is still running, so its `record` can run without the lock.

### Integration

The symbols below are **changed** by this feature. Each `Baseline:` exists only to locate the code; the `Target:`
is the shape to implement.

**`src/memory/mcp-id-map.ts`** (US-001, US-003)

- `readNotes(path, server)`. Baseline: returns `{ notes: new Map(), state: "unusable" }` when
  `_mcpIdMapDeps.readText` throws anything but ENOENT. Target (US-001): throws
  `NaxError("[memory] cannot read MCP id map <path>: <message>", "MEMORY_MCP_ID_MAP_READ_FAILED", { stage: "memory", path, retryable: true, cause })`.
  ENOENT still returns `state: "missing"`; text that fails `JSON.parse` or `notesOf` still returns
  `state: "unusable"`.
- `McpIdMap`. Baseline: `ids`, `add`, `drop`. Target (US-003): adds
  `hide(scope: MemoryScope, slug: string): Promise<readonly string[]>` and
  `hiddenIds(scope: MemoryScope): Promise<ReadonlySet<string>>`. `hide` runs through the same `serialised` queue as
  `add` and `drop`, and `hiddenIds` waits for that queue to settle before reading, as `ids` does. `hide` moves the slug's recorded ids into `hidden` and resolves them; on a missing file, a file whose
  content is not usable, or a slug with no recorded ids it resolves `[]` and writes nothing.
- File format. Baseline: `{ "version": 1, "server": "om", "notes": { "s1": ["r1"] } }`. Target (US-003): an
  optional `"hidden": ["r1", "r2"]` array of remote ids, written only when non-empty, so a file with nothing hidden
  is byte-for-byte what is written today. A `hidden` value that is not an array of strings reads as no hidden ids
  and leaves the file usable. `drop` carries the `hidden` list through unchanged. `add` removes from `hidden` every
  id it records: a server that answers a later save with the same remote id (a dedupe or an update) has made that
  copy live again.

**`src/memory/koda-approvals.ts`** (US-001)

- `_kodaApprovalsDeps`. Baseline: `{ write, rename }`; reads call `Bun.file(path).text()` directly. Target: adds
  `read(path: string): Promise<string>` (default `Bun.file(path).text()`), and `readApprovals` reads through it.
- `ApprovalsRead.state`. Baseline: `"valid" | "missing" | "unusable"`. Target:
  `"valid" | "missing" | "unusable" | "unreadable"`. `"unreadable"` means the read threw something other than
  ENOENT, and the read carries that error.
- `record(entry)` and `drop(approvalIds)`. Baseline: write after any read. Target: on an `"unreadable"` read, reject
  with
  `NaxError("[memory] cannot read koda approvals <path>: <message>", "MEMORY_KODA_APPROVALS_READ_FAILED", { stage: "memory", path, retryable: true, cause })`
  and write nothing.
- `list()` is unchanged in result: an `"unreadable"` read resolves `[]` and logs the existing once-per-instance
  warn `"koda approvals file is unusable"`. The instance's `read()` wrapper, which today warns only on
  `"unusable"`, warns on `"unreadable"` too, sharing the same once-per-instance flag. `list` writes nothing, so returning `[]` loses no record, and throwing
  would fail every pull while the file stays unreadable.

**`src/memory/mcp-provider.ts`** (US-002, US-003)

- `forgetRemote(tool, idArg, id)`. Baseline: returns `void`, warns on failure. Target: returns
  `{ kind: "answered" | "threw"; text: string }` for a failure (`result.content` for an `isError` answer, which may be
  the empty string; `errorMessage(error)` for a throw) or `undefined` on success, and keeps its warn
  `"memory mcp forget failed"` with `{ server, id, error }`. A delete succeeded exactly when the result is
  `undefined`.
- `forget(request)` with `tools.forget` set. Baseline: deletes each id, drops all of them, resolves `deleted`.
  Target (US-002): deletes each recorded id in order, drops only the ids whose delete succeeded
  (`idMap.drop(scope, slug, confirmed)`, skipped when none succeeded), then, if any delete failed, rejects with a
  retryable `NaxError` whose message is `[memory] MCP memory server "<server>" tool "<tool>" failed: <first failure text>`:
  - code `MEMORY_MCP_CALL_FAILED` when any delete threw (a transport failure, the provider's fault);
  - otherwise code `MEMORY_MCP_FORGET_BAD_RESPONSE` (every failed delete was answered with `isError`).

  The `_BAD_RESPONSE` suffix makes `isMemoryBadResponse` true, so the outbox drain (`sync-drain.ts`
  `proveAndPark`) counts it against the entry and parks the forget as `rejected` after
  `MEMORY_PUSH_MAX_BAD_RESPONSES` (3) once a write for another key is answered. A delete the server keeps refusing,
  for example an id it no longer holds, then stops blocking the outbox. With no failure it resolves
  `{ id: request.clientId, status: "deleted" }`.
- `forget(request)` without `tools.forget`. Baseline: `idMap.drop(scope, slug)`, resolves `deleted`. Target
  (US-003): `const hidden = await idMap.hide(scope, slug)`; when `hidden` is non-empty, warn
  `"memory mcp forget kept the server copy"` with `{ server, slug, ids: hidden.length }`; resolves `deleted`. Still
  no `pool.call` or `pool.listTools`.
- `search({ scope, text, limit })`. Baseline: maps every parsed item to a hit, then cuts to `limit`. Target (US-003):
  reads `idMap.hiddenIds("project")` and `idMap.hiddenIds("user")` and drops every item whose `id` is in either set
  before the cut, so `limit` counts kept hits. Both scopes, because one MCP server holds both scopes' saves and
  `host-remote-search.ts` always asks the provider with `scope: "project"`. An item keeps the slug it gets today: `mcpHitOf` is still given the item's position in the server's
  answer.

**`src/memory/koda-mapping.ts`** and **`src/memory/koda-provider.ts`** (US-004)

- `kodaHitOf(record, index, total)`. Baseline: returns a hit with `status: STATUS_ACTIVE` for any note row. Target:
  returns `null` when the row's `status` is not `"active"` or its `deletedAt` is a string (`readNoteRow`'s
  `status` and `deleted` fields).
- `search` in `createKodaMemoryProvider`. Baseline: `client.get("projects/<project>/memory", { kind, scope, text, size })`.
  Target: `{ kind, scope, status: "active", text, size }`, in that order, matching the lookup in `koda-lookup.ts`.

Read only (verified, unchanged):

- `MemoryWriteRequest`, `MemoryPushResult`, `isMemoryPushRejected` (`@nathapp/nax-agent`): a throw that is not
  `MEMORY_PUSH_REJECTED` is transient; `handOverForget` then queues the forget and returns `delivered: false`, and
  the drain stops at that entry and retries it on the next sync.
- `createMemoryHost` (`src/memory/host.ts`) and its `save`, `forget`, `search`, `sync`: the entry points the seam
  ACs enter at.
- `McpMemoryItem { id?: string; text: string; score?: number }` and `mcpHitOf` (`src/memory/mcp-results.ts`): a hit's
  slug is `mcp-` plus the folded remote id.

Patterns to follow: the `serialised` queue and the temp-plus-rename write already in both record modules; the
`NaxError` shape of `MEMORY_MCP_ID_MAP_WRITE_FAILED` and `MEMORY_KODA_APPROVALS_WRITE_FAILED`; the fake pool and
temp-dir id map in `test/unit/memory/mcp-provider.test.ts` and `test/unit/memory/host-mcp.test.ts`.

### Failure Handling

| Situation | Behaviour |
|:---|:---|
| `mcp-ids.json` read throws EACCES, EIO or EISDIR | `ids`, `add`, `drop`, `hide` and `hiddenIds` reject with `MEMORY_MCP_ID_MAP_READ_FAILED` (retryable); the file is not written. |
| `koda-approvals.json` read throws anything but ENOENT | `record` and `drop` reject with `MEMORY_KODA_APPROVALS_READ_FAILED` (retryable) and write nothing; `list` resolves `[]` with one warn. |
| Either file holds text that is not a usable version-1 file | Reads as empty and the next write replaces it, as today. |
| An MCP save's add succeeds but the id-map read then fails | The save push rejects as retryable and the outbox retries it, so the server may get the memory twice. |
| A koda save answered `202` but the approvals read fails | The save push rejects as retryable and is retried, so koda may open a second approval request for the slug. |
| Some deletes of an MCP forget fail | The confirmed ids are dropped and the failed ones stay recorded; the retry deletes only what is left. |
| A failed delete threw (transport) | The push rejects with `MEMORY_MCP_CALL_FAILED`; the drain stops there and retries on the next sync, as for any outage. |
| Every failed delete was answered `isError` | The push rejects with `MEMORY_MCP_FORGET_BAD_RESPONSE`; after 3 such answers and an answered write for another key, the drain parks the forget as `rejected`. |
| A forget with no forget tool and recorded ids | The ids move to `hidden`, one warn, resolves `deleted`. |
| `hiddenIds` rejects during an MCP search | The search rejects; `searchRemote` already turns that into one warn and the local hits only, so no forgotten copy is shown. |

## Out of Scope

- L31 (two processes racing on `koda-approvals.json`): no code. Every `record`, `list` and `drop` already runs under the memory mirror's cross-process `sync.lock` files. The remaining gap is a koda save push that outlives `MEMORY_OP_TIMEOUT_MS` and records after the operation released the lock.
- A server copy hidden by US-003 stays on the MCP server and stays visible to other clients of that server. Without a forget tool, nax cannot delete it.
- Un-hiding across scopes. `add` un-hides only ids in its own scope's file, while search hides the union of both, so a project-scope save the server answers with an id hidden in the user file stays hidden.
- Hiding the server copy of a forget that is queued or parked after failed `isError` deletes. Until a delete succeeds, nax search still returns that copy.
- Purging the `hidden` list, including deleting hidden ids once a forget tool is configured later. The list only grows.
- Hiding a remote memory that has no id in the search answer, or one whose save answer carried no parseable ids. Neither can be matched to the forgotten note.
- An older nax rewriting `mcp-ids.json` drops the `hidden` list it does not know about, so hidden copies show again in that older version.
- Backing up a file whose content does not parse before it is replaced. Corrupt content keeps today's rewrite.
- A duplicate remote memory, or a second koda approval request, from retrying a save whose record write failed after the server accepted it.
- Parking a forget whose remote delete keeps throwing. A `MEMORY_MCP_CALL_FAILED` forget is treated as an outage: it stays at the head of the outbox and blocks later writes until the server answers, as a failing save is today. Only `isError` answers (`MEMORY_MCP_FORGET_BAD_RESPONSE`) are parked.
- Telling a delete the server refuses because the id is already gone from any other refusal. Both are `MEMORY_MCP_FORGET_BAD_RESPONSE`; the drain parks the forget after 3, and `nax memory discard` clears it.
- Changing the code an MCP save's `isError` answer rejects with. A save keeps `MEMORY_MCP_CALL_FAILED`.
- US-002 only: a `createMemoryHost` test that drives a forget through the drain to `parked`. The parking itself is the existing `proveAndPark` path; US-002 proves the code it keys on.
- Checking whether koda's server already filters retired rows from search. US-004 filters on the client either way.
- The other review findings (M1-M11, M15-M23 not listed above, L1-L37 except L31). M1-M11 and M18 shipped in F1 and F2; the rest belong to F4 and F5.

## Stories

Four stories, all in `packages/nax`. US-002 depends on US-001 (its MCP save AC needs the id map's read rule). US-003 depends on US-001 (the id map's read rule, which the new methods share)
and on US-002 (both change `forget` in `mcp-provider.ts`).

### US-001: An unreadable memory record file is refused, never overwritten

Workdir: packages/nax. No dependencies.

Fix review M14 for both record files. In `mcp-id-map.ts`, a read error other than ENOENT throws
`MEMORY_MCP_ID_MAP_READ_FAILED` instead of reading as empty. In `koda-approvals.ts`, add a `read` seam to
`_kodaApprovalsDeps` and an `"unreadable"` read state; `record` and `drop` reject with
`MEMORY_KODA_APPROVALS_READ_FAILED` on it and write nothing, while `list` keeps resolving `[]` with its one warn.
Content that was read but is not a usable version-1 file keeps today's rewrite. Update both modules' doc comments.

### US-002: A failed MCP remote delete keeps its ids and is retried

Workdir: packages/nax. Depends on US-001.

Fix review M12. `forgetRemote` reports each failure to `forget`, which drops only the ids whose delete succeeded and
then rejects when any delete failed, so the outbox keeps the forget and the next attempt deletes only what is left.
The rejection is `MEMORY_MCP_CALL_FAILED` when a delete threw, and `MEMORY_MCP_FORGET_BAD_RESPONSE` when every
failed delete was answered `isError`, so a delete the server keeps refusing is eventually parked instead of blocking
the outbox. The per-id warn stays. Update the `mcp-provider.ts` header comment's list of refusals to name the new code.

### US-003: A forget on an MCP server with no delete tool hides the server copy from nax search

Workdir: packages/nax. Depends on US-001, US-002.

Fix review M13 (user ruling 2026-11-09: hide, do not refuse). Add `hide` and `hiddenIds` to `McpIdMap` and the
optional `hidden` array to `mcp-ids.json`. A forget without `tools.forget` moves the note's remote ids to `hidden`
and warns once that the server copy remains; the provider's `search` drops items whose id is hidden in either scope
before cutting to the limit, and a later save answered with a hidden id un-hides it.

### US-004: koda memory search returns only active notes

Workdir: packages/nax. No dependencies.

Fix review M23. `kodaHitOf` returns `null` for a row whose `status` is not `active` or whose `deletedAt` is set, and
the provider's search sends `status: "active"` between `scope` and `text`.

### Context Files

**US-001**

- `packages/nax/src/memory/mcp-id-map.ts`
- `packages/nax/src/memory/koda-approvals.ts`
- `packages/nax/test/unit/memory/mcp-id-map.test.ts`
- `packages/nax/test/unit/memory/koda-approvals.test.ts`
- `packages/nax/test/unit/memory/koda-provider-save.test.ts`

**US-002**

- `packages/nax/src/memory/mcp-provider.ts`
- `packages/nax/src/memory/mcp-id-map.ts`
- `packages/nax/test/unit/memory/mcp-provider.test.ts`
- `packages/nax/test/unit/memory/host-mcp.test.ts`
- `packages/nax/src/memory/host.ts`

**US-003**

- `packages/nax/src/memory/mcp-id-map.ts`
- `packages/nax/src/memory/mcp-provider.ts`
- `packages/nax/test/unit/memory/mcp-id-map.test.ts`
- `packages/nax/test/unit/memory/mcp-provider-id-map.test.ts` — created by US-002, extended here
- `packages/nax/test/unit/memory/host-mcp-forget.test.ts` — created by US-002, extended here

**US-004**

- `packages/nax/src/memory/koda-mapping.ts`
- `packages/nax/src/memory/koda-provider.ts`
- `packages/nax/src/memory/koda-lookup.ts`
- `packages/nax/test/unit/memory/koda-provider-forget-search.test.ts`

### Creates

**US-002**

- `packages/nax/test/unit/memory/host-mcp-forget.test.ts` — the `createMemoryHost` forget-and-sync cases for US-002 and US-003, kept out of `host-mcp.test.ts` (571 lines) so neither file passes the 650-line target.
- `packages/nax/test/unit/memory/mcp-provider-id-map.test.ts` — the new provider-level cases that depend on the id map (US-002's save and forget cases, US-003's forget and hidden-search cases), kept out of `mcp-provider.test.ts` (528 lines) for the same reason.

### Modifies

**US-001**

- `packages/nax/test/unit/memory/mcp-id-map.test.ts` — "an unreadable file reads as empty (AC-25)" (line 121) asserts that `ids` resolves `[]` when `readText` throws `EACCES`, and "add rewrites the file after an unreadable read (AC-27)" (line 153) asserts that `add` replaces a valid file holding `s1: ["old"]` after `readText` throws `EIO`. Both reads now reject. Replacement invariant: with `readText` throwing `EACCES`, `ids` rejects with `MEMORY_MCP_ID_MAP_READ_FAILED`; with `readText` throwing `EIO`, `add` rejects with that code and the file still holds `s1: ["old"]`. The other unusable-content cases (not JSON, another version, another server, a non-object `notes`) keep their assertions.

**US-002**

- `packages/nax/test/unit/memory/mcp-provider.test.ts` — under "when the call for r1 answers isError", "still tries r2 (AC-29)" (line 361) and "warns with stage, message and server/id/error (AC-30, AC-41)" (line 366) await a push that now rejects, and "resolves deleted and drops the entry (AC-31)" (line 378) asserts status `deleted` and an empty id-map entry; "a pool that throws for one id is also a warning, not a failure" (line 466) asserts status `deleted` when `pool.call` throws for r1. Replacement invariant: in all four cases the push rejects, with `MEMORY_MCP_FORGET_BAD_RESPONSE` in the three `isError` cases and `MEMORY_MCP_CALL_FAILED` in the throwing-pool case; deletes are still attempted for r1 then r2; the warn for r1 keeps exactly `{ server: "om", id: "r1", error: <the failure text> }`; afterwards `idMap.ids("project", "s1")` is `["r1"]`.

**US-003**

- `packages/nax/test/unit/memory/host-mcp.test.ts` — "AC-4 the id map is built over the host's own directories for the server" (line 218) builds a stub id map with only `ids`, `add` and `drop` and assigns it through `_memoryHostDeps.createMcpIdMap`, which stops type-checking once `McpIdMap` gains `hide` and `hiddenIds`. Replacement invariant: the stub also has `hide` resolving `[]` and `hiddenIds` resolving an empty set; the test still asserts the factory got `{ dirs: host.dirs, server: SERVER }` and the provider got that same stub.

**US-004**

- `packages/nax/test/unit/memory/koda-provider-forget-search.test.ts` — "a query requests kind, scope, text and size in that order (AC-17)" (line 129) asserts the exact search URL query `kind=NOTE&scope=project&text=replay+budget&size=5`. The search now sends `status=active`. Replacement invariant: the query is exactly `kind=NOTE&scope=project&status=active&text=replay+budget&size=5`.

### Seams

- `McpIdMap.hide` and `McpIdMap.hiddenIds` (created by US-003, internal to `src/memory/`) are called by the MCP provider's `forget` and `search` in the same story. US-003's `createMemoryHost` ACs enter at `host.forget` and `host.search` and prove both calls are wired.
- The retryable rejections of US-001 and US-002 reach the outbox through `provider.push`. The koda and MCP save ACs prove the save rejection is not a permanent refusal (`isMemoryPushRejected` is false), which the existing operations and drain treat as retryable; US-002's `host.forget` and `host.sync` ACs prove a forget is actually retried.

## Acceptance Criteria

### US-001

- [unit] With `_mcpIdMapDeps.readText` throwing an error whose `code` is `EACCES`, `createMcpIdMap({ dirs, server: "om" }).ids("project", "s1")` rejects with a `NaxError` whose `code` is `MEMORY_MCP_ID_MAP_READ_FAILED` and whose context `retryable` is `true`.
- [unit] That `MEMORY_MCP_ID_MAP_READ_FAILED` rejection's message contains the path of the project scope's `mcp-ids.json`.
- [unit] With the project `mcp-ids.json` holding `{ "version": 1, "server": "om", "notes": { "s1": ["old"] } }` and `_mcpIdMapDeps.readText` then throwing an error whose `code` is `EIO`, `add("project", "s1", ["n"])` rejects with `MEMORY_MCP_ID_MAP_READ_FAILED` and `_mcpIdMapDeps.writeText` is never called.
- [unit] Under the same file and `EIO` read error, `drop("project", "s1")` rejects with `MEMORY_MCP_ID_MAP_READ_FAILED` and `_mcpIdMapDeps.writeText` is never called.
- [unit] With `_mcpIdMapDeps.readText` throwing an error whose `code` is `ENOENT`, `add("project", "s1", ["n"])` resolves and the project `mcp-ids.json` then holds notes `{ "s1": ["n"] }`.
- [unit] With `_kodaApprovalsDeps.read` throwing an error whose `code` is `EACCES`, `createKodaApprovals({ dir, logger }).record(APR_1)` rejects with a `NaxError` whose `code` is `MEMORY_KODA_APPROVALS_READ_FAILED` and whose context `retryable` is `true`, and `_kodaApprovalsDeps.write` is never called.
- [unit] With `_kodaApprovalsDeps.read` throwing an error whose `code` is `EACCES`, `drop(["apr_1"])` rejects with `MEMORY_KODA_APPROVALS_READ_FAILED` and `_kodaApprovalsDeps.write` is never called.
- [unit] With `_kodaApprovalsDeps.read` throwing an error whose `code` is `EACCES`, two `list()` calls on one instance each resolve `[]` and the logger receives exactly one warn with message `koda approvals file is unusable`.
- [unit] With `_kodaApprovalsDeps.read` throwing an error whose `code` is `ENOENT`, `record(APR_1)` resolves and a fresh instance's `list()` resolves `[APR_1]`.
- [integration] With a directory created at `<dir>/koda-approvals.json` and no seam overridden, `record(APR_1)` rejects with `MEMORY_KODA_APPROVALS_READ_FAILED` and `<dir>/koda-approvals.json` is still a directory.
- [unit] With a koda provider built over `createKodaApprovals` whose `_kodaApprovalsDeps.read` throws an error whose `code` is `EACCES`, and the stubbed transport answering a save with `202` and an approval id, `provider.push` of that save rejects with `MEMORY_KODA_APPROVALS_READ_FAILED` and `isMemoryPushRejected` of the rejection is `false`.

### US-002

- [unit] With an MCP provider built over a real `createMcpIdMap` whose `_mcpIdMapDeps.readText` throws an error whose `code` is `EACCES`, and the add tool answering `{"results":[{"id":"r1","event":"ADD"}]}`, `provider.push` of a save rejects with `MEMORY_MCP_ID_MAP_READ_FAILED` and `isMemoryPushRejected` of the rejection is `false`.
- [unit] With `tools.forget` set to `delete_memory`, `args.id` set to `memory_id`, the id map holding `s1: ["r1", "r2"]`, and the `delete_memory` call for `r1` answering `isError` with content `no such memory` while `r2` answers `ok`, `provider.push` of a forget for `s1` rejects with a `NaxError` whose `code` is `MEMORY_MCP_FORGET_BAD_RESPONSE` and whose context `retryable` is `true`, and `isMemoryBadResponse` of the rejection is `true`.
- [unit] In that case the rejection's message contains `tool "delete_memory" failed` and `no such memory`.
- [unit] In that case `delete_memory` is called for `r1` and then `r2`, and afterwards `idMap.ids("project", "s1")` resolves `["r1"]`.
- [unit] In that case the logger receives one warn with message `memory mcp forget failed` and data exactly `{ server: "om", id: "r1", error: "no such memory" }`.
- [unit] With the id map holding `s1: ["r1", "r2"]` and `pool.call` throwing `Error("socket closed")` for `r1` while `r2` answers `ok`, the forget push rejects with `MEMORY_MCP_CALL_FAILED`, `isMemoryBadResponse` of the rejection is `false`, and afterwards `idMap.ids("project", "s1")` resolves `["r1"]`.
- [unit] With the id map holding `s1: ["r1", "r2"]`, `pool.call` throwing `Error("socket closed")` for `r1` and `r2` answering `isError`, the forget push rejects with `MEMORY_MCP_CALL_FAILED`.
- [unit] With the id map holding `s1: ["r1", "r2"]` and both deletes answering `isError`, the forget push rejects with `MEMORY_MCP_FORGET_BAD_RESPONSE` and afterwards `idMap.ids("project", "s1")` resolves `["r1", "r2"]`.
- [unit] With the id map holding `s1: ["r1"]` and the delete for `r1` answering `isError` with empty content, the forget push rejects with `MEMORY_MCP_FORGET_BAD_RESPONSE` and `idMap.ids("project", "s1")` still resolves `["r1"]`.
- [unit] After a forget push rejected because `r1`'s delete failed, a second forget push for `s1` with `r1` now answering `ok` calls `delete_memory` once, for `r1` only, resolves `{ id: "c-forget", status: "deleted" }`, and leaves `idMap.ids("project", "s1")` as `[]`.
- [integration] With `createMemoryHost` over a fake pool whose server lists `add_memories`, `search_memory` and `delete_memory`, `memory.mcp.tools.forget` set to `delete_memory`, `host.save` of note `s1` answered with remote id `r1`, and `delete_memory` answering `isError`, `host.forget({ scope: "project", slug: "s1", reason: "outdated" })` resolves with `delivered` equal to `false`.
- [integration] After that undelivered forget, with `delete_memory` now answering `ok`, `host.sync()` makes the fake pool receive a second `delete_memory` call with `memory_id` `r1`.
- [integration] After that sync delivered the forget, a second `host.sync()` makes no further `delete_memory` call.

### US-003

- [unit] With the id map holding `s1: ["r1", "r2"]`, `hide("project", "s1")` resolves `["r1", "r2"]`, afterwards `ids("project", "s1")` resolves `[]`, and `hiddenIds("project")` resolves a set holding exactly `r1` and `r2`.
- [unit] After that `hide`, the project `mcp-ids.json` parses to `{ "version": 1, "server": "om", "notes": {}, "hidden": ["r1", "r2"] }`.
- [unit] With a missing `mcp-ids.json`, `hide("project", "s1")` resolves `[]` and no file is written.
- [unit] With the project `mcp-ids.json` holding `this is not json`, `hide("project", "s1")` resolves `[]` and the file still holds `this is not json`.
- [unit] With a file holding notes `s2: ["r5"]` and no entry for `s1`, `hide("project", "s1")` resolves `[]` and `_mcpIdMapDeps.writeText` is never called.
- [unit] With a file holding `hidden: ["r1", "r2"]`, `add("project", "s1", ["r1"])` leaves `hiddenIds("project")` holding exactly `r2` and `ids("project", "s1")` resolving `["r1"]`.
- [unit] With a file holding `hidden: ["r1"]` and notes `s2: ["r5"]`, `add("project", "s2", ["r6"])` leaves `hiddenIds("project")` holding exactly `r1` and `ids("project", "s2")` resolving `["r5", "r6"]`.
- [unit] A file holding `{ "version": 1, "server": "om", "notes": { "s1": ["a"] }, "hidden": "r1" }` reads with `ids("project", "s1")` resolving `["a"]` and `hiddenIds("project")` resolving an empty set.
- [unit] After `add("project", "s1", ["n"])` on a missing file, the written file parses to exactly `{ "version": 1, "server": "om", "notes": { "s1": ["n"] } }`, with no `hidden` key.
- [unit] With `_mcpIdMapDeps.readText` throwing an error whose `code` is `EACCES`, `hide("project", "s1")` rejects with `MEMORY_MCP_ID_MAP_READ_FAILED` and `hiddenIds("project")` rejects with `MEMORY_MCP_ID_MAP_READ_FAILED`.
- [unit] With no `tools.forget` and the id map holding `s1: ["r1"]`, `provider.push` of a forget for `s1` resolves `{ id: "c-forget", status: "deleted" }`, calls neither `pool.call` nor `pool.listTools`, and leaves `hiddenIds("project")` holding `r1`.
- [unit] In that case the logger receives one warn with message `memory mcp forget kept the server copy` and data exactly `{ server: "om", slug: "s1", ids: 1 }`.
- [unit] With no `tools.forget` and no ids recorded for `s1`, a forget push for `s1` resolves `deleted` and the logger receives no warn.
- [unit] With `hiddenIds("project")` holding `r1` and `search_memory` answering items with ids `r1`, `r2` and `r3`, `provider.search({ scope: "project", text: "budget", limit: 2 })` resolves two hits whose slugs are `mcp-r2` and `mcp-r3`.
- [unit] With `hiddenIds("user")` holding `u1`, `hiddenIds("project")` empty, and `search_memory` answering items with ids `u1` and `r2`, `provider.search({ scope: "project", text: "budget", limit: 5 })` resolves one hit, whose slug is `mcp-r2`.
- [integration] With `createMemoryHost` over a fake pool whose server lists only `add_memories` and `search_memory`, `host.save` of note `s1` answered with remote id `r1`, then `host.forget({ scope: "project", slug: "s1", reason: "outdated" })`, then `search_memory` answering one item with id `r1` and text `s1: budget note`, `host.search({ text: "budget", limit: 5 })` resolves no hit whose slug is `mcp-r1`.
- [integration] In that same host, with `search_memory` answering items with ids `r1` and `r9`, `host.search({ text: "budget", limit: 5 })` resolves a hit whose slug is `mcp-r9`.
- [integration] With the same host and server, `host.save` of a user-scope note `u1` answered with remote id `ru1`, then `host.forget({ scope: "user", slug: "u1", reason: "outdated" })`, then `search_memory` answering one item with id `ru1`, `host.search({ text: "budget", limit: 5 })` resolves no hit whose slug is `mcp-ru1`.
- [integration] With that host's `_mcpIdMapDeps.readText` throwing an error whose `code` is `EACCES` after the save, and a local note matching `budget`, `host.search({ text: "budget", limit: 5 })` resolves the local hit, no hit whose slug starts with `mcp-`, and the host logger receives one warn with message `memory remote search failed`.

### US-004

- [unit] `kodaHitOf` of a note row whose `status` is `rejected` returns `null`.
- [unit] `kodaHitOf` of a note row whose `status` is `superseded` returns `null`.
- [unit] `kodaHitOf` of a note row whose `status` is `active` and whose `deletedAt` is `"2026-11-01T00:00:00.000Z"` returns `null`.
- [unit] `kodaHitOf` of a note row whose `status` is `active` and whose `deletedAt` is `null` returns a hit whose `status` is `active` and whose `slug` is the row's `subject`.
- [unit] A provider `search({ scope: "project", text: "replay budget", limit: 5 })` requests the memory endpoint with the query string exactly `kind=NOTE&scope=project&status=active&text=replay+budget&size=5`.
- [unit] With koda answering three note records in the order `a` (active), `b` (status `rejected`), `c` (active), `search({ scope: "project", text: "budget", limit: 2 })` resolves two hits whose slugs are `a` and `c`, in that order.
