# Issue 2 — Quality-Gate Config Wiring (2a + 2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make quality/verification gates read real, per-package-merged config so unconfigured gates skip-with-warning (never false-pass) and configured per-package commands (`.nax/mono/<pkg>/config.json`) actually run.

**Architecture:** Two layered defects (full diagnosis: `docs/findings/2026-06-08-model-tier-and-quality-gate-diagnosis.md`).
- **2a:** six `DeterministicOperation`s read a phantom `(ctx as { config }).config` that `CallContext` never carries → always `undefined` → empty command → `/bin/sh -c ""` → exit 0 → false "passed". Fix = read `ctx.packageView.select(qualityConfigSelector)`.
- **2b:** `runtime.packages.resolve()` (`src/runtime/packages.ts:48`) is a Wave-1 stub returning root config; per-package `.nax/mono/<pkg>/config.json` is never merged in the main run. Fix = eager-hydrate the registry with merged per-package configs at run setup (keeps `resolve()` sync). After 2a, every migrated op benefits from 2b automatically.
- Plus: **skip-with-warning** semantics for unconfigured lint/typecheck/format, and a **defense-in-depth** guard so `runQualityCommand` never spawns an empty command.

**Tech Stack:** Bun, TypeScript strict, `bun:test`, Zod config, `mergePackageConfig` (already proven in `loadConfigForWorkdir`).

**Sequencing:** 2a and 2b interact — landing 2a alone would route gates through whole-repo root commands. This plan lands them together (Phases A→B→C). Test command absence stays a **hard error** (`full-suite-gate` `TEST_COMMAND_MISSING`); only lint/typecheck/format absence warns-and-skips.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/config/loader.ts` | add `loadPackageOverride(repoRoot, packageDir)` | Modify (extract existing mono read) |
| `src/config/index.ts` | export `loadPackageOverride` | Modify |
| `src/runtime/packages.ts` | registry: per-package merge via eager `hydrate()` | Modify |
| `src/execution/lifecycle/run-setup.ts` | call `hydrate()` after `createRuntime` | Modify |
| `src/operations/lint-check.ts` | read config via packageView + skip-with-warning | Modify |
| `src/operations/typecheck-check.ts` | same | Modify |
| `src/operations/verify-scoped.ts` | read config via packageView | Modify |
| `src/operations/mechanical-lintfix-strategy.ts` | read config via packageView | Modify |
| `src/operations/mechanical-formatfix-strategy.ts` | read config via packageView | Modify |
| `src/operations/full-suite-gate.ts` | flags via packageView; `resolveGateContext` via packageView config | Modify |
| `src/quality/runner.ts` | reject empty/whitespace command | Modify |
| `test/unit/config/load-package-override.test.ts` | loader helper | Create |
| `test/unit/runtime/packages.test.ts` | registry hydration/merge | Modify (append) |
| `test/unit/operations/lint-check.test.ts` | packageView reads + skip-warning | Modify |
| `test/unit/operations/quality-gate-packageview.test.ts` | typecheck/verify-scoped/full-suite via packageView | Create |
| `test/unit/quality/runner-empty-command.test.ts` | empty-command guard | Create |

---

# Phase A — Per-package config reaches the registry (2b foundation)

## Task A1: Extract `loadPackageOverride` helper

The merge logic already lives inline in `loadConfigForWorkdir` (`src/config/loader.ts:487-501`). Extract the override-read half so the runtime registry can reuse it without re-implementing the path convention.

**Files:**
- Modify: `src/config/loader.ts`
- Modify: `src/config/index.ts`
- Test: `test/unit/config/load-package-override.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `test/unit/config/load-package-override.test.ts`:

```typescript
import { describe, expect, test, afterEach } from "bun:test";
import { loadPackageOverride } from "@/config";
import { makeTempDir, cleanupTempDir } from "@test/helpers/temp";
import { join } from "node:path";

// NOTE: makeTempDir/cleanupTempDir are SYNCHRONOUS (test/helpers/temp.ts) — do NOT await them.
let tmp: string | undefined;
afterEach(() => { cleanupTempDir(tmp); tmp = undefined; });

describe("loadPackageOverride", () => {
  test("returns the parsed mono config.json for a package", async () => {
    tmp = makeTempDir("lpo");
    const dir = join(tmp, ".nax", "mono", "packages", "agent");
    await Bun.write(join(dir, "config.json"), JSON.stringify({ quality: { commands: { lint: "ruff check packages/agent" } } }));
    const override = await loadPackageOverride(tmp, "packages/agent");
    expect(override?.quality?.commands?.lint).toBe("ruff check packages/agent");
  });

  test("returns null when no per-package config exists", async () => {
    tmp = makeTempDir("lpo");
    expect(await loadPackageOverride(tmp, "packages/missing")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/config/load-package-override.test.ts --timeout=5000`
