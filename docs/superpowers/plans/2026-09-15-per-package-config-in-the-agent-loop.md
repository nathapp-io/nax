# Per-package config in the agent loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the native agent loop resolve per-package `.nax/mono/<pkg>/config.json` overrides the way the deterministic ops already do, so `RunCommand` runs the package's toolchain instead of the repo root's.

**Architecture:** Two seams, in order. First `runtime/packages.ts` learns that a worktree path `.nax-wt/<storyId>/<pkg>` addresses package `<pkg>` — decoupling the *override lookup key* from the *path identity*, which must not change. Then `CallContext` gains a `config` field carrying the effective per-story config the pipeline already resolved, and `callOp` reads it instead of reaching past the pipeline to `configLoader.current()`.

**Tech Stack:** TypeScript, Bun, `bun:test`, Biome.

**Spec:** `docs/superpowers/specs/2026-09-15-per-package-config-in-the-agent-loop-design.md`

## Global Constraints

- `src/operations/call.ts` is at **597/600 lines**. `SRC_LIMIT = 600` in `scripts/check-file-sizes.ts`. The `call.ts` edit must be **net-zero lines** — a substitution, no added comment.
- Every `logger.{info,warn,error,debug}` call inside scoped dirs must pass a data object whose **first key is `storyId`** — `scripts/check-logger-storyid.ts` is a ratchet that fails when the violation count increases.
- Test commands are `bun run test`, `bun run lint`, `bun run typecheck`. **Never** bare `bun test` — it gives confident false signals in this repo.
- Do not change `PackageView.repoRoot` to point into a worktree. It is the registry construction argument and is out of scope; see "Out of scope" in the spec.
- Do not implement working-directory provenance for declared commands. Explicitly out of scope.

---

### Task 1: Worktree-aware override lookup in the package registry (#2069)

`hydrate()` stores relative package keys like `apps/web-ui`. Under worktree isolation `resolve()` is
called with `<repoRoot>/.nax-wt/<storyId>/apps/web-ui`, which derives the key
`.nax-wt/<storyId>/apps/web-ui` and misses the stored override.

**The trap:** `resolve()` passes `key` — not the caller's raw argument — into `createPackageView`
(`packages.ts:123`), so `view.packageDir` *is* the key, and `packageWorkdir(view)` joins it onto
`repoRoot`. Under a worktree the long key is what makes file tools land in the worktree. Shortening the
key would repoint every file tool at the main checkout. So: introduce a **separate** override-lookup key,
leave `key` (identity, cache) untouched.

**Files:**
- Modify: `src/runtime/packages.ts` (add `toOverrideKey`, use it at the `mergedConfigs` lookup in `resolve`, ~lines 93-127)
- Test: `test/unit/runtime/packages.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no exported API change. `PackageView.packageDir`, `.relativeFromRoot`, `.repoRoot` and the cache key keep their exact current values for every input. Only `.config` and `.hasOverride` change, and only for worktree-shaped inputs.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/runtime/packages.test.ts`:

