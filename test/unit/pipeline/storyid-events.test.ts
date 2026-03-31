// RE-ARCH: keep
/**
 * BUG-020: Verify storyId is present in JSONL event logger calls.
 *
 * Tests three key stages: verify, execution, tdd orchestrator.
 * Uses mocks — does NOT spawn nax processes.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { NaxConfig } from "../../../src/config";
import { getLogger, initLogger, resetLogger } from "../../../src/logger";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { UserStory } from "../../../src/prd/types";

const WORKDIR = `/tmp/nax-test-storyid-${randomUUID()}`;

// ── Static imports (uses _deps pattern — no mock.module() needed) ────────────

import { verifyStage } from "../../../src/pipeline/stages/verify";
import { _executionDeps, executionStage } from "../../../src/pipeline/stages/execution";
import { runThreeSessionTdd } from "../../../src/tdd/orchestrator";

// ── Mock agent ────────────────────────────────────────────────────────────────

const mockAgentRun = mock(async () => ({
  success: true,
  rateLimited: false,
  estimatedCost: 0.01,
  output: "done",
  exitCode: 0,
  durationMs: 100,
}));

const mockAgent = {
  name: "claude",
  // Only supports "balanced"/"powerful" — triggers tier mismatch when ctx.routing.modelTier="fast"
  capabilities: { supportedTiers: ["balanced", "powerful"] },
  run: mockAgentRun,
  isInstalled: async () => true,
  buildCommand: () => ["claude"],
};

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
  qualityOverrides: Partial<{ requireTests: boolean; testCommand: string | undefined }> = {},
): PipelineContext {
  const { requireTests = false, testCommand = undefined } = qualityOverrides;
  return {
    config: {
      quality: {
        requireTests,
        commands: { test: testCommand },
      },
      review: undefined,
      execution: {
        sessionTimeoutSeconds: 60,
        verificationTimeoutSeconds: 60,
        dangerouslySkipPermissions: false,
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
      autoMode: { defaultAgent: "claude" },
      tdd: { rollbackOnFailure: false },
      routing: { strategy: "complexity", llm: { mode: "per-story" } },
    } as unknown as NaxConfig,
    story: mockStory,
    stories: [mockStory],
    routing: {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "test fixture",
    },
    workdir: WORKDIR,
    prd: { feature: "test", userStories: [mockStory] },
    hooks: {} as any,
  } as PipelineContext;
}

// ── Logger lifecycle ──────────────────────────────────────────────────────────

beforeEach(() => {
  _executionDeps.getAgent = () => mockAgent as any;
  resetLogger();
  initLogger({ level: "debug", useChalk: false });
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
  // ── Verify stage ────────────────────────────────────────────────────────────

  describe("verify stage", () => {
    test("skip log (requireTests=false) includes storyId", async () => {
      const logger = getLogger();
      const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});

      const ctx = makeCtx({ requireTests: false });
      await verifyStage.execute(ctx);

      const call = debugSpy.mock.calls.find(
        ([, msg]) => msg === "Skipping verification (quality.requireTests = false)",
      );
      expect(call).toBeDefined();
      expect(call![2]).toEqual(expect.objectContaining({ storyId: STORY_ID }));
    });

    test("skip log (no test command) includes storyId", async () => {
      const logger = getLogger();
      const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});

      const ctx = makeCtx({ requireTests: true, testCommand: undefined });
      await verifyStage.execute(ctx);

      const call = debugSpy.mock.calls.find(
        ([, msg]) => msg === "Skipping verification (no test command configured)",
      );
      expect(call).toBeDefined();
      expect(call![2]).toEqual(expect.objectContaining({ storyId: STORY_ID }));
    });
  });

  // ── Execution stage ─────────────────────────────────────────────────────────

  describe("execution stage", () => {
    test("agent tier mismatch warn includes storyId", async () => {
      const logger = getLogger();
      const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
      spyOn(logger, "info").mockImplementation(() => {});
      spyOn(logger, "error").mockImplementation(() => {});

      const ctx = makeCtx();
      ctx.prompt = "implement the feature";
      await executionStage.execute(ctx);

      const call = warnSpy.mock.calls.find(([, msg]) => msg === "Agent tier mismatch");
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

  // ── TDD orchestrator ────────────────────────────────────────────────────────

  describe("tdd orchestrator", () => {
    test("dry-run info log includes storyId", async () => {
      const logger = getLogger();
      const infoSpy = spyOn(logger, "info").mockImplementation(() => {});

      const mockAgent = {
        name: "dry-run-agent",
        capabilities: { supportedTiers: ["fast"] },
        run: mock(async () => ({
          success: true,
          rateLimited: false,
          estimatedCost: 0,
          output: "",
          exitCode: 0,
          durationMs: 0,
        })),
      };

      await runThreeSessionTdd({
        agent: mockAgent as any,
        story: mockStory,
        config: makeCtx().config,
        workdir: WORKDIR,
        modelTier: "fast",
        dryRun: true,
      });

      const dryRunCall = infoSpy.mock.calls.find(
        ([, msg]) => msg === "[DRY RUN] Would run 3-session TDD",
      );
      expect(dryRunCall).toBeDefined();
      expect(dryRunCall![2]).toEqual(expect.objectContaining({ storyId: STORY_ID }));
    });
  });
});
