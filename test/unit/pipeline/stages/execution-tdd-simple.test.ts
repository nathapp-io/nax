/**
 * Unit tests for tdd-simple execution stage behavior (TS-003)
 *
 * Covers:
 * - tdd-simple uses single-session path (not three-session TDD orchestrator)
 * - tdd-simple session succeeds → returns continue
 * - tdd-simple session fails → returns escalate
 * - tdd-simple without prompt → returns fail (same as test-after)
 * - tdd-simple without agent → returns fail
 * - No regression: three-session-tdd still calls TDD orchestrator
 * - No regression: test-after still uses single-session path
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG } from "../../../../src/config";
import type { NaxConfig } from "../../../../src/config";
import { executionStage, _executionDeps } from "../../../../src/pipeline/stages/execution";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { PRD, UserStory } from "../../../../src/prd";
import { makeAgentAdapter, makeNaxConfig, makeStory } from "../../../../test/helpers";

const WORKDIR = `/tmp/nax-test-exec-${randomUUID()}`;

// ─────────────────────────────────────────────────────────────────────────────
// Save originals for restoration
// ─────────────────────────────────────────────────────────────────────────────

const originalGetAgent = _executionDeps.getAgent;
const originalValidateAgentForTier = _executionDeps.validateAgentForTier;
const originalDetectMergeConflict = _executionDeps.detectMergeConflict;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

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

function makeCtx(
  testStrategy: "test-after" | "tdd-simple" | "three-session-tdd" | "three-session-tdd-lite",
  overrides: Partial<PipelineContext> = {},
): PipelineContext {
  const story = makeStory();
  return {
    config: makeNaxConfig({
      agent: { default: "test-agent" },
      models: { "test-agent": { fast: "claude-haiku-4-5", balanced: "claude-sonnet-4-5", powerful: "claude-opus-4-5" } },
      execution: {
        sessionTimeoutSeconds: 60,
        dangerouslySkipPermissions: false,
        costLimit: 10,
        maxIterations: 10,
        rectification: { maxRetries: 3 },
      },
      interaction: { plugin: "cli", defaults: { timeout: 30000, fallback: "abort" as const }, triggers: {} },
    }),
    prd: makePRD(),
    story,
    stories: [story],
    routing: {
      complexity: "simple",
      modelTier: "fast",
      testStrategy,
      reasoning: "",
    },
    rootConfig: DEFAULT_CONFIG,
    workdir: WORKDIR,
    projectDir: WORKDIR,
    prompt: "Your tdd-simple task: write tests first, then implement.",
    hooks: {} as PipelineContext["hooks"],
    ...overrides,
  } as unknown as PipelineContext;
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

function makeConfig(): NaxConfig {
  return {
    agent: { default: "test-agent" },
    models: {
      "test-agent": {
        fast: "claude-haiku-4-5",
        balanced: "claude-sonnet-4-5",
        powerful: "claude-opus-4-5",
      },
    },
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
      triggers: {},
    },
  } as unknown as NaxConfig;
}

function makeAgent(success = true) {
  return makeAgentAdapter({
    name: "test-agent",
    capabilities: { supportedTiers: ["fast", "balanced", "powerful"] },
    run: mock(async () => ({
      success,
      exitCode: success ? 0 : 1,
      output: success ? "All tests passed" : "Tests failed",
      stderr: success ? "" : "Error output",
      rateLimited: false,
      durationMs: 100,
      estimatedCost: 0.01,
    })),
  });
}

function makeCtx(
  testStrategy: "test-after" | "tdd-simple" | "three-session-tdd" | "three-session-tdd-lite",
  overrides: Partial<PipelineContext> = {},
): PipelineContext {
  const story = makeStory();
  return {
    config: makeConfig(),
    prd: makePRD(),
    story,
    stories: [story],
    routing: {
      complexity: "simple",
      modelTier: "fast",
      testStrategy,
      reasoning: "",
    },
    rootConfig: DEFAULT_CONFIG,
    workdir: WORKDIR,
    projectDir: WORKDIR,
    prompt: "Your tdd-simple task: write tests first, then implement.",
    hooks: {} as PipelineContext["hooks"],
    ...overrides,
  } as unknown as PipelineContext;
}

afterEach(() => {
  mock.restore();
  _executionDeps.getAgent = originalGetAgent;
  _executionDeps.validateAgentForTier = originalValidateAgentForTier;
  _executionDeps.detectMergeConflict = originalDetectMergeConflict;
});

// ─────────────────────────────────────────────────────────────────────────────
// tdd-simple: uses single-session path (not TDD orchestrator)
// ─────────────────────────────────────────────────────────────────────────────

describe("executionStage — tdd-simple strategy", () => {
  test("successful session returns continue", async () => {
    const agent = makeAgent(true);
    _executionDeps.getAgent = mock(() => agent as unknown as ReturnType<typeof _executionDeps.getAgent>);
    _executionDeps.validateAgentForTier = mock(() => true);
    _executionDeps.detectMergeConflict = mock(() => false);

    const ctx = makeCtx("tdd-simple");
    const result = await executionStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(agent.run).toHaveBeenCalledTimes(1);
  });

  test("sets agentResult on success", async () => {
    const agent = makeAgent(true);
    _executionDeps.getAgent = mock(() => agent as unknown as ReturnType<typeof _executionDeps.getAgent>);
    _executionDeps.validateAgentForTier = mock(() => true);
    _executionDeps.detectMergeConflict = mock(() => false);

    const ctx = makeCtx("tdd-simple");
    await executionStage.execute(ctx);

    expect(ctx.agentResult).toBeDefined();
    expect(ctx.agentResult!.success).toBe(true);
  });

  test("failed session returns escalate", async () => {
    const agent = makeAgent(false);
    _executionDeps.getAgent = mock(() => agent as unknown as ReturnType<typeof _executionDeps.getAgent>);
    _executionDeps.validateAgentForTier = mock(() => true);
    _executionDeps.detectMergeConflict = mock(() => false);

    const ctx = makeCtx("tdd-simple");
    const result = await executionStage.execute(ctx);

    expect(result.action).toBe("escalate");
    expect(agent.run).toHaveBeenCalledTimes(1);
  });

  test("missing prompt returns fail (pipeline misconfiguration)", async () => {
    const agent = makeAgent(true);
    _executionDeps.getAgent = mock(() => agent as unknown as ReturnType<typeof _executionDeps.getAgent>);

    const ctx = makeCtx("tdd-simple", { prompt: undefined });
    const result = await executionStage.execute(ctx);

    expect(result.action).toBe("fail");
    expect((result as { reason?: string }).reason).toContain("Prompt not built");
    expect(agent.run).not.toHaveBeenCalled();
  });

  test("missing agent returns fail", async () => {
    _executionDeps.getAgent = mock(() => null as unknown as ReturnType<typeof _executionDeps.getAgent>);

    const ctx = makeCtx("tdd-simple");
    const result = await executionStage.execute(ctx);

    expect(result.action).toBe("fail");
    expect((result as { reason?: string }).reason).toContain("not found");
  });

  test("passes prompt from ctx to agent.run()", async () => {
    const agent = makeAgent(true);
    _executionDeps.getAgent = mock(() => agent as unknown as ReturnType<typeof _executionDeps.getAgent>);
    _executionDeps.validateAgentForTier = mock(() => true);
    _executionDeps.detectMergeConflict = mock(() => false);

    const expectedPrompt = "TDD-Simple role: write failing tests first";
    const ctx = makeCtx("tdd-simple", { prompt: expectedPrompt });
    await executionStage.execute(ctx);

    const callArgs = (agent.run as ReturnType<typeof mock>).mock.calls[0];
    expect(callArgs[0].prompt).toBe(expectedPrompt);
  });

  test("does NOT call three-session TDD orchestrator", async () => {
    const agent = makeAgent(true);
    _executionDeps.getAgent = mock(() => agent as unknown as ReturnType<typeof _executionDeps.getAgent>);
    _executionDeps.validateAgentForTier = mock(() => true);
    _executionDeps.detectMergeConflict = mock(() => false);

    const ctx = makeCtx("tdd-simple");
    const result = await executionStage.execute(ctx);

    // Single-session path was used: agent.run() called directly
    expect(agent.run).toHaveBeenCalledTimes(1);
    // No tddFailureCategory set (only set by TDD orchestrator on failure)
    expect(ctx.tddFailureCategory).toBeUndefined();
    expect(result.action).toBe("continue");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// No regression: test-after uses single-session path (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

describe("executionStage — test-after strategy (no regression)", () => {
  test("successful session returns continue", async () => {
    const agent = makeAgent(true);
    _executionDeps.getAgent = mock(() => agent as unknown as ReturnType<typeof _executionDeps.getAgent>);
    _executionDeps.validateAgentForTier = mock(() => true);
    _executionDeps.detectMergeConflict = mock(() => false);

    const ctx = makeCtx("test-after");
    const result = await executionStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(agent.run).toHaveBeenCalledTimes(1);
  });

  test("failed session returns escalate", async () => {
    const agent = makeAgent(false);
    _executionDeps.getAgent = mock(() => agent as unknown as ReturnType<typeof _executionDeps.getAgent>);
    _executionDeps.validateAgentForTier = mock(() => true);
    _executionDeps.detectMergeConflict = mock(() => false);

    const ctx = makeCtx("test-after");
    const result = await executionStage.execute(ctx);

    expect(result.action).toBe("escalate");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// No regression: three-session-tdd still calls TDD orchestrator (not agent.run)
// ─────────────────────────────────────────────────────────────────────────────

describe("executionStage — three-session-tdd strategy (no regression)", () => {
  test("does NOT call agent.run() directly for three-session-tdd", async () => {
    const agent = makeAgent(true);
    _executionDeps.getAgent = mock(() => agent as unknown as ReturnType<typeof _executionDeps.getAgent>);

    // The TDD orchestrator will fail (no real agent), but we just check agent.run() wasn't called
    const ctx = makeCtx("three-session-tdd");
    try {
      await executionStage.execute(ctx);
    } catch {
      // TDD orchestrator may throw without real infrastructure
    }

    // agent.run() should NOT have been called (TDD orchestrator handles sessions internally)
    expect(agent.run).not.toHaveBeenCalled();
  });
});