```ts
describe("PackageRegistry — worktree paths resolve the package override (#2069)", () => {
  async function registryWithOverride() {
    const loader = createConfigLoader(makeNaxConfig({ quality: { commands: { lint: "root-lint" } } }));
    const registry = createPackageRegistry(loader, "/repo");
    await registry.hydrate(["apps/web-ui"], async (_root, dir) =>
      dir === "apps/web-ui" ? makeNaxConfig({ quality: { commands: { lint: "pkg-lint" } } }) : null,
    );
    return registry;
  }

  test("a worktree package path finds the hydrated override", async () => {
    const registry = await registryWithOverride();
    const view = registry.resolve("/repo/.nax-wt/US-005/apps/web-ui");
    expect(view.hasOverride).toBe(true);
    expect(view.config.quality?.commands?.lint).toBe("pkg-lint");
  });

  // The identity invariant: packageWorkdir(view) joins packageDir onto repoRoot,
  // so shortening packageDir would repoint file tools at the MAIN checkout.
  test("packageDir still addresses the worktree, not the main checkout", async () => {
    const registry = await registryWithOverride();
    const view = registry.resolve("/repo/.nax-wt/US-005/apps/web-ui");
    expect(view.packageDir).toBe(".nax-wt/US-005/apps/web-ui");
  });

  // Two parallel stories on the SAME package must not share one view.
  test("two worktrees of the same package get distinct views", async () => {
    const registry = await registryWithOverride();
    const a = registry.resolve("/repo/.nax-wt/US-001/apps/web-ui");
    const b = registry.resolve("/repo/.nax-wt/US-002/apps/web-ui");
    expect(a).not.toBe(b);
    expect(a.packageDir).toBe(".nax-wt/US-001/apps/web-ui");
    expect(b.packageDir).toBe(".nax-wt/US-002/apps/web-ui");
    expect(a.hasOverride).toBe(true);
    expect(b.hasOverride).toBe(true);
  });

  // A story with no package workdir: the worktree ROOT is the repo package.
  test("a bare worktree root resolves to the repo-level view", async () => {
    const registry = await registryWithOverride();
    const view = registry.resolve("/repo/.nax-wt/US-005");
    expect(view.hasOverride).toBe(false);
    expect(view.config.quality?.commands?.lint).toBe("root-lint");
  });

  // A real directory that merely starts with the same characters must not match.
  test("a package named like the worktree dir is not mistaken for one", async () => {
    const loader = createConfigLoader(makeNaxConfig({ quality: { commands: { lint: "root-lint" } } }));
    const registry = createPackageRegistry(loader, "/repo");
    await registry.hydrate([".nax-wtx/pkg"], async (_root, dir) =>
      dir === ".nax-wtx/pkg" ? makeNaxConfig({ quality: { commands: { lint: "decoy-lint" } } }) : null,
    );
    const view = registry.resolve("/repo/.nax-wtx/pkg");
    expect(view.config.quality?.commands?.lint).toBe("decoy-lint");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/unit/runtime/packages.test.ts --timeout=60000`

Expected: the first three tests FAIL (`hasOverride` is `false`, `lint` is `"root-lint"`, and the two
worktree views are already distinct but override-less). The last two PASS already — they are the
regression guards.

- [ ] **Step 3: Implement the override-key derivation**

In `src/runtime/packages.ts`, add below `toRelativeKey` (which is unchanged):

```ts
  /**
   * Worktrees live at `<repoRoot>/.nax-wt/<storyId>/` (worktree/manager.ts), so a
   * story's package resolves to `.nax-wt/<storyId>/<pkg>` — which never matches the
   * plain `<pkg>` keys hydrate() stored, silently yielding root config (nax#2069).
   *
   * This strips the worktree prefix for the OVERRIDE LOOKUP ONLY. The key itself
   * stays as-is: resolve() passes it to createPackageView as `packageDir`, and
   * packageWorkdir() joins that onto repoRoot — shortening it would point every
   * file tool at the main checkout instead of the worktree.
   */
  function toOverrideKey(relativeKey: string): string {
    const segments = relativeKey.split("/");
    if (segments[0] !== ".nax-wt") return relativeKey;
    return segments.slice(2).join("/");
  }
```

Then in `resolve()`, change only the lookup line:

```ts
    const overrideConfig = mergedConfigs.get(toOverrideKey(key));
```

Leave `const key`, the `cache` get/set, and the `createPackageView(config, key, repoRoot, hasOverride)`
call exactly as they are.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/unit/runtime/packages.test.ts --timeout=60000`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/packages.ts test/unit/runtime/packages.test.ts
git commit -m "fix(runtime): resolve per-package overrides from worktree paths (#2069)"
```

---

### Task 2: Warn when `resolve()` silently falls back to root config (#2069)

