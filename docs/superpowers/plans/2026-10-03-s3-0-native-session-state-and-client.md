# S3-0 — Per-instance native session state and adapter-owned client — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the process-global native session state and the forced shared client, so many native sessions with different credentials and catalog overrides can run in one process, without changing anything nax can observe.

**Architecture:** Two PRs. S3-0a moves the ten session-name-keyed collections in `native/session/session.ts` into a `NativeSessionState` object owned by each `NativeSessionAdapter` and threaded to the loop through `TurnDeps`. S3-0b lets an adapter own its client and credential store (memory or exec source), with the module client memo kept as the default so nax builds one client as today.

**Tech Stack:** TypeScript 7.0.2, Bun 1.4 (bun:test), vitest on Node 22/24 for the Node contract suite, `@nathapp/nax-ai@0.1.16`.

**Spec:** `docs/superpowers/specs/2026-10-03-s3-conversational-session-api-design.md` (§5.2, §9 rows S3-0a and S3-0b).

## Global Constraints

- nax-visible behaviour unchanged: transcript files, stream-bus events, cost rows, auth stamps and refusal texts are byte-identical for nax.
- nax-agent ships zero Bun APIs (`check:no-bun-apis`); `node:` built-ins only in `src/`.
- Imports inside nax-agent use `#src/*` aliases and `.ts` specifiers, as the surrounding code does.
- No `_` names on `.`; `/internal` is unstable and may change (S2 D19). Run `bun run check:api` and `bun run api:update` when a surface changes.
- nax-agent coverage: 80% overall and per file, empty baseline (`bun run test:coverage`).
- Never run bare `bun test`; run package scripts from the package directory (`cd packages/nax-agent`, `cd packages/nax`).
- No emojis in code or comments. Files stay under the size gate (`check-file-sizes`); functions under the complexity gate.
- Commit messages are conventional (`refactor:`, `feat:`, `test:`).

## Review Focus

1. **A session closed through a different adapter instance than it was opened on.** Today any instance can close any session; after S3-0a the opener's state would leak and the transcript would be neither deleted nor retained. nax must open and close through one instance. Pinned by the Task 4 invariant test.
2. **Two adapters with the same session name in one process.** Each must keep its own transcript dir, owner, spin breaker and usage anchor. Pinned in Task 3.
3. **A truncation spill for a session the state does not know.** Must still fall back exactly as today (no spill path when no root is known). Pinned in Task 2.
4. **An embedder that never calls `configureCredentials` but passes a memory source.** Must build a client and stamp auth without touching the slot (which throws `CREDENTIALS_NOT_CONFIGURED`). Pinned in Task 7 and the Node case in Task 8.
5. **Two adapters with different catalog overrides in one process.** Today the second throws `NATIVE_CLIENT_OVERRIDES_MISMATCH`; with `ownClient` both must build; without it nax's mismatch error must still fire. Pinned in Task 7.

## Deviations from the spec (decided while planning)

- **Constructor shape.** The spec writes `new NativeSessionAdapter({ catalogOverrides?, credentials? })`. nax constructs it positionally (`packages/nax/src/agents/native-agent/index.ts:55`, `new NativeSessionAdapter(catalogOverrides)`), and `NativeSessionAdapter` is on the published `.` surface. To stay additive: `constructor(catalogOverrides = [], options: NativeSessionAdapterOptions = {})`. An adapter owns its client when `options.credentials` is set or `options.ownClient === true`; otherwise it uses the module memo exactly as today. The facade (S3-4) passes `ownClient: true`.
- **State accessor.** Tests reach an adapter's state through `nativeSessionStateOf(adapter)` exported from `/internal`, not a class member, so `.` gains no `_` member.
- **`AuthStamp.source` gains `"memory"`** (additive union widening on `.`), so a memory-sourced session stamps cost rows honestly.

---

## PR S3-0a — per-instance session state

Branch: `feat/s3-0a-native-session-state` from latest `main`.

### File map

| File | Change |
|---|---|
| `packages/nax-agent/src/native/session/session.ts` | Replace the ten module collections with `NativeSessionState` + `createNativeSessionState()`; lifecycle functions take the state first |
| `packages/nax-agent/src/native/session/truncation-handler.ts` | `spillRootFor`, `truncateNativeToolResult`, `createTruncationHandler` take the state |
| `packages/nax-agent/src/native/session/loop-handlers.ts` | `BuiltinLoopHandlerDeps` gains `sessionState` |
| `packages/nax-agent/src/native/session/turn-types.ts` | `TurnDeps` gains required `sessionState` |
| `packages/nax-agent/src/native/session/turn-loop.ts` | Read dir, owner, anchor from `deps.sessionState` |
| `packages/nax-agent/src/native/session/turn-loop-round-trip.ts` | Write the usage anchor to `deps.sessionState.lastUsage` |
| `packages/nax-agent/src/native/session-adapter.ts` | Adapter owns a state; `nativeSessionStateOf(adapter)` accessor |
| `packages/nax-agent/src/internal.ts` | Export `nativeSessionStateOf` (session.ts is already re-exported wholesale, line 64) |
| `packages/nax-agent/test/helpers/native-session-state.ts` | New: `seedNativeSession(state, name, seed)` test helper |
| nax-agent tests (19 files, list in Task 2) | Pass `sessionState`; seed through the helper |
| nax tests (14 files, list in Task 4) | Same, through `/internal` |
| `packages/nax/test/unit/agents/native/adapter-instance-invariant.test.ts` | New: one-instance invariant |

### Task 1: `NativeSessionState` and state-first lifecycle

