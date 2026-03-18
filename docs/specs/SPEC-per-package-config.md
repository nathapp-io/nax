# SPEC: Per-Package Config Override for Monorepo (v0.49.0)

**Status:** Draft
**Created:** 2026-03-18
**Author:** Nax Dev (with William)
**Depends on:** v0.48.0

---

## Problem

v0.47.0 shipped per-package config support (`mergePackageConfig`) but only `quality.commands` is mergeable. The following fields cannot be overridden per-package:

1. **`execution.smartTestRunner`** — Cannot disable smart-runner for packages using Playwright/visual tests where source→test mapping doesn't work
2. **`execution.regressionGate.mode`** — Cannot set `per-story` vs `deferred` per package
3. **`review.checks`** — Cannot override which checks run (e.g., skip typecheck for pure JS packages)
4. **`review.commands`** — Cannot override check commands per package
5. **`review.enabled`** — Cannot disable review entirely for a package
6. **`acceptance.enabled`** — Cannot disable acceptance tests per package
7. **`quality.requireTests`** — Cannot override test requirement per package

Additionally, even when `mergePackageConfig` is expanded, most pipeline stages don't use the merged config — they read from `ctx.config` (root) instead of the per-package resolved config.

---

## Prior Art

- **v0.47.0 (MW-008):** Per-package `nax/config.json` with `quality.commands` merge — partial implementation
- **v0.47.0 (MW-009):** Verify stage uses `effectiveConfig` — partial fix
- **v0.47.0 (MW-010):** Review stage scopes file checks to package — partial fix

This spec completes the picture: expand what's mergeable AND ensure all stages use the merged config.

---

## Goals

1. **Expand `mergePackageConfig`** to cover all fields that make sense at per-package level
2. **Centralize config resolution** — resolve effective config once per story, not per-stage
3. **Wire effective config into all stages** — review, rectify, autofix, prompt, regression, acceptance

---

## Design: Config Resolution Strategy

### Option A: Per-Stage Resolution (Current, Broken)

Each stage calls `loadConfigForWorkdir` individually:
- ✅ Simple to implement incrementally
- ❌ Duplicated code across 7+ stages
- ❌ Easy to forget — stages still use `ctx.config` instead of effective config
- ❌ Performance — N config loads for N stories

### Option B: Centralized Resolution (Recommended)

Resolve effective config **once** at the start of the per-story pipeline loop:

```typescript
// src/pipeline/runner.ts (or wherever per-story loop lives)
const effectiveConfig = ctx.story.workdir
  ? await loadConfigForWorkdir(join(ctx.workdir, "nax", "config.json"), ctx.story.workdir)
  : ctx.config;

ctx.effectiveConfig = effectiveConfig;  // NEW FIELD
```

Then update all stages to use `ctx.effectiveConfig` instead of `ctx.config`.

**Benefits:**
- Single resolution point — no duplication
- Harder to forget — all stages use `ctx.effectiveConfig`
- Performance — N config loads for N stories, not N×stages

**Changes:**
1. Add `effectiveConfig?: NaxConfig` to `PipelineContext` type
2. Resolve once in the per-story pipeline entry
3. Update all 7 stages to use `ctx.effectiveConfig`

---

## Fields to Add to Per-Package Merge

### Currently Mergeable
| Field | Status |
|:------|:-------|
| `quality.commands.*` | ✅ Already works |

### New Mergeable Fields

| Field | Type | Override? | Rationale |
|:------|:-----|:----------|:----------|
| `execution.smartTestRunner` | `SmartTestRunnerConfig \| boolean` | ✅ Yes | Packages with Playwright/visual tests need smart-runner disabled |
| `execution.regressionGate.mode` | `"deferred" \| "per-story" \| "disabled"` | ✅ Yes | Different packages may need different gate strategies |
| `execution.regressionGate.timeoutSeconds` | `number` | ✅ Yes | Larger packages need longer timeout |
| `execution.verificationTimeoutSeconds` | `number` | ✅ Yes | Different test suite durations |
| `review.enabled` | `boolean` | ✅ Yes | Some packages may not need review |
| `review.checks` | `string[]` | ✅ Yes | Skip typecheck for pure JS packages |
| `review.commands.*` | `Record<string, string>` | ✅ Yes | Custom lint commands per package |
| `review.pluginMode` | `"deferred" \| "per-story"` | ✅ Yes | Different plugin strategies |
| `acceptance.enabled` | `boolean` | ✅ Yes | Some packages have no acceptance tests |
| `acceptance.generateTests` | `boolean` | ✅ Yes | Generate or skip acceptance tests |
| `acceptance.testPath` | `string` | ✅ Yes | Custom acceptance test location |
| `quality.requireTests` | `boolean` | ✅ Yes | Some packages may have no tests |
| `quality.requireTypecheck` | `boolean` | ✅ Yes | Pure JS packages may skip typecheck |
| `quality.requireLint` | `boolean` | ✅ Yes | Packages with different lint configs |
| `context.testCoverage.enabled` | `boolean` | ✅ Yes | Disable for non-JS packages |

### Root-Only Fields (Not Mergeable)

These stay at root level:

| Field | Reason |
|:------|:-------|
| `models` | Global model definitions |
| `autoMode` | Global agent routing |
| `routing` | Global routing strategy |
| `agent` | Agent configuration |
| `generate` | Agent generation config |
| `tdd` | TDD strategy |
| `decompose` | Decompose settings |
| `plan` | Plan settings |
| `constitution` | Global constitution |
| `interaction` | Interaction config |

---

## Implementation Plan

### PKG-001: Expand `mergePackageConfig` (Medium)

Update `src/config/merge.ts` to deep-merge the new fields:

