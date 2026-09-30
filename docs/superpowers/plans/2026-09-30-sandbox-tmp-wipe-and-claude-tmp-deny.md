# Sandbox Temp Wipe + `/tmp/claude` Deny Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the end-of-run temp wipe remove the tree the run actually created (#2300), and stop a confined macOS sandboxed session from writing to `/tmp/claude` (#2301).

**Architecture:** Two independent defects, two independent fixes, no shared code path.

- **#2300** is an identity split. Two values are both called `runId`. `createRuntime` mints `crypto.randomUUID()` (`src/runtime/index.ts:310`) and hands it to the `AgentManager`, which forwards it as `AgentRunOptions.runId` — that is the id `resolveDispatchLauncher` passes to `runTmpRoot()` (`src/agents/coding-tool-support-resolve.ts:373`), so session dirs land under `/tmp/nax/<uuid>/`. `runner.ts:198` independently mints `buildRunId(workdir, …)` and hands *that* to `cleanupRun` (`src/execution/runner.ts:419-420`), which passes it to `wipeRunTmp` (`src/execution/lifecycle/run-cleanup.ts:380`). `wipeRunTmp` resolves `/tmp/nax/run-<hash>-<iso>`, a path nothing ever created, and `rm(..., { force: true })` on a missing path does not raise — so the wipe silently removed nothing, every run. The fix gives `RunCleanupOptions` a second, separately-named id (`runtimeRunId`) and wipes under that one. It does **not** unify the two ids (see Task 2's rejection note).
- **#2301** is a policy gap. On macOS, `@anthropic-ai/sandbox-runtime` hard-codes `/tmp/claude` and `/private/tmp/claude` into `SANDBOX_OWN_WRITE_PATHS` and sets `TMPDIR=/tmp/claude` in the child env; nax cannot remove the allow. srt writes `denyWrite` rules *after* the allow rules, so only an explicit deny takes the write back. nax does not need the directory: `createCommandLauncher` prefixes every wrapped command with `export TMPDIR=<session dir> TMP=… TEMP=…` (`src/sandbox/launcher.ts:62-65`), which replaces srt's value before the agent's command runs. So for a **confined** session the write root is dropped and both spellings are denied. `platform: "darwin"` only — srt's Linux (bwrap) backend handles this differently and needs its own check.

**Tech Stack:** Bun 1.4.0, TypeScript strict, `bun:test`, Biome, zod 4, `@anthropic-ai/sandbox-runtime` 0.0.77.

**#2301 verified against real srt before this plan was written** (macOS arm64, the project's pinned srt 0.0.77, `SandboxManager.wrapWithSandboxArgv` with `allowWrite: [runDir]` and `export TMPDIR=<runDir>` first):

| `denyWrite` | write to `/tmp/claude/x` | write to `$TMPDIR/inside.txt` | heredoc under the same deny |
|:--|:--|:--|:--|
| `[]` | **allowed** (the bug) | ok | ok |
| `["/tmp/claude"]` | `Operation not permitted` | ok | ok |
| `["/private/tmp/claude"]` | `Operation not permitted` | ok | ok |
| both | `Operation not permitted` | ok | **ok** |

Also read from `node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js:477-531`: `SANDBOX_OWN_WRITE_PATHS` is spread unconditionally by `getDefaultWritePaths` (only `HOME_CONVENIENCE_WRITE_DIRS` can be dropped), and it lands in `writeConfig.allowOnly` while nax's list lands in `writeConfig.denyWithinAllow`. Two consequences the plan relies on: a `denyWrite` is the only lever, and a write the agent's own `$TMPDIR` names is unaffected.

