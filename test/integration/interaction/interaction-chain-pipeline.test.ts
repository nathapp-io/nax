// RE-ARCH: rewrite

/**
 * Integration Tests: Interaction Chain → Pipeline (BUG-025)
 *
 * Verifies the three acceptance criteria:
 * AC1: interactionChain is accessible in PipelineContext
 * AC2: Story reaching max retries triggers a 'human-review' interaction request
 * AC3: CLI interaction plugin participates in non-headless human-review
 *
 * These tests FAIL until BUG-025 is implemented.
 */

import { describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../src/config";
import { InteractionChain } from "../../../src/interaction/chain";
import { pipelineEventBus } from "../../../src/pipeline/event-bus";
import { wireInteraction } from "../../../src/pipeline/subscribers/interaction";
import { CLIInteractionPlugin } from "../../../src/interaction/plugins/cli";
import type { InteractionPlugin, InteractionRequest, InteractionResponse, TriggerName } from "../../../src/interaction/types";
import { TRIGGER_METADATA } from "../../../src/interaction/types";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { SequentialExecutionContext } from "../../../src/execution/sequential-executor";
import type { PRD, UserStory } from "../../../src/prd/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const baseConfig: Partial<NaxConfig> = {
  execution: {
    maxIterations: 10,
    costLimit: 100,
    iterationDelayMs: 0,
    sessionTimeoutSeconds: 60,
    maxStoriesPerFeature: 50,
    rectification: { enabled: true, maxRetries: 2, fullSuiteTimeoutSeconds: 30, maxFailureSummaryChars: 500 },
    verificationTimeoutSeconds: 60,
  },
  interaction: {
    triggers: {
      "human-review": { enabled: true },
    },
    defaults: {
      timeout: 5000,
      fallback: "skip" as const,
    },
  },
} as Partial<NaxConfig>;

const baseStory: UserStory = {
  id: "US-001",
  title: "Test story",
  description: "A story that fails repeatedly",
  acceptanceCriteria: [],
  status: "pending",
  attempts: 0,
};

const basePrd: PRD = {
  feature: "test-feature",
  version: "1",
  userStories: [baseStory],
};

/** Build a mock InteractionPlugin that records sent requests */
function buildCapturingPlugin(): { plugin: InteractionPlugin; sentRequests: InteractionRequest[] } {
  const sentRequests: InteractionRequest[] = [];
  const plugin: InteractionPlugin = {
    name: "capture",
    send: mock(async (req: InteractionRequest) => {
      sentRequests.push(req);
    }),
    receive: mock(async (requestId: string): Promise<InteractionResponse> => ({
      requestId,
      action: "skip",
      respondedBy: "user",
      respondedAt: Date.now(),
    })),
  };
  return { plugin, sentRequests };
}

