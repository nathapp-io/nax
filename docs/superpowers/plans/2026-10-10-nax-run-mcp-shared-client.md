# nax run's MCP client onto the shared `@nathapp/nax-agent/mcp` layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `packages/nax/src/mcp/client.ts`'s private SDK wrapping with `connectMcp()` from `@nathapp/nax-agent/mcp`, so nax and the nax-agent ACP server share one MCP client (issue #2416).

**Architecture:** The shared layer (S5-5a, already merged) owns stdio connect with env overlay, piped/drained stderr, connect timeout, paginated `tools/list`, cancellable `tools/call`, byte-capped result-to-text, and close with a kill grace. nax's `client.ts` becomes a thin adapter that calls `connectMcp()` and reshapes the shared connection into nax's own `McpConnection` vocabulary (`serverId`/`workdir`/`pid`/`listTools()`/`callTool()` with `bytesPreTruncation`). `McpPool`, `lock.ts`, `provider.ts` and stage wiring are untouched. One gap closes first: the shared connection does not expose the child `pid`, which nax's pool needs for its PidRegistry.

**Tech Stack:** TypeScript strict (ESM), Bun 1.4.0 + `bun:test` for nax, vitest on Node for nax-agent runtime contracts, Biome, `@modelcontextprotocol/sdk` (imported only inside nax-agent after this refactor).

**Spec:** GitHub issue #2416; design `docs/superpowers/specs/2026-10-09-s5-5-mcp-bridge-design.md` §3.1 (ruling R5-5.5 kept this move out of S5-5).

## Global Constraints

