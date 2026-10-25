# SPEC: shared-session-storage — ACP session storage moves into `@nathapp/nax-agent`, with a lock-holder read

## Summary

The ACP server's session storage (`<id>.session.json` metadata, the `<id>.lock`
ownership protocol, and the listing scan) moves from
`packages/nax-agent-acp/src/server/` into a new `packages/nax-agent/src/session-store/`
module exported from the `@nathapp/nax-agent` package entry. The moved code no longer
depends on the ACP SDK: it throws `NaxError` codes (`SESSION_LOCKED`,
`SESSION_LIST_CURSOR_INVALID`, `SESSION_META_UNREADABLE`) and returns neutral list
types, and the ACP server maps those codes to the same JSON-RPC errors it sends
today. Storage also gains a read-only `readLockHolder(sessionId)` so a host can show
who holds a session without trying to take it. The ACP server then consumes the
shared module and its own copies are deleted. Formats on disk do not change, so a
session written by the ACP server today is read the same way afterwards.

This is feature F2 of the nax interactive coding agent, slice 1
(`docs/superpowers/specs/2026-10-24-nax-interactive-tui-slice1-design.md`, §4.2,
§5 row A5 and §5.1). It changes `packages/nax-agent` and `packages/nax-agent-acp`.

## Motivation

- **The terminal UI and koda must share one session store.** The user's ruling
  (2026-10-24): the terminal front door and koda share nothing except the session
  store on the same machine. koda lists and resumes sessions through the ACP server,
  which reads `<id>.session.json` plus `<id>.lock` in its sessions directory. A
  plain `TranscriptStore` is not visible to koda, so the TUI (F3) must write the
  same metadata and take the same lock.
- **`packages/nax` cannot import the storage where it lives.** `storage.ts`,
  `session-lock.ts` and `session-lock-guard.ts` sit under
  `packages/nax-agent-acp/src/server/`, and `check:package-boundaries` lets `nax`
  import nax-agent-acp only through `@nathapp/nax-agent-acp/client`. The design
  (§6) rules out widening the allowed import list; moving the code into
  `@nathapp/nax-agent`, which both packages already import, is the fix.
- **The moved code must not pull the ACP SDK into nax-agent.** Today the lock
  refusal is an ACP `RequestError.invalidRequest`, `SessionLockGuardBusy` extends
  `RequestError`, an invalid cursor is `RequestError.invalidParams`, and `list`
  returns ACP's `ListSessionsResponse`. nax-agent's declared dependencies do not
  include `@agentclientprotocol/sdk`.
- **A host cannot see who holds a lock.** `SessionStorage` exposes only
  `acquireLock`, which either takes the lock or refuses. The TUI design (§4.2) lists
  a session locked by another process as not resumable, with the holder shown.

## Design

### Approach

1. **Move (US-001 lock layer, US-002 metadata, listing and exports).** Create `packages/nax-agent/src/session-store/` with
   `session-meta.ts` (the metadata schema, `SESSION_META_MODES`,
   `SESSION_ID_PATTERN`, `defaultSessionsDir`), `session-lock-guard.ts`,
   `session-lock.ts` and `storage.ts`, carrying today's logic unchanged except for
   the error and type contract below, plus `index.ts` re-exporting the public
   names. `packages/nax-agent/src/index.ts` re-exports them. The metadata schema
   uses `BashApprovalModeSchema` (`src/config/bash-approval.ts`, same three values)
   for `bashApproval`. Error text uses `errorMessage` (`src/infra/errors.ts`) where
   the ACP code used `messageOf`.
2. **Error contract.** Every refusal of `acquireLock` (a fresh lock held by another
   live pid, a takeover that loses a race, and guard contention) is a `NaxError`
   with code `SESSION_LOCKED`, the same message text as today
   (`session in use by pid <pid>` or `session in use by another process`), and
   context `{ stage: "session-store" }` plus `pid` when known.
   `SessionLockGuardBusy` becomes a `NaxError` subclass with code `SESSION_LOCKED`
   and message `session in use by another process`, still distinguishable with
   `instanceof` by the release retry loop. An invalid list cursor is a `NaxError`
   with code `SESSION_LIST_CURSOR_INVALID`, message `invalid cursor`.
   `SESSION_META_UNREADABLE` keeps its code and message; its context `stage`
   becomes `"session-store"`.