Expected: FAIL — `loadPackageOverride` is not exported.

- [ ] **Step 3: Add the helper in `src/config/loader.ts`**

Add this exported function (near `loadConfigForWorkdir`). It reuses the existing imports `loadJsonFile`, `PROJECT_NAX_DIR`, `join`:

```typescript
/**
 * Read (but do NOT merge) the per-package override at
 * `<repoRoot>/.nax/mono/<packageDir>/config.json`. Returns null when absent.
 * The `profile` key (if present) is stripped — package profiles are resolved by
 * loadConfigForWorkdir, not by the runtime registry.
 */
export async function loadPackageOverride(
  repoRoot: string,
  packageDir: string,
): Promise<Partial<NaxConfig> | null> {
  const packageConfigPath = join(repoRoot, PROJECT_NAX_DIR, "mono", packageDir, "config.json");
  const override = await loadJsonFile<Partial<NaxConfig> & { profile?: string }>(packageConfigPath, "config");
  if (!override) return null;
  const { profile: _profile, ...fields } = override;
  return fields;
}
```

In `src/config/index.ts`, add `loadPackageOverride` to the existing loader export, AND add a barrel export for `mergePackageConfig` (Task A2 needs it; the barrel currently only re-exports `deepMergeConfig` from `./merger` at line 52 — `mergePackageConfig` lives in `./merge` and is not yet barrel-exported):

```typescript
export { loadConfig, loadConfigForWorkdir, loadPackageOverride, findProjectDir, globalConfigPath } from "./loader";
export { mergePackageConfig } from "./merge";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/config/load-package-override.test.ts --timeout=5000`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config/loader.ts src/config/index.ts test/unit/config/load-package-override.test.ts
git commit -m "feat(config): extract loadPackageOverride helper for runtime registry reuse"
```

---

## Task A2: Registry merges per-package config via eager `hydrate()`

Keep `resolve()` synchronous (it is called in 9 sync sites). Add an async `hydrate(packageDirs)` that pre-loads + merges each override into an internal map; `resolve(packageDir)` looks up the merged config, else falls back to root (back-compat).

**Files:**
- Modify: `src/runtime/packages.ts`
- Test: `test/unit/runtime/packages.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `test/unit/runtime/packages.test.ts`:

```typescript
import { loadPackageOverride } from "@/config";

describe("PackageRegistry.hydrate — per-package merge", () => {
  test("resolve(pkg) returns merged config after hydrate", async () => {
    const loader = createConfigLoader(makeNaxConfig({ quality: { commands: { lint: "root-lint" } } } as any));
    const registry = createPackageRegistry(loader, "/repo");
    // Inject a fake override loader to avoid disk I/O.
    await registry.hydrate(["packages/agent"], async (_root, dir) =>
      dir === "packages/agent" ? ({ quality: { commands: { lint: "pkg-lint" } } } as any) : null,
    );
    const view = registry.resolve("packages/agent");
    expect(view.config.quality?.commands?.lint).toBe("pkg-lint");
  });

  test("resolve(unhydrated pkg) falls back to root config", () => {
    const loader = createConfigLoader(makeNaxConfig({ quality: { commands: { lint: "root-lint" } } } as any));
    const registry = createPackageRegistry(loader, "/repo");
    expect(registry.resolve("packages/other").config.quality?.commands?.lint).toBe("root-lint");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/runtime/packages.test.ts -t "hydrate" --timeout=5000`
Expected: FAIL — `registry.hydrate` is not a function; merged view returns `root-lint`.

- [ ] **Step 3: Implement hydration in `src/runtime/packages.ts`**

Replace the file body with (keeping `createPackageView` unchanged):

