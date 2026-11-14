# SPEC: koda-refusals-and-held-index — status names a refused koda proposal, and the on-disk index marks a koda-held forget

Closes: #2912, #2905

## Summary

Two gaps in the koda memory provider remain after `cancel-and-forget-fixes` (#2913). That feature records a forget koda answers with a `202`, resolves it on pull, and marks the note `(forget pending)` in `nax memory list` and in `host.renderIndex()`. It left two parts of #2905's expected behaviour open, filed as #2912. (1) `nax memory status` never reports a proposal koda refused, whether a save or a forget: `readStatus` reads only the outbox, and the pull drops a refused record without leaving anything behind. (2) The `MEMORY.md` index files nax-agent writes into the mirror do not mark a koda-held forget, because `refreshMemoryIndex` reads only the outbox's held keys and the mirror's own `pending-forgets.jsonl` record, and a koda forget record lives in `koda-approvals.json`, which nax-agent does not read. This feature adds a bounded refusal log the pull writes and the status reads, and an optional held-forget key source on the nax-agent store that the index refresh merges in. With both parts done, #2905's expected behaviour holds in full, so both #2912 and #2905 close.

## Motivation

- #2905 expects a rejected forget to be reported by `status` "as it does for a rejected save". Today neither is reported: a refused save's record is dropped once its slug is restored, and a refused forget's record is dropped once the mirror is shown to hold the note. The owner who refused a proposal in koda and the operator who made it on this checkout never see it in one place.
- The two index surfaces disagree. `nax memory list` and `host.renderIndex()` mark a koda-held forget; the mirror's `MEMORY.md`, which a session started outside the host (a tool, an editor, a later `nax run` reading the file) reads, does not. A note waiting on a koda retire looks fully active in the file.
- Writing a koda forget into `pending-forgets.jsonl` would fix the file but is wrong: `nax memory approve <slug>` reads that record and would retire the note locally without koda's decision.

## Design

### Approach

**Part 1, the refusal log (nax, `packages/nax/src/memory/koda-refusals.ts`).** A new file in the project mirror directory, beside `koda-approvals.json`:

```json
{ "version": 1, "refusals": [
  { "approvalId": "apr_1", "kind": "forget", "scope": "project", "slug": "proposed-rule",
    "status": "rejected", "refusedAt": "2026-11-14T05:00:00.000Z" } ] }
```

Every field is required. `kind` is `"save"` or `"forget"` (a refused record with no `kind` is logged as `"save"`). `status` is koda's own status word for the approval, one of `APPROVAL_REFUSED_STATUSES` (`rejected`, `expired`, `cancelled`, `failed`). `refusedAt` is the ISO time the pull logged it.

`createKodaRefusals({ dir, logger, now? })` returns `{ list(): Promise<readonly KodaRefusal[]>, record(entries: readonly Omit<KodaRefusal, "refusedAt">[]): Promise<void> }`:

- `record(entries)` composes in this order: (1) drop every incoming entry whose `approvalId` is already in the file (the existing entry and its `refusedAt` stay), and every incoming entry whose `approvalId` repeats an earlier one in the same call; (2) append the rest, stamped `refusedAt = now()`, after the existing entries; (3) drop every entry whose `refusedAt` is older than `KODA_REFUSAL_REPORT_MS` (7 days) before `now()`; (4) keep only the last `KODA_REFUSALS_MAX` (20) entries. The write is atomic (same-directory temporary file renamed into place, the `koda-approvals.ts` pattern, through a `_kodaRefusalsDeps` seam with `read`, `write`, `rename`). An empty incoming list writes nothing.
- `list()` returns the file's entries, oldest first, whose `refusedAt` is within `KODA_REFUSAL_REPORT_MS` of `now()`. It never writes.
- `now` defaults to `() => new Date()`.

The log is a report, not a record anything resolves from, so its failure handling is lenient (see Failure Handling): a missing file reads as no refusals; a file that is not a version-1 refusals file, or cannot be read, reads as no refusals with one warn per instance and is overwritten by the next `record`; a failed write warns and never throws.

**Part 1, the pull logs refusals (nax, `koda-pull.ts`).** `resolveRecord` already reads koda's status word for each record. A record it drops after a status in `APPROVAL_REFUSED_STATUSES` is a refusal; a record dropped for `executed` or a `404` is not. `RecordResolution`'s `drop` arm gains an optional `refusedStatus` carrying that word, and `resolveApprovals` returns the refused records alongside `dropped`. `resolutionOf` calls `input.refusals.record(...)` with those records **before** `input.approvals.drop(...)`: if the drop then fails, the next pull resolves the same records again and the `approvalId` dedupe keeps the log from growing. A refused record that is kept (a `restore`, or a `keep` after a failed lookup) is not logged yet; it is logged by the later pull that drops it, which reads the same refused status again. `CreateKodaMemoryProviderInput` gains an optional `refusals?: KodaRefusals`; with none, nothing is logged.

**Part 1, status (nax, host).** `MemoryStatus` gains an optional `kodaRefusals?: readonly MemoryKodaRefusal[]`, set only by a koda-backed host from `refusals.list()`. `MemoryKodaRefusal` is declared in `koda-refusals.ts` (US-002) as `Omit<KodaRefusal, "approvalId">` (`{ kind, scope, slug, status, refusedAt }`); the status maps each `KodaRefusal` to it by dropping `approvalId`. `formatMemoryStatus` prints one line per entry after the `rejected:` lines: `refused by koda: <kind> <scope>/<slug> (<status>, <refusedAt>)`. `nax memory status --json` carries the field as is. Status stays a read: it never writes the log. A refusal never blocks `nax memory link` or `nax memory reset`, and `nax memory requeue` / `discard` never act on it (they act on outbox entries only).

**Part 2, the held-forget source (nax-agent, store and index).** `createMemoryStore` gains an optional input `heldForgets?: () => Promise<ReadonlySet<string>>`, keys spelled `"<scope>/<slug>"` (the `memoryNoteKey` spelling). The store gains an optional member `readHeldForgetKeys?(): Promise<ReadonlySet<string>>`, set only when the input was given; it calls the source and, when the source throws, logs one warn through the store's logger and answers an empty set. `markedForgets` in `index-render.ts` merges `store.readHeldForgetKeys?.()` into the keys it already merges (the caller's held forgets and the `pending-forgets.jsonl` record). Every on-disk index write goes through `refreshMemoryIndex(store, …)` — the save and forget operations, `approve`, and `sync`'s `finish` — so the one merge covers them all. `readPendingForgets` is unchanged: the source never reaches `approve`'s `holdsRecordedForget` check.

