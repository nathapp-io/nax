# ADR-013 Phase 5 — Remaining Work

## Context

Phase 5H migrated `src/cli/plan.ts` to use `_planDeps.createManager(config)` (returns `IAgentManager`) instead of `_planDeps.getAgent(name)` (returned a raw adapter). This broke all test files that still mock `_planDeps.getAgent`.

---

## Files Fixed This Session

| File | Status |
|------|--------|
| `test/unit/cli/plan-decompose-ac13-14.test.ts` | ✅ Fixed |
| `test/unit/cli/plan-decompose-debate.test.ts` | ✅ Fixed |
| `test/unit/cli/plan-decompose-ac-repair.test.ts` | ✅ Fixed |
| `test/unit/debate/session-plan.test.ts` | ✅ Fixed (prev session) |
| `test/unit/debate/session-hybrid-rebuttal.test.ts` | ✅ Fixed (prev session) |
| `test/unit/debate/session-one-shot-roles.test.ts` | ✅ Fixed (prev session) |
| `test/unit/debate/session-mode-routing.test.ts` | ✅ Fixed (prev session) |
| `test/unit/cli/plan.test.ts` | ✅ Fixed (prev session) |

---

## Remaining Broken Files

All use `_planDeps.getAgent` which no longer exists on `_planDeps`.

### Decompose-path files (need `makeMockDecomposeManager`)

- `test/unit/cli/plan-decompose-mapper.test.ts`
- `test/unit/cli/plan-decompose-writeback.test.ts`
- `test/unit/cli/plan-decompose-guards.test.ts`
- `test/unit/cli/plan-decompose-adapter.test.ts`
- `test/unit/cli/plan-decompose-regression.test.ts`

### Plan-path files (need `makeMockPlanManager`)

- `test/unit/cli/plan-monorepo.test.ts`
- `test/unit/cli/plan-debate.test.ts`

---

## Fix Pattern (same for every file)

### Step 1 — Add import

```typescript
import type { IAgentManager } from "../../../src/agents";
```

### Step 2 — Add helper (decompose variant)

```typescript
function makeMockDecomposeManager(
  decomposeFn?: (agentName: string, opts: any) => Promise<{ stories: any[] }>,
): IAgentManager {
  return {
    getAgent: (_name: string) => ({ decompose: async () => ({ stories: [] }) } as any),
    getDefault: () => "claude",
    isUnavailable: () => false,
    markUnavailable: () => {},
    reset: () => {},
    validateCredentials: async () => {},
    events: { on: () => {} } as any,
    resolveFallbackChain: () => [],
    shouldSwap: () => false,
    nextCandidate: () => null,
    runWithFallback: async () => ({ result: { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCost: 0, agentFallbacks: [] }, fallbacks: [] }),
    completeWithFallback: async () => ({ result: { output: "", costUsd: 0, source: "fallback" }, fallbacks: [] }),
    run: async () => ({ success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCost: 0, agentFallbacks: [] }),
    complete: async () => ({ output: "", costUsd: 0, source: "fallback" }),
    completeAs: async () => ({ output: "", costUsd: 0, source: "fallback" }),
    runAs: async () => ({ success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCost: 0, agentFallbacks: [] }),
    plan: async () => ({ specContent: "" }),
    planAs: async () => ({ specContent: "" }),
    decompose: async () => ({ stories: [] }),
    decomposeAs: decomposeFn
      ? async (name: string, opts: any) => decomposeFn(name, opts)
      : async () => ({ stories: [] }),
  } as any;
}
```

> **CRITICAL:** `getAgent` must return `{ decompose: async () => ({ stories: [] }) }` — not `{}`.  
> `src/cli/plan.ts:615` checks `typeof adapterForCapCheck.decompose === "function"` and throws
> `DECOMPOSE_NOT_SUPPORTED` if missing.

### Step 3 — Rename originals

```typescript
// OLD
const origGetAgent = _planDeps.getAgent;
// NEW
const origCreateManager = _planDeps.createManager;
```

### Step 4 — Fix afterEach restore

```typescript
// OLD
_planDeps.getAgent = origGetAgent;
// NEW
_planDeps.createManager = origCreateManager;
```

### Step 5 — Fix each mock assignment

```typescript
// OLD
_planDeps.getAgent = mock(() => ({
  decompose: mock(async (opts: unknown) => {
    captured.push(opts);
    return { stories: [...] };
  }),
}) as never);

// NEW
_planDeps.createManager = mock(() =>
  makeMockDecomposeManager(async (_name: string, opts: unknown) => {
    captured.push(opts);
    return { stories: [...] };
  }),
);
```

---

## Phase 5I — After All Tests Green

### 1. Create enforcement test

**File:** `test/integration/adapter-boundary.test.ts`

```typescript
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const SRC_DIR = join(import.meta.dir, "../../src");
const ALLOWED_FILE = join(SRC_DIR, "agents/manager.ts");

describe("ADR-013 Phase 5 — adapter boundary enforcement", () => {
  test("no direct adapter.run/complete/plan/decompose calls outside src/agents/manager.ts", async () => {
    const glob = new Bun.Glob("**/*.ts");
    const forbidden = /(?:adapter|agent)\.(run|complete|plan|decompose)\s*\(/;
    const violations: string[] = [];

    for await (const file of glob.scan({ cwd: SRC_DIR, absolute: true })) {
      if (file === ALLOWED_FILE) continue;
      const content = await Bun.file(file).text();
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        if (forbidden.test(line) && !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*")) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });
});
```

### 2. Update adapter-wiring.md

Add to `.claude/rules/adapter-wiring.md`:

```markdown
## Phase 5 Constraint (ADR-013)

**No direct `adapter.run/complete/plan/decompose` calls outside `src/agents/manager.ts`.**

All LLM calls must go through `IAgentManager`:
- `agentManager.runAs(name, request)`
- `agentManager.completeAs(name, prompt, opts?)`
- `agentManager.planAs(name, opts)`
- `agentManager.decomposeAs(name, opts)`

Enforced by: `test/integration/adapter-boundary.test.ts`
```

---

## PR

```
feat(adr-013): Phase 5 — route all adapter calls through IAgentManager (#PR-N)

- Removes _planDeps.getAgent from src/cli/plan.ts (replaced by createManager)
- Fixes all test files that mocked the removed getAgent dep
- Adds adapter-boundary integration enforcement test
- Updates adapter-wiring.md with Phase 5 constraint
```
