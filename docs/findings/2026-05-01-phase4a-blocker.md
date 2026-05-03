# Phase 4a Blocker — Debate Runner Config Narrowing

**Date:** 2026-05-01
**Phase:** 4a (Debate runners)
**Branch:** `refactor/745-config-selector-phase4`

---

## Blocker Summary

The debate runners cannot be narrowed to `Pick<NaxConfig, "debate" | "models">` due to a deep call chain involving `resolveOutcome` in `session-helpers.ts`.

---

## Call Chain Analysis

```
DebateRunner._config (config: NaxConfig)
  └── resolveOutcome(..., config: NaxConfig | undefined, ...)
        └── synthesisResolver(completeOptions: { config: NaxConfig })
        └── judgeResolver(completeOptions: { config: NaxConfig })
              └── CompleteOptions.config → public interface (Phase 3: NaxConfig)
```

`resolveOutcome` accepts `config: NaxConfig | undefined` (line 189) and passes it to `completeOptions.config` at lines 326 and 374, which flows into `synthesisResolver` and `judgeResolver`.

`completeOptions.config` resolves to `CompleteOptions.config: NaxConfig` — the public interface from Phase 3 which was intentionally kept as `NaxConfig` (per plan §3.3 Note: "caller-owned, reads models, agent.acp.promptRetries, execution.permissionProfile").

---

## Files Affected

| File | config usage | Read pattern |
|:-----|:------------|:-------------|
| `runner.ts:43` | `private readonly config: NaxConfig` | Passed to `resolveOutcome` at line 248, `toStatefulCtx()` at line 280 |
| `runner-stateful.ts:33` | `StatefulCtx.config: NaxConfig` | Passed to `resolveModelDefForDebater` at line 109 |
| `runner-hybrid.ts:39` | `HybridCtx.config: NaxConfig` | Passed to `resolveModelDefForDebater` at lines 80, 189; read at line 177 |
| `runner-plan.ts:33` | `PlanCtx.config: NaxConfig` | Passed to `resolveModelDefForDebater` at line 91; read at line 79 |
| `session-helpers.ts:156` | `resolveModelDefForDebater(config: NaxConfig)` | Reads `config.models` (line 157) |

---

## What Narrowing Would Require

To narrow the debate runner `config` to `Pick<NaxConfig, "debate" | "models">`:

1. Change `resolveOutcome` signature: `config: NaxConfig | undefined` → `config: Pick<NaxConfig, "debate" | "models">`
2. Change `resolveOutcome` callers in `runner.ts`, `runner-stateful.ts`, `runner-hybrid.ts`, `runner-plan.ts` to pass narrowed config
3. Either:
   - (a) Narrow `CompleteOptions.config` in `types.ts` (breaks Phase 3 contract that said this stays as `NaxConfig`)
   - (b) Cast at `resolveOutcome` boundary — `completeOptions.config: config as NaxConfig` (same pattern as Phase 3)

---

## Unblock Options

### Option A — Cast at resolveOutcome boundary (recommended)
Narrow debate runner internal `config` to `Pick<NaxConfig, "debate" | "models">`. At the `resolveOutcome` call site, cast `config as NaxConfig` to satisfy the `NaxConfig | undefined` parameter. This is the same pattern used in Phase 3 (`this._config as NaxConfig`).

**Pros:** Minimal change, preserves `resolveOutcome` interface for other callers
**Cons:** Explicit casts in multiple call sites

### Option B — Narrow resolveOutcome + CompleteOptions.config
Change `resolveOutcome` to accept `Pick<NaxConfig, "debate" | "models">`. Change `CompleteOptions.config` to `Pick<NaxConfig, "debate" | "models">`. This ripples into `synthesisResolver`, `judgeResolver`, and their internal `completeOptions.config` usage.

**Pros:** Consistent type narrowing throughout
**Cons:** Large blast radius; changes public interface types in `types.ts`

### Option C — Skip debate runners; defer to Phase 6
Treat debate runners like `src/execution/` — document as legitimate exception per plan § Out of Scope ("Runner, lifecycle, parallel execution (orchestration layer)").

**Pros:** No changes needed; phase 4 ships without debate
**Cons:** Incomplete phase 4; debate runners remain with broad config dependency

---

## Recommended Path

**Option A** — Cast at boundary. Proceed as follows:

1. Narrow debate runner class/interface `config` fields to `Pick<NaxConfig, "debate" | "models">`
2. At each `resolveOutcome` call site, cast: `this.config as NaxConfig`
3. `resolveModelDefForDebater` signature stays `config: NaxConfig` for now — cast at callers

This follows the same pattern as Phase 3's `/** @design */` documented casts at `resolvePermissions` call sites.

---

## Plan Conformance Check

Per the plan § Phase 4.1 Note:
> "this.config in runners is only passed downstream to `resolveOutcome()` → `resolveModelDefForDebater()` (reads `models`). The runner itself doesn't access `this.config.*` directly (uses `this.stageConfig` instead)."

This is accurate — the runner itself reads `this.config?.debate` only at line 128 (`maxConcurrentDebaters`). The remaining accesses are all `this.config` being passed as an argument. The narrow path is viable with Option A.

---

## Next Step

Await decision on which option to pursue before implementing Phase 4a changes.