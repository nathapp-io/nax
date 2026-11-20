# SPEC: mcp-pool-reconnect — evict a run-scoped MCP connection whose stdio server exited, reconnect on next use within a bounded budget, and retry the interrupted call once

Closes: #3002

## Summary

The run-scoped MCP pool (`packages/nax/src/mcp/pool.ts`) caches one connection per (serverId, workdir) for the whole run and never replaces it. When a stdio MCP server exits mid-run, every later call to that server fails with `the connection is closed` until the run ends. This feature listens for the shared layer's exit report, evicts the dead connection, reconnects on the next use through the existing `open()` path, retries the call that the exit interrupted once on the new connection, and caps reconnects at `MCP_MAX_RECONNECTS = 3` per (serverId, workdir) per run. A new `disconnected` pool event makes each eviction visible in the run rollup and in chat `/mcp`.

## Motivation

Issue #3002. Two concurrent runs on one machine lost a stdio MCP server whose backend restarted: run A's calls failed from 09:27Z to the end of the run (4 stories), run B's from 08:11Z to the end, with `McpCallError: MCP call search_graph failed: the connection is closed` on every call. Neither nax process still had a child process for the server; fresh sessions connected to it without problems. Agents fell back to grep and file reads, so the runs completed, but the configured tools were silently lost for hours and each attempt cost a tool call and an error round trip.

The cause is in the pool: `call()` turns the `callTool` rejection into error-as-data and leaves the dead `Entry` in `entries`, so every later `entry()` returns the same closed connection. `connect-failed` caching (spec R8: a wedged server costs its attempt budget once per run) is deliberate; a server that connected and died later is a different case that nothing handles.

The shared layer already reports the exit. `liveConnection` in `packages/nax-agent/src/mcp/connect.ts` sets `life.exited` from the SDK's `client.onclose` and calls every `onClose(listener)` registered on the connection (stdio only, never after a `close()` the caller asked for, and once even when the exit happened before anyone listened). nax's adapter in `packages/nax/src/mcp/client.ts` never exposes `onClose`, so the pool cannot see it.

## Design

### Integration

The baseline listings below exist only to locate the code. They are never the interface to implement; implement the Target.

Read only:

- `packages/nax-agent/src/mcp/types.ts` — shared `McpConnection.onClose(listener: (reason: string) => void): void`: "stdio only: called once when the process exits without close() having been called". The shared `call()` rejects with `McpCallError("MCP call <name> failed: the connection is closed")` once `life.exited` is set.
- MCP SDK `Protocol._onclose` (`@modelcontextprotocol/sdk` 1.32.1, `dist/esm/shared/protocol.js:252`) calls `this.onclose?.()` BEFORE it rejects the pending response handlers with `ConnectionClosed`. So by the time a call's rejection reaches the pool, the pool's `onClose` listener for that connection has already run. The same holds for a call made after the exit: the shared `call()` checks `life.exited`, which is set in the same handler that notifies listeners.
- `packages/nax/src/mcp/pool.ts` — `redactMcpReason(text, server)`, `MCP_DEFAULT_RETRY`, `PidRegistryLike`.
- `createMcpPool` callers, unchanged: `packages/nax/src/runtime/index.ts:333` (nax run), `packages/nax/src/chat/chat-mcp.ts:127` (chat, `CHAT_MCP_RETRY` = 1 attempt), `packages/nax/src/memory/host.ts:276`, `packages/nax/src/cli/mcp.ts:71`.

Changed:

- `packages/nax/src/mcp/types.ts` `McpConnection`
  - Baseline: `serverId`, `workdir`, `pid`, `instructions?`, `listTools()`, `callTool(name, input, opts)`, `close()`.
  - Target: adds `onClose(listener: (reason: string) => void): void`, with the shared semantics above.
- `packages/nax/src/mcp/client.ts` `connectMcpServer`
  - Baseline: the returned object omits `onClose`.
  - Target: the returned object has `onClose: (listener) => shared.onClose(listener)`.
