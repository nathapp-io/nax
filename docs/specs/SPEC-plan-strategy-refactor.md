# SPEC: Plan Mode Strategy Refactor

**Branch:** `feat/plan-strategy-refactor`  
**Scope:** `src/cli/plan.ts`, `src/plan/strategies/`, `src/plan/index.ts`

---

## Summary

Refactor the three plan modes (single, pipeline, debate) out of the monolithic `src/cli/plan.ts` into a Strategy pattern under `src/plan/strategies/`. The primary driver is a near-identical setup block duplicated at lines 112–157 and 376–411 of `plan.ts` — spec reading, source-root scanning, package-detail building, and output-path setup are copied verbatim for single/debate and again for pipeline. A unified `PlanModeContext` built once in `planCommand()` eliminates the duplication. Each mode becomes a focused `IPlanStrategy` implementation, and `planCommand()` is reduced to ~30 lines of context-build → dispatch → teardown. This refactor is a prerequisite for adding the `refine` mode (Phase 2).

---

## Motivation

`src/cli/plan.ts` is currently ~530 lines with three inlined dispatch paths. Adding a fourth mode (`refine`) without refactoring copies the setup block a third time and deepens the branching logic. The current structure makes it hard to:

- Test each mode in isolation (shared mutable state, no seam)
- Reason about what each mode does (logic mixed with setup)
- Add modes without touching unrelated paths

The strategy pattern makes modes additive. New modes are new files, not new branches in `planCommand()`.

---

## Design

### Strategy Interface

```typescript
// src/plan/strategies/types.ts

export interface IPlanStrategy {
  readonly mode: "single" | "pipeline" | "debate";
  execute(ctx: PlanModeContext): Promise<string>; // returns outputPath
}

export interface PlanModeContext {
  // paths
  workdir: string;
  naxDir: string;
  outputDir: string;
  outputPath: string;

  // content
  specContent: string;
  codebaseContext: string;
  normalizedRoots: SourceRoot[];
  relativePackages: string[];
  packageDetails: PackageSummary[];

  // metadata
  projectName: string;
  branchName: string;
  timeoutSeconds: number;

  // config slice — plan + debate keys only, via planConfigSelector
  // import type { PlanConfig } from "@/config/selectors"
  config: PlanConfig;
  // full NaxConfig — strategies that call subsystems requiring it (e.g. DebateRunner,
  // callOp interactionBridge opts) read this; plan/debate config reads go through ctx.config
  fullConfig: NaxConfig;
  options: PlanCommandOptions; // { feature, from, branch? }

  // runtime — built once in buildPlanModeContext, shared across strategy
  // strategies use ctx.runtime directly; never call createPlanRuntime themselves
  runtime: NaxRuntime;

  // runtime (interaction chain always built; pipeline ignores it)
  interactionChain: InteractionChain | null;
  interactionBridge: InteractionBridge;

  // DI — strategies do not import the _planDeps singleton directly
  deps: PlanDeps;
}

/**
 * Subset of _planDeps methods required by context-builder and strategies.
 * Declare as a structural interface so tests can supply a minimal fake.
 */
export interface PlanDeps {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  mkdirp: (path: string) => Promise<void>;
  existsSync: (path: string) => boolean;
  readPackageJson: (workdir: string) => Promise<Record<string, unknown> | null>;
  readPackageJsonAt: (path: string) => Promise<Record<string, unknown> | null>;
  scanSourceRoots: (workdir: string) => Promise<SourceRoot[]>;
  spawnSync: (cmd: string[], opts?: { cwd?: string }) => { stdout: Buffer; exitCode: number | null };
  initInteractionChain: (cfg: NaxConfig, headless: boolean) => Promise<InteractionChain | null>;
  createInteractionBridge: () => InteractionBridge;
  createDebateRunner: (opts: DebateRunnerOptions) => DebateRunner;
}
```

### Factory

```typescript
// src/plan/strategies/index.ts

export function createPlanStrategy(
  mode: "single" | "pipeline" | "debate"
): IPlanStrategy {
  switch (mode) {
    case "single":   return new SinglePlanStrategy();
    case "pipeline": return new PipelinePlanStrategy();
    case "debate":   return new DebatePlanStrategy();
    default:
      throw new NaxError(`Unknown plan mode: ${mode}`, "PLAN_MODE_UNKNOWN", {
        stage: "plan", mode,
      });
  }
}
```