**Part 2, the koda host passes the source (nax, host).** `composeMemory` creates the koda approvals store before the mirror store when the provider is `koda`, and passes `heldForgets` reading the approvals store's `kind: "forget"` records as `pendingForgetKey(...)` keys. `host-forget-keys.ts` exports that read as `kodaHeldForgetKeys(approvals)` and `readForgetPendingKeys` reuses it, so the two index surfaces read one function. A local- or MCP-backed host passes no source.

**File sizes.** `packages/nax-agent/src/memory/store.ts` is at 591 lines and `packages/nax/src/memory/host.ts` at 587, against a 600-line hard limit. US-001 moves `MemoryStorePaths`, `dirOrNull`, `memoryStorePaths` and the five file-name constants only `memoryStorePaths` uses (`INDEX_FILE`, `NOTES_DIR`, `DECISIONS_FILE`, `SYNC_STATE_FILE`, `PENDING_FORGETS_FILE`) from `store.ts` into a new leaf `store-paths.ts` (store.ts re-exports the type, so the package entry is unchanged). US-004 moves `readStatus`, `statusWriteMode`, `countState`, `rejectedEntries` and the `MemoryRejectedEntry` interface from `host.ts` into a new leaf `host-status.ts` (host.ts re-exports `MemoryRejectedEntry`). `host.ts` exports the file-local types `HostInput`, `HostReads` and `MemoryParts` so `host-status.ts` imports them type-only (type-only imports are not counted by `check:import-cycles`). Both moves are behaviour-neutral and verified by `bun run typecheck` and `bun run lint` (`check:file-sizes`, `check:import-cycles`) in the story's package.

### Integration (extends existing code)

The baseline signatures below exist only to locate the code. They are never the interface to implement; the target is.

Mutated symbols:

