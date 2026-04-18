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
import { executionStage, _executionDeps } from "../../../src/pipeline/stages/execution";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { PRD, UserStory } from "../../../src/prd";
import type { AgentAdapter } from "../../../src/agents/types";
import { _gitDeps } from "../../../src/utils/git";

// ─────────────────────────────────────────────────────────────────────────────
// Saved deps for restoration
// ─────────────────────────────────────────────────────────────────────────────

const origGetAgent = _executionDeps.getAgent;
const origValidateAgent = _executionDeps.validateAgentForTier;
const origDetectMerge = _executionDeps.detectMergeConflict;
const origShouldSwap = _executionDeps.shouldAttemptSwap;
const origResolveSwap = _executionDeps.resolveSwapTarget;
const origRebuildForSwap = _executionDeps.rebuildForSwap;
const origGitSpawn = _gitDeps.spawn;

afterEach(() => {
  _executionDeps.getAgent = origGetAgent;
  _executionDeps.validateAgentForTier = origValidateAgent;
  _executionDeps.detectMergeConflict = origDetectMerge;
  _executionDeps.shouldAttemptSwap = origShouldSwap;
  _executionDeps.resolveSwapTarget = origResolveSwap;
  _executionDeps.rebuildForSwap = origRebuildForSwap;
  _gitDeps.spawn = origGitSpawn;
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

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
    autoMode: { defaultAgent: "claude" },
    models: {
      claude: { fast: "claude-haiku-4-5", balanced: "claude-sonnet-4-5", powerful: "claude-opus-4-5" },
      codex: { fast: "codex-fast", balanced: "codex-balanced", powerful: "codex-powerful" },
    },
    context: {
      ...DEFAULT_CONFIG.context,
      v2: {
        ...DEFAULT_CONFIG.context.v2,
        fallback: {
          enabled: swapEnabled,
          onQualityFailure: false,
          maxHopsPerStory: 1,
          map: { claude: ["codex"] },
        },
      },
    },
  } as unknown as NaxConfig;
}

function makeCtx(config: NaxConfig, bundle: ContextBundle): PipelineContext {
  return {
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
    rootConfig: { ...DEFAULT_CONFIG, autoMode: { defaultAgent: "claude" }, models: config.models } as unknown as NaxConfig,
    workdir: "/tmp/test",
    projectDir: "/tmp/test",
    prompt: "Do something useful",
    hooks: {} as PipelineContext["hooks"],
    contextBundle: bundle,
  } as unknown as PipelineContext;
}

function makeFailingAgent(name: string): AgentAdapter {
  return {
    name,
    capabilities: { supportedTiers: ["fast", "balanced", "powerful"] },
    run: mock(async () => ({
      success: false,
      exitCode: 1,
      output: "",
      stderr: "quota exceeded",
      rateLimited: false,
      durationMs: 100,
      estimatedCost: 0.0,
      adapterFailure: QUOTA_FAILURE,
    })),
    closeSession: mock(async () => {}),
    closePhysicalSession: mock(async () => {}),
    deriveSessionName: mock(() => `nax-session-${name}`),
  } as unknown as AgentAdapter;
}

