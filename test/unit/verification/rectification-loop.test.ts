/**
 * Tests for runRectificationLoop — session context params
 *
 * Covers:
 * - runRectificationLoop passes featureName, storyId, and sessionRole to agent.run()
 * - runRectificationLoop works without featureName (backward compatibility)
 * - _rectificationDeps is injectable for testing without mock.module()
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AgentRunOptions } from "../../../src/agents/types";
import type { NaxConfig } from "../../../src/config";
import type { UserStory } from "../../../src/prd";
import { _rectificationDeps, runRectificationLoop } from "../../../src/verification/rectification-loop";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Bun test output with both a ✗ line (sets failed count) and a (fail) line (sets failures array)
const FAILING_TEST_OUTPUT =
  "✗ my test [1ms]\n(fail) my test [1ms]\nerror: Expected 1 to be 2";

function makeStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "TS-001",
    title: "Implement feature",
    description: "Implement the feature",
    acceptanceCriteria: ["Test passes"],
    status: "pending",
    routing: { modelTier: "balanced" },
    ...overrides,
  } as UserStory;
}

function makeConfig(overrides: Partial<NaxConfig> = {}): NaxConfig {
  return {
    autoMode: {
      defaultAgent: "claude",
      complexityRouting: {
        simple: "fast",
        medium: "balanced",
        complex: "powerful",
        expert: "powerful",
      },
      escalation: {
        tierOrder: [{ tier: "balanced" }],
      },
    },
    execution: {
      sessionTimeoutSeconds: 120,
      rectification: {
        maxRetries: 2,
        abortOnRegression: true,
      },
      permissionProfile: "cautious",
    },
    models: {
      balanced: { provider: "anthropic", model: "claude-haiku-4-5" },
    },
    agent: {
      maxInteractionTurns: 5,
    },
    quality: {
      forceExit: false,
      detectOpenHandles: false,
      detectOpenHandlesRetries: 0,
      gracePeriodMs: 0,
      drainTimeoutMs: 0,
    },
    ...overrides,
  } as unknown as NaxConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// _rectificationDeps injection
// ─────────────────────────────────────────────────────────────────────────────

describe("_rectificationDeps", () => {
  test("is exported from the module", () => {
    expect(_rectificationDeps).toBeDefined();
    expect(typeof _rectificationDeps.getAgent).toBe("function");
    expect(typeof _rectificationDeps.runVerification).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runRectificationLoop — session context params
// ─────────────────────────────────────────────────────────────────────────────

describe("runRectificationLoop — session context params", () => {
  const origGetAgent = _rectificationDeps.getAgent;
  const origRunVerification = _rectificationDeps.runVerification;

  afterEach(() => {
    _rectificationDeps.getAgent = origGetAgent;
    _rectificationDeps.runVerification = origRunVerification;
    mock.restore();
  });

  test("passes featureName, storyId, and sessionRole='implementer' to agent.run()", async () => {
    const capturedOptions: AgentRunOptions[] = [];

    const mockAgent = {
      name: "claude",
      run: mock(async (opts: AgentRunOptions) => {
        capturedOptions.push(opts);
        return { success: true, exitCode: 0, output: "done", rateLimited: false, durationMs: 10, estimatedCost: 0 };
      }),
      complete: mock(async (_prompt: string) => ""),
      isInstalled: mock(async () => true),
      buildCommand: mock((_opts: AgentRunOptions) => ["claude"]),
      buildAllowedEnv: mock((_opts?: AgentRunOptions) => ({})),
    };

    _rectificationDeps.getAgent = mock(
      (_name: string) => mockAgent as unknown as import("../../../src/agents/types").AgentAdapter,
    );

    // Mock verification to return success so the loop exits after first attempt
    _rectificationDeps.runVerification = mock(async () => ({
      success: true,
      output: "1 pass, 0 fail",
    }));

    const result = await runRectificationLoop({
      config: makeConfig(),
      workdir: "/tmp/test",
      story: makeStory({ id: "TS-001" }),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
      featureName: "my-feature",
    });

    expect(result).toBe(true);
    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0].featureName).toBe("my-feature");
    expect(capturedOptions[0].storyId).toBe("TS-001");
    expect(capturedOptions[0].sessionRole).toBe("implementer");
  });

  test("passes undefined featureName when not provided (backward compatibility)", async () => {
    const capturedOptions: AgentRunOptions[] = [];

    const mockAgent = {
      name: "claude",
      run: mock(async (opts: AgentRunOptions) => {
        capturedOptions.push(opts);
        return { success: true, exitCode: 0, output: "done", rateLimited: false, durationMs: 10, estimatedCost: 0 };
      }),
      complete: mock(async (_prompt: string) => ""),
      isInstalled: mock(async () => true),
      buildCommand: mock((_opts: AgentRunOptions) => ["claude"]),
      buildAllowedEnv: mock((_opts?: AgentRunOptions) => ({})),
    };

    _rectificationDeps.getAgent = mock(
      (_name: string) => mockAgent as unknown as import("../../../src/agents/types").AgentAdapter,
    );

    _rectificationDeps.runVerification = mock(async () => ({
      success: true,
      output: "1 pass, 0 fail",
    }));

    await runRectificationLoop({
      config: makeConfig(),
      workdir: "/tmp/test",
      story: makeStory({ id: "TS-002" }),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
      // featureName intentionally omitted
    });

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0].featureName).toBeUndefined();
    expect(capturedOptions[0].storyId).toBe("TS-002");
    expect(capturedOptions[0].sessionRole).toBe("implementer");
  });

  test("returns false when agent not found", async () => {
    _rectificationDeps.getAgent = mock((_name: string) => undefined);

    const result = await runRectificationLoop({
      config: makeConfig(),
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
      featureName: "my-feature",
    });

    expect(result).toBe(false);
  });

  test("storyId is always passed from story.id regardless of featureName", async () => {
    const capturedOptions: AgentRunOptions[] = [];

    const mockAgent = {
      name: "claude",
      run: mock(async (opts: AgentRunOptions) => {
        capturedOptions.push(opts);
        return { success: false, exitCode: 1, output: "failed", rateLimited: false, durationMs: 10, estimatedCost: 0 };
      }),
      complete: mock(async (_prompt: string) => ""),
      isInstalled: mock(async () => true),
      buildCommand: mock((_opts: AgentRunOptions) => ["claude"]),
      buildAllowedEnv: mock((_opts?: AgentRunOptions) => ({})),
    };

    _rectificationDeps.getAgent = mock(
      (_name: string) => mockAgent as unknown as import("../../../src/agents/types").AgentAdapter,
    );

    _rectificationDeps.runVerification = mock(async () => ({
      success: false,
      output: "1 fail",
    }));

    await runRectificationLoop({
      config: makeConfig(),
      workdir: "/tmp/test",
      story: makeStory({ id: "CUSTOM-999" }),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
    });

    // Should have attempted maxRetries times
    expect(capturedOptions.length).toBeGreaterThan(0);
    for (const opts of capturedOptions) {
      expect(opts.storyId).toBe("CUSTOM-999");
    }
  });
});