3. **Lock-holder read (US-003).** `SessionStorage.readLockHolder(sessionId)` reads
   `<id>.lock` without the guard and without writing, and classifies the holder with
   the same freshness rule `takeover` uses to refuse: a holder is `"live"` when its
   pid is not this storage's `pid`, `isAlive(pid)` is true, and it is either a
   legacy lock (no heartbeat) or its `heartbeatAt` is no older than
   `LOCK_STALE_MS`; `"own"` when its pid equals this storage's `pid`; otherwise
   `"stale"`. A missing lock file, or a body the lock schema rejects, returns
   `null`, because `acquireLock` would take such a file over. The result is a
   snapshot; `acquireLock` stays the only authority. The freshness check is one
   predicate exported from `session-lock.ts` (not from the package entry),
   `holderState(body, deps, isAlive): SessionLockHolderState`, created in US-001,
   that both `takeover` and `readLockHolder` call, so the two cannot drift; `takeover` refuses exactly when it returns
   `"live"`.
4. **Consume and delete (US-004).** The ACP server imports `createSessionStorage`,
   `SESSION_ID_PATTERN`, `defaultSessionsDir` and the types from
   `@nathapp/nax-agent`; `nax-config.ts` derives `MODES` from
   `SESSION_META_MODES`; `options.ts` uses `defaultSessionsDir(configDir)` for the
   fallback; `registry.list` maps the neutral page to `ListSessionsResponse`;
   `toRequestError` maps `SESSION_LOCKED` to `RequestError.invalidRequest` and
   `SESSION_LIST_CURSOR_INVALID` to `invalidParams`, neither logged as a failure.
   Then the ACP copies (`storage.ts`, `session-lock.ts`, `session-lock-guard.ts`),
   their tests and the `lock-contender.ts` fixture are deleted.
5. **Ported tests (US-001, US-002).** The moved tests replace the ACP-only
   `#test/helpers/recording-logger` (`lines`) with nax-agent's `makeLogger()` from
   `test/helpers/agent-logger.ts` (`calls`). The moved fixture
   `test/fixtures/session-store/lock-contender.ts` imports
   `#src/session-store/session-lock` and `#src/session-store/session-lock-guard`
   and passes an inline no-op `AgentLogger` (it runs as a child `bun` process, not
   under `bun test`); the hardening test spawns it as
   `join(import.meta.dir, "../../fixtures/session-store/lock-contender.ts")`.
6. **Unchanged details.** `SessionListEntry.updatedAt` carries
   `updatedAt ?? createdAt`, as the ACP `infoOf` does today. The moved warn and
   info log lines keep the stage `"session"`; only `NaxError` contexts use
   `"session-store"`.

### Integration (extends existing code)

The baseline shapes exist only to locate the code; they are never the interface to
implement. Implement the target.

**Read only (verified 2026-10-25 on `main` `01a03611c`):**

- `packages/nax-agent-acp/src/server/connection.ts` — `buildAgentApp` routes
  `session/list`, `session/load`, `session/resume` and the rest through
  `guard(deps.logger, () => deps.registry.<method>(...))`, so any error a registry
  call throws reaches `toRequestError`.
- `packages/nax-agent-acp/src/server/registry.ts` — calls
  `deps.storage.acquireLock`, `readMeta`, `writeMeta`, `hasMeta`, `removeMeta`,
  `list`; `list: (query) => deps.storage.list(query)`.
- `packages/nax-agent/src/config/bash-approval.ts` —
  `BashApprovalModeSchema = z.enum(["raw", "gated", "escalate"])`.
- `packages/nax-agent/src/infra/errors.ts` — `errorMessage(err: unknown): string`.
- `packages/nax-agent/test/helpers/agent-logger.ts` — `makeLogger()` records calls
  as `{ level, stage, message, data }`.

**Changed (baseline -> target):**

`SessionStorage` — Baseline (`nax-agent-acp/src/server/storage.ts`):

```typescript
list(query: { readonly cwd?: string | null; readonly cursor?: string | null }): Promise<ListSessionsResponse>;
```

