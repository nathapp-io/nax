/**
 * Integration test: agent-swap via execution stage (Issue #474 / Phase 5.5)
 *
 * Simulates an availability failure from the primary agent (fail-quota) and
 * verifies that the execution stage:
 *   - Calls rebuildForAgent to produce a rebuilt bundle
 *   - The rebuilt bundle carries rebuildInfo (priorAgentId, newAgentId)
 *   - A failure-note chunk is present in the rebuilt bundle
 *   - The retry runs under the new agent
 *   - Stage returns { action: "continue" } when the swap agent succeeds
 *   - Stage returns { action: "escalate" } when the swap agent also fails
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ContextOrchestrator } from "../../../src/context/engine/orchestrator";
import type { AdapterFailure, ContextBundle, ContextProviderResult, IContextProvider } from "../../../src/context/engine/types";
import { DEFAULT_CONFIG } from "../../../src/config";
import type { NaxConfig } from "../../../src/config";
import { AgentManager } from "../../../src/agents/manager";
import { SessionFailureError } from "../../../src/agents/types";

import { _buildHopCallbackDeps } from "../../../src/operations/build-hop-callback";
import { executionStage, _executionDeps } from "../../../src/pipeline/stages/execution";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { PRD, UserStory } from "../../../src/prd";
import type { AgentAdapter } from "../../../src/agents/types";
import type { AgentRegistry } from "../../../src/agents/registry";
import { _gitDeps } from "../../../src/utils/git";
import { makeMockAgentManager, makeSessionManager } from "../../helpers";

// Saved deps for restoration
const origGetAgent = _executionDeps.getAgent;
const origValidateAgent = _executionDeps.validateAgentForTier;
const origDetectMerge = _executionDeps.detectMergeConflict;
const origGitSpawn = _gitDeps.spawn;
const origWriteRebuildManifest = _buildHopCallbackDeps.writeRebuildManifest;

afterEach(() => {
  _executionDeps.getAgent = origGetAgent;
  _executionDeps.validateAgentForTier = origValidateAgent;
  _executionDeps.detectMergeConflict = origDetectMerge;
  _gitDeps.spawn = origGitSpawn;
  _buildHopCallbackDeps.writeRebuildManifest = origWriteRebuildManifest;
});

// Helpers

const QUOTA_FAILURE: AdapterFailure = {
  category: "availability",
  outcome: "fail-quota",
  message: "daily quota exhausted",
  retriable: false,
};

function makeProvider(): IContextProvider {
  const result: ContextProviderResult = {
    chunks: [
      {
        id: "chunk:abc",
        kind: "feature",
        scope: "project",
        role: ["all"],
        content: "Feature rule: use async/await.",
        tokens: 20,
        rawScore: 0.8,
      },
    ],
  };
  return { id: "p1", kind: "feature", fetch: async () => result };
}

async function makeBundle(): Promise<ContextBundle> {
  const orch = new ContextOrchestrator([makeProvider()]);
  return orch.assemble({
    storyId: "US-001",
    repoRoot: "/repo",
    packageDir: "/repo",
    stage: "run",
    role: "implementer",
    budgetTokens: 8_000,
    providerIds: [],
    agentId: "claude",
  });
}

function makeStory(): UserStory {
  return {
    id: "US-001",
    title: "Test Story",
    description: "Test",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "in-progress",
    passes: false,
    escalations: [],
    attempts: 1,
  };
}

function makePRD(): PRD {
  return {
    project: "test",
    feature: "my-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [makeStory()],
  };
}

function makeConfig(swapEnabled: boolean): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    agent: {
      ...(DEFAULT_CONFIG.agent ?? {}),
      default: "claude",
      fallback: {
        enabled: swapEnabled,
        onQualityFailure: false,
        maxHopsPerStory: 1,
        map: { claude: ["codex"] },
      },
    },
  } as unknown as NaxConfig;
}

function makeCtx(config: NaxConfig, bundle: ContextBundle): PipelineContext {
  // Lazy registry: delegates getAgent() to ctx.agentGetFn so tests can override it after construction.
  const ctx = {
    config,
    prd: makePRD(),
    story: makeStory(),
    stories: [makeStory()],
    routing: {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      agent: "claude",
      reasoning: "",
    },
    rootConfig: { ...DEFAULT_CONFIG, agent: { default: "claude" }, models: config.models } as unknown as NaxConfig,
    workdir: "/tmp/test",
    projectDir: "/tmp/test",
    prompt: "Do something useful",
    hooks: {} as PipelineContext["hooks"],
    contextBundle: bundle,
  } as unknown as PipelineContext;

  const lazyRegistry: AgentRegistry = {
    getAgent: (name: string) => (ctx.agentGetFn ? ctx.agentGetFn(name) as AgentAdapter | undefined : undefined),
    getInstalledAgents: async () => [],
    checkAgentHealth: async () => [],
    protocol: "acp",
  };
  ctx.agentManager = new AgentManager(config, lazyRegistry);
  return ctx;
}

function makeFailingAgent(name: string): AgentAdapter {
  const handle = { id: `mock-session-${name}`, agentName: name };
  return {
    name,
    capabilities: { supportedTiers: ["fast", "balanced", "powerful"] },
    openSession: mock(async () => handle),
    sendTurn: mock(async () => {
      throw new SessionFailureError("quota exceeded", QUOTA_FAILURE);
    }),
    closeSession: mock(async () => {}),
    closePhysicalSession: mock(async () => {}),
  } as unknown as AgentAdapter;
}

function makeSucceedingAgent(name: string): AgentAdapter {
  const handle = { id: `mock-session-${name}`, agentName: name };
  return {
    name,
    capabilities: { supportedTiers: ["fast", "balanced", "powerful"] },
    openSession: mock(async () => handle),
    sendTurn: mock(async () => ({
      output: "done",
      tokenUsage: { inputTokens: 10, outputTokens: 20 },
      cost: { total: 0.02 },
      internalRoundTrips: 1,
    })),
    closeSession: mock(async () => {}),
    closePhysicalSession: mock(async () => {}),
  } as unknown as AgentAdapter;
}

// Tests

describe("execution stage — agent-swap on availability failure (Phase 5.5)", () => {
  let bundle: ContextBundle;

  beforeEach(async () => {
    bundle = await makeBundle();
    _executionDeps.validateAgentForTier = mock(() => true);
    _executionDeps.detectMergeConflict = mock(() => false);
    // Prevent autoCommitIfDirty from spawning real git processes against /tmp/test
    _gitDeps.spawn = mock(() => ({ exited: Promise.resolve(1), stdout: null, stderr: null } as unknown as ReturnType<typeof Bun.spawn>));
  });

  test("swaps agent and returns continue when swap agent succeeds", async () => {
    const primaryAgent = makeFailingAgent("claude");
    const config = makeConfig(true);
    const ctx = makeCtx(config, bundle);
    const hopAgents: string[] = [];

    ctx.sessionManager = makeSessionManager();
    ctx.agentManager = makeMockAgentManager({
      runAsSessionFn: async (agentName) => {
        hopAgents.push(agentName);
        return {
          output: "done",
          tokenUsage: { inputTokens: 10, outputTokens: 20 },
          cost: { total: 0.02 },
          internalRoundTrips: 1,
        };
      },
      runWithFallbackFn: async (req) => {
        if (!req.executeHop) {
          return {
            result: { success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 0, estimatedCost: 0, adapterFailure: QUOTA_FAILURE, agentFallbacks: [] },
            fallbacks: [],
          };
        }
        const swapped = await req.executeHop("codex", req.bundle, QUOTA_FAILURE, req.runOptions);
        return {
          result: { ...swapped.result, agentFallbacks: [] },
          fallbacks: [{ storyId: "US-001", priorAgent: "claude", newAgent: "codex", outcome: "fail-quota", category: "availability", hop: 1, timestamp: new Date().toISOString(), costUsd: 0 }],
        };
      },
    });

    _executionDeps.getAgent = mock((name: string) => (name === "codex" ? makeSucceedingAgent("codex") : primaryAgent));
    ctx.agentGetFn = (name: string) => (name === "codex" ? makeSucceedingAgent("codex") : primaryAgent) as AgentAdapter;

    const result = await executionStage.execute(ctx);

    expect(result).toEqual({ action: "continue" });
    expect(ctx.agentSwapCount).toBe(1);
    expect(hopAgents).toEqual(["codex"]);
  });

  test("rebuilt bundle carries rebuildInfo with correct agents and failure", async () => {
    const primaryAgent = makeFailingAgent("claude");
    const config = makeConfig(true);
    const ctx = makeCtx(config, bundle);

    // Phase C: bundle rebuild runs inside buildHopCallback which requires sessionManager +
    // runAsSession. Mock runWithFallback to drive executeHop directly with QUOTA_FAILURE.
    ctx.sessionManager = makeSessionManager();
    _buildHopCallbackDeps.writeRebuildManifest = mock(async () => {});
    ctx.agentManager = makeMockAgentManager({
      runAsSessionFn: async () => ({
        output: "done",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 1,
      }),
      runWithFallbackFn: async (req) => {
        if (req.executeHop) {
          const { result } = await req.executeHop("codex", req.bundle, QUOTA_FAILURE, req.runOptions);
          return {
            result: { ...result, agentFallbacks: [] },
            fallbacks: [{ storyId: "US-001", priorAgent: "claude", newAgent: "codex", outcome: "fail-quota", category: "availability", hop: 1, timestamp: new Date().toISOString(), costUsd: 0 }],
          };
        }
        return { result: { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCost: 0, agentFallbacks: [] }, fallbacks: [] };
      },
    });

    _executionDeps.getAgent = mock((_name: string) => primaryAgent);
    ctx.agentGetFn = (_name: string) => primaryAgent as AgentAdapter;

    await executionStage.execute(ctx);

    const rebuildInfo = ctx.contextBundle?.manifest.rebuildInfo;
    expect(rebuildInfo).toBeDefined();
    expect(rebuildInfo?.priorAgentId).toBe("claude");
    expect(rebuildInfo?.newAgentId).toBe("codex");
    expect(rebuildInfo?.failureCategory).toBe("availability");
    expect(rebuildInfo?.failureOutcome).toBe("fail-quota");
  });

  test("rebuilt bundle contains a failure-note chunk", async () => {
    const primaryAgent = makeFailingAgent("claude");
    const config = makeConfig(true);
    const ctx = makeCtx(config, bundle);

    // Phase C: bundle rebuild runs inside buildHopCallback — same setup as the rebuildInfo test.
    ctx.sessionManager = makeSessionManager();
    _buildHopCallbackDeps.writeRebuildManifest = mock(async () => {});
    ctx.agentManager = makeMockAgentManager({
      runAsSessionFn: async () => ({
        output: "done",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 1,
      }),
      runWithFallbackFn: async (req) => {
        if (req.executeHop) {
          const { result } = await req.executeHop("codex", req.bundle, QUOTA_FAILURE, req.runOptions);
          return {
            result: { ...result, agentFallbacks: [] },
            fallbacks: [{ storyId: "US-001", priorAgent: "claude", newAgent: "codex", outcome: "fail-quota", category: "availability", hop: 1, timestamp: new Date().toISOString(), costUsd: 0 }],
          };
        }
        return { result: { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCost: 0, agentFallbacks: [] }, fallbacks: [] };
      },
    });

    _executionDeps.getAgent = mock((_name: string) => primaryAgent);
    ctx.agentGetFn = (_name: string) => primaryAgent as AgentAdapter;

    await executionStage.execute(ctx);

    const failureChunk = ctx.contextBundle?.chunks.find((c) => c.id.startsWith("failure-note:"));
    expect(failureChunk).toBeDefined();
    expect(failureChunk?.kind).toBe("session");
  });

  test("escalates when swap is disabled in config", async () => {
    const primaryAgent = makeFailingAgent("claude");
    const config = makeConfig(false); // disabled
    const ctx = makeCtx(config, bundle);

    _executionDeps.getAgent = mock(() => primaryAgent);
    ctx.agentGetFn = () => primaryAgent as AgentAdapter;

    const result = await executionStage.execute(ctx);

    expect(result).toEqual({ action: "escalate" });
    // When agentManager is used, agentSwapCount is set to 0 (no swaps); undefined is also acceptable.
    expect(ctx.agentSwapCount ?? 0).toBe(0);
  });

  test("escalates when swap agent also fails", async () => {
    const primaryAgent = makeFailingAgent("claude");
    const config = makeConfig(true);
    const ctx = makeCtx(config, bundle);
    const hopAgents: string[] = [];

    ctx.sessionManager = makeSessionManager();
    ctx.agentManager = makeMockAgentManager({
      runAsSessionFn: async (agentName) => {
        hopAgents.push(agentName);
        throw new Error(`quota exceeded for ${agentName}`);
      },
      runWithFallbackFn: async (req) => {
        if (!req.executeHop) {
          return {
            result: { success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 0, estimatedCost: 0, adapterFailure: QUOTA_FAILURE, agentFallbacks: [] },
            fallbacks: [],
          };
        }
        const swapped = await req.executeHop("codex", req.bundle, QUOTA_FAILURE, req.runOptions);
        return {
          result: { ...swapped.result, agentFallbacks: [] },
          fallbacks: [{ storyId: "US-001", priorAgent: "claude", newAgent: "codex", outcome: "fail-quota", category: "availability", hop: 1, timestamp: new Date().toISOString(), costUsd: 0 }],
        };
      },
    });

    _executionDeps.getAgent = mock((name: string) => (name === "codex" ? makeFailingAgent("codex") : primaryAgent));
    ctx.agentGetFn = (name: string) => (name === "codex" ? makeFailingAgent("codex") : primaryAgent) as AgentAdapter;

    const result = await executionStage.execute(ctx);

    expect(result).toEqual({ action: "escalate" });
    expect(ctx.agentSwapCount).toBe(1);
    expect(hopAgents).toEqual(["codex"]);
  });

  test("does not swap when no context bundle exists", async () => {
    const primaryAgent = makeFailingAgent("claude");
    const config = makeConfig(true);
    const ctx = makeCtx(config, bundle);
    ctx.contextBundle = undefined; // no bundle

    _executionDeps.getAgent = mock(() => primaryAgent);
    ctx.agentGetFn = () => primaryAgent as AgentAdapter;

    const result = await executionStage.execute(ctx);

    expect(result).toEqual({ action: "escalate" });
    // When agentManager is used, agentSwapCount is set to 0 (no swaps); undefined is also acceptable.
    expect(ctx.agentSwapCount ?? 0).toBe(0);
  });

  test("respects maxHopsPerStory cap — does not swap when cap is zero", async () => {
    const primaryAgent = makeFailingAgent("claude");
    const config = makeConfig(true);
    config.agent!.fallback!.maxHopsPerStory = 0;
    const ctx = makeCtx(config, bundle);

    _executionDeps.getAgent = mock(() => primaryAgent);
    ctx.agentGetFn = () => primaryAgent as AgentAdapter;

    const result = await executionStage.execute(ctx);

    expect(result).toEqual({ action: "escalate" });
    expect(ctx.agentSwapCount ?? 0).toBe(0);
  });

  test("tries the next fallback candidate when the first swap candidate fails", async () => {
    const primaryAgent = makeFailingAgent("claude");
    const config = makeConfig(true);
    config.agent!.fallback!.map = { claude: ["codex", "gemini"] };
    config.agent!.fallback!.maxHopsPerStory = 2;
    const ctx = makeCtx(config, bundle);
    const hopAgents: string[] = [];

    ctx.sessionManager = makeSessionManager();
    ctx.agentManager = makeMockAgentManager({
      runAsSessionFn: async (agentName) => {
        hopAgents.push(agentName);
        if (agentName === "codex") throw new Error("quota exceeded for codex");
        return {
          output: "done",
          tokenUsage: { inputTokens: 10, outputTokens: 20 },
          cost: { total: 0.02 },
          internalRoundTrips: 1,
        };
      },
      runWithFallbackFn: async (req) => {
        if (!req.executeHop) {
          return {
            result: { success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 0, estimatedCost: 0, adapterFailure: QUOTA_FAILURE, agentFallbacks: [] },
            fallbacks: [],
          };
        }
        const firstSwap = await req.executeHop("codex", req.bundle, QUOTA_FAILURE, req.runOptions);
        const secondFailure = firstSwap.result.adapterFailure ?? QUOTA_FAILURE;
        const secondSwap = await req.executeHop("gemini", firstSwap.bundle, secondFailure, req.runOptions);
        return {
          result: { ...secondSwap.result, agentFallbacks: [] },
          fallbacks: [
            { storyId: "US-001", priorAgent: "claude", newAgent: "codex", outcome: "fail-quota", category: "availability", hop: 1, timestamp: new Date().toISOString(), costUsd: 0 },
            { storyId: "US-001", priorAgent: "codex", newAgent: "gemini", outcome: "fail-adapter-error", category: "availability", hop: 2, timestamp: new Date().toISOString(), costUsd: 0 },
          ],
        };
      },
    });

    _executionDeps.getAgent = mock((name: string) => {
      if (name === "codex") return makeFailingAgent("codex");
      if (name === "gemini") return makeSucceedingAgent("gemini");
      return primaryAgent;
    });
    ctx.agentGetFn = (name: string) => {
      if (name === "codex") return makeFailingAgent("codex") as AgentAdapter;
      if (name === "gemini") return makeSucceedingAgent("gemini") as AgentAdapter;
      return primaryAgent as AgentAdapter;
    };

    const result = await executionStage.execute(ctx);

    expect(result).toEqual({ action: "continue" });
    expect(hopAgents).toEqual(["codex", "gemini"]);
    expect(ctx.agentSwapCount).toBe(2);
  });

  test("all fallback candidates fail — returns escalate (H-4 exhaustion)", async () => {
    const primaryAgent = makeFailingAgent("claude");
    const config = makeConfig(true);
    config.agent!.fallback!.map = { claude: ["codex", "gemini"] };
    config.agent!.fallback!.maxHopsPerStory = 3;
    const ctx = makeCtx(config, bundle);
    const hopAgents: string[] = [];

    ctx.sessionManager = makeSessionManager();
    ctx.agentManager = makeMockAgentManager({
      runAsSessionFn: async (agentName) => {
        hopAgents.push(agentName);
        throw new Error(`quota exceeded for ${agentName}`);
      },
      runWithFallbackFn: async (req) => {
        if (!req.executeHop) {
          return {
            result: { success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 0, estimatedCost: 0, adapterFailure: QUOTA_FAILURE, agentFallbacks: [] },
            fallbacks: [],
          };
        }
        const firstSwap = await req.executeHop("codex", req.bundle, QUOTA_FAILURE, req.runOptions);
        const secondFailure = firstSwap.result.adapterFailure ?? QUOTA_FAILURE;
        const secondSwap = await req.executeHop("gemini", firstSwap.bundle, secondFailure, req.runOptions);
        return {
          result: { ...secondSwap.result, agentFallbacks: [] },
          fallbacks: [
            { storyId: "US-001", priorAgent: "claude", newAgent: "codex", outcome: "fail-quota", category: "availability", hop: 1, timestamp: new Date().toISOString(), costUsd: 0 },
            { storyId: "US-001", priorAgent: "codex", newAgent: "gemini", outcome: "fail-adapter-error", category: "availability", hop: 2, timestamp: new Date().toISOString(), costUsd: 0 },
          ],
        };
      },
    });

    _executionDeps.getAgent = mock((name: string) => {
      if (name === "codex") return makeFailingAgent("codex");
      if (name === "gemini") return makeFailingAgent("gemini");
      return primaryAgent;
    });
    ctx.agentGetFn = (name: string) => {
      if (name === "codex") return makeFailingAgent("codex") as AgentAdapter;
      if (name === "gemini") return makeFailingAgent("gemini") as AgentAdapter;
      return primaryAgent as AgentAdapter;
    };

    const result = await executionStage.execute(ctx);

    expect(result).toEqual({ action: "escalate" });
    expect(hopAgents).toEqual(["codex", "gemini"]);
    // agentSwapCount reflects all hops attempted
    expect(ctx.agentSwapCount).toBe(2);
  });

  test("swap retry prompt includes rebuilt fallback context", async () => {
    const primaryAgent = makeFailingAgent("claude");
    const config = makeConfig(true);
    const ctx = makeCtx(config, bundle);

    // Phase C: prompt is rebuilt inside buildHopCallback and written to ctx.prompt on success.
    // The swap agent runs via runAsSession, not adapter.run(), so check ctx.prompt instead.
    ctx.sessionManager = makeSessionManager();
    _buildHopCallbackDeps.writeRebuildManifest = mock(async () => {});
    ctx.agentManager = makeMockAgentManager({
      runAsSessionFn: async () => ({
        output: "done",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 1,
      }),
      runWithFallbackFn: async (req) => {
        if (req.executeHop) {
          const { result } = await req.executeHop("codex", req.bundle, QUOTA_FAILURE, req.runOptions);
          return {
            result: { ...result, agentFallbacks: [] },
            fallbacks: [{ storyId: "US-001", priorAgent: "claude", newAgent: "codex", outcome: "fail-quota", category: "availability", hop: 1, timestamp: new Date().toISOString(), costUsd: 0 }],
          };
        }
        return { result: { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCost: 0, agentFallbacks: [] }, fallbacks: [] };
      },
    });

    _executionDeps.getAgent = mock((_name: string) => primaryAgent);
    ctx.agentGetFn = (_name: string) => primaryAgent as AgentAdapter;

    await executionStage.execute(ctx);

    expect(ctx.prompt).toContain("Agent swap (availability fallback)");
  });
});