- `createMemoryStore` (`packages/nax-agent/src/memory/store.ts`)
  - Baseline: `createMemoryStore(input: { readonly projectDir: string; readonly userDir?: string | null; readonly logger: AgentLogger }): MemoryStore`
  - Target: the input also takes `readonly heldForgets?: () => Promise<ReadonlySet<string>>`.
- `MemoryStore` (`packages/nax-agent/src/memory/store.ts`)
  - Target: gains the optional member `readHeldForgetKeys?(): Promise<ReadonlySet<string>>`. Every existing member is unchanged.
- `markedForgets(store, heldForgets)` (`packages/nax-agent/src/memory/index-render.ts`, file-local)
  - Target: the result also holds every key `store.readHeldForgetKeys?.()` answers.
- `CreateKodaMemoryProviderInput` (`packages/nax/src/memory/koda-provider.ts`)
  - Target: gains `readonly refusals?: KodaRefusals`.
- `RecordResolution` (`packages/nax/src/memory/koda-pull.ts`, file-local)
  - Baseline: `{ kind: "drop" } | { kind: "keep" } | { kind: "restore"; note: MemoryNote }`
  - Target: the `drop` arm carries an optional `refusedStatus?: string`.
- `resolutionOf` (`packages/nax/src/memory/koda-pull.ts`, file-local)
  - Target: records the refused drops through `input.refusals?.record(...)`, then calls `input.approvals.drop(...)`.
- `MemoryStatus` (`packages/nax/src/memory/host.ts`)
  - Target: gains `readonly kodaRefusals?: readonly MemoryKodaRefusal[]`.
- `formatMemoryStatus(status, index?)` (`packages/nax/src/memory/format.ts`)
  - Target: prints one `refused by koda: …` line per `status.kodaRefusals` entry, after the `rejected:` lines.
- `composeMemory` / `composeKoda` (`packages/nax/src/memory/host.ts`, file-local)
  - Baseline: `composeKoda(input, dirs, store)` creates the approvals store itself, after `composeMemory` created the mirror store.
  - Target: `composeMemory` creates the approvals store (and the refusals store) first when the provider is `koda`, then the mirror store with `heldForgets`, then calls `composeKoda(input, dirs, store, approvals, refusals)`, which still passes `store.readNote` / `store.readDecisions` to the provider. In short: for `koda`, the approvals store is created first and passed as the mirror store's `heldForgets` source; a refusals store is created and passed to the provider as `refusals`; `MemoryParts` carries `kodaRefusals`. `_memoryHostDeps` gains `createKodaRefusals` (default the real factory), the seam a test stubs to see the store's arguments.

Read-only symbols:

- `memoryNoteKey(scope, slug)` — nax-agent's `"<scope>/<slug>"` key spelling, used by `markedForgets`.
- `refreshMemoryIndex(store, options)` (`index-render.ts`) — the one writer of both `MEMORY.md` files; called by `refreshIndex` (`operations-support.ts`), `approveLocked` / `retireRecorded` (`operations.ts`), `forget-handover.ts`, and `finish` (`sync.ts`).
- `createKodaApprovals`, `KodaApproval`, `KodaApprovals.list()` (`packages/nax/src/memory/koda-approvals.ts`) — the pattern the refusals module mirrors (atomic write, `_deps` seam, warn once per instance).
- `APPROVAL_REFUSED_STATUSES`, `APPROVAL_EXECUTED_STATUS`, `resolveRecord`, `refusedRecord`, `refusedForget`, `resolveApprovals` (`koda-pull.ts`).
- `readForgetPendingKeys`, `pendingForgetKey`, `ForgetKeyParts` (`packages/nax/src/memory/host-forget-keys.ts`).
- `_memoryHostDeps.createKodaClient`, `_memoryHostDeps.createKodaApprovals` (`host.ts`) — the seams `test/unit/memory/host-koda.test.ts` stubs to build a koda host over a temp dir.
- `formatMemoryStatus` is called by `nax memory status` (`packages/nax/src/cli/memory.ts`) and `/memory` in chat (`packages/nax/src/tui/chat/slash-commands.ts`).

### Failure Handling