Target (`nax-agent/src/session-store/storage.ts`):

```typescript
export interface SessionListEntry {
  readonly sessionId: string;
  readonly cwd: string;
  readonly title: string | null;
  readonly updatedAt: string;
}
export interface SessionListPage {
  sessions: SessionListEntry[];
  nextCursor?: string;
}
// SessionLockHolderState is declared in session-lock.ts (US-001) and re-exported here, never redeclared.
export interface SessionLockHolder {
  readonly pid: number;
  readonly startedAt: string;
  readonly heartbeatAt: string | null;
  readonly state: SessionLockHolderState;
}
export interface SessionStorage {
  readonly dir: string;
  readMeta(sessionId: string): Promise<SessionMeta | null>;
  writeMeta(meta: SessionMeta): Promise<void>;
  hasMeta(sessionId: string): Promise<boolean>;
  removeMeta(sessionId: string): Promise<void>;
  acquireLock(sessionId: string): Promise<() => Promise<void>>;
  readLockHolder(sessionId: string): Promise<SessionLockHolder | null>; // US-003
  list(query: { readonly cwd?: string | null; readonly cursor?: string | null }): Promise<SessionListPage>;
}
export interface SessionStorageDeps {
  readonly dir: string;
  readonly pid: number;
  readonly now: () => Date;
  readonly logger: AgentLogger;
  readonly setInterval?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly isAlive?: (pid: number) => boolean;
}
export function createSessionStorage(deps: SessionStorageDeps): SessionStorage;
export function processAlive(pid: number): boolean;
export const LIST_PAGE_SIZE = 50;
```

`StorageDeps` is renamed `SessionStorageDeps`, because it becomes a public name.

`session-meta.ts` — Target:

```typescript
export const SESSION_META_MODES = ["none", "read", "ask", "full"] as const;
export type SessionMetaMode = (typeof SESSION_META_MODES)[number];
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export function defaultSessionsDir(configDir: string): string; // join(configDir, ".agent-server", "sessions")
export type SessionMeta = Readonly<{
  schemaVersion: 1; sessionId: string; cwd: string; mode: SessionMetaMode; model: string;
  bashApproval: BashApprovalMode; title: string | null; createdAt: string; updatedAt: string | null; costUsd?: number;
}>;
```

`session-lock.ts` — Baseline: `acquireSessionLock(path, deps: StorageDeps, isAlive)`;
`refused(pid?)` returns `RequestError.invalidRequest(...)`. Target: same signature
with `SessionStorageDeps`; `refused(pid?)` returns
`new NaxError(message, "SESSION_LOCKED", { stage: "session-store", ...(pid !== undefined ? { pid } : {}) })`
with the unchanged message. `LOCK_HEARTBEAT_MS = 30_000` and `LOCK_STALE_MS = 120_000`
are unchanged and exported.

`session-lock-guard.ts` — Baseline: `class SessionLockGuardBusy extends RequestError`
(`-32600`). Target: `class SessionLockGuardBusy extends NaxError`, code
`SESSION_LOCKED`, message `session in use by another process`.

`toRequestError` (`nax-agent-acp/src/server/errors.ts`) — Target adds, before the
generic branch: `NaxError` code `SESSION_LOCKED` ->
`RequestError.invalidRequest(undefined, error.message)`; `NaxError` code
`SESSION_LIST_CURSOR_INVALID` -> `invalidParams(error.message)`. Neither logs.

### Failure Handling

