# Per-package config in the agent loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the native agent loop resolve per-package `.nax/mono/<pkg>/config.json` overrides the way the deterministic ops already do, so `RunCommand` runs the package's toolchain instead of the repo root's.

**Architecture:** Two seams, in order. First `runtime/packages.ts` learns that a worktree path `.nax-wt/<storyId>/<pkg>` addresses package `<pkg>` — decoupling the *override lookup key* from the *path identity*, which must not change. Then `CallContext` gains a `config` field carrying the effective per-story config the pipeline already resolved, and `callOp` reads it instead of reaching past the pipeline to `configLoader.current()`.

**Tech Stack:** TypeScript, Bun, `bun:test`, Biome.

**Spec:** `docs/superpowers/specs/2026-09-15-per-package-config-in-the-agent-loop-design.md`

## Handover — start here

This plan was written in, and is meant to be executed in, an existing worktree. Nothing has been
implemented yet; only this plan and its spec are committed.

| | |
|---|---|
| Worktree | `<repo>/.claude/worktrees/fix-2066-per-package-config` |
| Branch | `worktree-fix-2066-per-package-config` |
| Based on | `origin/main` @ `63c4c3363` (`v0.82.0-canary.14`) |
| Commits so far | `0e07a3712` — this plan + spec, docs only |
| Baseline | `bun run test` green (unit 45s, integration 13s, ui 4s); full pre-commit gate green |

Working notes for this repo:

- **`git` commands must be prefixed `RTK_DISABLED=1`** in a worktree. An `rtk` hook rewrites `git` to
  `rtk git`, and the worktree guard refuses the rewritten form: `RTK_DISABLED=1 git add …`.