| Case | Behaviour |
|:---|:---|
| Refusals file missing | `list()` answers `[]`, no warn; `record` writes a new file. |
| Refusals file not JSON, wrong version, or an entry missing a field | `list()` answers `[]` and warns `koda refusals file is unusable` once per instance; the next `record` writes a file holding only the incoming entries. |
| Refusals file read fails (permission, I/O) | Same as unusable: `[]`, one warn per instance; `record` writes over it. |
| Refusals write or rename fails | `record` warns `koda refusals were not recorded` with the path and the error, and resolves; the pull continues and still drops the approvals. |
| `refusals` absent on the provider input | Nothing is logged; the pull behaves as before. |
| Approvals drop fails after the refusals were recorded | The next pull resolves the same records; the `approvalId` dedupe keeps one log entry each. |
| Held-forget source throws | `readHeldForgetKeys()` warns once per call through the store's logger and answers an empty set; the index is still written. |
| Store created without `heldForgets` | `readHeldForgetKeys` is absent and `markedForgets` merges nothing more. |

## Out of Scope

- A command to clear the refusal log by hand: entries expire after 7 days and the log keeps at most 20.
- Making a refused koda proposal block `nax memory link` or `nax memory reset`, or be acted on by `nax memory requeue` / `nax memory discard`: those act on outbox entries only.
- Logging a refusal for a record that a pull keeps (a `restore`, or a `keep` after a failed lookup): it is logged by the later pull that drops it.
- Logging an approval koda answered `executed` or `404`: neither is a refusal.
- Writing a koda-held forget into the mirror's `pending-forgets.jsonl` record: `nax memory approve <slug>` would retire the note locally without koda's decision.
- Reporting refusals from an MCP-backed or local-backed host: only the koda provider resolves approvals.
- Sharing the refusal log between checkouts: it lives in one checkout's mirror directory, as `koda-approvals.json` does.
- Keeping the refusal log across `nax memory reset`: `clearProjectMirror` keeps only `koda-approvals.json`, so a reset removes `koda-refusals.json` with the rest of the mirror; a refusal is a settled fact the reset's fresh pull does not need.
- A temporary refusals file left behind by a failed write: the seam has no `unlink`, as in `koda-approvals.ts`.

## Stories

### US-001 — the store carries a held-forget source and the index marks it

Workdir: packages/nax-agent. No dependencies.

`createMemoryStore` takes an optional `heldForgets` source and exposes it as `readHeldForgetKeys`; `refreshMemoryIndex` marks every key it answers in both `MEMORY.md` files. `MemoryStorePaths`, `dirOrNull` and `memoryStorePaths` move to `store-paths.ts` to keep `store.ts` under its size limit (verified by `bun run typecheck` and `bun run lint`).

### US-002 — the bounded koda refusal log

Workdir: packages/nax. No dependencies.

A new `koda-refusals.ts` module holds the bounded refusal log (`createKodaRefusals`, `KodaRefusal`, `MemoryKodaRefusal`, `KODA_REFUSALS_MAX`, `KODA_REFUSAL_REPORT_MS`), with its dedupe, expiry, cap and lenient failure handling.

### US-003 — the koda pull logs the proposals koda refused

Workdir: packages/nax. Depends on US-002.

`CreateKodaMemoryProviderInput` gains `refusals`, and the koda pull records every approval record it drops after a refused status, before it drops them.

### US-004 — status names koda refusals and the koda host feeds the index

Workdir: packages/nax. Depends on US-001, US-002, US-003.

A koda-backed host passes its koda forget keys to the mirror store as `heldForgets` and its refusals store to the provider; `status()` reports the log as `kodaRefusals` and `formatMemoryStatus` prints it. The status read moves to `host-status.ts` to keep `host.ts` under its size limit (verified by `bun run typecheck` and `bun run lint`).

### Context Files

**US-001**
- `packages/nax-agent/src/memory/store.ts` — `createMemoryStore`, `MemoryStore`, `MemoryStorePaths`, `memoryStorePaths`.
- `packages/nax-agent/src/memory/index-render.ts` — `markedForgets`, `refreshMemoryIndex`, the ` (forget pending)` suffix.
- `packages/nax-agent/src/memory/operations-support.ts` — `refreshIndex`.
- `packages/nax-agent/test/unit/memory/store-pending-forgets.test.ts` — the store test pattern over a temp dir.
- `packages/nax-agent/test/unit/memory/index-render.test.ts` — the index refresh assertions.