| Situation | Behaviour |
|---|---|
| `acquireLock` while another live pid holds a fresh lock | `NaxError` `SESSION_LOCKED`, message `session in use by pid <pid>`, context `pid`; lock file unchanged. |
| `acquireLock` while another process holds the mutation guard | `SessionLockGuardBusy` (`NaxError` `SESSION_LOCKED`), message `session in use by another process`. |
| `acquireLock` over a stale lock (dead pid, or heartbeat older than `LOCK_STALE_MS`) | Takes over, logs info `taking over a stale session lock`, resolves the release function (unchanged). |
| `list` with a cursor that is not base64 of a non-negative integer | `NaxError` `SESSION_LIST_CURSOR_INVALID`, message `invalid cursor`. |
| `list` meets an unreadable metadata file | Skips it, logs warn `skipping unreadable session metadata` with the file name (unchanged). |
| `list` on a missing directory | `{ sessions: [] }` (unchanged). |
| `readMeta` on invalid JSON, a bad shape, or a `schemaVersion` other than 1 | `NaxError` `SESSION_META_UNREADABLE`, file left as is (unchanged; stage now `session-store`). |
| `readLockHolder` on a missing or schema-invalid lock file | `null`; nothing written or deleted. |
| ACP `session/load` or `session/resume` of a locked session | JSON-RPC error `-32600` whose message contains `session in use by pid <pid>` (unchanged on the wire). |
| ACP `session/list` with an invalid cursor | JSON-RPC error `-32602` whose message contains `invalid cursor` (unchanged on the wire). |

## Out of Scope

- The on-disk formats do not change: `<id>.session.json` stays `schemaVersion: 1` with the same fields, `<id>.lock` keeps its body shape (nonce plus heartbeat, and legacy pid-only locks), and file names and the temp-then-rename write stay as they are.
- No new package subpath export and no change to `check:package-boundaries`; the shared storage is exported from the `@nathapp/nax-agent` package entry only.
- Sessions-dir resolution beyond `defaultSessionsDir(configDir)` stays in the ACP server: `--sessions-dir`, `NAX_AGENT_SESSIONS_DIR` and `agentServer.sessionsDir` are read only by `nax-agent-acp/src/server/options.ts`; how the TUI resolves the directory is decided in feature F3.
- `packages/nax` is unchanged: no TUI, no `nax chat`, no metadata writer outside the ACP server (feature F3).
- The transcript store (`createFileTranscriptStore`, `TranscriptStore`) is unchanged and not moved.
- No mode values are added to `SESSION_META_MODES`; mapping the TUI's `guarded` and `full` modes onto it is feature F3's work.
- These lock behaviours move unchanged and are covered by the ported `storage-hardening.test.ts` cases, not by new acceptance criteria: the heartbeat stops once the lock file names another nonce, takeover restores a renamed file that changed under it and refuses, dead mutation guards are reaped, a crash inside the guard leaves it reapable, and release retries on `SessionLockGuardBusy` (still matched by `instanceof`) until it can check the nonce.
- Lock semantics are moved, not redesigned: no new concurrency guarantee, no change to the heartbeat interval or stale threshold, no network-filesystem or Windows support work.
- US-003 only: `readLockHolder` is a point-in-time snapshot; the holder can change right after the read, and only `acquireLock` decides ownership.
- US-003 only: `readLockHolder` does not take the mutation guard, so a read during another process's lock rename may see no file and return `null`.
- Updating `.nax/mono/packages/nax-agent-acp/context.md` and `.nax/mono/packages/nax-agent/context.md` to say where session storage lives, and running `nax generate`, is a manual step after merge; `.nax/` is read-only to the run.
- No release and no version bump.

## Stories

Paths below are repo-relative. Four stories, one capability: one storage module
shared by the ACP server and later the TUI.

### US-001 — The session lock layer lives in `@nathapp/nax-agent` with a NaxError contract

Workdir: packages/nax-agent. No dependencies.

- Create `src/session-store/session-lock-guard.ts` and `src/session-store/session-lock.ts` carrying the ACP lock logic, with `SessionLockGuardBusy` a `NaxError` subclass, refusals as `NaxError` `SESSION_LOCKED`, and the `holderState` predicate that `takeover` uses (Design §Approach 2 and 3).
- `SessionStorageDeps` is declared in `session-lock.ts` (or a sibling types file) so the lock layer does not import `storage.ts`.
- Port `storage-hardening.test.ts` and the `lock-contender.ts` fixture into `test/unit/session-store/` and `test/fixtures/session-store/` (Design §Approach 5), driving `acquireSessionLock` directly.

### US-002 — Session metadata, listing and the package exports

Workdir: packages/nax-agent. Depends on US-001.

