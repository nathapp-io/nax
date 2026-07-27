// RE-ARCH: keep
/**
 * BUG-020: Verify storyId is present in JSONL event logger calls.
 *
 * Tests two key stages: verify, execution.
 * Uses mocks — does NOT spawn nax processes.
 *
 * Note: The tdd orchestrator describe block was removed in US-005 (AC#6) because
 * runThreeSessionTdd's dryRun behavior no longer exists in buildPlanForStrategy+plan.run().
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG } from "../../../src/config";
import { getLogger, initLogger, resetLogger } from "../../../src/logger";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { UserStory } from "../../../src/prd/types";
import { makeAgentAdapter, makeNaxConfig } from "../../../test/helpers";
import { fakeAgentManager } from "../../helpers/fake-agent-manager";

const WORKDIR = `/tmp/nax-test-storyid-${randomUUID()}`;

// ── Static imports (uses _deps pattern — no mock.module() needed) ────────────

import { _executionDeps, executionStage } from "../../../src/pipeline/stages/execution";

// ── Mock agent ────────────────────────────────────────────────────────────────

const mockAgentRun = mock(async () => ({
  success: true,
  rateLimited: false,
  estimatedCostUsd: 0.01,
  output: "done",
  exitCode: 0,
  durationMs: 100,
}));

const mockAgent = makeAgentAdapter({
  name: "claude",
  capabilities: { supportedTiers: ["balanced", "powerful"] },
  run: mockAgentRun,
  isInstalled: async () => true,
  buildCommand: () => ["claude"],
});

// ── Capture originals for afterEach restoration ───────────────────────────────

const _origExecutionDeps = { ..._executionDeps };

// ── Shared fixtures ───────────────────────────────────────────────────────────

const STORY_ID = "story-bug020-test";

const mockStory: UserStory = {
  id: STORY_ID,
  title: "Test story for BUG-020",
  description: "Verifies storyId appears in event payloads",
  acceptanceCriteria: [],
  status: "pending",
};

/**
 * Build a minimal PipelineContext with configurable quality overrides.
 */
function makeCtx(
  qualityOverrides: Partial<{ testCommand: string | undefined }> = {},
): PipelineContext {
  const { testCommand = undefined } = qualityOverrides;
  const config = makeNaxConfig({
      quality: {
        commands: { test: testCommand },
      },
      review: undefined,
      execution: {
        sessionTimeoutSeconds: 60,
        verificationTimeoutSeconds: 60,
        costLimit: 10,
        maxIterations: 50,
        iterationDelayMs: 0,
      },
      models: {
        claude: {
          fast: "claude-3-haiku-20240307",
          balanced: "claude-3-5-sonnet-20241022",
          powerful: "claude-opus-4-20250514",
        },
      },
      agent: { default: "claude" },
      tdd: { rollbackOnFailure: false },
  });
  return {
    config,
    story: mockStory,
    stories: [mockStory],
    routing: {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "test fixture",
    },
    rootConfig: DEFAULT_CONFIG,
    workdir: WORKDIR,
    projectDir: WORKDIR,
    prd: { feature: "test", userStories: [mockStory] },
    agentManager: fakeAgentManager(mockAgent),
    hooks: {} as any,
  } as PipelineContext;
}

// ── Logger lifecycle ──────────────────────────────────────────────────────────

beforeEach(() => {
  _executionDeps.getAgent = () => mockAgent as any;
  resetLogger();
  initLogger({ level: "silent" });
  mockAgentRun.mockClear();
});

afterEach(() => {
  Object.assign(_executionDeps, _origExecutionDeps);
  mock.restore();
  resetLogger();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

// BUG-020
describe("storyId is present in JSONL event payloads", () => {
  // ── Execution stage ─────────────────────────────────────────────────────────

  describe("execution stage", () => {
    test("agent tier mismatch debug log includes storyId", async () => {
      const logger = getLogger();
      const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
      spyOn(logger, "info").mockImplementation(() => {});
      spyOn(logger, "error").mockImplementation(() => {});

      const ctx = makeCtx();
      ctx.prompt = "implement the feature";
      await executionStage.execute(ctx);

      const call = debugSpy.mock.calls.find(([, msg]) => msg === "Agent tier mismatch — clamping to supported tier");
      expect(call).toBeDefined();
      expect(call![2]).toEqual(
        expect.objectContaining({
          storyId: STORY_ID,
          agentName: "claude",
          requestedTier: "fast",
        }),
      );
    });
  });
});