- `packages/nax/src/mcp/pool.ts` `McpServerEvent`
  - Baseline: union of `connected`, `connect-failed`, `closed`.
  - Target: adds `{ readonly kind: "disconnected"; readonly reason: string; readonly reconnect: boolean }` (with the shared `serverId`, `workdir`, `at`).
- `packages/nax/src/mcp/pool.ts`: new export `MCP_MAX_RECONNECTS = 3`.
- `packages/nax/src/mcp/pool.ts` `createMcpPool` internals (`open`, `entry`, `call`, `close`): see Approach.
- `packages/nax/src/mcp/rollup.ts` `McpServerSummary`
  - Baseline: `{ serverId, workdirs, connected, failed, toolsAdvertised }`.
  - Target: `{ serverId, workdirs, connected, failed, disconnected, toolsAdvertised }`, where `disconnected` counts `disconnected` events for the server.
- `packages/nax/src/chat/chat-mcp-listing.ts` `status()`: a latest non-`closed` event of kind `disconnected` renders `disconnected: <reason>`. Today it falls through to `not connected`.

Patterns to follow: the pool's existing error-as-data results (never throw into the turn loop), its `record()` + `getSafeLogger()?.warn("mcp", "[pool] ...")` pairing, and the `fakeSdk` / `cannedConnection` fake shape in `packages/nax/test/unit/mcp/pool.test.ts` (file-local; the new tests use a shared helper instead). The new tests use the shared fake described in § Testing notes.

### Approach

1. **Listen.** In `open()`, after a connection is connected, `tools/list` succeeded and the `connected` event has been recorded, the pool registers an `onClose` listener on it and keeps the pid it read at connect time. The listener is registered after `record(connected)` so that an exit reported synchronously from inside `onClose` (an exit that happened before the pool listened) is always recorded after the `connected` event, and chat `/mcp`, which shows the latest event, never shows a dead server as connected. The pool tracks, per live connection, whether that connection reported a close.
2. **Identify the entry.** `entry()` stores the open promise in `entries` synchronously, before `open()` reaches its first `await` (`assertTrusted`), so by the time the listener can fire, `entries.get(key)` holds the promise that this `open()` call produced, even when the exit is reported synchronously while `open()` has not yet returned. The pool keeps, per key, a token identifying the `open()` call whose result is current, and the listener evicts only while its own token is still current for the key. A listener belonging to a connection that was already replaced never touches the key.
3. **Evict.** When the listener fires, its token is current, and the pool is not closed:
   - Synchronously, before any `await`, the pool counts one disconnect for the (serverId, workdir) key and either removes the key from `entries` (count at most `MCP_MAX_RECONNECTS`; the next `entry()` call runs `open()` again with its full `retry.maxAttempts` budget) or pins it to "unavailable" for the rest of the run (count above `MCP_MAX_RECONNECTS`; the same cached-`undefined` state a failed connect leaves, spec R8). In the same synchronous step it records `disconnected` with `reconnect: true` or `reconnect: false`, with the reason passed through `redactMcpReason`. The eviction is also logged at warn level as `[pool] <serverId> disconnected`.
   - The same synchronous step clears the key's current open token, so a repeated exit report from the evicted connection, before or after the key reconnects, is ignored.
   - Then, asynchronously, it calls the dead connection's `close()` once (reaping the transport) and, when the connect-time pid is non-null, passes it to `pidRegistry.unregister` (the live `pid` getter may already read null). Each of these has its rejection swallowed, as on the existing connect-failure path, so a failing cleanup never strands the key.
4. **Retry once.** In `call()`, when `callTool` rejects AND the connection it was sent on has reported a close, the pool runs the call once more through `entry()` (so it reconnects, or reads the pinned-unavailable state) with the same tool name, input and options. The retried call gets its own `timeoutMs` deadline. It is never retried again, whatever it returns. A rejection on a connection that has NOT reported a close keeps today's result, `MCP server "<id>" is unavailable: <detail>`, with no eviction and no retry. A deadline result (`exceeded <timeoutMs>ms`) is not a rejection and keeps today's behaviour. This single re-dispatch is pool-internal, like the pool's existing connect retry loop; it is not an agent dispatch-tier retry.
5. **Concurrency.** Two calls in flight on one connection that exits both retry through `entry()`, whose memoized open promise gives them one new connection. The exit is counted once, because the shared layer reports it once. The `pool.ts` header comment, which says one hop never has two calls in flight against one server, is updated to say that concurrent callers on one key can exist (several hops, chat) and that a disconnect retries them through one reconnect.