### Reduced `planCommand()`

```typescript
export async function planCommand(
  workdir: string,
  config: NaxConfig,
  options: PlanCommandOptions,
): Promise<string> {
  const ctx = await buildPlanModeContext(workdir, config, options, _planDeps);
  try {
    const mode = resolvePlanMode(config);
    const strategy = createPlanStrategy(mode);
    return await strategy.execute(ctx);
  } finally {
    if (ctx.interactionChain) await ctx.interactionChain.destroy().catch(() => {});
  }
}
```

### New directory layout

```
src/plan/
  strategies/
    types.ts              — IPlanStrategy, PlanModeContext, PlanDeps
    context-builder.ts    — buildPlanModeContext()
    write-prd.ts          — writeOrRecoverPrd() shared helper
    assert.ts             — assertIsValidPrd() (moved from src/cli/plan.ts)
    single.ts             — SinglePlanStrategy
    pipeline.ts           — PipelinePlanStrategy
    debate.ts             — DebatePlanStrategy
    debate-composition.ts — buildPlanComposition() (moved from src/cli/plan.ts)
    index.ts              — barrel + createPlanStrategy factory
  critic.ts               — unchanged
  spec-deltas.ts          — unchanged
  index.ts                — re-exports strategies barrel
```

### Integration points

- `buildPlanModeContext()` replaces both duplicated setup blocks (lines 112–157 and 376–411)
- `buildPlanModeContext()` receives the full `NaxConfig`, stores it unchanged as `ctx.fullConfig`, applies `planConfigSelector.select(config)` to produce `ctx.config: PlanConfig`, and calls `createPlanRuntime(fullConfig, workdir, feature)` to produce `ctx.runtime: NaxRuntime`. Strategies read `ctx.config` for plan/debate keys; they access `ctx.fullConfig` when a subsystem (e.g. `DebateRunner`, `callOp` interaction options) requires keys outside the `PlanConfig` slice (`project`, `agent`, etc.).
- Strategies use `ctx.runtime` directly for `callOp` — they never call `createPlanRuntime` themselves
- `SinglePlanStrategy.execute()` absorbs lines 300–346 of current `planCommand()`
- `PipelinePlanStrategy.execute()` absorbs `runPlanPipeline()` (lines 360–482)
- `DebatePlanStrategy.execute()` absorbs lines 188–298 of current `planCommand()`
- `buildPlanComposition()` moves to `debate-composition.ts`; re-exported from `src/cli/plan.ts` for back-compat
- `assertIsValidPrd()` moves to `assert.ts`; re-exported from `src/cli/plan.ts` for back-compat

### projectName consistency

Pipeline mode currently uses `pkg?.name && typeof pkg.name === "string" ? pkg.name : options.feature` while single/debate use `detectProjectName()` (which includes the same type-safe check plus a git-remote fallback). This spec standardises all modes on `detectProjectName()` via `ctx.projectName`. Behavioural change is intentional — pipeline gets the richer git-remote fallback.

### interactionChain in pipeline

`buildPlanModeContext()` always initialises `interactionChain` (Option A). Pipeline strategy reads `ctx.config` and `ctx.deps` only; it never reads `ctx.interactionChain`. The `planCommand()` finally block disposes the chain unconditionally — `destroy()` on a headless/no-op chain is safe.

### Failure handling

- `SinglePlanStrategy` — disk-recovery catch path preserved verbatim from current lines 331–343
- `PipelinePlanStrategy` — throws `NaxError("PLAN_CRITIC_BLOCKED")` when critic returns blockers; caller handles
- `DebatePlanStrategy` — fallback to single-agent path when debate fails; uses shared `writeOrRecoverPrd()` helper
- All strategies use `NaxError` with `stage: "plan"` and mode-specific codes

---

## Stories

### US-001: Strategy contract and context builder

Create `types.ts` (interfaces), `context-builder.ts` (`buildPlanModeContext`), `write-prd.ts` (`writeOrRecoverPrd`), and `assert.ts` (`assertIsValidPrd`). These are the shared foundations all strategies depend on. `planCommand()` is NOT changed yet.

**Prerequisite — export `detectProjectName`:** Before `context-builder.ts` can be written, `detectProjectName` must be moved from `src/cli/plan.ts` (currently private, line 510) to `src/cli/plan-runtime.ts` and exported. `context-builder.ts` lives under `src/plan/strategies/`; importing `detectProjectName` from `src/cli/plan.ts` would create a circular dependency once `plan.ts` starts importing from `src/plan/strategies/`. Moving it to `plan-runtime.ts` — which neither `plan.ts` nor the strategies directory imports circularly — breaks the cycle. Update `plan.ts` to import `detectProjectName` from `./plan-runtime` instead.

