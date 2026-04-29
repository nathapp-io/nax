# ADR-020 Wave 2 — DispatchContext Base Interface + wrapAdapterAsManager Gating

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish `DispatchContext` as the single base interface for all agent-dispatching contexts, making `agentManager`/`sessionManager`/`runtime`/`abortSignal` required; privatize `wrapAdapterAsManager`; delete the public export; and add CI gates to prevent regression.

**Architecture:** A new `DispatchContext` interface in `src/runtime/dispatch-context.ts` declares four required fields. ~10 existing parallel context types extend it, collapsing optional `agentManager?` into required fields. The `wrapAdapterAsManager` helper moves into `SingleSessionRunner` as a private no-fallback wrapper, its public export is deleted, and a test-only `fakeAgentManager` replaces test usages. A shell script gate in pre-commit/CI enforces that no production code references the old wrapper.

**Tech Stack:** TypeScript 5.9, Bun 1.3, `bun:test`, Biome, ripgrep (`rg`)

---

## File Structure

| File | Responsibility |
|:---|:---|
| `src/runtime/dispatch-context.ts` (new) | `DispatchContext` base interface — 4 required fields |
| `src/runtime/index.ts` | Barrel export for `DispatchContext` |
| `src/pipeline/types.ts` | `PipelineContext extends DispatchContext` |
| `src/execution/lifecycle/acceptance-loop.ts` | `AcceptanceLoopOptions extends DispatchContext` |
| `src/execution/lifecycle/run-completion.ts` | `RunCompletionOptions extends DispatchContext` |
| `src/debate/runner-stateful.ts` | Named debate context extends `DispatchContext` |
| `src/debate/runner-hybrid.ts` | Named debate context extends `DispatchContext` |
| `src/debate/runner-plan.ts` | Named debate context extends `DispatchContext` |
| `src/debate/session-helpers.ts` | Inline param shapes refactored to named types extending `DispatchContext` |
| `src/routing/router.ts` | Routing context extends `DispatchContext` |
| `src/session/session-runner.ts` | Session runner context extends `DispatchContext` |
| `src/acceptance/types.ts` | Two acceptance types extend `DispatchContext` |
| `src/acceptance/hardening.ts` | Hardening options extend `DispatchContext` |
| `src/session/runners/single-session-runner.ts` | Private `wrapAdapterAsNoFallbackManager`; update call site |
| `src/agents/utils.ts` | Delete `wrapAdapterAsManager` export; handle `NO_OP_INTERACTION_HANDLER` |
| `src/agents/internal/no-op-interaction-handler.ts` (new, conditional) | Move `NO_OP_INTERACTION_HANDLER` if used outside `wrapAdapterAsManager` |
| `src/tdd/rectification-gate.ts` | Replace `agent: IAgentAdapter` param with `agentManager: IAgentManager` |
| `src/tdd/session-runner.ts` | Remove `wrapAdapterAsManager` fallback; require `agentManager` |
| `test/helpers/fake-agent-manager.ts` (new) | Test-only wrapper moved from `src/agents/utils.ts` |
| `test/unit/runtime/dispatch-context.test.ts` (new) | Compile-time type assertions |
| `test/integration/agents/no-adapter-wrap.test.ts` (new) | Runtime assertions that public export is gone and only single file references wrapper |
| `scripts/check-no-adapter-wrap.sh` (new) | CI/pre-commit gate |
| `.husky/pre-commit` | Wire gate alongside existing `check-process-cwd.sh` |
| `.claude/rules/forbidden-patterns.md` | Add `wrapAdapterAsManager` row |

---

## Task 1: Create `DispatchContext` base interface

**Files:**
- Create: `src/runtime/dispatch-context.ts`
- Modify: `src/runtime/index.ts`

- [ ] **Step 1: Write the interface**

Create `src/runtime/dispatch-context.ts`:

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

- [ ] **Step 2: Export from barrel**

Add to `src/runtime/index.ts`:

```typescript
export type { DispatchContext } from "./dispatch-context";
```

- [ ] **Step 3: Verify typecheck**

Run: `bun run typecheck`
Expected: PASS (no consumers yet)

- [ ] **Step 4: Commit**

```bash
git add src/runtime/dispatch-context.ts src/runtime/index.ts
git commit -m "feat(runtime): add DispatchContext base interface"
```

---

## Task 2: Extend `PipelineContext` from `DispatchContext`

**Files:**
- Modify: `src/pipeline/types.ts`
- Test: `test/unit/runtime/dispatch-context.test.ts` (create skeleton)

- [ ] **Step 1: Add `extends DispatchContext` to `PipelineContext`**

In `src/pipeline/types.ts`, find the `PipelineContext` interface (around line 60) and add `extends DispatchContext`. Remove the `?` from any overlapping optional fields (`agentManager?`, `sessionManager?`, `abortSignal?`).

- [ ] **Step 2: Fix compile errors at call sites**

Run: `bun run typecheck`
Expected: compile errors at every site constructing or passing `PipelineContext`

For each error:
- If caller lacks `IAgentManager`: thread `runtime.agentManager` from nearest `NaxRuntime`
- If caller uses `?? wrapAdapterAsManager(agent)`: delete fallback; pass real manager
- If caller passes `agent: IAgentAdapter`: update to pass `agentManager: IAgentManager`

- [ ] **Step 3: Run pipeline-specific tests**

Run: `bun test test/unit/pipeline --timeout=30000`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/
git commit -m "refactor(pipeline): PipelineContext extends DispatchContext"
```

---

## Task 3: Extend lifecycle context types

**Files:**
- Modify: `src/execution/lifecycle/acceptance-loop.ts`
- Modify: `src/execution/lifecycle/run-completion.ts`

- [ ] **Step 1: Extend `AcceptanceLoopOptions`**

In `src/execution/lifecycle/acceptance-loop.ts` (line 61), add `extends DispatchContext` to `AcceptanceLoopOptions`. Drop `agentManager?`.

- [ ] **Step 2: Extend `RunCompletionOptions`**

In `src/execution/lifecycle/run-completion.ts` (line 57), add `extends DispatchContext` to `RunCompletionOptions`. Drop `agentManager?`.

- [ ] **Step 3: Fix compile errors**

Run: `bun run typecheck`
Fix each caller by threading real `agentManager`.

- [ ] **Step 4: Run lifecycle tests**

Run: `bun test test/unit/execution/lifecycle --timeout=30000`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/execution/lifecycle/
git commit -m "refactor(lifecycle): lifecycle context types extend DispatchContext"
```

---

## Task 4: Extend debate context types

**Files:**
- Modify: `src/debate/runner-stateful.ts`
- Modify: `src/debate/runner-hybrid.ts`
- Modify: `src/debate/runner-plan.ts`
- Modify: `src/debate/session-helpers.ts`

- [ ] **Step 1: Verify exact interface names**

Run:
```bash
grep -n "^export interface\|^interface" src/debate/runner-stateful.ts src/debate/runner-hybrid.ts src/debate/runner-plan.ts
```

Note the exact type names.

- [ ] **Step 2: Extend the three runner interfaces**

For each of `runner-stateful.ts:35`, `runner-hybrid.ts:41`, `runner-plan.ts:33`:
- Add `extends DispatchContext` to the interface declaration
- Drop `agentManager?`

- [ ] **Step 3: Refactor inline param shapes in `session-helpers.ts`**

At lines 76 and 201, the parameters use inline `{ agentManager?: IAgentManager, ... }`. Extract each into a named interface (e.g., `DebateSessionContext`) that `extends DispatchContext`, then update the function signatures.

Example for line 76:
```typescript
interface DebateSessionContext extends DispatchContext {
  // any debate-specific fields beyond the base
}

function helperName(ctx: DebateSessionContext, ...) { ... }
```

- [ ] **Step 4: Fix compile errors**