- Create `src/session-store/session-meta.ts`, `src/session-store/storage.ts` and `src/session-store/index.ts`; `createSessionStorage` uses US-001's `acquireSessionLock`; `list` returns `SessionListPage` and throws `SESSION_LIST_CURSOR_INVALID`.
- Re-export the public names from `src/index.ts` and regenerate the API snapshot with `bun run api:update`.
- Port `storage.test.ts` into `test/unit/session-store/storage.test.ts`, asserting `NaxError` codes instead of `RequestError` and `makeLogger().calls` instead of `lines`.

### US-003 — `readLockHolder` reports who holds a session lock

Workdir: packages/nax-agent. Depends on US-002.

- Add `readLockHolder(sessionId)` to `SessionStorage`, built on US-001's `holderState`, with `SessionLockHolder` and `SessionLockHolderState` exported.
- Regenerate the API snapshot.

### US-004 — The ACP server uses the shared storage; its copies are deleted

Workdir: packages/nax-agent-acp. Depends on US-002.

- Switch `main.ts`, `connection.ts`, `registry.ts`, `registry-lifecycle.ts`, `registry-open.ts`, `options.ts`, `nax-config.ts` and the test helpers and tests to the `@nathapp/nax-agent` names; `registry.list` maps the page to `ListSessionsResponse`; `MODES` in `nax-config.ts` becomes `SESSION_META_MODES` itself.
- Map `SESSION_LOCKED` and `SESSION_LIST_CURSOR_INVALID` in `toRequestError`.
- Delete `src/server/storage.ts`, `src/server/session-lock.ts`, `src/server/session-lock-guard.ts`, `test/unit/server/storage.test.ts`, `test/unit/server/storage-hardening.test.ts` and `test/fixtures/lock-contender.ts`. Verification note: the removals are checked by `bun run typecheck` and `bun run check:all` in `packages/nax-agent-acp`, not by acceptance criteria.

### Context Files

**US-001**
- `packages/nax-agent-acp/src/server/session-lock.ts`
- `packages/nax-agent-acp/src/server/session-lock-guard.ts`
- `packages/nax-agent-acp/test/unit/server/storage-hardening.test.ts`
- `packages/nax-agent-acp/test/fixtures/lock-contender.ts`
- `packages/nax-agent/test/helpers/agent-logger.ts`

**US-002**
- `packages/nax-agent-acp/src/server/storage.ts`
- `packages/nax-agent-acp/test/unit/server/storage.test.ts`
- `packages/nax-agent/src/session-store/session-lock.ts` — created by US-001
- `packages/nax-agent/src/index.ts`

**US-003**
- `packages/nax-agent/src/session-store/storage.ts` — created by US-002, extended here
- `packages/nax-agent/src/session-store/session-lock.ts` — created by US-001, read for `holderState`
- `packages/nax-agent/test/unit/session-store/storage.test.ts` — created by US-002

**US-004**
- `packages/nax-agent-acp/src/server/errors.ts`
- `packages/nax-agent-acp/src/server/registry.ts`
- `packages/nax-agent-acp/src/server/connection.ts`
- `packages/nax-agent-acp/src/server/options.ts`
- `packages/nax-agent-acp/test/helpers/registry-setup.ts`

### Creates

**US-001**
- `packages/nax-agent/src/session-store/session-lock-guard.ts`
- `packages/nax-agent/src/session-store/session-lock.ts`
- `packages/nax-agent/test/unit/session-store/storage-hardening.test.ts`
- `packages/nax-agent/test/fixtures/session-store/lock-contender.ts`

**US-002**
- `packages/nax-agent/src/session-store/session-meta.ts`
- `packages/nax-agent/src/session-store/storage.ts`
- `packages/nax-agent/src/session-store/index.ts`
- `packages/nax-agent/test/unit/session-store/storage.test.ts`

**US-003**
- `packages/nax-agent/test/unit/session-store/lock-holder.test.ts`

### Modifies

**US-001**
None. US-001 adds new files only and exports nothing from the package entry, so no existing assertion changes.

**US-002**
- `packages/nax-agent/api/nax-agent.api.txt` — the public API snapshot lists every exported name; the invariant is the snapshot regenerated by bun run api:update gaining the session-store names (createSessionStorage, defaultSessionsDir, processAlive, LIST_PAGE_SIZE, LOCK_HEARTBEAT_MS, LOCK_STALE_MS, SESSION_ID_PATTERN, SESSION_META_MODES and the types).