**No other dependencies.**

#### Context Files
- `src/cli/plan.ts` — lines 112–157 (single/debate setup) and 376–411 (pipeline setup) to consolidate
- `src/cli/plan-helpers.ts` — `buildPackageSummary`, `buildSourceRootsSection`
- `src/cli/plan-runtime.ts` — `_planDeps` singleton, `detectProjectName` (must be moved here and exported before US-001 begins — see prerequisite note above)
- `test/unit/cli/plan-monorepo.test.ts` — existing tests verifying `relativePackages` derivation (must keep passing)

### US-002: `SinglePlanStrategy`

Create `single.ts` containing `SinglePlanStrategy`. Move the single-mode dispatch from `planCommand()` lines 300–346 into `execute(ctx)`. `planCommand()` is NOT changed yet — the strategy exists but is not wired in.

**Depends on US-001.**

#### Context Files
- `src/cli/plan.ts` — lines 300–346 (single-mode path to move)
- `src/operations/plan.ts` — `planInteractiveOp`
- `src/plan/strategies/write-prd.ts` — `writeOrRecoverPrd` (from US-001)
- `test/unit/cli/plan.test.ts` — existing single-mode tests (pattern to mirror in new test)
- `test/unit/cli/plan-callop.test.ts` — callOp invocation tests

### US-003: `PipelinePlanStrategy`

Create `pipeline.ts` containing `PipelinePlanStrategy`. Move `runPlanPipeline()` (lines 360–482) into `execute(ctx)`. `planCommand()` is NOT changed yet.

**Depends on US-001.**

#### Context Files
- `src/cli/plan.ts` — `runPlanPipeline()` lines 360–482 and setup block 376–411 (replaced by `ctx`)
- `src/plan/critic.ts` — `runPlanCritic()` called by the strategy
- `src/operations/plan-draft.ts` — `planDraftOp`
- `src/operations/ground.ts` — `groundOp`
- `test/unit/cli/plan-callop.test.ts` — `callOp` invocation patterns to mirror for pipeline tests (no dedicated pipeline test file exists yet)

### US-004: `DebatePlanStrategy`

Create `debate.ts` containing `DebatePlanStrategy` and `debate-composition.ts` containing `buildPlanComposition()` (moved from `src/cli/plan.ts`). Move debate dispatch (lines 188–298) into `execute(ctx)`. `planCommand()` is NOT changed yet.

**Depends on US-001.**

#### Context Files
- `src/cli/plan.ts` — lines 188–298 (debate dispatch), `buildPlanComposition()` definition
- `src/debate/runner.ts` — `DebateRunner` class
- `src/debate/runner-plan.ts` — `runPlan()` method
- `src/plan/strategies/write-prd.ts` — `writeOrRecoverPrd` (from US-001)
- `test/unit/cli/plan-debate.test.ts` — existing debate-path tests

### US-005: Factory, barrel, and `planCommand()` cut-over

Create `index.ts` with `createPlanStrategy` factory. Reduce `planCommand()` to ~30 lines: build context → dispatch → teardown. Delete `runPlanPipeline` from `src/cli/plan.ts`. Re-export `buildPlanComposition` and `assertIsValidPrd` from `src/cli/plan.ts` for back-compat. Add `src/plan/index.ts` barrel re-exporting the strategies barrel.

**Depends on US-002, US-003, US-004.**

#### Context Files
- `src/cli/plan.ts` — full file; this story deletes the old dispatch paths
- `src/plan/strategies/single.ts` — `SinglePlanStrategy` (US-002)
- `src/plan/strategies/pipeline.ts` — `PipelinePlanStrategy` (US-003)
- `src/plan/strategies/debate.ts` — `DebatePlanStrategy` (US-004)
- `test/unit/cli/plan-mode.test.ts` — `resolvePlanMode` tests
- `test/unit/cli/plan-debate.test.ts` — must still pass after cut-over
- `test/unit/cli/plan.test.ts` — must still pass after cut-over

---

## Acceptance Criteria

### US-001: Strategy contract and context builder