**US-002**
- `packages/nax/src/memory/koda-approvals.ts` — the atomic-write, `_deps` seam and warn-once pattern.
- `packages/nax/test/unit/memory/koda-approvals.test.ts` — the file-store test pattern.

**US-003**
- `packages/nax/src/memory/koda-refusals.ts` — created by US-002, consumed here.
- `packages/nax/src/memory/koda-pull.ts` — `resolveRecord`, `resolveApprovals`, `resolutionOf`, `APPROVAL_REFUSED_STATUSES`.
- `packages/nax/src/memory/koda-provider.ts` — `CreateKodaMemoryProviderInput`.
- `packages/nax/test/unit/memory/koda-pull-forget-approvals.test.ts` — the pull harness with a faked client and approvals store.

**US-004**
- `packages/nax/src/memory/host.ts` — `composeMemory`, `composeKoda`, `readStatus`, `MemoryStatus`, `_memoryHostDeps`.
- `packages/nax/src/memory/host-forget-keys.ts` — `readForgetPendingKeys`, `pendingForgetKey`.
- `packages/nax/src/memory/format.ts` — `formatMemoryStatus`.
- `packages/nax/test/integration/memory/host-koda.test.ts` — the `stubKoda` router pattern over `_kodaClientDeps.fetch` and the `US-006 AC-22` refused-sync case. Its helpers are file-local: the new `host-koda-refusals.test.ts` defines its own minimal router over `_kodaClientDeps.fetch`, routing on `/memory/write-mode`, `/memory/export` and `approvals/`, and does not import from this file.
- `packages/nax/test/unit/memory/format.test.ts` — the status block assertions.

### Creates

**US-001**
- `packages/nax-agent/src/memory/store-paths.ts`
- `packages/nax-agent/test/unit/memory/store-held-forgets.test.ts`

**US-002**
- `packages/nax/src/memory/koda-refusals.ts`
- `packages/nax/test/unit/memory/koda-refusals.test.ts`

**US-003**
- `packages/nax/test/unit/memory/koda-pull-refusals.test.ts`

**US-004**
- `packages/nax/src/memory/host-status.ts`
- `packages/nax/test/unit/memory/host-koda-refusals.test.ts`
- `packages/nax/test/integration/memory/host-koda-refusals.test.ts`

### Modifies

**US-001**
- `packages/nax-agent/src/memory/index.ts` — the barrel re-exports `MemoryStorePaths`; it may re-point that re-export to the new paths leaf. Every name it exports stays exported.

**US-002**
- `packages/nax/src/memory/index.ts` — the barrel gains the refusals exports (`createKodaRefusals`, `KodaRefusal`, `KodaRefusals`, `MemoryKodaRefusal`, `KODA_REFUSALS_FILE`, `KODA_REFUSALS_MAX`, `KODA_REFUSAL_REPORT_MS`); every name it exports today stays exported.

**US-004**
- `packages/nax/src/memory/index.ts` — the barrel may re-point `MemoryRejectedEntry` to the new status leaf; every name it exports today stays exported.

### Seams

- US-001 → US-004: `createMemoryStore`'s `heldForgets` input is consumed by the koda host's `composeMemory`. US-004 AC 2 enters at `host.sync()` and asserts the on-disk `MEMORY.md`, not the store call.
- US-002 → US-003: `KodaRefusals.record` is consumed by the pull's `resolutionOf`; US-003 enters at `provider.pull` (`pullKodaPage`) with a faked client and asserts the captured `record` calls.
- US-002, US-003 → US-004: `createKodaRefusals` and `CreateKodaMemoryProviderInput.refusals` are consumed by `composeKoda`. US-004 AC 6 enters at `host.sync()` with a refused approval and asserts `host.status()`.

## Acceptance Criteria

### US-001

