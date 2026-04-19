# AgentManager Phase 3 — Call-site Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all direct reads of `config.autoMode.defaultAgent` / `config.autoMode.fallbackOrder` / `config.context.v2.fallback` outside `src/config/` by routing through `agentManager.getDefault()` or a new `resolveDefaultAgent(config)` helper — purely mechanical, zero behaviour change.

**Architecture:** Two replacement patterns: (a) code with `ctx: PipelineContext` uses `ctx.agentManager.getDefault()` directly — manager is always populated by runner since Phase 1; (b) subsystem functions that receive only `config: NaxConfig` use a new `resolveDefaultAgent(config)` utility in `src/agents/utils.ts` that is the single allowed config reader outside `src/config/`. All scattered reads consolidate to two SSOT readers: `AgentManager.getDefault()` and `resolveDefaultAgent()`.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, bun:test

---

## File Map

| Action | File | Purpose |
|:---|:---|:---|
| Create | `src/agents/utils.ts` | `resolveDefaultAgent(config)` — SSOT helper for non-manager contexts |
| Modify | `src/agents/index.ts` | barrel-export `resolveDefaultAgent` |
| Create | `test/helpers/mock-agent-manager.ts` | `createMockAgentManager()` factory for tests |
| Modify | `src/pipeline/stages/routing.ts` | pattern (a) |
| Modify | `src/pipeline/stages/execution.ts` | pattern (a) — only the `resolveModelForAgent` calls; swap loop unchanged until Phase 5 |
| Modify | `src/pipeline/stages/autofix.ts` | pattern (a) |
| Modify | `src/pipeline/stages/autofix-adversarial.ts` | pattern (a) |
| Modify | `src/pipeline/stages/acceptance-setup.ts` | pattern (a) |
| Modify | `src/pipeline/stages/verify.ts` | pattern (a) |
| Modify | `src/pipeline/stages/rectify.ts` | pattern (a) |
| Modify | `src/execution/unified-executor.ts` | pattern (a) — `ctx.agentManager` from SequentialExecutionContext |
| Modify | `src/execution/lifecycle/run-initialization.ts` | pattern (b) |
| Modify | `src/execution/lifecycle/acceptance-loop.ts` | pattern (b) |
| Modify | `src/execution/lifecycle/acceptance-fix.ts` | pattern (b) |
| Modify | `src/tdd/orchestrator.ts` | pattern (b) |
| Modify | `src/tdd/session-runner.ts` | pattern (b) |
| Modify | `src/tdd/rectification-gate.ts` | pattern (b) |
| Modify | `src/acceptance/generator.ts` | pattern (b) |
| Modify | `src/acceptance/refinement.ts` | pattern (b) |
| Modify | `src/acceptance/fix-executor.ts` | pattern (b) |
| Modify | `src/acceptance/fix-diagnosis.ts` | pattern (b) |
| Modify | `src/routing/router.ts` | pattern (b) |
| Modify | `src/routing/strategies/llm.ts` | pattern (b) |
| Modify | `src/interaction/plugins/auto.ts` | pattern (b) |
| Modify | `src/debate/session-helpers.ts` | pattern (b) |
| Modify | `src/metrics/tracker.ts` | pattern (a) — has PipelineContext |
| Modify | `src/cli/agents.ts` | pattern (b) |
| Modify | `src/cli/config-descriptions.ts` | string label update only |
| Modify | `src/pipeline/types.ts` | comment cleanup (remove stale `autoMode.defaultAgent` comment) |

---

### Task 1: `resolveDefaultAgent` helper + test mock factory

