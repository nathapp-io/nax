# SPEC: A session close during a mode or model switch wins, and keeps ownership until the switch drains

Closes: #2654

## Summary

A `session/close` for a session that is in the middle of a mode or model switch now waits for that switch to settle.
It then closes whichever S3 session the switch left live, the replacement or the restored one. Only after that does
the registry release the session's lock and remove its entry. The interrupted switch rejects with
`session is closed`, so the registry never reinserts the entry and never writes its metadata. A `session/delete` or a
shutdown (`closeAll`) that overlaps a switch is held to the same rule. The fix is in `nax-agent-acp`'s server
(`ServerSession` and the session registry), and is pinned through the real ACP RPC handlers.

## Motivation

nax#2654 (P1). `ServerSession.switchTo` sets `closed = true` while it closes the old S3 session and opens the
replacement. `close()` returns at once when `closed` is already true (`server-session.ts:288`), so a close that arrives
during the switch resolves without closing anything. The registry then:

1. runs `closeRegistryEntry`, which closes the MCP tools, releases the session's lock and deletes the entry;
2. lets the switch finish: `switchTo` sets `closed = false` and adopts the replacement, and the registry's `switchTo`
   reinserts the entry with `entries.set` (`registry.ts:273`) and rewrites the metadata.

The client was told the close completed, but the session is back in the registry, unlocked, and answers prompts. The
issue's reproduction drives this through the real `buildAgentApp` RPC handlers (`session/set_mode` overlapped by
`session/close`) and observes `resurrected: true, unlocks: 1, newSessionClosed: false, promptAfterClose: "end_turn"`.

The same gap has two more entry points the issue's checklist asks to cover:

- **Shutdown.** `closeAll` calls `server.close()`, which resolves immediately mid-switch, and its cleanup releases the
  lock; the switch then reinserts the entry.
- **Delete.** `session/delete` closes the entry, then removes the transcript and metadata under the lock; the switch
  then writes the metadata back.

## Design

### Approach

1. **Terminal close is separate from the switch's gap.** `ServerSession` keeps `closed` meaning "no live S3 session".
   `switchTo` still sets it during its gap, so `isClosed()` and the reopen path keep their meaning. A new flag records
   that a terminal close was requested, exposed as `isClosing(): boolean` (true from the first `close()` call on).
   `switchTo` keeps its in-flight promise as `switching`.
2. **`close()` during a switch.**
   - Every first `close()` sets the closing flag, so `isClosing()` is true from then on, including on the fast path
     below. A second call returns the same `closing` promise.
   - `close()` resolves at once, without closing anything, only when `closed` is true and no switch is in flight.
     That is a session a failed switch left dead, which the registry's dead-entry cleanup closes.
   - `switching` is set when `switchTo` starts its gap and cleared in `switchTo`'s own `finally`, before its promise
     settles, whatever the outcome.
   - A `live` marker records whether the session currently holds a live S3 session. It is false from the moment the
     switch closes the old one, and true again only once `open` or `restore` returns a session. `closing` closes the
     current session only when `live` is true.
   - When `switching` is set, `closing` first waits for the switch to settle, ignoring its rejection. It then closes
     the S3 session the switch left live, and finally awaits `drained`, as today.
   - When the switch ends with no live S3 session (both `open` and `restore` failed), `closing` does not call
     `close()` on the old session a second time.
3. **The interrupted switch rejects.** When `switchTo`'s `open` (or `restore`) settles and a close was requested
   meanwhile, `switchTo`:
   - still adopts the session it got, so `close()` closes it;
   - leaves `closed` true;
   - rejects with `RequestError.invalidRequest(undefined, "session is closed")`, instead of resolving or rethrowing
     the open error.

   The closing check runs after the existing `open`/`restore` try/catch has settled, never inside its `try`.
   Otherwise the existing catch would call `restore()` and rethrow the open error. The two `closed = false`
   assignments (after a successful `open` or `restore`) are skipped when a close was requested, so `closed` stays
   true. A `switchTo` called after `close()` already rejects with the same error before calling `open`, as today.
4. **Registry.**
   - In `switchTo`'s catch, when `entry.server.isClosing()` is true, the registry rethrows without running its
     dead-entry cleanup. Whoever called `close` owns that cleanup (`closeRegistryEntry`, `closeEntries` or
     `delete`), so the MCP tools are closed once and the lock is released once.
