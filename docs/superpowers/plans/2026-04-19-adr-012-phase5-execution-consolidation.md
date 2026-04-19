# ADR-012 Phase 5 — Execution-Stage Consolidation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 160-line inline agent-swap loop in `execution.ts` with a single `ctx.agentManager.runWithFallback()` call, delete `agent-swap.ts`, and remove the `context.v2.fallback` compatibility shim from the config schema.

**Architecture:** The execution stage becomes a thin orchestrator that builds an `executeHop` callback (which owns context-plumbing: bundle rebuild, session handoff, protocol binding) and passes it to `AgentManager.runWithFallback()` (which owns policy: shouldSwap, nextCandidate, rate-limit backoff, event emissions). The manager's loop calls `executeHop(agentName, bundle, failure)` for both the primary and every fallback hop; it returns `{ result, bundle, prompt }` per hop. After the loop the execution stage applies the outcome to `ctx`.

**Tech Stack:** TypeScript strict, Bun 1.3.7+, `bun:test`, Biome

---

## File Map

| File | Change |
|:-----|:-------|
| `src/agents/manager-types.ts` | Add `executeHop` to `AgentRunRequest`; add `finalBundle`/`finalPrompt` to `AgentRunOutcome` |
| `src/agents/manager.ts` | Update `runWithFallback` to call `executeHop` when provided; track `currentBundle`/`currentFailure` through loop |
| `src/pipeline/stages/execution.ts` | Remove Phase 5.5 swap loop; remove fallback compat shim; build `executeHop` callback; call `runWithFallback` |
| `src/pipeline/types.ts` | Update JSDoc for `agentSwapCount`/`agentFallbacks` (Phase 5.5 → Phase 5) |
| `src/execution/iteration-runner.ts` | Call `agentManager.reset()` at story start |
| `src/execution/escalation/agent-swap.ts` | **Delete** |
| `src/config/schemas.ts` | Remove `fallback: ContextV2FallbackConfigSchema` from `context.v2` schema |
| `test/unit/agents/phase5-invariants.test.ts` | **Create** — grep-based invariant tests |
| `test/integration/execution/agent-swap.test.ts` | Update to wire real `AgentManager`, remove `_executionDeps` swap mocks |

---

### Task 1: Write failing invariant tests (TDD red phase)

**Files:**
- Create: `test/unit/agents/phase5-invariants.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// test/unit/agents/phase5-invariants.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "../../../");

function src(rel: string) {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("Phase 5 invariants — execution stage", () => {
  test("execution.ts does not import from agent-swap.ts", () => {
    const code = src("src/pipeline/stages/execution.ts");
    expect(code).not.toContain("escalation/agent-swap");
  });

  test("execution.ts does not contain shouldAttemptSwap call", () => {
    const code = src("src/pipeline/stages/execution.ts");
    expect(code).not.toContain("shouldAttemptSwap");
  });

  test("execution.ts does not contain resolveSwapTarget call", () => {
    const code = src("src/pipeline/stages/execution.ts");
    expect(code).not.toContain("resolveSwapTarget");
  });

  test("execution.ts does not contain the Phase 5.5 comment", () => {
    const code = src("src/pipeline/stages/execution.ts");
    expect(code).not.toContain("Phase 5.5");
  });

  test("execution.ts does not contain context.v2.fallback shim", () => {
    const code = src("src/pipeline/stages/execution.ts");
    expect(code).not.toContain("context?.v2?.fallback");
  });

  test("agent-swap.ts does not exist", () => {
    expect(() => src("src/execution/escalation/agent-swap.ts")).toThrow();
  });

  test("config schema does not have context.v2.fallback field", () => {
    const code = src("src/config/schemas.ts");
    expect(code).not.toContain("ContextV2FallbackConfigSchema");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test test/unit/agents/phase5-invariants.test.ts --timeout=10000
```

Expected: 7 failures (all assertions currently wrong — invariants not yet met).

- [ ] **Step 3: Commit the red tests**

```bash
git add test/unit/agents/phase5-invariants.test.ts
git commit -m "test(agents): add Phase 5 invariant tests (red)"
```

---

### Task 2: Extend `AgentRunRequest` and `AgentRunOutcome` types

**Files:**
- Modify: `src/agents/manager-types.ts`

- [ ] **Step 1: Write the failing type tests**

Create `test/unit/agents/manager-types-phase5.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { AgentRunRequest, AgentRunOutcome } from "../../../src/agents/manager-types";
import type { ContextBundle } from "../../../src/context/engine";
import type { AdapterFailure } from "../../../src/context/engine/types";
import type { AgentResult } from "../../../src/agents/types";

describe("AgentRunRequest — executeHop callback", () => {
  test("AgentRunRequest accepts executeHop callback", () => {
    const req: AgentRunRequest = {
      runOptions: {} as never,
      executeHop: async (agentName: string, bundle: ContextBundle | undefined, failure: AdapterFailure | undefined) => ({
        result: {} as AgentResult,
        bundle,
        prompt: "test",
      }),
    };
    expect(typeof req.executeHop).toBe("function");
  });

  test("AgentRunOutcome has finalBundle and finalPrompt", () => {
    const outcome: AgentRunOutcome = {
      result: {} as AgentResult,
      fallbacks: [],
      finalBundle: undefined,
      finalPrompt: undefined,
    };
    expect(outcome.finalBundle).toBeUndefined();
    expect(outcome.finalPrompt).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
bun test test/unit/agents/manager-types-phase5.test.ts --timeout=10000
```

