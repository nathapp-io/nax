/**
 * AC-41 — fallback observability: execution stage records AgentFallbackHop
 * in ctx.agentFallbacks whenever an agent-swap is triggered.
 *
 * Each hop captures storyId, priorAgent, newAgent, category, outcome, and the
 * 1-indexed hop number so downstream collectors (tracker.ts) can surface the
 * data without re-reading ctx.agentSwapCount.
 *
 * Post-Phase-5 refactor: fallback records come from agentManager.runWithFallback()
 * rather than the inline Phase 5.5 loop. Tests use a mock agentManager.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { _executionDeps, executionStage } from "../../../../src/pipeline/stages/execution";
import { _buildHopCallbackDeps } from "../../../../src/operations/build-hop-callback";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { PRD, UserStory } from "../../../../src/prd";
import type { ContextBundle } from "../../../../src/context/engine/types";
import type { IAgentManager, AgentRunRequest, AgentRunOutcome } from "../../../../src/agents/manager-types";
import { makeSparseNaxConfig, makeSessionManager } from "../../../helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "US-001",
    title: "Test story",
    description: "desc",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "in-progress",
    passes: false,
    attempts: 1,
    escalations: [],
    ...overrides,
  };
}

function makeBundle(): ContextBundle {
  return {
    pushMarkdown: "context",
    digest: "abc123",
    packedChunks: [],
    pullTools: [],
    manifest: {
      requestId: "r1",
      stage: "execution",
      totalBudgetTokens: 0,
      usedTokens: 0,
      includedChunks: [],
      excludedChunks: [],
      floorItems: [],
      digestTokens: 0,
      buildMs: 0,
    },
  } as unknown as ContextBundle;
}

function makeAgentManager(outcome: Partial<AgentRunOutcome> = {}): IAgentManager {
  const mgr: IAgentManager = {
    getDefault: () => "claude",
    isUnavailable: () => false,
    markUnavailable: () => {},
    reset: () => {},
    validateCredentials: async () => {},
    events: { on: () => {} },
    resolveFallbackChain: () => [],
    shouldSwap: () => false,
    nextCandidate: () => null,
    runWithFallback: async (req: AgentRunRequest): Promise<AgentRunOutcome> => {
      if (req.executeHop) {
        const { result, bundle, prompt } = await req.executeHop("claude", req.bundle, undefined, req.runOptions);
        return { result, fallbacks: outcome.fallbacks ?? [], finalBundle: bundle, finalPrompt: prompt };
      }
      return {
        result: { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCostUsd: 0 },
        fallbacks: outcome.fallbacks ?? [],
        finalBundle: req.bundle,
        finalPrompt: req.runOptions.prompt,
        ...outcome,
      };
    },
    completeWithFallback: async () => ({ result: { output: "", costUsd: 0, source: "fallback" as const }, fallbacks: [] }),
    run: async (req) => {
      const o = await mgr.runWithFallback(req);
      return { ...o.result, agentFallbacks: o.fallbacks };
    },
    complete: async () => ({ output: "", costUsd: 0, source: "fallback" as const }),
    getAgent: () => undefined,
  };
  return mgr;
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const story = makeStory();
  const config = makeSparseNaxConfig({ agent: { default: "claude" }, execution: { sessionTimeoutSeconds: 30, verificationTimeoutSeconds: 60 }, models: { claude: { fast: "claude-haiku", balanced: "claude-sonnet", powerful: "claude-opus" }, codex: { fast: "codex-mini", balanced: "codex-full", powerful: "codex-full" } }, quality: { requireTests: false, commands: { test: "bun test" } } });
  return {
    config,
    rootConfig: config,
    prd: { project: "p", feature: "f", branchName: "b", createdAt: "", updatedAt: "", userStories: [story] } as PRD,
    story,
    stories: [story],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    workdir: "/repo",
    hooks: {},
    prompt: "Do the thing",
    contextBundle: makeBundle(),
    agentManager: makeAgentManager(),
    ...overrides,
  } as unknown as PipelineContext;
}

// ─────────────────────────────────────────────────────────────────────────────
// Saved deps for restoration
// ─────────────────────────────────────────────────────────────────────────────

const origGetAgent = _executionDeps.getAgent;
const origValidate = _executionDeps.validateAgentForTier;
const origDetect = _executionDeps.detectMergeConflict;
const origWriteRebuildManifest = _buildHopCallbackDeps.writeRebuildManifest;
const origRebuildForAgent = _buildHopCallbackDeps.rebuildForAgent;

afterEach(() => {
  _executionDeps.getAgent = origGetAgent;
  _executionDeps.validateAgentForTier = origValidate;
  _executionDeps.detectMergeConflict = origDetect;
  _buildHopCallbackDeps.writeRebuildManifest = origWriteRebuildManifest;
  _buildHopCallbackDeps.rebuildForAgent = origRebuildForAgent;
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-41: execution stage records AgentFallbackHop
// ─────────────────────────────────────────────────────────────────────────────

describe("execution stage — AC-41 fallback observability", () => {
  test("records hop in ctx.agentFallbacks when swap succeeds", async () => {
    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.detectMergeConflict = () => false;

    // Manager reports one successful swap hop
    const manager = makeAgentManager({
      result: { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCostUsd: 0 },
      fallbacks: [
        {
          storyId: "US-001",
          priorAgent: "claude",
          newAgent: "codex",
          outcome: "fail-quota",
          category: "availability",
          hop: 1,
          timestamp: new Date().toISOString(),
          costUsd: 0,
        },
      ],
    });

    _executionDeps.getAgent = () =>
      ({
        name: "claude",
        capabilities: { supportedTiers: ["fast"] },
        run: async () => ({ success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0 }),
      }) as unknown as ReturnType<typeof _executionDeps.getAgent>;

    const ctx = makeCtx({ agentManager: manager });
    await executionStage.execute(ctx);

    expect(ctx.agentFallbacks).toHaveLength(1);
    const hop = ctx.agentFallbacks![0];
    expect(hop.storyId).toBe("US-001");
    expect(hop.priorAgent).toBe("claude");
    expect(hop.newAgent).toBe("codex");
    expect(hop.category).toBe("availability");
    expect(hop.outcome).toBe("fail-quota");
    expect(hop.hop).toBe(1);
  });

  test("records hop in ctx.agentFallbacks even when swap also fails", async () => {
    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.detectMergeConflict = () => false;

    // Manager reports one failed swap hop, final result is failure
    const manager = makeAgentManager({
      result: { success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 0, estimatedCostUsd: 0 },
      fallbacks: [
        {
          storyId: "US-001",
          priorAgent: "claude",
          newAgent: "codex",
          outcome: "fail-service-down",
          category: "availability",
          hop: 1,
          timestamp: new Date().toISOString(),
          costUsd: 0,
        },
      ],
    });

    _executionDeps.getAgent = () =>
      ({
        name: "claude",
        capabilities: { supportedTiers: ["fast"] },
        run: async () => ({ success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 0 }),
      }) as unknown as ReturnType<typeof _executionDeps.getAgent>;

    const ctx = makeCtx({ agentManager: manager });
    await executionStage.execute(ctx);

    expect(ctx.agentFallbacks).toHaveLength(1);
    const hop = ctx.agentFallbacks![0];
    expect(hop.newAgent).toBe("codex");
    expect(hop.outcome).toBe("fail-service-down");
    expect(hop.hop).toBe(1);
  });

  test("does not push to agentFallbacks when no fallbacks occurred", async () => {
    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.detectMergeConflict = () => false;

    // Manager reports no fallbacks (primary succeeded)
    const manager = makeAgentManager({
      result: { success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 0, estimatedCostUsd: 0 },
      fallbacks: [],
    });

    _executionDeps.getAgent = () =>
      ({
        name: "claude",
        capabilities: { supportedTiers: ["fast"] },
        run: async () => ({ success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 0 }),
      }) as unknown as ReturnType<typeof _executionDeps.getAgent>;

    const ctx = makeCtx({ agentManager: manager });
    await executionStage.execute(ctx);

    expect(ctx.agentFallbacks ?? []).toHaveLength(0);
  });

  test("hop number reflects correct hop count across multiple swaps", async () => {
    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.detectMergeConflict = () => false;

    // Manager reports two hops — pre-existing hop in ctx + new hop from manager
    const manager = makeAgentManager({
      result: { success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 0, estimatedCostUsd: 0 },
      fallbacks: [
        {
          storyId: "US-001",
          priorAgent: "claude",
          newAgent: "codex",
          outcome: "fail-rate-limit",
          category: "availability",
          hop: 2,
          timestamp: new Date().toISOString(),
          costUsd: 0,
        },
      ],
    });

    _executionDeps.getAgent = () =>
      ({
        name: "claude",
        capabilities: { supportedTiers: ["fast"] },
        run: async () => ({ success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 0 }),
      }) as unknown as ReturnType<typeof _executionDeps.getAgent>;

    const ctx = makeCtx({ agentManager: manager });
    await executionStage.execute(ctx);

    // The new hop should be hop=2
    expect(ctx.agentFallbacks).toHaveLength(1);
    expect(ctx.agentFallbacks![0].hop).toBe(2);
  });

  test("writes rebuild-manifest event when executeHop triggers rebuildForAgent", async () => {
    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.detectMergeConflict = () => false;

    const writes: Array<Record<string, unknown>> = [];
    _buildHopCallbackDeps.writeRebuildManifest = async (_projectDir, _featureId, _storyId, entry) => {
      writes.push(entry as unknown as Record<string, unknown>);
    };

    const rebuildBundle: ContextBundle = {
      ...makeBundle(),
      manifest: {
        ...makeBundle().manifest,
        requestId: "req-rebuild",
        rebuildInfo: {
          priorAgentId: "claude",
          newAgentId: "codex",
          failureCategory: "availability",
          failureOutcome: "fail-quota",
          priorChunkIds: ["chunk:a"],
          newChunkIds: ["chunk:a", "failure-note:1"],
          chunkIdMap: [{ priorChunkId: "chunk:a", newChunkId: "chunk:a" }],
        },
      },
    } as ContextBundle;

    // Override rebuildForAgent to return the bundle with rebuildInfo
    _buildHopCallbackDeps.rebuildForAgent = () => rebuildBundle;

    // sessionManager provides openSession/closeSession for buildHopCallback
    const sessionManager = makeSessionManager();

    // Manager delegates to executeHop for a swap hop (failure is set)
    const swapFallbacks = [
      {
        storyId: "US-001",
        priorAgent: "claude",
        newAgent: "codex",
        outcome: "fail-quota" as const,
        category: "availability" as const,
        hop: 1,
        timestamp: new Date().toISOString(),
        costUsd: 0,
      },
    ];
    const manager = Object.assign(makeAgentManager({ fallbacks: swapFallbacks }), {
      runAsSession: mock(async () => ({
        output: "",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      })),
    });
    manager.runWithFallback = async (req: AgentRunRequest): Promise<AgentRunOutcome> => {
      if (req.executeHop) {
        const failure = { category: "availability" as const, outcome: "fail-quota" as const, message: "quota", retriable: false };
        const { result, bundle, prompt } = await req.executeHop("codex", req.bundle, failure, req.runOptions);
        return { result, fallbacks: swapFallbacks, finalBundle: bundle, finalPrompt: prompt };
      }
      return { result: { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCostUsd: 0 }, fallbacks: [] };
    };

    _executionDeps.getAgent = (agentId: string) =>
      ({
        name: agentId,
        capabilities: { supportedTiers: ["fast"] },
        run: async () => ({ success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0 }),
      }) as unknown as ReturnType<typeof _executionDeps.getAgent>;

    const ctx = makeCtx({ projectDir: "/repo", agentManager: manager, sessionManager });
    await executionStage.execute(ctx);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.requestId).toBe("req-rebuild");
    expect(writes[0]?.stage).toBe("execution");
  });
});