- Runtime: Bun 1.4.0. nax src uses Bun-native APIs; **nax-agent src must not** (`bun run check:no-bun-apis`).
- No `any` without justification; `as never` is lint-banned repo-wide; Biome runs `--error-on-warnings`.
- External calls go through `_*Deps` seams; errors are `NaxError` with code, `{ stage, cause }` context.
- Conventional commits, one concern per commit.
- Never run bare `bun test`; run package commands from the package directory. Targeted: `bun test test/unit/mcp/<file>.test.ts --timeout=60000` (nax) / `bun test ./test/unit/mcp/<file>.test.ts --timeout=60000` (nax-agent).
- Versions and lockstep pins untouched; `@nathapp/nax-agent` stays a **devDependency** of nax (bundled into `dist/nax.js` by `check:bundle-externals`' contract, never shipped as a runtime dep).
- `@modelcontextprotocol/sdk` **stays** in nax's `package.json` — `test/fixtures/mcp/fake-server.ts` still imports it. No manifest changes in this refactor.
- nax-agent's API snapshot (`api/nax-agent.api.txt`) is regenerated only via `bun run api:update`, never hand-edited; `./mcp` exports are part of the snapshot.
- Deliberate, accepted deltas vs today (the issue's "behaviour unchanged" covers tool names, lock checks, stage attachment — not error-message prefixes or result-text rendering, which the shared layer now owns):
  - Connect-failure text becomes `MCP server "<id>" failed to connect at <workdir>: McpConnectError: MCP connect failed: <reason>` (was `…: Error: <reason>`); the shared layer may append a stderr tail.
  - Tool result text follows the shared renderer: parts join with `\n\n`, non-text placeholders read `[image omitted: <mime>]`, and `structuredContent` prints when no text item exists.

## Review Focus

1. **A result that trips maxBytes** — the shared renderer caps then appends `\n[truncated: N bytes in total]`, so its text can exceed the cap; nax's contract is `content ≤ maxBytes`, so the adapter re-caps. Pinned in Task 3 (unit: ≤100 bytes, `bytesPreTruncation` 5000) and Task 4 (integration: ≤1000 bytes, 500 000).
2. **A server that dies between connect and the first call** — shared `call` rejects with `McpCallError`; pool converts to error-as-data and the advertised tool set is unchanged for the hop (R9). Pinned in Task 3 (failure.test) and Task 4 (integration die-on-call).
3. **`tools/list` failing or paginating at connect** — now inside `connectMcp()`; failure surfaces as `McpConnectError` → `NaxError` naming the server, pool retries then degrades, and the shared layer closes the half-open transport (no orphan). Pinned in Task 3 (pool.test re-expressed) and Task 4 (nax-agent's own pagination tests).
4. **Env overlay keeping `PATH`** (old client.ts trap 1) — now the shared layer's job. Pinned by nax-agent's existing `connect-stdio` overlay test plus nax's integration test passing `FAKE_MCP_*` vars; both must stay green (run, don't rewrite).
5. **pid lifecycle** — every real stdio pid registered and unregistered on pool close; `pid: null` (HTTP or pre-start) skips the registry. Pinned in Task 1 (real pid exposure) and Task 3 (pool.test registry case).

---

### Task 1: nax-agent — expose `pid` on the shared MCP connection

**Files:**
- Modify: `packages/nax-agent/src/mcp/types.ts` (`McpConnection` interface)
- Modify: `packages/nax-agent/src/mcp/connect.ts` (`liveConnection`)
- Test: `packages/nax-agent/test/unit/mcp/connect-stdio.test.ts`
- Modify (generated): `packages/nax-agent/api/nax-agent.api.txt`

**Interfaces:**
- Consumes: existing `TransportHandle.pid(): number | null` (`#src/mcp/transport`).
- Produces: `McpConnection.pid: number | null` — the stdio child pid, `null` for HTTP; readable as a getter so it tracks the transport. Task 3's adapter relies on exactly this name and type.

- [ ] **Step 1: Write the failing test** in `packages/nax-agent/test/unit/mcp/connect-stdio.test.ts`, matching the file's real-fixture style:

```ts
test("exposes the stdio child pid on the connection", async () => {
  const connection = await connectMcp(stdio(), OPTS);
  const pid = await pidOf(connection);
  try {
    expect(connection.pid).toBe(pid);
  } finally {
    await connection.close().catch(() => undefined);
    killQuietly(pid);
  }
}, 20_000);
```

Do not assert `pid` after `close()` — the SDK may null it once the transport closes; nax reads pid before close.

- [ ] **Step 2: Run test to verify it fails**

Run (from `packages/nax-agent`): `bun test ./test/unit/mcp/connect-stdio.test.ts --timeout=60000`
Expected: FAIL — `McpConnection` has no `pid` (type error / `undefined`).

- [ ] **Step 3: Implement** — add `readonly pid: number | null` to `McpConnection` in `types.ts` (doc comment: "stdio child pid; null for HTTP"), and in `connect.ts`'s `liveConnection` return object add:

```ts
get pid() {
  return handle.pid();
},
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `packages/nax-agent`): `bun test ./test/unit/mcp/connect-stdio.test.ts --timeout=60000`
Expected: PASS (all cases in the file).

- [ ] **Step 4: Run the whole shared-layer mcp suite to verify it passes**

Run (from `packages/nax-agent`): `bun test ./test/unit/mcp/ --timeout=60000`
Expected: PASS — not just the new case: this catches any other test that pins the connection's shape exhaustively (`connect.test.ts`, `connect-http.test.ts`, `errors.test.ts`).

- [ ] **Step 5: Regenerate the API snapshot and run the package gates**

```bash
bun run api:update && bun run check:api
```

Commit the `api/nax-agent.api.txt` diff. Then `bun run typecheck && bun run lint` — both green.

- [ ] **Step 6: Commit**

```bash
git add packages/nax-agent/src/mcp/types.ts packages/nax-agent/src/mcp/connect.ts packages/nax-agent/test/unit/mcp/connect-stdio.test.ts packages/nax-agent/api/nax-agent.api.txt
git commit -m "feat(nax-agent): expose the stdio child pid on shared MCP connections"
```

---

### Task 2: nax — the package-boundaries gate admits `@nathapp/nax-agent/mcp`

**Files:**
- Modify: `packages/nax/scripts/check-package-boundaries.ts:60` (`NAX_ALLOWED_AGENT_SPECS`) and its header comment (lines 12–13)
- Test: `packages/nax/test/unit/scripts/check-package-boundaries.test.ts`

**Interfaces:**
- Produces: nax `src/` and `test/` may import exactly `@nathapp/nax-agent/mcp` (and still `.` / `./internal`); any deeper subpath (e.g. `@nathapp/nax-agent/mcp/nope`) stays rejected, because membership is an exact-string check.

- [ ] **Step 1: Write the failing tests** in `check-package-boundaries.test.ts`, next to the existing nax cases (reuse the harness those cases use — a synthetic tree passed to `findBoundaryViolations`):

```ts
// allowed: nax src may import the shared MCP layer
'import { connectMcp } from "@nathapp/nax-agent/mcp";\n' -> no violation for packages/nax/src/ok.ts
// still rejected: a deep path under ./mcp
'import { x } from "@nathapp/nax-agent/mcp/nope";\n' -> violation with why matching /only @nathapp\/nax-agent/
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `packages/nax`): `bun test test/unit/scripts/check-package-boundaries.test.ts --timeout=60000`
Expected: FAIL — the allowed case reports `only @nathapp/nax-agent or @nathapp/nax-agent/internal`.

- [ ] **Step 3: Implement** in `check-package-boundaries.ts`:

```ts
const NAX_ALLOWED_AGENT_SPECS = new Set([AGENT, `${AGENT}/internal`, `${AGENT}/mcp`]);
```

Update the header bullet (lines 12–13) to "`@nathapp/nax-agent`, `@nathapp/nax-agent/internal` or `@nathapp/nax-agent/mcp`". If any existing test pins the old rejection message text verbatim, update it to the new join (`"only @nathapp/nax-agent or @nathapp/nax-agent/internal or @nathapp/nax-agent/mcp"`).

- [ ] **Step 4: Run test to verify it passes**

Run (from `packages/nax`): `bun test test/unit/scripts/check-package-boundaries.test.ts --timeout=60000 && bun run check:package-boundaries`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/scripts/check-package-boundaries.ts packages/nax/test/unit/scripts/check-package-boundaries.test.ts
git commit -m "chore(nax): allow nax to import @nathapp/nax-agent/mcp"
```

---

### Task 3: nax — swap `client.ts` onto the shared layer and move the unit fakes to the new seam

**Files:**
- Modify: `packages/nax/src/mcp/client.ts` (full rewrite, ~153 → ~70 lines)
- Modify: `packages/nax/test/unit/mcp/client.test.ts`
- Modify: `packages/nax/test/unit/mcp/pool.test.ts` (fake only; assertions keep their intent, one test re-expressed)
- Modify: `packages/nax/test/unit/mcp/failure.test.ts` (fake only)
- Modify: `packages/nax/test/unit/mcp/one-connection-per-worktree.test.ts` (fake only)
- Untouched: `pool.ts`, `lock.ts`, `provider.ts`, `rollup.ts`, `types.ts`, `index.ts`, `test/integration/mcp/stdio-server.test.ts`

**Interfaces:**
- Consumes: `connectMcp(config: McpTransportConfig, opts: ConnectMcpOptions): Promise<McpConnection>`, `McpConnectError`, and shared types from `@nathapp/nax-agent/mcp` (Task 1's `pid`; `tools: readonly McpToolInfo[]` fetched at connect; `call(name, input, { signal, timeoutMs, maxBytes }) → { text, isError, bytesBeforeCap }`; idempotent `close()`).
- Produces (unchanged signature): `connectMcpServer(args: { serverId: string; workdir: string; command: string; args: readonly string[]; env: Record<string, string>; connectTimeoutMs: number }): Promise<McpConnection>` (nax's own type from `./types`). New test seam: `_mcpClientDeps: { connect: typeof connectMcp }` (replaces `createTransport`/`createClient`).

**Seam-contract notes for the fake rewrites (all four test files):**
- The fake implements the SHARED connection shape `{ kind: "stdio"; pid; tools; call; onClose; close }`, so counting changes meaning: spawns are counted in `connect(config)` via `config.cwd`, closes in the fake connection's `close()`.
- `tools/list` now happens inside `connect`. The old "connect succeeded, then listTools failed → pool reaps" path no longer exists: a tools/list failure rejects `connectMcpServer` with the shared layer having already closed the transport, so pool's `connection` stays `undefined` and the retry path handles it. (Pool's defensive reap branch in its catch becomes unreachable but stays, per the issue's "keep McpPool as-is".) Orphan protection for failed connects is pinned by nax-agent's connect tests.
- Content-join rendering tests move out of client.test.ts: the fake returns already-rendered shared results; rendering itself is pinned by nax-agent's `result-text.test.ts` and nax's integration test.

- [ ] **Step 1: Rewrite `client.test.ts` fakes and assertions to the new seam**

Fake (declared with `import type { McpConnection as SharedConnection } from "@nathapp/nax-agent/mcp"`):

```ts
function fakeShared(over: {
  pid?: number | null;
  tools?: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  call?: (name: string) => { text: string; isError: boolean; bytesBeforeCap: number };
  connect?: (config: unknown, opts: unknown) => Promise<SharedConnection>; // set to reject
}) { /* assign _mcpClientDeps.connect, return the connection + a closed[] recorder */ }
```

Keep these cases (same names where possible) with these exact assertions:
1. `exposes the transport pid` — fake `pid: 4242` → `conn.pid === 4242`.
2. `maps tool descriptors, defaulting a missing description` — fake `tools: [{ name: "search_graph", description: "Search", inputSchema: { type: "object" } }, { name: "bare", inputSchema: {} }]` → same name list, `"Search"`, `""`.
3. `maps the shared call result onto nax's vocabulary` (replaces the content-join test) — fake `call` returns `{ text: "a", isError: false, bytesBeforeCap: 27 }` → `callTool` returns `{ content: "a", isError: false, bytesPreTruncation: 27 }`.
4. `carries the server's isError through as data` — fake `{ text: "boom", isError: true, bytesBeforeCap: 4 }` → `{ isError: true, content: "boom" }`.
5. `truncates to maxBytes and reports the pre-truncation size` — fake `{ text: "x".repeat(5000), isError: false, bytesBeforeCap: 5000 }`, `maxBytes: 100` → `Buffer.byteLength(result.content, "utf8") <= 100` and `result.bytesPreTruncation === 5000` (the adapter's own re-cap — Review Focus 1).
6. `a rejecting connect() surfaces as a NaxError naming the server` — fake `connect` throws `new Error("ENOENT")` → `rejects.toThrow(/memory/)` AND `rejects.toMatchObject({ code: "MCP_CONNECT_FAILED" })`.
7. `close() closes the shared connection` — recorder gains `"connection"`.
8. NEW `hands the shared layer a stdio config and nax's client info` — capture `(config, opts)` in the fake; expect `config` to deep-equal `{ kind: "stdio", command: "fake", args: [], env: {}, cwd: "/w" }` and `opts.timeoutMs === 1000`, `opts.clientInfo` `{ name: "nax", version: "1" }`.

- [ ] **Step 2: Rewrite the fakes in `pool.test.ts`, `failure.test.ts`, `one-connection-per-worktree.test.ts`** per the seam-contract notes:

- `pool.test.ts` `fakeSdk`: one `connect` that counts attempts (gate, `failFirst`), allocates `nextPid`, records `{ cwd: config.cwd, pid }` in `spawns`, and returns a canned connection (`tools: [{ name: "t", … }]`, `call` → `{ text: \`ran ${name}\`, isError: false, bytesBeforeCap: … }`, `close` records the pid in `closes`). `listToolsFails` disappears; instead re-express its test as:

```ts
test("a failed connect retries, registers only the surviving connection, leaves no orphan", async () => {
  // fakeSdk({ failFirst: 1 }), retry { maxAttempts: 2, baseDelayMs: 0 }, pidRegistry recorder
  // → listTools returns ["t"], spawns.length === 2, closes.length === 0 (nothing handed back to reap),
  //   unregistered is [] before pool.close() and equals registered after it.
});
```

The trust-gate tests (AC12–AC15) keep their assertions; AC13 counts `connect` invocations instead of `createTransport`. The pid-registry case (Review Focus 5) and the MEM-5 timer case keep their assertions verbatim — only the fake changes.

- `failure.test.ts` `sdk`: connection with `call` honouring `onCall` (throw → error-as-data; never-resolving promise → pool deadline; both ignore the signal argument). First test's fake rejects `connect` with `new Error("spawn ENOENT")`. The R9 case keeps: two runs, `calls === 2`, both error-as-data.
- `one-connection-per-worktree.test.ts` `fakeMcpClient`: count `connect(config)` calls, record `config.cwd`, return the canned `search_graph` connection.

- [ ] **Step 3: Run the rewritten tests to verify they fail**

Run (from `packages/nax`): `bun test test/unit/mcp/client.test.ts test/unit/mcp/pool.test.ts test/unit/mcp/failure.test.ts test/unit/mcp/one-connection-per-worktree.test.ts --timeout=60000`
Expected: FAIL — `_mcpClientDeps.connect` is still the old `{ createTransport, createClient }` implementation (no `connect` member).

- [ ] **Step 4: Rewrite `src/mcp/client.ts` as the adapter**

```ts
import { connectMcp as connectSharedMcp, type ConnectMcpOptions, type McpTransportConfig } from "@nathapp/nax-agent/mcp";
import type { JSONSchema } from "@/context/engine";
import { NaxError } from "@/errors";
import type { McpConnection } from "./types";

/** Injectable seam (mirrors the ACP bridge's `connect` dep): unit tests fake the shared layer here. */
export const _mcpClientDeps: { connect: typeof connectSharedMcp } = { connect: connectSharedMcp };

export async function connectMcpServer(args: { /* unchanged signature */ }): Promise<McpConnection> {
  const config: McpTransportConfig = { kind: "stdio", command: args.command, args: args.args, env: args.env, cwd: args.workdir };
  const opts: ConnectMcpOptions = {
    signal: new AbortController().signal, // no cancellation source in nax run; connect is bounded by timeoutMs
    timeoutMs: args.connectTimeoutMs,
    clientInfo: { name: "nax", version: "1" },
  };
  const shared = await _mcpClientDeps.connect(config, opts).catch((error: unknown) => {
    throw new NaxError(
      `MCP server "${args.serverId}" failed to connect at ${args.workdir}: ${String(error)}`,
      "MCP_CONNECT_FAILED",
      { stage: "tools", cause: error },
    );
  });
  return {
    serverId: args.serverId,
    workdir: args.workdir,
    get pid() { return shared.pid; },
    listTools() { return Promise.resolve(shared.tools); }, // structurally identical to McpToolDescriptor (same JSONSchema re-export)
    async callTool(name, input, callOpts) {
      const result = await shared.call(name, input, {
        signal: AbortSignal.timeout(callOpts.timeoutMs), // SDK-level cancellation under the pool's own deadline race
        timeoutMs: callOpts.timeoutMs,
        maxBytes: callOpts.maxBytes,
      });
      return {
        content: truncateToBytes(result.text, callOpts.maxBytes), // keep nax's hard ceiling; shared text may carry a truncation notice past the cap
        isError: result.isError,
        bytesPreTruncation: result.bytesBeforeCap,
      };
    },
    close: () => shared.close(),
  };
}
```

Keep `truncateToBytes` verbatim from today's file. Delete: SDK imports, `McpClientLike`, `toDescriptors`, `renderContent`, `_mcpClientDeps.createTransport/createClient`. Rewrite the header comment: the env-overlay and piped-stderr traps now live in the shared layer (`@nathapp/nax-agent/mcp`); the adapter adds only nax's vocabulary, the hard byte re-cap, and the `NaxError` wrap.

- [ ] **Step 5: Run the mcp unit suite to verify it passes**

Run (from `packages/nax`): `bun test test/unit/mcp/ --timeout=60000`
Expected: PASS (all five files: client, pool, failure, one-connection-per-worktree, lock, provider, rollup, acp-exclusion).

- [ ] **Step 6: Typecheck and lint**

Run (from `packages/nax`): `bun run typecheck && bun run lint`
Expected: both green (boundaries gate from Task 2 admits the import; file-size/complexity gates pass on the smaller client.ts).

- [ ] **Step 7: Commit**

```bash
git add packages/nax/src/mcp/client.ts packages/nax/test/unit/mcp/client.test.ts packages/nax/test/unit/mcp/pool.test.ts packages/nax/test/unit/mcp/failure.test.ts packages/nax/test/unit/mcp/one-connection-per-worktree.test.ts
git commit -m "refactor(nax): move nax run's MCP client onto @nathapp/nax-agent/mcp"
```

---

### Task 4: prove `nax run` behaviour unchanged end-to-end, then full gates

**Files:**
- No source changes expected. If a coverage baseline must move, commit it separately.

**Interfaces:**
- Consumes: Tasks 1–3 merged in the working tree.

- [ ] **Step 1: Run the real-stdio integration suite unchanged**

Run (from `packages/nax`): `bun test test/integration/mcp/stdio-server.test.ts --timeout=60000`
Expected: PASS with **zero edits to the file** — tool discovery, per-workdir cwd answers, die-on-call error-as-data, hang bounded by timeoutMs, big result truncated to maxBytes with `resultBytesPreTruncation === 500_000`, and the lock-withholding case. This is the behaviour-unchanged proof (Review Focus 1, 2, 4).

- [ ] **Step 2: Run nax's remaining gates**

```bash
bun run build && bun run typecheck && bun run check:all && bun run test && bun run test:coverage
```

Expected: all green. `check:bundle-externals` must still report nax-agent (now including its `mcp/` submodule and the SDK) bundled into `dist/nax.js`. If `test:coverage` moves a per-file floor for the rewritten `client.ts`, run `bun run test:coverage:update` and commit the baseline as its own commit (`chore(nax): update coverage baseline for the shared-layer MCP client`).

- [ ] **Step 3: Run nax-agent's gates** (its `mcp/` module changed in Task 1)

```bash
cd packages/nax-agent && bun run check:all && bun run test
```

Expected: green, including the `./mcp` entry-isolation and API-snapshot checks. (CI additionally runs `bun run test:node` — the vitest real-Node contracts and packed-tarball smoke; it is slow, so this task leaves it to CI.)

- [ ] **Step 4: Commit any baseline drift** (only if Step 2 produced one), else no commit.

```bash
git add -A && git commit -m "chore(nax): update coverage baseline for the shared-layer MCP client"
```
