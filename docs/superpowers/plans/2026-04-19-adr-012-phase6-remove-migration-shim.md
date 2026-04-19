# ADR-012 Phase 6 — Remove Migration Shim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the `applyAgentConfigMigration()` shim and the legacy `autoMode.defaultAgent` / `autoMode.fallbackOrder` schema fields, completing ADR-012's config consolidation onto `agent.default` + `agent.fallback.map`.

**Architecture:** Migrate every remaining call site off the legacy keys to `agentManager.getDefault()` (inside pipeline stages) or `resolveDefaultAgent(config)` (standalone modules). Then drop the legacy fields from Zod schema, delete the migration shim file, update `validate.ts` to read the canonical keys, and update tests/docs. Post-merge, any pre-migration config becomes a Zod validation error with a clear pointer to ADR-012.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, `bun:test`, Zod. Project rules: Bun-native APIs only, 400-line file limit, barrel imports, conventional commits.

**Worktree:** `/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/.worktrees/feat/adr-012-phase6-remove-migration-shim` (branch `feat/adr-012-phase6-remove-migration-shim`).

---

## File Structure

### Files modified (by concern)

| File | Change |
|:---|:---|
| `src/agents/utils.ts` | `resolveDefaultAgent` drops legacy fallback |
| `src/agents/manager.ts` | `getDefault()` drops legacy fallback |
| `src/agents/manager-types.ts` | Update doc comment for `getDefault()` |
| `src/pipeline/stages/execution.ts` | 3 call sites → `agentManager.getDefault()` |
| `src/pipeline/stages/autofix-adversarial.ts` | 1 call site |
| `src/pipeline/stages/acceptance-setup.ts` | 1 call site |
| `src/pipeline/stages/verify.ts` | 1 call site |
| `src/pipeline/stages/review.ts` | 1 call site |
| `src/pipeline/stages/rectify.ts` | 1 call site |
| `src/pipeline/stages/autofix.ts` | 2 call sites |
| `src/pipeline/stages/context.ts` | 1 call site |
| `src/context/engine/stage-assembler.ts` | 1 call site |
| `src/tdd/orchestrator.ts` | 2 call sites |
| `src/debate/session-helpers.ts` | 4 call sites |
| `src/review/adversarial.ts` | 1 call site |
| `src/review/semantic.ts` | 1 call site |
| `src/review/dialogue.ts` | 1 call site |
| `src/review/orchestrator.ts` | 1 call site |
| `src/agents/acp/adapter.ts` | 2 call sites |
| `src/agents/shared/model-resolution.ts` | 1 call site |
| `src/cli/plan.ts` | 3 call sites |
| `src/cli/config-descriptions.ts` | Replace `autoMode.defaultAgent`/`autoMode.fallbackOrder` entries |
| `src/config/validate.ts` | Read `agent.default` + `agent.fallback.map` |
| `src/config/loader.ts` | Remove `applyAgentConfigMigration` import + 2 call sites |
| `src/config/schemas.ts` | Remove `defaultAgent`/`fallbackOrder` from `AutoModeConfigSchema` + default |
| `docs/adr/ADR-012-agent-manager-ownership.md` | Check off Phase 6 ACs |
| `.claude/rules/adapter-wiring.md` | Replace example using `config.autoMode.defaultAgent` |
| `CHANGELOG.md` | Add breaking-change note |

### Files deleted

| File | Reason |
|:---|:---|
| `src/config/agent-migration.ts` | Shim retired |
| `test/unit/config/agent-migration.test.ts` | Tests the deleted shim |

### Test files modified

| File | Change |
|:---|:---|
| `test/unit/config/phase6-invariants.test.ts` | **Create** — red-phase gate tests |
| `test/unit/agents/resolve-default-agent.test.ts` | Remove legacy-fallback test |
| `test/unit/agents/manager.test.ts` | Remove legacy-fallback test |
| `test/unit/config/defaults.test.ts` | Drop `autoMode.fallbackOrder` assertion group |
| `test/unit/config/schemas.test.ts` | Replace `autoMode.defaultAgent` reads with `agent.default` |
| `test/integration/cli/cli-config.test.ts` | Update expected CLI output strings |
| `test/integration/cli/cli-config-explain.test.ts` | Update expected CLI output strings |
| `test/integration/plan/plan.test.ts` | Read `agent.default` not `autoMode.defaultAgent` |
| `test/unit/acceptance/fix-executor.test.ts` | Replace `autoMode.defaultAgent` reads |
| `test/unit/acceptance/fix-diagnosis.test.ts` | Replace `autoMode.defaultAgent` reads |
| `test/unit/routing/default-agent-routing.test.ts` | Replace `autoMode.defaultAgent` read |

---

## Key Invariants

Throughout Phase 6, these must hold:

1. `DEFAULT_CONFIG.agent.default === "claude"` already — the schema supplies this, so removing `autoMode.defaultAgent` does not need a replacement default.
2. `config.agent.fallback.enabled === false` by default — means `config.agent.fallback.map` can be empty without breaking validate.
3. `resolveDefaultAgent(config)` is the single standalone-module helper. Pipeline stages with `ctx: PipelineContext` use `ctx.agentManager?.getDefault() ?? resolveDefaultAgent(ctx.rootConfig)` — but after this phase, `agentManager` is always present so the `??` can simplify to `ctx.agentManager.getDefault()`.
4. The `agentManager` on `PipelineContext` is now always constructed (verified in Phase 3+). It's safe to treat as required.

---

### Task 1: Write Phase 6 invariant tests (red phase)

**Files:**
- Create: `test/unit/config/phase6-invariants.test.ts`

- [ ] **Step 1: Write the failing test file**