The existing warning is guarded on `!hydrated`, so once hydration has run an unknown package key returns
root config with no signal at all. That guard is what made #2069 invisible. Warn on an unknown non-empty
key **after** hydration too — but only for a key that is not a known workspace package, so an
override-less package (the common case) stays quiet.

**Files:**
- Modify: `src/runtime/packages.ts` (track known package dirs in `hydrate`; extend the warn branch in `resolve`)
- Test: `test/unit/runtime/packages.test.ts`

**Interfaces:**
- Consumes: `toOverrideKey` from Task 1.
- Produces: no API change. New warn on the `packages` logger channel.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/runtime/packages.test.ts`:

```ts
describe("PackageRegistry — unknown package key is loud (#2069)", () => {
  const originalLogger = _packagesDeps.getSafeLogger;
  afterEach(() => {
    _packagesDeps.getSafeLogger = originalLogger;
  });

  function captureWarnings(): string[] {
    const warnings: string[] = [];
    const logger = makeLogger();
    logger.warn = (_channel: string, message: string) => {
      warnings.push(message);
    };
    _packagesDeps.getSafeLogger = () => logger;
    return warnings;
  }

  test("warns when a non-empty key matches no hydrated package", async () => {
    const warnings = captureWarnings();
    const registry = createPackageRegistry(createConfigLoader(minConfig), "/repo");
    await registry.hydrate(["apps/web-ui"], async () => null);
    registry.resolve("/repo/apps/does-not-exist");
    expect(warnings.some((w) => w.includes("unknown package"))).toBe(true);
  });

  test("stays quiet for a known package that simply has no override", async () => {
    const warnings = captureWarnings();
    const registry = createPackageRegistry(createConfigLoader(minConfig), "/repo");
    await registry.hydrate(["apps/web-ui"], async () => null);
    registry.resolve("/repo/apps/web-ui");
    expect(warnings).toEqual([]);
  });

  test("stays quiet for the repo-root view", async () => {
    const warnings = captureWarnings();
    const registry = createPackageRegistry(createConfigLoader(minConfig), "/repo");
    await registry.hydrate(["apps/web-ui"], async () => null);
    registry.resolve(undefined);
    expect(warnings).toEqual([]);
  });
});
```

Add `afterEach` and `makeLogger` to the existing imports at the top of the file if not already present —
the file already imports `afterEach` from `bun:test` and `makeLogger` from `@test/helpers`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/runtime/packages.test.ts --timeout=60000`
Expected: the first test FAILS (no warning emitted); the other two PASS.

- [ ] **Step 3: Implement**

In `createPackageRegistry`, add alongside the existing `mergedConfigs` declaration:

```ts
  const knownPackages = new Set<string>();
```

In `hydrate()`, record every discovered package — including ones with no override — right after the
`if (!dir) continue;` guard:

```ts
      knownPackages.add(dir);
```

In `resolve()`, replace the existing warn branch with:

```ts
    const overrideKey = toOverrideKey(key);
    if (!hasOverride && key) {
      if (!hydrated) {
        _packagesDeps
          .getSafeLogger()
          ?.warn(
            "packages",
            "resolve() called for non-root package before hydrate(); returning root config (per-package overrides not applied)",
            { storyId: "_runtime", packageDir: key },
          );
      } else if (overrideKey && !knownPackages.has(overrideKey)) {
        _packagesDeps
          .getSafeLogger()
          ?.warn(
            "packages",
            "resolve() got an unknown package key after hydrate(); returning root config (per-package overrides not applied)",
            { storyId: "_runtime", packageDir: key, overrideKey },
          );
      }
    }
```

Hoist `const overrideKey = toOverrideKey(key);` above the `mergedConfigs` lookup from Task 1 and reuse it
there, so the derivation happens once.