**AC1:** `buildPlanModeContext(workdir, config, options, deps)` returns a `PlanModeContext` where `specContent` equals the file content read from `options.from`.

**AC2:** `buildPlanModeContext` returns `relativePackages` containing only non-root paths (filtered `p !== "."`) relative to `workdir` (no leading `/`).

**AC3:** `buildPlanModeContext` returns `packageDetails` with one `PackageSummary` entry per entry in `relativePackages`, built via `buildPackageSummary`.

**AC4:** `buildPlanModeContext` returns `projectName` equal to `detectProjectName(workdir, pkg)` — same derivation for all modes (pipeline included).

**AC5:** `buildPlanModeContext` returns `outputPath` equal to `join(naxDir, "features", options.feature, "prd.json")`.

**AC6:** `buildPlanModeContext` calls `deps.mkdirp(outputDir)` before returning.

**AC7:** `buildPlanModeContext` returns `null` for `interactionChain` when `config` is null. When `config` is provided it returns the result of `deps.initInteractionChain(config, !process.stdin.isTTY)`, which may itself be `null` if no interaction plugins are configured — the AC does not guarantee a non-null chain when TTY + config are present.

**AC8:** `buildPlanModeContext` returns `config` equal to `planConfigSelector.select(fullConfig)` — a `PlanConfig` slice, not the full `NaxConfig`.

**AC8b:** `buildPlanModeContext` returns `fullConfig` equal to the `NaxConfig` argument passed in, un-sliced.

**AC9:** `buildPlanModeContext` returns `runtime` built via `createPlanRuntime(fullConfig, workdir, feature)` — strategies never call `createPlanRuntime` themselves.

**AC10:** `IPlanStrategy` and `PlanModeContext` are both exported from `src/plan/strategies/index.ts`.

**AC11:** `writeOrRecoverPrd(ctx, prd)` writes `JSON.stringify(prd, null, 2)` to `ctx.outputPath` via `ctx.deps.writeFile` and returns `ctx.outputPath`.

**AC12:** `writeOrRecoverPrd(ctx, null, err)` reads `ctx.outputPath` from disk and returns the path when the file exists; re-throws `err` when the file does not exist.

### US-002: `SinglePlanStrategy`

**AC1:** `SinglePlanStrategy.execute(ctx)` calls `callOp` with `planInteractiveOp` and input fields derived from `ctx`.

**AC2:** `SinglePlanStrategy.execute(ctx)` returns `ctx.outputPath` on success.