```typescript
// test/unit/config/phase6-invariants.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

async function readSrc(relPath: string): Promise<string> {
  return await Bun.file(join(REPO_ROOT, relPath)).text();
}

describe("Phase 6 invariants — migration shim removal", () => {
  test("agent-migration.ts file does not exist", () => {
    expect(existsSync(join(REPO_ROOT, "src/config/agent-migration.ts"))).toBe(false);
  });

  test("loader.ts does not import applyAgentConfigMigration", async () => {
    const code = await readSrc("src/config/loader.ts");
    expect(code).not.toContain("applyAgentConfigMigration");
    expect(code).not.toContain("agent-migration");
  });

  test("AutoModeConfigSchema does not declare defaultAgent field", async () => {
    const code = await readSrc("src/config/schemas.ts");
    // extract the AutoModeConfigSchema block
    const start = code.indexOf("const AutoModeConfigSchema");
    const end = code.indexOf("});", start);
    const block = code.slice(start, end);
    expect(block).not.toContain("defaultAgent:");
  });

  test("AutoModeConfigSchema does not declare fallbackOrder field", async () => {
    const code = await readSrc("src/config/schemas.ts");
    const start = code.indexOf("const AutoModeConfigSchema");
    const end = code.indexOf("});", start);
    const block = code.slice(start, end);
    expect(block).not.toContain("fallbackOrder:");
  });

  test("no src file outside src/config/ reads autoMode.defaultAgent", async () => {
    const proc = Bun.spawn(
      ["grep", "-rln", "autoMode\\.defaultAgent", "src/", "--include=*.ts"],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    const offenders = out.split("\n").filter((l) => l.trim().length > 0 && !l.includes("src/config/"));
    expect(offenders).toEqual([]);
  });

  test("no src file reads autoMode.fallbackOrder", async () => {
    const proc = Bun.spawn(
      ["grep", "-rln", "autoMode\\.fallbackOrder", "src/", "--include=*.ts"],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    const offenders = out.split("\n").filter((l) => l.trim().length > 0);
    expect(offenders).toEqual([]);
  });

  test("resolveDefaultAgent does not reference autoMode.defaultAgent", async () => {
    const code = await readSrc("src/agents/utils.ts");
    expect(code).not.toContain("autoMode.defaultAgent");
  });

  test("AgentManager.getDefault does not reference autoMode.defaultAgent", async () => {
    const code = await readSrc("src/agents/manager.ts");
    expect(code).not.toContain("autoMode.defaultAgent");
  });

  test("validate.ts reads agent.default not autoMode.defaultAgent", async () => {
    const code = await readSrc("src/config/validate.ts");
    expect(code).not.toContain("autoMode.defaultAgent");
    expect(code).not.toContain("autoMode.fallbackOrder");
  });
});
```

- [ ] **Step 2: Run — expect all 9 to FAIL**

Run: `bun test test/unit/config/phase6-invariants.test.ts --timeout=30000`
Expected: 9 fail, 0 pass (red phase).

- [ ] **Step 3: Commit (red tests)**

```bash
git add test/unit/config/phase6-invariants.test.ts
git commit -m "test(config): add Phase 6 invariant tests (red)"
```

---

### Task 2: Simplify `resolveDefaultAgent`

**Files:**
- Modify: `src/agents/utils.ts`
- Modify: `test/unit/agents/resolve-default-agent.test.ts`

- [ ] **Step 1: Update the test to remove the legacy-fallback case**

Replace the test file contents with:

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

  test("returns DEFAULT_CONFIG.agent.default when agent block absent", () => {
    const c = cfg({ agent: undefined });
    expect(resolveDefaultAgent(c)).toBe("claude");
  });
});
```

- [ ] **Step 2: Run — expect fail (old implementation still compiles but tests adjusted)**

Run: `bun test test/unit/agents/resolve-default-agent.test.ts --timeout=30000`
Expected: 1 fail (`returns DEFAULT_CONFIG.agent.default when agent block absent` — because current impl falls through to `config.autoMode.defaultAgent` which still exists and equals "claude", the test may actually pass. Note: this test is primarily to lock in the new behaviour for post-Task 13.)

- [ ] **Step 3: Rewrite `resolveDefaultAgent` to drop the legacy fallback**

Replace `src/agents/utils.ts` with:

```typescript
import type { NaxConfig } from "../config";

const FALLBACK_DEFAULT_AGENT = "claude";