Note the `storyId` first key — `scripts/check-logger-storyid.ts` requires it and the pre-existing call
above is already a ratchet entry; adding a second violation would fail the gate.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/unit/runtime/packages.test.ts --timeout=60000`
Expected: PASS.

Then confirm the ratchet did not regress:

Run: `bun run check:logger-storyid`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/packages.ts test/unit/runtime/packages.test.ts
git commit -m "fix(runtime): warn when resolve() falls back to root config for an unknown package (#2069)"
```

---

### Task 3: `CallContext.config` and its consumption in `callOp` (#2066)

`callOp` reads `ctx.runtime.configLoader.current()` — the root config — and hands it to both dispatch
hops. Add the field and read it. This task does **not** populate the field in production; Task 4 does.

**Files:**
- Modify: `src/operations/types.ts` (add `config` to `CallContext`, near `packageView`)
- Modify: `src/operations/call.ts:83` (net-zero substitution)
- Test: `test/unit/operations/call-effective-config.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `CallContext.config?: NaxConfig` — read by `callOp` and forwarded as `runOptions.config` and `hopCtx.config`. Task 4 populates it.

- [ ] **Step 1: Write the failing test**

Create `test/unit/operations/call-effective-config.test.ts`:

```ts
/**
 * callOp — the per-story effective config, not the root config, reaches run options.
 *
 * nax#2066: callOp read ctx.runtime.configLoader.current() (root) while
 * codingToolRoot two lines below was package-correct, so RunCommand advertised
 * the ROOT quality.commands for a package story and ran the wrong toolchain.
 */

import { describe, expect, test } from "bun:test";
import { makeMockAgentManager, makeMockCallContext, makeNaxConfig, makeSessionManager, makeTestRuntime } from "@test/helpers";
import type { AgentRunOptions } from "@/agents";
import { type DEFAULT_CONFIG, type NaxConfig, pickSelector } from "@/config";
import type { BuildHopCallbackContext, RunOperation } from "@/operations";
import { _callOpDeps, callOp } from "@/operations";

const testSel = pickSelector("effective-config-test", "routing");

const runEchoOp: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
  kind: "run",
  name: "run-echo-effective-config",
  stage: "run",
  config: testSel,
  session: { role: "implementer", lifetime: "fresh" },
  build: (input) => ({
    role: { id: "role", content: "You echo text.", overridable: false },
    task: { id: "task", content: input.text, overridable: false },
  }),
  parse: (output) => output.trim(),
};

async function captureRunOptionsConfig(ctxConfig: NaxConfig | undefined): Promise<NaxConfig | undefined> {
  const orig = _callOpDeps.buildHopCallback;
  let seen: NaxConfig | undefined;
  _callOpDeps.buildHopCallback = (
    _hopCtx: BuildHopCallbackContext,
    _sessionId: string | undefined,
    runOptions: AgentRunOptions,
  ) => {
    seen = runOptions.config as NaxConfig | undefined;
    return async () => ({
      result: {
        success: true,
        exitCode: 0,
        output: "ok",
        rateLimited: false,
        durationMs: 0,
        estimatedCostUsd: 0,
      },
      bundle: undefined,
    });
  };

  const rootConfig = makeNaxConfig({ quality: { commands: { testScoped: "root-runner {{files}}" } } });
  const runtime = makeTestRuntime({
    config: rootConfig,
    agentManager: makeMockAgentManager({}),
    sessionManager: makeSessionManager({}),
  });
  try {
    await callOp(
      makeMockCallContext({
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        ...(ctxConfig ? { config: ctxConfig } : {}),
      }),
      runEchoOp,
      { text: "hi" },
    ).catch(() => undefined);
  } finally {
    _callOpDeps.buildHopCallback = orig;
    await runtime.close();
  }
  return seen;
}