**Spec:** `docs/specs/SPEC-tmp-confinement.md` (the design record for #2285, which both issues amend) and `docs/adr/ADR-030-bash-approval-modes.md` (amendment 2026-09-28, decision 2 — the clause #2301 reverses). Issues: https://github.com/nathapp-io/nax/issues/2300 and https://github.com/nathapp-io/nax/issues/2301. This plan implements both issues and records both amendments.

## Global Constraints

- **Worktree:** all work happens in `.worktrees/fix-sandbox-tmp-wipe` (branch `fix/sandbox-tmp-wipe`, branched from `origin/main` @ `f3ad8ac01`). Never edit the parent checkout — it is under development on `feat/project-trust-gate`.
- **Bun-native APIs only.** No `node:` equivalents of Bun APIs; `existsSync` from `node:fs` is already the house choice for synchronous stats (`src/sandbox/session-tmp.ts:35`).
- **Test file placement:** add to the module's existing test file. A new test file is permitted only for a genuine cross-module integration test whose name maps to a `src/` module. Never `<module>-<ticket>.test.ts`.
- **`_deps` injection seam** for every external call (`docs/architecture/conventions.md` §2). A test reassigns a property of the exported seam object; production values are the defaults.
- **No new magic strings.** Every path constant goes in `src/sandbox/defaults.ts` (`UPPER_SNAKE_CASE`).
- **File-size limits:** 600 lines `src/`, 800 lines `test/` (`bun run check:file-sizes`). `test/unit/execution/lifecycle/run-cleanup.test.ts` is at 767 — one added line only, nothing more.
- **Complexity ratchet:** `cleanupRun` is baselined at cognitive complexity 29 (`scripts/baselines/complexity-baseline.json`). Task 2 must add no branch to that function.
- **Every emitted sandbox path goes through `literal()` → `realOrRaw()`.** On macOS `/tmp` is a symlink to `/private/tmp`, so a test comparing against `/tmp/claude` must compare against `realOrRaw("/tmp/claude")`.
- **`sandboxBackendFor` is a process-wide singleton** — a session-scoped decision must never reach it.
- **Pre-existing baseline failures (do NOT fix, do NOT attribute to this work):** `bun run test` on a fresh `origin/main` worktree is **21610 pass / 3 fail**, all three in `test/unit/scripts/check-complexity.test.ts` (the checked-in `complexity-baseline.json` is stale relative to the tree). Any other failure is yours.
- **Verification commands:** `AGENT=1 bun test <path> --timeout=30000` (targeted), `bun run typecheck`, `AGENT=1 bun run lint:biome`, `bun run test:coverage`.

---

### Task 1: An absent wipe target is recorded, not silently swallowed

`rm(path, { force: true })` does not raise on a missing path, so the #2300 mismatch produced no log line at all. Add an existence check to `wipeRunTmp` so the absent case is observable — it is the only signal that distinguishes "this run never dispatched a sandboxed command" from "the id this call was handed was never the id the directories were created under".

**Files:**
- Modify: `src/execution/lifecycle/run-tmp-wipe.ts:1-52`
- Modify (tests): `test/unit/execution/lifecycle/run-tmp-wipe.test.ts:29-69`

**Interfaces:**
- Consumes: nothing new.
- Produces: `_runTmpWipeDeps.exists: (path: string) => boolean` (new seam member, default `existsSync`). `wipeRunTmp(runId: string, opts?: WipeRunTmpOptions): Promise<void>` — signature unchanged.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/execution/lifecycle/run-tmp-wipe.test.ts`, inside the existing `describe("wipeRunTmp (US-004)")`. The describe already has `withDepsRestore(_runTmpWipeDeps)` and `withDepsRestore(_sessionTmpDeps)`, and its `beforeEach` pins the host via `stubSessionTmpDeps(_sessionTmpDeps, { parent: "ENOENT" })` — so `runTmpRoot("r1")` is `/tmp/nax/r1` on every machine.

```ts
  test("#2300: an absent target is recorded at debug and removed from nothing", async () => {
    const remove = mock(async (_path: string) => {});
    _runTmpWipeDeps.remove = remove as typeof _runTmpWipeDeps.remove;
    _runTmpWipeDeps.exists = mock(() => false) as unknown as typeof _runTmpWipeDeps.exists;

    await withDebugSpy(async (debugSpy) => {
      await wipeRunTmp("r1");

      const record = debugSpy.mock.calls.find((call) => call[0] === "sandbox");
      expect(record).toBeDefined();
      expect(String(record?.[1])).toContain("/tmp/nax/r1");
      expect((record?.[2] as { runId?: string }).runId).toBe("r1");
    });
    expect(remove).not.toHaveBeenCalled();
  });
```

Extend the import on line 16 to include `withDebugSpy`:

```ts
import { stubSessionTmpDeps, withDepsRestore, withDebugSpy, withWarnSpy } from "@test/helpers";
```

- [ ] **Step 2: Update the three existing tests that assert `remove` was called**

They stub `remove` but not `exists`, so once the guard exists they will short-circuit and fail. Add one line to each — the test at line 29 (`US-001 AC9`), the test at line 42 (`US-001 AC9 boundary`) and the test at line 54 (`US-004 AC15 boundary`):

```ts
    _runTmpWipeDeps.exists = () => true;
```

Also correct the comment in the test at line 63, whose claim "the production removal primitive stays in place" is no longer what happens:

```ts
  test("US-004 AC15 boundary: wiping a run whose directory does not exist resolves", async () => {
    // Absence is the ordinary case for a run that never spawned a command: the
    // production `exists` seam reports it and the wipe returns without calling
    // `remove` at all.
    expect(existsSync(runTmpRoot("us004-no-such-run"))).toBe(false);

    await expect(wipeRunTmp("us004-no-such-run")).resolves.toBeUndefined();
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
AGENT=1 bun test test/unit/execution/lifecycle/run-tmp-wipe.test.ts --timeout=30000
```

Expected: FAIL. `_runTmpWipeDeps.exists` is `undefined` at the assignment in Step 1 (or the assignment throws), and the new test's `record` is `undefined`.

- [ ] **Step 4: Implement the existence check**

Replace `src/execution/lifecycle/run-tmp-wipe.ts` in full:

```ts
/**
 * End-of-run temp-directory wipe (US-004).
 *
 * The complement of `scratchpad-wipe.ts`: it removes the run's OWN temp root
 * (`runTmpRoot(runId)` — `<parent>/<runId>` under the shared `/tmp/nax`, or the
 * per-user fallback), never a `/tmp/nax*` sweep — a concurrent run's live
 * directories share that prefix, and a crashed run's directory is left for the
 * OS to clear. It never removes the shared parent either, which the next run is
 * about to use. Unlike the scratchpad wipe it is NOT gated on `runCompleted`: a
 * failed run's `/tmp` files are not kept for inspection because no later run can
 * find them to clear.
 *
 * Failure is tolerated by design: a temp directory must never wedge a run.
 * Everything that is not absence is logged at warn and swallowed.
 *
 * #2300: `rm(..., { force: true })` does not raise on a missing path, so a wipe
 * aimed at the WRONG run id removed nothing AND said nothing — every run's temp
 * root survived the wipe that was supposed to remove it. The existence check
 * below is what makes absence observable.
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { getSafeLogger } from "@/logger";
import { runTmpRoot } from "@/sandbox";
import { errorMessage } from "@/utils/errors";

/** Injectable deps for the wipe (see docs/architecture/conventions.md §2). */
export const _runTmpWipeDeps = {
  remove: (path: string): Promise<void> => rm(path, { recursive: true, force: true }),
  /**
   * #2300 — one synchronous stat, so a wipe aimed at an id nothing was created
   * under is recorded instead of passing silently.
   */
  exists: (path: string): boolean => existsSync(path),
};

/** Options for {@link wipeRunTmp}. */
export interface WipeRunTmpOptions {
  /** When true, skip disk work entirely — a dry run must not delete anything. */
  dryRun?: boolean;
}

/**
 * Delete the run's temp root, tolerating absence and failure.
 *
 * Resolves for every outcome: the caller has no decision to make either way —
 * a failed wipe is reported and the run carries on.
 */
export async function wipeRunTmp(runId: string, opts: WipeRunTmpOptions = {}): Promise<void> {
  if (opts.dryRun) return;
  const path = runTmpRoot(runId);
  if (!_runTmpWipeDeps.exists(path)) {
    getSafeLogger()?.debug("sandbox", `Run temp dir absent — nothing to wipe: ${path}`, { runId, path });
    return;
  }
  try {
    await _runTmpWipeDeps.remove(path);
  } catch (err) {
    getSafeLogger()?.warn("sandbox", `Failed to wipe run temp dir ${path} — continuing`, {
      runId,
      path,
      error: errorMessage(err),
    });
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
AGENT=1 bun test test/unit/execution/lifecycle/run-tmp-wipe.test.ts --timeout=30000
```

Expected: PASS, 7 tests (6 existing + 1 new), 0 fail.

- [ ] **Step 6: Commit**

```bash
git add src/execution/lifecycle/run-tmp-wipe.ts test/unit/execution/lifecycle/run-tmp-wipe.test.ts
git commit -m "fix(sandbox): record an absent run-temp wipe target instead of passing silently (#2300)"
```

---

### Task 2: Wipe under the id the session dirs were created under

`cleanupRun` receives the runner's `buildRunId(...)` and hands it to `wipeRunTmp`, while the dirs on disk hang off `runtime.runId` (`crypto.randomUUID()`). Add a second, separately-named option so the two never get confused again.

**Files:**
- Modify: `src/execution/lifecycle/run-cleanup.ts:72-118` (`RunCleanupOptions`) and `:373-387` (the wipe block)
- Modify: `src/execution/runner.ts:419-447` (the `cleanupRun` call)
- Modify (tests): `test/unit/execution/lifecycle/run-cleanup-run-tmp-wipe.test.ts:20-91`
- Modify (tests, one line each): `test/unit/execution/lifecycle/run-cleanup.test.ts:62`, `run-cleanup-locks.test.ts:25`, `run-cleanup-approvals-seal.test.ts:36`, `run-cleanup-sandbox.test.ts:17`, `run-cleanup-scratchpad-wipe.test.ts:28`

**Interfaces:**
- Consumes: `NaxRuntime.runId: string` (`src/runtime/index.ts:150`, `readonly`), already in scope in `runner.ts`'s finally block as `runtime`.
- Produces: `RunCleanupOptions.runtimeRunId: string` — **required**. `RunCleanupOptions.runId` keeps its existing meaning and is unchanged: it is the runner's id, used for `status.json`, the log file name, `releaseFeatureLock` and the reporter `PostRunContext`.

- [ ] **Step 1: Write the failing tests**

In `test/unit/execution/lifecycle/run-cleanup-run-tmp-wipe.test.ts`, change `makeCleanupOptions` so the two ids are visibly different — that is the whole point of the file now:

```ts
function makeCleanupOptions(overrides: Partial<RunCleanupOptions> = {}): RunCleanupOptions {
  return {
    runId: "run-8a1b05ad-2026-09-29T07-32-15.243",
    // #2300: deliberately a DIFFERENT id from `runId` — this is the shape that
    // shipped, and the reason the wipe removed nothing.
    runtimeRunId: "0f9c1d2e-3a4b-4c5d-8e6f-0708090a0b0c",
    startTime: Date.now() - 1000,
    totalCost: 0,
    storiesCompleted: 0,
    prd: makePRD({ feature: "us004-run-tmp" }),
    pluginRegistry: makePluginRegistry(),
    workdir: "/tmp/us004-run-tmp",
    interactionChain: null,
    feature: "us004-run-tmp",
    prdPath: "/tmp/us004-run-tmp/.nax/features/us004-run-tmp/prd.json",
    branch: "feat/us004",
    version: "1.0.0",
    hooks: { hooks: {} },
    dryRun: false,
    ...overrides,
  };
}
```

Then update the four existing assertions — `expect(wipeCalls.map((call) => call.runId)).toEqual(["r1"])` becomes the runtime id, and `runId: "r1"` in the three call sites becomes `runId: "run-8a1b05ad-2026-09-29T07-32-15.243"`:

```ts
  test("US-004 AC17: a failed run still wipes its temp root", async () => {
    stubWipe();

    await cleanupRun(makeCleanupOptions({ runCompleted: false, dryRun: false }));

    // Unlike the scratchpad wipe, this one is NOT gated on runCompleted: a
    // failed run's /tmp files are unreachable by any later run.
    expect(wipeCalls.map((call) => call.runId)).toEqual(["0f9c1d2e-3a4b-4c5d-8e6f-0708090a0b0c"]);
  });

  test("US-004 AC17 boundary: a completed run also wipes its temp root", async () => {
    stubWipe();

    await cleanupRun(makeCleanupOptions({ runCompleted: true, dryRun: false }));

    expect(wipeCalls.map((call) => call.runId)).toEqual(["0f9c1d2e-3a4b-4c5d-8e6f-0708090a0b0c"]);
  });

  test("US-004 AC17 boundary: no runCompleted (abnormal exit) also wipes its temp root", async () => {
    stubWipe();

    await cleanupRun(makeCleanupOptions({ dryRun: false }));

    expect(wipeCalls.map((call) => call.runId)).toEqual(["0f9c1d2e-3a4b-4c5d-8e6f-0708090a0b0c"]);
  });

  test("US-004 AC18: a dry run does not wipe", async () => {
    stubWipe();

    await cleanupRun(makeCleanupOptions({ runCompleted: true, dryRun: true }));

    expect(wipeCalls).toHaveLength(0);
  });

  // #2300: the regression. The runner's `runId` is `buildRunId(workdir, …)`; the
  // session temp dirs were created under `runTmpRoot(runtime.runId)`. Handing the
  // wipe the first one removed `/tmp/nax/run-8a1b05ad-…`, which nothing creates.
  test("#2300: the wipe never sees the runner's run id", async () => {
    stubWipe();

    await cleanupRun(makeCleanupOptions({ runCompleted: false, dryRun: false }));

    const ids = wipeCalls.map((call) => call.runId);
    expect(ids).not.toContain("run-8a1b05ad-2026-09-29T07-32-15.243");
  });
```

- [ ] **Step 2: Add the required field to the other five `cleanupRun` test files**

`RunCleanupOptions.runtimeRunId` is required, so each file's options builder needs it. Add one line immediately after its existing `runId:` line:

- `test/unit/execution/lifecycle/run-cleanup.test.ts` (after line 62, `runId: "run-001",`) → `    runtimeRunId: "run-001",`
- `test/unit/execution/lifecycle/run-cleanup-locks.test.ts` (after line 25) → `  runtimeRunId: "run-cleanup-locks",`
- `test/unit/execution/lifecycle/run-cleanup-approvals-seal.test.ts` (after line 36) → `  runtimeRunId: "run-seal-cleanup",`
- `test/unit/execution/lifecycle/run-cleanup-sandbox.test.ts` (after line 17) → `  runtimeRunId: "run-p4",`
- `test/unit/execution/lifecycle/run-cleanup-scratchpad-wipe.test.ts` (after line 28) → `  runtimeRunId: "run-us004",`

- [ ] **Step 3: Run the tests to verify they fail**

```bash
AGENT=1 bun test test/unit/execution/lifecycle/ --timeout=30000
```

Expected: FAIL on `run-cleanup-run-tmp-wipe.test.ts` — the wipe still receives `run-8a1b05ad-2026-09-29T07-32-15.243`. The other five files fail to typecheck (or fail at runtime on the missing field) until Step 2's lines are in place; `bun run typecheck` is the authoritative check for that and is Step 6.

- [ ] **Step 4: Implement the field in `RunCleanupOptions`**

In `src/execution/lifecycle/run-cleanup.ts`, insert immediately after the `runId: string;` line inside `export interface RunCleanupOptions` (line 73):

```ts
  /**
   * US-004 / #2300 — `NaxRuntime.runId`, the `crypto.randomUUID()` that
   * `createRuntime` mints and the `AgentManager` forwards as
   * `AgentRunOptions.runId`. It is NOT `runId`: that one is
   * `buildRunId(workdir, …)`, which addresses status.json, the log file name and
   * the feature lock. Only this id addresses the tree `runTmpRoot` created, so
   * only this id may be handed to `wipeRunTmp`.
   */
  runtimeRunId: string;
```

- [ ] **Step 5: Use it in the wipe block**

Replace the block at `src/execution/lifecycle/run-cleanup.ts:373-387`:

```ts
  // US-004 — end-of-run run-temp wipe. Deliberately NOT gated on
  // `runCompleted`: a failed run's `/tmp` files are not kept for inspection,
  // because no later run can find them to clear. A dry run is a preview, not a
  // mutation, so it is skipped outright. Fail-open: a rejected wipe is logged
  // at warn and the run's verdict is unaffected — this is the finally block.
  if (!options.dryRun) {
    try {
      // #2300 — `runtimeRunId`, NEVER `runId`. The session temp dirs were
      // created under `runTmpRoot(runtime.runId)`; `rm(..., { force: true })` on
      // the path `runId` resolves to never raised, so every run's temp tree
      // survived the wipe that was meant to remove it.
      await _runCleanupDeps.wipeRunTmp(options.runtimeRunId);
    } catch (err) {
      logger?.warn("cleanup", "End-of-run run-temp wipe failed — continuing", {
        runtimeRunId: options.runtimeRunId,
        error: errorMessage(err),
      });
    }
  }
```

The early `const { runId, … } = options;` destructure at line 242 is unchanged — `runId` is still needed for `buildPostRunContext` and `releaseFeatureLock`.

- [ ] **Step 6: Pass `runtime.runId` from the runner**

In `src/execution/runner.ts`, add one key to the `_runnerDeps.cleanupRun({ … })` call, immediately after `runId,` at line 420:

```ts
        runId,
        // #2300 — the id the session temp dirs were created under. NOT `runId`:
        // `runtime.runId` is the `crypto.randomUUID()` that
        // `resolveDispatchLauncher` passed to `runTmpRoot`, and wiping under
        // `runId` removed a path that was never created.
        runtimeRunId: runtime.runId,
```

`runtime` is already destructured from `setupResult` at `src/execution/runner.ts:286`, and `cleanupRun` runs before `runtime.close()` in the outer `finally`, so `runtime.runId` is readable here.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
AGENT=1 bun test test/unit/execution/lifecycle/ test/unit/execution/runner-total.test.ts --timeout=30000
bun run typecheck
```

Expected: PASS; typecheck clean. `bun run typecheck` is what proves `runtimeRunId` is supplied at every construction site — if any other `RunCleanupOptions` literal exists, this is where it surfaces.

- [ ] **Step 8: Commit**

```bash
git add src/execution/lifecycle/run-cleanup.ts src/execution/runner.ts test/unit/execution/lifecycle/
git commit -m "fix(sandbox): wipe the run temp root under runtime.runId, not the runner id (#2300)"
```

**Rejection note — why this does not unify the two ids (do not "improve" on this in review).** The alternative fix #2300 lists — thread the runner's `buildRunId` into `createRuntime` so there is only one id — renames `cost/<runId>.jsonl`, `usage/<runId>.jsonl`, `prompt-audit/<feature>/<runId>.jsonl`, the review-audit files and the `runId` field of every log line from a uuid to `run-<hash>-<iso>`, and breaks `test/unit/runtime/runtime.test.ts:141` and `:474`, which pin `rt.runId` to `/^[0-9a-f-]{36}$/`. That is an observability-format change across the whole pipeline, not a temp-leak fix. Record it as a follow-up issue; do not fold it in here.

---

### Task 3: The regression test that would have caught #2300

The two existing test files each check one half in isolation: `run-tmp-wipe.test.ts` checks `runTmpRoot(runId)` on its own, and `run-cleanup-run-tmp-wipe.test.ts` checks the id the wipe receives through a stub. Neither asserts that the path the wipe removes is the path dispatch created. This task asserts exactly that, with the real filesystem at both ends and no stub on either side of the create→wipe boundary.

**Files:**
- Modify: `test/helpers/session-sandbox-deps.ts:61-68` (`ConfinedSessionOptions`) and `:128-133` (the `mkdir` stub)
- Create: `test/integration/execution/run-tmp-wipe.test.ts`

**Interfaces:**
- Consumes: `stubSessionSandboxDeps(deps, { mkdir: "real" })` — the new option value added in Step 1. `resolveDispatchLauncher(options, declared, sessionName)` from `@/agents/coding-tool-support-resolve`. `cleanupRun(options: RunCleanupOptions)` from `@/execution/lifecycle/run-cleanup`.
- Produces: `ConfinedSessionOptions.mkdir: "ok" | "fails" | "real"` (widened union; default stays `"ok"`).

- [ ] **Step 1: Widen the shared stub's `mkdir` option**

In `test/helpers/session-sandbox-deps.ts`, replace the `mkdir` line in `ConfinedSessionOptions` (line 62):

```ts
  /**
   * `"ok"` records the call and succeeds, `"fails"` rejects the way an unwritable
   * temp root does, and `"real"` records the call AND delegates to the production
   * `mkdir` — the mode a filesystem-level assertion needs, where the directory
   * under test must actually appear on disk.
   */
  readonly mkdir?: "ok" | "fails" | "real";
```

Then replace the `deps.mkdir` assignment (lines 128-133):

```ts
  // Captured before the overwrite, so `mkdir: "real"` still reaches the
  // production recursive mkdir the seam ships with.
  const realMkdir = deps.mkdir;
  deps.mkdir = async (path: string): Promise<void> => {
    events.push(`mkdir:${path}`);
    mkdirCalls.push(path);
    if (options.mkdir === "fails") throw new Error("EXDEV: cross-device link");
    if (options.mkdir === "real") await realMkdir(path);
  };
```

- [ ] **Step 2: Verify the helper change is backward compatible**

```bash
AGENT=1 bun test test/unit/agents/coding-tool-sandbox.test.ts test/unit/agents/coding-tool-support-resolve.test.ts --timeout=30000
```

Expected: PASS. Every existing caller passes no `mkdir`, so it still takes `"ok"`.

- [ ] **Step 3: Write the failing integration test**

Create `test/integration/execution/run-tmp-wipe.test.ts`:

```ts
/**
 * #2300 — the create side and the wipe side must agree on the run id.
 *
 * `resolveDispatchLauncher` builds every session temp dir under
 * `runTmpRoot(options.runId)` and `cleanupRun` wipes `runTmpRoot(<some id>)`.
 * Two unit suites each pinned one half — `run-tmp-wipe.test.ts` the path
 * resolution, `run-cleanup-run-tmp-wipe.test.ts` the id handed to a STUBBED wipe —
 * and nothing asserted that the two ids were the same. They were not: the create
 * side used `crypto.randomUUID()` (via `runtime.runId`) and the wipe side
 * `buildRunId(workdir, …)`, so `rm(…, { force: true })` targeted a path nothing
 * had created and every run's temp root survived its own wipe.
 *
 * This is the test that closes that gap: real `mkdir` on the create side, real
 * `fs.rm` on the wipe side, `_runCleanupDeps.wipeRunTmp` left unstubbed, and the
 * only assertion that matters — the run's own directory is gone afterwards.
 *
 * `/tmp/nax` is pinned absent through `_sessionTmpDeps`, so `runTmpRoot(id)` is
 * `<real /tmp>/nax/<id>` on any host. The run id carries the pid and a timestamp,
 * so the directory is unique to this test and a concurrent run is never touched.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import {
  assertDefined,
  cleanupTempDir,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeTempDir,
  stubSessionSandboxDeps,
  stubSessionTmpDeps,
  withDepsRestore,
  withSessionSandboxSeam,
} from "@test/helpers";
import { _sessionSandboxDeps } from "@/agents/coding-tool-sandbox";
import { resolveDispatchLauncher } from "@/agents/coding-tool-support-resolve";
import { cleanupRun } from "@/execution/lifecycle/run-cleanup";
import { _launcherDeps, _resetSandboxRegistryForTests, _sessionTmpDeps, runTmpRoot } from "@/sandbox";

/** Bash is what makes `resolveDispatchLauncher` ask for a launcher at all. */
const DECLARED = ["Bash"] as const;
/** The ledger session name the dispatch derives for a story + role. */
const SESSION_NAME = "US-2300-implementer";

describe("#2300 — the run temp root dispatch creates is the root cleanupRun wipes", () => {
  withDepsRestore(_sessionSandboxDeps);
  withSessionSandboxSeam(_sessionSandboxDeps);
  withDepsRestore(_sessionTmpDeps);
  withDepsRestore(_launcherDeps);

  let root: string;
  /** The runtime's uuid-shaped id — the one the create side uses. */
  const runtimeRunId = `2300-${process.pid}-${Date.now()}`;
  /** The runner's workdir-hashed id — the one the buggy wipe used. */
  const runnerRunId = "run-8a1b05ad-2026-09-29T07-32-15.243";
  let runRoot: string;

  beforeEach(() => {
    root = makeTempDir("run-tmp-lifecycle-");
    // US-001: `/tmp/nax` absent, so the run root of any id is `<tmp>/nax/<id>`.
    stubSessionTmpDeps(_sessionTmpDeps, { parent: "ENOENT" });
    runRoot = runTmpRoot(runtimeRunId);
    // The command itself is not the subject; the directory `ensureTmpDir` creates
    // before it is. runArgv is stubbed so nothing is spawned.
    _launcherDeps.runArgv = async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
    // `mkdir: "real"` — the create side must touch the real filesystem.
    stubSessionSandboxDeps(_sessionSandboxDeps, { mkdir: "real" });
  });

  afterEach(() => {
    cleanupTempDir(root);
    cleanupTempDir(runRoot);
    _resetSandboxRegistryForTests();
  });

  test("#2300: the directory a dispatched session creates is gone after cleanupRun", async () => {
    // ── create side: the production dispatch path, sandbox confinement on ──
    const launcher = await resolveDispatchLauncher(
      {
        codingToolRoot: root,
        runId: runtimeRunId,
        storyId: "US-2300",
        sessionRole: "implementer",
        config: makeNaxConfig({ execution: { sandbox: { enabled: true } } }),
      },
      DECLARED,
      SESSION_NAME,
    );
    assertDefined(launcher, "the dispatch launcher");
    expect(launcher.state).toEqual({ kind: "available", backend: "srt", network: "open", sharedTmp: false });

    await launcher.run({
      spec: { kind: "shell", shell: "/bin/sh", command: "true" },
      root,
      cwd: root,
      timeoutMs: 5000,
      stripEnvVars: [],
    });

    // The run's own root, with a real session dir under it.
    expect(existsSync(`${runRoot}/${SESSION_NAME}`)).toBe(true);

    // ── wipe side: the REAL wipeRunTmp, not the _runCleanupDeps stub ──
    await cleanupRun({
      runId: runnerRunId,
      runtimeRunId,
      startTime: Date.now() - 1000,
      totalCost: 0,
      storiesCompleted: 0,
      prd: makePRD({ feature: "us-2300" }),
      pluginRegistry: makePluginRegistry(),
      workdir: root,
      interactionChain: null,
      feature: "us-2300",
      prdPath: `${root}/.nax/features/us-2300/prd.json`,
      branch: "feat/us-2300",
      version: "1.0.0",
      hooks: { hooks: {} },
      runCompleted: false,
      dryRun: false,
    });

    expect(existsSync(runRoot)).toBe(false);
  });

  test("#2300: a second run's root under the same parent survives the wipe", async () => {
    // The wipe is run-scoped. A sibling run's directory shares the `/tmp/nax`
    // prefix, and a prefix sweep would take it with the run that ended.
    const siblingId = `${runtimeRunId}-sibling`;
    const siblingRoot = runTmpRoot(siblingId);
    await mkdir(siblingRoot, { recursive: true });

    try {
      await cleanupRun({
        runId: runnerRunId,
        runtimeRunId,
        startTime: Date.now() - 1000,
        totalCost: 0,
        storiesCompleted: 0,
        prd: makePRD({ feature: "us-2300" }),
        pluginRegistry: makePluginRegistry(),
        workdir: root,
        interactionChain: null,
        feature: "us-2300",
        prdPath: `${root}/.nax/features/us-2300/prd.json`,
        branch: "feat/us-2300",
        version: "1.0.0",
        hooks: { hooks: {} },
        runCompleted: false,
        dryRun: false,
      });

      expect(existsSync(siblingRoot)).toBe(true);
    } finally {
      cleanupTempDir(siblingRoot);
    }
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
AGENT=1 bun test test/integration/execution/run-tmp-wipe.test.ts --timeout=30000
```

Expected: FAIL on the first test with `expect(received).toBe(false)` — the run root still exists, because `cleanupRun` (as of Task 2 it now uses `runtimeRunId`, so this must be run **after** Task 2) removes it. To confirm the test has teeth, re-run it with `runtimeRunId: runnerRunId` in the `cleanupRun` options: the root must still be there, which is exactly the #2300 bug.

- [ ] **Step 5: Run the test to verify it passes**

```bash
AGENT=1 bun test test/integration/execution/run-tmp-wipe.test.ts --timeout=30000
```

Expected: PASS, 2 tests, 0 fail. The first assertion — `existsSync(runRoot)` is `false` — is the regression guard.

- [ ] **Step 6: Run the gates**

```bash
bun run typecheck
AGENT=1 bun run lint:biome
bun run check:test-satellites
bun run check:inline-test-mocks
```

Expected: all clean. `check:test-satellites` must pass because `run-tmp-wipe.test.ts` is a module name, not a ticket name.

- [ ] **Step 7: Commit**

```bash
git add test/helpers/session-sandbox-deps.ts test/integration/execution/run-tmp-wipe.test.ts
git commit -m "test(sandbox): assert the dispatched run temp root is the one cleanupRun wipes (#2300)"
```

---

### Task 4: A confined macOS policy denies `/tmp/claude` and stops granting it

**Files:**
- Modify: `src/sandbox/defaults.ts:22-23`
- Modify: `src/sandbox/policy-builder.ts:19-27` (imports), `:29-42` (`SandboxPolicyInput`), `:115-142` (`buildSandboxPolicy`)
- Modify (tests): `test/unit/sandbox/policy-builder.test.ts:1-42` (imports + `input()` helper) and `:197-206`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `SRT_MACOS_TMPDIR_PRIVATE_SPELLING = "/private/tmp/claude"` and `SRT_MACOS_TMPDIR_DENIES: readonly string[] = [SRT_MACOS_TMPDIR, SRT_MACOS_TMPDIR_PRIVATE_SPELLING]` — both in `src/sandbox/defaults.ts`, exported. **Not** re-exported from `src/sandbox/index.ts` (that barrel does not export `./defaults` today; do not change that).
  - `SandboxPolicyInput.confined?: boolean` — optional. Absent means NOT confined, so every construction outside `resolveSessionSandbox` (and `probeSandbox`'s hand-built policy) keeps today's behaviour.

- [ ] **Step 1: Write the failing tests**

In `test/unit/sandbox/policy-builder.test.ts`, widen the import on line 6 and add the constant check plus four policy tests.

Replace line 6:

```ts
import { buildSandboxPolicy, type SandboxPolicyInput } from "@/sandbox";
import { SRT_MACOS_TMPDIR_DENIES } from "@/sandbox/defaults";
```

Add these four tests inside `describe("buildSandboxPolicy")`:

```ts
  test("#2301: the deny list offers both the /tmp and the /private/tmp spelling", () => {
    // Measured 2026-09-30 on macOS with the project's srt 0.0.77: with
    // `/tmp/claude` existing, EITHER spelling alone denies the write, because srt
    // normalises a path that already exists. The pair is still what we emit,
    // because a not-yet-created directory keeps the spelling it was given — and
    // `literal()` collapses the pair to a single entry when they do resolve to
    // the same directory, so listing both costs nothing.
    expect(SRT_MACOS_TMPDIR_DENIES).toEqual(["/tmp/claude", "/private/tmp/claude"]);
  });

  test("#2301: a confined darwin session denies both spellings of srt's forced TMPDIR", () => {
    const policy = buildSandboxPolicy(input({ platform: "darwin", confined: true }));
    for (const spelling of ["/tmp/claude", "/private/tmp/claude"])
      expect(policy.denyWrite).toContain(realOrRaw(spelling));
  });

  test("#2301: a confined darwin session drops /tmp/claude from its write roots", () => {
    const policy = buildSandboxPolicy(input({ platform: "darwin", confined: true }));
    expect(policy.writeRoots).not.toContain(realOrRaw("/tmp/claude"));
    // The other macOS-only root is unrelated to TMPDIR and stays.
    expect(policy.writeRoots).toContain(join(home, "Library", "Caches"));
  });

  test("#2301: a shared-temp darwin session keeps today's behaviour", () => {
    // `confined` absent = shared roots = the opt-out posture. No deny, and the
    // write root is still granted, because srt points TMPDIR there and nax keeps
    // it as a write root for tools that hardcode /tmp.
    const policy = buildSandboxPolicy(input({ platform: "darwin" }));
    expect(policy.writeRoots).toContain(realOrRaw("/tmp/claude"));
    expect(policy.denyWrite).not.toContain(realOrRaw("/tmp/claude"));
  });

  test("#2301: a confined linux session is untouched — bwrap needs its own check", () => {
    const policy = buildSandboxPolicy(input({ platform: "linux", confined: true }));
    expect(policy.denyWrite).not.toContain(realOrRaw("/tmp/claude"));
    expect(policy.denyWrite).not.toContain(realOrRaw("/private/tmp/claude"));
  });
```

Rename the existing test at line 197 so the two macOS cases read as one decision rather than contradicting each other — its title currently promises `/tmp/claude` on every macOS session:

```ts
  test("write roots: root, temp roots, built-in caches; a SHARED macOS session adds /tmp/claude and ~/Library/Caches", () => {
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
AGENT=1 bun test test/unit/sandbox/policy-builder.test.ts --timeout=30000
```

Expected: FAIL — the `SRT_MACOS_TMPDIR_DENIES` import does not resolve, and the confined-darwin assertions see `/tmp/claude` in `writeRoots` with no matching deny.

- [ ] **Step 3: Add the constants**

In `src/sandbox/defaults.ts`, replace the `SRT_MACOS_TMPDIR` block at lines 22-23:

```ts
/** srt forces TMPDIR to this inside the macOS sandbox and does not create it (spec F3). */
export const SRT_MACOS_TMPDIR = "/tmp/claude";

/**
 * #2301 — the same directory through macOS's `/tmp` -> `/private/tmp` symlink.
 * A write against either spelling reaches the same inode, so a deny that carries
 * only one of them is a spelling the kernel may never match.
 */
export const SRT_MACOS_TMPDIR_PRIVATE_SPELLING = "/private/tmp/claude";

/**
 * #2301 — both spellings of srt's forced TMPDIR, as a deny list.
 *
 * srt always includes `/tmp/claude` and `/private/tmp/claude` in
 * `SANDBOX_OWN_WRITE_PATHS` and `getDefaultWritePaths` never drops them, so the
 * only way to take the write back is an explicit `denyWrite` — srt writes its deny
 * rules after the allow rules on macOS, and a later deny wins.
 */
export const SRT_MACOS_TMPDIR_DENIES: readonly string[] = [SRT_MACOS_TMPDIR, SRT_MACOS_TMPDIR_PRIVATE_SPELLING];
```

- [ ] **Step 4: Add the `confined` input**

In `src/sandbox/policy-builder.ts`, extend the `./defaults` import block (lines 19-24) with `SRT_MACOS_TMPDIR_DENIES` in alphabetical position:

```ts
import {
  BUILTIN_CACHE_WRITE_ROOTS,
  BUILTIN_CREDENTIAL_READ_DENIES,
  MACOS_CACHE_WRITE_ROOT,
  SRT_MACOS_TMPDIR,
  SRT_MACOS_TMPDIR_DENIES,
} from "./defaults";
```

Then insert into `SandboxPolicyInput` after `readonly tempRoots: readonly string[];` (line 39):

```ts
  /**
   * #2301: this session confines temp writes to its own run temp root
   * (`SandboxState.sharedTmp === false`). Absent means it did NOT confine, which
   * keeps every construction outside `resolveSessionSandbox` — and the probe's
   * own hand-built policy — on today's behaviour.
   */
  readonly confined?: boolean;
```

- [ ] **Step 5: Implement the policy change**

In `src/sandbox/policy-builder.ts`, replace the body of `buildSandboxPolicy` (lines 115-142) with:

```ts
export function buildSandboxPolicy(input: SandboxPolicyInput): SandboxPolicy {
  const { root, home, config } = input;
  const darwin = input.platform === "darwin";
  // #2301: a CONFINED session does not need srt's forced TMPDIR. srt always
  // allows `/tmp/claude` (and always points `TMPDIR` at it) on macOS, and its
  // deny rules are written AFTER the allow rules, so the only way to take the
  // write back is an explicit deny — which is what a confined session gets, on
  // both spellings. Both, because srt normalises a path that already exists: on a
  // host where `/tmp/claude` exists either spelling alone denies (measured
  // 2026-09-30 on macOS + srt 0.0.77), but a not-yet-created directory keeps the
  // spelling it was given, and `literal()` collapses the pair to one entry when
  // they do resolve to the same directory, so the list is free either way.
  // Nothing needs the root instead: `createCommandLauncher` prefixes every
  // wrapped command with `export TMPDIR=<session dir> TMP=… TEMP=…`
  // (src/sandbox/launcher.ts:62), which replaces srt's value before the agent's
  // command runs. A shared-temp session (`allowSharedTmp: true`) keeps the grant,
  // because there srt's TMPDIR is still the directory the agent is told to use.
  const confined = input.confined === true;
  const writeRoots = literal([
    root,
    ...worktreeGitWriteRoots(input.git),
    ...input.tempRoots,
    ...(darwin ? [...(confined ? [] : [SRT_MACOS_TMPDIR]), join(home, MACOS_CACHE_WRITE_ROOT)] : []),
    ...BUILTIN_CACHE_WRITE_ROOTS.map((rel) => join(home, rel)),
    ...config.filesystem.allowWrite.map((p) => {
      const expanded = expandHome(p, home);
      return isAbsolute(expanded) ? expanded : resolve(root, expanded);
    }),
  ]);
  const denyWrite = literal([
    ...naxDenies(root, input.naxEntries, config.filesystem.allowWrite),
    ...[...QUEUE_CONTROL_FILES].map((name) => join(root, name)),
    ...gitDenies(root, input.git),
    ...input.gitGuardFiles,
    ...(input.approvalsFile !== undefined ? [input.approvalsFile] : []),
    ...(darwin && confined ? SRT_MACOS_TMPDIR_DENIES : []),
  ]);
  const denyRead = literal([
    ...BUILTIN_CREDENTIAL_READ_DENIES.map((rel) => join(home, rel)),
    ...input.credentialFiles,
    ...config.filesystem.denyRead.map((p) => resolve(root, expandHome(p, home))),
  ]);
  const allowed = config.network.allowedDomains;
  return { writeRoots, denyWrite, denyRead, network: allowed === undefined ? {} : { allowedDomains: [...allowed] } };
}
```

The only new branch is `confined ? [] : [...]`, inside `buildSandboxPolicy` — not `cleanupRun`, so the complexity ratchet is untouched.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
AGENT=1 bun test test/unit/sandbox/ --timeout=30000
bun run typecheck
```

Expected: PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/sandbox/defaults.ts src/sandbox/policy-builder.ts test/unit/sandbox/policy-builder.test.ts
git commit -m "fix(sandbox): deny /tmp/claude on both spellings for a confined macOS session (#2301)"
```

---

### Task 5: Thread the resolved confinement decision into the policy

`buildSandboxPolicy` needs to know whether the session actually confined. It must be the **resolved** value from `sessionTempRoots`, not `config.filesystem.allowSharedTmp`: that flag is `false` in the fail-open case and in the no-run-root case too, and reading it would deny a session that is running on the shared roots.

**Files:**
- Modify: `src/agents/coding-tool-sandbox.ts:133-146` (`policyFor`)
- Modify (tests): `test/unit/agents/coding-tool-sandbox.test.ts:357-373`

**Interfaces:**
- Consumes: `SandboxPolicyInput.confined` from Task 4.
- Produces: nothing new — `resolveSessionSandbox` passes the `confined` boolean `sessionTempRoots` already returns (`src/agents/coding-tool-sandbox.ts:74`).

- [ ] **Step 1: Write the failing tests**

In `test/unit/agents/coding-tool-sandbox.test.ts`, replace the two tests at lines 357-373 — they encode the behaviour #2301 reverses:

```ts
  test("#2301: a confined darwin session denies both spellings and drops the write root", async () => {
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps, { platform: "darwin" });
    const launcher = await resolveSessionSandbox(confinedArgs());

    await launcher.run(launchRequest());

    const policy = wrappedPolicy(seam);
    for (const spelling of ["/tmp/claude", "/private/tmp/claude"])
      expect(policy.denyWrite).toContain(realOrRaw(spelling));
    expect(policy.writeRoots).not.toContain(realOrRaw("/tmp/claude"));
  });

  test("#2301 boundary: a confined linux session denies neither spelling", async () => {
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps, { platform: "linux" });
    const launcher = await resolveSessionSandbox(confinedArgs());

    await launcher.run(launchRequest());

    const policy = wrappedPolicy(seam);
    expect(policy.denyWrite).not.toContain(realOrRaw("/tmp/claude"));
    expect(policy.denyWrite).not.toContain(realOrRaw("/private/tmp/claude"));
  });

  test("#2301 boundary: a SHARED darwin session still gets the /tmp/claude write root", async () => {
    // No run root, no session dir: the session runs on the shared roots, srt's
    // TMPDIR is still the directory it advertises, and the deny must not fire.
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps, { platform: "darwin" });
    const launcher = await resolveSessionSandbox(sharedArgs());

    await launcher.run(launchRequest());

    const policy = wrappedPolicy(seam);
    expect(policy.writeRoots).toContain(realOrRaw("/tmp/claude"));
    expect(policy.denyWrite).not.toContain(realOrRaw("/tmp/claude"));
  });

  test("#2301 boundary: a FAILED mkdir leaves the shared roots and denies nothing", async () => {
    // `allowSharedTmp` is false here too, so a policy that read the config flag
    // instead of the resolved decision would deny a session that is not confined.
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps, { platform: "darwin", mkdir: "fails" });
    const launcher = await resolveSessionSandbox(confinedArgs());

    await launcher.run(launchRequest());

    const policy = wrappedPolicy(seam);
    expect(policy.writeRoots).toContain(realOrRaw("/tmp"));
    expect(policy.denyWrite).not.toContain(realOrRaw("/tmp/claude"));
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
AGENT=1 bun test test/unit/agents/coding-tool-sandbox.test.ts --timeout=30000
```

Expected: FAIL on the confined-darwin test — `/tmp/claude` is still in `writeRoots` and absent from `denyWrite`, because `resolveSessionSandbox` does not pass `confined` yet.

- [ ] **Step 3: Pass `confined` into the policy**

In `src/agents/coding-tool-sandbox.ts`, add one line to the `buildSandboxPolicy({ … })` call inside `policyFor`, immediately after `tempRoots,` (line 143):

```ts
      tempRoots,
      // #2301: the RESOLVED confinement, not `config.filesystem.allowSharedTmp`.
      // A session confines only when a run root AND a session dir were supplied
      // AND the dir was created; the config flag is false in the fail-open and
      // no-run-root cases too, so reading it here would deny a session running
      // on the shared roots.
      confined,
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
AGENT=1 bun test test/unit/agents/coding-tool-sandbox.test.ts test/unit/agents/coding-tool-support-resolve.test.ts test/unit/sandbox/ --timeout=30000
bun run typecheck
```

Expected: PASS; typecheck clean.

- [ ] **Step 5: Check the denial hint needs no change**

`denialHintLine(policy.writeRoots, sharedTmp)` (`src/sandbox/messages.ts:52`) lists `policy.writeRoots`. With `/tmp/claude` no longer among them, a confined session's hint drops it automatically — this closes issue #2301's "out of scope / open" item with no code. Confirm by reading, do not edit `src/sandbox/messages.ts`:

```bash
AGENT=1 bun test test/unit/sandbox/messages.test.ts --timeout=30000
```

- [ ] **Step 6: Commit**

```bash
git add src/agents/coding-tool-sandbox.ts test/unit/agents/coding-tool-sandbox.test.ts
git commit -m "fix(sandbox): pass the resolved confinement decision into the sandbox policy (#2301)"
```

- [ ] **Step 7 (added by the Task 4 review ruling): a dropped `TMPDIR` override must stop the deny**

Task 4's reviewer established that the deny this task wires up breaks a case the project's own spec forbids. `docs/specs/SPEC-tmp-confinement.md:132` and `src/agents/coding-tool-sandbox.ts:66-69` both state a session must never be left with a `TMPDIR` its sandbox cannot write.

The mechanism: `createCommandLauncher.run()` computes the effective dir as

```ts
const tmpDir = env.tmpDir !== undefined && (await ensureTmpDir(env.tmpDir)) ? env.tmpDir : undefined;
```

(`src/sandbox/launcher.ts:179`). When that second `mkdir` fails, `runWrapped` omits the `export TMPDIR=…` prefix (`:123`) and srt's own `/tmp/claude` becomes the child's `TMPDIR` — which the Task 4 deny now blocks, so `mktemp` fails for that session while the agent's own hint (`src/sandbox/messages.ts:53`) tells it to use `$TMPDIR`.

Fix: forward the **effective** confinement into `policyFor`, so a session that ended up without its own `TMPDIR` does not carry the deny.

In `src/sandbox/types.ts`, widen the policy builder so it can be told whether the override is actually in force:

```ts
export interface CommandLauncherOptions {
  readonly state: SandboxState;
  readonly backend?: SandboxBackend;
  /**
   * Build the policy for one command. `confined` is the EFFECTIVE confinement as
   * of this launch — false when the session's own `TMPDIR` override could not be
   * created (#2301), because srt's forced `TMPDIR` then applies instead.
   */
  readonly policyFor?: (root: string, confined: boolean) => Promise<SandboxPolicy>;
  ...
}
```

In `src/sandbox/launcher.ts`, pass it at the call site in `run()` (`:190`):

```ts
        return await runWrapped(req, opts.backend, await opts.policyFor(req.root, env.tmpDir !== undefined && tmpDir !== undefined), { ...env, tmpDir });
```

In `src/agents/coding-tool-sandbox.ts`, accept it in the closure and use it instead of the captured `confined`:

```ts
  const policyFor = async (root: string, overrideInForce: boolean) =>
    buildSandboxPolicy({
      ...
      // #2301: the RESOLVED confinement, narrowed by whether this command will
      // actually get the session's `TMPDIR`. When `ensureTmpDir` failed, srt's own
      // `/tmp/claude` becomes the child's TMPDIR, and denying it would leave the
      // session with a TMPDIR its own sandbox refuses to write — the one posture
      // SPEC-tmp-confinement.md:132 rules out.
      confined: confined && overrideInForce,
```

Add a test to `test/unit/agents/coding-tool-sandbox.test.ts` for the launcher-level narrowing, using `_launcherDeps.mkdir` to reject:

```ts
  test("#2301: a command whose session dir cannot be re-created stops carrying the /tmp/claude deny", async () => {
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps, { platform: "darwin" });
    // The resolve-time mkdir succeeds (so the session IS confined), but the
    // per-launch one fails, so no `export TMPDIR=` prefix is applied.
    _launcherDeps.mkdir = async () => {
      throw new Error("EROFS: read-only file system");
    };
    const launcher = await resolveSessionSandbox(confinedArgs());

    await launcher.run(launchRequest());

    const policy = wrappedPolicy(seam);
    expect(policy.denyWrite).not.toContain(realOrRaw("/tmp/claude"));
    // The rest of the confinement is untouched: the run's own root is still the
    // only temp write root.
    expect(policy.writeRoots).toContain(realOrRaw(RUN_TMP_ROOT));
  });
```

- [ ] **Step 8 (added by the Task 4 review ruling): run the full gate set**

```bash
AGENT=1 bun test test/unit/agents/ test/unit/sandbox/ --timeout=30000
bun run typecheck
AGENT=1 bun run check:all
```

Note that `test/unit/agents/coding-tool-sandbox.test.ts:357-373` (`US-002 AC20`) is **expected to fail** once `confined` is threaded — that test pins the behaviour #2301 reverses, and Step 1 of this task replaces it. If it still fails after Step 1, you missed a replacement.

- [ ] **Step 9: Commit the ruling-A work separately**

```bash
git add src/sandbox/types.ts src/sandbox/launcher.ts src/agents/coding-tool-sandbox.ts test/unit/agents/coding-tool-sandbox.test.ts
git commit -m "fix(sandbox): stop the /tmp/claude deny when the session TMPDIR override is not in force (#2301)"
```

This is a separate commit from Step 6 on purpose: it is a behaviour fix discovered during review, not part of the original wiring, and a reviewer may reasonably want to evaluate it on its own.

---

### Task 6: The live darwin proof

Unit tests assert the policy nax builds. This asserts what the kernel does with it, against real srt — the only place the "srt writes deny rules after allow rules" claim can be confirmed.

**Files:**
- Modify: `test/integration/sandbox/sandbox-live.test.ts:358-417` (the `describe("US-002 — …")` block)

**Interfaces:**
- Consumes: `confinedLauncher(runRoot, sessionDir)` and `request(command)` already defined in that describe block (lines 366-384). Nothing new is exported.
- Produces: nothing.

- [ ] **Step 1: Write the test**

Inside the existing `describe("US-002 — the run's own temp root is the only writable temp root")`, after the test at line 401, add:

```ts
    // #2301. srt always allows `/tmp/claude` on macOS regardless of the policy,
    // and it writes deny rules AFTER the allow rules, so the deny is the only
    // thing that takes the write back. This is the assertion that proves it: on
    // the unit side we only see the policy nax built.
    test.skipIf(process.platform !== "darwin")(
      "#2301: a write straight into /tmp/claude is refused and leaves nothing behind",
      async () => {
        const { runRoot, sessionDir } = makeRun();
        const stray = `/tmp/claude/nax-2301-${process.pid}-${Date.now()}.txt`;
        try {
          const launcher = await confinedLauncher(runRoot, sessionDir);

          const result = await launcher.run(request(`echo x > ${stray}`));

          expect(result.exitCode).not.toBe(0);
          expect(existsSync(stray)).toBe(false);
        } finally {
          if (existsSync(stray)) rmSync(stray, { force: true });
          cleanupTempDir(runRoot);
        }
      },
      60_000,
    );

    test.skipIf(process.platform !== "darwin")(
      "#2301 boundary: writing through $TMPDIR and a heredoc still work",
      async () => {
        // The deny is specific to srt's own TMPDIR. The session temp dir and the
        // heredoc temp file the shell creates under it are what the agent is told
        // to use, and they must keep working.
        const { runRoot, sessionDir } = makeRun();
        try {
          const launcher = await confinedLauncher(runRoot, sessionDir);

          const result = await launcher.run(
            request('cat <<\'EOF\' > "$TMPDIR/heredoc.txt"\nbody\nEOF\necho ok'),
          );

          expect(result.exitCode).toBe(0);
          expect(existsSync(join(sessionDir, "heredoc.txt"))).toBe(true);
        } finally {
          cleanupTempDir(runRoot);
        }
      },
      60_000,
    );
```

`existsSync`, `rmSync` and `join` are already imported at lines 15-16.

- [ ] **Step 2: Run the live suite**

```bash
AGENT=1 bun test test/integration/sandbox/sandbox-live.test.ts --timeout=30000
```

Expected on this macOS host with srt available: PASS, both new tests included. If the suite reports `SKIPPED:` in its describe title, srt is unavailable here and the tests cannot run — record that and rely on Task 4's unit coverage; do not mark this step passed on a skip.

- [ ] **Step 3: Commit**

```bash
git add test/integration/sandbox/sandbox-live.test.ts
git commit -m "test(sandbox): prove a confined macOS session cannot write to /tmp/claude (#2301)"
```

---

### Task 7: Record the two amendments

ADR-030's 2026-09-28 amendment, decision 2, states "srt's own `/tmp/claude` on macOS is unaffected" — that clause is what #2301 reverses, so the ADR has to carry the reversal or the next reader will re-derive the old answer. `docs/guides/sandbox-and-command-safety.md` tells agents which roots are writable, and `docs/specs/SPEC-tmp-confinement.md` is the design record for the feature both issues amend.

**Files:**
- Modify: `docs/adr/ADR-030-bash-approval-modes.md` (append a new `## Amendment — 2026-09-30:` section at the end)
- Modify: `docs/guides/sandbox-and-command-safety.md:70` and `:126`
- Modify: `docs/specs/SPEC-tmp-confinement.md` (append an amendment section; do not rewrite the body)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing executable.

- [ ] **Step 1: Append the ADR amendment**

Append to the end of `docs/adr/ADR-030-bash-approval-modes.md`:

```markdown
## Amendment — 2026-09-30: a confined macOS session loses `/tmp/claude` (#2301)

### What changed

Decision 2 of the 2026-09-28 amendment ended: *"srt's own `/tmp/claude` on macOS is
unaffected."* That is no longer true for a confined session.

`@anthropic-ai/sandbox-runtime` (0.0.77) always includes `/tmp/claude` and
`/private/tmp/claude` in `SANDBOX_OWN_WRITE_PATHS`; `getDefaultWritePaths` never
drops them whatever the policy says. On macOS srt writes its `denyWrite` rules
AFTER the allow rules, so a deny is the only thing that takes the write back.

### Decision

1. **A CONFINED session on darwin denies both spellings of srt's forced TMPDIR, and
   loses it as a write root.** Measured 2026-09-30 on macOS with the project's
   srt 0.0.77: with `/tmp/claude` existing, either spelling alone denies the write,
   because srt normalises a path that already exists — but a not-yet-created
   directory keeps the spelling it was given, so the list carries both and
   `literal()` collapses the pair to a single entry when they resolve alike.
   `/tmp` is a symlink to `/private/tmp` on macOS; the policy always carries the
   spelling the kernel sees.
2. **The write root is dropped for the same sessions.** Nothing needs it: the launcher
   prefixes every wrapped command with `export TMPDIR=<session dir> TMP=… TEMP=…`,
   which replaces srt's value before the agent's command runs.
3. **`allowSharedTmp: true` keeps the grant and takes no deny.** There srt's TMPDIR is
   still the directory the agent is told to use, so removing it would break the
   opt-out's whole purpose.
4. **The decision is the RESOLVED confinement, not the config flag.**
   `config.filesystem.allowSharedTmp` is `false` in the fail-open and no-run-root
   cases too; those sessions run on the shared roots and must not be denied.
5. **darwin only.** srt's Linux (bwrap) backend handles `/tmp/claude` differently and
   needs its own check before a deny is added there. Out of scope, recorded.
6. **The host-side `mkdir /tmp/claude` stays.** `sandboxBackendFor` builds one
   process-wide backend from `network` alone (`src/sandbox/registry.ts:21`); it cannot
   see a per-session decision, and a shared-temp session still needs the directory.

### Consequences

- `/tmp/claude` is no longer the one temp location a confined macOS session can write
  outside its own run root. It was shared by every run and never wiped.
- The denial hint drops `/tmp/claude` on its own: it lists `policy.writeRoots`
  (`src/sandbox/messages.ts:52`), which no longer contains it.
- A confined macOS session whose tooling genuinely depends on `/tmp/claude` now fails
  with "Operation not permitted". The escape hatches are unchanged and still work:
  `allowSharedTmp: true`, or a specific `filesystem.allowWrite` entry.

### Related

#2301. The end-of-run wipe bug this amendment's sibling fixed is #2300: the wipe used
the runner's `buildRunId(...)` while the session dirs were created under
`runtime.runId`, so it removed a path nothing had created.
```

- [ ] **Step 2: Update the writable-roots table in the agent guide**

In `docs/guides/sandbox-and-command-safety.md`, replace line 70:

```markdown
| **Writable** | the story root (repo or worktree); this run's temp root under `/tmp/nax/` (or `/tmp/nax-<uid>` when the shared parent is unusable), which is also where `$TMPDIR` points; the system temp dir and `/tmp` only with `filesystem.allowSharedTmp`; package-manager caches under `$HOME` (`.bun/install/cache`, `.npm`, `.cache`, `.cargo/registry`, `.cargo/git`, `go/pkg/mod`, `.gradle/caches`, `.m2/repository`, `.pnpm-store`; plus `Library/Caches` on macOS, and `/tmp/claude` on macOS only when the shared temp roots are granted); `filesystem.allowWrite` |
```

Add a row to the same table, immediately after **Write-denied inside those**:

```markdown
| **Write-denied on macOS, when confined** | `/tmp/claude` and `/private/tmp/claude`. srt always allows that directory, so the deny is the only thing that takes the write back; a confined session does not need it, because `$TMPDIR` already points inside the run's own root. Not denied when `filesystem.allowSharedTmp` is `true`. |
```

Then update the `filesystem.allowSharedTmp` row at line 126:

```markdown
| `filesystem.allowSharedTmp` | `false` | By default the sandbox confines temp writes to this run's temp root (`/tmp/nax/<runId>/...`, where `$TMPDIR` points), and on macOS denies `/tmp/claude` outright; set `true` to re-grant the system temp dir, `/tmp` and `/tmp/claude` for commands a tool hardcodes against. |
```

- [ ] **Step 3: Append the spec amendment**

Append to the end of `docs/specs/SPEC-tmp-confinement.md`:

```markdown
## Amendment — 2026-09-30: post-implementation defects (#2300, #2301)

Two defects shipped with this feature. Both are recorded here rather than folded
into the body above, because the body is the design that was approved.

### #2300 — the end-of-run wipe never fired

This spec's US-001 kept the wipe run-scoped, and US-004 added
`wipeRunTmp(runId)` to `cleanupRun`. The id it was handed was the runner's
`buildRunId(workdir, …)`; the directories it was meant to remove were created under
`runtime.runId` (`crypto.randomUUID()`), because `resolveDispatchLauncher` threads
`AgentRunOptions.runId` — which is the runtime's — into `runTmpRoot`. `rm(…, { force:
true })` on the resulting missing path does not raise, so every run's temp root
survived its own wipe and no log line recorded it.

The fix adds a second, separately-named option, `RunCleanupOptions.runtimeRunId`, and
wipes under that. The two ids are NOT unified: doing so would rename every
`cost/<runId>.jsonl`, `usage/<runId>.jsonl`, `prompt-audit/<feature>/<runId>.jsonl` and
log line from a uuid to `run-<hash>-<iso>`, which is an observability-format change
across the whole pipeline and needs its own decision. `wipeRunTmp` now checks for the
target's existence so an absent one is recorded at debug.

### #2301 — a confined macOS session could still write `/tmp/claude`

This spec's Approach says: *"The darwin `/tmp/claude` root that srt needs stays,
because `buildSandboxPolicy` adds it independently of `tempRoots`."* That was right
about `buildSandboxPolicy` and wrong about srt: `SANDBOX_OWN_WRITE_PATHS` always
contains `/tmp/claude` and `/private/tmp/claude`, `getDefaultWritePaths` never drops
them, and srt writes macOS deny rules after the allow rules.

A confined session does not need the directory — the launcher's
`export TMPDIR=<session dir> TMP=… TEMP=…` prefix replaces srt's value before the
agent's command runs — so for `platform: "darwin"` with the RESOLVED confinement the
write root is dropped and both spellings are added to `denyWrite`. `allowSharedTmp:
true` keeps today's behaviour. darwin only; srt's Linux backend needs its own check
before a deny is added there. `SandboxPolicyInput` gains `confined?: boolean`, absent
meaning not confined, so the probe's own policy and every other construction are
unchanged.

Supersedes US-002 acceptance criterion 13, which asserted the opposite
(*"the policy passed to `wrap` has `writeRoots` including `realOrRaw("/tmp/claude")`"*
on darwin). That criterion was correct against srt's behaviour at the time and is
wrong against confinement's goal now.
```

- [ ] **Step 4: Verify the docs gates**

```bash
bun run check:review-prompts
bun run check:no-control-bytes
```

Expected: clean. Neither touches these files, but they run in CI.

- [ ] **Step 5: Commit**

```bash
git add docs/adr/ADR-030-bash-approval-modes.md docs/guides/sandbox-and-command-safety.md docs/specs/SPEC-tmp-confinement.md
git commit -m "docs(sandbox): record the #2300 and #2301 amendments to temp confinement"
```

---

## Verification

Run in the worktree, in order. Every gate below is part of `AGENT=1 bun run lint`.

```bash
AGENT=1 bun run lint          # biome + all check:* gates
bun run typecheck             # tsc --noEmit, then -p tsconfig.test.json
bun run test                  # unit + integration + ui phases
bun run test:coverage         # per-file coverage floor (CI runs this)
```

Expected results:

- `bun run typecheck` — clean.
- `bun run lint` — clean. In particular `check:test-satellites`, `check:file-sizes`, `check:complexity`, `check:inline-test-mocks` and `check:dispatch-field-forwarding`.
- `bun run test` — **21613 pass / 3 fail**. The three failures are the pre-existing `test/unit/scripts/check-complexity.test.ts` baseline-staleness failures recorded in Global Constraints, unrelated to this work. Any OTHER failure is a regression from these tasks.
- `bun run test:coverage` — no new baseline entries needed; every `src/` file touched already has tests and none is listed in `scripts/baselines/coverage-per-file-baseline.json`.

Manual confirmation on a real run (optional, needs an agent dispatch):

```bash
ls /tmp/nax            # before: one uuid-named root per completed run
# … run `nax run` to completion …
ls /tmp/nax            # after: the root for THAT run is gone; a concurrent run's is not
```

## Out of Scope

Recorded deliberately, with reasons — do not implement any of these inside this plan.

- **Unifying the two run ids.** Renames every cost/usage/prompt-audit filename and log line's `runId`; breaks `test/unit/runtime/runtime.test.ts:141,474`. Its own issue. See Task 2's rejection note.
- **The `denyWrite` on Linux.** Issue #2301 tested macOS only; srt's bwrap backend handles `/tmp/claude` differently and needs its own probe before a deny is added there.
- **The host-side `mkdir /tmp/claude` in `srt-backend.ts:59`.** `sandboxBackendFor` builds one process-wide backend from `network` alone, so it cannot see a per-session decision, and a shared-temp session still needs the directory because srt still points `TMPDIR` there and nax keeps it as a write root. Issue #2301 lists this as optional; it stays.
- **A `/tmp/nax*` sweep of stale roots from crashed runs.** Rejected by US-001 and reaffirmed in this spec's Out of Scope: a concurrent run's live directories share the prefix.
- **Cleaning up the existing `/tmp/nax` leftovers.** The fix is forward-looking; a one-off `rm -rf /tmp/nax/<uuid>` sweep is an operator action, not a code change.
- **`src/sandbox/messages.ts`.** The denial hint lists `policy.writeRoots`, which no longer contains `/tmp/claude` — no edit needed.