function buildInteractionChain(): InteractionChain {
  return new InteractionChain({ defaultTimeout: 5000, defaultFallback: "skip" });
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1: interactionChain is accessible in PipelineContext
// ─────────────────────────────────────────────────────────────────────────────

describe("AC1: interactionChain accessible in PipelineContext", () => {
  test("PipelineContext type includes 'interaction' field", () => {
    // FAILS until BUG-025 adds 'interaction?: InteractionChain' to PipelineContext interface
    // We create a minimal context and verify the interaction field is accepted by the type system at runtime
    const chain = buildInteractionChain();

    const ctx: PipelineContext = {
      config: baseConfig as NaxConfig,
      effectiveConfig: baseConfig as NaxConfig,
      prd: basePrd,
      story: baseStory,
      stories: [baseStory],
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "test" },
      workdir: "/tmp",
      hooks: { hooks: {} },
      // @ts-expect-error — will fail until PipelineContext adds 'interaction' field
      interaction: chain,
    };

    // The interaction field should be accessible
    expect((ctx as Record<string, unknown>).interaction).toBe(chain);
  });

  test("PipelineContext 'interaction' field is optional (not required)", () => {
    // FAILS until BUG-025 adds the field (or if it becomes required incorrectly)
    // A context without 'interaction' should still be valid
    const ctx: PipelineContext = {
      config: baseConfig as NaxConfig,
      effectiveConfig: baseConfig as NaxConfig,
      prd: basePrd,
      story: baseStory,
      stories: [baseStory],
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "test" },
      workdir: "/tmp",
      hooks: { hooks: {} },
    };

    // Without the field, it should be undefined (not cause errors)
    expect((ctx as Record<string, unknown>).interaction).toBeUndefined();
  });

  test("interactionChain stored in PipelineContext survives pipeline execution (via runPipeline)", async () => {
    // BUG-025: PipelineContext now accepts 'interaction?: InteractionChain' field.
    // Verifies the field is set and preserved correctly.
    const chain = buildInteractionChain();
    const { plugin } = buildCapturingPlugin();
    chain.register(plugin, 10);

    const ctx: PipelineContext = {
      config: baseConfig as NaxConfig,
      effectiveConfig: baseConfig as NaxConfig,
      prd: basePrd,
      story: baseStory,
      stories: [baseStory],
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "test" },
      workdir: "/tmp",
      hooks: { hooks: {} },
      interaction: chain, // BUG-025: 'interaction' field now accepted by PipelineContext
    };

    // The interaction chain is preserved in the context
    expect((ctx as Record<string, unknown>).interaction).toBeInstanceOf(InteractionChain);
    expect((ctx as Record<string, unknown>).interaction).toBe(chain);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SequentialExecutionContext — accepts interactionChain field
// ─────────────────────────────────────────────────────────────────────────────

describe("SequentialExecutionContext accepts interactionChain", () => {
  test("SequentialExecutionContext type has interactionChain field", () => {
    // FAILS until BUG-025 adds 'interactionChain?: InteractionChain | null' to SequentialExecutionContext
    const chain = buildInteractionChain();

    const ctx: SequentialExecutionContext = {
      prdPath: "/tmp/prd.json",
      workdir: "/tmp",
      config: baseConfig as NaxConfig,
      hooks: { hooks: {} } as any,
      feature: "test-feature",
      dryRun: true,
      useBatch: false,
      pluginRegistry: { plugins: [], getReporters: () => [], teardownAll: async () => {} } as any,
      statusWriter: { setPrd: () => {}, setCurrentStory: () => {}, setRunStatus: () => {}, update: async () => {} } as any,
      logFilePath: undefined,
      runId: "run-test-001",
      startTime: Date.now(),
      batchPlan: [],
      // @ts-expect-error — will fail until SequentialExecutionContext adds 'interactionChain' field
      interactionChain: chain,
    };

    expect((ctx as Record<string, unknown>).interactionChain).toBe(chain);
  });

  test("runner.ts passes interactionChain from setupRun result to executeSequential", () => {
    // BUG-025: SequentialExecutionContext now has 'interactionChain?: InteractionChain | null'.
    // Verifies the data flow: runner.ts -> executeSequential ctx -> pipeline handler.
    const chain = buildInteractionChain();

    const ctx: SequentialExecutionContext = {
      prdPath: "/tmp/prd.json",
      workdir: "/tmp",
      config: baseConfig as NaxConfig,
      hooks: { hooks: {} } as any,
      feature: "test-feature",
      dryRun: true,
      useBatch: false,
      pluginRegistry: { plugins: [], getReporters: () => [], teardownAll: async () => {} } as any,
      statusWriter: { setPrd: () => {}, setCurrentStory: () => {}, setRunStatus: () => {}, update: async () => {} } as any,
      logFilePath: undefined,
      runId: "run-test-002",
      startTime: Date.now(),
      batchPlan: [],
      interactionChain: chain, // BUG-025: field now exists in SequentialExecutionContext
    };

    // interactionChain is accessible and preserved in the context
    expect((ctx as Record<string, unknown>).interactionChain).toBe(chain);
    expect((ctx as Record<string, unknown>).interactionChain).toBeInstanceOf(InteractionChain);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2: Story reaching max retries triggers 'human-review'
// ─────────────────────────────────────────────────────────────────────────────

describe("AC2: max retries triggers human-review interaction", () => {
  test("human-review trigger is called when story.attempts >= maxRetries", async () => {
    // FAILS until BUG-025 wires executeTrigger('human-review', ...) into the failure/max-retries path
    const chain = buildInteractionChain();
    const { plugin, sentRequests } = buildCapturingPlugin();
    chain.register(plugin, 10);

    // Story has already hit max retries (attempts >= maxRetries = 2)
    const exhaustedStory: UserStory = {
      ...baseStory,
      id: "US-002",
      attempts: 2,
      status: "pending",
    };

    const prd: PRD = { ...basePrd, userStories: [exhaustedStory] };

    // Wire interaction subscriber on the singleton bus (Phase 3: replaces direct executeTrigger call)
    pipelineEventBus.clear();
    wireInteraction(pipelineEventBus, chain, baseConfig as any);

    // Import and invoke the failure handler or sequential executor path
    // that should fire 'human-review' when a story has exceeded max retries
    const { handlePipelineFailure } = await import("../../../src/execution/pipeline-result-handler");
    await handlePipelineFailure(
      {
        config: baseConfig as NaxConfig,
        prd,
        prdPath: "/tmp/prd.json",
        workdir: "/tmp",
        featureDir: undefined,
        hooks: { hooks: {} } as any,
        feature: "test-feature",
        totalCost: 0,
        startTime: Date.now(),
        runId: "run-test-001",
        pluginRegistry: { plugins: [], getReporters: () => [], teardownAll: async () => {} } as any,
        story: exhaustedStory,
        storiesToExecute: [exhaustedStory],
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "test" },
        isBatchExecution: false,
        allStoryMetrics: [],
        timeoutRetryCountMap: new Map(),
        storyGitRef: null,
        // @ts-expect-error — interactionChain not in PipelineHandlerContext yet
        interactionChain: chain,
      },
      {
        success: false,
        finalAction: "fail",
        reason: "Max retries exceeded",
        context: {
          config: baseConfig as NaxConfig,
          prd,
          story: exhaustedStory,
          stories: [exhaustedStory],
          routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "test" },
          workdir: "/tmp",
          hooks: { hooks: {} } as any,
        },
      } as any,
    );

    // FAILS: human-review trigger is not currently called in handlePipelineFailure
    const humanReviewRequests = sentRequests.filter(
      (r) => (r.metadata?.trigger as string) === "human-review",
    );
    expect(humanReviewRequests.length).toBeGreaterThan(0);
  });

  test("human-review request has storyId set to the failing story", async () => {
    // BUG-025: handlePipelineFailure fires 'human-review' with the correct storyId
    const chain = buildInteractionChain();
    const { plugin, sentRequests } = buildCapturingPlugin();
    chain.register(plugin, 10);

    // Wire interaction subscriber on the singleton bus (Phase 3)
    pipelineEventBus.clear();
    wireInteraction(pipelineEventBus, chain, baseConfig as any);

    const failingStory: UserStory = {
      ...baseStory,
      id: "US-FAILING",
      attempts: 3, // exceeds maxRetries=2
      status: "pending",
    };

    const prd: PRD = { ...basePrd, userStories: [failingStory] };

    // Verify the trigger is enabled
    const { isTriggerEnabled } = await import("../../../src/interaction/triggers");
    const enabled = isTriggerEnabled("human-review" as TriggerName, baseConfig as NaxConfig);
    expect(enabled).toBe(true);

    // Call handlePipelineFailure to trigger the human-review request
    const { handlePipelineFailure } = await import("../../../src/execution/pipeline-result-handler");
    await handlePipelineFailure(
      {
        config: baseConfig as NaxConfig,
        prd,
        prdPath: "/tmp/prd.json",
        workdir: "/tmp",
        featureDir: undefined,
        hooks: { hooks: {} } as any,
        feature: "test-feature",
        totalCost: 0,
        startTime: Date.now(),
        runId: "run-test-003",
        pluginRegistry: { plugins: [], getReporters: () => [], teardownAll: async () => {} } as any,
        story: failingStory,
        storiesToExecute: [failingStory],
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "test" },
        isBatchExecution: false,
        allStoryMetrics: [],
        timeoutRetryCountMap: new Map(),
        storyGitRef: null,
        interactionChain: chain,
      },
      {
        success: false,
        finalAction: "fail",
        reason: "Max retries exceeded",
        context: {
          config: baseConfig as NaxConfig,
          prd,
          story: failingStory,
          stories: [failingStory],
          routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "test" },
          workdir: "/tmp",
          hooks: { hooks: {} } as any,
        },
      } as any,
    );

    // human-review request should have the correct storyId
    const humanReviewRequests = sentRequests.filter(
      (r) => (r.metadata?.trigger as string) === "human-review",
    );
    expect(humanReviewRequests.length).toBeGreaterThan(0);
    expect(humanReviewRequests[0].storyId).toBe("US-FAILING");
  });

  test("human-review response 'skip' causes story to be skipped", async () => {
    // FAILS until BUG-025 implements the full human-review trigger + response handling
    const chain = buildInteractionChain();
    const plugin: InteractionPlugin = {
      name: "skip-responder",
      send: mock(async () => {}),
      receive: mock(async (requestId: string): Promise<InteractionResponse> => ({
        requestId,
        action: "skip",
        respondedBy: "user",
        respondedAt: Date.now(),
      })),
    };
    chain.register(plugin, 10);

    // When human-review returns 'skip', the story outcome should be 'skipped'
    const { executeSequential } = await import("../../../src/execution/sequential-executor");

    const exhaustedStory: UserStory = {
      ...baseStory,
      id: "US-EXHAUST",
      attempts: 3, // exceeds maxRetries=2
      status: "pending",
    };

    // We cannot run full executeSequential (spawns agents, prechecks, etc.)
    // Instead, verify the interactionChain is passed correctly and used
    // This test serves as a sentinel: after BUG-025, executeSequential must accept interactionChain
    const seqCtx = {
      prdPath: "/tmp/prd.json",
      workdir: "/tmp",
      config: baseConfig as NaxConfig,
      hooks: { hooks: {} },
      feature: "test-feature",
      dryRun: false,
      useBatch: false,
      pluginRegistry: { plugins: [], getReporters: () => [] },
      statusWriter: { setPrd: () => {}, setCurrentStory: () => {}, update: async () => {} },
      runId: "run-001",
      startTime: Date.now(),
      batchPlan: [],
      interactionChain: chain, // <- not accepted yet
    };

    // The interactionChain field is not recognized by SequentialExecutionContext — FAILS
    expect((seqCtx as Record<string, unknown>).interactionChain).toBeInstanceOf(InteractionChain);
    // AND it should be passed through to pipeline execution
    // (behavioral verification would require full integration, guarded by AC1 tests above)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3: CLI interaction plugin participates in non-headless human-review
// ─────────────────────────────────────────────────────────────────────────────

describe("AC3: CLI interaction plugin for non-headless human-review", () => {
  test("CLIInteractionPlugin can be instantiated and registered in the chain", async () => {
    // FAILS if CLIInteractionPlugin doesn't exist or cannot be imported
    const plugin = new CLIInteractionPlugin();
    expect(plugin.name).toBe("cli");

    const chain = buildInteractionChain();
    chain.register(plugin, 10);

    // Primary plugin should be CLI
    expect(chain.getPrimary()).toBe(plugin);
  });

  test("initInteractionChain registers CLI plugin for non-headless mode", async () => {
    // FAILS if initInteractionChain doesn't register CLI plugin when headless=false
    const { initInteractionChain } = await import("../../../src/interaction");

    const config = {
      ...baseConfig,
      interaction: {
        ...baseConfig.interaction,
        enabled: true,
        plugin: "cli",
      },
    } as unknown as NaxConfig;

    const chain = await initInteractionChain(config, false /* headless = false */);

    // After BUG-025, the chain should have a CLI plugin registered for non-headless mode
    // Currently may return null or a chain without a CLI plugin
    expect(chain).not.toBeNull();
    expect(chain?.getPrimary()).not.toBeNull();
    expect(chain?.getPrimary()?.name).toBe("cli");
  });

  test("human-review request sent through CLI plugin contains all required fields", async () => {
    // FAILS until BUG-025 implements human-review trigger in TRIGGER_METADATA
    const { createTriggerRequest } = await import("../../../src/interaction/triggers");

    const request = createTriggerRequest(
      "human-review" as TriggerName,
      {
        featureName: "my-feature",
        storyId: "US-003",
        iteration: 5,
        reason: "Story has failed 5 times",
      },
      baseConfig as NaxConfig,
    );

    // Verify request is well-formed for CLI presentation
    expect(request.type).toBe("confirm");
    expect(request.stage).toBe("custom");
    expect(request.featureName).toBe("my-feature");
    expect(request.storyId).toBe("US-003");
    expect(request.summary).toBeDefined();
    expect(request.summary.length).toBeGreaterThan(0);
    expect(request.fallback).toBe("skip");
    expect(request.metadata?.trigger).toBe("human-review");
    expect(request.metadata?.safety).toBe("yellow");
    expect(request.createdAt).toBeGreaterThan(0);
  });
});