**US-003**
- `packages/nax-agent/api/nax-agent.api.txt` — regenerated with bun run api:update so it gains type SessionLockHolder and type SessionLockHolderState.

**US-004**
- `packages/nax-agent-acp/test/helpers/registry-setup.ts` — imports createSessionStorage and type SessionStorage from the ACP storage module this story deletes; the invariant is the same helper importing them from @nathapp/nax-agent.
- `packages/nax-agent-acp/test/unit/server/registry.test.ts` — the test a session held by another live process is refused with the pid passes the load rejection to failure(), which throws unless it is a RequestError; registry.load is called directly, not through guard(), so it now rejects with a NaxError. The invariant is that this one assertion expects a NaxError with code SESSION_LOCKED whose message contains session in use by pid 4242; failure() and every other assertion are unchanged.
- `packages/nax-agent-acp/test/unit/server/errors.test.ts` — gains the toRequestError cases for SESSION_LOCKED and SESSION_LIST_CURSOR_INVALID; existing assertions unchanged.
- `packages/nax-agent-acp/test/unit/server/options.test.ts` — gains the default sessionsDir case through defaultSessionsDir; existing assertions unchanged.
- `packages/nax-agent-acp/test/unit/server/nax-config.test.ts` — gains the MODES is SESSION_META_MODES case; existing assertions unchanged.
- `packages/nax-agent-acp/test/unit/server/connection-sessions.test.ts` — imports createSessionStorage from the ACP storage module deleted here; the invariant is the import from @nathapp/nax-agent with the assertions unchanged.
- `packages/nax-agent-acp/test/unit/server/registry-credentials.test.ts` — imports createSessionStorage from the ACP storage module deleted here; the invariant is the import from @nathapp/nax-agent with the assertions unchanged.
- `packages/nax-agent-acp/test/unit/server/connection.test.ts` — imports createSessionStorage and SESSION_ID_PATTERN from the ACP storage module deleted here; the invariant is the import from @nathapp/nax-agent with the assertions unchanged.
- `packages/nax-agent-acp/test/unit/server/connection-close-switch.test.ts` — imports createSessionStorage from the ACP storage module deleted here; the invariant is the import from @nathapp/nax-agent with the assertions unchanged.
- `packages/nax-agent-acp/test/unit/server/registry-switch.test.ts` — imports createSessionStorage and type SessionStorage from the ACP storage module deleted here; the invariant is the import from @nathapp/nax-agent with the assertions unchanged.
- `packages/nax-agent-acp/test/unit/server/connection-persistence.test.ts` — imports createSessionStorage from the ACP storage module deleted here; the invariant is the import from @nathapp/nax-agent with the assertions unchanged.
- `packages/nax-agent-acp/test/unit/server/storage.test.ts` — moved into nax-agent by US-002; this story deletes it.
- `packages/nax-agent-acp/test/unit/server/storage-hardening.test.ts` — moved into nax-agent by US-001; this story deletes it.
- `packages/nax-agent-acp/test/fixtures/lock-contender.ts` — moved into nax-agent by US-001; this story deletes it.

### Seams

- US-001 -> US-002: `acquireSessionLock`; US-002 asserts `createSessionStorage(...).acquireLock` on a held lock rejects with `SESSION_LOCKED`.
- US-001 -> US-003: `holderState`; US-003 asserts `readLockHolder` and `acquireLock` agree on `"live"`, `"stale"` and `"own"` locks.
- US-002 -> US-004: `createSessionStorage` and `defaultSessionsDir` from `@nathapp/nax-agent`; US-004 asserts, through the ACP connection built by `buildAgentApp` over registry deps whose storage is that `createSessionStorage`, that a `session/load` of a locked session fails with `-32600` and that `session/list` returns a session created through `session/new`.
- US-001/US-002 -> US-004: the `SESSION_LOCKED` and `SESSION_LIST_CURSOR_INVALID` codes; US-004 asserts `toRequestError` maps each to its JSON-RPC code.

## Acceptance Criteria

### US-001 — The session lock layer

