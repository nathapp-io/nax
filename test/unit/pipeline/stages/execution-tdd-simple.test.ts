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
import { executionStage, _executionDeps } from "../../../../src/pipeline/stages/execution";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { PRD } from "../../../../src/prd";
import { makeAgentAdapter, makeMockAgentManager, makeNaxConfig, makeStory } from "../../../../test/helpers";
import { fakeAgentManager } from "../../../../test/helpers/fake-agent-manager";

const WORKDIR = `/tmp/nax-test-exec-${randomUUID()}`;

// ─────────────────────────────────────────────────────────────────────────────
// Save originals for restoration
// ─────────────────────────────────────────────────────────────────────────────

const originalGetAgent = _executionDeps.getAgent;
const originalValidateAgentForTier = _executionDeps.validateAgentForTier;
const originalDetectMergeConflict = _executionDeps.detectMergeConflict;
const originalRunThreeSessionTddFromCtx = _executionDeps.runThreeSessionTddFromCtx;

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
        costLimit: 10,
        maxIterations: 10,
        rectification: { maxRetries: 3 },
      },
      interaction: {
        plugin: "cli",
        defaults: { timeout: 30000, fallback: "abort" as const },
        triggers: {},
      },
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
    agentManager: (() => { const a = _executionDeps.getAgent?.("claude"); return a ? fakeAgentManager(a, "claude") : fakeAgentManager(makeAgentAdapter({ name: "claude" })); })(),
    ...overrides,
  } as unknown as PipelineContext;
}

function makeAgent(success = true) {
  return makeAgentAdapter({
    name: "test-agent",
    capabilities: { supportedTiers: ["fast", "balanced", "powerful"], maxContextTokens: 100_000, features: new Set<"tdd" | "review" | "refactor" | "batch">() },
    openSession: mock(async () => ({ id: "mock-session", agentName: "test-agent" })),
    sendTurn: mock(async () => {
      if (!success) {
        throw new Error("Tests failed");
      }
      return { output: "All tests passed", tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 1 };
    }),
    closeSession: mock(async () => {}),
  });
}

afterEach(() => {
  mock.restore();
  _executionDeps.getAgent = originalGetAgent;
  _executionDeps.validateAgentForTier = originalValidateAgentForTier;
  _executionDeps.detectMergeConflict = originalDetectMergeConflict;
  _executionDeps.runThreeSessionTddFromCtx = originalRunThreeSessionTddFromCtx;
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
    expect(agent.openSession).toHaveBeenCalledTimes(1);
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
    expect(agent.openSession).toHaveBeenCalledTimes(1);
  });

  test("missing prompt returns fail (pipeline misconfiguration)", async () => {
    const agent = makeAgent(true);
    _executionDeps.getAgent = mock(() => agent as unknown as ReturnType<typeof _executionDeps.getAgent>);

    const ctx = makeCtx("tdd-simple", { prompt: undefined as unknown as string });
    const result = await executionStage.execute(ctx);

    expect(result.action).toBe("fail");
    expect((result as { reason?: string }).reason).toContain("Prompt not built");
    expect(agent.openSession).not.toHaveBeenCalled();
  });

  test("missing agent returns fail", async () => {
    _executionDeps.getAgent = mock(() => null as unknown as ReturnType<typeof _executionDeps.getAgent>);

    const ctx = makeCtx("tdd-simple");
    const result = await executionStage.execute(ctx);

    expect(result.action).toBe("fail");
    expect((result as { reason?: string }).reason).toContain("not found");
  });

  test("passes prompt from ctx to agent sendTurn()", async () => {
    const agent = makeAgent(true);
    _executionDeps.getAgent = mock(() => agent as unknown as ReturnType<typeof _executionDeps.getAgent>);
    _executionDeps.validateAgentForTier = mock(() => true);
    _executionDeps.detectMergeConflict = mock(() => false);

    const expectedPrompt = "TDD-Simple role: write failing tests first";
    const ctx = makeCtx("tdd-simple", { prompt: expectedPrompt });
    await executionStage.execute(ctx);

    // sendTurn(handle, prompt, opts) — prompt is the second argument
    const callArgs = (agent.sendTurn as ReturnType<typeof mock>).mock.calls[0];
    expect(callArgs[1]).toBe(expectedPrompt);
  });

  test("does NOT call three-session TDD orchestrator", async () => {
    const agent = makeAgent(true);
    _executionDeps.getAgent = mock(() => agent as unknown as ReturnType<typeof _executionDeps.getAgent>);
    _executionDeps.validateAgentForTier = mock(() => true);
    _executionDeps.detectMergeConflict = mock(() => false);

    const ctx = makeCtx("tdd-simple");
    const result = await executionStage.execute(ctx);

    // Single-session path was used: openSession called directly
    expect(agent.openSession).toHaveBeenCalledTimes(1);
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
    expect(agent.openSession).toHaveBeenCalledTimes(1);
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
// No regression: three-session-tdd still calls TDD orchestrator (not single-session path)
// ─────────────────────────────────────────────────────────────────────────────

describe("executionStage — three-session-tdd strategy (no regression)", () => {
  test("routes through runThreeSessionTddFromCtx (not single-session path)", async () => {
    const agent = makeAgent(true);
    _executionDeps.getAgent = mock(() => agent as unknown as ReturnType<typeof _executionDeps.getAgent>);

    let tddCalled = false;
    _executionDeps.runThreeSessionTddFromCtx = mock(async () => {
      tddCalled = true;
      return {
        success: true,
        sessions: [],
        totalCost: 0,
        needsHumanReview: false,
        lite: false,
      };
    });

    const ctx = makeCtx("three-session-tdd");
    await executionStage.execute(ctx);

    // Must route through the TDD orchestrator, not the single-session path
    expect(tddCalled).toBe(true);
  });
});
