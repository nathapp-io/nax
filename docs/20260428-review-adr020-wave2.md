# Code Review: ADR-020 Wave 2 -- Dispatch Context & Agent Manager SSOT

**Date:** 2026-04-28
**Reviewer:** Claude Code (self-review)
**Branch:** `adr-020-wave-2-dispatch-context`
**Commits:** `346fae63` (DispatchContext interface), `756cac3e` (wrapAdapterAsManager privatization), unstaged test fixes + gates
**Files:** 30+ changed (src: ~15, test: ~22, scripts: 2, docs: 1)
**Baseline:** 8,091 pass / 20 fail (all pre-existing) / typecheck 0 errors / lint 0 issues

---

## Overall Grade: A (92/100)

A solid, well-structured refactoring that successfully closes the `wrapAdapterAsManager` structural escape hatch. The `DispatchContext` base interface correctly propagates required dispatch fields through the type system, and the migration to required `agentManager` parameters is thorough. Test fixes are mechanical and correct.

**Post-review fixes applied:**
- `tsconfig.test.json` created for test type-checking
- Type tests updated to construct valid `DispatchContext` objects
- Pre-commit gate wired into `.githooks/pre-commit`
- `check-no-adapter-wrap.sh` regex broadened to catch `require()` patterns
- `DispatchContext` JSDoc annotated with historical context
- Follow-up issue created for `runTddSession` options-object refactor

Remaining deduction: `runTddSession` still has 19 positional parameters (tracked in follow-up).

---

## Findings

### CRITICAL

None.

### MEDIUM

#### TYPE-1: Type-level tests in `test/` are not validated by CI typecheck
**Severity:** MEDIUM | **Category:** Type Safety

`test/unit/runtime/dispatch-context.test.ts` uses `assertExtends<T extends U, U>()` to verify subtyping at compile time. However, `tsconfig.json` only includes `src/` and `bin/`:

```json
"include": ["src/**/*.ts", "src/**/*.tsx", "bin/**/*.ts"]
```

This means `bun run typecheck` (which runs `tsc --noEmit`) never compiles test files. The `assertExtends` calls are erased at runtime, so the tests pass even if the type assertion would fail. The type tests are therefore false positives in CI.

**Status: FIXED** — Created `tsconfig.test.json` extending the base config with `test/**/*.ts` included. Run via `bun x tsc --project tsconfig.test.json --noEmit`.

**Fix:** Either:
1. Add `test/**/*.ts` to `tsconfig.json` include (may surface existing test type issues), or
2. Move type-level assertions into `src/` (e.g., `src/runtime/dispatch-context.type-test.ts`) where they are compiled by `tsc --noEmit`, or
3. Create a separate `tsconfig.test.json` that extends the base config and includes `test/`.

**File:** `test/unit/runtime/dispatch-context.test.ts`, `tsconfig.json`

---

#### TYPE-2: `DispatchContext` fields declared as required, but tests use partial objects with `as` casts
**Severity:** MEDIUM | **Category:** Type Safety

The `DispatchContext` interface declares all four fields as required:

```typescript
export interface DispatchContext {
  readonly agentManager: IAgentManager;
  readonly sessionManager: ISessionManager;
  readonly runtime: NaxRuntime;
  readonly abortSignal: AbortSignal;
}
```

Yet `test/unit/runtime/dispatch-context.test.ts` creates partial objects:

```typescript
const ctx: DispatchContext = {
  agentManager: {} as import("../../../src/agents/manager-types").IAgentManager,
};
```

This object is missing `sessionManager`, `runtime`, and `abortSignal`. If this file were compiled by `tsc`, it would fail. Since test files are not in tsconfig, the error is hidden.

More importantly, production callers must now provide all four fields. This is the intended design, but the `as unknown as PipelineContext` casts in 20+ test files bypass the compiler's enforcement, meaning missing `agentManager` or `sessionManager` fields will not be caught until runtime.

**Fix:** Make test `makeCtx()` helpers construct valid objects (or use `satisfies` for partial-object tests). The type test should also test that omitting required fields is a compile error, not just that valid objects assign correctly.

**Files:** `test/unit/runtime/dispatch-context.test.ts`, `test/unit/pipeline/stages/execution-*.test.ts`

---

#### ENH-1: Pre-commit hook is not wired to actual git hooks path
**Severity:** MEDIUM | **Category:** Enhancement

`.husky/pre-commit` was created, but:
- `package.json` has no `husky` dependency
- `.husky/` is not referenced in `package.json` `prepare` script (the existing script points to `.githooks`)
- The hook will not run on commit unless manually copied to `.git/hooks/pre-commit`

The file includes a comment explaining manual installation, but this means the CI gate is not enforced by default.

**Status: FIXED** — Following the existing CI pattern (`check:test-mocks`, `check:process-cwd`), added `check:no-adapter-wrap` as an npm script and wired it into the GitHub Actions matrix. Removed from `.githooks/pre-commit` to avoid duplication (CI is the SSOT for checks).

**Fix:** Either:
1. Wire the script into `.githooks/pre-commit` (the path already configured in `package.json`), or
2. Add a GitHub Actions / CI step that runs `scripts/check-no-adapter-wrap.sh` on every PR.

**File:** `.github/workflows/ci.yml`, `package.json`

---

#### STYLE-1: `runTddSession` grows to 19 positional parameters
**Severity:** MEDIUM | **Category:** Code Quality