```typescript
// mergePackageConfig is barrel-exported from ../config by Task A1.
import { type ConfigLoader, type ConfigSelector, mergePackageConfig, type NaxConfig } from "../config";

export interface PackageView {
  readonly packageDir: string;
  readonly relativeFromRoot: string;
  readonly config: NaxConfig;
  select<C>(selector: ConfigSelector<C>): C;
}

/** Override-loader seam — injectable so unit tests avoid disk I/O. */
export type PackageOverrideLoader = (repoRoot: string, packageDir: string) => Promise<Partial<NaxConfig> | null>;

export interface PackageRegistry {
  all(): readonly PackageView[];
  resolve(packageDir?: string): PackageView;
  repo(): PackageView;
  /** Eager-load + merge per-package overrides. Call once at run setup. Idempotent per dir. */
  hydrate(packageDirs: readonly string[], loadOverride?: PackageOverrideLoader): Promise<void>;
}

// createPackageView unchanged — copy from current file (lines 16-37).

export function createPackageRegistry(loader: ConfigLoader, repoRoot: string): PackageRegistry {
  const cache = new Map<string, PackageView>();
  const mergedConfigs = new Map<string, NaxConfig>(); // packageDir -> merged config

  function resolve(packageDir?: string): PackageView {
    const key = packageDir ?? "";
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    // Merged per-package config if hydrated; else root config (back-compat).
    const config = mergedConfigs.get(key) ?? loader.current();
    const view = createPackageView(config, key, repoRoot);
    cache.set(key, view);
    return view;
  }

  async function hydrate(packageDirs: readonly string[], loadOverride?: PackageOverrideLoader): Promise<void> {
    const load = loadOverride ?? (await import("../config")).loadPackageOverride;
    for (const dir of packageDirs) {
      if (!dir || mergedConfigs.has(dir)) continue;
      const override = await load(repoRoot, dir);
      if (!override) continue;
      mergedConfigs.set(dir, mergePackageConfig(loader.current(), override));
      cache.delete(dir); // invalidate any root-config view resolved before hydrate
    }
  }

  return {
    all() { return [...cache.values()]; },
    resolve,
    repo() { return resolve(undefined); },
    hydrate,
  };
}
```

> `mergePackageConfig` is exported from `../config` by Task A1 Step 3. The dynamic `(await import("../config")).loadPackageOverride` inside `hydrate` avoids a static import cycle (runtime → config → runtime) while still resolving the real helper at call time.

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/runtime/packages.test.ts --timeout=5000`
Expected: PASS (existing 5 + new 2).

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: clean (the `PackageRegistry` interface gained `hydrate`; the only implementer is `createPackageRegistry`).

- [ ] **Step 6: Commit**

```bash
git add src/runtime/packages.ts test/unit/runtime/packages.test.ts
git commit -m "feat(runtime): PackageRegistry.hydrate merges per-package config (2b)"
```

---

## Task A3: Hydrate the registry at run setup

**Files:**
- Modify: `src/execution/lifecycle/run-setup.ts` (after `createRuntime`, ~line 182)
- Test: covered by Phase C end-to-end + existing run-setup tests.

- [ ] **Step 1: Add the hydrate call**

In `src/execution/lifecycle/run-setup.ts`, add two imports. `discoverWorkspacePackages` is NOT in the `test-runners` barrel — import it from the leaf, matching existing importers (`src/commands/detect.ts:26`, `src/cli/setup-analyze.ts:13`). `getSafeLogger` is already imported (line 24); `errorMessage` is not.

```typescript
import { discoverWorkspacePackages } from "../../test-runners/detect/workspace";
import { errorMessage } from "../../utils/errors";
```

> Verify the relative path to `utils/errors` resolves from `src/execution/lifecycle/` (it is `../../utils/errors`). Confirm `errorMessage` is the export name in `src/utils/errors.ts` (it is, per `.claude/rules/error-handling.md`).

Immediately after the `const runtime = createRuntime(config, workdir, {...})` block (~line 182-onwards, after the runtime is fully constructed) — `workdir` is the run's repo root, in scope here — add:

```typescript
  // 2b: merge per-package .nax/mono/<pkg>/config.json into the runtime registry so
  // every packageView consumer (quality gates, smart-runner, context) sees the
  // package's own commands — not just root config. Failure is non-fatal (root fallback).
  try {
    const workspacePackages = await discoverWorkspacePackages(workdir);
    if (workspacePackages.length > 0) {
      await runtime.packages.hydrate(workspacePackages);
    }
  } catch (err) {
    getSafeLogger()?.warn("run-setup", "Per-package config hydration failed — using root config", {
      storyId: "_setup",
      error: errorMessage(err),
    });
  }