1. [unit] `createMemoryStore({ projectDir, logger, heldForgets: async () => new Set(["project/x"]) }).readHeldForgetKeys()` resolves a set containing `"project/x"`.
2. [unit] `createMemoryStore({ projectDir, logger })` (no `heldForgets`) returns a store whose `readHeldForgetKeys` is `undefined`.
3. [unit] A store whose `heldForgets` source rejects with an error answers `readHeldForgetKeys()` with an empty set and logs one warn at stage `memory` naming the error message.
4. [unit] `refreshMemoryIndex(store)` over a store holding project note `x` whose `heldForgets` source answers `{"project/x"}` writes a project `MEMORY.md` whose `x` entry ends in ` (forget pending)`.
5. [unit] `refreshMemoryIndex(store)` over a store with a user directory holding user note `u` whose `heldForgets` source answers `{"user/u"}` writes a user `MEMORY.md` whose `u` entry ends in ` (forget pending)`.
6. [unit] `refreshMemoryIndex(store, { heldForgets: new Set(["project/a"]) })` over a store holding notes `a`, `b` and `c`, with `pending-forgets.jsonl` holding `b` and a `heldForgets` source answering `{"project/c"}`, marks all three entries ` (forget pending)`.
7. [unit] `refreshMemoryIndex(store)` over a store whose `heldForgets` source rejects still writes `MEMORY.md`, with no entry marked for that source.
8. [unit] (regression guard) A store whose `heldForgets` source answers `{"project/x"}` answers `readPendingForgets()` with no entry for `x`.
9. [unit] (regression guard) `approveMemoryNote` on a store holding pending note `x`, with `pending-forgets.jsonl` empty and a `heldForgets` source answering `{"project/x"}`, puts `x` in force and does not delete it.

### US-002

1. [unit] `createKodaRefusals({ dir, logger, now })` `record([{ approvalId: "apr_1", kind: "forget", scope: "project", slug: "x", status: "rejected" }])` followed by `list()` returns one entry with those fields and `refusedAt` equal to `now().toISOString()`.
2. [unit] `list()` with no refusals file in `dir` resolves `[]` and logs no warn.
3. [unit] Recording an entry whose `approvalId` is already in the file leaves one entry for it, with the original `refusedAt`.
4. [unit] Recording entries `apr_2` then `apr_3` lists them in that order, after any earlier entry.
5. [unit] `list()` omits an entry whose `refusedAt` is more than `KODA_REFUSAL_REPORT_MS` (7 days) before `now()`, and returns an entry exactly `KODA_REFUSAL_REPORT_MS` old.
6. [unit] `record` drops from the file every entry older than `KODA_REFUSAL_REPORT_MS`, so a later read of the raw file holds no such entry.
7. [unit] After recording 25 distinct entries, `list()` returns 20 (`KODA_REFUSALS_MAX`): the last 20 recorded.
8. [unit] With a file holding 1 entry older than `KODA_REFUSAL_REPORT_MS`, recording 21 new entries leaves `list()` and the raw file with the last 20 of the 21 new entries and not the expired one.
9. [unit] `record([])` makes no `_kodaRefusalsDeps.write` call.
10. [unit] `list()` on a file that is not JSON resolves `[]` and logs the warn `koda refusals file is unusable` once across two `list()` calls of one instance.
11. [unit] `record` over a file that is not JSON writes a version-1 file holding only the incoming entries.
12. [unit] `list()` whose `_kodaRefusalsDeps.read` rejects with an `EACCES` error resolves `[]` and logs the warn `koda refusals file is unusable`.
13. [unit] `list()` on a JSON file of `version: 2`, and on a version-1 file whose entry has no `refusedAt`, resolves `[]` and logs the warn `koda refusals file is unusable`.
14. [unit] `record([a, a])` with two incoming entries of one `approvalId` stores one entry for it.
15. [unit] `record` whose `_kodaRefusalsDeps.rename` rejects resolves, logs the warn `koda refusals were not recorded` naming the path, and leaves the original file unchanged.
16. [unit] `record` writes through a temporary file in `dir` and renames it to `koda-refusals.json` (`_kodaRefusalsDeps.write` gets a path other than the final one, `rename` moves it there).

### US-003