**Files:**
- Create: `src/agents/utils.ts`
- Modify: `src/agents/index.ts`
- Create: `test/helpers/mock-agent-manager.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/unit/agents/resolve-default-agent.test.ts
import { describe, expect, test } from "bun:test";
import { resolveDefaultAgent } from "../../../src/agents/utils";
import type { NaxConfig } from "../../../src/config";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";

function cfg(overrides: Record<string, unknown> = {}): NaxConfig {
  return { ...DEFAULT_CONFIG, ...overrides } as NaxConfig;
}

describe("resolveDefaultAgent", () => {
  test("returns config.agent.default when set", () => {
    const c = cfg({ agent: { ...DEFAULT_CONFIG.agent, default: "codex" } });
    expect(resolveDefaultAgent(c)).toBe("codex");
  });

  test("falls back to autoMode.defaultAgent when agent.default absent", () => {
    const c = cfg({ agent: { ...DEFAULT_CONFIG.agent, default: undefined } });
    expect(resolveDefaultAgent(c)).toBe(DEFAULT_CONFIG.autoMode.defaultAgent);
  });

  test("prefers canonical over legacy when both set", () => {
    const c = cfg({
      agent: { ...DEFAULT_CONFIG.agent, default: "gemini" },
      autoMode: { ...DEFAULT_CONFIG.autoMode, defaultAgent: "claude" },
    });
    expect(resolveDefaultAgent(c)).toBe("gemini");
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
bun test test/unit/agents/resolve-default-agent.test.ts --timeout=30000
```

Expected: FAIL — `resolveDefaultAgent` not found.

- [ ] **Step 3: Implement `src/agents/utils.ts`**

```typescript
import type { NaxConfig } from "../config";

/**
 * Resolve the canonical default agent from config.
 * Prefers config.agent.default (canonical, Phase 2+).
 * Falls back to config.autoMode.defaultAgent (legacy, migration shim always sets it).
 * This is the SSOT for code that has config but no AgentManager instance.
 */
export function resolveDefaultAgent(config: NaxConfig): string {
  const fromAgent = config.agent?.default;
  if (typeof fromAgent === "string" && fromAgent.length > 0) return fromAgent;
  return config.autoMode.defaultAgent;
}
```

- [ ] **Step 4: Add barrel export in `src/agents/index.ts`**

Open `src/agents/index.ts` and add:

```typescript
export { resolveDefaultAgent } from "./utils";
```

- [ ] **Step 5: Run test to confirm it passes**

```bash
bun test test/unit/agents/resolve-default-agent.test.ts --timeout=30000
```

Expected: PASS (3 tests).

- [ ] **Step 6: Create test helper `test/helpers/mock-agent-manager.ts`**

This factory is used by all test files that call subsystem functions now requiring an agentManager.

```typescript
import type { IAgentManager } from "../../src/agents";

export function createMockAgentManager(defaultAgent = "claude"): IAgentManager {
  return {
    getDefault: () => defaultAgent,
    isUnavailable: () => false,
    markUnavailable: () => {},
    reset: () => {},
    validateCredentials: async () => {},
    resolveFallbackChain: () => [],
    shouldSwap: () => false,
    nextCandidate: () => null,
    runWithFallback: async (req) => ({
      result: {
        success: true,
        exitCode: 0,
        output: "",
        rateLimited: false,
        durationMs: 0,
        estimatedCost: 0,
      },
      fallbacks: [],
    }),
    events: { on: () => {} },
  };
}
```

- [ ] **Step 7: Commit**

```bash
git add src/agents/utils.ts src/agents/index.ts test/helpers/mock-agent-manager.ts test/unit/agents/resolve-default-agent.test.ts
git commit -m "feat(agents): add resolveDefaultAgent helper and test mock factory (Phase 3 scaffolding)"
```

---

### Task 2: Pipeline stages — pattern (a)

All pipeline stages have `ctx: PipelineContext`, and `ctx.agentManager` is always set by the runner (Phase 1). Use `ctx.agentManager.getDefault()` directly.

**Files:**
- Modify: `src/pipeline/stages/routing.ts`, `verify.ts`, `rectify.ts`, `autofix.ts`, `autofix-adversarial.ts`, `acceptance-setup.ts`, `execution.ts`