```typescript
export function mergePackageConfig(root: NaxConfig, pkg: Partial<NaxConfig>): NaxConfig {
  return {
    ...root,
    execution: {
      ...root.execution,
      ...pkg.execution,
      smartTestRunner: pkg.execution?.smartTestRunner ?? root.execution.smartTestRunner,
      regressionGate: {
        ...root.execution.regressionGate,
        ...pkg.execution?.regressionGate,
      },
      verificationTimeoutSeconds: pkg.execution?.verificationTimeoutSeconds
        ?? root.execution.verificationTimeoutSeconds,
    },
    review: {
      ...root.review,
      ...pkg.review,
      commands: {
        ...root.review.commands,
        ...pkg.review?.commands,
      },
    },
    acceptance: {
      ...root.acceptance,
      ...pkg.acceptance,
    },
    quality: {
      ...root.quality,
      requireTests: pkg.quality?.requireTests ?? root.quality.requireTests,
      requireTypecheck: pkg.quality?.requireTypecheck ?? root.quality.requireTypecheck,
      requireLint: pkg.quality?.requireLint ?? root.quality.requireLint,
      commands: {
        ...root.quality.commands,
        ...pkg.quality?.commands,
      },
    },
    context: {
      ...root.context,
      testCoverage: {
        ...root.context.testCoverage,
        ...pkg.context?.testCoverage,
      },
    },
  };
}
```

### PKG-002: Add `effectiveConfig` to PipelineContext (Simple)

Add to `src/pipeline/types.ts`:

```typescript
export interface PipelineContext {
  // ... existing fields ...
  
  /**
   * Resolved config for this story's package.
   * When story.workdir is set, this is root config merged with package config.
   * When no workdir, this === ctx.config (root).
   */
  effectiveConfig: NaxConfig;
}
```

### PKG-003: Centralize Config Resolution (Medium)

In the per-story pipeline entry (likely `src/pipeline/runner.ts` or wherever stories are executed):

```typescript
// Resolve per-package config once per story
const effectiveConfig = story.workdir
  ? await loadConfigForWorkdir(join(workdir, "nax", "config.json"), story.workdir)
  : config;

const ctx: PipelineContext = {
  // ... other fields ...
  config,           // root config (unchanged)
  effectiveConfig,  // NEW: merged per-package config
  story,
  // ...
};
```

### PKG-004: Update Stages to Use `effectiveConfig` (Medium)

Update these 7 stages to use `ctx.effectiveConfig` instead of `ctx.config`:

| Stage | Fields to Update |
|:------|:-----------------|
| `verify.ts` | Already uses `effectiveConfig` for quality — update smartRunnerConfig and regressionGate |
| `review.ts` | `review.enabled`, `review.checks`, `review.commands`, `review.pluginMode` |
| `rectify.ts` | `quality.commands.test`, `execution.verificationTimeoutSeconds` |
| `autofix.ts` | `quality.commands.lintFix`, `quality.commands.formatFix`, `quality.autofix.*` |
| `prompt.ts` | `quality.commands.test` |
| `regression.ts` | `quality.commands.test`, `execution.regressionGate.*` |
| `acceptance.ts` | `acceptance.enabled`, `acceptance.testPath` |

### PKG-005: Tests (Medium)

Add tests for:

1. **Merge tests** — verify each new field is correctly overridden
2. **Integration test** — end-to-end with package config, verify stages use effective config
3. **Fallback test** — no package config → uses root config

---

## Example Usage

### Root Config (`nax/config.json`)

```json
{
  "quality": {
    "requireTests": true,
    "requireTypecheck": true,
    "commands": {
      "test": "bunx turbo test",
      "testScoped": "bunx turbo test --filter={{package}}",
      "typecheck": "bunx turbo type-check"
    }
  },
  "execution": {
    "smartTestRunner": { "enabled": true },
    "regressionGate": { "mode": "deferred", "timeoutSeconds": 300 }
  },
  "review": {
    "checks": ["typecheck", "lint"]
  }
}
```

### Package Override (`packages/api/nax/config.json`)

```json
{
  "quality": {
    "commands": {
      "test": "jest",
      "testScoped": "jest --testPathPattern={{files}}"
    }
  }
}
```

### Package Override (`packages/web/nax/config.json`)

```json
{
  "execution": {
    "smartTestRunner": false,
    "regressionGate": { "mode": "per-story" }
  },
  "review": {
    "checks": ["lint"]
  },
  "acceptance": {
    "enabled": false
  }
}
```

### Package Override (`packages/docs/nax/config.json`)

```json
{
  "quality": {
    "requireTests": false,
    "requireTypecheck": false,
    "requireLint": false
  },
  "review": {
    "enabled": false
  }
}
```

---

## Breaking Changes

None. This is purely additive — existing single-package repos work exactly as before.

---

## Migration

1. **Single-package repos:** No changes needed — `effectiveConfig === ctx.config`
2. **Existing monorepo configs:** Existing `quality.commands` overrides continue to work
3. **New per-package fields:** Available immediately when users add them to package configs

---

## Acceptance Criteria

- [ ] `packages/*/nax/config.json` can override all mergeable fields listed above
- [ ] All 7 pipeline stages use `ctx.effectiveConfig` for package-relevant fields
- [ ] Smart-runner can be disabled per-package
- [ ] Review checks can be overridden per-package
- [ ] Regression gate mode can differ per-package
- [ ] Tests pass for merge logic and integration

---

## Open Questions

1. **Should `context.testCoverage` be merged deeply?** Yes — `scopeToStory`, `testPattern`, `detail` can all differ per package
2. **Should `quality.autofix` be mergeable?** Probably yes — some packages may want autofix disabled
3. **Performance:** Is loading config per-story acceptable? Yes — it's async and cached by filesystem