5. **Ownership.** `closeRegistryEntry` already awaits `server.close()` before it closes the MCP tools and releases the
   lock. Because `close()` now waits for the switch, the lock stays held until the replacement session is closed.
   `closeEntries` (shutdown) already defers cleanup while `entry.server.running` is true after its wait. `running`
   is true for the whole switch, so a switch still in flight keeps ownership past the bounded wait. Once the switch
   has settled, a slow close of the replacement is bounded like any other hung close.

### Integration

Read only (verified at `6cc3675eb`):

- `packages/nax-agent-acp/src/server/registry-lifecycle.ts`:
  - `closeRegistryEntry(entries, sessionId, entry)` runs `server.close()`, then `mcp.closeAll()`, then `release()`,
    then `entries.delete`.
  - `closeEntries({ open, entries, wait, logger })` is the bounded shutdown; it defers cleanup while
    `entry.server.running`.
- `packages/nax-agent-acp/src/server/registry-open.ts`: `reopen` throws `unknownSession` for a registered entry whose
  `server.isClosed()` is true.
- `packages/nax-agent-acp/src/server/connection.ts`: `buildAgentApp` routes `session/close` to `registry.close`,
  `session/set_mode` to `registry.setMode`, and `session/set_config_option` to `registry.setConfigOption`.
- `packages/nax-agent-acp/src/server/errors.ts`: `unknownSession(id)` returns `RequestError.resourceNotFound(id)`.

Changed. Each baseline below only locates the code, and is never the interface to implement; the target is.

- `packages/nax-agent-acp/src/server/server-session.ts` `ServerSession`
  - Baseline: `{ id; running; queueNotice; prompt; switchTo; isClosed; cancel; close }`.
  - Target: plus `isClosing(): boolean`.
- `packages/nax-agent-acp/src/server/server-session.ts` `createServerSession(...).close()`
  - Baseline: returns `Promise.resolve()` when `closed` is already true.
  - Target: Approach 2.
- `packages/nax-agent-acp/src/server/server-session.ts` `createServerSession(...).switchTo(open, restore)`
  - Target: Approach 3.
- `packages/nax-agent-acp/src/server/registry.ts` `switchTo(sessionId, entry, next)` (internal)
  - Target: Approach 4.
- `packages/nax-agent-acp/test/helpers/registry-setup.ts` `RegistrySetupExtra`
  - Baseline: `openGate` gates every `openSession` call.
  - Target: plus `openGateFrom?: number`, the 1-based `openSession` call from which `openGate` applies, so a test can
    create the session and then gate only the switch's open. Plus `releases(): number`, which counts calls of every
    lock-release function `acquireLock` returned. The existing `openGate` behaviour is unchanged when `openGateFrom`
    is unset.

### Failure Handling

| Situation | Behaviour |
|:---|:---|
| Close during a switch whose `open` succeeds | Close waits, closes the replacement; switch rejects `session is closed`; entry not reinserted |
| Close during a switch whose `open` fails and `restore` succeeds | Close waits, closes the restored session; switch rejects `session is closed` |
| Close during a switch whose `open` and `restore` both fail | Close resolves without a second `close()` on the old session; switch rejects `session is closed` |
| `switchTo` called after `close()` | Rejects `session is closed`; `open` is never called |
| Second `close()` during the same switch | Returns the first close's promise; the replacement is closed once |

## Out of Scope

- Cancelling the replacement session's open when a close arrives; the close waits for the open to settle instead.
- Changing what `isClosed()` reports during a switch; it stays true for the switch's gap, so `reopen` keeps answering `resource_not_found` for a session mid-switch.
- A `session/load` or `session/resume` of the same id overlapping a switch; `reopen` already refuses it while `isClosed()` is true.
- The nax-side ACP client (`src/client/`); this feature changes only the `./server` side.
- A `session/delete` that lands after a switch has fully succeeded but before the registry's own `writeMeta` resolves (a pre-existing window unrelated to the close race).

## Stories

Two stories, both in `packages/nax-agent-acp`.

### US-001: `ServerSession.close()` waits for an in-flight switch
No dependencies. Workdir: packages/nax-agent-acp.