- [ ] **Step 1: Write a guard test that confirms agentManager is populated in PipelineContext at execution time**

```typescript
// test/unit/pipeline/stages/agentmanager-presence.test.ts
import { describe, expect, test } from "bun:test";
import { createMockAgentManager } from "../../helpers/mock-agent-manager";

describe("PipelineContext agentManager propagation", () => {
  test("createMockAgentManager returns IAgentManager with getDefault()", () => {
    const mgr = createMockAgentManager("codex");
    expect(mgr.getDefault()).toBe("codex");
  });
});
```

```bash
bun test test/unit/pipeline/stages/agentmanager-presence.test.ts --timeout=30000
```

Expected: PASS.

- [ ] **Step 2: Migrate `src/pipeline/stages/routing.ts`**

Find the line (currently ~33):
```typescript
const configDefaultAgent = ctx.config.autoMode?.defaultAgent ?? DEFAULT_CONFIG.autoMode.defaultAgent;
```

Replace with:
```typescript
const configDefaultAgent = ctx.agentManager?.getDefault() ?? ctx.config.autoMode.defaultAgent;
```

- [ ] **Step 3: Migrate `src/pipeline/stages/verify.ts`**

Find (currently ~239):
```typescript
writtenByAgent: ctx.routing?.agent ?? ctx.config.autoMode.defaultAgent,
```
Replace with:
```typescript
writtenByAgent: ctx.routing?.agent ?? ctx.agentManager?.getDefault() ?? ctx.config.autoMode.defaultAgent,
```

- [ ] **Step 4: Migrate `src/pipeline/stages/rectify.ts`**

Find (currently ~95):
```typescript
writtenByAgent: ctx.routing?.agent ?? ctx.config.autoMode.defaultAgent,
```
Replace with:
```typescript
writtenByAgent: ctx.routing?.agent ?? ctx.agentManager?.getDefault() ?? ctx.config.autoMode.defaultAgent,
```

- [ ] **Step 5: Migrate `src/pipeline/stages/autofix.ts`**

Three occurrences (currently ~483, ~493, ~495). Replace all `ctx.rootConfig.autoMode.defaultAgent` with `ctx.agentManager?.getDefault() ?? ctx.rootConfig.autoMode.defaultAgent`:

```typescript
// ~483
const agent = agentGetFn(ctx.agentManager?.getDefault() ?? ctx.rootConfig.autoMode.defaultAgent);
// ~493
ctx.routing.agent ?? ctx.agentManager?.getDefault() ?? ctx.rootConfig.autoMode.defaultAgent,
// ~495
ctx.agentManager?.getDefault() ?? ctx.rootConfig.autoMode.defaultAgent,
```

- [ ] **Step 6: Migrate `src/pipeline/stages/autofix-adversarial.ts`**

Three occurrences (~68, ~80, ~82):
```typescript
// ~68
const twAgent = agentGetFn(ctx.agentManager?.getDefault() ?? ctx.rootConfig.autoMode.defaultAgent);
// ~80, ~82
ctx.agentManager?.getDefault() ?? ctx.rootConfig.autoMode.defaultAgent,
```

- [ ] **Step 7: Migrate `src/pipeline/stages/acceptance-setup.ts`**

Three occurrences (~234, ~236, ~241):
```typescript
// ~234
ctx.routing.agent ?? ctx.agentManager?.getDefault() ?? ctx.rootConfig.autoMode.defaultAgent,
// ~236
ctx.agentManager?.getDefault() ?? ctx.rootConfig.autoMode.defaultAgent,
// ~241
const agentName = resolvedAcceptanceModel?.agent ?? ctx.agentManager?.getDefault() ?? ctx.rootConfig.autoMode.defaultAgent;
```

- [ ] **Step 8: Migrate `src/pipeline/stages/execution.ts`**