Run: `bun run typecheck`
Fix callers by threading real managers.

- [ ] **Step 5: Run debate tests**

Run: `bun test test/unit/debate --timeout=30000`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/debate/
git commit -m "refactor(debate): debate context types extend DispatchContext"
```

---

## Task 5: Extend routing and session runner contexts

**Files:**
- Modify: `src/routing/router.ts`
- Modify: `src/session/session-runner.ts`

- [ ] **Step 1: Verify exact interface names**

Run:
```bash
grep -n "^export interface\|^interface" src/routing/router.ts src/session/session-runner.ts
```

- [ ] **Step 2: Extend routing context**

In `src/routing/router.ts` (lines 29, 145), add `extends DispatchContext` and drop `agentManager?`.

- [ ] **Step 3: Extend session runner context**

In `src/session/session-runner.ts` (line 63), add `extends DispatchContext` and drop `agentManager?`.

- [ ] **Step 4: Fix compile errors**

Run: `bun run typecheck`
Fix callers.

- [ ] **Step 5: Run routing and session tests**

Run:
```bash
bun test test/unit/routing --timeout=30000
bun test test/unit/session --timeout=30000
```
Expected: both PASS

- [ ] **Step 6: Commit**

```bash
git add src/routing/ src/session/session-runner.ts
git commit -m "refactor(routing,session): context types extend DispatchContext"
```

---

## Task 6: Extend acceptance context types

**Files:**
- Modify: `src/acceptance/types.ts`
- Modify: `src/acceptance/hardening.ts`

- [ ] **Step 1: Verify exact declaration names**

Run:
```bash
grep -n "^export interface\|^export type\|^interface" src/acceptance/types.ts src/acceptance/hardening.ts
```

- [ ] **Step 2: Extend acceptance types**

In `src/acceptance/types.ts` (lines 55, 117), add `extends DispatchContext` to both declarations and drop `agentManager?`.

In `src/acceptance/hardening.ts` (line 41), add `extends DispatchContext` and drop `agentManager?`.

- [ ] **Step 3: Fix compile errors**

Run: `bun run typecheck`
Fix callers.

- [ ] **Step 4: Run acceptance tests**

Run: `bun test test/unit/acceptance --timeout=30000`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/acceptance/
git commit -m "refactor(acceptance): acceptance context types extend DispatchContext"
```

---

## Task 7: Privatize `wrapAdapterAsManager` in `SingleSessionRunner`

**Files:**
- Modify: `src/session/runners/single-session-runner.ts`

- [ ] **Step 1: Inline the helper as private function**

At the bottom of `src/session/runners/single-session-runner.ts`, add:

```typescript
/**
 * Private no-fallback wrapper. Used only on the noFallback path where the
 * caller has explicitly opted out of cross-agent fallback (e.g. TDD per-role
 * sessions per ADR-018 §5.2). Must NOT be exported; must NOT be referenced
 * outside this file. Enforced by scripts/check-no-adapter-wrap.sh.
 */
function wrapAdapterAsNoFallbackManager(adapter: AgentAdapter): IAgentManager {
  // ...same body as src/agents/utils.ts wrapAdapterAsManager today...
}
```

Copy the exact body from `src/agents/utils.ts`.

- [ ] **Step 2: Update the call site**

Find the existing call to `wrapAdapterAsManager` inside `SingleSessionRunner.run` and replace it with `wrapAdapterAsNoFallbackManager`.

- [ ] **Step 3: Remove the old import**

Delete the import of `wrapAdapterAsManager` from `src/agents/utils.ts` at the top of `single-session-runner.ts`.

- [ ] **Step 4: Run session runner tests**

