# PR 1: Command-CWD Split + Per-Package Declared Commands — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Goal

Thread the execution cwd for declared (non-Exec) `RunCommand` calls independently
of `ctx.root`/`codingToolRoot`, and resolve the declared-command map (and the
other `quality`-derived fields around it) from the story's own **package**
config via `loadConfigForPackage`, not whatever config the dispatch happened to
be threaded with. This is the #2066 residual named in the single-frame-redesign
design: today `ctx.root` already equals the package dir, so nothing user-visible
breaks yet, but PR 2 repoints `codingToolRoot` at the story's repo-rooted
execution root — and without this PR done first, that move would silently turn
every package story's declared `test` command into a whole-repo run.

## Architecture

Two independent values are threaded from `callOp` (`src/operations/call.ts`)
through `AgentRunOptions` into `resolveCodingToolSupport`: `projectDir` (the
repo root holding `.nax/`, stable across PR 2) and `codingToolPackageDir` (the
story's package dir, relative — `PackageView.packageDir`, also stable).
`resolveCodingToolSupport` combines them with `packageWorkdir()` to compute a
`commandCwd` independent of `codingToolRoot`, and separately resolves the
story's per-package `NaxConfig` via `loadConfigForPackage` (cached by
`packageConfigCache`) to build the declared-command map. Both values flow
through `buildCodingToolSupport` into `createRunCommandTool`'s
`RunCommandToolOptions.commandCwd`, which `run-command.ts`'s declared branch
now passes to `runQualityCommand` instead of `ctx.root`.

## Tech Stack

Bun 1.4+, TypeScript strict, `bun:test`, Biome. No new dependencies.

**Spec:** docs/superpowers/specs/2026-09-18-single-frame-redesign-design.md

## Global Constraints

