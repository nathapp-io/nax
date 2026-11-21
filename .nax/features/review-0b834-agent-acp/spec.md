# SPEC: review 0b834ecc fixes: stale user-note forget, ACP registry races, cancelled-turn tokens

## Summary

Three fixes from the verified code review of `0b834ecc1` (findings 1, 4, 5 and 6), each reproduced by a proof script:

1. **Stale forget approval (finding 1, High).** A proposal forget records the `id` of the note it targets. Every save gives a note a fresh `id`, while approval and pull keep it. If the note's `id` has changed since then, approval drops the forget and handles the note as it now stands. The index no longer marks a stale forget. A user note refiled from another project then survives an old forget approval.
2. **ACP registry races (findings 4 and 5).** A model or mode switch builds its persisted metadata from the registry entry as it stands after the switch, not from the snapshot taken before the credential lookup. Two overlapping `session/resume` or `session/load` requests for one closed session reopen it once; the second request joins the first.
3. **Cancelled-turn tokens (finding 6).** When a denied-permission continuation misses the cancellation grace, the thrown reason still carries the tokens of the prompts the turn already answered.

## Motivation

The review (`review-0b834ecc/REVIEW.md`) reproduced each defect through its production entry point, with a passing control:

- **Finding 1.** Project A proposed forgetting a user note. Project B then refiled it with the body "Use French". Running `nax memory approve` in A deleted B's replacement. With both steps in one project, the replacement stayed active, because a save clears the forget in its own project's `pending-forgets.jsonl`. User notes are shared across projects, but the forget record is kept per project, so B's save never reached A's record. `docs/guides/memory.md` says "Saving the slug again clears a pending forget."
- **Finding 4.** A prompt completed while a model switch was waiting on `ensureCredentials`. The switch then wrote the entry's earlier metadata, which erased the title, `updatedAt` and the $0.25 `costUsd` that `recordTurn` had just persisted. `switchTo` checks `entry.server.running` before the await, and the turn had already finished by the time it resumed.
- **Finding 5.** Two overlapping resume requests for the same closed session both passed the `entries.get` check before either opened. Both opened a facade, and the second `entries.set` overwrote the first. After shutdown, one facade had never been closed and its lock-release callback had never run.
- **Finding 6.** The first prompt reported 10 input and 5 output tokens. When the continuation answered within the grace period, the cancelled turn reported 12 and 6. When it missed the grace, the same turn reported 0 and 0, because the abort path attaches `NO_RESPONSE_SPEND` without the carried usage.

## Design

### Integration

Symbols this feature only reads:

- `packages/nax-agent/src/memory/types.ts`: `MemoryNote { id; slug; scope; updatedAt; status; ... }` and `memoryNoteKey(scope, slug)`.
- `packages/nax-agent/src/memory/store.ts`: `MemoryStore.readNote(scope, slug): Promise<MemoryNote | null>`, `readPendingForgets()` and `writePendingForgets(entries)`.
- `packages/nax-agent/src/memory/operations.ts`: `approveMemoryNote(input)`, which runs `approveLocked` under `orderedByMirrorLocks` + `withMirrorLock`.
- `packages/nax/src/cli/memory-write.ts`: the approve message. A deleted note prints `forgot <scope>/<slug> (forget approved)`, an active one `<scope>/<slug> is already active; nothing to approve`, and otherwise `approved <scope>/<slug>`. Unchanged.
- `packages/nax-agent-acp/src/server/registry.ts`: `recordTurn(sessionId, prompt, costUsd)`, which writes `{ ...entry.meta, costUsd, title, updatedAt }` into `entries` and storage. It also reads `openEntry(meta, port, mcpServers)`, which ends with `entries.set(meta.sessionId, ...)`.
- `packages/nax-agent-acp/src/client/usage.ts`: `sumUsage(first, second)` and `tokenUsageOf(usage)`.

Symbols this feature changes. Each **Baseline** exists only to locate the code. Implement the **Target**, never the baseline.