Expected: type errors / test failures (fields don't exist yet).

- [ ] **Step 3: Add `executeHop` to `AgentRunRequest` and `finalBundle`/`finalPrompt` to `AgentRunOutcome`**

In `src/agents/manager-types.ts`, update:

```typescript
export interface AgentRunRequest {
  runOptions: AgentRunOptions;
  bundle?: ContextBundle;
  sessionId?: string;
  /**
   * Per-hop executor. When provided, replaces the internal adapter.run() call for every hop
   * (primary AND fallback). Called with:
   *   - agentName: which agent to use for this hop
   *   - bundle: the context bundle at the start of this hop (rebuilt between hops)
   *   - failure: the AdapterFailure that triggered this hop; undefined for the primary hop
   * Returns the agent result, the bundle used (may differ after rebuild), and the prompt used.
   * Used by execution stage to inject context rebuild, session handoff, and prompt building.
   */
  executeHop?: (
    agentName: string,
    bundle: ContextBundle | undefined,
    failure: AdapterFailure | undefined,
  ) => Promise<{ result: AgentResult; bundle: ContextBundle | undefined; prompt?: string }>;
}

export interface AgentRunOutcome {
  result: AgentResult;
  fallbacks: AgentFallbackRecord[];
  /** The context bundle used by the final (successful or last failed) hop. */
  finalBundle?: ContextBundle;
  /** The prompt used by the final (successful or last failed) hop. */
  finalPrompt?: string;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test test/unit/agents/manager-types-phase5.test.ts --timeout=10000
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/manager-types.ts test/unit/agents/manager-types-phase5.test.ts
git commit -m "feat(agent-manager): extend AgentRunRequest with executeHop callback (Phase 5)"
```

---

### Task 3: Update `AgentManager.runWithFallback` to call `executeHop`

**Files:**
- Modify: `src/agents/manager.ts`
- Modify: `test/unit/agents/manager-swap-loop.test.ts`

- [ ] **Step 1: Write a failing test for the executeHop path**

Add to `test/unit/agents/manager-swap-loop.test.ts` (inside the existing `describe` block):

```typescript
describe("AgentManager.runWithFallback — executeHop callback", () => {
  test("calls executeHop for primary hop (failure=undefined)", async () => {
    const calls: Array<{ agentName: string; failure: unknown }> = [];
    const m = new AgentManager(makeConfig(), undefined /* no registry — executeHop replaces it */);
    const outcome = await m.runWithFallback({
      runOptions: {} as never,
      bundle: mockBundle,
      executeHop: async (agentName, bundle, failure) => {
        calls.push({ agentName, failure });
        return {
          result: { success: true, exitCode: 0, output: "ok", rateLimited: false, durationMs: 0, estimatedCost: 0 },
          bundle,
          prompt: "test",
        };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].agentName).toBe("claude");
    expect(calls[0].failure).toBeUndefined();
    expect(outcome.result.success).toBe(true);
    expect(outcome.finalPrompt).toBe("test");
  });

  test("calls executeHop for swap hop with failure set", async () => {
    const calls: Array<{ agentName: string; failure: unknown }> = [];
    let hop = 0;
    const m = new AgentManager(makeConfig({ claude: ["codex"] }), undefined);
    const outcome = await m.runWithFallback({
      runOptions: {} as never,
      bundle: mockBundle,
      executeHop: async (agentName, bundle, failure) => {
        calls.push({ agentName, failure });
        hop++;
        const success = hop === 2; // first fails, second succeeds
        return {
          result: {
            success,
            exitCode: success ? 0 : 1,
            output: "",
            rateLimited: false,
            durationMs: 0,
            estimatedCost: 0,
            adapterFailure: success ? undefined : availFailure,
          },
          bundle,
          prompt: `prompt-${agentName}`,
        };
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].agentName).toBe("claude");
    expect(calls[0].failure).toBeUndefined();
    expect(calls[1].agentName).toBe("codex");
    expect(calls[1].failure).toEqual(availFailure);
    expect(outcome.fallbacks).toHaveLength(1);
    expect(outcome.finalPrompt).toBe("prompt-codex");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
bun test test/unit/agents/manager-swap-loop.test.ts --timeout=10000
```

Expected: FAIL — `executeHop` not yet used by `runWithFallback`.

- [ ] **Step 3: Update `runWithFallback` in `src/agents/manager.ts`**

Replace the `runWithFallback` method body with:

```typescript
async runWithFallback(request: AgentRunRequest): Promise<AgentRunOutcome> {
  const logger = getSafeLogger();
  const fallbacks: AgentFallbackRecord[] = [];
  let currentAgent = this.getDefault();
  let hopsSoFar = 0;
  const MAX_RATE_LIMIT_RETRIES = 3;
  let rateLimitRetry = 0;
  let currentBundle = request.bundle;
  let currentFailure: import("../context/engine/types").AdapterFailure | undefined;
  let finalPrompt: string | undefined;

  while (true) {
    let result: AgentResult;
    let updatedBundle = currentBundle;

    if (request.executeHop) {
      const hopOut = await request.executeHop(currentAgent, currentBundle, currentFailure);
      result = hopOut.result;
      updatedBundle = hopOut.bundle ?? currentBundle;
      finalPrompt = hopOut.prompt ?? finalPrompt;
    } else {
      const adapter = this._registry?.getAgent(currentAgent);
      if (!adapter) {
        logger?.warn("agent-manager", "No adapter available", {
          storyId: request.runOptions.storyId,
          agent: currentAgent,
        });
        const result: AgentResult = {
          success: false,
          exitCode: 1,
          output: `Agent "${currentAgent}" not found in registry`,
          rateLimited: false,
          durationMs: 0,
          estimatedCost: 0,
        };
        return { result, fallbacks, finalBundle: currentBundle, finalPrompt };
      }
      try {
        result = await adapter.run(request.runOptions);
      } catch (err) {
        result = {
          success: false,
          exitCode: 1,
          output: err instanceof Error ? err.message : String(err),
          rateLimited: false,
          durationMs: 0,
          estimatedCost: 0,
          adapterFailure: {
            category: "quality",
            outcome: "fail-unknown",
            retriable: false,
            message: String(err).slice(0, 500),
          },
        };
      }
    }

    if (result.success) return { result, fallbacks, finalBundle: updatedBundle, finalPrompt };

    const bundleForSwapCheck = updatedBundle ?? request.bundle;

    if (!this.shouldSwap(result.adapterFailure, hopsSoFar, bundleForSwapCheck)) {
      // Preserve legacy rate-limit backoff when no swap candidates are available
      if (result.adapterFailure?.outcome === "fail-rate-limit" && rateLimitRetry < MAX_RATE_LIMIT_RETRIES) {
        rateLimitRetry += 1;
        const backoffMs = 2 ** rateLimitRetry * 1000;
        logger?.info("agent-manager", "Rate-limited with no swap candidate — backing off", {
          storyId: request.runOptions.storyId,
          attempt: rateLimitRetry,
          backoffMs,
        });
        await _agentManagerDeps.sleep(backoffMs);
        continue;
      }
      if (hopsSoFar > 0) {
        this._emitter.emit("onSwapExhausted", { storyId: request.runOptions.storyId, hops: hopsSoFar });
      }
      return { result, fallbacks, finalBundle: updatedBundle, finalPrompt };
    }

    const next = this.nextCandidate(currentAgent, hopsSoFar);
    if (!next) {
      this._emitter.emit("onSwapExhausted", { storyId: request.runOptions.storyId, hops: hopsSoFar });
      return { result, fallbacks, finalBundle: updatedBundle, finalPrompt };
    }

    const adapterFailure = result.adapterFailure ?? {
      category: "quality" as const,
      outcome: "fail-unknown" as const,
      retriable: false,
      message: "",
    };
    this.markUnavailable(currentAgent, adapterFailure);
    hopsSoFar += 1;
    // Reset per-agent rate-limit counter so the new agent gets its own backoff budget.
    rateLimitRetry = 0;
    currentBundle = updatedBundle;
    currentFailure = adapterFailure;

    const hop: AgentFallbackRecord = {
      storyId: request.runOptions.storyId,
      priorAgent: currentAgent,
      newAgent: next,
      hop: hopsSoFar,
      outcome: adapterFailure.outcome,
      category: adapterFailure.category,
      timestamp: new Date().toISOString(),
      costUsd: result.estimatedCost ?? 0,
    };
    fallbacks.push(hop);
    this._emitter.emit("onSwapAttempt", hop);

    logger?.info("agent-manager", "Agent swap triggered", {
      storyId: request.runOptions.storyId,
      fromAgent: currentAgent,
      toAgent: next,
      hop: hopsSoFar,
    });

    currentAgent = next;
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test test/unit/agents/manager-swap-loop.test.ts --timeout=10000
```

Expected: PASS (all tests including the new ones).

- [ ] **Step 5: Run full suite to catch regressions**

```bash
bun run test:bail 2>&1 | tail -5
```

Expected: 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/agents/manager.ts test/unit/agents/manager-swap-loop.test.ts
git commit -m "feat(agent-manager): runWithFallback calls executeHop callback per hop (Phase 5)"
```

---

### Task 4: Refactor `execution.ts` — replace inline swap loop with `runWithFallback`

**Files:**
- Modify: `src/pipeline/stages/execution.ts`

This is the core task. The inline Phase 5.5 swap loop (lines ~257–416 and the fallback compat shim on lines ~261–274) is replaced with a single `ctx.agentManager.runWithFallback()` call. The primary `agent.run()` call also moves inside the `executeHop` callback.

- [ ] **Step 1: Write a new failing unit test for the post-refactor execution stage wiring**

Create `test/unit/pipeline/stages/execution-manager-wiring.test.ts`:

```typescript
import { describe, expect, mock, test } from "bun:test";
import { executionStage, _executionDeps } from "../../../../src/pipeline/stages/execution";
import type { PipelineContext } from "../../../../src/pipeline/types";
import { DEFAULT_CONFIG } from "../../../../src/config";
import type { NaxConfig } from "../../../../src/config";
import type { IAgentManager } from "../../../../src/agents/manager-types";
import type { AgentAdapter } from "../../../../src/agents/types";
import type { ContextBundle } from "../../../../src/context/engine";
import { ContextOrchestrator } from "../../../../src/context/engine/orchestrator";

const origGetAgent = _executionDeps.getAgent;
const origValidateAgent = _executionDeps.validateAgentForTier;
const origDetectMerge = _executionDeps.detectMergeConflict;

afterEach(() => {
  _executionDeps.getAgent = origGetAgent;
  _executionDeps.validateAgentForTier = origValidateAgent;
  _executionDeps.detectMergeConflict = origDetectMerge;
  mock.restore();
});

async function makeBundle(): Promise<ContextBundle> {
  return new ContextOrchestrator([]).assemble({
    storyId: "US-1",
    repoRoot: "/r",
    packageDir: "/r",
    stage: "run",
    role: "implementer",
    budgetTokens: 8000,
    providerIds: [],
    agentId: "claude",
  });
}

function makeCtx(config: NaxConfig, bundle: ContextBundle, manager: IAgentManager): PipelineContext {
  return {
    config,
    rootConfig: { ...DEFAULT_CONFIG, autoMode: { defaultAgent: "claude" }, models: config.models } as NaxConfig,
    prd: { project: "p", feature: "f", branchName: "b", createdAt: "", updatedAt: "", userStories: [] },
    story: { id: "US-1", title: "T", description: "", acceptanceCriteria: [], tags: [], dependencies: [], status: "in-progress", passes: false, escalations: [], attempts: 1 },
    stories: [],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", agent: "claude", reasoning: "" },
    workdir: "/tmp/t",
    projectDir: "/tmp/t",
    prompt: "do it",
    hooks: {} as PipelineContext["hooks"],
    contextBundle: bundle,
    agentManager: manager,
  } as unknown as PipelineContext;
}

describe("execution stage — uses agentManager.runWithFallback", () => {
  test("calls agentManager.runWithFallback (not direct adapter.run) when agentManager present", async () => {
    const bundle = await makeBundle();
    const config = { ...DEFAULT_CONFIG, autoMode: { defaultAgent: "claude" } } as NaxConfig;

    let runWithFallbackCalled = false;
    const manager: IAgentManager = {
      getDefault: () => "claude",
      isUnavailable: () => false,
      markUnavailable: () => {},
      reset: () => {},
      validateCredentials: async () => {},
      events: { on: () => {} },
      resolveFallbackChain: () => [],
      shouldSwap: () => false,
      nextCandidate: () => null,
      runWithFallback: mock(async (request) => {
        runWithFallbackCalled = true;
        // Call executeHop to simulate primary run
        const { result, bundle: b, prompt } = await request.executeHop!("claude", request.bundle, undefined);
        return { result, fallbacks: [], finalBundle: b, finalPrompt: prompt };
      }),
      completeWithFallback: async () => ({ result: { output: "", costUsd: 0, source: "fallback" }, fallbacks: [] }),
    };

    const successAdapter: AgentAdapter = {
      name: "claude",
      capabilities: { supportedTiers: ["fast", "balanced", "powerful"] },
      run: mock(async () => ({ success: true, exitCode: 0, output: "done", rateLimited: false, durationMs: 100, estimatedCost: 0.01 })),
      closeSession: async () => {},
      closePhysicalSession: async () => {},
      deriveSessionName: mock(() => "nax-session-claude"),
    } as unknown as AgentAdapter;

    _executionDeps.getAgent = mock(() => successAdapter);
    _executionDeps.validateAgentForTier = mock(() => true);
    _executionDeps.detectMergeConflict = mock(() => false);

    const result = await executionStage.execute(makeCtx(config, bundle, manager));

    expect(runWithFallbackCalled).toBe(true);
    expect(result).toEqual({ action: "continue" });
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
bun test test/unit/pipeline/stages/execution-manager-wiring.test.ts --timeout=30000
```

Expected: FAIL — execution stage currently calls `agent.run()` directly, not `agentManager.runWithFallback()`.

- [ ] **Step 3: Refactor `execution.ts` — replace the primary run + inline swap loop**

The `execute` function body currently (after the merge-conflict wiring) calls `agent.run()` directly, then has the Phase 5.5 inline loop. Replace the section from the primary `agent.run()` call down to the final `return { action: "continue" }` with the following. Keep everything before (TDD path, validateAgentForTier, keepOpen, session-state-machine) unchanged.

Find and replace the block starting with `// G3: Resolve descriptor for Phase 1+` through `return { action: "continue" };` (the final line of the function) with:

```typescript
    // G3: Resolve descriptor for Phase 1+ session tracking.
    const sessionDescriptor = ctx.sessionManager && ctx.sessionId ? ctx.sessionManager.get(ctx.sessionId) : undefined;

    // Build shared base run options — reused for primary hop and overridden per fallback hop.
    const baseRunOptions: import("../../agents/types").AgentRunOptions = {
      prompt: ctx.prompt,
      workdir: ctx.workdir,
      modelTier: effectiveTier,
      modelDef: resolveModelForAgent(
        ctx.rootConfig.models,
        ctx.routing.agent ?? defaultAgent,
        effectiveTier,
        defaultAgent,
      ),
      timeoutSeconds: ctx.config.execution.sessionTimeoutSeconds,
      dangerouslySkipPermissions: resolvePermissions(ctx.config, "run").skipPermissions,
      pipelineStage: "run",
      config: ctx.config,
      projectDir: ctx.projectDir,
      maxInteractionTurns: ctx.config.agent?.maxInteractionTurns,
      pidRegistry: ctx.pidRegistry,
      featureName: ctx.prd.feature,
      storyId: ctx.story.id,
      sessionRole: "implementer",
      keepOpen,
      interactionBridge: buildInteractionBridge(ctx.interaction, {
        featureName: ctx.prd.feature,
        storyId: ctx.story.id,
        stage: "execution",
      }),
    };

    const { result, fallbacks, finalBundle, finalPrompt } = await (ctx.agentManager
      ? ctx.agentManager.runWithFallback({
          runOptions: baseRunOptions,
          bundle: ctx.contextBundle,
          executeHop: async (agentName, bundle, failure) => {
            const hopAgent = (ctx.agentGetFn ?? _executionDeps.getAgent)(agentName);
            if (!hopAgent) {
              return {
                result: {
                  success: false,
                  exitCode: 1,
                  output: `Agent "${agentName}" not found`,
                  rateLimited: false,
                  durationMs: 0,
                  estimatedCost: 0,
                },
                bundle,
                prompt: ctx.prompt,
              };
            }

            let workingBundle = bundle;
            let prompt = ctx.prompt;

            if (failure && bundle) {
              workingBundle = _executionDeps.rebuildForAgent(bundle, agentName, failure, ctx.story.id);
              if (ctx.projectDir && ctx.prd.feature && workingBundle.manifest.rebuildInfo) {
                try {
                  await _executionDeps.writeRebuildManifest(ctx.projectDir, ctx.prd.feature, ctx.story.id, {
                    requestId: workingBundle.manifest.requestId,
                    stage: "execution",
                    priorAgentId: workingBundle.manifest.rebuildInfo.priorAgentId,
                    newAgentId: workingBundle.manifest.rebuildInfo.newAgentId,
                    failureCategory: workingBundle.manifest.rebuildInfo.failureCategory,
                    failureOutcome: workingBundle.manifest.rebuildInfo.failureOutcome,
                    priorChunkIds: workingBundle.manifest.rebuildInfo.priorChunkIds,
                    newChunkIds: workingBundle.manifest.rebuildInfo.newChunkIds,
                    chunkIdMap: workingBundle.manifest.rebuildInfo.chunkIdMap,
                    createdAt: new Date().toISOString(),
                  });
                } catch (err) {
                  logger.warn("execution", "Failed to write rebuild manifest", {
                    storyId: ctx.story.id,
                    error: String(err),
                  });
                }
              }
              prompt = buildSwapPrompt(ctx.prompt, workingBundle.pushMarkdown);
            }

            const session = failure
              ? ctx.sessionManager && ctx.sessionId
                ? ctx.sessionManager.handoff?.(ctx.sessionId, agentName, failure.outcome)
                : undefined
              : sessionDescriptor;

            const hopResult = await hopAgent.run({
              ...baseRunOptions,
              prompt,
              modelDef: resolveModelForAgent(
                ctx.rootConfig.models,
                agentName,
                effectiveTier,
                defaultAgent,
              ),
              contextPullTools: workingBundle?.pullTools,
              contextToolRuntime: workingBundle
                ? createContextToolRuntime({
                    bundle: workingBundle,
                    story: ctx.story,
                    config: ctx.config,
                    repoRoot: ctx.workdir,
                    runCounter: ctx.contextToolRunCounter,
                  })
                : undefined,
              ...(session && { session }),
            });

            ctx.agentResult = hopResult;

            if (ctx.sessionManager && ctx.sessionId && hopResult.protocolIds) {
              const descriptor = ctx.sessionManager.get(ctx.sessionId);
              if (descriptor) {
                ctx.sessionManager.bindHandle(
                  ctx.sessionId,
                  hopAgent.deriveSessionName(descriptor),
                  hopResult.protocolIds,
                );
              }
            }

            return { result: hopResult, bundle: workingBundle, prompt };
          },
        })
      : // Fallback path: no manager (should not happen in production — agentManager is always set by runner.ts)
        (async () => {
          const contextToolRuntime = ctx.contextBundle
            ? createContextToolRuntime({
                bundle: ctx.contextBundle,
                story: ctx.story,
                config: ctx.config,
                repoRoot: ctx.workdir,
                runCounter: ctx.contextToolRunCounter,
              })
            : undefined;
          const r = await agent.run({
            ...baseRunOptions,
            contextPullTools: ctx.contextBundle?.pullTools,
            contextToolRuntime,
            ...(sessionDescriptor && { session: sessionDescriptor }),
          });
          ctx.agentResult = r;
          if (ctx.sessionManager && ctx.sessionId && r.protocolIds) {
            const descriptor = ctx.sessionManager.get(ctx.sessionId);
            if (descriptor) {
              ctx.sessionManager.bindHandle(ctx.sessionId, agent.deriveSessionName(descriptor), r.protocolIds);
            }
          }
          return { result: r, fallbacks: [], finalBundle: ctx.contextBundle, finalPrompt: ctx.prompt };
        })());

    // Apply swap outcome to ctx
    ctx.agentSwapCount = fallbacks.length;
    if (fallbacks.length > 0) {
      ctx.agentFallbacks = fallbacks.map((f) => ({
        storyId: f.storyId ?? ctx.story.id,
        priorAgent: f.priorAgent,
        newAgent: f.newAgent,
        outcome: f.outcome,
        category: f.category,
        hop: f.hop,
      }));
    }

    // BUG-058: Auto-commit if agent left uncommitted changes (single-session/test-after)
    await autoCommitIfDirty(ctx.workdir, "execution", "single-session", ctx.story.id);

    // merge-conflict trigger: detect CONFLICT markers in agent output
    const combinedOutput = (result.output ?? "") + (result.stderr ?? "");
    if (
      _executionDeps.detectMergeConflict(combinedOutput) &&
      ctx.interaction &&
      isTriggerEnabled("merge-conflict", ctx.config)
    ) {
      const shouldProceed = await _executionDeps.checkMergeConflict(
        { featureName: ctx.prd.feature, storyId: ctx.story.id },
        ctx.config,
        ctx.interaction,
      );
      if (!shouldProceed) {
        logger.error("execution", "Merge conflict detected — aborting story", { storyId: ctx.story.id });
        if (ctx.sessionManager && ctx.sessionId) {
          await _executionDeps.failAndClose(ctx.sessionManager, ctx.sessionId, ctx.agentGetFn);
        }
        return { action: "fail", reason: "Merge conflict detected" };
      }
    }

    // story-ambiguity trigger: detect ambiguity signals in agent output
    if (
      result.success &&
      _executionDeps.isAmbiguousOutput(combinedOutput) &&
      ctx.interaction &&
      isTriggerEnabled("story-ambiguity", ctx.config)
    ) {
      const shouldContinue = await _executionDeps.checkStoryAmbiguity(
        { featureName: ctx.prd.feature, storyId: ctx.story.id, reason: "Agent output suggests ambiguity" },
        ctx.config,
        ctx.interaction,
      );
      if (!shouldContinue) {
        logger.warn("execution", "Story ambiguity detected — escalating story", { storyId: ctx.story.id });
        return { action: "escalate", reason: "Story ambiguity detected — needs clarification" };
      }
    }

    if (!result.success) {
      logger.error("execution", "Agent session failed", {
        storyId: ctx.story.id,
        exitCode: result.exitCode,
        stderr: result.stderr || "",
        rateLimited: result.rateLimited,
      });
      if (result.rateLimited) {
        logger.warn("execution", "Rate limited — will retry", { storyId: ctx.story.id });
      }
      if (ctx.sessionManager && ctx.sessionId) {
        await _executionDeps.failAndClose(ctx.sessionManager, ctx.sessionId, ctx.agentGetFn);
      }
      return { action: "escalate" };
    }

    // Update ctx for downstream stages (only on success)
    if (finalBundle) ctx.contextBundle = finalBundle;
    if (finalPrompt && finalPrompt !== ctx.prompt) ctx.prompt = finalPrompt;

    logger.info("execution", "Agent session complete", {
      storyId: ctx.story.id,
      cost: result.estimatedCost,
    });
    return { action: "continue" };
```

Also update the import at the top of `execution.ts` — remove the `agent-swap` import and add `rebuildForAgent` to `_executionDeps`. Find:

```typescript
import { rebuildForSwap, resolveSwapTarget, shouldAttemptSwap } from "../../execution/escalation/agent-swap";
```

Delete that line entirely. Then update `_executionDeps`:

```typescript
export const _executionDeps = {
  getAgent,
  validateAgentForTier,
  detectMergeConflict,
  checkMergeConflict,
  isAmbiguousOutput,
  checkStoryAmbiguity,
  rebuildForAgent: (
    prior: import("../../context/engine/types").ContextBundle,
    newAgentId: string,
    failure: import("../../context/engine/types").AdapterFailure,
    storyId?: string,
  ): import("../../context/engine/types").ContextBundle =>
    new (require("../../context/engine/orchestrator").ContextOrchestrator)([]).rebuildForAgent(prior, {
      newAgentId,
      failure,
      storyId,
    }),
  writeRebuildManifest,
  failAndClose,
};
```

**Note:** Replace the `require()` with a proper import. Add to imports at the top of `execution.ts`:

```typescript
import { ContextOrchestrator } from "../../context/engine";
```

And define `rebuildForAgent` in `_executionDeps` as:

```typescript
  rebuildForAgent: (
    prior: import("../../context/engine/types").ContextBundle,
    newAgentId: string,
    failure: import("../../context/engine/types").AdapterFailure,
    storyId?: string,
  ) => new ContextOrchestrator([]).rebuildForAgent(prior, { newAgentId, failure, storyId }),
```

- [ ] **Step 4: Run the new wiring test**

```bash
bun test test/unit/pipeline/stages/execution-manager-wiring.test.ts --timeout=30000
```

Expected: PASS

- [ ] **Step 5: Run the full test suite to catch regressions**

```bash
bun run test:bail 2>&1 | tail -5
```

Expected: 0 failures (integration tests may need adjustment — handled in Task 8).

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/stages/execution.ts test/unit/pipeline/stages/execution-manager-wiring.test.ts
git commit -m "refactor(execution): replace Phase 5.5 inline swap loop with agentManager.runWithFallback (Phase 5)"
```

---

### Task 5: Wire `agentManager.reset()` at story boundaries

**Files:**
- Modify: `src/execution/iteration-runner.ts`

The `AgentManager` is shared across stories in a run. `markUnavailable` called for story 1's swap should not affect story 2. `reset()` clears the per-run unavailable state.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/execution/iteration-runner.test.ts` (if the file exists) OR create `test/unit/agents/agent-manager-reset.test.ts`:

```typescript
import { describe, expect, mock, test } from "bun:test";
import { AgentManager } from "../../../src/agents/manager";
import { createAgentRegistry } from "../../../src/agents/registry";
import { DEFAULT_CONFIG } from "../../../src/config";

describe("AgentManager.reset — called between stories", () => {
  test("unavailable state from one story does not bleed into the next", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      autoMode: { defaultAgent: "claude" },
    } as never;
    const manager = new AgentManager(config, createAgentRegistry(config));

    manager.markUnavailable("claude", {
      category: "availability",
      outcome: "fail-auth",
      retriable: false,
      message: "story 1 auth failure",
    });

    expect(manager.isUnavailable("claude")).toBe(true);

    // Simulates reset at story boundary
    manager.reset();

    expect(manager.isUnavailable("claude")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm it passes (reset() already exists)**

```bash
bun test test/unit/agents/agent-manager-reset.test.ts --timeout=10000
```

Expected: PASS (the test passes because `reset()` is already implemented — this is a documentation test).

- [ ] **Step 3: Add `agentManager?.reset()` at story start in `iteration-runner.ts`**

In `src/execution/iteration-runner.ts`, find the line just after `const pipelineContext: PipelineContext = {` construction (around line 149) and add before the pipeline.run() call:

```typescript
  // ADR-012 Phase 5: reset per-story unavailable state so a rate-limit/auth failure
  // in story N does not prevent the agent from being used in story N+1.
  ctx.agentManager?.reset();
```

Place it just before `const pipeline = createPipeline(pipelineContext)` or equivalent pipeline execution call.

- [ ] **Step 4: Run full suite**

```bash
bun run test:bail 2>&1 | tail -5
```

Expected: 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/execution/iteration-runner.ts test/unit/agents/agent-manager-reset.test.ts
git commit -m "fix(execution): reset agentManager unavailable state at story boundary (ADR-012 Phase 5)"
```

---

### Task 6: Delete `agent-swap.ts` and clean dead imports

**Files:**
- Delete: `src/execution/escalation/agent-swap.ts`
- Modify: `src/pipeline/stages/execution.ts` (imports already cleaned in Task 4)

- [ ] **Step 1: Verify nothing else imports `agent-swap.ts`**

```bash
grep -r "agent-swap" /home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/ --include="*.ts"
```

Expected: zero results (Task 4 removed the only import).

- [ ] **Step 2: Delete the file**

```bash
rm src/execution/escalation/agent-swap.ts
```

- [ ] **Step 3: Run full suite to confirm nothing broke**

```bash
bun run test:bail 2>&1 | tail -5
```

Expected: 0 failures.

- [ ] **Step 4: Check Phase 5 invariant tests**

```bash
bun test test/unit/agents/phase5-invariants.test.ts --timeout=10000
```

Expected: 6/7 tests now pass (agent-swap.ts deleted, execution.ts no longer imports it). Only the schema test still fails.

- [ ] **Step 5: Commit**

```bash
git rm src/execution/escalation/agent-swap.ts
git add src/pipeline/stages/execution.ts
git commit -m "refactor(agents): delete agent-swap.ts — logic absorbed by AgentManager (ADR-012 Phase 5)"
```

---

### Task 7: Remove `context.v2.fallback` from config schema

**Files:**
- Modify: `src/config/schemas.ts`
- Modify: `src/config/agent-migration.ts` (update comment)

The `applyAgentConfigMigration` shim already migrates `context.v2.fallback → agent.fallback` before `safeParse()`. Removing the schema field means configs that haven't migrated will simply have their `context.v2.fallback` key silently stripped by Zod's `strip()` behaviour — which is correct, because the shim already promoted it.

- [ ] **Step 1: Write the failing schema test**

Add to `test/unit/config/schemas.test.ts` (or create it):

```typescript
import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "../../../src/config/schemas";

describe("config schema — context.v2 no longer has fallback field", () => {
  test("context.v2 schema does not accept fallback key", () => {
    const result = NaxConfigSchema.safeParse({
      context: {
        v2: {
          fallback: { enabled: true, map: { claude: ["codex"] }, maxHopsPerStory: 1, onQualityFailure: false },
        },
      },
    });
    // Zod strips unknown keys — result.data should not have context.v2.fallback
    expect(result.success).toBe(true);
    expect((result.data?.context?.v2 as Record<string, unknown>)?.fallback).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
bun test test/unit/config/schemas.test.ts --timeout=10000
```

Expected: FAIL — `context.v2.fallback` is currently defined in schema and gets parsed.

- [ ] **Step 3: Remove `fallback: ContextV2FallbackConfigSchema` from `src/config/schemas.ts`**

Find in `src/config/schemas.ts`:

```typescript
    /** Availability-fallback configuration (Phase 5.5+) */
    fallback: ContextV2FallbackConfigSchema,
```

Delete those two lines. Also find and remove the `ContextV2FallbackConfigSchema` variable definition (the `z.object({...}).default(...)` block at lines ~461–486). Also remove it from the `DEFAULT_CONFIG` derivation if it appears there explicitly.

Also find the `context.v2.fallback` default in the schema (line ~637):

```typescript
    fallback: { enabled: false, onQualityFailure: false, maxHopsPerStory: 2, map: {} },
```

Remove that line from the v2 defaults object.

- [ ] **Step 4: Update migration shim comment in `src/config/agent-migration.ts`**

Find:

```typescript
 * Shim lives for 3 canary releases, then removed in Phase 6.
```

Replace with:

```typescript
 * Shim lives until Phase 6 (3 canary releases from Phase 5 landing).
 * context.v2.fallback schema field removed in Phase 5; shim still accepts the
 * legacy key so existing config files continue to work without a hard error.
```

- [ ] **Step 5: Run schema test and full suite**

```bash
bun test test/unit/config/schemas.test.ts --timeout=10000
bun run test:bail 2>&1 | tail -5
```

Expected: schema test PASS, full suite 0 failures.

- [ ] **Step 6: Run Phase 5 invariant tests**

```bash
bun test test/unit/agents/phase5-invariants.test.ts --timeout=10000
```

Expected: all 7 PASS.

- [ ] **Step 7: Commit**

```bash
git add src/config/schemas.ts src/config/agent-migration.ts test/unit/config/schemas.test.ts
git commit -m "refactor(config): remove context.v2.fallback schema field; migration shim still accepts legacy key (ADR-012 Phase 5)"
```

---

### Task 8: Update integration tests

**Files:**
- Modify: `test/integration/execution/agent-swap.test.ts`

The integration tests currently mock `_executionDeps.shouldAttemptSwap`, `_executionDeps.resolveSwapTarget`, and `_executionDeps.rebuildForSwap`. After Phase 5 these don't exist — the swap policy lives in `AgentManager`. Tests must now wire `ctx.agentManager` as a real `AgentManager` with mocked registry.

- [ ] **Step 1: Run the existing integration tests to see how many fail**

```bash
bun test test/integration/execution/agent-swap.test.ts --timeout=30000 2>&1 | tail -20
```

Note which tests fail.

- [ ] **Step 2: Update the test file**

Replace the entire `agent-swap.test.ts` with the following:

```typescript
/**
 * Integration test: agent-swap via execution stage (ADR-012 Phase 5)
 *
 * After Phase 5, execution.ts delegates swap policy to AgentManager.runWithFallback().
 * Tests wire a real AgentManager (with config.agent.fallback.enabled=true) and
 * mock agents via ctx.agentGetFn.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ContextOrchestrator } from "../../../src/context/engine/orchestrator";
import type { AdapterFailure, ContextBundle, ContextProviderResult, IContextProvider } from "../../../src/context/engine/types";
import { DEFAULT_CONFIG } from "../../../src/config";
import type { NaxConfig } from "../../../src/config";
import { AgentManager } from "../../../src/agents/manager";
import { executionStage, _executionDeps } from "../../../src/pipeline/stages/execution";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { PRD, UserStory } from "../../../src/prd";
import type { AgentAdapter } from "../../../src/agents/types";
import { _gitDeps } from "../../../src/utils/git";

const origGetAgent = _executionDeps.getAgent;
const origValidateAgent = _executionDeps.validateAgentForTier;
const origDetectMerge = _executionDeps.detectMergeConflict;
const origRebuildForAgent = _executionDeps.rebuildForAgent;
const origGitSpawn = _gitDeps.spawn;

afterEach(() => {
  _executionDeps.getAgent = origGetAgent;
  _executionDeps.validateAgentForTier = origValidateAgent;
  _executionDeps.detectMergeConflict = origDetectMerge;
  _executionDeps.rebuildForAgent = origRebuildForAgent;
  _gitDeps.spawn = origGitSpawn;
  mock.restore();
});

const QUOTA_FAILURE: AdapterFailure = {
  category: "availability",
  outcome: "fail-quota",
  message: "daily quota exhausted",
  retriable: false,
};

function makeProvider(): IContextProvider {
  const result: ContextProviderResult = {
    chunks: [{ id: "chunk:abc", kind: "feature", scope: "project", role: ["all"], content: "Rule", tokens: 20, rawScore: 0.8 }],
  };
  return { id: "p1", kind: "feature", fetch: async () => result };
}

async function makeBundle(): Promise<ContextBundle> {
  return new ContextOrchestrator([makeProvider()]).assemble({
    storyId: "US-001", repoRoot: "/repo", packageDir: "/repo", stage: "run", role: "implementer", budgetTokens: 8000, providerIds: [], agentId: "claude",
  });
}

function makeStory(): UserStory {
  return { id: "US-001", title: "Test Story", description: "Test", acceptanceCriteria: [], tags: [], dependencies: [], status: "in-progress", passes: false, escalations: [], attempts: 1 };
}

function makePRD(): PRD {
  return { project: "test", feature: "my-feature", branchName: "test-branch", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), userStories: [makeStory()] };
}

function makeConfig(swapEnabled: boolean): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    autoMode: { defaultAgent: "claude" },
    models: {
      claude: { fast: "claude-haiku-4-5", balanced: "claude-sonnet-4-5", powerful: "claude-opus-4-5" },
      codex: { fast: "codex-fast", balanced: "codex-balanced", powerful: "codex-powerful" },
    },
    agent: {
      ...DEFAULT_CONFIG.agent,
      fallback: {
        enabled: swapEnabled,
        onQualityFailure: false,
        maxHopsPerStory: 1,
        map: { claude: ["codex"] },
        rebuildContext: false,
      },
    },
  } as unknown as NaxConfig;
}

function makeCtx(config: NaxConfig, bundle: ContextBundle, manager: AgentManager): PipelineContext {
  return {
    config,
    prd: makePRD(),
    story: makeStory(),
    stories: [makeStory()],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", agent: "claude", reasoning: "" },
    rootConfig: { ...DEFAULT_CONFIG, autoMode: { defaultAgent: "claude" }, models: config.models } as unknown as NaxConfig,
    workdir: "/tmp/test",
    projectDir: "/tmp/test",
    prompt: "Do something useful",
    hooks: {} as PipelineContext["hooks"],
    contextBundle: bundle,
    agentManager: manager,
  } as unknown as PipelineContext;
}

function makeFailingAgent(name: string): AgentAdapter {
  return {
    name,
    capabilities: { supportedTiers: ["fast", "balanced", "powerful"] },
    run: mock(async () => ({ success: false, exitCode: 1, output: "", stderr: "quota exceeded", rateLimited: false, durationMs: 100, estimatedCost: 0.0, adapterFailure: QUOTA_FAILURE })),
    closeSession: mock(async () => {}),
    closePhysicalSession: mock(async () => {}),
    deriveSessionName: mock(() => `nax-session-${name}`),
  } as unknown as AgentAdapter;
}

function makeSucceedingAgent(name: string): AgentAdapter {
  return {
    name,
    capabilities: { supportedTiers: ["fast", "balanced", "powerful"] },
    run: mock(async () => ({ success: true, exitCode: 0, output: "done", stderr: "", rateLimited: false, durationMs: 200, estimatedCost: 0.02 })),
    closeSession: mock(async () => {}),
    closePhysicalSession: mock(async () => {}),
    deriveSessionName: mock(() => `nax-session-${name}`),
  } as unknown as AgentAdapter;
}

describe("execution stage — agent-swap via AgentManager (Phase 5)", () => {
  let bundle: ContextBundle;

  beforeEach(async () => {
    bundle = await makeBundle();
    _executionDeps.validateAgentForTier = mock(() => true);
    _executionDeps.detectMergeConflict = mock(() => false);
    _executionDeps.rebuildForAgent = mock((prior, _agentId, _failure, _storyId) => prior);
    _gitDeps.spawn = mock(() => ({ exited: Promise.resolve(1), stdout: null, stderr: null } as unknown as ReturnType<typeof Bun.spawn>));
  });

  test("swaps agent and returns continue when swap agent succeeds", async () => {
    const primaryAgent = makeFailingAgent("claude");
    const swapAgent = makeSucceedingAgent("codex");
    const config = makeConfig(true);
    const manager = new AgentManager(config);

    const ctx = makeCtx(config, bundle, manager);
    ctx.agentGetFn = (name: string) => (name === "codex" ? swapAgent : primaryAgent) as AgentAdapter;

    const result = await executionStage.execute(ctx);

    expect(result).toEqual({ action: "continue" });
    expect(ctx.agentSwapCount).toBe(1);
    expect((swapAgent.run as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
  });

  test("fallback disabled — returns escalate immediately on failure", async () => {
    const primaryAgent = makeFailingAgent("claude");
    const config = makeConfig(false);
    const manager = new AgentManager(config);

    const ctx = makeCtx(config, bundle, manager);
    ctx.agentGetFn = (_name: string) => primaryAgent as AgentAdapter;

    const result = await executionStage.execute(ctx);

    expect(result).toEqual({ action: "escalate" });
    expect(ctx.agentSwapCount).toBe(0);
  });

  test("agentFallbacks populated with hop record on swap", async () => {
    const primaryAgent = makeFailingAgent("claude");
    const swapAgent = makeSucceedingAgent("codex");
    const config = makeConfig(true);
    const manager = new AgentManager(config);

    const ctx = makeCtx(config, bundle, manager);
    ctx.agentGetFn = (name: string) => (name === "codex" ? swapAgent : primaryAgent) as AgentAdapter;

    await executionStage.execute(ctx);

    expect(ctx.agentFallbacks).toHaveLength(1);
    expect(ctx.agentFallbacks![0].priorAgent).toBe("claude");
    expect(ctx.agentFallbacks![0].newAgent).toBe("codex");
    expect(ctx.agentFallbacks![0].category).toBe("availability");
    expect(ctx.agentFallbacks![0].outcome).toBe("fail-quota");
    expect(ctx.agentFallbacks![0].hop).toBe(1);
  });

  test("all swap candidates exhausted — returns escalate", async () => {
    const primaryAgent = makeFailingAgent("claude");
    const swapAgent = makeFailingAgent("codex");
    const config = makeConfig(true);
    const manager = new AgentManager(config);

    const ctx = makeCtx(config, bundle, manager);
    ctx.agentGetFn = (name: string) => (name === "codex" ? swapAgent : primaryAgent) as AgentAdapter;

    const result = await executionStage.execute(ctx);

    expect(result).toEqual({ action: "escalate" });
  });

  test("context bundle updated to rebuilt bundle on successful swap", async () => {
    const primaryAgent = makeFailingAgent("claude");
    const swapAgent = makeSucceedingAgent("codex");
    const config = makeConfig(true);
    const manager = new AgentManager(config);

    // Make rebuildForAgent return a distinct bundle
    const rebuiltBundle = { ...bundle, manifest: { ...bundle.manifest, requestId: "rebuilt-123" } };
    _executionDeps.rebuildForAgent = mock(() => rebuiltBundle as unknown as ContextBundle);

    const ctx = makeCtx(config, bundle, manager);
    ctx.agentGetFn = (name: string) => (name === "codex" ? swapAgent : primaryAgent) as AgentAdapter;

    await executionStage.execute(ctx);

    expect(ctx.contextBundle).toBe(rebuiltBundle);
  });
});
```

- [ ] **Step 3: Run to confirm all pass**

```bash
bun test test/integration/execution/agent-swap.test.ts --timeout=30000 2>&1 | tail -10
```

Expected: all tests PASS.

- [ ] **Step 4: Run full suite**

```bash
bun run test:bail 2>&1 | tail -5
```

Expected: 0 failures.

- [ ] **Step 5: Commit**

```bash
git add test/integration/execution/agent-swap.test.ts
git commit -m "test(execution): update agent-swap integration tests for Phase 5 (real AgentManager, no swap-dep mocks)"
```

---

### Task 9: Final gate validation

**Files:** No changes — verification only.

- [ ] **Step 1: Run Phase 5 invariant tests**

```bash
bun test test/unit/agents/phase5-invariants.test.ts --timeout=10000
```

Expected: all 7 PASS.

- [ ] **Step 2: Run full test suite**

```bash
bun run test:bail 2>&1 | tail -5
```

Expected: 0 failures.

- [ ] **Step 3: Verify `execution.ts` LOC reduction**

```bash
wc -l src/pipeline/stages/execution.ts
```

Expected: ≤340 lines (was ~464 — reduction of ≥120 per ADR-012 acceptance criterion).

- [ ] **Step 4: Verify `agent-swap.ts` is deleted**

```bash
ls src/execution/escalation/
```

Expected: `agent-swap.ts` not present.

- [ ] **Step 5: Verify no remaining `shouldAttemptSwap`/`resolveSwapTarget` in `src/`**

```bash
grep -r "shouldAttemptSwap\|resolveSwapTarget\|ContextV2FallbackConfigSchema" src/ --include="*.ts"
```

Expected: zero results.

- [ ] **Step 6: Run typecheck and lint**

```bash
bun run typecheck && bun run lint
```

Expected: no errors.

- [ ] **Step 7: Commit final gate**

```bash
git commit --allow-empty -m "chore(agents): Phase 5 gate passed — all invariants green"
```

---

## ADR-012 Phase 5 Acceptance Criteria Checklist

| # | Criterion | Task |
|:--|:----------|:-----|
| ✅ | `execution.ts` LOC reduced ≥120 | Task 4 |
| ✅ | `agent-swap.ts` deleted | Task 6 |
| ✅ | `context.v2.fallback` schema entry removed | Task 7 |
| ✅ | Migration shim still accepts legacy key | Task 7 |
| ✅ | `agentManager.reset()` called at story boundary | Task 5 |
| ✅ | `AgentFallbackRecord.costUsd` populated per hop | Already done in Phase 4 |
| ✅ | Phase 5 invariant tests all pass | Task 9 |