```

> Uses `getSafeLogger()` (already imported, null-safe). Note `storyId: "_setup"` as the first data key — `run-setup.ts` uses this sentinel elsewhere (e.g. line 239) to satisfy the structured-log `storyId`-first rule.

- [ ] **Step 2: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 3: Run run-setup tests**

Run: `timeout 60 bun test test/unit/execution/ -t "run-setup" --timeout=10000`
Expected: PASS (or run the relevant lifecycle suite). Investigate any failure caused by the new async call.

- [ ] **Step 4: Commit**

```bash
git add src/execution/lifecycle/run-setup.ts
git commit -m "feat(execution): hydrate per-package config at run setup (2b)"
```

---

# Phase B — Ops read real config via packageView (2a)

## Task B1: `lint-check` reads packageView + skip-with-warning

**Files:**
- Modify: `src/operations/lint-check.ts:40-64`
- Test: `test/unit/operations/lint-check.test.ts` (modify)

- [ ] **Step 1: Update the failing tests**

The current tests inject a phantom `config` on `ctx`. Rewrite them to provide a fake `packageView`. Replace the `mockCtx` and the AC10 test in `test/unit/operations/lint-check.test.ts` with:

```typescript
import { qualityConfigSelector } from "@/config";

function ctxWithQuality(quality?: Record<string, unknown>) {
  const config = { quality, execution: {} } as any;
  return {
    runtime: {},
    storyId: "US-003",
    packageView: { packageDir: "packages/agent", config, select: (sel: any) => sel.select(config) },
  } as any;
}

test("runs the lint command resolved from packageView", async () => {
  let seen = "";
  const deps = makeDeps({ runQualityCommand: async (o) => { seen = o.command; return passedResult; } });
  await lintCheckOp.execute({ workdir: "/w", storyId: "US-003" }, ctxWithQuality({ commands: { lint: "ruff check packages/agent" } }), deps);
  expect(seen).toBe("ruff check packages/agent");
});