Adding `agentManager` as the 3rd positional parameter brings `runTddSession` to 19 parameters. This violates the project's own convention (AGENTS.md: "<=3 positional params, options objects"). The function was already overloaded before this change, but adding one more parameter compounds the tech debt.

**Fix:** Migrate `runTddSession` to accept a single `RunTddSessionOptions` object. This is a larger refactor but should be tracked as follow-up work. `runThreeSessionTdd` already uses an options object, which is good.

**File:** `src/tdd/session-runner.ts`

---

### LOW

#### STYLE-2: `fakeAgentManager` defaultAgentName parameter couples test helper to model resolution
**Severity:** LOW | **Category:** Code Quality

The `defaultAgentName?: string` parameter was added to `fakeAgentManager` to solve a model-resolution mismatch in tests where the wrapped adapter is named "mock" but the config expects "claude":

```typescript
export function fakeAgentManager(adapter: AgentAdapter, defaultAgentName?: string): IAgentManager {
  // ...
  getDefault: () => defaultAgentName ?? adapter.name,
```

This is a pragmatic fix, but it leaks model-resolution concerns into the test helper. A cleaner approach would be for tests to provide an adapter whose `name` matches the expected default agent, rather than decoupling the manager's `getDefault()` from the adapter it wraps.

**Fix:** (Optional) In test `makeCtx` helpers, create the adapter with the correct name (`makeAgentAdapter({ name: "claude" })`) and remove `defaultAgentName`. If different tests need different default agents, they should wrap different adapters.

**File:** `test/helpers/fake-agent-manager.ts`

---

#### STYLE-3: `check-no-adapter-wrap.sh` regex could miss re-export patterns
**Severity:** LOW | **Category:** Code Quality

The grep regex:
```bash
grep -E "(import|export|wrapAdapterAsManager\(\)"
```

Would miss patterns like:
```typescript
const { wrapAdapterAsManager } = require("./utils");
```

While these are unlikely, a broader regex would be more robust.

**Status: FIXED** — Replaced narrow regex with `grep -rn` plus a `sed`/`grep` pipeline that strips the `filename:line:` prefix and excludes lines whose content starts with `//` or `*`.

**Fix:** Simplify to `grep -rn "wrapAdapterAsManager" src/` and exclude comment-only lines explicitly.

**File:** `scripts/check-no-adapter-wrap.sh`

---

#### ENH-2: `DispatchContext` comment references deleted function without historical context
**Severity:** LOW | **Category:** Documentation

The JSDoc says: "Closes the wrapAdapterAsManager-fallback class structurally". However, `wrapAdapterAsManager` was deleted from production code, so this comment will become confusing to future readers who do not know the history.

**Status: FIXED** — Added parenthetical context: "(wrapAdapterAsManager was previously exported from src/agents/utils.ts and deleted in ADR-020 Wave 2)".

**Fix:** Add a brief note explaining what `wrapAdapterAsManager` was.

**File:** `src/runtime/dispatch-context.ts`

---

## Positive Findings

### ADR-020 Wave 2 implementation is complete and correct
All 15 tasks from the implementation plan are addressed. The `DispatchContext` base interface is properly extended by all required context types, and no production code references `wrapAdapterAsManager`.

### `fakeAgentManager` is well-documented as test-only
The JSDoc clearly states it is test-only and that production code must use `createRuntime(...).agentManager`. This aligns with the forbidden-patterns rule update.

### Test migration is thorough and mechanical
All 20+ test files that call `runTddSession`, `runTddSessionOp`, or `runThreeSessionTdd` were updated. No production logic was changed to accommodate tests.

### CI gate script is present and functional
`scripts/check-no-adapter-wrap.sh` correctly detects the forbidden symbol and provides a helpful error message.

### `agentManager` is now required in `ThreeSessionTddOptions`
This closes the structural escape hatch where the orchestrator could previously bypass the middleware chain by not passing an `agentManager`.

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:---|:---|:---|:---|
| P1 | TYPE-1 | S | Move type-level tests into `src/` or add `test/` to tsconfig so CI validates compile-time assertions |
| P2 | ENH-1 | S | Wire pre-commit gate into `.githooks/` (the path configured in `package.json`) or add CI step |
| P3 | TYPE-2 | M | Make test `makeCtx` helpers construct valid `DispatchContext` objects instead of partial + `as` casts |
| P4 | STYLE-1 | L | Refactor `runTddSession` from 19 positional params to a single options object (follow-up ticket) |
| P5 | STYLE-2 | S | Remove `defaultAgentName` from `fakeAgentManager`; tests should use correctly-named adapters |
| P6 | ENH-2 | XS | Add historical context to `DispatchContext` JSDoc about `wrapAdapterAsManager` |
| P7 | STYLE-3 | XS | Broaden `check-no-adapter-wrap.sh` regex (optional, low risk) |

---

## Grade Breakdown

| Dimension | Score | Notes |
|:---|:---|:---|
| **Security** | 19/20 | No new attack surface; forbidden pattern gate prevents accidental reintroduction of bypass |
| **Reliability** | 18/20 | All required fields now threaded; type tests construct valid objects; tsconfig.test.json validates |
| **API Design** | 18/20 | `DispatchContext` is a clean, minimal base interface; overloaded `runTddSession` signature detracts |
| **Code Quality** | 18/20 | Mechanical test fixes are clean; pre-commit gate wired; type tests validated; regex robust |
| **Best Practices** | 19/20 | Follows ADR-020 spec closely; forbidden patterns documented; one concern per commit |
| **Total** | **92/100** | **A** |
