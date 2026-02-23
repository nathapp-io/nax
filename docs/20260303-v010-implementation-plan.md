# v0.10 Implementation Plan

**Date:** 2026-03-03  
**Branch:** `feat/v0.10-plugins`  
**Base:** v0.9.3 (master, `d4562b2`)  

## Test Strategy
- Mode: hybrid
- TDD targets: plugin types, plugin loader/validator, merger utility, optimizer interface
- Test-after targets: pipeline integration, CLI commands, config schema updates

## Phase 1: Plugin System Foundation (Types + Loader + Registry)

### 1a: Plugin types and extension interfaces
**Files:**
- `src/plugins/types.ts` — `NaxPlugin`, `PluginType`, `PluginExtensions`, `IPromptOptimizer`, `IReviewPlugin`, `IContextProvider`, `IReporter` + event types
- `src/plugins/index.ts` — public exports

**Change:** Define all interfaces. `RoutingStrategy` and `AgentAdapter` already exist — reference them, don't duplicate.

### 1b: Plugin validator
**File:** `src/plugins/validator.ts`
**Change:** `validatePlugin(module: unknown): NaxPlugin | null` — runtime type checks (name string, version string, provides array, matching extensions). Returns null + logs warning on invalid.

### 1c: Plugin loader
**File:** `src/plugins/loader.ts`
**Change:** `loadPlugins(globalDir, projectDir, configPlugins)` — scan directories, import modules, validate, call setup(), return registry. Directory auto-discovery + explicit config modules.

### 1d: Plugin registry
**File:** `src/plugins/registry.ts`
**Change:** `PluginRegistry` class with typed getters (`getOptimizers()`, `getRouters()`, etc.) and `teardownAll()`.

### Tests:
- `test/plugins/validator.test.ts` — valid/invalid plugin shapes
- `test/plugins/loader.test.ts` — directory scan, module loading, validation
- `test/plugins/registry.test.ts` — registration, getters, teardown

**Commit:** `feat(plugins): add plugin system foundation (types, loader, registry)`

## Phase 2: Config Layering (Global + Project + Deep Merge)

### 2a: Config paths resolver
**File:** `src/config/paths.ts`
**Change:** `globalConfigDir()` → `~/.nax/`, `projectConfigDir(dir?)` → `<cwd>/nax/`. Handle XDG_CONFIG_HOME if set.

### 2b: Deep merge utility
**File:** `src/config/merger.ts`
**Change:** `mergeConfigs(base, override)` — recursive object merge, arrays replace, `null` removes keys. Special handling: hooks and constitution concatenate via `skipGlobal` check.

### 2c: Update loadConfig()
**File:** `src/config/loader.ts` (modify existing)
**Change:** Load global → project → merge → apply CLI flags. Update existing `loadConfig()` signature.

### 2d: Zod schema updates
**File:** `src/config/schema.ts` (modify existing)
**Change:** Add `HooksConfig` (`skipGlobal`, `dir`), `ConstitutionConfig` (`path`, `skipGlobal`), `OptimizerConfig` (`enabled`, `strategy`, `strategies`), `PluginConfigEntry` (`module`, `config`), `plugins` array to root schema.

### 2e: `nax init --global`
**File:** `src/commands/init.ts` (modify existing)
**Change:** Add `--global` flag. Creates `~/.nax/config.json` (with commented examples), `~/.nax/constitution.md`, `~/.nax/hooks/`.

### 2f: Hook concatenation
**File:** `src/hooks/loader.ts` (modify existing)
**Change:** Load hooks from global dir first, then project dir. Both fire independently. Respect `skipGlobal`.

### 2g: Constitution concatenation
**File:** `src/constitution/loader.ts` (modify existing)
**Change:** Prepend global constitution to project constitution with `---` separator. Respect `skipGlobal`.

### Tests:
- `test/config/merger.test.ts` — deep merge, null removal, array replace
- `test/config/paths.test.ts` — path resolution
- `test/config/loader.test.ts` — global+project merge integration
- Update existing hook/constitution tests for concatenation

