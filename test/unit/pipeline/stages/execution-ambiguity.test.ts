/**
 * Unit tests for story-ambiguity trigger and isAmbiguousOutput helper (TC-004)
 *
 * Covers:
 * - isAmbiguousOutput() detects all 6 keyword phrases (case-insensitive)
 * - story-ambiguity trigger fires when output is ambiguous and trigger enabled
 * - story-ambiguity is disabled by default
 * - trigger responds abort → escalate
 * - trigger responds approve → continue
 * - Trigger does not fire when output is clear
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../../src/config";
import { InteractionChain } from "../../../../src/interaction/chain";
import type { InteractionPlugin, InteractionResponse } from "../../../../src/interaction/types";
import { isAmbiguousOutput, _executionDeps } from "../../../../src/pipeline/stages/execution";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { PRD, UserStory } from "../../../../src/prd";
import { makeAgentAdapter, makeNaxConfig, makeStory } from "../../../../test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Save originals for restoration
// ─────────────────────────────────────────────────────────────────────────────

const originalGetAgent = _executionDeps.getAgent;
const originalCheckStoryAmbiguity = _executionDeps.checkStoryAmbiguity;
const originalIsAmbiguousOutput = _executionDeps.isAmbiguousOutput;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeChain(action: InteractionResponse["action"]): InteractionChain {
  const chain = new InteractionChain({ defaultTimeout: 5000, defaultFallback: "abort" });
  const plugin: InteractionPlugin = {
    name: "test",
    send: mock(async () => {}),
    receive: mock(async (id: string): Promise<InteractionResponse> => ({
      requestId: id,
      action,
      respondedBy: "user",
      respondedAt: Date.now(),
    })),
  };
  chain.register(plugin);
  return chain;
}

function makeConfig(triggers: Record<string, unknown>) {
  return makeNaxConfig({
    agent: { default: "test-agent" },
    models: { "test-agent": { fast: "claude-haiku-4-5", balanced: "claude-sonnet-4-5", powerful: "claude-opus-4-5" } },
    execution: {
      sessionTimeoutSeconds: 60,
      dangerouslySkipPermissions: false,
      costLimit: 10,
      maxIterations: 10,
      rectification: { maxRetries: 3 },
    },
    interaction: {
      plugin: "cli",
      defaults: { timeout: 30000, fallback: "abort" as const },
      triggers,
    },
  });
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

function makeAgent(output: string) {
  return makeAgentAdapter({
    name: "test-agent",
    capabilities: { supportedTiers: ["fast", "balanced", "powerful"] },
    run: mock(async () => ({
      success: true,
      exitCode: 0,
      output,
      stderr: "",
      rateLimited: false,
      durationMs: 100,
      estimatedCost: 0.01,
    })),
  });
}

function makeCtx(config: ReturnType<typeof makeNaxConfig>, interaction?: InteractionChain): PipelineContext {
  return {
    config,
    prd: makePRD(),
    story: makeStory(),
    stories: [makeStory()],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir: "/tmp/test",
    projectDir: "/tmp/test",
    prompt: "Do something",
    hooks: {} as PipelineContext["hooks"],
    interaction,
  } as unknown as PipelineContext;
}

afterEach(() => {
  mock.restore();
  _executionDeps.getAgent = originalGetAgent;
  _executionDeps.checkStoryAmbiguity = originalCheckStoryAmbiguity;
  _executionDeps.isAmbiguousOutput = originalIsAmbiguousOutput;
});

// ─────────────────────────────────────────────────────────────────────────────
// isAmbiguousOutput helper tests
// ─────────────────────────────────────────────────────────────────────────────

describe("isAmbiguousOutput", () => {
  test("detects 'unclear' keyword (case-insensitive)", () => {
    expect(isAmbiguousOutput("This is unclear")).toBe(true);
    expect(isAmbiguousOutput("This is UNCLEAR")).toBe(true);
    expect(isAmbiguousOutput("This is UnClEaR")).toBe(true);
  });

  test("detects 'ambiguous' keyword", () => {
    expect(isAmbiguousOutput("The requirement is ambiguous")).toBe(true);
    expect(isAmbiguousOutput("The requirement is AMBIGUOUS")).toBe(true);
  });

  test("detects 'need clarification' phrase", () => {
    expect(isAmbiguousOutput("I need clarification on this")).toBe(true);
    expect(isAmbiguousOutput("I NEED CLARIFICATION on this")).toBe(true);
  });

  test("detects 'please clarify' phrase", () => {
    expect(isAmbiguousOutput("Please clarify what you mean")).toBe(true);
    expect(isAmbiguousOutput("PLEASE CLARIFY what you mean")).toBe(true);
  });

  test("detects 'which one' phrase", () => {
    expect(isAmbiguousOutput("Which one should I use?")).toBe(true);
    expect(isAmbiguousOutput("WHICH ONE should I use?")).toBe(true);
  });

  test("detects 'not sure which' phrase", () => {
    expect(isAmbiguousOutput("I'm not sure which option to pick")).toBe(true);
    expect(isAmbiguousOutput("I'm NOT SURE WHICH option to pick")).toBe(true);
  });

  test("returns false for clear output", () => {
    expect(isAmbiguousOutput("Implementation complete")).toBe(false);
    expect(isAmbiguousOutput("Tests passing")).toBe(false);
    expect(isAmbiguousOutput("")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isAmbiguousOutput("")).toBe(false);
  });

  test("detects multiple keywords in same output", () => {
    expect(isAmbiguousOutput("This is unclear and ambiguous")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// story-ambiguity trigger tests (via _executionDeps injection)
// ─────────────────────────────────────────────────────────────────────────────

describe("executionStage — story-ambiguity trigger", () => {
  test("returns escalate when ambiguity detected and trigger responds abort", async () => {
    const { executionStage } = await import("../../../../src/pipeline/stages/execution");
    const agent = makeAgent("This is unclear about requirements");
    _executionDeps.getAgent = mock(() => agent as ReturnType<typeof _executionDeps.getAgent>);
    _executionDeps.checkStoryAmbiguity = mock(async () => false);

    const config = makeConfig({ "story-ambiguity": { enabled: true } });
    const chain = makeChain("abort");
    const ctx = makeCtx(config, chain);

    const result = await executionStage.execute(ctx);

    expect(result.action).toBe("escalate");
    expect((result as { reason?: string }).reason).toContain("ambiguity");
    expect(_executionDeps.checkStoryAmbiguity).toHaveBeenCalledTimes(1);
  });

  test("returns continue when ambiguity detected but trigger approves", async () => {
    const { executionStage } = await import("../../../../src/pipeline/stages/execution");
    const agent = makeAgent("I need clarification on this");
    _executionDeps.getAgent = mock(() => agent as ReturnType<typeof _executionDeps.getAgent>);
    _executionDeps.checkStoryAmbiguity = mock(async () => true);

    const config = makeConfig({ "story-ambiguity": { enabled: true } });
    const chain = makeChain("approve");
    const ctx = makeCtx(config, chain);

    const result = await executionStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(_executionDeps.checkStoryAmbiguity).toHaveBeenCalledTimes(1);
  });

  test("does not call trigger when story-ambiguity is disabled (default)", async () => {
    const { executionStage } = await import("../../../../src/pipeline/stages/execution");
    const agent = makeAgent("This is unclear");
    _executionDeps.getAgent = mock(() => agent as ReturnType<typeof _executionDeps.getAgent>);
    _executionDeps.checkStoryAmbiguity = mock(async () => false);

    const config = makeConfig({});
    const chain = makeChain("abort");
    const ctx = makeCtx(config, chain);

    const result = await executionStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(_executionDeps.checkStoryAmbiguity).not.toHaveBeenCalled();
  });

  test("does not call trigger when output is clear", async () => {
    const { executionStage } = await import("../../../../src/pipeline/stages/execution");
    const agent = makeAgent("Implementation complete successfully");
    _executionDeps.getAgent = mock(() => agent as ReturnType<typeof _executionDeps.getAgent>);
    _executionDeps.checkStoryAmbiguity = mock(async () => false);

    const config = makeConfig({ "story-ambiguity": { enabled: true } });
    const chain = makeChain("abort");
    const ctx = makeCtx(config, chain);

    const result = await executionStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(_executionDeps.checkStoryAmbiguity).not.toHaveBeenCalled();
  });

  test("does not call trigger when no interaction chain", async () => {
    const { executionStage } = await import("../../../../src/pipeline/stages/execution");
    const agent = makeAgent("Which one should I use?");
    _executionDeps.getAgent = mock(() => agent as ReturnType<typeof _executionDeps.getAgent>);
    _executionDeps.checkStoryAmbiguity = mock(async () => false);

    const config = makeConfig({ "story-ambiguity": { enabled: true } });
    const ctx = makeCtx(config); // no chain

    const result = await executionStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(_executionDeps.checkStoryAmbiguity).not.toHaveBeenCalled();
  });

  test("does not call trigger when agent session failed", async () => {
    const { executionStage } = await import("../../../../src/pipeline/stages/execution");
    _executionDeps.getAgent = mock(() =>
      makeAgentAdapter({
        name: "test-agent",
        capabilities: { supportedTiers: ["fast", "balanced", "powerful"] },
        run: mock(async () => ({
          success: false,
          exitCode: 1,
          output: "This is unclear",
          stderr: "Error occurred",
          rateLimited: false,
          durationMs: 100,
          estimatedCost: 0.01,
        })),
      }),
    );
    _executionDeps.checkStoryAmbiguity = mock(async () => false);

    const config = makeConfig({ "story-ambiguity": { enabled: true } });
    const chain = makeChain("abort");
    const ctx = makeCtx(config, chain);

    const result = await executionStage.execute(ctx);

    expect(result.action).toBe("escalate");
    expect(_executionDeps.checkStoryAmbiguity).not.toHaveBeenCalled();
  });

  test("passes correct context to checkStoryAmbiguity", async () => {
    const { executionStage } = await import("../../../../src/pipeline/stages/execution");
    const agent = makeAgent("not sure which");
    _executionDeps.getAgent = mock(() => agent as ReturnType<typeof _executionDeps.getAgent>);
    _executionDeps.checkStoryAmbiguity = mock(async () => true);

    const config = makeConfig({ "story-ambiguity": { enabled: true } });
    const chain = makeChain("approve");
    const ctx = makeCtx(config, chain);

    await executionStage.execute(ctx);

    const callArgs = (_executionDeps.checkStoryAmbiguity as any).mock.calls[0];
    expect(callArgs[0].featureName).toBe("my-feature");
    expect(callArgs[0].storyId).toBe("US-001");
    expect(callArgs[0].reason).toContain("Agent output suggests ambiguity");
  });
});