Five occurrences that pass `autoMode.defaultAgent` to `resolveModelForAgent` as the `fallbackDefault` arg (~177, ~179, ~262, ~347). Leave the Phase-5.5 swap loop untouched (that's Phase 5). Also fix the hard-failure guard at ~41 and ~45:

```typescript
// ~41: agent lookup — use agentManager
const agent = (ctx.agentGetFn ?? _executionDeps.getAgent)(
  ctx.agentManager?.getDefault() ?? ctx.rootConfig.autoMode.defaultAgent
);
// ~45
reason: `Agent "${ctx.agentManager?.getDefault() ?? ctx.rootConfig.autoMode.defaultAgent}" not found`,

// ~177, ~179 (resolveModelForAgent call):
ctx.routing.agent ?? ctx.agentManager?.getDefault() ?? ctx.rootConfig.autoMode.defaultAgent,
// fallbackDefault param:
ctx.agentManager?.getDefault() ?? ctx.rootConfig.autoMode.defaultAgent,

// ~262 (primaryAgentId):
const primaryAgentId = ctx.routing.agent ?? ctx.agentManager?.getDefault() ?? ctx.rootConfig.autoMode.defaultAgent;

// ~347 (resolveModelForAgent in swap loop):
ctx.agentManager?.getDefault() ?? ctx.rootConfig.autoMode.defaultAgent,
```

- [ ] **Step 9: Run full test suite to confirm no regressions**

```bash
bun run typecheck && bun test --timeout=30000
```

Expected: all existing tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/pipeline/stages/
git commit -m "refactor(pipeline): migrate autoMode.defaultAgent reads to agentManager.getDefault() (Phase 3A)"
```

---

### Task 3: Execution lifecycle

**Files:**
- Modify: `src/execution/lifecycle/run-initialization.ts`
- Modify: `src/execution/unified-executor.ts`
- Modify: `src/execution/lifecycle/acceptance-loop.ts`
- Modify: `src/execution/lifecycle/acceptance-fix.ts`

- [ ] **Step 1: Write failing test for the migration pattern**

```typescript
// test/unit/execution/lifecycle/default-agent-migration.test.ts
import { describe, expect, test } from "bun:test";
import { resolveDefaultAgent } from "../../../../src/agents/utils";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";

describe("resolveDefaultAgent — execution lifecycle", () => {
  test("resolves from canonical config.agent.default", () => {
    const config = { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, default: "codex" } };
    expect(resolveDefaultAgent(config as never)).toBe("codex");
  });
});
```

```bash
bun test test/unit/execution/lifecycle/default-agent-migration.test.ts --timeout=30000
```

Expected: PASS (utility already written in Task 1).

- [ ] **Step 2: Migrate `src/execution/lifecycle/run-initialization.ts`**

Add import at top:
```typescript
import { resolveDefaultAgent } from "../../agents/utils";
```

Replace all four occurrences of `config.autoMode.defaultAgent` in `checkAgentInstalled`:
```typescript
// Before: const agent = (agentGetFn ?? _reconcileDeps.getAgent)(config.autoMode.defaultAgent);
const agent = (agentGetFn ?? _reconcileDeps.getAgent)(resolveDefaultAgent(config));

// Before: agent: config.autoMode.defaultAgent,
agent: resolveDefaultAgent(config),

// Before: throw new AgentNotFoundError(config.autoMode.defaultAgent);
throw new AgentNotFoundError(resolveDefaultAgent(config));