test("skips with success+warning when no lint command is configured (no false command)", async () => {
  let called = false;
  const deps = makeDeps({ runQualityCommand: async () => { called = true; return passedResult; } });
  const out = await lintCheckOp.execute({ workdir: "/w", storyId: "US-003" }, ctxWithQuality({ commands: {} }), deps);
  expect(called).toBe(false);             // never spawns an empty command
  expect(out.success).toBe(true);          // skip is non-blocking
  expect(out.findings).toEqual([]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `timeout 30 bun test test/unit/operations/lint-check.test.ts --timeout=5000`
Expected: FAIL — op reads phantom `ctx.config`, ignores packageView; "runs the lint command" sees `""`.

- [ ] **Step 3: Rewrite `lint-check.ts` execute body**

Replace lines 40-64 of `src/operations/lint-check.ts` with:

```typescript
  async execute(
    input: LintCheckInput,
    ctx: CallContext,
    deps: LintCheckDeps = _lintCheckDeps,
  ): Promise<LintCheckOutput> {
    const quality = ctx.packageView.select(qualityConfigSelector).quality;
    const command = quality?.commands?.lint;

    // No command configured → skip (success, non-blocking) with a warning.
    // Never spawn an empty command (that would exit 0 and read as a false pass).
    if (!command) {
      getSafeLogger()?.warn("quality", "No lint command configured — skipping lint gate", {
        storyId: input.storyId,
        packageDir: ctx.packageView.packageDir,
      });
      return { success: true, findings: [], durationMs: 0 };
    }

    const start = Date.now();
    const result = await deps.runQualityCommand({
      commandName: "lint",
      command,
      workdir: input.workdir,
      storyId: input.storyId,
      stripEnvVars: quality?.stripEnvVars ?? [],
    });

    if (result.exitCode === 0) {
      return { success: true, findings: [], durationMs: Date.now() - start };
    }
    const parsed = deps.parseLintOutput(result.output, "auto", { workdir: input.workdir });
    return { success: false, findings: parsed?.findings ?? [], durationMs: Date.now() - start };
  },
```

Add imports at the top of `lint-check.ts`: `qualityConfigSelector` (from `../config`) is already imported; add the logger:

```typescript
import { getSafeLogger } from "../logger";
```

> Confirm the logger accessor name/path used elsewhere in `src/operations` (`getSafeLogger` is used in `call.ts`). Match the existing import.

- [ ] **Step 4: Run to verify pass**

Run: `timeout 30 bun test test/unit/operations/lint-check.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/operations/lint-check.ts test/unit/operations/lint-check.test.ts
git commit -m "fix(quality): lint-check reads packageView config + skips-with-warning (2a)"
```

---

## Task B2: `typecheck-check` reads packageView + skip-with-warning

**Files:**
- Modify: `src/operations/typecheck-check.ts:44-60`
- Test: `test/unit/operations/quality-gate-packageview.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `test/unit/operations/quality-gate-packageview.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { typecheckCheckOp } from "@/operations";
import { qualityConfigSelector } from "@/config";

function ctxWithQuality(quality?: Record<string, unknown>) {
  const config = { quality, execution: {} } as any;
  return { runtime: {}, storyId: "US-003", packageView: { packageDir: "packages/agent", config, select: (s: any) => s.select(config) } } as any;
}

describe("typecheckCheckOp via packageView", () => {
  test("runs the typecheck command from packageView", async () => {
    let seen = "";
    const deps = { runQualityCommand: async (o: any) => { seen = o.command; return { commandName: "typecheck", command: o.command, success: true, exitCode: 0, output: "", durationMs: 1, timedOut: false }; }, parseTypecheckOutput: () => null } as any;
    await typecheckCheckOp.execute({ workdir: "/w", storyId: "US-003" }, ctxWithQuality({ commands: { typecheck: "mypy packages/agent/src" } }), deps);
    expect(seen).toBe("mypy packages/agent/src");
  });

  test("skips with success when no typecheck command configured", async () => {
    let called = false;
    const deps = { runQualityCommand: async () => { called = true; return {} as any; }, parseTypecheckOutput: () => null } as any;
    const out = await typecheckCheckOp.execute({ workdir: "/w", storyId: "US-003" }, ctxWithQuality({ commands: {} }), deps);
    expect(called).toBe(false);
    expect(out.success).toBe(true);
  });
});
```

> Confirm the typecheck op's deps key name (`parseTypecheckOutput` vs similar) by reading `src/operations/typecheck-check.ts` deps interface, and match it.

- [ ] **Step 2: Run to verify failure**

Run: `timeout 30 bun test test/unit/operations/quality-gate-packageview.test.ts -t "typecheck" --timeout=5000`
Expected: FAIL.

- [ ] **Step 3: Rewrite `typecheck-check.ts` execute body**

Mirror Task B1 exactly, swapping `lint` → `typecheck`. Replace the phantom-config read at line 46 (`const ctxConfig = (ctx as unknown as ...).config; const command = ctxConfig?.quality?.commands?.typecheck;`) and the dead skip-guard with:

```typescript
    const quality = ctx.packageView.select(qualityConfigSelector).quality;
    const command = quality?.commands?.typecheck;
    if (!command) {
      getSafeLogger()?.warn("quality", "No typecheck command configured — skipping typecheck gate", {
        storyId: input.storyId,
        packageDir: ctx.packageView.packageDir,
      });
      return { success: true, findings: [], durationMs: 0 };
    }
```

Keep the rest of the execute body (the `runQualityCommand` call and result handling) but pass `command` (not `command ?? ""`) and `stripEnvVars: quality?.stripEnvVars ?? []`. Add the `getSafeLogger` and `qualityConfigSelector` imports as in B1.

- [ ] **Step 4: Run to verify pass**

Run: `timeout 30 bun test test/unit/operations/quality-gate-packageview.test.ts -t "typecheck" --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/operations/typecheck-check.ts test/unit/operations/quality-gate-packageview.test.ts
git commit -m "fix(quality): typecheck-check reads packageView config + skips-with-warning (2a)"
```

---

## Task B3: `verify-scoped` reads packageView

`verify-scoped`'s `!ctxConfig` guard makes it an unconditional no-op in production. Switch to packageView so scoped per-story tests actually run.

**Files:**
- Modify: `src/operations/verify-scoped.ts:61-91`
- Test: `test/unit/operations/quality-gate-packageview.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `test/unit/operations/quality-gate-packageview.test.ts`:

```typescript
import { verifyScopedOp, _verifyScopedDeps } from "@/operations";

describe("verifyScopedOp via packageView", () => {
  test("reads quality.commands.test from packageView (not phantom ctx.config)", async () => {
    let sawTestCommand: string | undefined;
    const deps = {
      ..._verifyScopedDeps,
      selectScopedTests: async (o: any) => { sawTestCommand = o.testCommand; return { isFullSuite: true, isMonorepoOrchestrator: false, thresholdFallback: false, files: [], command: o.testCommand }; },
    } as any;
    await verifyScopedOp.execute(
      { workdir: "/w", storyId: "US-003", regressionMode: "deferred" } as any,
      ctxWithQuality({ commands: { test: "pytest packages/agent/tests" } }),
      deps,
    );
    expect(sawTestCommand).toBe("pytest packages/agent/tests");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `timeout 30 bun test test/unit/operations/quality-gate-packageview.test.ts -t "verifyScopedOp" --timeout=5000`
Expected: FAIL — phantom config → `!ctxConfig` no-op returns before `selectScopedTests`, so `sawTestCommand` is undefined.

- [ ] **Step 3: Rewrite the config read in `verify-scoped.ts`**

`verify-scoped.ts` already imports `getLogger` (line 5) and has `const logger = getLogger();` (line 61) — reuse that local `logger`, do NOT add `getSafeLogger`. Replace lines 62-75 (`const ctxConfig = (ctx as unknown as { config? }).config; const baseCommand = ...; if (!ctxConfig || !baseCommand) { ... no-op }`) with:

```typescript
    const quality = ctx.packageView.select(qualityConfigSelector);
    const baseCommand = quality.quality?.commands?.test;

    // No test command configured → skip (deferred run-end gate still covers regressions).
    if (!baseCommand) {
      logger.warn("quality", "No test command configured — skipping scoped verify", {
        storyId: input.storyId,
        packageDir: ctx.packageView.packageDir,
      });
      return { success: true, status: "skipped", findings: [], durationMs: 0, passCount: 0, isFullSuite: true };
    }
```

Then update the subsequent references that read `ctxConfig.*` to read from `quality.*`:
- `ctxConfig.quality?.commands?.testScoped` → `quality.quality?.commands?.testScoped`
- `ctxConfig.execution?.smartTestRunner` → `quality.execution?.smartTestRunner`
- `ctxConfig.quality?.scopeTestThreshold` → `quality.quality?.scopeTestThreshold`
- `ctxConfig.quality?.commands?.test` → `quality.quality?.commands?.test`

Add only the `qualityConfigSelector` import (`getLogger` is already imported).

> Note: the prior no-op returned `status: "passed"`; this returns `status: "skipped"` to stop a no-op reading as a pass. Verify the orchestrator treats `"skipped"` as non-blocking (it does for `full-suite-gate` skips).

- [ ] **Step 4: Run to verify pass**

Run: `timeout 30 bun test test/unit/operations/quality-gate-packageview.test.ts -t "verifyScopedOp" --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/operations/verify-scoped.ts test/unit/operations/quality-gate-packageview.test.ts
git commit -m "fix(quality): verify-scoped reads packageView config so scoped tests actually run (2a)"
```

---

## Task B4: `mechanical-lintfix` + `mechanical-formatfix` read packageView

**Files:**
- Modify: `src/operations/mechanical-lintfix-strategy.ts:56` and `src/operations/mechanical-formatfix-strategy.ts:60`
- Test: `test/unit/operations/mechanical-lintfix-strategy.test.ts` (modify if it injects phantom config)

- [ ] **Step 1: Inspect + update tests**

Read both test files. Where they construct a ctx with a phantom `config`, switch to the `ctxWithQuality` packageView shape (as in B1). Add an assertion that the resolved fix command comes from packageView.

- [ ] **Step 2: Run to verify failure**

Run: `timeout 30 bun test test/unit/operations/mechanical-lintfix-strategy.test.ts --timeout=5000`
Expected: FAIL after the test update.

- [ ] **Step 3: Rewrite the config reads**

The lintfix strategy reads BOTH a broad and a scoped command and composes them via `buildCommand` (verified at `mechanical-lintfix-strategy.ts:56-70`). Replace the phantom read block:

```typescript
    const ctxConfig = (ctx as unknown as { config?: QualityConfig }).config;
    const broad = ctxConfig?.quality?.commands?.lintFix;
    const scoped = ctxConfig?.quality?.commands?.lintFixScoped;
    const command = buildCommand(broad, scoped, input.scopeFiles);
    if (!command) return { applied: true, exitCode: 0 };
    const result = await deps.runQualityCommand({
      commandName: "lintFix",
      command,
      workdir: input.workdir,
      storyId: input.storyId,
      stripEnvVars: ctxConfig?.quality?.stripEnvVars ?? [],
    });
```

with:

```typescript
    const quality = ctx.packageView.select(qualityConfigSelector).quality;
    const broad = quality?.commands?.lintFix;
    const scoped = quality?.commands?.lintFixScoped;
    const command = buildCommand(broad, scoped, input.scopeFiles);
    if (!command) return { applied: true, exitCode: 0 }; // already no-ops gracefully — never spawns ""
    const result = await deps.runQualityCommand({
      commandName: "lintFix",
      command,
      workdir: input.workdir,
      storyId: input.storyId,
      stripEnvVars: quality?.stripEnvVars ?? [],
    });
```

For `mechanical-formatfix-strategy.ts`, apply the identical change but read `formatFix` / `formatFixScoped` (the format strategy's command keys — read the file to confirm the exact key names and `buildCommand` usage; mirror whatever shape it currently has, swapping only the phantom `ctxConfig` source for `ctx.packageView.select(qualityConfigSelector).quality`). Add the `qualityConfigSelector` import to both files (already imported as the op `config:` selector — confirm it is imported as a value, not only referenced).

- [ ] **Step 4: Run to verify pass**

Run: `timeout 30 bun test test/unit/operations/mechanical-lintfix-strategy.test.ts test/unit/operations/mechanical-formatfix-strategy.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/operations/mechanical-lintfix-strategy.ts src/operations/mechanical-formatfix-strategy.ts test/unit/operations/mechanical-lintfix-strategy.test.ts test/unit/operations/mechanical-formatfix-strategy.test.ts
git commit -m "fix(quality): mechanical lint/format fixers read packageView config (2a)"
```

---

## Task B5: `full-suite-gate` reads packageView (flags + test command)

`full-suite-gate` has two leaks: phantom flag reads (`regressionGate.enabled`, `acceptOnTimeout`) at line 198, and `resolveGateContext` using `ctx.runtime.configLoader.current()` (root) at line 111. Both must use the package-merged config.

**Files:**
- Modify: `src/operations/full-suite-gate.ts:111` and `:198`
- Test: `test/unit/operations/quality-gate-packageview.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append:

```typescript
import { _fullSuiteGateDeps, fullSuiteGateOp } from "@/operations";

describe("fullSuiteGateOp uses package config", () => {
  test("resolveGateContext resolves the PACKAGE test command, not root", async () => {
    // packageView merged config carries the package command; configLoader.current() is root.
    const config = { quality: { commands: { test: "pytest packages/agent/tests" } }, execution: {} } as any;
    const ctx = {
      runtime: { configLoader: { current: () => ({ quality: { commands: { test: "pytest" } }, execution: {} }) } },
      storyId: "US-003",
      packageView: { packageDir: "packages/agent", config, select: (s: any) => s.select(config) },
    } as any;
    const gateCtx = await _fullSuiteGateDeps.resolveGateContext(
      { workdir: "/w", story: { id: "US-003", workdir: "packages/agent" } } as any,
      ctx,
    );
    expect(gateCtx.testCmd).toBe("pytest packages/agent/tests");
  });
});
```

> Confirm `_fullSuiteGateDeps` and `fullSuiteGateOp` are exported from `@/operations`; if `_fullSuiteGateDeps` is module-private, export it for testing (it is already injected as `deps`, so it is likely exported).

- [ ] **Step 2: Run to verify failure**

Run: `timeout 30 bun test test/unit/operations/quality-gate-packageview.test.ts -t "fullSuiteGate" --timeout=5000`
Expected: FAIL — `resolveGateContext` reads `ctx.runtime.configLoader.current()` (root → `pytest`).

- [ ] **Step 3: Switch both reads to packageView**

In `resolveGateContext` (`full-suite-gate.ts:111`), replace:

```typescript
    const config = ctx.runtime.configLoader.current();
```

with:

```typescript
    const config = ctx.packageView.config; // package-merged config (2b), not root
```

At line 198, replace:

```typescript
    const ctxConfig = (ctx as unknown as { config?: NaxConfig }).config;
```

with:

```typescript
    const ctxConfig = ctx.packageView.config;
```

(The downstream `ctxConfig?.execution?.regressionGate?.enabled ?? true` etc. stay; they now read real config.)

- [ ] **Step 4: Run to verify pass**

Run: `timeout 30 bun test test/unit/operations/quality-gate-packageview.test.ts -t "fullSuiteGate" --timeout=5000`
Expected: PASS. The existing `TEST_COMMAND_MISSING` throw for a genuinely-absent test command is preserved (hard error — correct).

- [ ] **Step 5: Commit**

```bash
git add src/operations/full-suite-gate.ts test/unit/operations/quality-gate-packageview.test.ts
git commit -m "fix(quality): full-suite-gate uses package-merged config for command + flags (2a/2b)"
```

---

# Phase C — Defense-in-depth + end-to-end verification

## Task C1: `runQualityCommand` rejects empty/whitespace commands

Belt-and-suspenders: even if a caller regresses, an empty command must never spawn `/bin/sh -c ""` and report exit 0.

**Files:**
- Modify: `src/quality/runner.ts:83-89`
- Test: `test/unit/quality/runner-empty-command.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `test/unit/quality/runner-empty-command.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { runQualityCommand } from "@/quality";

describe("runQualityCommand empty-command guard", () => {
  test("returns failure (does not spawn) for an empty command", async () => {
    const result = await runQualityCommand({ commandName: "lint", command: "", workdir: "/tmp", storyId: "US-001" });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(-1);
    expect(result.output).toContain("empty command");
  });

  test("returns failure for a whitespace-only command", async () => {
    const result = await runQualityCommand({ commandName: "lint", command: "   ", workdir: "/tmp", storyId: "US-001" });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `timeout 30 bun test test/unit/quality/runner-empty-command.test.ts --timeout=5000`
Expected: FAIL — empty command currently exits 0 → `success: true`.

- [ ] **Step 3: Add the guard**

In `src/quality/runner.ts`, at the top of `runQualityCommand` (after destructuring `opts` at line 84, before the `logger?.info("quality", ...)` call):

```typescript
  if (!command || command.trim() === "") {
    return {
      commandName,
      command,
      success: false,
      exitCode: -1,
      output: `[nax] ${commandName} skipped: empty command`,
      durationMs: 0,
      timedOut: false,
    };
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `timeout 30 bun test test/unit/quality/runner-empty-command.test.ts --timeout=5000`
Expected: PASS.

> Note: callers (B1-B5) now skip *before* calling `runQualityCommand` for absent commands, so this guard is a backstop and returns `success:false` (not a silent pass) if ever hit. The gate ops treat a non-zero exit as a finding, so a regressed empty command surfaces loudly instead of false-greening.

- [ ] **Step 5: Commit**

```bash
git add src/quality/runner.ts test/unit/quality/runner-empty-command.test.ts
git commit -m "fix(quality): runQualityCommand rejects empty/whitespace commands (defense-in-depth)"
```

---

## Task C2: Full verification gate

- [ ] **Step 1: Lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 2: Targeted suites**

Run: `timeout 90 bun test test/unit/operations/ test/unit/quality/ test/unit/runtime/ test/unit/config/ --timeout=15000`
Expected: PASS. Audit any remaining test that injected a phantom `config` on a deterministic-op ctx — convert it to the `ctxWithQuality` packageView shape.

- [ ] **Step 3: Grep for residual phantom reads**

Run: `grep -rn "as unknown as { config" src/operations/`
Expected: **no matches** (all six migrated). `auto-approve.ts` / `setup-generate.ts` use a different `.config` access and are out of scope.

- [ ] **Step 4: Full suite**

Run: `bun run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(quality): fixups for packageView config migration"
```

---

## Self-Review Checklist (completed by author)

- **Spec coverage:** 2a phantom reads migrated for all six ops (B1 lint, B2 typecheck, B3 verify-scoped, B4 lint/format fixers, B5 full-suite-gate); 2b registry merge (A1 loader helper, A2 hydrate, A3 run-setup wiring, B5 resolveGateContext via packageView); skip-with-warning (B1-B3); test-command-missing stays hard error (B5, preserved); defense-in-depth (C1); residual-read grep gate (C2 Step 3).
- **Placeholder scan:** none — all code shown. Soft confirmations flagged inline: logger accessor name (`getSafeLogger`), `mergePackageConfig` barrel export, typecheck op deps key, `_fullSuiteGateDeps` export visibility — each with a concrete check instruction.
- **Type consistency:** `ctx.packageView.select(qualityConfigSelector)` returns `{ quality, execution }` (selector at `src/config/selectors.ts`), matching every `.quality?.commands?.*` access. `PackageOverrideLoader` signature matches `loadPackageOverride(repoRoot, packageDir)`. `hydrate(packageDirs, loadOverride?)` is the only new interface method and is implemented in `createPackageRegistry`.
- **Sequencing:** Phase A (2b) lands before Phase B (2a) so migrated ops immediately read package-merged config — avoids an interim state where gates run whole-repo root commands.