**Files:**
- Modify: `packages/nax-agent/src/native/session/session.ts` (whole file)
- Test: `packages/nax-agent/test/unit/native/session/session-state.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  export interface NativeSessionStreamHooks {
    onStreamActivity?: (event: AgentStreamEvent) => void;
    onActiveCall?: (callId: string, cancel: () => Promise<void>) => void;
  }
  export interface NativeSessionState {
    readonly transcriptDirs: Map<string, string>;
    readonly scratchpadRoots: Map<string, string>;
    readonly timeouts: Map<string, number>;
    readonly streamHooks: Map<string, NativeSessionStreamHooks>;
    readonly failed: Set<string>;
    readonly transcriptOwners: Map<string, string>;
    readonly compaction: Map<string, ResolvedCompaction>;
    readonly transportRetry: Map<string, TurnRetryConfig>;
    readonly spinBreakers: Map<string, SpinBreaker>;
    readonly lastUsage: Map<string, SessionAnchor>;
  }
  export function createNativeSessionState(): NativeSessionState;
  export function sessionAnchorFor(state: NativeSessionState, sessionName: string, model: string | undefined): SessionAnchor | undefined;
  export function markNativeTurnOutcome(state: NativeSessionState, sessionName: string, failed: boolean): void;
  export function openNativeSession(state: NativeSessionState, name: string, opts: OpenSessionOpts): Promise<SessionHandle>;
  export function clearNativeSessionState(state: NativeSessionState, sessionName: string): void;
  export function closeNativeSession(state: NativeSessionState, handle: SessionHandle, failed?: boolean): Promise<void>;
  ```
- Removed: the exports `nativeTranscriptDirs`, `nativeSessionScratchpadRoots`, `nativeSessionTimeouts`, `nativeSessionStreamHooks`, `nativeSessionFailed`, `nativeSessionTranscriptOwners`, `nativeSessionCompaction`, `nativeSessionTransportRetry`, `nativeSessionSpinBreaker`, `nativeSessionLastUsage`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/nax-agent/test/unit/native/session/session-state.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearNativeSessionState,
  closeNativeSession,
  createNativeSessionState,
  markNativeTurnOutcome,
  openNativeSession,
  sessionAnchorFor,
} from "#src/native/session/session";
import type { OpenSessionOpts } from "#src/session/session-types";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "native-state-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function openOpts(transcriptDir: string, workdir: string): OpenSessionOpts {
  return {
    agentName: "native",
    workdir,
    transcriptDir,
    timeoutSeconds: 30,
    modelDef: { provider: "anthropic", model: "anthropic/claude-sonnet-5-5" },
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
  } as OpenSessionOpts;
}