Budget arithmetic: a key may connect at most `1 + MCP_MAX_RECONNECTS` = 4 times successfully in a run. Each `open()` may itself spend up to `retry.maxAttempts` connect attempts. A reconnect whose attempts all fail is cached as unavailable like any failed connect, and does not count as a disconnect.

### Testing notes

- The shared-connection fake lives in a new helper `packages/nax/test/helpers/mcp-fake-connection.ts`, whose factory `makeFakeMcpConnection(overrides?)` is exported from the `test/helpers` barrel (`.nax/rules/test-helpers.md` and `forbidden-patterns-tests.md` forbid copy-pasted mock setup across test files). It returns a fake shared `McpConnection` whose `onClose` captures the listener, which a test fires through an `exit(reason)` control; whose `call` resolves `ran <name>` with its pid until the exit, then rejects with `MCP call <name> failed: the connection is closed`, as the real `life.exited` check does; which can be told to report the exit synchronously from inside `onClose` (an exit before the pool listened) or to hold a `call` open until released; whose `pid` reads null after the exit; and which counts `close()` calls. Its controls are `exit(reason)`, `release()` (settle held calls normally) and `closeCount`. `exit(reason)` follows the SDK order: it sets the exited state, invokes the captured listener synchronously, and only then rejects every held call with `MCP call <name> failed: the connection is closed`. Each fake connection is an independent instance with its own pid, exited state and `closeCount`, so a test can count closes per connection.
- The asynchronous cleanup (`close()`, `unregister`) is awaited with `waitForAsyncCondition` from `test/helpers`, never a fixed sleep.
- The deadline case uses a `call` held open by the fake and a small `timeoutMs`, as the existing deadline test in `pool.test.ts` does.

### Failure Handling

| Situation | Behaviour |
|:---|:---|
| stdio server exits while no call is in flight | Evicted on the exit report; next call reconnects (US-001) |
| stdio server exits during a call | That call is retried once on a new connection (US-003) |
| Retried call's connection also exits | No second retry; returns `MCP server "<id>" is unavailable: <detail>` (US-003) |
| Reconnect fails every connect attempt | Call returns `MCP server "<id>" is unavailable; its tools cannot be called for this hop.`; key cached unavailable (US-003) |
| More than `MCP_MAX_RECONNECTS` exits on one key | Key pinned unavailable, `disconnected` with `reconnect: false` (US-002) |
| Exit reported after `pool.close()` | Ignored: no event, no reconnect (US-002) |
| `callTool` rejects with the connection still open | Unchanged: error-as-data, no eviction, no retry (US-002, US-003) |
| Call exceeds the pool deadline | Unchanged: `exceeded <timeoutMs>ms` result, no eviction (US-002) |
| `close()` of the dead connection or `unregister` rejects | Swallowed, as on the existing connect-failure path; eviction still completes (US-001) |
| Exit reported synchronously while `open()` registers the listener | Evicted like any exit; `disconnected` recorded after `connected` (US-001) |

## Out of Scope

- Streamable-HTTP MCP servers: the shared layer reports exits for stdio connections only, so an HTTP connection that closes keeps today's error-as-data behaviour with no eviction or retry.
- Making the retried call idempotent: a call cut off mid-flight may already have run on the server before it exited, and the single retry runs it again (ruling 2026-11-20).
- Retrying calls that failed for any reason other than their connection reporting a close: deadlines, tool `isError` results and protocol errors on an open connection keep today's results.
- Detecting a dead server before the next call by pinging or health-checking it.
- Refreshing tool lists that providers already advertised for a hop after a reconnect: a restarted server that drops a tool answers calls to it with its own error.
- Changing `connect-failed` caching (spec R8) or the connect retry budget `MCP_DEFAULT_RETRY` / `CHAT_MCP_RETRY`.
- Making `MCP_MAX_RECONNECTS` configurable or carrying the reconnect count across runs or across `createMcpPool` instances.
- The chat welcome row's connected-server count (`packages/nax/src/tui/chat/session-transcript.ts`): it already treats any latest event other than `connected` as not connected.