- `MemoryPendingForget` (`packages/nax-agent/src/memory/types.ts`) and `PendingForgetSchema` (`records.ts`).
  - Baseline: `{ clientId; scope; slug; reason }`.
  - Target: the type and schema gain an optional `noteId?: string`. It holds the `id` of the note the mirror held when the forget was recorded. A line without the field still parses, and the field is omitted when the mirror held no note.
  - Why `id` and not `updatedAt`: `stagedNote` (`operations.ts`) gives every save, direct or proposal, a fresh `randomUUID()` id. `inForce` (approval of a pending save) restamps `updatedAt` but keeps `id`. So approving the same pending note from another project restamps it without making the forget stale, while a refile always does.
- `forget` in `createLocalMemoryProvider` (`packages/nax-agent/src/memory/local-provider.ts`).
  - Baseline: a proposal forget appends `queuedForget(request)` to the record.
  - Target: a proposal forget reads `store.readNote(request.scope, request.slug)` before rewriting the record. The queued entry carries `noteId: note.id` when that note is non-null. When `readNote` throws (for example `MEMORY_SCOPE_UNAVAILABLE` for a user forget on a store with no user directory), the entry is recorded without `noteId`, exactly as today. A direct forget is unchanged.
  - `sameEntries` also compares `noteId`, so a re-forget that names a new revision rewrites the record.