**AC3:** When `callOp` throws (including after `planInteractiveOp`'s `op.recover` returned `null`) and `ctx.outputPath` still exists on disk, `SinglePlanStrategy.execute` returns that path without re-throwing. Note: `op.recover` runs first and handles the common case (valid JSON on disk); this outer catch covers the narrow case where the file exists but its content fails `validatePlanOutput`.

**AC4:** `SinglePlanStrategy.mode` equals `"single"`.

**AC5:** `SinglePlanStrategy` calls `rt.close()` in a finally block regardless of success or failure.

### US-003: `PipelinePlanStrategy`

**AC1:** `PipelinePlanStrategy.execute(ctx)` calls `callOp` with `groundOp`, then `planDraftOp`, then `runPlanCritic` — in that order.

**AC2:** `PipelinePlanStrategy.execute(ctx)` throws `NaxError` with code `"PLAN_CRITIC_BLOCKED"` when `runPlanCritic` returns a verdict with blockers.

**AC3:** `PipelinePlanStrategy.execute(ctx)` passes `ctx.fullConfig?.project` as `projectProfile` to the draft op input.

**AC4:** `PipelinePlanStrategy.execute(ctx)` passes `ctx.relativePackages` and `ctx.packageDetails` to the draft op input.

**AC5:** `PipelinePlanStrategy.mode` equals `"pipeline"`.

**AC6:** `PipelinePlanStrategy` calls `rt.close()` in a finally block regardless of success or failure.

### US-004: `DebatePlanStrategy`

**AC1:** `DebatePlanStrategy.execute(ctx)` calls `ctx.deps.createDebateRunner` and calls `runner.runPlan(taskContext, outputFormat, opts)` where:
- `taskContext` and `outputFormat` are obtained from `new PlanPromptBuilder().build(ctx.specContent, ctx.codebaseContext, undefined, ctx.relativePackages, ctx.packageDetails, ctx.fullConfig?.project)`
- `opts` maps as: `workdir: ctx.workdir`, `feature: ctx.options.feature`, `outputDir: ctx.outputDir`, `timeoutSeconds: ctx.timeoutSeconds`, `specContent: ctx.specContent`, and optionally `maxInteractionTurns: ctx.fullConfig?.agent?.maxInteractionTurns`
- `createDebateRunner` receives: `ctx: callCtx` (built from `ctx.runtime`), `stage: "plan"`, `stageConfig: buildPlanComposition(ctx.config.debate.stages.plan)`, `config: ctx.fullConfig`, `workdir: ctx.workdir`, `featureName: ctx.options.feature`, `timeoutSeconds: ctx.timeoutSeconds`, `sessionManager: ctx.runtime.sessionManager`

**AC2:** When `runner.runPlan()` returns `outcome: "failed"`, `DebatePlanStrategy.execute` falls back to `callOp(planInteractiveOp, ...)` using `writeOrRecoverPrd`.

**AC3:** `DebatePlanStrategy.mode` equals `"debate"`.

**AC4:** `buildPlanComposition` is exported from `src/plan/strategies/debate-composition.ts`.

**AC5:** `DebatePlanStrategy` calls `rt.close()` in a finally block regardless of success or failure.

### US-005: Factory, barrel, and `planCommand()` cut-over

**AC1:** `createPlanStrategy("single")` returns an instance of `SinglePlanStrategy`.

**AC2:** `createPlanStrategy("pipeline")` returns an instance of `PipelinePlanStrategy`.

**AC3:** `createPlanStrategy("debate")` returns an instance of `DebatePlanStrategy`.

**AC4:** `createPlanStrategy` throws `NaxError` with code `"PLAN_MODE_UNKNOWN"` for an unrecognised mode string.

**AC5:** `planCommand()` body contains no inline mode dispatch — it calls only `buildPlanModeContext`, `resolvePlanMode`, `createPlanStrategy`, `strategy.execute`, and `interactionChain.destroy` in the finally block.

**AC6:** `src/cli/plan.ts` is under 150 lines after the cut-over.

**AC7:** `buildPlanComposition` remains importable from `src/cli/plan.ts` (re-exported via `debate-composition.ts`).

**AC8:** `runPlanPipeline` is no longer defined in `src/cli/plan.ts`; any existing import of it resolves through `PipelinePlanStrategy` or a back-compat shim.

**AC9:** All existing tests in `test/unit/cli/plan.test.ts`, `test/unit/cli/plan-callop.test.ts`, `test/unit/cli/plan-debate.test.ts`, and `test/unit/cli/plan-mode.test.ts` pass without modification.

---

## New Tests Required

### `test/unit/plan/strategies/context-builder.test.ts`

- Happy path: given fake deps returning fixture spec + source roots, `buildPlanModeContext` returns expected `relativePackages` and `packageDetails`
- `outputPath` equals `join(naxDir, "features", feature, "prd.json")`
- `mkdirp` is called with `outputDir`
- `projectName` uses `detectProjectName` result (not raw `pkg.name`)
- `specContent` equals the content returned by `deps.readFile`
- `writeOrRecoverPrd(ctx, prd)` writes serialised PRD and returns `ctx.outputPath`
- `writeOrRecoverPrd(ctx, null, err)` returns `ctx.outputPath` when file exists on disk; re-throws when absent

### `test/unit/plan/strategies/single.test.ts`

- `execute` calls `callOp` with `planInteractiveOp` and returns `ctx.outputPath`
- Disk-recovery: when `callOp` throws and file exists, returns the recovered path without re-throwing
- `rt.close()` always called (spy)

### `test/unit/plan/strategies/pipeline.test.ts`

- `execute` calls ground → draft → critic in that order (spy on each)
- Throws `PLAN_CRITIC_BLOCKED` when critic returns blockers
- Passes `relativePackages` and `packageDetails` to draft op input
- `rt.close()` always called (spy)

### `test/unit/plan/strategies/debate.test.ts`

- `execute` calls `createDebateRunner` with `stage: "plan"` and calls `runner.runPlan`
- Falls back to `callOp(planInteractiveOp)` when debate outcome is `"failed"`
- `rt.close()` always called (spy)

### `test/unit/plan/strategies/factory.test.ts`

- `createPlanStrategy("single" | "pipeline" | "debate")` returns the correct class instance
- `createPlanStrategy("unknown")` throws `NaxError` with code `"PLAN_MODE_UNKNOWN"`