function makeSucceedingAgent(name: string): AgentAdapter {
  return {
    name,
    capabilities: { supportedTiers: ["fast", "balanced", "powerful"] },
    run: mock(async () => ({
      success: true,
      exitCode: 0,
      output: "done",
      stderr: "",
      rateLimited: false,
      durationMs: 200,
      estimatedCost: 0.02,
    })),
    closeSession: mock(async () => {}),
    closePhysicalSession: mock(async () => {}),
    deriveSessionName: mock(() => `nax-session-${name}`),
  } as unknown as AgentAdapter;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

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
    const swapAgent = makeSucceedingAgent("codex");
    const config = makeConfig(true);
    const ctx = makeCtx(config, bundle);

    _executionDeps.getAgent = mock((name: string) => (name === "codex" ? swapAgent : primaryAgent));
    ctx.agentGetFn = (name: string) => (name === "codex" ? swapAgent : primaryAgent) as AgentAdapter;

    const result = await executionStage.execute(ctx);

    expect(result).toEqual({ action: "continue" });
    expect(ctx.agentSwapCount).toBe(1);
    // Swap agent ran
    expect((swapAgent.run as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
  });

  test("rebuilt bundle carries rebuildInfo with correct agents and failure", async () => {
    const primaryAgent = makeFailingAgent("claude");
    const swapAgent = makeSucceedingAgent("codex");
    const config = makeConfig(true);
    const ctx = makeCtx(config, bundle);

    _executionDeps.getAgent = mock((name: string) => (name === "codex" ? swapAgent : primaryAgent));
    ctx.agentGetFn = (name: string) => (name === "codex" ? swapAgent : primaryAgent) as AgentAdapter;

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
    const swapAgent = makeSucceedingAgent("codex");
    const config = makeConfig(true);
    const ctx = makeCtx(config, bundle);

    _executionDeps.getAgent = mock((name: string) => (name === "codex" ? swapAgent : primaryAgent));
    ctx.agentGetFn = (name: string) => (name === "codex" ? swapAgent : primaryAgent) as AgentAdapter;

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
    expect(ctx.agentSwapCount).toBeUndefined();
  });

  test("escalates when swap agent also fails", async () => {
    const primaryAgent = makeFailingAgent("claude");
    const swapAgent = makeFailingAgent("codex");
    const config = makeConfig(true);
    const ctx = makeCtx(config, bundle);

    _executionDeps.getAgent = mock((name: string) => (name === "codex" ? swapAgent : primaryAgent));
    ctx.agentGetFn = (name: string) => (name === "codex" ? swapAgent : primaryAgent) as AgentAdapter;

    const result = await executionStage.execute(ctx);

    expect(result).toEqual({ action: "escalate" });
    expect(ctx.agentSwapCount).toBe(1);
    expect((swapAgent.run as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
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
    expect(ctx.agentSwapCount).toBeUndefined();
  });

  test("respects maxHopsPerStory cap — does not swap when already at limit", async () => {
    const primaryAgent = makeFailingAgent("claude");
    const config = makeConfig(true);
    const ctx = makeCtx(config, bundle);
    ctx.agentSwapCount = 1; // already used the one allowed hop

    _executionDeps.getAgent = mock(() => primaryAgent);
    ctx.agentGetFn = () => primaryAgent as AgentAdapter;

    const result = await executionStage.execute(ctx);

    expect(result).toEqual({ action: "escalate" });
    expect(ctx.agentSwapCount).toBe(1); // unchanged
  });

  test("tries the next fallback candidate when the first swap candidate fails", async () => {
    const primaryAgent = makeFailingAgent("claude");
    const firstSwapAgent = makeFailingAgent("codex");
    const secondSwapAgent = makeSucceedingAgent("gemini");
    const config = makeConfig(true);
    config.context.v2.fallback.map = { claude: ["codex", "gemini"] };
    config.context.v2.fallback.maxHopsPerStory = 2;
    const ctx = makeCtx(config, bundle);

    _executionDeps.getAgent = mock((name: string) => {
      if (name === "codex") return firstSwapAgent;
      if (name === "gemini") return secondSwapAgent;
      return primaryAgent;
    });
    ctx.agentGetFn = (name: string) => {
      if (name === "codex") return firstSwapAgent as AgentAdapter;
      if (name === "gemini") return secondSwapAgent as AgentAdapter;
      return primaryAgent as AgentAdapter;
    };

    const result = await executionStage.execute(ctx);

    expect(result).toEqual({ action: "continue" });
    expect((firstSwapAgent.run as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    expect((secondSwapAgent.run as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    expect(ctx.agentSwapCount).toBe(2);
  });

  test("all fallback candidates fail — returns escalate (H-4 exhaustion)", async () => {
    const primaryAgent = makeFailingAgent("claude");
    const firstSwapAgent = makeFailingAgent("codex");
    const secondSwapAgent = makeFailingAgent("gemini");
    const config = makeConfig(true);
    config.context.v2.fallback.map = { claude: ["codex", "gemini"] };
    config.context.v2.fallback.maxHopsPerStory = 3;
    const ctx = makeCtx(config, bundle);

    _executionDeps.getAgent = mock((name: string) => {
      if (name === "codex") return firstSwapAgent;
      if (name === "gemini") return secondSwapAgent;
      return primaryAgent;
    });
    ctx.agentGetFn = (name: string) => {
      if (name === "codex") return firstSwapAgent as AgentAdapter;
      if (name === "gemini") return secondSwapAgent as AgentAdapter;
      return primaryAgent as AgentAdapter;
    };

    const result = await executionStage.execute(ctx);

    expect(result).toEqual({ action: "escalate" });
    expect((firstSwapAgent.run as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    expect((secondSwapAgent.run as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    // agentSwapCount reflects all hops attempted
    expect(ctx.agentSwapCount).toBe(2);
  });

  test("swap retry prompt includes rebuilt fallback context", async () => {
    const primaryAgent = makeFailingAgent("claude");
    const swapAgent = makeSucceedingAgent("codex");
    const config = makeConfig(true);
    const ctx = makeCtx(config, bundle);

    _executionDeps.getAgent = mock((name: string) => (name === "codex" ? swapAgent : primaryAgent));
    ctx.agentGetFn = (name: string) => (name === "codex" ? swapAgent : primaryAgent) as AgentAdapter;

    await executionStage.execute(ctx);

    const swapRunCall = (swapAgent.run as ReturnType<typeof mock>).mock.calls[0]?.[0] as
      | { prompt?: string }
      | undefined;
    expect(swapRunCall?.prompt).toContain("Agent swap (availability fallback)");
  });
});