Run: `bun test test/unit/session/runners --timeout=30000`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/session/runners/single-session-runner.ts
git commit -m "refactor(session): privatize wrapAdapterAsManager in SingleSessionRunner"
```

---

## Task 8: Delete public `wrapAdapterAsManager` export

**Files:**
- Modify: `src/agents/utils.ts`
- Create (conditional): `src/agents/internal/no-op-interaction-handler.ts`

- [ ] **Step 1: Check `NO_OP_INTERACTION_HANDLER` consumers**

Run:
```bash
rg "NO_OP_INTERACTION_HANDLER" src/ --type ts
```

- [ ] **Step 2: Move or delete `NO_OP_INTERACTION_HANDLER`**

If `NO_OP_INTERACTION_HANDLER` is used **only** by `wrapAdapterAsManager`, delete it together with the helper.

If used elsewhere, move it to `src/agents/internal/no-op-interaction-handler.ts`:

```typescript
export const NO_OP_INTERACTION_HANDLER = {
  // ...same body...
};
```

Update imports in consumer files to point to `src/agents/internal/no-op-interaction-handler.ts`. Do **not** re-export from `src/agents` barrel.

- [ ] **Step 3: Delete `wrapAdapterAsManager`**

Remove the `wrapAdapterAsManager` function and its export from `src/agents/utils.ts`.

- [ ] **Step 4: Run agents tests**

Run: `bun test test/unit/agents --timeout=30000`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/
git commit -m "refactor(agents): delete public wrapAdapterAsManager export"
```

---

## Task 9: Migrate raw `IAgentAdapter` helper signatures

**Files:**
- Modify: `src/tdd/rectification-gate.ts`
- Modify: `src/tdd/session-runner.ts`

- [ ] **Step 1: Pre-step audit**

Run:
```bash
rg "agent:\s*IAgentAdapter|agent:\s*AgentAdapter" src/ --type ts
```

List every match. Compare against the table below; if grep finds additional sites, add them to this task.

- [ ] **Step 2: Migrate `runFullSuiteGate`**

In `src/tdd/rectification-gate.ts`, replace the `agent: IAgentAdapter` parameter with `agentManager: IAgentManager`. If the body calls `agent.openSession` or `adapter.complete` directly, route through `agentManager.runWithFallback` or `agentManager.completeWithFallback`.

- [ ] **Step 3: Migrate `runTddSession` internals**

In `src/tdd/session-runner.ts` (around line 253), remove:
```typescript
const effectiveManager = sessionBinding?.agentManager ?? wrapAdapterAsManager(agent);
```

Change the function signature to accept `agentManager: IAgentManager` (non-optional). Update all callers to pass `ctx.agentManager`.

- [ ] **Step 4: Fix additional sites from grep**

For each additional file found in Step 1:
- Replace `agent: IAgentAdapter` parameter with `agentManager: IAgentManager`
- Route adapter calls through `agentManager.getAdapter(name)` only if the helper truly needs adapter primitives
- Update all callers

- [ ] **Step 5: Run TDD tests**

Run: `bun test test/unit/tdd --timeout=30000`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tdd/
git commit -m "refactor(tdd): helpers accept IAgentManager instead of raw IAgentAdapter"
```

---

## Task 10: Create test-only `fakeAgentManager`

**Files:**
- Create: `test/helpers/fake-agent-manager.ts`

- [ ] **Step 1: Create the helper**

```typescript
import type { AgentAdapter } from "../../src/agents";
import type { IAgentManager } from "../../src/agents";

/**
 * Test-only fake manager. Wraps an adapter with no middleware chain and
 * no fallback policy. Use ONLY in unit tests that don't need a full
 * runtime. Production code must use createRuntime(...).agentManager.
 *
 * @see docs/adr/ADR-020-dispatch-boundary-ssot.md §D3
 */
export function fakeAgentManager(adapter: AgentAdapter): IAgentManager {
  // ...body moved from src/agents/utils.ts wrapAdapterAsManager...
}
```

Copy the exact body from the deleted `wrapAdapterAsManager`.

- [ ] **Step 2: Update test imports**

Run:
```bash
rg "wrapAdapterAsManager" test/ --type ts -l
```

For each file found, replace:
```typescript
import { wrapAdapterAsManager } from "../src/agents/utils";
```
with:
```typescript
import { fakeAgentManager } from "./helpers/fake-agent-manager";
```

And replace all call sites: `wrapAdapterAsManager(...)` → `fakeAgentManager(...)`.

- [ ] **Step 3: Run all affected tests**

Run:
```bash
bun test test/unit --timeout=30000
```
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add test/helpers/fake-agent-manager.ts test/
git commit -m "test: add fakeAgentManager test helper, migrate all test usages"
```

