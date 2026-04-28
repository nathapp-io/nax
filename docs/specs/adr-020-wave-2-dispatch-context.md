# ADR-020 Wave 2 — `DispatchContext` Base Interface + `wrapAdapterAsManager` Gating

> **Spec status:** Ready for implementation
> **Owning ADR:** [docs/adr/ADR-020-dispatch-boundary-ssot.md](../adr/ADR-020-dispatch-boundary-ssot.md) §D3
> **Closes Gap class:** Optional `agentManager` across ~10 context types (#783 root)
> **Estimated:** ~165 LOC source, ~120 LOC tests, single PR

---

## Goal

After this wave lands:

1. `DispatchContext` is the single base interface for any context that dispatches agent work. It declares 4 required fields (`agentManager`, `sessionManager`, `runtime`, `abortSignal`) — non-nullable.
2. The ~10 existing parallel context types extend `DispatchContext`. Optional `agentManager?` becomes required `agentManager`. Every `?? wrapAdapterAsManager(agent)` fallback site is a compile error and gets fixed in this PR.
3. `wrapAdapterAsManager` is private to `SingleSessionRunner` (gated by `noFallback: true` per ADR-018 §5.2). The public export from `src/agents/utils.ts` is deleted. CI grep gate prevents reintroduction.
4. Helpers that today take `agent: IAgentAdapter` directly (the #783 root pattern) accept `agentManager: IAgentManager` instead.

## Prerequisites

- ADR-020 Wave 1 merged (typed dispatch events at three boundaries; Wave 2 doesn't strictly depend on Wave 1's types but reviewers benefit from seeing the audit/cost coverage already structurally guaranteed).

## Step-by-step implementation

### Step 1 — Add `DispatchContext` base interface

**New file: `src/runtime/dispatch-context.ts`** (~25 LOC)

```typescript
import type { IAgentManager } from "../agents";
import type { ISessionManager } from "../session";
import type { NaxRuntime } from "./index";

/**
 * Base contract for any context that dispatches agent work. Required fields
 * mean every consumer (pipeline stage, operation, lifecycle, CLI command,
 * routing, debate, review, acceptance, plan) must thread these by
 * construction. Closes the wrapAdapterAsManager-fallback class structurally:
 * there is nowhere a nullable agentManager exists in code that dispatches.
 *
 * Future cross-cutting fields (e.g. traceId, resolvedPermissions slice,
 * packageId) go here once; the compiler then surfaces every consumer that
 * must thread them.
 *
 * @see docs/adr/ADR-020-dispatch-boundary-ssot.md §D3
 */
export interface DispatchContext {
  readonly agentManager: IAgentManager;
  readonly sessionManager: ISessionManager;
  readonly runtime: NaxRuntime;
  readonly abortSignal: AbortSignal;
}
```

Export from `src/runtime/index.ts` barrel.

### Step 2 — Make existing context types extend `DispatchContext`

For each row below: add `extends DispatchContext` to the interface declaration; drop the `?` from any field name that overlaps (`agentManager?` → required via the base; `sessionManager?` → required; `abortSignal?` → required). Run `bun run typecheck` after each file to surface compile errors at call sites; fix in same PR.

> **Note on `OperationContext`:** there is **no** type by that name in the codebase. `src/operations/types.ts` declares `BuildContext<C>` (lines 9-12; `packageView` + `config` only) and `CallContext` (lines 14-38; the larger ambient context). `CallContext` is the one to extend `DispatchContext` from — it already has `runtime: NaxRuntime` (line 15), which is the agentManager/sessionManager owner per ADR-018. The cleanest move: have `CallContext` extend `DispatchContext`, and have callers populate the four required fields explicitly (or derive `agentManager`/`sessionManager` from `runtime`).
>
> **Decision:** for `CallContext` specifically, do NOT extend `DispatchContext`. Instead, treat `runtime` (which contains both managers) as the SSOT — `CallContext` already requires `runtime: NaxRuntime`, so the agentManager/sessionManager are non-nullably reachable via `ctx.runtime.agentManager` / `ctx.runtime.sessionManager`. No optional `?` exists on this type today; no fix needed. **Skip `CallContext` from the table below.** Other context types that today declare their own optional `agentManager?` are the migration targets.

| File | Type | Existing optional fields to make required (via base) | Verified? |
|:---|:---|:---|:---|
| `src/pipeline/types.ts:60` | `PipelineContext` | `agentManager?` (145), `sessionManager?` (139), `abortSignal?` (119) | ✓ confirmed via grep |
| `src/execution/lifecycle/acceptance-loop.ts:61` | `AcceptanceLoopOptions` | `agentManager?` (61) | ✓ |
| `src/execution/lifecycle/run-completion.ts:57` | `RunCompletionOptions` | `agentManager?` (57) | ✓ |
| `src/debate/runner-stateful.ts:35` | (verify name via `grep "^export interface\|^interface" src/debate/runner-stateful.ts`) | `agentManager?` (35) | ✓ field present, type name unverified |
| `src/debate/runner-hybrid.ts:41` | (verify name) | `agentManager?` (41) | ✓ field present |
| `src/debate/runner-plan.ts:33` | (verify name) | `agentManager?` (33) | ✓ field present |
| `src/debate/session-helpers.ts:76,201` | (function-param object — may not be a named interface) | `agentManager?` (76, 201) | ✓ field present, may need refactor to a named type |
| `src/review/semantic-debate.ts:30` | (verify name) | already required (`agentManager: IAgentManager`) | ✓ — no change needed |
| `src/routing/router.ts:29,145` | (verify name) | `agentManager?` (29, 145) | ✓ field present |
| `src/session/session-runner.ts:63` | (verify name) | `agentManager?` (63) | ✓ field present |
| `src/acceptance/types.ts:55,117` | (two declarations — verify names) | `agentManager?` (both) | ✓ fields present; confirm two distinct types |
| `src/acceptance/hardening.ts:41` | (verify name) | `agentManager?` (41) | ✓ field present |
| `src/runtime/index.ts:60` | `CreateRuntimeOptions` (constructor input) | `agentManager?` (60) | ⚠ deliberately optional — `createRuntime` constructs a default if absent. **Do NOT make this required;** it's the constructor's "bring-your-own" override slot, not a dispatch-time field. Skip from migration. |

**Implementer action for each unverified type name:** before editing, run `grep -n "^export interface\|^export type\|^interface" <file>` to find the actual declaration name. Add `extends DispatchContext` to the declaration.

**Function-parameter-object cases** (`session-helpers.ts:76,201` and similar): these aren't named interfaces — they're inline `{ agentManager?: IAgentManager, ... }` parameter shapes. Refactor to a named type that extends `DispatchContext`, then update the function signature. ~5 LOC per occurrence.

After all extends added, run `bun run typecheck`. Each compile error is one of:

- **Caller didn't have an `IAgentManager`:** thread one through (it's almost always available higher in the call chain — see Wave 1's emission audit confirming `runtime.agentManager` is reachable everywhere)
- **Caller used `?? wrapAdapterAsManager(agent)`:** delete the fallback; pass real manager
- **Caller used `agent: IAgentAdapter` instead of manager:** update signature (Step 4)

### Step 3 — Move `wrapAdapterAsManager` into `SingleSessionRunner` private scope

**File: `src/session/runners/single-session-runner.ts`**.

Today it imports `wrapAdapterAsManager` from `src/agents/utils.ts`. Inline the implementation as a private (non-exported) helper at the bottom of the file, used only on the `noFallback: true` code path that ADR-018 §5.2 line 716 already established:

```typescript
// src/session/runners/single-session-runner.ts (bottom of file)

/**
 * Private no-fallback wrapper. Used only on the noFallback path where the
 * caller has explicitly opted out of cross-agent fallback (e.g. TDD per-role
 * sessions per ADR-018 §5.2). Must NOT be exported; must NOT be referenced
 * outside this file. Enforced by scripts/check-no-adapter-wrap.sh.
 */
function wrapAdapterAsNoFallbackManager(adapter: AgentAdapter): IAgentManager {
  // ... (same body as src/agents/utils.ts wrapAdapterAsManager today)
}
```

Update the existing call site in `SingleSessionRunner.run` to reference the private helper.

### Step 4 — Delete public `wrapAdapterAsManager` export

**File: `src/agents/utils.ts`**.

Delete the `wrapAdapterAsManager` export. Inline its body (one occurrence) into `SingleSessionRunner` per Step 3.

For `NO_OP_INTERACTION_HANDLER`: run `rg "NO_OP_INTERACTION_HANDLER" src/` to find consumers. If used **only** by `wrapAdapterAsManager`, delete with it. If consumed elsewhere (likely: ad-hoc adapter calls in tests or one-shot tools), move to a clearly-named private module — `src/agents/internal/no-op-interaction-handler.ts` — and update imports. Do **not** re-export from `src/agents` barrel; consumers import directly from `internal/`.

### Step 5 — Audit raw `IAgentAdapter` helper signatures

The #783 root pattern: helpers like `runFullSuiteGate(agent: IAgentAdapter)` accept the adapter directly, side-stepping the manager and any middleware. After Wave 1, audit/cost don't fire as middleware, but **the `noFallback` semantics still need a manager to satisfy `DispatchContext.agentManager`**.

Update each helper to accept `IAgentManager` instead. Where the helper truly needs adapter access (to call `adapter.openSession` for ad-hoc work), get it via `agentManager.getAdapter(name)`.

**Pre-step audit:** run `rg "agent:\s*IAgentAdapter\|agent:\s*AgentAdapter" src/ --type ts` to enumerate every helper that takes a raw adapter. Compare against the list below; if grep finds additional sites, add them to the migration.

| File | Helper | Migration |
|:---|:---|:---|
| `src/tdd/rectification-gate.ts` | `runFullSuiteGate` | Replace `agent: IAgentAdapter` param with `agentManager: IAgentManager`. Where the body called `agent.openSession`/`adapter.complete` directly (if any), route through the manager (`agentManager.runWithFallback` or `agentManager.completeWithFallback`). |
| `src/tdd/orchestrator-ctx.ts` | `getTddSessionBinding` | Confirmed manager-typed post-#783 — verify with grep; no change expected. |
| `src/tdd/session-runner.ts:253` | `runTddSession` internals | The current `effectiveManager = sessionBinding?.agentManager ?? wrapAdapterAsManager(agent)` pattern is removed. Function signature accepts `agentManager: IAgentManager` (no `?`); callers pass `ctx.agentManager`. |
| Others surfaced by the pre-step grep | — | Same pattern: replace adapter param with manager; route adapter calls through `agentManager.getAdapter(name)` only if the helper truly needs adapter primitives (rare — most can use the higher-layer manager API). |

For each updated helper, update every caller. Most callers already have `ctx.agentManager` reachable (verified during Wave 1).

### Step 6 — Test-only fake manager

**New file: `test/helpers/fake-agent-manager.ts`** (~80 LOC)

Test fixtures need a way to instantiate an `IAgentManager` without a full `NaxRuntime`. Move `wrapAdapterAsManager`'s body here under a clearly test-only name:

```typescript
/**
 * Test-only fake manager. Wraps an adapter with no middleware chain and
 * no fallback policy. Use ONLY in unit tests that don't need a full
 * runtime. Production code must use createRuntime(...).agentManager.
 *
 * @see docs/adr/ADR-020-dispatch-boundary-ssot.md §D3
 */
export function fakeAgentManager(adapter: AgentAdapter): IAgentManager {
  // ... (body moved from src/agents/utils.ts)
}
```

Update every test that currently imports `wrapAdapterAsManager` from `src/agents/utils.ts` to import `fakeAgentManager` from `test/helpers/fake-agent-manager`. Mechanical sed across `test/`.

### Step 7 — CI grep gate

**New file: `scripts/check-no-adapter-wrap.sh`** (~20 LOC)

```bash
#!/usr/bin/env bash
set -euo pipefail

# Production code must NOT reference wrapAdapterAsManager. The only legitimate
# wrapper lives privately inside src/session/runners/single-session-runner.ts
# (named wrapAdapterAsNoFallbackManager) and is gated by noFallback:true.
#
# @see docs/adr/ADR-020-dispatch-boundary-ssot.md §D3

violations=$(rg --files-with-matches 'wrapAdapterAsManager' src/ \
  | grep -v '^src/session/runners/single-session-runner.ts$' \
  || true)

if [[ -n "$violations" ]]; then
  echo "FAIL: wrapAdapterAsManager referenced outside SingleSessionRunner:"
  echo "$violations"
  echo ""
  echo "Use ctx.agentManager (DispatchContext) instead. See ADR-020 §D3."
  exit 1
fi

echo "OK: No wrapAdapterAsManager violations found."
```

Wire into `.husky/pre-commit` (alongside the existing `check-process-cwd.sh`) and CI workflow.

### Step 8 — Update forbidden-patterns rule

**File: `.claude/rules/forbidden-patterns.md`**.

Add row under "Source Code" table:

| ❌ Forbidden | ✅ Use Instead | Why |
|:---|:---|:---|
| `wrapAdapterAsManager` outside `src/session/runners/single-session-runner.ts` | `ctx.agentManager` (from `DispatchContext`) | The wrapper has no middleware chain; using it bypasses audit, cost, cancellation. ADR-020 §D3. |

## Tests

### `test/unit/runtime/dispatch-context.test.ts` (new, ~30 LOC)

Type-only tests using `tsd` or compile-time assertions:
- `PipelineContext extends DispatchContext` — assignable
- `OperationContext<C> extends DispatchContext` — assignable
- All 10 context types satisfy `DispatchContext`
- A type with `agentManager?: IAgentManager` does NOT satisfy `DispatchContext` (negative)

### `test/integration/agents/no-adapter-wrap.test.ts` (new, ~25 LOC)

```typescript
test("src/agents/utils.ts does not export wrapAdapterAsManager", async () => {
  const utils = await import("../../../src/agents/utils");
  expect("wrapAdapterAsManager" in utils).toBe(false);
});

test("only single-session-runner references the private wrapper", async () => {
  const result = Bun.spawnSync({
    cmd: ["rg", "wrapAdapterAsManager", "src/", "--files-with-matches"],
  });
  const files = result.stdout.toString().trim().split("\n").filter(Boolean);
  expect(files).toEqual(["src/session/runners/single-session-runner.ts"]);
});
```

### Existing tests

All existing tests using `wrapAdapterAsManager` from `src/agents/utils.ts` switch to `fakeAgentManager` from `test/helpers/fake-agent-manager.ts`. Mechanical update; behaviour identical.

## Validation

1. **Typecheck green:** `bun run typecheck` — every compile error from Step 2 fixed in the same PR
2. **Tests pass:** `bun run test`
3. **Pre-commit gate:** `bash scripts/check-no-adapter-wrap.sh` returns OK
4. **Grep:** `rg 'wrapAdapterAsManager' src/` returns exactly one file: `src/session/runners/single-session-runner.ts`
5. **Grep (whitespace-tolerant):** `rg 'agentManager\?\s*:\s*(import\(.+\)\.)?IAgentManager' src/` returns zero hits — covers `agentManager?: IAgentManager`, `agentManager? : IAgentManager`, and `agentManager?: import("../agents").IAgentManager` variants. The exception is `src/runtime/index.ts:60` (CreateRuntimeOptions, deliberately optional per Step 2 note).
6. **Re-run dogfood (`tdd-calc`, `hello-lint`):** all audit and cost coverage from Wave 1 still works (no regressions); TDD per-role audit names still present

## Rollback

Single PR. Revert restores `wrapAdapterAsManager` public export and the optional `?` on context types. The `DispatchContext` base interface is additive — its removal needs the `extends` clauses removed simultaneously.

## Risk + mitigation

| Risk | Mitigation |
|:---|:---|
| Step 2 produces many compile errors at once | Run typecheck per file as you add each `extends`; commit batches by directory (pipeline, then operations, then debate, etc.) for easier review |
| A truly fallback-needing site discovered (no `IAgentManager` reachable) | This case shouldn't exist post-Wave 1, but if found: thread `runtime.agentManager` from the nearest available `NaxRuntime`. If even that is impossible, the call site is itself the bug — investigate before forcing the type |
| Plugin or third-party code uses the public wrapper | No third-party in-tree plugins use it (verified via grep at audit time). CHANGELOG note for downstream consumers |
| `fakeAgentManager` named too closely to production helper, future test author confuses them | Aggressive doc comment + test-only directory + grep gate prevents production import |

## Out of scope

- ADR-020 Wave 1 work (typed dispatch events) — this wave assumes that's done
- ADR-020 Wave 3 (`Operation.verify`/`recover`) — orthogonal
- Promoting `DispatchContext` to a runtime "context factory" — explicitly rejected per ADR-020 §A5