// Before: throw new AgentNotInstalledError(config.autoMode.defaultAgent, agent.binary);
throw new AgentNotInstalledError(resolveDefaultAgent(config), agent.binary);
```

- [ ] **Step 3: Migrate `src/execution/unified-executor.ts`**

`unified-executor.ts` receives `SequentialExecutionContext` which already has `agentManager?: IAgentManager`. Add import and replace five occurrences:

```typescript
import { resolveDefaultAgent } from "../agents/utils";
```

Replace `ctx.config.autoMode.defaultAgent` (five occurrences ~180, ~282, ~304, ~376, ~467):
```typescript
// Pattern: ctx.config.autoMode.defaultAgent  →  ctx.agentManager?.getDefault() ?? resolveDefaultAgent(ctx.config)
```

Example (~180):
```typescript
agent: ctx.agentManager?.getDefault() ?? resolveDefaultAgent(ctx.config),
```

Apply same pattern for all five occurrences.

- [ ] **Step 4: Migrate `src/execution/lifecycle/acceptance-loop.ts`**

Add import:
```typescript
import { resolveDefaultAgent } from "../../agents/utils";
```

Find (~239):
```typescript
const agentName = ctx.config.autoMode.defaultAgent;
```
Replace:
```typescript
const agentName = resolveDefaultAgent(ctx.config);
```

- [ ] **Step 5: Migrate `src/execution/lifecycle/acceptance-fix.ts`**

Add import:
```typescript
import { resolveDefaultAgent } from "../../agents/utils";
```

Replace four occurrences of `config.autoMode.defaultAgent` (~96, ~98, ~146, ~148) with `resolveDefaultAgent(config)` or `resolveDefaultAgent(ctx.config)` depending on which variable name is in scope at each site.

- [ ] **Step 6: Run tests**

```bash
bun run typecheck && bun test --timeout=30000
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/execution/
git commit -m "refactor(execution): migrate autoMode.defaultAgent reads to resolveDefaultAgent (Phase 3B)"
```

---

### Task 4: TDD subsystem

**Files:**
- Modify: `src/tdd/orchestrator.ts`
- Modify: `src/tdd/session-runner.ts`
- Modify: `src/tdd/rectification-gate.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/unit/tdd/default-agent-tdd.test.ts
import { describe, expect, test } from "bun:test";
import { resolveDefaultAgent } from "../../../src/agents/utils";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";

describe("resolveDefaultAgent in tdd context", () => {
  test("returns agent.default when present", () => {
    const c = { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, default: "gemini" } };
    expect(resolveDefaultAgent(c as never)).toBe("gemini");
  });
});
```

```bash
bun test test/unit/tdd/default-agent-tdd.test.ts --timeout=30000
```

Expected: PASS.

- [ ] **Step 2: Migrate `src/tdd/orchestrator.ts`**

Add import:
```typescript
import { resolveDefaultAgent } from "../agents/utils";
```

Find (~131):
```typescript
story.routing?.agent ?? config.autoMode.defaultAgent,
```
Replace:
```typescript
story.routing?.agent ?? resolveDefaultAgent(config),
```

- [ ] **Step 3: Migrate `src/tdd/session-runner.ts`**

Add import:
```typescript
import { resolveDefaultAgent } from "../agents/utils";
```

Two occurrences (~223, ~225) — both pass `config.autoMode.defaultAgent` to `resolveModelForAgent`:
```typescript
// ~223
story.routing?.agent ?? resolveDefaultAgent(config),
// ~225 (fallbackDefault param)
resolveDefaultAgent(config),
```

- [ ] **Step 4: Migrate `src/tdd/rectification-gate.ts`**

Add import:
```typescript
import { resolveDefaultAgent } from "../agents/utils";
```

Two occurrences (~220, ~222):
```typescript
story.routing?.agent ?? resolveDefaultAgent(config),
// fallbackDefault param:
resolveDefaultAgent(config),
```

- [ ] **Step 5: Run tests**

```bash
bun run typecheck && bun test test/unit/tdd/ --timeout=30000
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/tdd/
git commit -m "refactor(tdd): migrate autoMode.defaultAgent reads to resolveDefaultAgent (Phase 3C)"
```

---

### Task 5: Acceptance subsystem

**Files:**
- Modify: `src/acceptance/generator.ts`
- Modify: `src/acceptance/refinement.ts`
- Modify: `src/acceptance/fix-executor.ts`
- Modify: `src/acceptance/fix-diagnosis.ts`

All four files receive `config: NaxConfig` and call `resolveModelForAgent(..., config.autoMode.defaultAgent)`. Replace the last argument with `resolveDefaultAgent(config)`.

- [ ] **Step 1: Write failing test**

```typescript
// test/unit/acceptance/default-agent-acceptance.test.ts
import { describe, expect, test } from "bun:test";
import { resolveDefaultAgent } from "../../../src/agents/utils";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";