**Commit:** `feat(config): add global config layering with deep merge`

## Phase 3: Prompt Optimizer

### 3a: Optimizer types + NoopOptimizer
**Files:**
- `src/optimizer/types.ts` — `IPromptOptimizer`, `PromptOptimizerInput`, `PromptOptimizerResult`
- `src/optimizer/noop.optimizer.ts` — passthrough, zero savings
- `src/optimizer/index.ts` — exports + `resolveOptimizer()` factory

### 3b: RuleBasedOptimizer
**File:** `src/optimizer/rule-based.optimizer.ts`
**Rules:** `stripWhitespace`, `compactCriteria`, `deduplicateContext`, `maxPromptTokens`

### 3c: Optimizer pipeline stage
**File:** `src/pipeline/stages/optimizer.ts`
**Change:** New stage between prompt and execution. Uses `resolveOptimizer()` which checks plugin registry first, then built-in strategy.

### 3d: Wire optimizer stage into pipeline
**File:** `src/pipeline/stages/index.ts` (modify)
**Change:** Insert `optimizerStage` after `promptStage` in `defaultPipeline`.

### Tests:
- `test/optimizer/noop.test.ts`
- `test/optimizer/rule-based.test.ts` — each rule individually + combined
- `test/optimizer/stage.test.ts` — pipeline integration

**Commit:** `feat(optimizer): add prompt optimization stage with rule-based optimizer`

## Phase 4: Pipeline Integration + CLI

### 4a: Add PluginRegistry to PipelineContext
**File:** `src/pipeline/types.ts` (modify)
**Change:** Add `plugins?: PluginRegistry` field.

### 4b: Initialize plugins in runner
**File:** `src/pipeline/runner.ts` (modify)
**Change:** Load plugins at run start, pass registry to context, teardown at run end.

### 4c: Wire plugin routers into routing chain
**File:** `src/routing/chain.ts` or `src/routing/builder.ts` (modify)
**Change:** Prepend plugin routers before built-in strategies.

### 4d: Wire plugin reviewers into review stage
**File:** `src/pipeline/stages/review.ts` (modify)
**Change:** Run plugin reviewers after built-in checks.

### 4e: Wire context providers into context stage
**File:** `src/pipeline/stages/context.ts` (modify)
**Change:** Append provider content after built context, within token budget.

### 4f: Wire reporters into runner
**File:** `src/pipeline/runner.ts` (modify)
**Change:** Emit `onRunStart`, `onStoryComplete`, `onRunEnd` to all reporters.

### 4g: `nax plugins list` CLI
**File:** `src/commands/plugins.ts` (new)
**Change:** Show loaded plugins with name, version, provides, source (global/project/config).

### Tests:
- Update existing pipeline/runner tests for plugin initialization
- `test/commands/plugins.test.ts` — CLI output

**Commit:** `feat(pipeline): integrate plugin system into pipeline + add plugins CLI`

## Phase 5: Final Verification + Version Bump

1. Run full test suite: `bun test`
2. Run typecheck: `tsc --noEmit`
3. Run lint: `eslint src/`
4. Bump version to `0.10.0` in package.json
5. Update CHANGELOG.md

**Commit:** `chore: bump version to v0.10.0`

---

## Execution Plan

| Phase | Target | Estimated Duration | Strategy |
|:------|:-------|:------------------|:---------|
| 1 | Mac01 (claude-monitor) | ~15 min | test-first for types + loader |
| 2 | Mac01 (claude-monitor) | ~15 min | test-first for merger, test-after for wiring |
| 3 | Mac01 (claude-monitor) | ~10 min | test-first for optimizers |
| 4 | Mac01 (claude-monitor) | ~15 min | test-after for pipeline wiring |
| 5 | Mac01 (claude-monitor) | ~5 min | verification only |

All phases run sequentially on Mac01 via `claude-run.sh --phases`.

**Branch strategy:** Single feature branch `feat/v0.10-plugins`, one commit per phase, squash merge to master.