describe("NativeSessionState", () => {
  test("two states keep the same session name apart", async () => {
    const a = createNativeSessionState();
    const b = createNativeSessionState();
    const dirA = await tempDir();
    const dirB = await tempDir();
    await openNativeSession(a, "s", { ...openOpts(dirA, dirA), transcriptOwner: "owner-a" });
    await openNativeSession(b, "s", { ...openOpts(dirB, dirB), transcriptOwner: "owner-b" });
    expect(a.transcriptDirs.get("s")).toBe(dirA);
    expect(b.transcriptDirs.get("s")).toBe(dirB);
    expect(a.transcriptOwners.get("s")).toBe("owner-a");
    expect(b.transcriptOwners.get("s")).toBe("owner-b");
  });

  test("clear empties every collection for one name only", async () => {
    const state = createNativeSessionState();
    const dir = await tempDir();
    await openNativeSession(state, "keep", openOpts(dir, dir));
    await openNativeSession(state, "drop", openOpts(dir, dir));
    state.lastUsage.set("drop", { promptTokens: 1, anchorIndex: 0 });
    markNativeTurnOutcome(state, "drop", true);
    clearNativeSessionState(state, "drop");
    for (const collection of [
      state.transcriptDirs, state.scratchpadRoots, state.timeouts, state.streamHooks,
      state.failed, state.transcriptOwners, state.compaction, state.transportRetry,
      state.spinBreakers, state.lastUsage,
    ]) {
      expect(collection.has("drop")).toBe(false);
    }
    expect(state.transcriptDirs.has("keep")).toBe(true);
  });

  test("close on a failed turn retains the transcript; on success deletes it", async () => {
    const state = createNativeSessionState();
    const dir = await tempDir();
    const handle = await openNativeSession(state, "s", openOpts(dir, dir));
    await writeFile(join(dir, "s.transcript.json"), JSON.stringify({ savedAt: "x", messages: [] }));
    markNativeTurnOutcome(state, "s", true);
    await closeNativeSession(state, handle);
    expect((await readdir(dir)).some((f) => f.startsWith("s.transcript.failed-"))).toBe(true);
    expect(state.transcriptDirs.has("s")).toBe(false);
  });

  test("closing a name this state never opened touches nothing", async () => {
    const opener = createNativeSessionState();
    const other = createNativeSessionState();
    const dir = await tempDir();
    const handle = await openNativeSession(opener, "s", openOpts(dir, dir));
    await writeFile(join(dir, "s.transcript.json"), JSON.stringify({ savedAt: "x", messages: [] }));
    await closeNativeSession(other, handle);
    expect(await readdir(dir)).toContain("s.transcript.json");
    expect(opener.transcriptDirs.get("s")).toBe(dir);
  });

  test("sessionAnchorFor drops an anchor measured under another model", () => {
    const state = createNativeSessionState();
    state.lastUsage.set("s", { promptTokens: 10, anchorIndex: 2, model: "m1" });
    expect(sessionAnchorFor(state, "s", "m2")).toBeUndefined();
    expect(state.lastUsage.has("s")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/nax-agent && bun test test/unit/native/session/session-state.test.ts`
Expected: FAIL — `createNativeSessionState` is not exported.

- [ ] **Step 3: Implement**

In `session.ts`: keep every existing doc comment, moving each one onto the matching `NativeSessionState` field. Replace each `export const nativeX = new Map(...)` with the field. Then:

```ts
export function createNativeSessionState(): NativeSessionState {
  return {
    transcriptDirs: new Map(),
    scratchpadRoots: new Map(),
    timeouts: new Map(),
    streamHooks: new Map(),
    failed: new Set(),
    transcriptOwners: new Map(),
    compaction: new Map(),
    transportRetry: new Map(),
    spinBreakers: new Map(),
    lastUsage: new Map(),
  };
}

export function sessionAnchorFor(
  state: NativeSessionState,
  sessionName: string,
  model: string | undefined,
): SessionAnchor | undefined {
  const entry = state.lastUsage.get(sessionName);
  if (entry?.model === undefined || model === undefined || entry.model === model) return entry;
  state.lastUsage.delete(sessionName);
  return undefined;
}

export function markNativeTurnOutcome(state: NativeSessionState, sessionName: string, failed: boolean): void {
  if (failed) state.failed.add(sessionName);
  else state.failed.delete(sessionName);
}
```

`openNativeSession(state, name, opts)`: same body as today with `nativeTranscriptDirs.set` → `state.transcriptDirs.set`, and so on for every collection (`nativeSessionSpinBreaker` → `state.spinBreakers`). `clearNativeSessionState(state, name)`: delete `name` from all ten collections. `closeNativeSession(state, handle, failed?)`: same body, reading `state.transcriptDirs` and `state.failed`, and calling `clearNativeSessionState(state, handle.id)` in the `finally`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/nax-agent && bun test test/unit/native/session/session-state.test.ts`
Expected: PASS (5 tests). `bun run typecheck` fails at the callers. Tasks 2-3 fix them, so do not commit yet.

### Task 2: Thread the state through the loop and truncation

**Files:**
- Modify: `packages/nax-agent/src/native/session/turn-types.ts` (`TurnDeps`, line 58)
- Modify: `packages/nax-agent/src/native/session/turn-loop.ts:30,73,85,99-109,111`
- Modify: `packages/nax-agent/src/native/session/turn-loop-round-trip.ts:47,88,218`
- Modify: `packages/nax-agent/src/native/session/loop-handlers.ts:46-60,159`
- Modify: `packages/nax-agent/src/native/session/truncation-handler.ts:27-92`
- Create: `packages/nax-agent/test/helpers/native-session-state.ts`
- Modify (tests, mechanical): `test/unit/native/session/session-lifetime-spin.test.ts`, `truncation-handler.test.ts`, `turn-loop-transcript-identity.test.ts`, `loop-events/transform-context.test.ts`, `loop-events/before-compaction.test.ts`, `loop-events/before-turn-end.test.ts`, `loop-events/before-request.test.ts`, `us-003-acs.test.ts`, `turn-loop-seam.test.ts`, `turn-loop-seam-regressions.test.ts`, `turn-loop-cancel.test.ts`, `loop-handlers-plugins.test.ts`, and `test/unit/native/turn-loop-compaction.test.ts`, `turn-loop.test.ts`, `turn-loop-usage.test.ts`, `session-adapter.test.ts`, `adapter-turn-signal.test.ts`, `adapter-loop-handlers.test.ts` (all under `packages/nax-agent/`), plus any other file `bun run typecheck` names.

**Interfaces:**
- Consumes: `NativeSessionState`, `sessionAnchorFor(state, ...)` from Task 1.
- Produces:
  ```ts
  // turn-types.ts, TurnDeps
  /** The owning adapter's per-session state (S3 spec 5.2). Required: there is no process-global fallback. */
  readonly sessionState: NativeSessionState;
  // loop-handlers.ts, BuiltinLoopHandlerDeps
  readonly sessionState: NativeSessionState;
  // truncation-handler.ts
  export function spillRootFor(state: NativeSessionState, sessionId: string): string | undefined;
  export function truncateNativeToolResult(state: NativeSessionState, sessionId: string, body: string, opts: {...}): Promise<string>;
  export function createTruncationHandler(state: NativeSessionState, sessionName: string): HandlerOf<"after_tool">;
  // test/helpers/native-session-state.ts
  export interface NativeSessionSeed { transcriptDir: string; owner?: string; scratchpadRoot?: string; timeoutSeconds?: number }
  export function seedNativeSession(state: NativeSessionState, name: string, seed: NativeSessionSeed): NativeSessionState;
  ```

- [ ] **Step 1: Write the failing truncation-fallback test** (Review Focus 3), added to `test/unit/native/session/truncation-handler.test.ts`:

```ts
test("a session unknown to the state spills nowhere and names no path", async () => {
  const state = createNativeSessionState();
  const big = "x".repeat(MODEL_MAX_BYTES + 10);
  const out = await truncateNativeToolResult(state, "unknown-session", big, { toolName: "Read", callId: "c1" });
  expect(spillRootFor(state, "unknown-session")).toBeUndefined();
  expect(out.length).toBeLessThanOrEqual(MODEL_MAX_BYTES);
  expect(out).not.toContain(".nax/scratchpad");
});

test("the scratchpad root of one state does not leak into another", () => {
  const a = seedNativeSession(createNativeSessionState(), "s", { transcriptDir: "/t/a", scratchpadRoot: "/w/a" });
  const b = seedNativeSession(createNativeSessionState(), "s", { transcriptDir: "/t/b" });
  expect(spillRootFor(a, "s")).toBe("/w/a");
  expect(spillRootFor(b, "s")).toBe("/t/b");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/nax-agent && bun test test/unit/native/session/truncation-handler.test.ts`
Expected: FAIL (signature mismatch / `seedNativeSession` missing).

- [ ] **Step 3: Implement**

Helper:

```ts
// packages/nax-agent/test/helpers/native-session-state.ts
import type { NativeSessionState } from "#src/native/session/session";

export interface NativeSessionSeed {
  readonly transcriptDir: string;
  readonly owner?: string;
  readonly scratchpadRoot?: string;
  readonly timeoutSeconds?: number;
}

/** Seeds what `openNativeSession` would record, for tests that drive `runNativeTurn` directly. */
export function seedNativeSession(state: NativeSessionState, name: string, seed: NativeSessionSeed): NativeSessionState {
  state.transcriptDirs.set(name, seed.transcriptDir);
  if (seed.owner !== undefined) state.transcriptOwners.set(name, seed.owner);
  if (seed.scratchpadRoot !== undefined) state.scratchpadRoots.set(name, seed.scratchpadRoot);
  if (seed.timeoutSeconds !== undefined) state.timeouts.set(name, seed.timeoutSeconds);
  return state;
}
```

`truncation-handler.ts`: replace the `session.ts` map import with `import type { NativeSessionState } from "./session.ts"`. Then `spillRootFor(state, id)` returns `state.scratchpadRoots.get(id) ?? state.transcriptDirs.get(id)`, and `spillPathStyle` reads `state.scratchpadRoots.has(id)`. `createTruncationHandler(state, sessionName)` passes `state` through.

`loop-handlers.ts:159`: `registry.register("after_tool", (payload) => createTruncationHandler(state.current.sessionState, state.current.sessionName)(payload));`

`turn-loop.ts`:
```ts
const dir = deps.sessionState.transcriptDirs.get(handle.id);
// ...
owner: deps.sessionState.transcriptOwners.get(handle.id),
// registerBuiltinLoopHandlers(loopEvents, { sessionName: handle.id, sessionState: deps.sessionState, ... })
const anchor = sessionAnchorFor(deps.sessionState, handle.id, transcriptIdentity.model);
```

`turn-loop-round-trip.ts:218`: `deps.sessionState.lastUsage.set(handle.id, {...})`. Drop the `session.ts` import. Update the doc comment at `:88` to name `sessionState.lastUsage`.

Tests: in every listed file, replace `nativeTranscriptDirs.set(id, dir)` (and the other collections) with a local `const sessionState = seedNativeSession(createNativeSessionState(), id, { transcriptDir: dir, ... })`. Add `sessionState` to every `TurnDeps` object passed to `runNativeTurn`. Most files build deps in one local factory (`makeDeps`/`deps()`), so edit the factory once. `afterEach` blocks that called `clearNativeSessionState(id)` are deleted, because each test owns a fresh state. Do not change any assertion.

- [ ] **Step 4: Run the nax-agent suite**

Run: `cd packages/nax-agent && bun run typecheck && bun run test`
Expected: typecheck clean except `session-adapter.ts` (Task 3). If you prefer, do Task 3's adapter change now and run the full suite once at the end of Task 3. Test counts must match `main` plus the new tests.

### Task 3: The adapter owns its state

**Files:**
- Modify: `packages/nax-agent/src/native/session-adapter.ts:24-35,78-130,143-160,195-210,330-409`
- Modify: `packages/nax-agent/src/internal.ts` (add `nativeSessionStateOf`; session.ts is already re-exported at line 64)
- Test: `packages/nax-agent/test/unit/native/session-adapter-state.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 lifecycle functions; Task 2 `TurnDeps.sessionState`.
- Produces: `export function nativeSessionStateOf(adapter: NativeSessionAdapter): NativeSessionState` (in `session-adapter.ts`, re-exported from `/internal` only).

- [ ] **Step 1: Write the failing test** (Review Focus 2)

```ts
// packages/nax-agent/test/unit/native/session-adapter-state.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeSessionAdapter, nativeSessionStateOf } from "#src/native/session-adapter";
import type { OpenSessionOpts } from "#src/session/session-types";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function opts(owner: string): Promise<OpenSessionOpts> {
  const dir = await mkdtemp(join(tmpdir(), "adapter-state-"));
  dirs.push(dir);
  return {
    agentName: "native", workdir: dir, transcriptDir: dir, transcriptOwner: owner, timeoutSeconds: 30,
    modelDef: { provider: "anthropic", model: "anthropic/claude-sonnet-5-5" },
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
  } as OpenSessionOpts;
}

describe("NativeSessionAdapter state ownership", () => {
  test("two adapters keep the same session name apart", async () => {
    const a = new NativeSessionAdapter();
    const b = new NativeSessionAdapter();
    const oa = await opts("a");
    const ob = await opts("b");
    await a.openSession("same", oa);
    await b.openSession("same", ob);
    expect(nativeSessionStateOf(a).transcriptDirs.get("same")).toBe(oa.transcriptDir);
    expect(nativeSessionStateOf(b).transcriptOwners.get("same")).toBe("b");
  });

  test("closePhysicalSession clears only this adapter's entry and deletes its clean transcript", async () => {
    const a = new NativeSessionAdapter();
    const b = new NativeSessionAdapter();
    const oa = await opts("a");
    await a.openSession("s", oa);
    await b.openSession("s", await opts("b"));
    await writeFile(join(oa.transcriptDir as string, "s.transcript.json"), JSON.stringify({ savedAt: "x", messages: [] }));
    await a.closePhysicalSession("s");
    expect(nativeSessionStateOf(a).transcriptDirs.has("s")).toBe(false);
    expect(nativeSessionStateOf(b).transcriptDirs.has("s")).toBe(true);
    expect(await readdir(oa.transcriptDir as string)).not.toContain("s.transcript.json");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/nax-agent && bun test test/unit/native/session-adapter-state.test.ts`
Expected: FAIL — `nativeSessionStateOf` not exported.

- [ ] **Step 3: Implement**

```ts
const adapterStates = new WeakMap<NativeSessionAdapter, NativeSessionState>();

/** The adapter's per-session state. `/internal` only: tests and the S3 facade read it; nax never does. */
export function nativeSessionStateOf(adapter: NativeSessionAdapter): NativeSessionState {
  const state = adapterStates.get(adapter);
  if (state === undefined) {
    throw new NaxError("NativeSessionAdapter has no session state", "NATIVE_SESSION_STATE_MISSING", { stage: "native-session" });
  }
  return state;
}
```

In the class: `constructor(private readonly catalogOverrides: NativeCatalogOverrides = []) { adapterStates.set(this, createNativeSessionState()); }`, plus `private get state(): NativeSessionState { return nativeSessionStateOf(this); }`. Replace every module-map read in `sendTurn` with `this.state.<field>`:
- `nativeSessionTimeouts.get` → `this.state.timeouts.get`
- `nativeSessionStreamHooks.get` → `this.state.streamHooks.get`
- `nativeSessionTranscriptOwners.get` → `this.state.transcriptOwners.get`
- `nativeSessionCompaction` / `nativeSessionTransportRetry` / `nativeSessionSpinBreaker` → `this.state.compaction` / `.transportRetry` / `.spinBreakers`

Then:
- Pass `sessionState: this.state` in the `TurnDeps` the adapter builds.
- `markNativeTurnOutcome(handle.id, x)` → `markNativeTurnOutcome(this.state, handle.id, x)`.
- `openSession` → `openNativeSession(this.state, name, opts)`.
- `closeSession` → `closeNativeSession(this.state, handle)`.
- `closePhysicalSession` → `closeNativeSession(this.state, { id: handle, agentName: NATIVE_AGENT })`.
- Update the `closePhysicalSession` doc comment: "the maps" are now this adapter's state.

Add `nativeSessionStateOf` to `src/internal.ts` next to the other `native/` exports, and register `NATIVE_SESSION_STATE_MISSING` wherever `check-nax-error` requires codes to be registered.

- [ ] **Step 4: Run the nax-agent gates**

Run: `cd packages/nax-agent && bun run typecheck && bun run test && bun run check:all && bun run check:api`
Expected: all PASS. `check:api` reports `/internal` changes only (removed map names, added `createNativeSessionState`, `nativeSessionStateOf`, `NativeSessionState`, `NativeSessionStreamHooks`); `.` is unchanged. Run `bun run api:update` and inspect the diff: the `[.]` section must be byte-identical.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent
git commit -m "refactor(nax-agent): native session state per adapter instance"
```

### Task 4: nax tests and the one-instance invariant

**Files:**
- Modify (mechanical, through `@nathapp/nax-agent/internal`): `packages/nax/test/unit/agents/native/session-lifecycle.test.ts`, `session/turn-loop-invalid-input.test.ts`, `session/loop-events/turn-lifecycle.test.ts`, `turn-loop-transport-retry.test.ts`, `session/native-truncation-nudge.test.ts`, `session/native-truncation-chokepoint.test.ts`, `adapter-close-physical-session.test.ts`, `adapter-complete-rates.test.ts`, and `packages/nax/test/integration/plugins/loop-handler-delivery.test.ts`, plus any further file `bun run typecheck` in `packages/nax` names
- Create: `packages/nax/test/unit/agents/native/adapter-instance-invariant.test.ts`

**Interfaces:**
- Consumes: `createNativeSessionState`, `nativeSessionStateOf`, the state-first functions, all from `@nathapp/nax-agent/internal`.

- [ ] **Step 1: Write the invariant test** (Review Focus 1)

Audit first, and record the result in the PR body:
- `createAgentRegistry` is called only from `AgentManager` (`src/agents/manager.ts:585`, memoised with `??=`);
- `nax run` builds one runtime (`src/execution/lifecycle/run-setup.ts:244`);
- every teardown path (`src/execution/session-manager-runtime.ts`) resolves adapters through the same runtime's `agentGetFn`.

If any caller resolves through a second manager, stop and report it.

```ts
// packages/nax/test/unit/agents/native/adapter-instance-invariant.test.ts
import { describe, expect, test } from "bun:test";
import { createAgentRegistry } from "../../../../src/agents/registry";
import { NATIVE_AGENT } from "@nathapp/nax-agent";
import { makeNaxConfig } from "../../../helpers/mock-nax-config";

describe("native adapter instance invariant (S3 spec 5.2)", () => {
  test("one registry hands out one native adapter for every lookup", async () => {
    const registry = createAgentRegistry(makeNaxConfig());
    const first = registry.getAgent(NATIVE_AGENT);
    const second = registry.getAgent(NATIVE_AGENT);
    const installed = (await registry.getInstalledAgents()).find((a) => a.name === NATIVE_AGENT);
    expect(first).toBeDefined();
    expect(second).toBe(first);
    if (installed !== undefined) expect(installed).toBe(first);
  });
});
```

Use whatever config helper the neighbouring tests in `test/unit/agents/` use. If `makeNaxConfig` has a different name there, use theirs. `adapter.name` is the agent name per `AgentAdapter`. Check `src/agents/types.ts` and adjust the accessor if it differs.

- [ ] **Step 2: Run it**

Run: `cd packages/nax && bun test test/unit/agents/native/adapter-instance-invariant.test.ts`
Expected: PASS. This pins existing behaviour; it is a guard, not a red-green step.

- [ ] **Step 3: Update the nax tests**

In each listed file, replace module-map seeding with `const state = createNativeSessionState()` plus direct `state.transcriptDirs.set(...)` (nax tests cannot import nax-agent's test helpers). Pass `sessionState: state` in `TurnDeps` and `state` as the first argument of the state-first functions. Where a test opens through an adapter and then inspects the maps, read `nativeSessionStateOf(adapter)` instead. `native-agent/index.ts` wraps a `NativeSessionAdapter` in `this.sessions`; reach it the way the existing test does today (the constructor's injectable `sessions` parameter). Do not change assertions.

- [ ] **Step 4: Run the repo gates**

Run: `cd packages/nax && bun run typecheck && bun run test` then from the repo root `bun run typecheck && bun run check:all && bun run build`
Expected: all PASS; nax unit/integration counts equal `main` plus 1 (the invariant test). Then `cd packages/nax-agent && bun run test:coverage` (80% per file, baseline empty) and `cd packages/nax && bun run test:coverage`.

- [ ] **Step 5: Verify nax output unchanged**

Run from the repo root: `bun packages/nax/bin/nax.ts --help | md5` and `bun packages/nax/bin/nax.ts --version` on `main` and on the branch.
Expected: identical.

- [ ] **Step 6: Commit**

```bash
git add packages/nax
git commit -m "test(nax): native session state via adapter instance; pin one-instance invariant"
```

S3-0a ends here: push and open the PR only after user approval.

---

## PR S3-0b — adapter-owned client and credentials

Branch: `feat/s3-0b-adapter-client` from `main` after S3-0a merges.

### File map

| File | Change |
|---|---|
| `packages/nax-agent/src/native/credentials/fingerprint.ts` | `fingerprintCredential(credential, salt?)` |
| `packages/nax-agent/src/native/credentials/change-guard.ts` | `ChangeGuardOptions.salt?`; `CredentialOrigin.source` gains `"memory"` |
| `packages/nax-agent/src/session/session-types.ts:28-35` | `AuthStamp.source` gains `"memory"` |
| `packages/nax-agent/src/native/credentials/session-source.ts` | New: `CredentialSource`, `createSessionCredentialStore` |
| `packages/nax-agent/src/native/client.ts` | `BuildNativeClientOptions.credentials?` |
| `packages/nax-agent/src/native/session-adapter.ts` | `NativeSessionAdapterOptions`; own client and store; per-instance auth stamp and `hasCredentials` |
| `packages/nax-agent/src/index.ts` | Export `CredentialSource`, `NativeSessionAdapterOptions` on `.` |
| `packages/nax-agent/test/node/session-credentials.test.ts` | New Node contract case |
| `packages/nax-agent/CHANGELOG.md` | Unreleased entry |

### Task 5: Injectable fingerprint salt and the `memory` source label

**Files:**
- Modify: `packages/nax-agent/src/native/credentials/fingerprint.ts:178-182`
- Modify: `packages/nax-agent/src/native/credentials/change-guard.ts:24-40,127-140`
- Modify: `packages/nax-agent/src/session/session-types.ts:28-35`
- Test: `packages/nax-agent/test/unit/native/credentials/fingerprint.test.ts`, `change-guard.test.ts` (add cases)

**Interfaces:**
- Produces:
  ```ts
  export async function fingerprintCredential(credential: StoredCredential, salt?: Buffer): Promise<string>;
  // ChangeGuardOptions
  /** Fingerprint key. Absent = the machine salt file (today). A session store passes an in-memory salt. */
  readonly salt?: Buffer;
  // CredentialOrigin.source and AuthStamp.source: "file" | "exec" | "memory"
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// fingerprint.test.ts
test("an explicit salt is used instead of the machine salt file", async () => {
  _resetCredentialsConfig(); // the slot is unset: reading it would throw CREDENTIALS_NOT_CONFIGURED
  const salt = Buffer.alloc(32, 7);
  const a = await fingerprintCredential({ kind: "api-key", key: "k1" }, salt);
  const b = await fingerprintCredential({ kind: "api-key", key: "k1" }, salt);
  expect(a).toBe(b);
  expect(a).toMatch(/^[0-9a-f]{12}$/);
});

// change-guard.test.ts
test("a guard with an explicit salt never reads the credentials slot", async () => {
  _resetCredentialsConfig();
  const inner = createMemoryCredentialStore({ anthropic: { kind: "api-key", key: "k" } });
  const guard = createChangeGuard(inner, {
    onChange: "warn",
    salt: Buffer.alloc(32, 1),
    describe: () => ({ source: "memory" }),
  });
  await guard.read("anthropic");
  expect(guard.servedAuth("anthropic")?.source).toBe("memory");
});
```

Each test file restores the slot after itself. Follow the save/restore pattern S2-3b established in `credentials-config` tests (other suites rely on the preload's slot).

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/nax-agent && bun test test/unit/native/credentials/fingerprint.test.ts test/unit/native/credentials/change-guard.test.ts`
Expected: FAIL (extra argument ignored, so the slot is read and throws; `"memory"` is not assignable).

- [ ] **Step 3: Implement**

```ts
export async function fingerprintCredential(credential: StoredCredential, salt?: Buffer): Promise<string> {
  const key = salt ?? (await resolveSalt());
  const secret = identifyingSecret(credential);
  return createHmac("sha256", key).update(secret).digest("hex").slice(0, FINGERPRINT_CHARS);
}
```

In `createChangeGuard`, the call at `:138` becomes `fingerprintCredential(credential, options.salt)`. Widen `CredentialOrigin.source` and `AuthStamp.source` to `"file" | "exec" | "memory"`, and update their doc comments.

- [ ] **Step 4: Run to verify they pass**

Run the same command. Expected: PASS. Then `bun run typecheck` in both packages: any exhaustive `switch` on `AuthStamp.source` in nax must handle `"memory"`. Fix each site by rendering `memory` like the others, and list the sites in the PR body.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent packages/nax
git commit -m "feat(nax-agent): injectable fingerprint salt and memory credential source label"
```

### Task 6: `CredentialSource` and the per-session store

**Files:**
- Create: `packages/nax-agent/src/native/credentials/session-source.ts`
- Test: `packages/nax-agent/test/unit/native/credentials/session-source.test.ts`

**Interfaces:**
- Consumes: `createChangeGuard` with `salt` (Task 5), `createExecCredentialSource` (`exec-source.ts:152`), nax-ai `createMemoryCredentialStore`, `StoredCredential`, `ProviderId`.
- Produces:
  ```ts
  export type CredentialSource =
    | { readonly kind: "memory"; readonly credentials: Readonly<Record<string, StoredCredential>> }
    | { readonly kind: "exec"; readonly command: readonly string[]; readonly timeoutMs?: number; readonly onChange?: "warn" | "refuse" };
  export function createSessionCredentialStore(source: CredentialSource): GuardedCredentialStore;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { _resetCredentialsConfig } from "#src/infra/credentials-config";
import { createSessionCredentialStore } from "#src/native/credentials/session-source";

describe("createSessionCredentialStore", () => {
  test("memory source serves its credential and stamps source memory without the slot", async () => {
    _resetCredentialsConfig();
    const store = createSessionCredentialStore({
      kind: "memory",
      credentials: { anthropic: { kind: "api-key", key: "sk-test" } },
    });
    expect(await store.read("anthropic")).toEqual({ kind: "api-key", key: "sk-test" });
    const stamp = store.servedAuth("anthropic");
    expect(stamp?.source).toBe("memory");
    expect(stamp?.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  test("memory source declines an unknown provider", async () => {
    const store = createSessionCredentialStore({ kind: "memory", credentials: {} });
    expect(await store.read("openai")).toBeUndefined();
  });

  test("two memory stores fingerprint the same key with different salts", async () => {
    const creds = { anthropic: { kind: "api-key" as const, key: "same" } };
    const a = createSessionCredentialStore({ kind: "memory", credentials: creds });
    const b = createSessionCredentialStore({ kind: "memory", credentials: creds });
    await a.read("anthropic");
    await b.read("anthropic");
    expect(a.servedAuth("anthropic")?.fingerprint).not.toBe(b.servedAuth("anthropic")?.fingerprint);
  });
});
```

For the exec branch, add one case that reuses the fake-helper fixture `exec-source.test.ts` already uses (same file paths and helpers). Assert that `servedAuth(...).source === "exec"`, that the account label is passed through, and that `_resetCredentialsConfig()` beforehand does not make it throw.

Check what nax-ai's memory store returns for an unknown provider (`packages/nax-ai/src/credentials/memory-store.ts`). If it returns `null`, assert `null`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/nax-agent && bun test test/unit/native/credentials/session-source.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/nax-agent/src/native/credentials/session-source.ts
/**
 * A credential source owned by one session (S3 spec 5.2), instead of the
 * process-wide store behind `configureCredentials`. It never reads the slot:
 * the fingerprint salt is random per store, so an embedder that never called
 * `configureCredentials` can still run a session and stamp its cost rows.
 */
import { randomBytes } from "node:crypto";
import { createMemoryCredentialStore, type StoredCredential } from "@nathapp/nax-ai";
import { createChangeGuard, type GuardedCredentialStore } from "./change-guard.ts";
import { createExecCredentialSource } from "./exec-source.ts";

export type CredentialSource =
  | { readonly kind: "memory"; readonly credentials: Readonly<Record<string, StoredCredential>> }
  | {
      readonly kind: "exec";
      readonly command: readonly string[];
      readonly timeoutMs?: number;
      readonly onChange?: "warn" | "refuse";
    };

const SALT_BYTES = 32;

export function createSessionCredentialStore(source: CredentialSource): GuardedCredentialStore {
  const salt = randomBytes(SALT_BYTES);
  if (source.kind === "memory") {
    return createChangeGuard(createMemoryCredentialStore(source.credentials), {
      onChange: "warn",
      salt,
      describe: () => ({ source: "memory" }),
    });
  }
  const exec = createExecCredentialSource({
    command: source.command,
    ...(source.timeoutMs !== undefined ? { timeoutMs: source.timeoutMs } : {}),
  });
  return createChangeGuard(exec, {
    onChange: source.onChange ?? "warn",
    salt,
    describe: (providerId) => {
      const account = exec.accountOf(providerId);
      return account === undefined ? { source: "exec" } : { source: "exec", account };
    },
  });
}
```

If `createMemoryCredentialStore`'s parameter type is `Record<ProviderId, StoredCredential>` and `ProviderId` is a branded or narrower type, cast at this one boundary with a comment rather than widening the public type. Also verify that `exec-source.ts` reads no slot state (it should not; `assembleStore` is the only slot reader).

- [ ] **Step 4: Run to verify it passes**

Run the same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent
git commit -m "feat(nax-agent): per-session credential source (memory, exec)"
```

### Task 7: Adapter-owned client, auth stamp and `hasCredentials`

**Files:**
- Modify: `packages/nax-agent/src/native/client.ts` (`BuildNativeClientOptions`, `buildNativeClient`)
- Modify: `packages/nax-agent/src/native/session-adapter.ts` (constructor, `hasCredentials`, `sendTurn` client acquisition at `:123`, `authFields` call near `:380`)
- Modify: `packages/nax-agent/src/native/adapter-deps.ts` (`authFields` takes an optional store)
- Test: `packages/nax-agent/test/unit/native/session-adapter-client.test.ts` (new)

**Interfaces:**
- Consumes: `createSessionCredentialStore` (Task 6).
- Produces:
  ```ts
  // client.ts
  export interface BuildNativeClientOptions {
    readonly transportRetries?: number;
    /** The store the protocols resolve credentials from. Absent = the process store (`naxCredentialStore()`). */
    readonly credentials?: CredentialStore;
  }
  // session-adapter.ts
  export interface NativeSessionAdapterOptions {
    /** A credential source owned by this adapter. Implies an owned client. */
    readonly credentials?: CredentialSource;
    /** Build and own a client even without `credentials` (for per-session catalog overrides). */
    readonly ownClient?: boolean;
  }
  export class NativeSessionAdapter {
    constructor(catalogOverrides?: NativeCatalogOverrides, options?: NativeSessionAdapterOptions);
  }
  // adapter-deps.ts
  export function authFields(provider: string, store?: GuardedCredentialStore): { auth?: AuthStamp };
  ```

- [ ] **Step 1: Write the failing tests** (Review Focus 4 and 5)

The stub client and open helper mirror `test/unit/native/session-adapter.test.ts:33-80` and `test/node/fixtures/packed-smoke.mjs`. Today `sendTurn` reads the credentials slot through `authFields` -> `servedAuth` -> `naxCredentialStore()` even against a stub client; that is exactly the read a memory-sourced adapter must not make.

```ts
// packages/nax-agent/test/unit/native/session-adapter-client.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenSessionOpts } from "@nathapp/nax-agent";
import { _clientDeps, _resetNativeClient, getNativeClient } from "@nathapp/nax-agent/internal";
import type { Client, ResolvedModel } from "@nathapp/nax-ai";
import { _resetCredentialsConfig, configureCredentials, credentialsConfig } from "#src/infra/credentials-config";
import { NativeSessionAdapter } from "#src/native/session-adapter";

const REAL_BUILD = _clientDeps.build;
const dirs: string[] = [];
let savedSlot: ReturnType<typeof credentialsConfig> | undefined;
afterEach(async () => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
  if (savedSlot !== undefined) configureCredentials(savedSlot);
  savedSlot = undefined;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const model: ResolvedModel = {
  id: "stub-model", provider: "stub", protocol: "stub",
  pricing: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000, supportsTools: true, thinkingLevels: [],
};
function stubClient(): Client {
  return {
    model: async () => model,
    listModels: async () => [model],
    pricing: () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }),
    stream: async function* stream() {},
    complete: async () => ({ text: "ok", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" }),
    validate: () => {},
  };
}
async function oneTurn(adapter: NativeSessionAdapter, name: string) {
  const dir = await mkdtemp(join(tmpdir(), "adapter-client-"));
  dirs.push(dir);
  const handle = await adapter.openSession(name, {
    agentName: "native", workdir: dir, transcriptDir: dir, timeoutSeconds: 60,
    modelDef: { provider: "stub", model: "stub/stub-model" },
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
  } as OpenSessionOpts);
  const result = await adapter.sendTurn(handle, "hi", {
    interactionHandler: { onInteraction: async () => ({ answer: "" }) },
  });
  await adapter.closeSession(handle);
  return result;
}

describe("adapter-owned client", () => {
  test("a memory-sourced adapter runs a turn with the slot unset and stamps source memory", async () => {
    savedSlot = credentialsConfig();
    _resetCredentialsConfig();
    const seenOptions: unknown[] = [];
    _clientDeps.build = (async (_overrides, options) => {
      seenOptions.push(options);
      return stubClient();
    }) as typeof REAL_BUILD;
    const adapter = new NativeSessionAdapter([], {
      credentials: { kind: "memory", credentials: { stub: { kind: "api-key", key: "k" } } },
    });
    const result = await oneTurn(adapter, "mem");
    expect(result.output).toBe("ok");
    expect(seenOptions).toHaveLength(1);
    expect((seenOptions[0] as { credentials?: unknown }).credentials).toBeDefined();
    expect(await adapter.hasCredentials()).toBe(true);
  });

  test("two owned clients with different overrides both build; the memo still refuses a mismatch", async () => {
    let builds = 0;
    _clientDeps.build = (async () => {
      builds += 1;
      return stubClient();
    }) as typeof REAL_BUILD;
    const p1 = [{ provider: "p1", models: [] }];
    const p2 = [{ provider: "p2", models: [] }];
    await oneTurn(new NativeSessionAdapter(p1 as never, { ownClient: true }), "a");
    await oneTurn(new NativeSessionAdapter(p2 as never, { ownClient: true }), "b");
    expect(builds).toBe(2);
    await getNativeClient(p1 as never);
    await expect(getNativeClient(p2 as never)).rejects.toMatchObject({ code: "NATIVE_CLIENT_OVERRIDES_MISMATCH" });
  });

  test("option-less adapters share the module memo (nax path)", async () => {
    let builds = 0;
    _clientDeps.build = (async () => {
      builds += 1;
      return stubClient();
    }) as typeof REAL_BUILD;
    await oneTurn(new NativeSessionAdapter(), "x");
    await oneTurn(new NativeSessionAdapter(), "y");
    expect(builds).toBe(1);
  });
});
```

The overrides literals are cast because `getNativeClient` only canonicalises them here and the stub build ignores them. If `check-test-escape-hatches` rejects `as never`, build them from the `ProviderCatalogOverride` fixture an existing client test uses (`grep -rn "catalogOverrides" test/unit/native/`). If the package preload sets no slot, `credentialsConfig()` throws when the memory test saves it: wrap that save in try/catch and restore only what was saved.

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/nax-agent && bun test test/unit/native/session-adapter-client.test.ts`
Expected: FAIL (constructor ignores options; second override set throws in the memo).

- [ ] **Step 3: Implement**

`client.ts`, inside `buildNativeClient`: `credentials: options.credentials ?? naxCredentialStore(),`.

`session-adapter.ts`:

```ts
export interface NativeSessionAdapterOptions {
  readonly credentials?: CredentialSource;
  readonly ownClient?: boolean;
}

export class NativeSessionAdapter implements AgentSessionAdapter {
  private readonly ownStore: GuardedCredentialStore | undefined;
  private ownClient: Promise<Client> | undefined;
  private readonly owns: boolean;

  constructor(
    private readonly catalogOverrides: NativeCatalogOverrides = [],
    options: NativeSessionAdapterOptions = {},
  ) {
    adapterStates.set(this, createNativeSessionState());
    this.ownStore = options.credentials !== undefined ? createSessionCredentialStore(options.credentials) : undefined;
    this.owns = this.ownStore !== undefined || options.ownClient === true;
  }

  /** The module memo for nax (one client per process, as before); an owned client for an embedder session. */
  private client(): Promise<Client> {
    if (!this.owns) return getNativeClient(this.catalogOverrides);
    this.ownClient ??= _clientDeps
      .build(this.catalogOverrides, this.ownStore !== undefined ? { credentials: this.ownStore } : {})
      .catch((err: unknown) => {
        this.ownClient = undefined;
        throw err;
      });
    return this.ownClient;
  }
}
```

- In `sendTurn`, replace `await getNativeClient(this.catalogOverrides)` with `await this.client()`, and the `authFields(provider)` call with `authFields(provider, this.ownStore)`.
- `adapter-deps.ts`: `authFields(provider, store?)` reads `store?.servedAuth(provider) ?? _adapterDeps.servedAuth(provider)` when no store is given (today's path); with a store, it reads only the store.
- `hasCredentials()`: when `this.ownStore` is set, return `true`. A memory source was given its keys explicitly, and an exec source answers per request, as US-004 does. Otherwise the existing body runs.
- `_clientDeps.build`'s signature already takes `(overrides, options)`, so the S2 pack-smoke stub keeps working.

- [ ] **Step 4: Run to verify they pass**

Run: `cd packages/nax-agent && bun test test/unit/native/session-adapter-client.test.ts && bun run test`
Expected: PASS; full suite green.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent
git commit -m "feat(nax-agent): adapter-owned client and credential store"
```

### Task 8: Public surface, Node contract case, changelog

**Files:**
- Modify: `packages/nax-agent/src/index.ts` (export `type CredentialSource`, `type NativeSessionAdapterOptions`)
- Modify: `packages/nax-agent/api/nax-agent.api.txt` (via `bun run api:update`)
- Create: `packages/nax-agent/test/node/session-credentials.test.ts`
- Modify: `packages/nax-agent/CHANGELOG.md`

- [ ] **Step 1: Write the Node contract case** (Review Focus 4 under real Node)

Model it on `test/node/builtins.test.ts` (vitest, imports the built `dist/` the way the existing node tests do; read that file first and copy its import style):

```ts
import { describe, expect, test } from "vitest";
// import path copied from builtins.test.ts (built output of src/native/credentials/session-source.ts)

describe("session credential source on Node", () => {
  test("memory source reads and stamps without configureCredentials", async () => {
    const store = createSessionCredentialStore({
      kind: "memory",
      credentials: { anthropic: { kind: "api-key", key: "sk-node" } },
    });
    expect(await store.read("anthropic")).toEqual({ kind: "api-key", key: "sk-node" });
    expect(store.servedAuth("anthropic")?.source).toBe("memory");
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd packages/nax-agent && bun run build && bun run test:node`
Expected: PASS on the local Node; CI runs 22 and 24.

- [ ] **Step 3: Surface and changelog**

Add the two type exports to `src/index.ts` next to `NativeSessionAdapter`. Run `bun run api:update`. The `[.]` diff must show exactly:
- the two new types;
- `NativeSessionAdapter`'s constructor gaining the optional `options` parameter;
- `AuthStamp.source` gaining `"memory"`.

Then append to `CHANGELOG.md` under an `Unreleased` heading: "Per-session credential sources (`memory`, `exec`) and adapter-owned clients for embedders; `AuthStamp.source` may be `memory`. nax behaviour unchanged."

- [ ] **Step 4: Full gates**

Run from the repo root: `bun run typecheck && bun run check:all && bun run test && bun run build`. Then `cd packages/nax-agent && bun run check:api && bun run test:coverage && bun run test:node`, and `cd packages/nax && bun run test:coverage`.
Expected: all PASS; agent coverage baseline still empty.

- [ ] **Step 5: Verify nax output unchanged**

Run from the repo root: `bun packages/nax/bin/nax.ts --help | md5` and `--version`, compared with `main`. Expected: identical.

- [ ] **Step 6: Commit**

```bash
git add packages/nax-agent
git commit -m "feat(nax-agent): export CredentialSource and adapter options; Node contract case"
```

S3-0b ends here: push and open the PR only after user approval. No billed run is needed for S3-0 (no wire-path change); the billed S1-recipe smoke belongs to S3-3.