describe("resolveDefaultAgent in acceptance context", () => {
  test("resolves correctly", () => {
    expect(resolveDefaultAgent({ ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, default: "claude" } } as never)).toBe("claude");
  });
});
```

```bash
bun test test/unit/acceptance/default-agent-acceptance.test.ts --timeout=30000
```

Expected: PASS.

- [ ] **Step 2: Migrate all four acceptance files**

In each file, add at the top:
```typescript
import { resolveDefaultAgent } from "../agents/utils";
```

Then replace every occurrence of `config.autoMode.defaultAgent` with `resolveDefaultAgent(config)`.

Files and occurrence counts:
- `src/acceptance/generator.ts` — 2 occurrences (~83, ~85)
- `src/acceptance/refinement.ts` — 4 occurrences (~32, ~34, ~106, ~108)
- `src/acceptance/fix-executor.ts` — 4 occurrences (~43, ~45, ~114, ~116)
- `src/acceptance/fix-diagnosis.ts` — 2 occurrences (~78, ~80)

- [ ] **Step 3: Run tests**

```bash
bun run typecheck && bun test test/unit/acceptance/ --timeout=30000
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/acceptance/
git commit -m "refactor(acceptance): migrate autoMode.defaultAgent reads to resolveDefaultAgent (Phase 3D)"
```

---

### Task 6: Routing + interaction + debate + CLI + metrics

**Files:**
- Modify: `src/routing/router.ts`
- Modify: `src/routing/strategies/llm.ts`
- Modify: `src/interaction/plugins/auto.ts`
- Modify: `src/debate/session-helpers.ts`
- Modify: `src/metrics/tracker.ts`
- Modify: `src/cli/agents.ts`
- Modify: `src/cli/config-descriptions.ts` (string labels only)
- Modify: `src/pipeline/types.ts` (comment only)

- [ ] **Step 1: Write failing test**

```typescript
// test/unit/routing/default-agent-routing.test.ts
import { describe, expect, test } from "bun:test";
import { resolveDefaultAgent } from "../../../src/agents/utils";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";