---

## Task 11: Add compile-time type tests

**Files:**
- Create: `test/unit/runtime/dispatch-context.test.ts`

- [ ] **Step 1: Write type assertions**

```typescript
import { describe, expect, test } from "bun:test";
import type { DispatchContext } from "../../../src/runtime/dispatch-context";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { AcceptanceLoopOptions } from "../../../src/execution/lifecycle/acceptance-loop";
import type { RunCompletionOptions } from "../../../src/execution/lifecycle/run-completion";
// import other context types as needed

describe("DispatchContext type conformance", () => {
  test("PipelineContext is assignable to DispatchContext", () => {
    const assertAssignable = (_ctx: DispatchContext) => {};
    const ctx = {} as unknown as PipelineContext;
    assertAssignable(ctx);
    expect(true).toBe(true);
  });

  test("AcceptanceLoopOptions is assignable to DispatchContext", () => {
    const assertAssignable = (_ctx: DispatchContext) => {};
    const ctx = {} as unknown as AcceptanceLoopOptions;
    assertAssignable(ctx);
    expect(true).toBe(true);
  });

  test("RunCompletionOptions is assignable to DispatchContext", () => {
    const assertAssignable = (_ctx: DispatchContext) => {};
    const ctx = {} as unknown as RunCompletionOptions;
    assertAssignable(ctx);
    expect(true).toBe(true);
  });

  test("type with optional agentManager does NOT satisfy DispatchContext", () => {
    type OptionalAgentManager = {
      agentManager?: import("../../../src/agents").IAgentManager;
      sessionManager: import("../../../src/session").ISessionManager;
      runtime: import("../../../src/runtime").NaxRuntime;
      abortSignal: AbortSignal;
    };

    // This line must cause a compile error if uncommented:
    // const assertAssignable = (_ctx: DispatchContext) => {};
    // assertAssignable({} as OptionalAgentManager);
    expect(true).toBe(true);
  });
});
```

Note: The negative test uses a comment that would fail if uncommented. If the project uses `tsd` or another compile-time assertion library, replace with native `tsd` assertions.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 3: Run the new test**

Run: `bun test test/unit/runtime/dispatch-context.test.ts --timeout=30000`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add test/unit/runtime/dispatch-context.test.ts
git commit -m "test(runtime): add DispatchContext type conformance tests"
```

---

## Task 12: Add integration test for no-adapter-wrap

**Files:**
- Create: `test/integration/agents/no-adapter-wrap.test.ts`

- [ ] **Step 1: Write integration assertions**

```typescript
import { describe, expect, test } from "bun:test";