- Run everything from the worktree directory. Do not `cd` to the main checkout.
- **Never bare `bun test …` for a whole-suite run** — use `bun run test`. (Single-file
  `bun test <path> --timeout=60000` during a TDD cycle is fine and is what each task's steps use.)
- The pre-commit hook runs typecheck plus 25 static checks on every commit, so a task that commits
  cleanly has already passed most of the final gate.
- Before opening a PR, confirm `RTK_DISABLED=1 git log origin/main..HEAD` contains only this plan's
  commits. The worktree was branched from a local HEAD and reset onto `origin/main`; if you create
  another worktree, check its base rather than assuming.

## Global Constraints

- `src/operations/call.ts` is at **597/600 lines**. `SRC_LIMIT = 600` in `scripts/check-file-sizes.ts`. The `call.ts` edit must be **net-zero lines** — a substitution, no added comment.
- `scripts/check-logger-storyid.ts` (data object's **first key must be `storyId`**) scans only
  `SCOPED_DIRS = ["src/pipeline/stages", "src/debate", "src/review"]`. **No file this plan touches is in
  scope**, so it constrains nothing here — do not restructure existing log calls for it. Baseline is 0
  violations; keep it there by not adding a log to those three dirs.
- 🚨 **`scripts/check-test-escape-hatches.ts` counts `looseCast` = `/\bas\s+[A-Z]\w*/` in `test/` and
  fails on ANY growth** (current baseline 1593). Every test in this plan is written cast-free for that
  reason. If you find yourself reaching for `as SomeType` in a test, restructure the assertion instead —
  typically by asserting on a field that is actually present in the declared type. `bun run lint` runs
  this check.
- `test/` typecheck is a hard gate at 0 errors (`bun run typecheck` covers `tsconfig.test.json`), so a
  test cannot be made to compile with a suppression either.
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

Expected, per test — check each one, because three of the five pass before the fix and are there as
regression guards:

| Test | Before the fix |
|---|---|
| "a worktree package path finds the hydrated override" | **FAIL** — `hasOverride` is `false`, `lint` is `"root-lint"` |
| "packageDir still addresses the worktree, not the main checkout" | PASS (guard — must still pass after) |
| "two worktrees of the same package get distinct views" | **FAIL** — on the two `hasOverride` assertions only; the identity assertions already pass |
| "a bare worktree root resolves to the repo-level view" | PASS (guard) |
| "a package named like the worktree dir is not mistaken for one" | PASS (guard) |

If "packageDir still addresses the worktree" ever fails after your change, you have shortened the key
itself — that is the regression this task exists to avoid. Revert and re-read Step 3.

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

In `resolve()`, replace the existing warn branch with the following. **Leave the existing warning's
message and data object exactly as they are** — only the surrounding condition changes and a second
branch is added:

```ts
    if (!hasOverride && key) {
      if (!hydrated) {
        _packagesDeps
          .getSafeLogger()
          ?.warn(
            "packages",
            "resolve() called for non-root package before hydrate(); returning root config (per-package overrides not applied)",
            { packageDir: key },
          );
      } else if (overrideKey && !knownPackages.has(overrideKey)) {
        _packagesDeps
          .getSafeLogger()
          ?.warn(
            "packages",
            "resolve() got an unknown package key after hydrate(); returning root config (per-package overrides not applied)",
            { packageDir: key, overrideKey },
          );
      }
    }
```

Hoist `const overrideKey = toOverrideKey(key);` above the `mergedConfigs` lookup from Task 1 and reuse it
in both places, so the derivation happens once.

The data shape matches the existing neighbouring call. `src/runtime/` is **not** in
`check-logger-storyid`'s `SCOPED_DIRS`, so do not add a `storyId` key here — it would diverge from the
file's own convention for no gate benefit.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/unit/runtime/packages.test.ts --timeout=60000`
Expected: PASS — including every test from Task 1, which must not have regressed.

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

// The assertion field is `execution.permissionProfile`, not `quality.commands`,
// for two reasons. (1) `AgentRunOptions["config"]` is the narrow
// agentManagerConfigSelector Pick — `agent` / `execution` / `profile` — so
// reading `quality` off it would need a cast, and the looseCast ratchet fails
// on growth. (2) It is the field with the real consequence: it is what
// resolvePermissions reads, so this test pins the SEC-3 half of the change.

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

async function captureRunOptionsConfig(
  ctxConfig: NaxConfig | undefined,
): Promise<AgentRunOptions["config"]> {
  const orig = _callOpDeps.buildHopCallback;
  let seen: AgentRunOptions["config"];
  _callOpDeps.buildHopCallback = (
    _hopCtx: BuildHopCallbackContext,
    _sessionId: string | undefined,
    runOptions: AgentRunOptions,
  ) => {
    seen = runOptions.config;
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

  // "scoped" — deliberately NOT the schema default ("unrestricted"), so the
  // fallback test proves the value came from the runtime's root config rather
  // than from DEFAULT_CONFIG by coincidence.
  const rootConfig = makeNaxConfig({ execution: { permissionProfile: "scoped" } });
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
    const effective = makeNaxConfig({ execution: { permissionProfile: "safe" } });
    const seen = await captureRunOptionsConfig(effective);
    expect(seen?.execution?.permissionProfile).toBe("safe");
  });

  test("without ctx.config it still falls back to the root config", async () => {
    const seen = await captureRunOptionsConfig(undefined);
    expect(seen?.execution?.permissionProfile).toBe("scoped");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/operations/call-effective-config.test.ts --timeout=60000`
Expected: the first test FAILS — `permissionProfile` comes back `"scoped"` (the root value) instead of
`"safe"`. The second test passes already; it is the fallback guard. The file may also fail to typecheck on
`config:` not existing on `CallContext` yet; that is the same failure, resolved by Step 3.

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
 * Every CallContext built from a PipelineContext must forward the per-story
 * effective config (nax#2066). Without it the `CallContext.config` field is
 * never set in production and the fix is inert — the declared-but-unreachable
 * failure mode this change exists to close.
 *
 * A convention check rather than a behavioural one: each of these sites needs a
 * large pipeline fixture to drive, and the behavioural half (callOp honouring
 * the field) is pinned by call-effective-config.test.ts. This test guards the
 * wiring itself, which is the half that silently rots.
 */

import { describe, expect, test } from "bun:test";

// Each entry: the file, and the literal that must carry a `config:` entry.
const SITES: readonly { file: string; marker: string }[] = [
  { file: "src/pipeline/stages/execution.ts", marker: "const callCtx: CallContext = {" },
  { file: "src/pipeline/stages/acceptance-setup.ts", marker: "packageView: pipelineCtx.runtime.packages.resolve(packageDir)," },
  { file: "src/execution/lifecycle/acceptance-fix.ts", marker: "packageView: ctx.runtime.packages.resolve(ctx.workdir)," },
  { file: "src/execution/lifecycle/acceptance-loop.ts", marker: "packageView: runtime.packages.resolve(packageDir)," },
  { file: "src/finish/phase.ts", marker: "packageView: ctx.runtime.packages.resolve(ctx.workdir)," },
];

describe("pipeline CallContext sites forward the effective config (#2066)", () => {
  for (const site of SITES) {
    test(`${site.file} sets config on its CallContext literal`, async () => {
      const source = await Bun.file(site.file).text();
      const at = source.indexOf(site.marker);
      expect(at).toBeGreaterThan(-1); // marker drifted — re-anchor this entry
      // Scan a window past the marker, not the whole file, so an unrelated
      // `config:` elsewhere cannot make this pass.
      expect(source.slice(at, at + 600)).toContain("config:");
    });
  }

  test("hardening.ts sets config on both of its CallContext literals", async () => {
    const source = await Bun.file("src/acceptance/hardening.ts").text();
    const occurrences = source.split("packageView: ctx.runtime.packages.resolve(packageDir),");
    expect(occurrences.length).toBe(3); // two sites => three fragments
    for (const fragment of occurrences.slice(1)) {
      expect(fragment.slice(0, 600)).toContain("config:");
    }
  });
});
```

If a marker string has drifted, the `toBeGreaterThan(-1)` assertion fails first and names the file — fix
the marker, do not delete the entry.

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

Use the same `ToolRunContext` literal the rest of this file already uses (see the `run() names the
declared command...` describe block) — a plain object, no cast.

⚠️ The declared command is `"true"` (the shell builtin) deliberately. In the RED phase the first test
runs **before** the guard exists, so the call falls through and actually executes the declared command.
`true` exits 0 instantly and touches nothing; a command like `bun test` would re-enter the test suite.

```ts
describe("RunCommand — target is argv-only", () => {
  const ctx = { root: process.cwd(), resolvedPaths: [], maxBytes: 4096, maxFileBytes: 1024 };

  test("a declared command with target is rejected, naming why", async () => {
    const tool = createRunCommandTool(new Map([["noop", "true"]]));
    const result = await tool.run({ command: "noop", target: "repoRoot" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("target");
    expect(result.content).toContain("argv");
  });

  // Control: without `target` the guard must be inert. An undeclared command
  // name proves we reached the NEXT check rather than the new one, and returns
  // without executing anything.
  test("the guard is inert when target is absent", async () => {
    const tool = createRunCommandTool(new Map([["noop", "true"]]));
    const result = await tool.run({ command: "definitely-not-declared" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("unknown command");
    expect(result.content).not.toContain("target");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/tools/run-command.test.ts --timeout=60000`
Expected: the first test FAILS — `target` is ignored today, so the call falls through, runs `true`,
succeeds, and `isError` is falsy. The control test passes already.

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

`codingToolRoot` must be a real directory — the neighbouring tests in this file already use
`makeTempDir` for that. The options object is a plain literal with no cast, exactly as the existing
`resolveCodingToolSupport` calls in this file are written.

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
    const root = makeTempDir("nax-dispatch-log-");
    await resolveCodingToolSupport({
      declaredTools: ["Read"],
      codingToolRoot: root,
      pipelineStage: "run",
      storyId: "US-005",
      config: makeNaxConfig({ quality: { commands: { testScoped: "pkg-runner {{files}}" } } }),
    });

    const entry = logCalls.find((l) => l.message.includes("Declared commands resolved"));
    expect(entry).toBeDefined();
    expect(entry?.data?.commands).toEqual(["testScoped"]);
    expect(entry?.data?.storyId).toBe("US-005");
  });
});
```

`makeNaxConfig()` returns a full `NaxConfig`, which is structurally assignable to the narrower
`AgentRunOptions["config"]` the parameter declares — that is why no cast is needed, and it is how the
existing calls in this file already pass `config: makeNaxConfig()`.

Add to the file's imports:

```ts
import { addSink, initLogger, resetLogger } from "@/logger";
import type { LogEntry } from "@/logger/types";
```

and `beforeEach` to the existing `bun:test` import. `makeTempDir` and `makeNaxConfig` are already
imported by this file.

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

`storyId` leads the data object by convention and because it is what makes the line greppable per story
in run artifacts — `src/agents/` is not in `check-logger-storyid`'s `SCOPED_DIRS`, so no gate enforces it
here.

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