Adds `isClosing()` to `ServerSession`, the `switching` promise and the closing flag. `close()` waits for an in-flight
switch, then closes the session the switch left live. A switch interrupted by a close rejects `session is closed`
(Approach 1-3). Tested on `createServerSession` with fake S3 sessions, as in `server-session-switch.test.ts`.

### US-002: The registry never resurrects a session closed during a switch
Depends on US-001. Workdir: packages/nax-agent-acp.

The registry's `switchTo` skips its dead-entry cleanup when `entry.server.isClosing()`. An interrupted switch
rejects before the reinsert and the metadata write (Approach 4). Extends `registry-setup.ts` with `openGateFrom` and
`releases()`. Pins close, delete and `closeAll` during a switch at the registry. It also pins `session/set_mode` and
`session/set_config_option` overlapped by `session/close`, through `buildAgentApp` and the ACP SDK client, in the
pattern of `connection-sessions.test.ts`. The new `connection-close-switch.test.ts` builds its own registry with
`createSessionRegistry`:
- its `OPTIONS` carry tiers `fast` = `anthropic/claude-haiku-4-5` and `balanced` = `anthropic/claude-sonnet-5-5`
  (default model `anthropic/claude-sonnet-5-5`), as `connection-persistence.test.ts` does, so a model change really
  switches;
- its `openSession` records each fake session and waits on a gate from the second call on;
- it keeps the registry and the fakes for its assertions.

Probes that a promise is still pending race it against an already-settled marker, as `registry-hardening.test.ts`
does.

### Context Files

**US-001**
- `packages/nax-agent-acp/src/server/server-session.ts` — `ServerSession`, `createServerSession`, `switchTo`, `close`
- `packages/nax-agent-acp/test/unit/server/server-session-switch.test.ts` — the switch harness (`setup`, gated `open`)
- `packages/nax-agent-acp/test/helpers/fake-agent-session.ts` — `fakeAgentSession`, `closed()`

**US-002**
- `packages/nax-agent-acp/src/server/registry.ts` — `switchTo`, `close`, `delete`, `closeAll`
- `packages/nax-agent-acp/src/server/registry-lifecycle.ts` — `closeRegistryEntry`, `closeEntries`
- `packages/nax-agent-acp/test/helpers/registry-setup.ts` — `setupRegistry`, `openGate`, `failOpens`
- `packages/nax-agent-acp/test/unit/server/connection-sessions.test.ts` — the `buildAgentApp` RPC harness
- `packages/nax-agent-acp/test/helpers/fake-agent-session.ts` — `fakeAgentSession`, `closed()`

### Creates

**US-001**
- `packages/nax-agent-acp/test/unit/server/server-session-close-switch.test.ts`

**US-002**
- `packages/nax-agent-acp/test/unit/server/registry-close-switch.test.ts`
- `packages/nax-agent-acp/test/unit/server/connection-close-switch.test.ts`

### Modifies

**US-001**
None. No existing test calls `close()` during a switch. In `server-session-switch.test.ts`, "a failed restore is logged and the open error is still returned" and "close failure still attempts open and restore and preserves the open error" request no close, so they still see `isClosed()` true and the open error.

**US-002**
- `packages/nax-agent-acp/test/helpers/registry-setup.ts` — `RegistrySetupExtra` gains `openGateFrom?: number` (the 1-based `openSession` call from which `openGate` applies) and `setupRegistry`'s result gains `releases(): number` (calls of every lock-release function `acquireLock` returned). With `openGateFrom` unset, `openGate` still gates every call, so every existing registry test keeps its behaviour. No existing assertion changes; the registry hardening test that retires a dead switched entry requests no close, so the dead-entry cleanup still runs.

### Seams

- US-001 -> US-002: `ServerSession.isClosing()` (US-001) is read by the registry's `switchTo` (US-002). US-002's ACs enter at `registry.close` / `registry.delete` / `registry.closeAll` racing `registry.setMode`, and at the `session/close` RPC racing `session/set_mode`.

## Acceptance Criteria

### US-001