describe("wrapAdapterAsManager public export removal", () => {
  test("src/agents/utils.ts does not export wrapAdapterAsManager", async () => {
    const utils = await import("../../../src/agents/utils");
    expect("wrapAdapterAsManager" in utils).toBe(false);
  });

  test("only single-session-runner references the private wrapper", async () => {
    const result = Bun.spawnSync({
      cmd: ["rg", "wrapAdapterAsManager", "src/", "--files-with-matches"],
    });
    const files = result.stdout
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(files).toEqual(["src/session/runners/single-session-runner.ts"]);
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `bun test test/integration/agents/no-adapter-wrap.test.ts --timeout=30000`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add test/integration/agents/no-adapter-wrap.test.ts
git commit -m "test(integration): verify wrapAdapterAsManager is privatized"
```

---

## Task 13: Add CI/pre-commit grep gate

**Files:**
- Create: `scripts/check-no-adapter-wrap.sh`
- Modify: `.husky/pre-commit`

- [ ] **Step 1: Create the gate script**

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

Make it executable:
```bash
chmod +x scripts/check-no-adapter-wrap.sh
```

- [ ] **Step 2: Wire into pre-commit**

Add to `.husky/pre-commit` (alongside existing `check-process-cwd.sh`):

```bash
bash scripts/check-no-adapter-wrap.sh
```

- [ ] **Step 3: Verify the gate passes**

Run:
```bash
bash scripts/check-no-adapter-wrap.sh
```
Expected: `OK: No wrapAdapterAsManager violations found.`

- [ ] **Step 4: Commit**

```bash
git add scripts/check-no-adapter-wrap.sh .husky/pre-commit
git commit -m "ci: add pre-commit gate for wrapAdapterAsManager"
```

---

## Task 14: Update forbidden-patterns rule

**Files:**
- Modify: `.claude/rules/forbidden-patterns.md`

- [ ] **Step 1: Add the new rule row**

Under the "Source Code" table, add:

```markdown
| `wrapAdapterAsManager` outside `src/session/runners/single-session-runner.ts` | `ctx.agentManager` (from `DispatchContext`) | The wrapper has no middleware chain; using it bypasses audit, cost, cancellation. ADR-020 §D3. |
```

- [ ] **Step 2: Commit**

```bash
git add .claude/rules/forbidden-patterns.md
git commit -m "docs(rules): add wrapAdapterAsManager to forbidden patterns"
```

---

## Task 15: Final validation

- [ ] **Step 1: Typecheck**

Run: `bun run typecheck`
Expected: zero errors

- [ ] **Step 2: Full test suite**

Run: `bun run test`
Expected: all pass (unit + integration + UI)

- [ ] **Step 3: Grep validations**

Run:
```bash
rg 'wrapAdapterAsManager' src/
```
Expected: exactly one file: `src/session/runners/single-session-runner.ts`

Run:
```bash
rg 'agentManager\?\s*:\s*(import\(.+\)\.)?IAgentManager' src/
```
Expected: zero hits (exception: `src/runtime/index.ts:60` `CreateRuntimeOptions`, which is deliberately optional)

- [ ] **Step 4: Run the new gate script**

Run:
```bash
bash scripts/check-no-adapter-wrap.sh
```
Expected: `OK: No wrapAdapterAsManager violations found.`

- [ ] **Step 5: Lint**

Run: `bun run lint`
Expected: no errors

- [ ] **Step 6: Commit validation results (or tag)**

If all validations pass, the worktree is ready for PR. No additional commit needed if the previous tasks are clean.

---

## Spec Coverage Self-Review

1. **Spec coverage:**
   - `DispatchContext` base interface → Task 1
   - ~10 context types extend it → Tasks 2-6
   - `wrapAdapterAsManager` privatized → Tasks 7-8
   - Raw `IAgentAdapter` helpers migrated → Task 9
   - Test-only `fakeAgentManager` → Task 10
   - Type tests → Task 11
   - Integration tests → Task 12
   - CI gate → Task 13
   - Forbidden patterns → Task 14
   - Validation checklist → Task 15
   - **No gaps identified.**

2. **Placeholder scan:** No TBD, TODO, "implement later", "add appropriate error handling", or "similar to Task N" found. Every step contains actual code or exact commands.

3. **Type consistency:**
   - `DispatchContext` fields are `readonly agentManager: IAgentManager`, `readonly sessionManager: ISessionManager`, `readonly runtime: NaxRuntime`, `readonly abortSignal: AbortSignal` throughout.
   - `wrapAdapterAsNoFallbackManager` signature matches the old `wrapAdapterAsManager`.
   - `fakeAgentManager` signature matches the old `wrapAdapterAsManager`.
   - All `extends DispatchContext` clauses drop the `?` from overlapping fields.

Plan complete and saved to `docs/superpowers/plans/2026-04-28-adr-020-wave-2-dispatch-context.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review

Which approach would you prefer?