1. [unit] A pull at the scope's last page, with a save record `apr_1` for `x` whose `GET approvals/apr_1` answers `rejected` and whose slug the page already carries, calls `refusals.record` once with `[{ approvalId: "apr_1", kind: "save", scope, slug: "x", status: "rejected" }]`.
2. [unit] A pull with a forget record `apr_2` for `x` answered `expired`, while the mirror holds `x`, calls `refusals.record` with an entry `{ approvalId: "apr_2", kind: "forget", status: "expired" }`.
3. [unit] A pull with a record answered `executed`, and one whose approval read answers `404`, calls `refusals.record` with no entry for either.
4. [unit] A pull with a forget record answered `rejected` whose resolution is `restore` (the page does not carry `x`, the mirror lacks `x`, and `findActiveKodaNote` finds an active row for `x`, so the page carries that row's note and the record is kept) calls `refusals.record` with no entry for it.
5. [unit] A pull with a forget record `apr_5` answered `rejected` whose page already carries a note for `x` drops the record and calls `refusals.record` with an entry for `apr_5`.
6. [unit] A pull with a refused record that is dropped calls `refusals.record` before `approvals.drop`.
7. [unit] A pull whose `refusals.record` resolves after warning still calls `approvals.drop` with the refused record's `approvalId`.
8. [unit] A pull through a provider created without `refusals` drops a refused record as before and does not throw.
9. [unit] A first pull whose `approvals.drop` rejects (that pull rejects) after `refusals.record` recorded refused record `apr_1`, followed by a second pull resolving `apr_1` refused again over a real `createKodaRefusals` store, leaves `list()` with exactly one entry for `apr_1`.
10. [unit] A pull whose page is not the scope's last one (`hasMore: true`) calls `refusals.record` zero times.

### US-004

1. [unit] A koda-backed `createMemoryHost`, with `_memoryHostDeps.createMemoryStore` stubbed as a pass-through to the real factory that captures its input, passes it a `heldForgets` source that answers `{"project/x"}` when the approvals store holds a `kind: "forget"` record for `project/x`, and does not answer `project/y` for a save record for `project/y`.
2. [integration] A koda-backed host over a temp mirror holding project note `x`, whose `koda-approvals.json` holds a forget record for `project/x` and whose koda transport (a router over `_kodaClientDeps.fetch` defined in the test file) answers `GET projects/<slug>/memory/write-mode` with `{ mode: "direct" }`, the export with `{ items: [], hasMore: false }` and `GET approvals/<id>` with `pending`, after `host.sync()` leaves a project `MEMORY.md` on disk whose `x` entry ends in ` (forget pending)`.
3. [integration] The same host and transport (write-mode answering `{ mode: "direct" }`) after a `host.sync()` whose approval read answers `executed` leaves a `MEMORY.md` in which no entry for `x` ends in ` (forget pending)`.
4. [unit] A local-backed `createMemoryHost` passes `_memoryHostDeps.createMemoryStore` no `heldForgets` source.
5. [unit] A koda-backed `createMemoryHost` calls `_memoryHostDeps.createKodaRefusals` once with `dir` equal to the host's `dirs.projectDir`, and passes the store it returns to `_memoryHostDeps.createKodaMemoryProvider` as `refusals`.
6. [integration] A koda-backed host whose approvals file holds a forget record `apr_1` for `project/x`, with `x` in the mirror and a koda transport (a router over `_kodaClientDeps.fetch`) answering write-mode `{ mode: "direct" }`, the export `{ items: [], hasMore: false }` and `GET approvals/apr_1` `rejected`, reports after `host.sync()` a `status().kodaRefusals` of one entry `{ kind: "forget", scope: "project", slug: "x", status: "rejected" }` with an ISO `refusedAt`.
7. [unit] `status()` of a koda-backed host whose refusals file is empty answers `kodaRefusals: []`.
8. [unit] `status()` of a local-backed host answers no `kodaRefusals` field.
9. [unit] Two `status()` calls on a koda-backed host with one logged refusal both report that refusal.
10. [unit] `formatMemoryStatus` of a status whose `kodaRefusals` holds `{ kind: "forget", scope: "project", slug: "x", status: "rejected", refusedAt: "2026-11-14T05:00:00.000Z" }` prints the line `refused by koda: forget project/x (rejected, 2026-11-14T05:00:00.000Z)` after every `rejected:` line and before the `notes:` line.
11. [unit] `formatMemoryStatus` of a status with no `kodaRefusals` field, or an empty one, prints no `refused by koda:` line.
12. [cli] (regression guard) `nax memory status --json` through a host whose `status()` answers one `kodaRefusals` entry prints a JSON document whose `kodaRefusals` array holds that entry.
13. [unit] A koda-backed host's `forgetPendingKeys()` and its store's `readHeldForgetKeys()` answer the same koda forget keys for one approvals file holding forget records for `project/x` and `user/u`.