- [unit] `isClosing()` on a new server session returns `false`.
- [unit] `isClosing()` returns `true` right after `close()` is called during a switch whose `open` is still pending.
- [unit] `close()` called while `switchTo`'s `open` is pending is still unresolved after a `waitForCondition` on the old session's `closed()` (probed by racing it against an already-resolved marker).
- [unit] Once the gated `open` resolves with session `b`, that `close()` resolves and `b.closed()` is `true`.
- [unit] That `switchTo` rejects with a `RequestError` whose message contains `session is closed`.
- [unit] After both settle, `prompt` rejects with a `RequestError` whose message contains `session is closed`.
- [unit] After both settle, `isClosed()` returns `true`.
- [unit] `close()` during a switch whose `open` rejects and whose `restore` resolves with session `c` closes `c`.
- [unit] That `switchTo` rejects with a message containing `session is closed`, not the open error.
- [unit] `close()` during a switch whose `open` and `restore` both reject resolves.
- [unit] In that case `switchTo` rejects with a message containing `session is closed`, not the open error.
- [unit] In that case the old session's `close` is called exactly once (by the switch), counted by wrapping `session.close`.
- [unit] Two `close()` calls during one pending switch both stay unresolved while the `open` is pending, and both resolve once it settles.
- [unit] In that case the replacement session's `close` is called exactly once.
- [unit] `switchTo` called after `close()` rejects with a message containing `session is closed`.
- [unit] That `switchTo` never calls its `open` callback.
- [unit] `close()` on a server session left dead by a switch whose `open` and `restore` both failed, with no close requested during it, resolves at once and makes `isClosing()` return `true`.
- [unit] `close()` with no switch in flight on a live session still closes the current S3 session and resolves (unchanged behaviour).

### US-002

- [unit] With `setupRegistry` gating only the second `openSession` (`openGateFrom: 2`), `registry.close(id)` called while `registry.setMode(id, "full")` waits on that open leaves `registry.find(id)` `undefined` after both settle.
- [unit] In that race the session's `<id>.lock` file still exists after `close` was called and before the gated open is released.
- [unit] In that race the session's `<id>.lock` file is absent after both settle.
- [unit] In that race the lock is released exactly once (`releases()` equals 1).
- [unit] In that race `registry.setMode` rejects with a message containing `session is closed`.
- [unit] In that race the replacement fake session (the second opened) reports `closed()` `true`.
- [unit] In that race the session's metadata file keeps the pre-switch mode `ask`.
- [unit] `registry.delete(id)` called during the same gated `setMode` leaves no metadata file for `id` after both settle.
- [unit] That delete leaves `registry.find(id)` `undefined`.
- [unit] `registry.closeAll()` called during the same gated `setMode` (the helper's `shutdownWaitMs` is 50) resolves while the open is still gated, and the session's `<id>.lock` file still exists at that point.
- [unit] Once that gated open is released and the switch settles, `registry.find(id)` is `undefined` and the `<id>.lock` file is absent (checked with `waitForCondition`).
- [unit] That shutdown releases the lock exactly once (`releases()` equals 1).
- [unit] `registry.close(id)` during a gated `setConfigOption(id, "model", "anthropic/claude-haiku-4-5")` leaves `registry.find(id)` `undefined` after both settle.
- [unit] `registry.close(id)` during a gated `setMode` whose second and third opens both fail (`failOpens: [2, 3]`, `openGateFrom: 2`) leaves `registry.find(id)` `undefined` after both settle.
- [unit] That race releases the lock exactly once (`releases()` equals 1).
- [integration] Through `buildAgentApp` and an ACP SDK client, a `session/set_mode` whose replacement open is gated, overlapped by `session/close` for the same session, leaves the registry's `find(sessionId)` `undefined` after both settle.
- [integration] In that RPC race the `session/close` request resolves only after the gated open is released.
- [integration] In that RPC race the `session/set_mode` request rejects with an error whose message contains `session is closed`.
- [integration] In that RPC race the replacement fake session reports `closed()` `true`.
- [integration] After that RPC race, a `session/prompt` for the same session rejects with a resource-not-found error (`RequestError.resourceNotFound`).
- [integration] Through `buildAgentApp`, a gated `session/set_config_option` with `configId` `model` and value `anthropic/claude-haiku-4-5` overlapped by `session/close` leaves the registry's `find(sessionId)` `undefined` after both settle.