## Stories

**US-001 — evict a connection whose stdio server exited and reconnect on next use (#3002).** Workdir: `packages/nax`. No dependencies. nax's `McpConnection` gains `onClose` and `connectMcpServer` forwards the shared one. `createMcpPool` registers a listener per connection after recording `connected`, identifies the current entry per key by an open token, evicts on exit (removing the key, recording `disconnected`, then reaping the dead connection and its non-null connect-time pid asynchronously), and reconnects on the next `entry()` (Design § Approach steps 1-3). US-001 keeps the per-key disconnect count but applies no cap: every exit records `reconnect: true` and removes the key; US-002 adds the cap. Adds the shared test fake `packages/nax/test/helpers/mcp-fake-connection.ts` (Design § Testing notes), exported from the `test/helpers` barrel. A call already in flight on the dead connection keeps today's error result in this story; US-003 adds the retry.

**US-002 — cap reconnects per key and pin the edges that must not evict (#3002).** Workdir: `packages/nax`. Depends on US-001 (it bounds the eviction US-001 adds). Adds the exported constant `MCP_MAX_RECONNECTS = 3`; a key whose disconnect count exceeds it is pinned unavailable and records `disconnected` with `reconnect: false`. Pins that a rejection on an open connection, a deadline result, and an exit reported after `pool.close()` neither evict nor reconnect, and that `pool.close()` after a reconnect reaps only the live connection.

**US-003 — retry the interrupted call once on a new connection (#3002).** Workdir: `packages/nax`. Depends on US-001, US-002 (it reads the per-connection close state US-001 tracks and the pinned-unavailable state US-002 adds). In `call()`, a `callTool` rejection on a connection that reported a close is retried once through `entry()`, with the same tool, input and options (Design § Approach steps 4-5). Updates the `pool.ts` header comment on in-flight calls per step 5.

**US-004 — show disconnects in the run rollup and chat `/mcp` (#3002).** Workdir: `packages/nax`. Depends on US-001 (it reads the `disconnected` event kind US-001 adds). `buildMcpRollup` gains a per-server `disconnected` count, and `formatMcpListing` renders `disconnected: <reason>`.

### Context Files

**US-001**
- `packages/nax/src/mcp/pool.ts` — `createMcpPool`, `open`, `entry`, `call`, `close`, `McpServerEvent`, `redactMcpReason`
- `packages/nax/src/mcp/client.ts` — `connectMcpServer`, `_mcpClientDeps`
- `packages/nax/src/mcp/types.ts` — nax `McpConnection`
- `packages/nax-agent/src/mcp/connect.ts` — `liveConnection` `onClose` and `call` closed-state semantics, `trackLife`
- `packages/nax/test/unit/mcp/pool.test.ts` — the file-local `fakeSdk` and `cannedConnection` shape the new helper generalises

**US-002**
- `packages/nax/src/mcp/pool.ts` — the eviction and per-key disconnect count from US-001
- `packages/nax/test/helpers/mcp-fake-connection.ts` — created by US-001, used here
- `packages/nax/test/unit/mcp/pool-reconnect.test.ts` — created by US-001; its setup pattern is followed here

**US-003**
- `packages/nax/src/mcp/pool.ts` — `call()` and the per-connection close state from US-001
- `packages/nax/test/helpers/mcp-fake-connection.ts` — created by US-001, used here

**US-004**
- `packages/nax/src/mcp/rollup.ts` — `buildMcpRollup`, `McpServerSummary`
- `packages/nax/src/chat/chat-mcp-listing.ts` — `status`, `lastOutcome`
- `packages/nax/test/unit/mcp/rollup.test.ts` — event fixtures
- `packages/nax/test/unit/chat/chat-mcp-listing.test.ts` — `lineOf` helper and event fixtures

### Creates

**US-001**
- `packages/nax/test/helpers/mcp-fake-connection.ts` — the shared fake shared-connection factory (Design § Testing notes)
- `packages/nax/test/unit/mcp/pool-reconnect.test.ts` — eviction and reconnect tests (`pool.test.ts` is 484 lines)

**US-002**
- `packages/nax/test/unit/mcp/pool-budget.test.ts` — budget and no-evict tests

**US-003**
- `packages/nax/test/unit/mcp/pool-retry.test.ts` — retry-once tests

**US-004**

None.

### Modifies

**US-001**
- `packages/nax/test/helpers/index.ts` — the barrel gains the `makeFakeMcpConnection` export from the new helper file. No existing export changes. Every existing fake of the shared connection already provides `onClose: () => {}`, which never fires, so no existing pool, client or chat test observes the new listener.

**US-002**

None. The cap only changes behaviour after a fourth exit on one key, which no existing test produces.

**US-003**

None. No existing test asserts the result of a call in flight at an exit.

**US-004**
- `packages/nax/test/unit/mcp/rollup.test.ts` — the test "answers 'was this server actually attached?' per server" asserts `rollup.servers` deep-equals objects without a `disconnected` field. Each expected summary gains `disconnected: 0`; the other fields stay as they are.

### Seams

- US-002 and US-003 build on US-001's pool internals; US-004 reads US-001's `disconnected` event kind. No new production symbol crosses a story boundary as a call. Every pool AC enters through `createMcpPool(...).call` / `.listTools` with `_mcpClientDeps.connect` faked, so the real `connectMcpServer` adapter, and its `onClose` forwarding, sits on the tested path.

## Acceptance Criteria

### US-001

1. [unit] The connection returned by `connectMcpServer`, with `_mcpClientDeps.connect` faked, calls a listener passed to its `onClose` with `"the server process exited"` when the fake shared connection reports an exit with that reason.
2. [unit] After a pool connection to stdio server `memory` at workdir `/a` reports an exit, the next `pool.call("memory", "/a", "t", ...)` makes the faked `_mcpClientDeps.connect` run a second time with `cwd` `/a`.
3. [unit] After that exit, the next `pool.call("memory", "/a", "t", ...)` returns the result produced by the second connection, with `isError` false.
4. [unit] The exit appends to `pool.events()` an event equal, apart from its `at` timestamp, to `{ kind: "disconnected", serverId: "memory", workdir: "/a", reason: "the server process exited", reconnect: true }`.
5. [unit] The recorded `disconnected` reason is passed through `redactMcpReason`: a reported reason that contains a header value configured for the server is recorded with that value replaced by `***`.
6. [unit] After the exit, the dead connection's `close()` is eventually called exactly once.
7. [unit] After the exit, the pid the connection reported at connect time is eventually passed to `pidRegistry.unregister`, even though the fake connection's `pid` reads null after the exit.
8. [unit] After an exit on a connection whose pid was null at connect time, `pidRegistry.unregister` is never called for that connection.
9. [unit] When `pidRegistry.unregister` and the dead connection's `close()` both reject, the next `pool.call` on the key still makes `_mcpClientDeps.connect` run a second time.
10. [unit] After an exit on (`memory`, `/a`), the next `pool.call("memory", "/b", ...)` uses the existing `/b` connection, and `_mcpClientDeps.connect` runs no second time for `/b`.
11. [unit] When the fake shared connection reports its exit synchronously from inside `onClose` (an exit before the pool listened), the event kinds recorded for (`memory`, `/a`) are, in order, `connected` then `disconnected`.
12. [unit] In that synchronous-exit case, after one `pool.listTools("memory", "/a")` resolves, the next `pool.call("memory", "/a", ...)` makes `_mcpClientDeps.connect` run a second time.
13. [unit] When the fake reports a second exit from the same, already-evicted connection after the key has reconnected, `pool.events()` holds one `disconnected` event for the key and `_mcpClientDeps.connect` has run twice in total.
14. [unit] When the fake reports a second exit from the same evicted connection before any call reconnects the key, `pool.events()` holds one `disconnected` event for the key.

### US-002

1. [unit] `MCP_MAX_RECONNECTS` imported from `@/mcp/pool` equals 3.
2. [unit] On one key, after each of the first three exits is followed by a pool.call that reconnects, the fourth exit records a disconnected event with reconnect: false.
3. [unit] After that fourth exit, `pool.call` on the key returns `isError` true with content `MCP server "memory" is unavailable; its tools cannot be called for this hop.`
4. [unit] After that fourth exit, two further `pool.call`s on the key leave the total `_mcpClientDeps.connect` count at 4.
5. [unit] After (`memory`, `/a`) is pinned unavailable by its fourth exit, an exit on (`memory`, `/b`) is followed by a `pool.call("memory", "/b", ...)` that returns the result of a new `/b` connection with `isError` false.
6. [unit] When `callTool` rejects on a connection that has not reported a close, the next `pool.call` on that key leaves the total `_mcpClientDeps.connect` count at 1.
7. [unit] When a call returns the pool deadline result `MCP call memory__t exceeded <timeoutMs>ms`, the next `pool.call` on that key leaves the total `_mcpClientDeps.connect` count at 1.
8. [unit] When a call returns the pool deadline result, `pool.events()` holds no `disconnected` event.
9. [unit] An exit reported after `pool.close()` resolved leaves `pool.events()` with no `disconnected` event.
10. [unit] An exit reported after `pool.close()` resolved does not call `_mcpClientDeps.connect` again.
11. [unit] `pool.close()` after one eviction and reconnect calls the new connection's `close()` exactly once.
12. [unit] `pool.close()` after one eviction and reconnect leaves the dead connection's `close()` count at 1.

### US-003

1. [unit] When the connection's `callTool` rejects after that connection reported an exit, `pool.call("memory", "/a", "t", input, opts)` returns the result of the same call on a new connection, with `isError` false.
2. [unit] The retried call reaches the new connection with tool name `t` and the same `input` values as the original call.
3. [unit] The retried call reaches the new connection with the same `timeoutMs` and `maxBytes` as the original call.
4. [unit] When the retried call's connection also reports an exit and rejects, `pool.call` returns `isError` true with content starting `MCP server "memory" is unavailable:`.
5. [unit] In that double-exit case, `_mcpClientDeps.connect` has run exactly twice when `pool.call` resolves.
6. [unit] When the reconnect fails all `retry.maxAttempts` connect attempts, the interrupted `pool.call` returns `isError` true with content `MCP server "memory" is unavailable; its tools cannot be called for this hop.`
7. [unit] When `callTool` rejects on a connection that has not reported a close, `pool.call` returns content starting `MCP server "memory" is unavailable:` and `_mcpClientDeps.connect` has run once in total.
8. [unit] Two `pool.call`s in flight on one connection that then reports an exit both return the result produced by the new connection.
9. [unit] In that two-call case, `_mcpClientDeps.connect` has run exactly twice in total.
10. [unit] When the fake shared connection reports its exit synchronously from inside `onClose`, the first `pool.call` on the key returns the result produced by a second connection, with `isError` false.
11. [unit] When the key's fourth exit interrupts an in-flight call, that call returns `isError` true with content `MCP server "memory" is unavailable; its tools cannot be called for this hop.`, and the total `_mcpClientDeps.connect` count stays at 4.
12. [unit] After the reconnect for an interrupted call fails all `retry.maxAttempts` connect attempts, a further `pool.call` on the key leaves the total `_mcpClientDeps.connect` count unchanged.

### US-004

1. [unit] `buildMcpRollup` with two `disconnected` events for server `memory` returns a `memory` summary with `disconnected: 2`.
2. [unit] `buildMcpRollup` returns `disconnected: 0` for a server with only `connected` events.
3. [unit] `formatMcpListing` renders the line of a locked server whose latest non-`closed` event is `disconnected` with reason `the server process exited` ending in `disconnected: the server process exited`.
4. [unit] `formatMcpListing` renders `connected, <toolCount> tools` for a server whose `disconnected` event is followed by a `connected` event.
