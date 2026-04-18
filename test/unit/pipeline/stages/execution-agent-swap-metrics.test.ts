/**
 * AC-41 — fallback observability: execution stage records AgentFallbackHop
 * in ctx.agentFallbacks whenever an agent-swap is triggered.
 *
 * Each hop captures storyId, priorAgent, newAgent, category, outcome, and the
 * 1-indexed hop number so downstream collectors (tracker.ts) can surface the
 * data without re-reading ctx.agentSwapCount.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { _executionDeps, executionStage } from "../../../../src/pipeline/stages/execution";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { NaxConfig } from "../../../../src/config";
import type { PRD, UserStory } from "../../../../src/prd";
import type { ContextBundle } from "../../../../src/context/engine/types";

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

function makeConfig(): NaxConfig {
  return {
    autoMode: { defaultAgent: "claude" },
    execution: { sessionTimeoutSeconds: 30, verificationTimeoutSeconds: 60 },
    models: {
      claude: { fast: "claude-haiku", balanced: "claude-sonnet", powerful: "claude-opus" },
      codex: { fast: "codex-mini", balanced: "codex-full", powerful: "codex-full" },
    },
    quality: { requireTests: false, commands: { test: "bun test" } },
    agent: {},
    context: {
      v2: {
        enabled: true,
        fallback: {
          enabled: true,
          maxHopsPerStory: 2,
          map: { claude: ["codex"] },
          onQualityFailure: false,
        },
      },
    },
  } as unknown as NaxConfig;
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

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const story = makeStory();
  const config = makeConfig();
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
    ...overrides,
  } as unknown as PipelineContext;
}

// ─────────────────────────────────────────────────────────────────────────────
// Saved deps for restoration
// ─────────────────────────────────────────────────────────────────────────────

const origGetAgent = _executionDeps.getAgent;
const origValidate = _executionDeps.validateAgentForTier;
const origDetect = _executionDeps.detectMergeConflict;
const origShouldSwap = _executionDeps.shouldAttemptSwap;
const origResolveSwap = _executionDeps.resolveSwapTarget;
const origRebuild = _executionDeps.rebuildForSwap;
const origWriteRebuildManifest = _executionDeps.writeRebuildManifest;

afterEach(() => {
  _executionDeps.getAgent = origGetAgent;
  _executionDeps.validateAgentForTier = origValidate;
  _executionDeps.detectMergeConflict = origDetect;
  _executionDeps.shouldAttemptSwap = origShouldSwap;
  _executionDeps.resolveSwapTarget = origResolveSwap;
  _executionDeps.rebuildForSwap = origRebuild;
  _executionDeps.writeRebuildManifest = origWriteRebuildManifest;
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-41: execution stage records AgentFallbackHop
// ─────────────────────────────────────────────────────────────────────────────

describe("execution stage — AC-41 fallback observability", () => {
  test("records hop in ctx.agentFallbacks when swap succeeds", async () => {
    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.detectMergeConflict = () => false;
    _executionDeps.shouldAttemptSwap = () => true;
    _executionDeps.resolveSwapTarget = () => "codex";
    _executionDeps.rebuildForSwap = () => makeBundle();
    _executionDeps.writeRebuildManifest = async () => {};

    _executionDeps.getAgent = (agentId: string) =>
      ({
        name: agentId,
        capabilities: { supportedTiers: ["fast"] },
        run: async () => {
          if (agentId === "claude") {
            return {
              success: false,
              exitCode: 1,
              output: "",
              rateLimited: false,
              durationMs: 0,
              adapterFailure: { category: "availability", outcome: "fail-quota" },
            };
          }
          return { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0 };
        },
        deriveSessionName: () => "nax-test-session",
      }) as unknown as ReturnType<typeof _executionDeps.getAgent>;

    const ctx = makeCtx();
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
    let shouldSwapCalls = 0;
    _executionDeps.shouldAttemptSwap = () => {
      shouldSwapCalls++;
      return shouldSwapCalls === 1;
    };
    _executionDeps.resolveSwapTarget = () => "codex";
    _executionDeps.rebuildForSwap = () => makeBundle();
    _executionDeps.writeRebuildManifest = async () => {};

    _executionDeps.getAgent = (_agentId: string) =>
      ({
        name: "claude",
        capabilities: { supportedTiers: ["fast"] },
        run: async () => ({
          success: false,
          exitCode: 1,
          output: "",
          rateLimited: false,
          durationMs: 0,
          adapterFailure: { category: "availability", outcome: "fail-service-down" },
        }),
        deriveSessionName: () => "nax-test-session",
      }) as unknown as ReturnType<typeof _executionDeps.getAgent>;

    const ctx = makeCtx();
    await executionStage.execute(ctx);

    expect(ctx.agentFallbacks).toHaveLength(1);
    const hop = ctx.agentFallbacks![0];
    expect(hop.newAgent).toBe("codex");
    expect(hop.outcome).toBe("fail-service-down");
    expect(hop.hop).toBe(1);
  });

  test("does not push to agentFallbacks when shouldAttemptSwap returns false", async () => {
    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.detectMergeConflict = () => false;
    _executionDeps.shouldAttemptSwap = () => false;
    _executionDeps.writeRebuildManifest = async () => {};

    _executionDeps.getAgent = () =>
      ({
        name: "claude",
        capabilities: { supportedTiers: ["fast"] },
        run: async () => ({
          success: false,
          exitCode: 1,
          output: "",
          rateLimited: false,
          durationMs: 0,
          adapterFailure: { category: "availability", outcome: "fail-quota" },
        }),
        deriveSessionName: () => "nax-test-session",
      }) as unknown as ReturnType<typeof _executionDeps.getAgent>;

    const ctx = makeCtx();
    await executionStage.execute(ctx);

    expect(ctx.agentFallbacks ?? []).toHaveLength(0);
  });

  test("hop number increments correctly across multiple swaps", async () => {
    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.detectMergeConflict = () => false;
    // shouldAttemptSwap is called twice — first by the original fail, second by
    // swapResult fail. We return true only for the first call so execution halts.
    let swapAttempts = 0;
    _executionDeps.shouldAttemptSwap = () => {
      swapAttempts++;
      return swapAttempts === 1;
    };
    _executionDeps.resolveSwapTarget = () => "codex";
    _executionDeps.rebuildForSwap = () => makeBundle();
    _executionDeps.writeRebuildManifest = async () => {};

    _executionDeps.getAgent = () =>
      ({
        name: "claude",
        capabilities: { supportedTiers: ["fast"] },
        run: async () => ({
          success: false,
          exitCode: 1,
          output: "",
          rateLimited: false,
          durationMs: 0,
          adapterFailure: { category: "availability", outcome: "fail-rate-limit" },
        }),
        deriveSessionName: () => "nax-test-session",
      }) as unknown as ReturnType<typeof _executionDeps.getAgent>;

    const ctx = makeCtx();
    ctx.agentFallbacks = [
      // Pre-seed a hop to simulate a prior swap in a previous iteration
      { storyId: "US-001", priorAgent: "codex", newAgent: "claude", outcome: "fail-quota", category: "availability", hop: 1 },
    ];
    ctx.agentSwapCount = 1;
    await executionStage.execute(ctx);

    // The new hop should be hop=2
    expect(ctx.agentFallbacks).toHaveLength(2);
    expect(ctx.agentFallbacks![1].hop).toBe(2);
  });

  test("writes rebuild-manifest event when swap rebuildInfo exists", async () => {
    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.detectMergeConflict = () => false;
    _executionDeps.shouldAttemptSwap = () => true;
    _executionDeps.resolveSwapTarget = () => "codex";
    _executionDeps.rebuildForSwap = () =>
      ({
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
      }) as ContextBundle;

    const writes: Array<Record<string, unknown>> = [];
    _executionDeps.writeRebuildManifest = async (_projectDir, _featureId, _storyId, entry) => {
      writes.push(entry as unknown as Record<string, unknown>);
    };

    _executionDeps.getAgent = (agentId: string) =>
      ({
        name: agentId,
        capabilities: { supportedTiers: ["fast"] },
        run: async () => {
          if (agentId === "claude") {
            return {
              success: false,
              exitCode: 1,
              output: "",
              rateLimited: false,
              durationMs: 0,
              adapterFailure: { category: "availability", outcome: "fail-quota" },
            };
          }
          return { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0 };
        },
        deriveSessionName: () => "nax-test-session",
      }) as unknown as ReturnType<typeof _executionDeps.getAgent>;

    const ctx = makeCtx({ projectDir: "/repo" });
    await executionStage.execute(ctx);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.requestId).toBe("req-rebuild");
    expect(writes[0]?.stage).toBe("execution");
  });
});
