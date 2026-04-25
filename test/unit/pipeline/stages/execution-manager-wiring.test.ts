import { afterEach, describe, expect, mock, test } from "bun:test";
import { executionStage, _executionDeps } from "../../../../src/pipeline/stages/execution";
import type { PipelineContext } from "../../../../src/pipeline/types";
import { DEFAULT_CONFIG } from "../../../../src/config";
import type { NaxConfig } from "../../../../src/config";
import type { IAgentManager } from "../../../../src/agents/manager-types";
import { ContextOrchestrator } from "../../../../src/context/engine";
import type { ContextBundle } from "../../../../src/context/engine";
import { makeAgentAdapter } from "../../../../test/helpers";

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
    rootConfig: { ...DEFAULT_CONFIG, agent: { default: "claude" }, models: config.models } as NaxConfig,
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
    const config = { ...DEFAULT_CONFIG, agent: { default: "claude" } } as NaxConfig;

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
        const { result, bundle: b, prompt } = await request.executeHop!("claude", request.bundle, undefined, request.runOptions);
        return { result, fallbacks: [], finalBundle: b, finalPrompt: prompt };
      }),
      completeWithFallback: async () => ({ result: { output: "", costUsd: 0, source: "fallback" as const }, fallbacks: [] }),
      run: async (request) => {
        const outcome = await manager.runWithFallback(request);
        return { ...outcome.result, agentFallbacks: outcome.fallbacks };
      },
      complete: async () => ({ output: "", costUsd: 0, source: "fallback" as const }),
      getAgent: () => undefined,
    };

    const successAdapter = makeAgentAdapter({
      name: "claude",
      displayName: "Claude",
      binary: "claude",
      capabilities: { supportedTiers: ["fast", "balanced", "powerful"], maxContextTokens: 100000, features: new Set() },
      run: mock(async () => ({ success: true, exitCode: 0, output: "done", rateLimited: false, durationMs: 100, estimatedCost: 0.01 })),
    });

    _executionDeps.getAgent = mock(() => successAdapter);
    _executionDeps.validateAgentForTier = mock(() => true);
    _executionDeps.detectMergeConflict = mock(() => false);

    const result = await executionStage.execute(makeCtx(config, bundle, manager));

    expect(runWithFallbackCalled).toBe(true);
    expect(result).toEqual({ action: "continue" });
  });
});