- New export `isStaleForget(entry: MemoryPendingForget, note: MemoryNote | null): boolean` in a new file `packages/nax-agent/src/memory/forget-revision.ts`. It returns `true` exactly when `entry.noteId` is a string, `note` is non-null, and `note.id !== entry.noteId`. In every other case it returns `false`: a legacy entry with no field, or a null note.
- `approveLocked` / `holdsRecordedForget` / `retireRecorded` (`packages/nax-agent/src/memory/operations.ts`).
  - Baseline: any recorded entry for the key makes approval delete the note.
  - Target: approval finds the recorded entry for the key. If `isStaleForget(entry, note)` is true, it removes that entry from the record (re-read after removal, the same way `retireRecorded` does, so another writer's entry survives) and calls `refreshIndex`. Approval then continues as if no forget were recorded: an active note comes back unchanged, and a pending note is put in force. A non-stale entry still retires the note as today. `operations.ts` is at 425 lines, so the new helper lives in `forget-revision.ts`.
- `markedForgets` (`packages/nax-agent/src/memory/index-render.ts`).
  - Baseline: every recorded entry's key is marked `(forget pending)`.
  - Target: a recorded entry is marked only when `isStaleForget(entry, await store.readNote(entry.scope, entry.slug))` is false. When that `readNote` throws (no user directory, or a path outside the scope root), the entry counts as not stale and is marked, as today. The record is not rewritten here. Held and source keys are unchanged.
- `switchTo` (`packages/nax-agent-acp/src/server/registry.ts`).
  - Baseline: after `entry.server.switchTo(...)` succeeds, it writes `{ ...entry.meta, mode, model, bashApproval }`, where `entry` is the value captured before `ensureCredentials`.
  - Target: after the switch succeeds, it reads `const current = entries.get(sessionId) ?? entry`. It then writes `meta = { ...current.meta, mode: next.mode, model: next.model, bashApproval: next.bashApproval }` into `entries.set(sessionId, { ...current, meta })` and `deps.storage.writeMeta(meta)`. A `title`, `updatedAt` or `costUsd` that `recordTurn` wrote during the `ensureCredentials` await is kept. The `?? entry` fallback is defensive only: a close requested during the switch makes `ServerSession.switchTo` throw `sessionClosed()` before this write (`server-session.ts`), so the write is never reached for a closed entry.
- `createReopen().reopen` (`packages/nax-agent-acp/src/server/registry-open.ts`).
  - Baseline: no coordination between concurrent reopens of one session id.
  - Target: the reopener keeps a private `Map<string, Promise<void>>` of in-flight opens, keyed by session id. A reopen that finds no open entry and an in-flight open for its id awaits that promise, ignoring its rejection. It then re-runs `reopen(sessionId, input, replay)` from the top, which takes the already-open branch (a `load` waiter replays the stored transcript to the open entry's port, as an already-open `load` does today), or opens afresh if the first open failed. The first open sets the map entry before its first await (`storage.readMeta`) and deletes it in a `finally`. A waiter that re-runs after `closeAll` started is refused `SHUTTING_DOWN` by `openEntry`, as any open after shutdown is. `registry-open.ts` is 101 lines.
- `promptOnce` abort branch (`packages/nax-agent-acp/src/client/turn.ts`).
  - Baseline: `response === undefined` attaches `NO_RESPONSE_SPEND`.
  - Target: when `response` is undefined and `carried` is defined, it attaches `{ ...NO_RESPONSE_SPEND, tokenUsage: tokenUsageOf(carried) }`, the same shape the `failed` branch uses. When both are undefined, it attaches `NO_RESPONSE_SPEND`. Cost stays `0` / `unpriced` because the cumulative cost meter carries the reading to the next turn.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| A recorded forget from before this feature (no `noteId`) | Treated as current. Approval retires the note as before. |
| The note is gone or retired when approval runs | `MEMORY_NOTE_NOT_FOUND`, as today. The revision check is never reached. |
| Removing a stale entry from the record throws | The error propagates. The note is not deleted, and the stale entry stays, so the next approval finds it stale again. |
| The first of two overlapping reopens fails | The waiting reopen ignores that rejection and opens the session itself. Only the first caller sees the error. |
| `readNote` throws while a proposal forget records its entry, or while the index marks entries | The entry is recorded without `noteId`, or marked as pending, as today. |

## Out of Scope

- Finding 18 of review 0b834ecc (loader cache with explicit overrides) was withdrawn as a CLI defect and is not fixed by this feature.
- Findings 2, 3 and 7-22 of review 0b834ecc belong to the other three review-0b834 features (provider-credentials, workflow-verification, release-config-ci).
- Moving the pending-forget record of user-scope notes into the user directory is not done; the forget stays bound to the project that recorded it, and the revision check is the fix.
- A recorded forget written before this feature carries no revision and keeps the old behaviour; existing `pending-forgets.jsonl` files are not migrated.
- Remote memory providers are unchanged; only the local provider writes `pending-forgets.jsonl`, and a pull that rewrites a note's `id` from a remote provider is not reconciled with a recorded forget.
- US-003 only: a turn that starts after the switch's busy check and is still running when the switch resumes is not newly refused; the existing `ServerSession.switchTo` busy guard covers it.
- US-003 only: the in-flight reopen map is per registry instance; reopens of one session across separate server processes are coordinated by the file-backed session lock, as today.
- US-004 only: the dollar cost of a turn that misses the cancellation grace is not attached to that turn; the cumulative ACP cost meter reports it on the next turn, as today.

## Stories

**US-001: a proposal forget records the note id it targets (finding 1, part 1).** Workdir: `packages/nax-agent`. No dependencies. Adds the optional `noteId` to `MemoryPendingForget` and `PendingForgetSchema`. The local provider's proposal `forget` records the held note's `id` (and records no `noteId` when `readNote` returns null or throws), and `sameEntries` compares `noteId`. Adds `isStaleForget` in the new `forget-revision.ts`.

**US-002: approval and the index ignore a stale forget (finding 1, part 2).** Workdir: `packages/nax-agent`. Depends on US-001. `approveLocked` drops a stale recorded entry and approves the note as it stands. `markedForgets` does not mark a stale entry, and treats a `readNote` error as not stale.

**US-003: ACP registry switch and reopen races (findings 4 and 5).** Workdir: `packages/nax-agent-acp`. No dependencies. `switchTo` re-reads the registry entry after the reopen succeeds and persists the switched settings over that entry's metadata. `createReopen` single-flights concurrent opens of one session id.

**US-004: a cancelled turn that misses the grace keeps its answered tokens (finding 6).** Workdir: `packages/nax-agent-acp`. No dependencies. The abort branch of `promptOnce` attaches the carried token usage when the grace expires with no response.

### Context Files

**US-001**
- `packages/nax-agent/src/memory/local-provider.ts` — `createLocalMemoryProvider`, `queuedForget`, `rewriteRecord`, `sameEntries`
- `packages/nax-agent/src/memory/records.ts` — `PendingForgetSchema`, `parsePendingForgetLine`
- `packages/nax-agent/src/memory/types.ts` — `MemoryPendingForget`, `MemoryNote`
- `packages/nax-agent/test/unit/memory/local-provider-pending-forgets.test.ts` — provider fixtures for proposal forgets

**US-002**
- `packages/nax-agent/src/memory/operations.ts` — `approveLocked`, `holdsRecordedForget`, `retireRecorded`, `saveMemoryNote`, `stagedNote`, `inForce`
- `packages/nax-agent/src/memory/forget-handover.ts` — `forgetMemoryNote`
- `packages/nax-agent/src/memory/index-render.ts` — `markedForgets`, `refreshMemoryIndex`
- `packages/nax-agent/src/memory/forget-revision.ts` — `isStaleForget`, created by US-001, consumed here
- `packages/nax-agent/test/unit/memory/operations-approve-forget.test.ts` — the single-store `endToEnd(dir)` harness the two-store fixture extends

**US-003**
- `packages/nax-agent-acp/src/server/registry.ts` — `switchTo`, `recordTurn`, `openEntry`
- `packages/nax-agent-acp/src/server/registry-open.ts` — `createReopen`, `openAndReplay`
- `packages/nax-agent-acp/test/helpers/registry-setup.ts` — file-backed registry over fake sessions (`fakes`, `releases()`, `extra.ensureCredentials`, `extra.transcripts`)
- `packages/nax-agent-acp/test/helpers/fake-agent-session.ts` — `closed()`
- `packages/nax-agent-acp/test/unit/server/registry-hardening.test.ts` — the `priced(costUsd)` script and resume fixtures

**US-004**
- `packages/nax-agent-acp/src/client/turn.ts` — `runPromptTurn`, `promptOnce`, `cancelTurn`, `NO_RESPONSE_SPEND`
- `packages/nax-agent-acp/src/client/usage.ts` — `sumUsage`, `tokenUsageOf`
- `packages/nax-agent-acp/test/unit/client/backend.test.ts` — the existing `cancelGraceMs` kill-after-grace test

### Creates

**US-001**
- `packages/nax-agent/src/memory/forget-revision.ts` — `isStaleForget`
- `packages/nax-agent/test/unit/memory/forget-revision.test.ts` — `isStaleForget`, record-parsing and provider-recording tests

**US-002**
- `packages/nax-agent/test/unit/memory/operations-approve-stale-forget.test.ts` — the two-store fixture (one shared `userDir`, project dirs A and B) and the approval and index tests

**US-003**
- `packages/nax-agent-acp/test/unit/server/registry-races.test.ts` — overlapping switch and resume tests

### Modifies

**US-001**
- `packages/nax-agent/test/unit/memory/local-provider-pending-forgets.test.ts` — the assertion that saves a note and then proposal-forgets it pins the recorded entry to exactly `{ clientId, scope, slug, reason }`; the entry now also carries `noteId`. The invariant becomes: those four fields as before, plus `noteId` equal to the held note's `id`. Assertions on forgets of a slug the store holds no note for keep the four-field shape unchanged.
- `packages/nax-agent/test/unit/memory/store-pending-forgets.test.ts` — a round-trip assertion that pins the exact parsed entry shape may need the optional `noteId`. The invariant becomes: a line with or without `noteId` round-trips unchanged.

**US-002**

None. Existing approval and index tests use legacy entries without `noteId`, or `objectContaining`, so their assertions hold.

**US-003**

None. The change keeps the meta and entry shapes; existing switch and resume tests assert sequential behaviour, which is unchanged.

**US-004**
- `packages/nax-agent-acp/test/unit/client/backend-codex.test.ts` — the new missed-grace tests are added here, reusing its denied-then-cancelled peer fixture and `driveTurn` instead of copying them, per the project rule against copy-pasted mock setup. Its local `OpenOptions` and `open()` gain an optional `cancelGraceMs` passed through to the backend options. No existing assertion changes.

### Seams

- US-001 exports `isStaleForget` from `forget-revision.ts`; US-002 calls it from `approveLocked` and `markedForgets`. US-002's ACs drive it through `approveMemoryNote` and `refreshMemoryIndex`, the production entry points, so a stale entry that is not routed through the check fails them.

## Acceptance Criteria

ACs marked **(control)** already pass on the baseline code and pin behaviour that must not regress; every other AC fails on the baseline.

### US-001

1. [unit] `isStaleForget` returns `true` for an entry with `noteId: "note-a"` and a note whose `id` is `"note-b"`.
2. [unit] `isStaleForget` returns `false` when the entry's `noteId` equals the note's `id`, even when the note's `updatedAt` has changed.
3. [unit] `isStaleForget` returns `false` for an entry with no `noteId` field, whatever the note's `id`.
4. [unit] `isStaleForget` returns `false` when the note is `null`.
5. [unit] `parsePendingForgetLine` parses a line carrying `noteId` into an entry whose `noteId` equals the line's value.
6. [unit] (control) `parsePendingForgetLine` parses a line without `noteId` into an entry with no `noteId` field.
7. [unit] A proposal `forget` pushed to `createLocalMemoryProvider` for a user note the store holds with `id` `note-a` records an entry in `readPendingForgets()` whose `noteId` is `note-a`.
8. [unit] (control) A proposal `forget` for a slug the store holds no note for records an entry with no `noteId` field.
9. [unit] (control) A proposal `forget` of a user-scope slug, on a store created with `userDir: null`, is recorded in `readPendingForgets()` without `noteId` instead of rejecting.
10. [unit] A second proposal `forget` of the same key, after the note was refiled with a new `id`, rewrites the record so its single entry for the key carries the new `id`.

### US-002

Setup for ACs 1-8: two stores are created with `createMemoryStore` over one shared `userDir` and separate project directories A and B. Each store gets its own `{ store, outbox: createMemoryOutbox({ dir: store.paths.outboxDir }), provider: createLocalMemoryProvider(store), logger }` for `saveMemoryNote`, `forgetMemoryNote` and `approveMemoryNote`, with proposal mode unless an AC says otherwise. Store A first saves user note `lang` (body `Use English`) in direct mode, then records a proposal forget of it through `forgetMemoryNote`. "B's refile" means store B then saves `lang` again through `saveMemoryNote` in proposal mode with body `Use French`.

1. [integration] After B's refile, `approveMemoryNote` on store A for `user`/`lang` returns a note whose `status` is `active` and whose body is `Use French`.
2. [integration] After that approval, `readNote("user", "lang")` on store B returns a note with status `active`.
3. [integration] (control) After that approval, store A's `readPendingForgets()` holds no entry for `user`/`lang`.
4. [integration] When B's refile is made in direct mode instead, approval on store A returns a note with status `active` whose `updatedAt` equals B's save.
5. [integration] (control) When store A's initial save of `lang` is in proposal mode and store B approves that pending note (no refile), a later `approveMemoryNote` on store A returns status `deleted`.
6. [integration] (control) When nothing changed `lang` after A recorded the forget, `approveMemoryNote` on store A returns status `deleted`.
7. [integration] (control) A record line for `user`/`lang` with no `noteId`, written directly with `writePendingForgets` before B's refile, still makes `approveMemoryNote` on store A return status `deleted`.
8. [integration] With store A wrapped in a store whose `writePendingForgets` throws, approval after B's refile rejects with that error, and `readNote("user", "lang")` afterwards returns the `Use French` note.
9. [integration] After B's refile, `refreshMemoryIndex` on store A renders the user index line for `lang` without the `(forget pending)` marker.
10. [integration] When nothing changed `lang` after A recorded the forget, `refreshMemoryIndex` on store A renders the `lang` line with the `(forget pending)` marker.
11. [integration] (control) After B's refile, `refreshMemoryIndex` on store A leaves store A's `readPendingForgets()` unchanged.
12. [integration] (control) `refreshMemoryIndex` on a store created with `userDir: null`, whose record holds a user-scope entry, resolves and writes the project index.

### US-003

1. [integration] A registry is built with `registry-setup.ts`, with an `ensureCredentials` that resolves at once for its first call (the `create` open) and is held pending on its second call (the switch's lookup). A new session with no prior turn (persisted `title` null, `updatedAt` null) starts `setConfigOption` to switch the model. A prompt run with the `priced(0.25)` script completes while the lookup is pending, and only then is the lookup released. After the switch resolves, `storage.readMeta(sessionId)` returns `costUsd` 0.25.
2. [integration] In that case the persisted meta's `title` is the prompt's title, not null.
3. [integration] In that case the persisted meta's `updatedAt` is not null.
4. [integration] In that case the persisted meta's `model` is the newly selected model.
5. [integration] (control) With the priced turn finished before `setConfigOption` starts, the persisted meta has the new model, `costUsd` 0.25 and the prompt's title.
6. [integration] A session is created on a first registry and that registry is shut down with `closeAll`. A second registry is then built with `registry-setup.ts` over the same sessions directory with `openSession` held pending, and two `resume(sessionId, input)` calls are started on it before either resolves. The second registry's `openSession` is called exactly once.
7. [integration] In that case both `resume` calls resolve with the stored session's mode and model.
8. [integration] In that case, after `closeAll` on the second registry, `closed()` is true on every fake session the second registry's `openSession` returned.
9. [integration] In that case, after `closeAll` on the second registry, its `releases()` equals the number of fake sessions its `openSession` returned.
10. [integration] When the first of two overlapping `resume` calls on the second registry fails because `openSession` rejects once, the second `resume` resolves with the stored session's state, and `openSession` has been called twice in total.
11. [integration] With a stored transcript seeded through the `transcripts` extra, two overlapping `load(sessionId, input)` calls on the second registry call `openSession` exactly once.
12. [integration] In that case the shared fake port receives the transcript's replay twice, once per `load` call.
13. [integration] (control) A `resume` started on the second registry after an overlapping pair has settled finds the open entry and does not call `openSession` again.

### US-004

1. [integration] Through the ACP backend with the scripted peer of `backend-codex.test.ts`, a read-only profile and `cancelGraceMs` 50: the first prompt is denied a permission, answers `cancelled` with usage of 10 input and 5 output tokens, and the turn sends `DENIED_CONTINUATION_PROMPT`. The peer hangs on the continuation, and `AgentSession.cancel()` is called once the peer has received it. The terminal `turn_end` event reports `inputTokens` 10 and `outputTokens` 5.
2. [integration] In that case the agent process receives exactly one kill request.
3. [integration] In that case the turn's status is `cancelled`.
4. [integration] When the continuation answers inside the grace with 2 input and 1 output tokens, the terminal `turn_end` event reports 12 input and 6 output tokens.
5. [integration] (control) When a first prompt with no carried usage hangs and the grace expires after `AgentSession.cancel()`, the terminal `turn_end` event reports 0 input and 0 output tokens.
6. [integration] In the missed-grace continuation case of AC1, the terminal `turn_end` event reports `costUsd` 0 and `costSource` `unpriced`.