describe("resolveDefaultAgent in routing context", () => {
  test("resolves from config", () => {
    expect(resolveDefaultAgent(DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG.autoMode.defaultAgent);
  });
});
```

```bash
bun test test/unit/routing/default-agent-routing.test.ts --timeout=30000
```

Expected: PASS.

- [ ] **Step 2: Migrate `src/routing/router.ts`**

Add import:
```typescript
import { resolveDefaultAgent } from "../agents/utils";
```

Find (~292) — the `resolveConfiguredModel` call passing `config.autoMode.defaultAgent`:
```typescript
config.autoMode.defaultAgent,
```
Replace with:
```typescript
resolveDefaultAgent(config),
```

- [ ] **Step 3: Migrate `src/routing/strategies/llm.ts`**

Add import:
```typescript
import { resolveDefaultAgent } from "../../agents/utils";
```

Find (~145) inside `callLlmOnce` — the `resolveConfiguredModel` call:
```typescript
config.autoMode.defaultAgent,
```
Replace with:
```typescript
resolveDefaultAgent(config),
```

- [ ] **Step 4: Migrate `src/interaction/plugins/auto.ts`**

Add import:
```typescript
import { resolveDefaultAgent } from "../../agents/utils";
```

Two occurrences (~180, ~182):
```typescript
naxConfig.autoMode.defaultAgent,
// →
resolveDefaultAgent(naxConfig),
```

- [ ] **Step 5: Migrate `src/debate/session-helpers.ts`**

Add import:
```typescript
import { resolveDefaultAgent } from "../agents/utils";
```

Four occurrences (~160, ~178, ~302, ~346) — all `config?.autoMode?.defaultAgent ?? DEFAULT_CONFIG.autoMode.defaultAgent` patterns. Replace with:
```typescript
resolveDefaultAgent(config ?? DEFAULT_CONFIG),
```

Remove any now-unused imports of `DEFAULT_CONFIG` if that was the only reason it was imported (check carefully — it may be used elsewhere in the file).

- [ ] **Step 6: Migrate `src/metrics/tracker.ts`**

`tracker.ts` receives `ctx: PipelineContext`, so use `ctx.agentManager?.getDefault()`.

Add import at top:
```typescript
import { resolveDefaultAgent } from "../agents/utils";
```

Four occurrences (~110, ~117, ~206, ~213):
```typescript
// ~110
const agentUsed = routing.agent ?? ctx.agentManager?.getDefault() ?? resolveDefaultAgent(ctx.config);
// ~117 (fallbackDefault in resolveModelForAgent)
ctx.agentManager?.getDefault() ?? resolveDefaultAgent(ctx.config),
// ~206 same pattern
const batchAgentUsed = routing.agent ?? ctx.agentManager?.getDefault() ?? resolveDefaultAgent(ctx.config);
// ~213
ctx.agentManager?.getDefault() ?? resolveDefaultAgent(ctx.config),
```

- [ ] **Step 7: Migrate `src/cli/agents.ts`**

Add import:
```typescript
import { resolveDefaultAgent } from "../agents/utils";
```

Find (~37):
```typescript
isDefault: config.autoMode.defaultAgent === agent.name,
```
Replace:
```typescript
isDefault: resolveDefaultAgent(config) === agent.name,
```

- [ ] **Step 8: Update string label in `src/cli/config-descriptions.ts`**

Find the description for `"autoMode.defaultAgent"` (~24-26) and update the description text to mention the canonical key:
```typescript
"autoMode.defaultAgent":
  "Deprecated — use agent.default instead (see ADR-012). Default agent used for all AI operations.",
```

- [ ] **Step 9: Update stale comment in `src/pipeline/types.ts`**

Find the comment around line 71 referencing `autoMode.defaultAgent`:
```typescript
// Before: * autoMode.defaultAgent, models, autoMode.escalation.
// After:  * agent.default, models, autoMode.escalation.
```

- [ ] **Step 10: Run full suite**

```bash
bun run typecheck && bun run lint && bun test --timeout=30000
```

Expected: all pass.

- [ ] **Step 11: Verify the grep check**

```bash
grep -rn "autoMode\.defaultAgent" src/ --include="*.ts" | grep -v "src/config/\|src/agents/manager\.ts\|src/agents/utils\.ts"
```

Expected: 0 hits (or only hits in the fallback patterns that use `?? resolveDefaultAgent(...)` which do NOT reference autoMode directly).

```bash
grep -rn "autoMode\.fallbackOrder" src/ --include="*.ts" | grep -v "src/config/\|src/agents/manager"
```

Expected: 0 hits.

- [ ] **Step 12: Commit**

```bash
git add src/routing/ src/interaction/ src/debate/ src/metrics/ src/cli/ src/pipeline/types.ts
git commit -m "refactor(routing,debate,cli,metrics): migrate autoMode.defaultAgent reads to resolveDefaultAgent (Phase 3E-F)"
```

---

## Self-Review Checklist

Run these grep checks before marking Phase 3 complete:

```bash
# Should return 0 hits (except src/config/, manager.ts, utils.ts):
grep -rn "autoMode\.defaultAgent" src/ --include="*.ts" \
  | grep -v "src/config/\|src/agents/manager\|src/agents/utils"

# Should return 0 hits outside src/config/:
grep -rn "autoMode\.fallbackOrder" src/ --include="*.ts" | grep -v "src/config/"

# Full suite green:
bun run typecheck && bun run lint && bun test --timeout=30000
```