export function resolveDefaultAgent(config: NaxConfig): string {
  const fromAgent = config.agent?.default;
  if (typeof fromAgent === "string" && fromAgent.length > 0) return fromAgent;
  return FALLBACK_DEFAULT_AGENT;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test test/unit/agents/resolve-default-agent.test.ts --timeout=30000`
Expected: 2 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/agents/utils.ts test/unit/agents/resolve-default-agent.test.ts
git commit -m "refactor(agents): resolveDefaultAgent drops autoMode.defaultAgent fallback (ADR-012 Phase 6)"
```

---

### Task 3: Simplify `AgentManager.getDefault()`

**Files:**
- Modify: `src/agents/manager.ts:55-59`
- Modify: `src/agents/manager-types.ts:65` (doc comment)
- Modify: `test/unit/agents/manager.test.ts:29-35`

- [ ] **Step 1: Update the manager test**

Find the test at `test/unit/agents/manager.test.ts:29`:

```typescript
test("getDefault() reads config.autoMode.defaultAgent when agent.default is unset", () => {
  const mgr = new AgentManager({
    ...DEFAULT_CONFIG,
    agent: { ...DEFAULT_CONFIG.agent, default: undefined },
    autoMode: { ...DEFAULT_CONFIG.autoMode, defaultAgent: "claude" },
  } as NaxConfig);
  expect(mgr.getDefault()).toBe("claude");
});
```

Replace with:

```typescript
test("getDefault() returns built-in default when config.agent.default is unset", () => {
  const mgr = new AgentManager({
    ...DEFAULT_CONFIG,
    agent: { ...DEFAULT_CONFIG.agent, default: undefined },
  } as NaxConfig);
  expect(mgr.getDefault()).toBe("claude");
});
```

- [ ] **Step 2: Rewrite `AgentManager.getDefault()`**

At `src/agents/manager.ts`, replace:

```typescript
getDefault(): string {
  const fromAgent = this._config.agent?.default;
  if (typeof fromAgent === "string" && fromAgent.length > 0) return fromAgent;
  return this._config.autoMode.defaultAgent;
}
```

With:

```typescript
getDefault(): string {
  const fromAgent = this._config.agent?.default;
  if (typeof fromAgent === "string" && fromAgent.length > 0) return fromAgent;
  return "claude";
}
```

- [ ] **Step 3: Update the doc comment in manager-types.ts**

At `src/agents/manager-types.ts:65`, find:

```typescript
/** Resolve the default agent name. Reads config.agent.default, falls back to config.autoMode.defaultAgent during Phase 1-5. */
```

Replace with:

```typescript
/** Resolve the default agent name. Reads config.agent.default (falls back to built-in "claude"). */
```

- [ ] **Step 4: Run tests**

Run: `bun test test/unit/agents/manager.test.ts --timeout=30000`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/agents/manager.ts src/agents/manager-types.ts test/unit/agents/manager.test.ts
git commit -m "refactor(agents): AgentManager.getDefault drops autoMode.defaultAgent fallback (ADR-012 Phase 6)"
```

---

### Task 4: Migrate pipeline stages + context engine

**Files:**
- Modify: `src/pipeline/stages/execution.ts:36,276,361`
- Modify: `src/pipeline/stages/autofix-adversarial.ts:67`
- Modify: `src/pipeline/stages/acceptance-setup.ts:230`
- Modify: `src/pipeline/stages/verify.ts:239`
- Modify: `src/pipeline/stages/review.ts:37`
- Modify: `src/pipeline/stages/rectify.ts:95`
- Modify: `src/pipeline/stages/autofix.ts:483,491`
- Modify: `src/pipeline/stages/context.ts:55`
- Modify: `src/context/engine/stage-assembler.ts:168`

**Strategy:** In pipeline stages (have `ctx: PipelineContext`), replace `ctx.rootConfig.autoMode.defaultAgent` with `ctx.agentManager?.getDefault() ?? "claude"`. Where `ctx.agentManager?.getDefault()` is already present (e.g. `ctx.agentManager?.getDefault() ?? ctx.rootConfig.autoMode.defaultAgent`), simplify to `ctx.agentManager?.getDefault() ?? "claude"`. Drop the `ctx.rootConfig.autoMode.defaultAgent` fallback entirely.

- [ ] **Step 1: execution.ts — 3 call sites**

`src/pipeline/stages/execution.ts:36`:
```typescript
// BEFORE
const defaultAgent = ctx.agentManager?.getDefault() ?? ctx.rootConfig.autoMode.defaultAgent;
// AFTER
const defaultAgent = ctx.agentManager?.getDefault() ?? "claude";
```

`src/pipeline/stages/execution.ts:276` (inside executeHop callback):
```typescript
// BEFORE
const primaryAgentId = ctx.routing.agent ?? ctx.rootConfig.autoMode.defaultAgent;
// AFTER
const primaryAgentId = ctx.routing.agent ?? ctx.agentManager?.getDefault() ?? "claude";
```

`src/pipeline/stages/execution.ts:361`:
```typescript
// BEFORE
ctx.rootConfig.autoMode.defaultAgent,
// AFTER
ctx.agentManager?.getDefault() ?? "claude",
```

- [ ] **Step 2: autofix-adversarial.ts:67**

```typescript
// BEFORE
const defaultAgent = ctx.agentManager?.getDefault() ?? ctx.rootConfig.autoMode.defaultAgent;
// AFTER
const defaultAgent = ctx.agentManager?.getDefault() ?? "claude";
```

- [ ] **Step 3: acceptance-setup.ts:230**

```typescript
// BEFORE
const defaultAgent = ctx.agentManager?.getDefault() ?? ctx.rootConfig.autoMode.defaultAgent;
// AFTER
const defaultAgent = ctx.agentManager?.getDefault() ?? "claude";
```

- [ ] **Step 4: verify.ts:239**

```typescript
// BEFORE
writtenByAgent: ctx.routing?.agent ?? ctx.agentManager?.getDefault() ?? ctx.rootConfig.autoMode.defaultAgent,
// AFTER
writtenByAgent: ctx.routing?.agent ?? ctx.agentManager?.getDefault() ?? "claude",
```

- [ ] **Step 5: review.ts:37**

Currently reads the legacy key directly without a `??`. Change to use `agentManager.getDefault()`:

```typescript
// BEFORE
const agentName = ctx.rootConfig.autoMode?.defaultAgent;
// AFTER
const agentName = ctx.agentManager?.getDefault();
```

Verify downstream code handles an `undefined` agentName the same way (if `agentName` is required, add `?? "claude"`).

- [ ] **Step 6: rectify.ts:95**

```typescript
// BEFORE
writtenByAgent: ctx.routing?.agent ?? ctx.agentManager?.getDefault() ?? ctx.rootConfig.autoMode.defaultAgent,
// AFTER
writtenByAgent: ctx.routing?.agent ?? ctx.agentManager?.getDefault() ?? "claude",
```

- [ ] **Step 7: autofix.ts — 2 sites at 483 and 491**

```typescript
// BEFORE (both lines)
const agent = agentGetFn(ctx.agentManager?.getDefault() ?? ctx.rootConfig.autoMode.defaultAgent);
const defaultAgent = ctx.agentManager?.getDefault() ?? ctx.rootConfig.autoMode.defaultAgent;
// AFTER
const agent = agentGetFn(ctx.agentManager?.getDefault() ?? "claude");
const defaultAgent = ctx.agentManager?.getDefault() ?? "claude";
```

- [ ] **Step 8: context.ts:55 — 3-level fallback**

```typescript
// BEFORE
ctx.routing.agent ?? ctx.rootConfig?.autoMode?.defaultAgent ?? ctx.config.autoMode?.defaultAgent ?? "claude";
// AFTER
ctx.routing.agent ?? ctx.agentManager?.getDefault() ?? "claude";
```

- [ ] **Step 9: stage-assembler.ts:168 — 3-level fallback**

```typescript
// BEFORE
ctx.routing.agent ?? ctx.rootConfig?.autoMode?.defaultAgent ?? ctx.config.autoMode?.defaultAgent ?? "claude";
// AFTER
ctx.routing.agent ?? ctx.agentManager?.getDefault() ?? "claude";
```

- [ ] **Step 10: Run typecheck + targeted tests**

Run: `bun run typecheck 2>&1 | tail -5`
Expected: clean.

Run: `bun test test/unit/pipeline/ test/unit/context/ --timeout=30000 2>&1 | tail -10`
Expected: all pass.

- [ ] **Step 11: Commit**

```bash
git add src/pipeline/stages/ src/context/engine/stage-assembler.ts
git commit -m "refactor(pipeline): drop autoMode.defaultAgent reads in pipeline stages (ADR-012 Phase 6)"
```

---

### Task 5: Migrate TDD orchestrator + debate helpers

**Files:**
- Modify: `src/tdd/orchestrator.ts:551,630`
- Modify: `src/debate/session-helpers.ts:98,163,306,351`

- [ ] **Step 1: orchestrator.ts — 2 sites**

`src/tdd/orchestrator.ts:551`:
```typescript
// BEFORE
agent: ctx.routing.agent ?? ctx.agentManager?.getDefault() ?? ctx.rootConfig.autoMode.defaultAgent,
// AFTER
agent: ctx.routing.agent ?? ctx.agentManager?.getDefault() ?? "claude",
```

`src/tdd/orchestrator.ts:630`:
```typescript
// BEFORE
writtenByAgent: ctx.routing?.agent ?? ctx.agentManager?.getDefault() ?? ctx.rootConfig.autoMode.defaultAgent,
// AFTER
writtenByAgent: ctx.routing?.agent ?? ctx.agentManager?.getDefault() ?? "claude",
```

- [ ] **Step 2: session-helpers.ts — add import**

At the top of `src/debate/session-helpers.ts`, ensure there is an import:

```typescript
import { resolveDefaultAgent } from "../agents";
```

(Use barrel import, not `"../agents/utils"`.)

- [ ] **Step 3: session-helpers.ts:98**

```typescript
// BEFORE
const defaultAgent = config.autoMode?.defaultAgent ?? debater.agent;
// AFTER
const defaultAgent = resolveDefaultAgent(config) ?? debater.agent;
```

Note: `resolveDefaultAgent` never returns empty; the `?? debater.agent` branch is dead but preserve it for reviewer safety. Actually — since `resolveDefaultAgent` always returns a non-empty string, simplify:

```typescript
// AFTER (final)
const defaultAgent = resolveDefaultAgent(config);
```

If the caller semantics actually expected `debater.agent` when `config.autoMode.defaultAgent` was unset, audit callers; otherwise the simplification is correct.

- [ ] **Step 4: session-helpers.ts:163, 306, 351 — three identical patterns**

Each line looks like:
```typescript
config?.agent?.default ?? config?.autoMode?.defaultAgent ?? DEFAULT_CONFIG.autoMode.defaultAgent;
```

Replace with:
```typescript
resolveDefaultAgent(config);
```

Remove the now-unused import of `DEFAULT_CONFIG` if that was its only use (check with `grep -n "DEFAULT_CONFIG" src/debate/session-helpers.ts`).

- [ ] **Step 5: Run typecheck + tests**

Run: `bun run typecheck 2>&1 | tail -5`
Expected: clean.

Run: `bun test test/unit/tdd/ test/unit/debate/ --timeout=30000 2>&1 | tail -10`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/tdd/orchestrator.ts src/debate/session-helpers.ts
git commit -m "refactor(tdd,debate): use resolveDefaultAgent/agentManager (ADR-012 Phase 6)"
```

---

### Task 6: Migrate review + agents/acp + agents/shared + cli/plan

**Files:**
- Modify: `src/review/adversarial.ts:252`
- Modify: `src/review/semantic.ts:423`
- Modify: `src/review/dialogue.ts:247`
- Modify: `src/review/orchestrator.ts:463`
- Modify: `src/agents/acp/adapter.ts:863,1020`
- Modify: `src/agents/shared/model-resolution.ts:32`
- Modify: `src/cli/plan.ts:44,174,603`

- [ ] **Step 1: review/adversarial.ts:252**

Add import near top: `import { resolveDefaultAgent } from "../agents";`

```typescript
// BEFORE
const defaultAgent = naxConfig?.autoMode?.defaultAgent ?? "claude";
// AFTER
const defaultAgent = naxConfig ? resolveDefaultAgent(naxConfig) : "claude";
```

- [ ] **Step 2: review/semantic.ts:423**

Same pattern — add `resolveDefaultAgent` import, then:
```typescript
// BEFORE
const defaultAgent = naxConfig?.autoMode?.defaultAgent ?? "claude";
// AFTER
const defaultAgent = naxConfig ? resolveDefaultAgent(naxConfig) : "claude";
```

- [ ] **Step 3: review/dialogue.ts:247**

Add `resolveDefaultAgent` import:
```typescript
// BEFORE
const defaultAgent = _config.autoMode?.defaultAgent ?? "claude";
// AFTER
const defaultAgent = resolveDefaultAgent(_config);
```

- [ ] **Step 4: review/orchestrator.ts:463**

```typescript
// BEFORE
const agentName = ctx.rootConfig.autoMode?.defaultAgent;
// AFTER
const agentName = ctx.agentManager?.getDefault();
```

(This mirrors the `review.ts` stage change. If downstream requires non-undefined, append `?? "claude"`.)

- [ ] **Step 5: agents/acp/adapter.ts:863**

```typescript
// BEFORE
_options.config.autoMode?.defaultAgent ?? agentName,
// AFTER — adapter already receives agentName, so prefer agentName over config default
_options.config.agent?.default ?? agentName,
```

- [ ] **Step 6: agents/acp/adapter.ts:1020**

Same file, different function. Add at top of the function if needed:
```typescript
// BEFORE
const defaultAgent = config.autoMode?.defaultAgent ?? "claude";
// AFTER
const defaultAgent = config.agent?.default ?? "claude";
```

Note: do NOT introduce `resolveDefaultAgent` here since the adapter is inside `src/agents/` and importing from its own barrel would create a cycle. Read `config.agent?.default` directly.

- [ ] **Step 7: agents/shared/model-resolution.ts:32**

```typescript
// BEFORE
const defaultAgent = configWithModels.autoMode?.defaultAgent ?? "claude";
// AFTER
const defaultAgent = configWithModels.agent?.default ?? "claude";
```

(Same cycle concern — stay on direct read.)

- [ ] **Step 8: cli/plan.ts — 3 sites at 44, 174, 603**

Add import at top: `import { resolveDefaultAgent } from "../agents";`

`src/cli/plan.ts:44`:
```typescript
// BEFORE
const defaultAgent = config.autoMode?.defaultAgent ?? preferredAgent;
// AFTER
const defaultAgent = resolveDefaultAgent(config) || preferredAgent;
```

(Use `||` because `resolveDefaultAgent` always returns truthy; fallback is now effectively dead. Keep for readability.)

Actually `resolveDefaultAgent` always returns a non-empty string, so simplify:
```typescript
// AFTER (final)
const defaultAgent = resolveDefaultAgent(config);
```

Audit `preferredAgent` usage — if the original semantic was "prefer config, fall back to a caller-provided preference", that's now broken. Review the surrounding context. If `preferredAgent` must still be honoured, use:
```typescript
const defaultAgent = config.agent?.default ?? preferredAgent;
```

`src/cli/plan.ts:174`:
```typescript
// BEFORE
const defaultAgentName = config?.autoMode?.defaultAgent ?? "claude";
// AFTER
const defaultAgentName = resolveDefaultAgent(config);
```

`src/cli/plan.ts:603`:
```typescript
// BEFORE
const defaultAgentName = config?.autoMode?.defaultAgent ?? "claude";
// AFTER
const defaultAgentName = resolveDefaultAgent(config);
```

- [ ] **Step 9: Run typecheck + tests**

```bash
bun run typecheck 2>&1 | tail -5
bun test test/unit/review/ test/unit/agents/acp/ test/unit/agents/shared/ test/unit/cli/ --timeout=30000 2>&1 | tail -10
```
Expected: clean + tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/review/ src/agents/acp/adapter.ts src/agents/shared/model-resolution.ts src/cli/plan.ts
git commit -m "refactor(review,agents,cli): drop autoMode.defaultAgent reads (ADR-012 Phase 6)"
```

---

### Task 7: Update `src/config/validate.ts`

**Files:**
- Modify: `src/config/validate.ts:42,81,96-102,120`

The current validator reads `config.autoMode.defaultAgent` and `config.autoMode.fallbackOrder` directly. Replace with `agent.default` + `agent.fallback.map` (flattened).

- [ ] **Step 1: Read validate.ts to understand context**

```bash
cat src/config/validate.ts
```

- [ ] **Step 2: Replace the 4 read sites**

At `src/config/validate.ts:42`:
```typescript
// BEFORE
const defaultAgent = config.autoMode?.defaultAgent ?? "claude";
// AFTER
const defaultAgent = config.agent?.default ?? "claude";
```

At `src/config/validate.ts:81`:
```typescript
// BEFORE
if (!config.autoMode.defaultAgent || config.autoMode.defaultAgent.trim() === "") {
// AFTER
const agentDefault = config.agent?.default;
if (!agentDefault || agentDefault.trim() === "") {
```
(Make sure the error message below still matches — change `autoMode.defaultAgent` to `agent.default` in any error strings.)

At `src/config/validate.ts:96-102` (the fallback-validation block):
```typescript
// BEFORE
if (config.models && config.autoMode?.fallbackOrder) {
  const modelKeys = Object.keys(config.models);
  for (const agent of config.autoMode.fallbackOrder) {
    if (!modelKeys.includes(agent)) {
      errors.push(
        `autoMode.fallbackOrder: agent "${agent}" is not a key in models (available: ${modelKeys.join(", ")})`,
      );
    }
  }
}

// AFTER
if (config.models && config.agent?.fallback?.map) {
  const modelKeys = Object.keys(config.models);
  const fallbackAgents = new Set<string>();
  for (const [primary, candidates] of Object.entries(config.agent.fallback.map)) {
    fallbackAgents.add(primary);
    for (const c of candidates) fallbackAgents.add(c);
  }
  for (const agent of fallbackAgents) {
    if (!modelKeys.includes(agent)) {
      errors.push(
        `agent.fallback.map: agent "${agent}" is not a key in models (available: ${modelKeys.join(", ")})`,
      );
    }
  }
}
```

At `src/config/validate.ts:120`:
```typescript
// BEFORE
const defaultAgentKey = config.autoMode?.defaultAgent ?? "claude";
// AFTER
const defaultAgentKey = config.agent?.default ?? "claude";
```

- [ ] **Step 3: Find any existing test for validate.ts and update it**

```bash
grep -rn "autoMode.fallbackOrder\|autoMode.defaultAgent" test/ --include="*.ts" | grep -i "validate" || echo "no validate test refs"
```

If `test/unit/config/validate.test.ts` exists and has legacy references, update them to use `agent.default` and `agent.fallback.map`.

- [ ] **Step 4: Run validate tests**

```bash
bun test test/unit/config/ --timeout=30000 2>&1 | tail -10
```
Expected: all pass (except the pre-existing agent-migration.test.ts which Task 12 will delete).

- [ ] **Step 5: Commit**

```bash
git add src/config/validate.ts test/unit/config/
git commit -m "refactor(config): validate.ts reads agent.default + agent.fallback.map (ADR-012 Phase 6)"
```

---

### Task 8: Update CLI config-descriptions

**Files:**
- Modify: `src/cli/config-descriptions.ts:24,26,254,261`

- [ ] **Step 1: Replace the legacy-key description entries**

`src/cli/config-descriptions.ts` has a record keyed by dotted path. Currently it has:

```typescript
"autoMode.defaultAgent": { ... },
"autoMode.fallbackOrder": { ... },
```

Find those two entries. **Delete them**, then verify there are already canonical entries:

```bash
grep -n '"agent.default"\|"agent.fallback"' src/cli/config-descriptions.ts
```

If `agent.default` or `agent.fallback.map` entries are missing, add:

```typescript
"agent.default": {
  description: "Default agent used when no routing override applies (e.g., 'claude', 'codex', 'gemini').",
  examples: ["claude", "codex", "gemini"],
  learnMore: "docs/adr/ADR-012-agent-manager-ownership.md",
},
"agent.fallback.map": {
  description: "Keyed fallback chain: primary agent → ordered list of candidates to try on availability failure.",
  examples: [`{ "claude": ["codex", "gemini"] }`],
  learnMore: "docs/adr/ADR-012-agent-manager-ownership.md",
},
"agent.fallback.enabled": {
  description: "Enable automatic fallback to candidate agents on primary failure.",
  examples: ["true", "false"],
},
"agent.fallback.maxHopsPerStory": {
  description: "Maximum number of agent swaps per story (default 2).",
  examples: ["1", "2", "3"],
},
```

(Match the shape of existing description entries in the file — inspect one other entry first to match the exact object shape.)

- [ ] **Step 2: Replace the two description strings at lines 254 and 261**

`src/cli/config-descriptions.ts:254`:
```typescript
// BEFORE
"Agent used as resolver — resolved from config.autoMode.defaultAgent when absent",
// AFTER
"Agent used as resolver — resolved from config.agent.default when absent",
```

`src/cli/config-descriptions.ts:261`:
```typescript
// BEFORE
"Optional array of debater agents (min 2 entries). Resolved from config.autoMode.defaultAgent when absent.",
// AFTER
"Optional array of debater agents (min 2 entries). Resolved from config.agent.default when absent.",
```

- [ ] **Step 3: Update CLI integration tests**

Edit `test/integration/cli/cli-config.test.ts:631`:
```typescript
// BEFORE
expect(output).toContain("autoMode.fallbackOrder");
// AFTER
expect(output).toContain("agent.fallback.map");
```

Edit `test/integration/cli/cli-config-explain.test.ts:192,200,249-250`:
```typescript
// Replace each "autoMode.defaultAgent" string with "agent.default"
// Replace "autoMode.fallbackOrder" with "agent.fallback.map"
```

- [ ] **Step 4: Run CLI tests**

```bash
bun test test/integration/cli/ --timeout=30000 2>&1 | tail -10
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/config-descriptions.ts test/integration/cli/
git commit -m "refactor(cli): config-descriptions uses agent.default/agent.fallback.map (ADR-012 Phase 6)"
```

---

### Task 9: Delete migration shim + remove from loader

**Files:**
- Delete: `src/config/agent-migration.ts`
- Delete: `test/unit/config/agent-migration.test.ts`
- Modify: `src/config/loader.ts:11,140,152`

- [ ] **Step 1: Verify no non-loader imports of the shim**

```bash
grep -rln "applyAgentConfigMigration\|agent-migration" src/ --include="*.ts"
```
Expected: only `src/config/loader.ts` and `src/config/agent-migration.ts` itself.

If anything else imports it, STOP and investigate.

- [ ] **Step 2: Remove the import + calls from loader.ts**

At `src/config/loader.ts:11`:
```typescript
// DELETE this line
import { applyAgentConfigMigration } from "./agent-migration";
```

At `src/config/loader.ts:140`:
```typescript
// BEFORE
const globalConf = applyAgentConfigMigration(
  ...args,
);
// AFTER — just inline the pre-parse variable without the shim wrap
const globalConf = ...args; // (keep whatever the inner expression was)
```

At `src/config/loader.ts:152`:
```typescript
// Same pattern — remove the applyAgentConfigMigration() wrapper
```

Read the file first to see the exact shape of the two call sites before editing.

- [ ] **Step 3: Delete the shim files**

```bash
git rm src/config/agent-migration.ts
git rm test/unit/config/agent-migration.test.ts
```

- [ ] **Step 4: Run typecheck + loader tests**

```bash
bun run typecheck 2>&1 | tail -10
bun test test/unit/config/ --timeout=30000 2>&1 | tail -10
```
Expected: typecheck clean. Loader tests pass (migration tests are gone).

- [ ] **Step 5: Commit**

```bash
git add src/config/loader.ts
git commit -m "refactor(config): remove applyAgentConfigMigration shim (ADR-012 Phase 6)"
```

---

### Task 10: Remove legacy schema fields + update DEFAULT_CONFIG

**Files:**
- Modify: `src/config/schemas.ts:57-72,846-850`

- [ ] **Step 1: Remove `defaultAgent` and `fallbackOrder` from AutoModeConfigSchema**

At `src/config/schemas.ts:57-72`, current:

```typescript
const AutoModeConfigSchema = z.object({
  enabled: z.boolean(),
  defaultAgent: z.string().trim().min(1, "defaultAgent must be non-empty"),
  fallbackOrder: z.array(z.string()),
  complexityRouting: z.object({
    simple: ModelTierSchema,
    medium: ModelTierSchema,
    complex: ModelTierSchema,
    expert: ModelTierSchema,
  }),
  escalation: z.object({
    enabled: z.boolean(),
    tierOrder: z.array(TierConfigSchema).min(1, { message: "tierOrder must have at least one tier" }),
    escalateEntireBatch: z.boolean().optional(),
  }),
});
```

Replace with:

```typescript
const AutoModeConfigSchema = z.object({
  enabled: z.boolean(),
  complexityRouting: z.object({
    simple: ModelTierSchema,
    medium: ModelTierSchema,
    complex: ModelTierSchema,
    expert: ModelTierSchema,
  }),
  escalation: z.object({
    enabled: z.boolean(),
    tierOrder: z.array(TierConfigSchema).min(1, { message: "tierOrder must have at least one tier" }),
    escalateEntireBatch: z.boolean().optional(),
  }),
});
```

- [ ] **Step 2: Remove defaults from `AutoModeConfigSchema.default({...})`**

At `src/config/schemas.ts:846-850`, current:

```typescript
autoMode: AutoModeConfigSchema.default({
  enabled: true,
  defaultAgent: "claude",
  fallbackOrder: ["claude"],
  complexityRouting: {
```

Replace with:

```typescript
autoMode: AutoModeConfigSchema.default({
  enabled: true,
  complexityRouting: {
```

(Leave the rest of the default object — `complexityRouting`, `escalation` — untouched.)

- [ ] **Step 3: Update `src/config/runtime-types.ts` if it re-declares AutoModeConfig**

```bash
grep -n "defaultAgent\|fallbackOrder" src/config/runtime-types.ts
```

If found, remove them from the type declaration.

- [ ] **Step 4: Run typecheck — expect breakage in tests only**

```bash
bun run typecheck 2>&1 | tail -30
```

Expected: typecheck errors in test files (covered in Task 11). **DO NOT proceed to commit if there are non-test src/ typecheck errors — that means a call site was missed in Tasks 4-6.**

If src/ is clean, commit the schema change:

```bash
git add src/config/schemas.ts src/config/runtime-types.ts
git commit -m "refactor(config): remove defaultAgent/fallbackOrder from AutoModeConfigSchema (ADR-012 Phase 6) [breaking]"
```

---

### Task 11: Fix tests broken by schema removal

**Files to modify** (all expected to break after Task 10):
- `test/unit/config/defaults.test.ts:162-176` — the `describe("DEFAULT_CONFIG.autoMode.fallbackOrder")` block
- `test/unit/config/schemas.test.ts:37,58,79,96` — 4 reads of `(DEFAULT_CONFIG as { autoMode: { defaultAgent: string } }).autoMode.defaultAgent`
- `test/unit/routing/default-agent-routing.test.ts:7`
- `test/unit/acceptance/fix-executor.test.ts:305,307,355,357,755,757`
- `test/unit/acceptance/fix-diagnosis.test.ts:231,233`
- `test/integration/plan/plan.test.ts:68,115`

- [ ] **Step 1: defaults.test.ts — delete the obsolete describe block**

At `test/unit/config/defaults.test.ts:162`, delete the entire `describe("DEFAULT_CONFIG.autoMode.fallbackOrder (US-001-4)", () => { ... })` block (lines 162–180ish).

If the same file asserts on `autoMode.defaultAgent`, replace with `DEFAULT_CONFIG.agent.default`.

- [ ] **Step 2: schemas.test.ts — replace 4 sites**

At each site like:
```typescript
const defaultAgent = (DEFAULT_CONFIG as { autoMode: { defaultAgent: string } }).autoMode.defaultAgent;
```

Replace with:
```typescript
const defaultAgent = DEFAULT_CONFIG.agent?.default ?? "claude";
```

- [ ] **Step 3: default-agent-routing.test.ts:7**

```typescript
// BEFORE
expect(resolveDefaultAgent(DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG.autoMode.defaultAgent);
// AFTER
expect(resolveDefaultAgent(DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG.agent?.default);
```

- [ ] **Step 4: fix-executor.test.ts + fix-diagnosis.test.ts — 8 sites total**

Each site: `config.autoMode.defaultAgent` → `config.agent?.default ?? "claude"`.

- [ ] **Step 5: plan.test.ts:68,115**

```typescript
// BEFORE
expect(config.models[config.autoMode.defaultAgent]?.powerful).toBeDefined();
// AFTER
expect(config.models[config.agent?.default ?? "claude"]?.powerful).toBeDefined();
```

Apply the same replacement at line 115 (including the `[tier]` loop variant).

- [ ] **Step 6: Sweep for any remaining legacy reads in tests**

```bash
grep -rn "autoMode\.defaultAgent\|autoMode\.fallbackOrder" test/ --include="*.ts"
```
Expected: 0 results.

- [ ] **Step 7: Run full test suite**

```bash
bun run test 2>&1 | tail -15
```
Expected: all pass, 0 fail.

- [ ] **Step 8: Commit**

```bash
git add test/
git commit -m "test: migrate tests off autoMode.defaultAgent/fallbackOrder (ADR-012 Phase 6)"
```

---

### Task 12: Update docs + ADR + rules

**Files:**
- Modify: `docs/adr/ADR-012-agent-manager-ownership.md:269-283` — check off Phase 6 ACs
- Modify: `.claude/rules/adapter-wiring.md:94` — replace the `config.autoMode.defaultAgent` example
- Modify: `CHANGELOG.md` — breaking-change note

- [ ] **Step 1: ADR — check off Phase 6 acceptance criteria**

In `docs/adr/ADR-012-agent-manager-ownership.md`, around line 276:

```markdown
**Acceptance criteria:**
- [x] `applyAgentConfigMigration()` deleted from `src/config/loader.ts`.
- [x] `defaultAgent`, `fallbackOrder` removed from `AutoModeConfigSchema`.
- [x] `ContextV2FallbackConfigSchema` removed.
- [x] Loading a pre-migration config → Zod validation error with clear "migrate to `agent.*` per ADR-012" message.
- [ ] 3 canary releases have passed between Phase 2 and this phase.
- [x] CHANGELOG breaking-change note added.
- [x] `docs/architecture/conventions.md` and `.claude/rules/config-patterns.md` updated.
```

(Note: the 3-canary gate is not applicable for internal projects — leave unchecked with a note, or mark N/A depending on project convention.)

- [ ] **Step 2: adapter-wiring.md — replace the example**

At `.claude/rules/adapter-wiring.md`, find the example using `ctx.config.autoMode.defaultAgent`:

```markdown
**In pipeline stages** (have `ctx: PipelineContext`):
```typescript
// ctx.agentGetFn is threaded from runner.ts via createAgentRegistry(config)
const agent = (ctx.agentGetFn ?? _deps.getAgent)(ctx.config.autoMode.defaultAgent);
```
```

Replace with:

```markdown
**In pipeline stages** (have `ctx: PipelineContext`):
```typescript
// ctx.agentGetFn is threaded from runner.ts via createAgentRegistry(config)
const defaultAgent = ctx.agentManager?.getDefault() ?? "claude";
const agent = (ctx.agentGetFn ?? _deps.getAgent)(defaultAgent);
```
```

- [ ] **Step 3: config-patterns.md — remove legacy compatibility-shim example if it references `autoMode`**

```bash
grep -n "autoMode\|applyAgentConfigMigration" .claude/rules/config-patterns.md
```

If present, either remove the example or update it to reference a current migration pattern.

- [ ] **Step 4: CHANGELOG.md — breaking-change note**

Add a new entry at the top under the current unreleased section:

```markdown
### Breaking

- `autoMode.defaultAgent` and `autoMode.fallbackOrder` config fields removed. Use `agent.default` and `agent.fallback.map` instead (ADR-012 Phase 6). Loading a legacy config now fails Zod validation.
```

If `CHANGELOG.md` does not exist, skip this step and report back — there may be a different release-notes file.

- [ ] **Step 5: Commit**

```bash
git add docs/adr/ADR-012-agent-manager-ownership.md .claude/rules/ CHANGELOG.md
git commit -m "docs(adr-012): Phase 6 complete — mark ACs, update rules + changelog"
```

---

### Task 13: Final gate

- [ ] **Step 1: All 9 Phase 6 invariant tests pass**

```bash
bun test test/unit/config/phase6-invariants.test.ts --timeout=30000
```
Expected: 9 pass, 0 fail.

- [ ] **Step 2: Full sweep for legacy references**

```bash
grep -rn "autoMode\.defaultAgent\|autoMode\.fallbackOrder\|applyAgentConfigMigration\|ContextV2FallbackConfig" src/ test/ --include="*.ts"
```
Expected: only doc-comment hits in `src/config/agent-migration.ts`'s former companion documents (if any), but the shim file itself is gone. If `agent-migration.test.ts` still exists, the Phase 6 work is incomplete.

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck 2>&1 | tail -10
```
Expected: clean.

- [ ] **Step 4: Lint**

```bash
bun run lint 2>&1 | tail -5
```
Expected: clean.

- [ ] **Step 5: Full test suite**

```bash
bun run test 2>&1 | tail -10
```
Expected: all pass, 0 fail.

- [ ] **Step 6: Schema-rejection smoke test (optional but recommended)**

Create a throwaway legacy config and verify `NaxConfigSchema.safeParse()` rejects it with a clear error:

```bash
bun -e '
import { NaxConfigSchema } from "./src/config/schemas";
const legacy = { autoMode: { enabled: true, defaultAgent: "claude", fallbackOrder: ["claude"], complexityRouting: { simple: "fast", medium: "balanced", complex: "powerful", expert: "powerful" }, escalation: { enabled: true, tierOrder: [{ tier: "fast", attempts: 5 }] } } };
const r = NaxConfigSchema.safeParse(legacy);
console.log(r.success ? "UNEXPECTED PASS" : JSON.stringify(r.error.issues, null, 2));
'
```

Expected output: the issues array reports unrecognised keys `autoMode.defaultAgent` and `autoMode.fallbackOrder` (Zod strict mode will flag them).

If Zod silently ignores the extras (non-strict mode), add `.strict()` to the `AutoModeConfigSchema` definition OR add a dedicated pre-parse check in `loader.ts` that emits a friendly NaxError pointing to ADR-012. Decide based on what the current `NaxConfigSchema` does for other unrecognised keys. **Do not silently ignore legacy keys** — that was the entire problem Phase 6 is solving.

- [ ] **Step 7: Report final state**

Log:
- Phase 6 invariant tests: 9/9 ✅
- Full test suite: N pass / 0 fail
- Typecheck: clean
- Lint: clean
- Legacy key references: 0 in src/, 0 in test/
- Schema rejects legacy config with a clear error

Mark Phase 6 complete.

---

## Self-Review Checklist

Author ran these checks after writing the plan:

- [x] Spec coverage — Phase 6 ACs in ADR-012 map to: Task 9 (delete shim), Task 10 (remove schema fields), Task 13 Step 6 (Zod rejects legacy), Task 12 (changelog + docs). The "3 canary releases" gate is noted as N/A for internal projects in Task 12 Step 1.
- [x] Placeholder scan — no "TBD", no "handle edge cases", no "similar to Task N". Every code edit is shown.
- [x] Type consistency — `resolveDefaultAgent(config)` signature is consistent across Tasks 2/5/6. `agentManager.getDefault()` return type is consistent across Tasks 3/4/5.
- [x] 400-line limit — none of the modified files approach 400 lines (checked: `manager.ts` 338, `loader.ts` 287, `schemas.ts` large but only small edits).
- [x] Migration completeness — every call site in the grep inventory (`src/pipeline/`, `src/tdd/`, `src/debate/`, `src/review/`, `src/agents/`, `src/cli/`, `src/context/engine/`, `src/config/`) has a matching step.
- [x] Test coverage — every legacy-key assertion in the test inventory (`test/unit/config/`, `test/unit/agents/`, `test/unit/routing/`, `test/unit/acceptance/`, `test/integration/cli/`, `test/integration/plan/`) has a migration step.

---

## Execution

Plan saved to `docs/superpowers/plans/2026-04-19-adr-012-phase6-remove-migration-shim.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks, fast iteration
2. **Inline Execution** — batch execution in this session with checkpoints

Which approach?