describe("callOp — effective config reaches run options (#2066)", () => {
  test("ctx.config wins over the runtime's root config", async () => {
    const effective = makeNaxConfig({ quality: { commands: { testScoped: "pkg-runner {{files}}" } } });
    const seen = await captureRunOptionsConfig(effective);
    expect(seen?.quality?.commands?.testScoped).toBe("pkg-runner {{files}}");
  });

  test("without ctx.config it still falls back to the root config", async () => {
    const seen = await captureRunOptionsConfig(undefined);
    expect(seen?.quality?.commands?.testScoped).toBe("root-runner {{files}}");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/operations/call-effective-config.test.ts --timeout=60000`
Expected: the first test FAILS — `testScoped` is `"root-runner {{files}}"`. It may also fail to typecheck
on `config:` not existing on `CallContext`; that is the same failure.

- [ ] **Step 3: Add the field**

In `src/operations/types.ts`, inside `interface CallContext`, immediately after the `packageDir` line:

```ts
  /**
   * The per-story EFFECTIVE config — `PipelineContext.config`, which
   * `loadConfigForWorkdir(root, story.workdir)` already merged from
   * `.nax/mono/<pkg>/config.json`. `callOp` forwards it as
   * `runOptions.config`, so the declared-command map, `resolvePermissions`
   * and dispatch model resolution all see the package's own values (nax#2066).
   *
   * Absent for callers with no pipeline (plan strategies, one-off CLI ops);
   * `callOp` then falls back to the runtime's root config. Prefer this over
   * `packageView.config`: `packages.resolve()` is keyed on the absolute
   * workdir and this value is keyed on `story.workdir`, so it stays correct
   * under worktree and parallel isolation (nax#2069).
   */
  readonly config?: NaxConfig;
```

- [ ] **Step 4: Make `callOp` read it**

In `src/operations/call.ts`, replace line 83 exactly — one line for one line, no added comment
(the file is at 597/600):

```ts
  const config = ctx.config ?? ctx.runtime.configLoader.current();
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/unit/operations/call-effective-config.test.ts --timeout=60000`
Expected: PASS, both tests.

Run: `bun run check:file-sizes`
Expected: exit 0. If it fails on `call.ts`, the substitution added a line — remove it.

- [ ] **Step 6: Commit**

```bash
git add src/operations/types.ts src/operations/call.ts test/unit/operations/call-effective-config.test.ts
git commit -m "fix(operations): let callOp use the per-story effective config (#2066)"
```

---

### Task 4: Populate `CallContext.config` at every pipeline construction site (#2066)

Task 3's field is dead until something sets it. Every `CallContext` built from a `PipelineContext` has the
effective config in hand as `ctx.config`.

**Files:**
- Modify: `src/pipeline/stages/execution.ts:102` (the `callCtx` literal)
- Modify: `src/execution/lifecycle/acceptance-fix.ts:29`
- Modify: `src/execution/lifecycle/acceptance-loop.ts:187`
- Modify: `src/acceptance/hardening.ts:83` and `:130`
- Modify: `src/finish/phase.ts:213`
- Modify: `src/pipeline/stages/acceptance-setup.ts:192` (use the group config it already loads via `loadGroupConfig`, when one is in scope; otherwise `pipelineCtx.config`)
- Test: `test/unit/pipeline/execution-stage-effective-config.test.ts` (create)

Leave the plan/CLI sites alone — `src/plan/strategies/*.ts`, `src/cli/plan-command.ts`,
`src/cli/plan-decompose.ts`, `src/cli/setup.ts`, `src/routing/router.ts`. They have no per-story workdir,
and the `??` fallback is the correct behaviour there.

`src/findings/cycle-dispatch.ts:81` needs **no change**: it builds its `FixCycleContext` with `...ctx`,
so `config` propagates by spread once `buildFixCycleCtx` sets it.

**Interfaces:**
- Consumes: `CallContext.config` from Task 3.
- Produces: nothing new; wiring only.

- [ ] **Step 1: Write the failing test**

Create `test/unit/pipeline/execution-stage-effective-config.test.ts`:

```ts
/**
 * The execution stage must hand callOp the per-story effective config.
 * Without this the field added for nax#2066 is never set in production and the
 * fix is inert — declared-but-unreachable.
 */

import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { executionStage } from "@/pipeline/stages/execution";

describe("execution stage — CallContext carries the effective config (#2066)", () => {
  test("the stage source sets `config` on the CallContext literal", async () => {
    // Structural assertion: the callCtx literal must forward ctx.config.
    // A behavioural assertion here would need a full pipeline context; the
    // end-to-end path is covered by call-effective-config.test.ts.
    const source = await Bun.file("src/pipeline/stages/execution.ts").text();
    const callCtxBlock = source.slice(source.indexOf("const callCtx: CallContext = {"));
    expect(callCtxBlock.slice(0, 400)).toContain("config: ctx.config");
    expect(typeof executionStage.execute).toBe("function");
    expect(makeNaxConfig().version).toBe(1);
  });
});
```

> If the reviewer objects to a source-text assertion, replace it with a behavioural test that builds a
> full `PipelineContext` and spies on `_executionDeps`. The structural form is here because the
> execution stage's `execute` needs a large fixture, and the behavioural half of this wiring is already
> covered by Task 3's test.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/pipeline/execution-stage-effective-config.test.ts --timeout=60000`
Expected: FAIL — `config: ctx.config` is not in the literal.

- [ ] **Step 3: Wire the execution stage**

In `src/pipeline/stages/execution.ts`, in the `const callCtx: CallContext = {` literal, immediately after
the `packageDir: ctx.workdir,` line:

```ts
      // nax#2066: the per-story effective config (loadConfigForWorkdir over
      // story.workdir). callOp forwards it to both dispatch hops, so the
      // declared-command map and resolvePermissions see the package's values.
      config: ctx.config,
```

- [ ] **Step 4: Wire the remaining pipeline sites**

Each of these builds a `CallContext` and has a `PipelineContext` (or an effective config) in scope. Add
the same `config:` entry to each literal:

- `src/execution/lifecycle/acceptance-fix.ts:29` → `config: ctx.config,`
- `src/execution/lifecycle/acceptance-loop.ts:187` — this is `buildFixCycleCtx`, returning a
  `FixCycleContext` (`src/findings/cycle-types.ts:189` defines it as `CallContext & {...}`, so the field
  is valid). Its `ctx: AcceptanceLoopContext` carries `config`. Add `config: ctx.config,` after the
  `packageDir,` line.
- `src/acceptance/hardening.ts:83` and `:130` → `config: ctx.config,`
- `src/finish/phase.ts:213` → `config: ctx.config,`
- `src/pipeline/stages/acceptance-setup.ts:192` → `config: pipelineCtx.config,`

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/unit/pipeline/execution-stage-effective-config.test.ts --timeout=60000`
Expected: PASS.

Run: `bun run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/stages/execution.ts src/execution/lifecycle/acceptance-fix.ts src/execution/lifecycle/acceptance-loop.ts src/acceptance/hardening.ts src/finish/phase.ts src/pipeline/stages/acceptance-setup.ts test/unit/pipeline/execution-stage-effective-config.test.ts
git commit -m "fix(pipeline): thread the effective config into every pipeline CallContext (#2066)"
```

---

### Task 5: Reject `target` on `RunCommand`'s declared-command branch

`target` is documented as *"Working directory for `argv`"* and is read only in `run-command-exec.ts:65`.
On the declared branch `run-command.ts` passes `workdir: ctx.root` and never reads it. In the audited run
48 of 136 declared-command calls (35%) carried a `target` that was silently discarded. Rejecting names the
mistake; honouring it is out of scope (see the spec).

**Files:**
- Modify: `src/tools/run-command.ts` (in `run()`, after the `hasArgv` early return)
- Test: `test/unit/tools/run-command.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a new `isError: true` result for `{command, target}` calls.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/tools/run-command.test.ts`, following the file's existing tool-construction helper:

```ts
describe("RunCommand — target is argv-only", () => {
  test("a declared command with target is rejected, naming why", async () => {
    const tool = createRunCommandTool(new Map([["test", "echo hi"]]));
    const result = await tool.run(
      { command: "test", target: "repoRoot" },
      { root: "/repo", resolvedPaths: [] } as never,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("target");
    expect(result.content).toContain("argv");
  });

  test("a declared command without target still runs", async () => {
    const tool = createRunCommandTool(new Map([["test", "echo hi"]]));
    const result = await tool.run({ command: "test" }, { root: "/repo", resolvedPaths: [] } as never);
    expect(result.isError).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/tools/run-command.test.ts --timeout=60000`
Expected: the first test FAILS — `isError` is falsy because `target` is ignored.

- [ ] **Step 3: Implement**

In `src/tools/run-command.ts`, in `run()`, immediately after `if (hasArgv) return runExecBranch(input, ctx, opts);`:

```ts
      // #2066: `target` is read only on the argv branch (run-command-exec.ts).
      // 48 of 136 declared-command calls in one audited run carried a `target`
      // that was silently discarded, and the transcript shows the model
      // reasoning about it while trying to fix a failure. Silently ignoring it
      // is the one option that teaches nothing.
      if (input.target !== undefined) {
        return {
          content: `"target" applies only to "argv" calls; a declared command runs in the directory its configuration declares. Remove "target" and call "${typeof input.command === "string" ? input.command : ""}" on its own.`,
          isError: true,
        };
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/unit/tools/run-command.test.ts --timeout=60000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/run-command.ts test/unit/tools/run-command.test.ts
git commit -m "fix(tools): reject target on RunCommand's declared-command branch (#2066)"
```

---

### Task 6: Log the resolved declared-command keys and permission profile

This class of defect took a full transcript audit to find because nothing in the run artifacts named what
the agent was actually given. One line per dispatch fixes that.

**Files:**
- Modify: `src/agents/coding-tool-support.ts` (in `resolveCodingToolSupport`, after `declaredCommands` is built ~line 290)
- Test: `test/unit/agents/coding-tool-support.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a `debug` line on the `tools` logger channel.

Note: `coding-tool-support.ts` has **no** `_deps` seam — it imports `getSafeLogger` from `@/logger`
directly (line 13) and logs on the `"tools"` channel (see its existing calls at lines 207 and 362). Do not
add a seam; capture the entry with a log sink, the pattern used in
`test/unit/pipeline/runner-throw-logging.test.ts`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/agents/coding-tool-support.test.ts`:

```ts
describe("resolveCodingToolSupport — dispatch visibility (#2066)", () => {
  let logCalls: LogEntry[];

  beforeEach(() => {
    resetLogger();
    logCalls = [];
    initLogger({ level: "silent" });
    addSink((entry) => logCalls.push(entry));
  });

  test("logs the declared command keys and the resolved permission profile", async () => {
    await resolveCodingToolSupport({
      declaredTools: ["Read"],
      codingToolRoot: "/repo/apps/web-ui",
      codingToolRepoRoot: "/repo",
      pipelineStage: "run",
      storyId: "US-005",
      config: makeNaxConfig({ quality: { commands: { testScoped: "pkg-runner {{files}}" } } }),
    } as never);

    const entry = logCalls.find((l) => l.message.includes("Declared commands resolved"));
    expect(entry).toBeDefined();
    expect(entry?.data?.commands).toEqual(["testScoped"]);
    expect(entry?.data?.storyId).toBe("US-005");
  });
});
```

Add to the file's imports:

```ts
import { addSink, initLogger, resetLogger } from "@/logger";
import type { LogEntry } from "@/logger/types";
```

and `beforeEach` to the existing `bun:test` import.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/agents/coding-tool-support.test.ts --timeout=60000`
Expected: FAIL — no such log line.

- [ ] **Step 3: Implement**

In `src/agents/coding-tool-support.ts`, after the `declaredCommands` map is constructed:

```ts
  // nax#2066: the declared-command map came from the ROOT config for a package
  // story, and nothing in the run artifacts said so — it took a transcript audit
  // to find. Name what the agent was actually given, once per dispatch.
  getSafeLogger()?.debug("tools", "Declared commands resolved for dispatch", {
    storyId: options.storyId ?? "_dispatch",
    commands: [...declaredCommands.keys()],
    permissionProfile: options.config?.execution?.permissionProfile ?? "unrestricted",
    codingToolRoot: options.codingToolRoot,
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/unit/agents/coding-tool-support.test.ts --timeout=60000`
Expected: PASS.

Run: `bun run check:logger-storyid`
Expected: exit 0 — the data object's first key is `storyId`.

- [ ] **Step 5: Commit**

```bash
git add src/agents/coding-tool-support.ts test/unit/agents/coding-tool-support.test.ts
git commit -m "feat(agents): log declared commands and permission profile per dispatch (#2066)"
```

---

### Task 7: Release note for the permission movement

Per-package `execution.permissionProfile` and `execution.permissions` were inert at every dispatch site
and now apply. On a repo that already has those keys in an overlay this changes what the agent may do —
in either direction. That must be stated, not discovered.

**Files:**
- Modify: `CHANGELOG.md` (top, under the current unreleased heading — match the file's existing format exactly)

**Interfaces:**
- Consumes: the behaviour from Tasks 1-6.
- Produces: nothing code-facing.

- [ ] **Step 1: Read the existing format**

Run: `head -40 CHANGELOG.md`

Match the heading level, bullet style and issue-reference convention already in use. Do not invent a new
section shape.

- [ ] **Step 2: Add the entry**

```markdown
### Fixed

- **Monorepo: the agent loop now uses per-package config.** `callOp` resolved its config from the repo
  root, so a story with a `workdir` was given the ROOT `quality.commands` and `RunCommand` ran the wrong
  toolchain (#2066). The registry also missed every override under worktree and parallel isolation, where
  a package resolved through `.nax-wt/<storyId>/` (#2069).

  **Behaviour change:** `execution.permissionProfile` and `execution.permissions` declared in
  `.nax/mono/<pkg>/config.json` were previously inert at every dispatch site and now apply, completing the
  SEC-3 fix. Per-package `execution.denyPaths`, `models`, `agent.native.transportRetry` and
  `execution.compaction` likewise now take effect. If an overlay in your repo sets any of these, review it
  before upgrading — the resolved profile is now logged once per dispatch.
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: note the per-package permission movement (#2066, #2069)"
```

---

## Final verification

- [ ] **Full quality gates**

```bash
bun run test
bun run lint
bun run typecheck
```

All three must exit 0. `bun run lint` includes `check:file-sizes`, `check:logger-storyid` and
`check:import-cycles` — the three most likely to catch a mistake in this change.

- [ ] **Confirm the fix is reachable, not just tested**

The failure mode this plan exists to prevent is a mechanism that is declared but never runs. Confirm by
inspection that `config: ctx.config` is present in the execution stage's `callCtx` literal and that
`call.ts:83` reads `ctx.config` — Task 3's test passes with a hand-built context and would stay green if
Task 4 were skipped.

- [ ] **Open the PR**

Base the PR on `origin/main`. Check `git log origin/main..HEAD` contains only this plan's commits before
opening — the worktree may have been branched from a local HEAD rather than `origin/main`.

## Out of scope — do not implement

- Working-directory provenance for declared commands (inherited root command still runs in the package
  dir; unchanged from today, needs a separate ruling).
- Changing `PackageView.repoRoot` to point into a worktree.
- Language-aware `quality.commands` inheritance.