- Bun-native only (`Bun.file`/`Bun.write`/`Bun.spawn`) — no Node.js fs/child_process equivalents.
- DI via the `_deps` object pattern — never `mock.module()`.
- `src/` files: 600-line hard cap. `src/operations/call.ts` is AT the cap (600 lines) today — it may not grow; this plan extracts from it instead. `src/tools/policy.ts` (595) and other capped files are not touched by this plan and must not grow either.
- Test files: 800-line hard cap.
- Every `logger.*` call inside a pipeline/tool/agent module includes `storyId` first in its data object.
- Errors that are genuinely exceptional use `NaxError` with `{ stage, ... }` context; a recoverable per-package config load failure logs a warning and falls back (mirrors `acceptance-setup.ts`'s own pattern), it does not throw.
- Per-package config resolution goes through `loadConfigForPackage(projectDir, packageDir, from)` only — never `loadConfigForWorkdir` directly, never `packageView.config`. `scripts/check-config-profile-threading.ts` enforces the direct-`loadConfigForWorkdir` half of this; calling `loadConfigForPackage` satisfies it automatically.
- Barrel imports for `src/`, `bin/`, `scripts/` (tests may reach internals per `test-architecture.md`).
- Conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`); one logical concern per commit; no `[run-release]` unless told to.
- Test commands: `bun run typecheck`, `bun run lint`, `bun run test` (never bare `bun test` for the suite); targeted iteration uses `timeout 30 bun test <path> --timeout=30000`. `bun run test:coverage` is run manually at the end (not part of `check:all`).
- No placeholders, no "TBD", no "similar to Task N" — every step below is real code.

---

## Task 1 — Extract `call.ts`'s `runOptions` construction; thread `projectDir` + `codingToolPackageDir`

**Files:**
- Create: `src/operations/call-run-options.ts`
- Modify: `src/operations/call.ts` (imports at `:1-30`; the `runOptions` object literal at `:232-270`)

**Interfaces:**
- Produces: `buildRunDispatchOptions(ctx: CallContext, params: RunDispatchOptionsParams): AgentRunOptions`-shaped object (structurally compatible; not literally typed `AgentRunOptions` because it omits fields the caller doesn't have yet — TypeScript structurally widens it when assigned).
- Produces: `RunDispatchOptionsParams` interface (exported).
- Consumes: `CallContext` (`src/operations/types.ts`, unchanged), `packageWorkdir`/`storyExecRoot` (`src/runtime/packages.ts`, unchanged), `resolveDeclaredTools` (`src/operations/types.ts`, unchanged).
- Downstream consumer (Task 5): `options.projectDir` and `options.codingToolPackageDir` on `AgentRunOptions`, produced here at the two new unconditional keys in the returned object.

### Why this task exists first

`src/operations/call.ts` is 600 lines today — exactly the hard cap — so adding
the two new `runOptions` keys in place would push it over. The existing
`runOptions` object literal (`:232-270`, 39 lines) is self-contained enough to
extract as a pure function; doing so removes ~35 lines from `call.ts` (net,
after also deleting the now-unused `packageWorkdir`/`storyExecRoot` import),
giving headroom for this PR and the ones after it.

### Steps

- [ ] **1.1 — Write the new module with the two new fields, calling it from nowhere yet.**

  Create `src/operations/call-run-options.ts`:

  ```typescript
  /**
   * Builds the AgentRunOptions literal callOp hands to runWithFallback for a
   * run-kind dispatch.
   *
   * Extracted out of call.ts (single-frame redesign PR1,
   * docs/superpowers/specs/2026-09-18-single-frame-redesign-design.md) so
   * call.ts — already at the 600-line hard cap — has room to thread the two
   * new PR1 fields (`projectDir`, `codingToolPackageDir`) without growing
   * past it.
   */

  import { DEFAULT_CONFIG } from "../config";
  import type { ModelDef, ModelTier, NaxConfig } from "../config";
  import { packageWorkdir, storyExecRoot } from "../runtime/packages";
  import type { SessionRole } from "../session/types";
  import type { CodingToolName, ToolPatternNarrowing } from "../tools";
  import type { CallContext } from "./types";

  export interface RunDispatchOptionsParams {
    readonly prompt: string;
    readonly effectiveTier: ModelTier;
    readonly dispatchModelDef: ModelDef;
    readonly timeoutMs?: number;
    readonly config: NaxConfig;
    readonly sessionRole?: SessionRole;
    readonly callId: string;
    readonly pipelineStage: string;
    readonly declaredTools: readonly CodingToolName[];
    readonly toolPatterns?: ToolPatternNarrowing;
    readonly fileOutputPath?: string;
    readonly keepOpen: boolean;
  }

  /**
   * @param ctx - The dispatching CallContext; supplies packageView/runtime/story fields.
   * @param params - Call-site-local values callOp already resolved for this dispatch.
   */
  export function buildRunDispatchOptions(ctx: CallContext, params: RunDispatchOptionsParams) {
    const {
      prompt,
      effectiveTier,
      dispatchModelDef,
      timeoutMs,
      config,
      sessionRole,
      callId,
      pipelineStage,
      declaredTools,
      toolPatterns,
      fileOutputPath,
      keepOpen,
    } = params;
    return {
      prompt,
      workdir: ctx.packageDir,
      modelTier: effectiveTier,
      modelDef: dispatchModelDef,
      timeoutSeconds:
        timeoutMs !== undefined
          ? Math.ceil(timeoutMs / 1000)
          : (config.execution?.sessionTimeoutSeconds ?? DEFAULT_CONFIG.execution.sessionTimeoutSeconds),
      pipelineStage,
      config,
      sessionRole,
      featureName: ctx.featureName,
      storyId: ctx.storyId,
      callId,
      declaredTools,
      ...(ctx.runtime.toolProviders.length > 0 ? { providers: ctx.runtime.toolProviders } : {}),
      ...(toolPatterns !== undefined ? { toolPatterns } : {}),
      codingToolRoot: packageWorkdir(ctx.packageView),
      ...(fileOutputPath !== undefined ? { codingToolFileOutput: fileOutputPath } : {}),
      codingToolRepoRoot: storyExecRoot(ctx.packageView),
      // PR1 (single-frame redesign): thread the repo root and the story's
      // RELATIVE package dir independently of codingToolRoot, so
      // resolveCodingToolSupport can resolve declared commands' execution cwd
      // and per-package config without depending on what codingToolRoot means
      // at dispatch time (PR2 repoints it at storyExecRoot).
      projectDir: ctx.runtime.projectDir,
      codingToolPackageDir: ctx.packageView.packageDir,
      outputDir: ctx.runtime.outputDir,
      ...(keepOpen ? { keepOpen: true } : {}),
      ...(ctx.scopeId !== undefined ? { scopeId: ctx.scopeId } : {}),
      ...(ctx.interactionBridge ? { interactionBridge: ctx.interactionBridge } : {}),
      ...(ctx.maxInteractionTurns !== undefined ? { maxInteractionTurns: ctx.maxInteractionTurns } : {}),
    };
  }
  ```

- [ ] **1.2 — Write a failing test pinning the two new fields.**

  Create the test file (mirrors `src/operations/call-run-options.ts` per
  `test-architecture.md`): `test/unit/operations/call-run-options.test.ts`.

  First inspect how existing operations tests build a minimal `CallContext` —
  `test/unit/operations/call.test.ts` already constructs one with
  `makeTestRuntime()` (`test/helpers/runtime.ts`) and a `PackageView` from
  `runtime.packages.resolve(...)`. Reuse that pattern:

  ```typescript
  import { afterEach, describe, expect, test } from "bun:test";
  import { makeNaxConfig, makeTestRuntime } from "@test/helpers";
  import type { NaxRuntime } from "@/runtime";
  import { buildRunDispatchOptions } from "@/operations/call-run-options";
  import type { CallContext } from "@/operations/types";

  const createdRuntimes: NaxRuntime[] = [];
  afterEach(async () => {
    await Promise.allSettled(createdRuntimes.map((r) => r.close()));
    createdRuntimes.length = 0;
  });

  describe("buildRunDispatchOptions — PR1 fields (single-frame redesign)", () => {
    test("threads projectDir and the story's relative package dir independently of codingToolRoot", () => {
      const config = makeNaxConfig();
      const runtime = makeTestRuntime({ config, workdir: "/repo" });
      createdRuntimes.push(runtime);
      const packageView = runtime.packages.resolve("packages/api");
      const ctx: CallContext = {
        runtime,
        packageView,
        packageDir: "packages/api",
        config,
        agentName: "claude", // required field on CallContext (types.ts:56)
      };

      const result = buildRunDispatchOptions(ctx, {
        prompt: "hi",
        effectiveTier: "balanced",
        dispatchModelDef: { provider: "claude", model: "sonnet" },
        config,
        callId: "call-1",
        pipelineStage: "run",
        declaredTools: ["Read"],
        keepOpen: false,
      });

      expect(result.projectDir).toBe(runtime.projectDir);
      expect(result.codingToolPackageDir).toBe("packages/api");
      // codingToolRoot is the package WORKDIR (absolute) — a different value
      // from codingToolPackageDir (relative) by construction, proving the two
      // are threaded independently rather than one being derived from the
      // other at this call site.
      expect(result.codingToolRoot).not.toBe(result.codingToolPackageDir);
    });

    test("the root package (packageDir '') threads an empty codingToolPackageDir, not undefined", () => {
      const config = makeNaxConfig();
      const runtime = makeTestRuntime({ config, workdir: "/repo" });
      createdRuntimes.push(runtime);
      const packageView = runtime.packages.repo();
      const ctx: CallContext = {
        runtime,
        packageView,
        packageDir: "",
        config,
        agentName: "claude", // required field on CallContext (types.ts:56)
      };

      const result = buildRunDispatchOptions(ctx, {
        prompt: "hi",
        effectiveTier: "balanced",
        dispatchModelDef: { provider: "claude", model: "sonnet" },
        config,
        callId: "call-1",
        pipelineStage: "run",
        declaredTools: ["Read"],
        keepOpen: false,
      });

      expect(result.codingToolPackageDir).toBe("");
    });
  });
  ```

  Run it and confirm it **fails to compile**:
  `timeout 30 bun test test/unit/operations/call-run-options.test.ts --timeout=15000`

  Expected failure: `Cannot find module '@/operations/call-run-options'` (the
  file exists after step 1.1, so this actually passes compilation — the real
  failure signal here is step 1.3 below, since `call.ts` has not been wired to
  the new module yet and `AgentRunOptions` does not carry
  `codingToolPackageDir` until Task 2). Run the test now anyway and confirm it
  fails typecheck on `result.codingToolPackageDir` (`Property
  'codingToolPackageDir' does not exist`) — this IS the correct red state:
  `buildRunDispatchOptions`'s inferred return type has no such property until
  the `AgentRunOptions` type gains it in Task 2, and even once it's a bare
  property on the inferred object literal type, the test still exercises real
  runtime behavior once Task 2 lands. Do not proceed past this step until the
  failure is confirmed and understood — it will turn green only after Task 2.

- [ ] **1.3 — Wire `call.ts` to call the new function; delete the old inline object and the now-unused import.**

  In `src/operations/call.ts`:
  - Remove `import { packageWorkdir, storyExecRoot } from "../runtime/packages";` (line 10) — no longer used in this file.
  - Add `import { buildRunDispatchOptions } from "./call-run-options";`.
  - Replace the `runOptions` object literal (`:232-270`) with:
    ```typescript
    const runOptions = buildRunDispatchOptions(ctx, {
      prompt,
      effectiveTier,
      dispatchModelDef,
      timeoutMs,
      config,
      sessionRole,
      callId,
      pipelineStage: op.stage,
      declaredTools: resolveDeclaredTools(runOp),
      toolPatterns: runOp.toolPatterns,
      fileOutputPath,
      keepOpen,
    });
    ```
  - Verify `resolveDeclaredTools` (imported at `:30`, `import { resolveDeclaredTools } from "./types";`) is still imported — it is, and is now used only here (previously also inline in the deleted object, so no duplicate-import cleanup needed).

- [ ] **1.4 — Run the test from 1.2 again and confirm PASS.**

  `timeout 30 bun test test/unit/operations/call-run-options.test.ts --timeout=15000`

  Both tests pass now: `AgentRunOptions` structurally accepts the extra keys
  (TypeScript widens an object literal's inferred type at the `return`
  statement, and nothing here assigns it against the `AgentRunOptions`
  interface yet — that assignment happens implicitly wherever `runOptions` is
  passed to `runWithFallback`, which already accepts `AgentRunOptions`; Task 2
  makes that assignment sound by declaring the field).

- [ ] **1.5 — Confirm `call.ts` stays under the file-size cap.**

  `wc -l src/operations/call.ts` — expect a count comfortably below 600 (the
  39-line object literal is replaced by a 13-line call plus one new import
  line, and one import line was deleted).

- [ ] **1.6 — Confirm the wider operations suite still passes.**

  `timeout 60 bun test test/unit/operations/ --timeout=30000`

- [ ] **1.7 — Commit.**

  ```
  git add src/operations/call-run-options.ts src/operations/call.ts test/unit/operations/call-run-options.test.ts
  git commit -m "refactor(operations): extract callOp's runOptions builder, thread projectDir + package dir"
  ```

---

## Task 2 — Add `codingToolPackageDir` to `AgentRunOptions`

**Files:**
- Modify: `src/agents/types.ts` (insert after the `codingToolRepoRoot` field, `:182-196`)

**Interfaces:**
- Produces: `AgentRunOptions.codingToolPackageDir?: string`.
- Consumes: nothing new (pure type addition).

### Steps

- [ ] **2.1 — Add the field.**

  In `src/agents/types.ts`, immediately after the `codingToolRepoRoot` field
  (ends at line 196 with `codingToolRepoRoot?: string;`), insert:

  ```typescript
  /**
   * The story's package dir, RELATIVE to `projectDir` — `PackageView.packageDir`
   * verbatim ("" for the root package of a single-package repo, e.g.
   * "packages/api" for a monorepo member).
   *
   * Independent of `codingToolRoot`: PR2
   * (docs/superpowers/specs/2026-09-18-single-frame-redesign-design.md)
   * repoints `codingToolRoot` at the story's repo-rooted execution root, so
   * this field — combined with `projectDir` below — is what
   * `resolveCodingToolSupport` uses to resolve the story's own
   * `.nax/mono/<pkg>/config.json` and to compute declared commands'
   * execution cwd, without depending on what `codingToolRoot` means at
   * dispatch time.
   *
   * PRODUCER: src/operations/call-run-options.ts (`ctx.packageView.packageDir`).
   */
  codingToolPackageDir?: string;
  ```

  (`projectDir` already exists on this interface at `:153`, documented as
  "Absolute path to repo root where `.nax/` lives" — it is reused for this
  purpose, not duplicated.)

- [ ] **2.2 — Typecheck.**

  `bun run typecheck`

  Expect PASS. This also confirms Task 1's test (1.2) now passes for the real
  reason (the field exists on the type), not just structurally.

- [ ] **2.3 — Re-run Task 1's test to confirm it is green for the right reason.**

  `timeout 30 bun test test/unit/operations/call-run-options.test.ts --timeout=15000`

- [ ] **2.4 — Commit.**

  ```
  git add src/agents/types.ts
  git commit -m "feat(agents): add codingToolPackageDir to AgentRunOptions"
  ```

---

## Task 3 — Decouple `RunCommand`'s declared-branch execution cwd from `ctx.root`

**Files:**
- Modify: `src/tools/run-command.ts` (`RunCommandToolOptions` interface `:64-69`; the `runQualityCommand` call inside `run()` at `:425-434`)

**Interfaces:**
- Produces: `RunCommandToolOptions.commandCwd?: string`.
- Consumes: nothing new — `ToolRunContext.root` (`src/tools/registry.ts:48-49`, unchanged) remains the fallback.

### Steps

- [ ] **3.1 — Write a failing test.**

  In `test/unit/tools/run-command.test.ts`, add (near the other `describe`
  blocks, before the final `describe("run() truncates ...")`-style blocks —
  append as a new top-level `describe`):

  ```typescript
  // PR1 (single-frame redesign): declared commands must run at a cwd
  // independent of ctx.root (tool containment), so PR2's later root move
  // (codingToolRoot -> the story's repo-rooted execution root) cannot turn a
  // package's declared "test" into a whole-repo run.
  describe("run() executes declared commands at commandCwd, not ctx.root", () => {
    test("commandCwd wins over ctx.root when both are supplied", async () => {
      const containmentRoot = await realpath(await mkdtemp(join(tmpdir(), "nax-runcmd-root-")));
      const packageCwd = await realpath(await mkdtemp(join(tmpdir(), "nax-runcmd-pkg-")));
      const tool = createRunCommandTool(new Map([["where", "pwd"]]), { commandCwd: packageCwd });

      const result = await tool.run(
        { command: "where" },
        { root: containmentRoot, resolvedPaths: [], maxBytes: 4096, maxFileBytes: 1024 },
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain(packageCwd);
      expect(result.content).not.toContain(containmentRoot);
    });

    test("falls back to ctx.root when commandCwd is not supplied (back-compat)", async () => {
      const containmentRoot = await realpath(await mkdtemp(join(tmpdir(), "nax-runcmd-fallback-")));
      const tool = createRunCommandTool(new Map([["where", "pwd"]]));

      const result = await tool.run(
        { command: "where" },
        { root: containmentRoot, resolvedPaths: [], maxBytes: 4096, maxFileBytes: 1024 },
      );

      expect(result.content).toContain(containmentRoot);
    });
  });
  ```

  Add the two new imports this needs at the top of the file (alongside the
  existing `import { mkdir, realpath, writeFile } from "node:fs/promises";`
  at `:2` — extend it rather than adding a second import line):

  ```typescript
  import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
  import { tmpdir } from "node:os";
  ```

  Run it:
  `timeout 30 bun test test/unit/tools/run-command.test.ts --timeout=15000`

  Expected failure: `bun run typecheck` (and Biome's structural check inside
  `bun test`, which does not itself type-check but Bun's transpiler still
  requires syntactically valid TS) rejects `{ commandCwd: packageCwd }` as an
  excess property against `RunCommandToolOptions`, since the field does not
  exist yet — `error TS2353: Object literal may only specify known
  properties, and 'commandCwd' does not exist in type 'RunCommandToolOptions'`.
  Confirm this with `bun run typecheck` directly, since `bun test`'s
  transpiler alone does not enforce it. Even setting typecheck aside, the
  first test would fail at runtime too: `run()` today always spawns at
  `ctx.root`, so `result.content` would contain `containmentRoot`, not
  `packageCwd` — the assertion `not.toContain(containmentRoot)` fails.

- [ ] **3.2 — Add the option and use it in `run()`.**

  In `src/tools/run-command.ts`, add to `RunCommandToolOptions` (`:64-69`):

  ```typescript
  export interface RunCommandToolOptions {
    /** Secret environment variables excluded from agent-triggered commands. */
    readonly stripEnvVars?: readonly string[];
    /** See `RunCommandExecOptions`. */
    readonly exec?: RunCommandExecOptions;
    /**
     * Execution cwd for the DECLARED (non-Exec) branch below, independent of
     * `ctx.root` (tool containment). Falls back to `ctx.root` when absent —
     * every caller today passes the package workdir either way, so the
     * fallback is a no-op until PR2
     * (docs/superpowers/specs/2026-09-18-single-frame-redesign-design.md)
     * repoints `ctx.root` at the story's repo-rooted execution root.
     *
     * PRODUCER: src/agents/coding-tool-support.ts (`buildCodingToolSupport`'s
     * `commandCwd` arg).
     */
    readonly commandCwd?: string;
  }
  ```

  Change the `runQualityCommand` call inside `run()` (`:425-434`):

  ```typescript
      const result = await runQualityCommand({
        commandName: key,
        command,
        workdir: opts.commandCwd ?? ctx.root,
        stripEnvVars: [...(opts.stripEnvVars ?? [])],
        // The agent's own iteration loop, not a harness gate: kept in the JSONL
        // at debug, off the console. Its outcome reaches the agent through the
        // returned content, and the harness reports its own gates separately.
        origin: "agent-tool",
      });
  ```

  (Only the `workdir:` line changes, from `ctx.root` to `opts.commandCwd ??
  ctx.root`.)

- [ ] **3.3 — Run the test from 3.1 and confirm PASS.**

  `timeout 30 bun test test/unit/tools/run-command.test.ts --timeout=15000`

- [ ] **3.4 — Typecheck and lint.**

  `bun run typecheck && bun run lint`

- [ ] **3.5 — Confirm the whole tools test directory still passes (the Exec branch and other RunCommand tests are untouched).**

  `timeout 60 bun test test/unit/tools/ --timeout=30000`

- [ ] **3.6 — Commit.**

  ```
  git add src/tools/run-command.ts test/unit/tools/run-command.test.ts
  git commit -m "feat(tools): decouple RunCommand's declared-branch execution cwd from ctx.root"
  ```

---

## Task 4 — Thread `commandCwd` through `buildCodingToolSupport`

**Files:**
- Modify: `src/agents/coding-tool-support.ts` (the `buildCodingToolSupport` args interface, after the `repoRoot` field `:49-61`; the `createRunCommandTool` call inside it, `:174-195`)

**Interfaces:**
- Consumes: Task 3's `RunCommandToolOptions.commandCwd`.
- Produces: `buildCodingToolSupport`'s `args.commandCwd?: string`, wired to `createRunCommandTool`.

### Steps

- [ ] **4.1 — Write a failing test.**

  In `test/unit/agents/coding-tool-support.test.ts`, add a new `describe`
  block (place it after the existing `"buildCodingToolSupport — declared-command
  seam and audit sink"` block, `:218-276`):

  ```typescript
  describe("buildCodingToolSupport — commandCwd reaches RunCommand (PR1)", () => {
    test("a declared command runs at commandCwd, not root, when the two differ", async () => {
      const containmentRoot = makeTempDir("nax-support-cwd-root-");
      const packageCwd = makeTempDir("nax-support-cwd-pkg-");
      try {
        const support = buildCodingToolSupport({
          root: containmentRoot,
          commandCwd: packageCwd,
          grants: runCommandGrants,
          declared: ["RunCommand"],
          declaredCommands: new Map([["where", "pwd"]]),
        });
        const result = await support?.runtime.callTool("RunCommand", { command: "where" });
        expect(result?.kind).toBe("ok");
        if (result?.kind !== "ok") throw new Error("expected RunCommand to succeed");
        expect(result.content).toContain(await realpathAsync(packageCwd));
        expect(result.content).not.toContain(await realpathAsync(containmentRoot));
      } finally {
        cleanupTempDir(containmentRoot);
        cleanupTempDir(packageCwd);
      }
    });
  });
  ```

  Add the needed import (this file's existing imports at `:1-12` do not yet
  import `realpath`):

  ```typescript
  import { realpath as realpathAsync } from "node:fs/promises";
  ```

  Run it:
  `timeout 30 bun test test/unit/agents/coding-tool-support.test.ts --timeout=15000`

  Expected failure: `bun run typecheck` rejects `commandCwd: packageCwd` as an
  excess property on `buildCodingToolSupport`'s args (the field does not exist
  on that interface yet — same `TS2353` shape as Task 3.1). Confirm with
  `bun run typecheck`. Even without typechecking, the runtime assertion also
  fails today: `buildCodingToolSupport` never reads a `commandCwd` arg, so the
  RunCommand tool built from it still has no `commandCwd` (falls back to
  `ctx.root` per Task 3's own fallback), and `result.content` would contain
  `containmentRoot`, not `packageCwd`.

- [ ] **4.2 — Add the field and wire it.**

  In `src/agents/coding-tool-support.ts`, add to `buildCodingToolSupport`'s
  args interface, immediately after the `repoRoot` field's closing `;`
  (`:61`):

  ```typescript
    /**
     * Execution cwd for RunCommand's DECLARED (non-Exec) branch, independent
     * of `root` (tool containment). Falls back to `root` when absent.
     *
     * PRODUCER: resolveCodingToolSupport below, computed from
     * `codingToolPackageDir` + `projectDir` (docs/superpowers/specs/2026-09-18-single-frame-redesign-design.md
     * PR 1) so it stays pointed at the story's package dir even after PR2
     * repoints `codingToolRoot`/`root` at the repo root.
     */
    commandCwd?: string;
  ```

  Then in the `extraTools` array's `createRunCommandTool` call (`:174-195`),
  add `commandCwd` immediately after `stripEnvVars`:

  ```typescript
            createRunCommandTool(declaredCommands, {
              stripEnvVars: args.stripEnvVars,
              commandCwd: args.commandCwd ?? args.root,
              ...(allowExec
                ? {
                    exec: {
  ```

  (Only the one new line is inserted; everything from `...(allowExec` onward
  is unchanged.)

- [ ] **4.3 — Run the test from 4.1 and confirm PASS.**

  `timeout 30 bun test test/unit/agents/coding-tool-support.test.ts --timeout=15000`

- [ ] **4.4 — Typecheck, lint, and confirm the full agents test directory passes.**

  ```
  bun run typecheck && bun run lint
  timeout 60 bun test test/unit/agents/ --timeout=30000
  ```

- [ ] **4.5 — Commit.**

  ```
  git add src/agents/coding-tool-support.ts test/unit/agents/coding-tool-support.test.ts
  git commit -m "feat(agents): thread commandCwd through buildCodingToolSupport into RunCommand"
  ```

---

## Task 5 — Resolve declared commands per-package via `loadConfigForPackage`; compute `commandCwd`

**Files:**
- Modify: `src/agents/coding-tool-support.ts` (imports `:1-42`; `resolveCodingToolSupport`'s `Pick<AgentRunOptions, ...>` param list `:255-269`; the config-widening block `:271-303`; the `root`/`buildCodingToolSupport` call tail `:313-421`)

**Interfaces:**
- Consumes: Task 2's `AgentRunOptions.codingToolPackageDir` and the existing `AgentRunOptions.projectDir`; Task 4's `buildCodingToolSupport({ commandCwd })`; `loadConfigForPackage` (`src/config/package-config.ts`, unchanged); `packageConfigCache` (`src/config/package-config-cache.ts`, unchanged, consulted internally by `loadConfigForWorkdir`); `packageWorkdir` (`src/runtime/packages.ts`, unchanged).
- Produces: `_codingToolSupportDeps` (exported, DI seam for `loadConfigForPackage`).

### Steps

- [ ] **5.1 — Write failing tests: per-package override wins, cache hit on second dispatch, parity with `loadConfigForPackage`.**

  In `test/unit/agents/coding-tool-support.test.ts`, EXTEND the existing
  `node:fs` import at line 2 (it already imports `existsSync, mkdtempSync,
  writeFileSync` — adding a second `node:fs` import statement is a duplicate
  identifier error) and add the config imports:

  ```typescript
  import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"; // extend line 2 in place
  import { loadConfigForPackage, packageConfigCache } from "@/config";
  import { _clearRootConfigCache } from "@/config/loader";
  ```

  `join` may already be imported from `node:path` at `:4` — extend that
  import in place too rather than adding a second statement.

  (`join` may already be imported at `:4` — extend that existing import
  rather than duplicating it if so; verify before editing.)

  Add a new `describe` block:

  ```typescript
  describe("resolveCodingToolSupport — per-package declared commands (#2066 residual)", () => {
    let tempDir: string;
    let originalGlobalDir: string | undefined;

    beforeEach(() => {
      tempDir = makeTempDir("nax-coding-tool-pkg-");
      originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
      process.env.NAX_GLOBAL_CONFIG_DIR = join(tempDir, ".global-nax");
      mkdirSync(join(tempDir, ".nax", "mono", "packages", "api"), { recursive: true });
      mkdirSync(join(tempDir, "packages", "api"), { recursive: true });
      writeFileSync(join(tempDir, ".nax", "config.json"), JSON.stringify({}));
      writeFileSync(
        join(tempDir, ".nax", "mono", "packages", "api", "config.json"),
        JSON.stringify({ quality: { commands: { test: "echo PACKAGE" } } }),
      );
      _clearRootConfigCache();
      packageConfigCache.clear();
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
      if (originalGlobalDir === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
      else process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
      _clearRootConfigCache();
      packageConfigCache.clear();
    });

    test("a package story's RunCommand runs the PACKAGE override, not the root-only config a stale caller threaded", async () => {
      const packageDir = join(tempDir, "packages", "api");
      const support = await resolveCodingToolSupport({
        declaredTools: ["RunCommand"],
        codingToolRoot: packageDir,
        codingToolPackageDir: "packages/api",
        projectDir: tempDir,
        pipelineStage: "run",
        // Simulates the #2066 residual directly: options.config still carries
        // a ROOT-only "test" command. resolveCodingToolSupport must resolve
        // the PACKAGE override from disk rather than trusting this value.
        config: makeNaxConfig({ quality: { commands: { test: "echo ROOT" } } }),
      });
      const result = await support?.runtime.callTool("RunCommand", { command: "test" });
      expect(result?.kind).toBe("ok");
      if (result?.kind !== "ok") throw new Error("expected RunCommand to succeed");
      expect(result.content).toContain("PACKAGE");
      expect(result.content).not.toContain("ROOT");
    });

    test("the resolved package config is cached — second dispatch for the same package/profile hits packageConfigCache", async () => {
      const packageDir = join(tempDir, "packages", "api");
      const dispatch = () =>
        resolveCodingToolSupport({
          declaredTools: ["RunCommand"],
          codingToolRoot: packageDir,
          codingToolPackageDir: "packages/api",
          projectDir: tempDir,
          pipelineStage: "run",
          config: makeNaxConfig(),
        });

      await dispatch();
      const rootConfigPath = join(tempDir, ".nax", "config.json");
      const afterFirst = packageConfigCache.get(rootConfigPath, "packages/api", "");
      expect(afterFirst).toBeDefined();

      await dispatch();
      const afterSecond = packageConfigCache.get(rootConfigPath, "packages/api", "");
      // Reference equality: a cache HIT returns the exact object
      // loadConfigForWorkdir built on the first call. A re-parse (cache MISS)
      // would construct a fresh object via NaxConfigSchema.safeParse — deep-
      // equal but a different reference — and fail this assertion.
      expect(afterSecond).toBe(afterFirst);
    });

    test("RunCommand's resolved 'test' template equals loadConfigForPackage's — the resolver acceptance-setup.ts already uses", async () => {
      const rootConfig = makeNaxConfig();
      const acceptanceResolved = await loadConfigForPackage(tempDir, "packages/api", rootConfig);
      expect(acceptanceResolved.quality.commands.test).toBe("echo PACKAGE");

      const support = await resolveCodingToolSupport({
        declaredTools: ["RunCommand"],
        codingToolRoot: join(tempDir, "packages", "api"),
        codingToolPackageDir: "packages/api",
        projectDir: tempDir,
        pipelineStage: "run",
        config: rootConfig,
      });
      const result = await support?.runtime.callTool("RunCommand", { command: "test" });
      expect(result?.kind).toBe("ok");
      if (result?.kind !== "ok") throw new Error("expected RunCommand to succeed");
      expect(result.content).toContain("PACKAGE");
    });
  });
  ```

  Run them:
  `timeout 30 bun test test/unit/agents/coding-tool-support.test.ts --timeout=15000`

  Expected failures, all for the same reason: `resolveCodingToolSupport` does
  not yet accept `codingToolPackageDir`/`projectDir` in its narrowed
  `Pick<AgentRunOptions, ...>` param type (`TS2353` excess property, same
  shape as Tasks 3–4), so `bun run typecheck` fails. At runtime (transpile
  strips the excess-property check), the three tests fail for their own
  reasons too:
  - Test 1: `resolveCodingToolSupport` still reads `commands` straight off
    `options.config` — never touches disk — so the RunCommand tool runs `echo
    ROOT`, and `result.content` contains `"ROOT"` where the assertion expects
    `"PACKAGE"` and expects `"ROOT"` absent.
  - Test 2: `packageConfigCache` is never populated at all (nothing calls
    `loadConfigForPackage`), so `afterFirst` is `undefined` and the very first
    assertion (`toBeDefined()`) fails.
  - Test 3: same as Test 1 — `result.content` never contains `"PACKAGE"`
    because the per-package override is never consulted.

- [ ] **5.2 — Add imports and the `_codingToolSupportDeps` DI seam.**

  In `src/agents/coding-tool-support.ts`, add to the import block (`:12-41`):

  ```typescript
  import { loadConfigForPackage } from "../config";
  import type { NaxConfig } from "../config";
  import { packageWorkdir } from "../runtime/packages";
  import { errorMessage } from "../utils/errors";
  ```

  Immediately above `export async function resolveCodingToolSupport(` (before
  `:254`), add:

  ```typescript
  /** Injectable deps for testability — mirrors the _agentManagerDeps pattern. */
  export const _codingToolSupportDeps = {
    loadConfigForPackage,
  };
  ```

- [ ] **5.3 — Widen the `Pick<AgentRunOptions, ...>` param list.**

  In the `resolveCodingToolSupport` signature (`:255-269`), add
  `"projectDir"` and `"codingToolPackageDir"` to the `Pick<...>` union:

  ```typescript
  export async function resolveCodingToolSupport(
    options: Pick<
      AgentRunOptions,
      | "declaredTools"
      | "providers"
      | "toolPatterns"
      | "codingToolRoot"
      | "codingToolRepoRoot"
      | "codingToolFileOutput"
      | "outputDir"
      | "pipelineStage"
      | "storyId"
      | "sessionRole"
      | "featureName"
      | "config"
      | "projectDir"
      | "codingToolPackageDir"
    >,
  ): Promise<CodingToolSupport | undefined> {
  ```

- [ ] **5.4 — Resolve the per-package config, and use it (falling back to the root-derived one) for every `quality`/`install`/`execution.denyPaths`-derived field.**

  Replace the block from `const widenedConfig = options.config as ...`
  through `const denyPaths = options.config?.execution?.denyPaths;` (the
  original `:277-298`) with:

  ```typescript
    // PR1 (single-frame redesign, #2066 residual): resolve the declared-command
    // map (and the quality-derived fields around it) from the STORY'S PACKAGE
    // config when one is known, not the config this dispatch happened to be
    // threaded with. loadConfigForPackage is the R4-mandated resolver — never
    // loadConfigForWorkdir directly, never packageView.config
    // (packages.resolve() misses under worktree/parallel isolation, #2069);
    // its required `from` carries the --profile chain (#2126/#2127). Cheap on
    // a hit: loadConfigForWorkdir's own packageConfigCache
    // (rootConfigPath, packageDir, profileKey) serves every dispatch after the
    // first for the same package/profile.
    const packageDir = options.codingToolPackageDir;
    const projectDir = options.projectDir;
    let packageEffectiveConfig: NaxConfig | undefined;
    if (
      packageDir !== undefined &&
      packageDir.trim() !== "" &&
      packageDir !== "." &&
      projectDir !== undefined &&
      projectDir.trim() !== "" &&
      options.config !== undefined
    ) {
      try {
        packageEffectiveConfig = await _codingToolSupportDeps.loadConfigForPackage(
          projectDir,
          packageDir,
          // RULING F2 (see below): options.config's declared type is a Pick,
          // but at runtime both hops source it from the full NaxConfig.
          options.config as unknown as NaxConfig,
        );
      } catch (err) {
        getSafeLogger()?.warn("tools", "Per-package config failed to load for dispatch — using root config", {
          storyId: options.storyId ?? "_dispatch",
          packageDir,
          error: errorMessage(err),
        });
      }
    }

    // RULING F2: AgentRunOptions['config'] is typed as the agent-manager Pick
    // (agent/execution/profile), yet both hops source it from configLoader.current(),
    // so it carries the full NaxConfig at runtime — only the type lies. The read is
    // widened locally here; the shared agentManagerConfigSelector stays untouched.
    // Now sourced from packageEffectiveConfig when a package story resolved one
    // above, so a per-package quality.commands/install override is honored —
    // falls back to options.config for a root story or when resolution failed.
    const widenedConfig = (packageEffectiveConfig ?? options.config) as
      | {
          quality?: { commands?: Partial<Record<string, QualityCommandSpec>>; stripEnvVars?: unknown; shell?: unknown };
          // AgentManagerConfig (agentManagerConfigSelector) only picks
          // agent/execution/profile, so `install` is not in its type even
          // though both hops source this from the full NaxConfig at runtime
          // (see RULING F2 above). Widen locally rather than broaden the
          // shared selector.
          install?: { allowScripts?: boolean };
        }
      | undefined;
    const quality = widenedConfig?.quality;
    const commands = quality?.commands ?? {};
    const stripEnvVars = Array.isArray(quality?.stripEnvVars)
      ? quality.stripEnvVars.filter((value): value is string => typeof value === "string")
      : [];
    const shell = typeof quality?.shell === "string" ? quality.shell : undefined;
    const allowScripts = widenedConfig?.install?.allowScripts ?? false;
    // Same package-first fallback as widenedConfig above — a package can
    // override execution.denyPaths too.
    const denyPaths = (packageEffectiveConfig ?? options.config)?.execution?.denyPaths;
  ```

- [ ] **5.5 — Compute `commandCwd` and pass it (and the resolved `denyPaths`, unchanged from before) into `buildCodingToolSupport`.**

  Locate `const root = options.codingToolRoot;` (originally `:313`) and add
  immediately after it:

  ```typescript
    const root = options.codingToolRoot;
    // Independent of `root`: PR2 repoints `codingToolRoot` at the story's
    // execution root, so declared commands must resolve their cwd from the
    // story's own relative package dir + the (stable) project root rather
    // than from whatever `root` means at dispatch time. Falls back to `root`
    // when either input is unavailable (legacy callers, or a single-package
    // repo where the two already coincide).
    const commandCwd =
      projectDir !== undefined && projectDir.trim() !== ""
        ? packageWorkdir({ packageDir: packageDir ?? "", repoRoot: projectDir })
        : root;
  ```

  Then, in the `return buildCodingToolSupport({...})` call at the end of the
  function (originally `:399-420`), add `commandCwd,` as a new key (placement
  next to `declaredCommands,` reads naturally):

  ```typescript
    return buildCodingToolSupport({
      root: options.codingToolRoot,
      pipelineStage: options.pipelineStage ?? "run",
      ...(options.codingToolRepoRoot !== undefined ? { repoRoot: options.codingToolRepoRoot } : {}),
      commandCwd,
      grants: [...allow.grants, ...providerResult.grants],
      declared: declaredWithProviders,
      extraTools: providerResult.tools,
      providerIdByTool: providerResult.providerIdByTool,
      ...(options.toolPatterns !== undefined ? { toolPatterns: options.toolPatterns } : {}),
      ...(denyRules.length > 0 ? { denyRules } : {}),
      ...(askRules.length > 0 ? { askRules } : {}),
      ...(options.storyId !== undefined ? { storyId: options.storyId } : {}),
      declaredCommands,
      stripEnvVars,
      ...(shell !== undefined ? { shell } : {}),
      ...(auditDir !== undefined ? { auditDir } : {}),
      sessionName,
      ...(packageName !== undefined ? { packageName } : {}),
      allowScripts,
      ...(denyPaths !== undefined ? { denyPaths } : {}),
      ...(options.codingToolFileOutput !== undefined ? { fileOutputPath: options.codingToolFileOutput } : {}),
    });
  ```

  (Only the `commandCwd,` line is new; every other key is unchanged from the
  current file.)

- [ ] **5.6 — Run the tests from 5.1 and confirm PASS.**

  `timeout 30 bun test test/unit/agents/coding-tool-support.test.ts --timeout=15000`

- [ ] **5.7 — Confirm no regression in the existing tests in the same file (denyPaths, stripEnvVars, dispatch-visibility, Exec grant selection) — these pass no `codingToolPackageDir`/`projectDir`, so `packageEffectiveConfig` stays `undefined` and behavior is byte-identical to before.**

  `timeout 60 bun test test/unit/agents/coding-tool-support.test.ts test/unit/agents/coding-tool-support-exec.test.ts test/unit/agents/coding-tool-support-bash.test.ts test/unit/agents/coding-tool-support-providers.test.ts test/unit/agents/coding-tool-support-session-name.test.ts --timeout=30000`

- [ ] **5.8 — Confirm `coding-tool-support.ts` stays under the 600-line cap.**

  `wc -l src/agents/coding-tool-support.ts` — expect roughly 480-500 lines (up
  from 421), comfortably under the cap.

- [ ] **5.9 — Typecheck and lint the whole tree.**

  `bun run typecheck && bun run lint`

- [ ] **5.10 — Commit.**

  ```
  git add src/agents/coding-tool-support.ts test/unit/agents/coding-tool-support.test.ts
  git commit -m "fix(agents): resolve declared commands per-package via loadConfigForPackage (#2066 residual)"
  ```

---

## Task 6 — Full verification gate

**Files:** none (verification only).

- [ ] **6.1 — Full suite.**

  `bun run test`

- [ ] **6.2 — Typecheck.**

  `bun run typecheck`

- [ ] **6.3 — Lint (includes `check:file-sizes`, `check:config-profile-threading` is a separate script — run it explicitly too).**

  `bun run lint` (already runs `check:config-profile-threading` as part of
  `lint:checks`; run it standalone too for a direct signal:
  `bun run check:config-profile-threading`)

- [ ] **6.4 — Coverage (not part of `check:all` — run manually since this PR adds a new `src/` file, `call-run-options.ts`).**

  `bun run test:coverage`

  Confirm `src/operations/call-run-options.ts` clears the per-file 80% floor
  (Task 1's test exercises both branches — a monorepo package and the root
  package — so line/function coverage should be complete); if it is reported
  below floor, add the missing case rather than lowering the baseline.

- [ ] **6.5 — Run the one command all four gates together, as a final confirmation.**

  `bun run typecheck && bun run lint && bun run test && bun run test:coverage`

  All four must exit 0 before this PR is considered done.

- [ ] **6.6 — No commit at this step** (verification-only; if a gate fails, fix
  and return to the relevant task's commit step — do not create a new
  "fix lint" commit that isn't traceable to a task).