All ACs call `acquireSessionLock(path, deps, isAlive)` or `holderState` from `src/session-store/session-lock.ts` with `deps.pid` 1000 and `deps.now` fixed at `2026-10-09T00:00:00Z`.

- [unit] `acquireSessionLock` over a lock file `{ pid: 4242, startedAt, nonce, heartbeatAt: "2026-10-09T00:00:00.000Z" }` with `isAlive` reporting 4242 alive throws a `NaxError` whose `code` is `SESSION_LOCKED`.
- [unit] That refusal's message contains `session in use by pid 4242`.
- [unit] That refusal's `context.pid` is `4242`.
- [unit] `acquireSessionLock` over a lock for live pid 4242 whose `heartbeatAt` is one millisecond more than `LOCK_STALE_MS` before `now` returns a release function and the lock file's `pid` becomes 1000.
- [unit] That stale takeover logs an info whose message is `taking over a stale session lock`.
- [unit] `acquireSessionLock` over a legacy lock `{ pid: 4242, startedAt }` (no nonce, no heartbeat) with 4242 alive throws `SESSION_LOCKED`.
- [unit] Calling the returned release function removes the lock file.
- [unit] Calling the release function after the lock file was rewritten with a different `nonce` leaves the lock file in place holding that other nonce.
- [unit] With `deps.setInterval` stubbed to capture its callback, the stub was called with `LOCK_HEARTBEAT_MS`, which is `30000`.
- [unit] Invoking the captured heartbeat callback after `deps.now` advances to `2026-10-09T00:00:30Z` rewrites the lock's `heartbeatAt` to `2026-10-09T00:00:30.000Z`.
- [unit] `new SessionLockGuardBusy()` is an instance of `NaxError`.
- [unit] `new SessionLockGuardBusy()` has `code` `SESSION_LOCKED`.
- [unit] `holderState` for a holder with live pid 4242 whose `heartbeatAt` is exactly `LOCK_STALE_MS` before `now` returns `"live"`.
- [unit] `holderState` for a holder whose pid is 1000 (the deps' own pid) returns `"own"`, even when `isAlive` reports 1000 dead.
- [unit] `holderState` for a holder with pid 4242 that `isAlive` reports dead returns `"stale"`.
- [integration] While the parent process is inside a heartbeat lock mutation (its `_lockDeps.rename` barrier spawns the child), a child process run from `test/fixtures/session-store/lock-contender.ts` against the same lock path prints `{ "acquired": false }`.
- [integration] After the parent leaves the mutation, the same child run prints `{ "acquired": true }`, and the parent's later release leaves the child's nonce in the lock file.

### US-002 — Session metadata, listing and the package exports

- [unit] `createSessionStorage` imported from the package entry `src/index.ts` is a function.
- [unit] `defaultSessionsDir` imported from `src/index.ts` returns `/h/.nax/.agent-server/sessions` for `/h/.nax`.
- [unit] After `writeMeta(meta)` on a storage over a temp directory, `readMeta(meta.sessionId)` deep-equals `meta`.
- [unit] `readMeta` of an id with no metadata file resolves to `null`.
- [unit] `readMeta` of a metadata file holding invalid JSON rejects with a `NaxError` whose `code` is `SESSION_META_UNREADABLE`.
- [unit] That rejection's `context.stage` is `"session-store"`.
- [unit] `readMeta` of a metadata file with `schemaVersion: 2` rejects with a message containing `schemaVersion 2; this build reads 1`.
- [unit] `readMeta` of a metadata file whose `mode` is `"review"` rejects with `SESSION_META_UNREADABLE`.
- [unit] `list({})` over three sessions returns them newest first, ordered by `updatedAt`, or by `createdAt` when `updatedAt` is null.
- [unit] Each entry `list({})` returns has exactly the keys `sessionId`, `cwd`, `title` and `updatedAt`.
- [unit] `list({ cwd: "/repo-a" })` returns only the sessions whose metadata `cwd` is `/repo-a`.
- [unit] `list({})` over 51 sessions returns 50 entries and a `nextCursor`.
- [unit] `list({ cursor })` with that `nextCursor` returns 1 entry and no `nextCursor`.
- [unit] `list({ cursor: "bad" })` rejects with a `NaxError` whose `code` is `SESSION_LIST_CURSOR_INVALID`.
- [unit] `list({})` with one metadata file holding invalid JSON still returns the other sessions.
- [unit] That `list({})` logs a warn whose message is `skipping unreadable session metadata` and whose `data.file` names the bad file.
- [unit] `list({})` on a directory that does not exist returns `{ sessions: [] }`.
- [unit] `createSessionStorage(...).acquireLock(id)` while `<id>.lock` holds live pid 4242 with a heartbeat equal to `now` rejects with `SESSION_LOCKED`.

### US-003 — `readLockHolder` reports who holds a session lock

Storage built with `pid` 1000 and `now` fixed at `2026-10-09T00:00:00Z`.

- [unit] `readLockHolder(id)` with no `<id>.lock` file resolves to `null`.
- [unit] `readLockHolder(id)` over a lock `{ pid: 4242, startedAt, nonce, heartbeatAt: "2026-10-09T00:00:00.000Z" }` with `isAlive` reporting 4242 alive resolves to `{ pid: 4242, startedAt, heartbeatAt: "2026-10-09T00:00:00.000Z", state: "live" }`.
- [unit] `readLockHolder(id)` over the same lock with `isAlive` reporting 4242 dead resolves with `state: "stale"`.
- [unit] `readLockHolder(id)` over a lock whose `pid` is 1000 resolves with `state: "own"`.
- [unit] `readLockHolder(id)` over a legacy lock `{ pid: 4242, startedAt }` with 4242 alive resolves with `heartbeatAt: null` and `state: "live"`.
- [unit] `readLockHolder(id)` over a lock file holding `not json` resolves to `null`.
- [unit] `readLockHolder(id)` over a lock file holding `{ "pid": -1 }` resolves to `null`.
- [unit] After `readLockHolder(id)` over a live lock, the lock file's bytes are unchanged and the directory holds no new file.
- [unit] For a lock `readLockHolder` reports `"live"`, `acquireLock` on the same storage rejects with `SESSION_LOCKED`.
- [unit] For a lock `readLockHolder` reports `"stale"`, `acquireLock` on the same storage resolves.
- [unit] For a lock `readLockHolder` reports `"own"`, `acquireLock` on the same storage resolves and the lock file then holds a new nonce.

### US-004 — The ACP server uses the shared storage; its copies are deleted

- [unit] `toRequestError(new NaxError("session in use by pid 4242", "SESSION_LOCKED", { stage: "session-store", pid: 4242 }), logger)` returns a `RequestError` with `code` `-32600` whose message contains `session in use by pid 4242`.
- [unit] `toRequestError(new NaxError("invalid cursor", "SESSION_LIST_CURSOR_INVALID", { stage: "session-store" }), logger)` returns a `RequestError` with `code` `-32602` whose message contains `invalid cursor`.
- [unit] Neither mapping calls `logger.error`.
- [unit] `resolveServerOptions` with no `--sessions-dir`, no `NAX_AGENT_SESSIONS_DIR`, no `agentServer.sessionsDir` and `configDir` `/h/.nax` resolves `options.sessionsDir` to `/h/.nax/.agent-server/sessions`.
- [unit] `MODES` exported from `src/server/nax-config.ts` is the same array object as `SESSION_META_MODES` from `@nathapp/nax-agent`.
- [integration] Through a connection built by `buildAgentApp` over the registry test setup (whose storage is `createSessionStorage` from `@nathapp/nax-agent`), `session/new` followed by `session/list` returns the new session's id and cwd.
- [integration] Through the same connection, with the setup given `isAlive: (pid) => pid === 4242` and the session's lock file written as `{ pid: 4242, startedAt: "x" }` (a legacy body, so no heartbeat age applies), `session/load` of that session fails with JSON-RPC code `-32600` and a message containing `session in use by pid 4242`.
- [integration] Through the same connection, `session/list` with `cursor: "bad"` fails with JSON-RPC code `-32602` and a message containing `invalid cursor`.
- [integration] Through the same connection, `session/list` after a metadata file is written directly with `createSessionStorage(...).writeMeta` (no ACP request created that session) includes that session.
