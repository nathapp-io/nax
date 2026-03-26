/**
 * Tests for runRectificationLoop — model tier escalation (US-002)
 *
 * Covers:
 * - Escalation fires when escalateOnExhaustion=true, enabled=true, loop exhausted with failures
 * - Escalated agent.run receives the next tier from tierOrder
 * - No escalation when current tier is last in tierOrder (escalateTier returns null)
 * - Returns true when escalated verification succeeds; logs info with both tier names
 * - Returns false when escalated verification fails; logs warn with 'escalated rectification also failed'
 * - No escalation when escalateOnExhaustion=false
 * - No escalation when abortOnIncreasingFailures exits early (attempt < maxRetries)
 * - Total agent.run invocations = maxRetries + 1 when escalation fires
 * - _rectificationDeps.escalateTier is injectable
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentRunOptions } from "../../../src/agents/types";
import type { NaxConfig } from "../../../src/config";
import type { UserStory } from "../../../src/prd";
import { _rectificationDeps, runRectificationLoop } from "../../../src/verification/rectification-loop";
import { getSafeLogger, initLogger, resetLogger } from "../../../src/logger";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Test output that produces 1 failing test so shouldRetryRectification returns true
const FAILING_TEST_OUTPUT = "✗ my test [1ms]\n(fail) my test [1ms]\nerror: Expected 1 to be 2\n1 passed, 1 failed [1ms]";

// Test output that shows 0 failures (success)
const PASSING_TEST_OUTPUT = "✓ my test [1ms]\n1 passed, 0 failed [1ms]";

const TIER_ORDER = [
  { tier: "fast", attempts: 2 },
  { tier: "balanced", attempts: 2 },
  { tier: "powerful", attempts: 2 },
];

function makeStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "TS-001",
    title: "Implement feature",
    description: "Implement the feature",
    acceptanceCriteria: ["Test passes"],
    status: "pending",
    routing: { modelTier: "balanced", complexity: "medium" },
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
        enabled: true,
        tierOrder: TIER_ORDER,
      },
    },
    execution: {
      sessionTimeoutSeconds: 120,
      rectification: {
        maxRetries: 2,
        abortOnIncreasingFailures: false,
        escalateOnExhaustion: true,
      },
      permissionProfile: "cautious",
    },
    models: {
      fast: { provider: "anthropic", model: "claude-haiku-4-5" },
      balanced: { provider: "anthropic", model: "claude-sonnet-4-6" },
      powerful: { provider: "anthropic", model: "claude-opus-4-6" },
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

function makeAgent(runResult: Partial<Awaited<ReturnType<typeof _rectificationDeps.getAgent extends (name: string) => infer A ? Exclude<A, undefined>["run"] : never>>> = {}) {
  const defaults = { success: false, exitCode: 1, output: "failed", rateLimited: false, durationMs: 10, estimatedCost: 0 };
  return {
    name: "claude",
    run: mock(async (_opts: AgentRunOptions) => ({ ...defaults, ...runResult })),
    complete: mock(async (_prompt: string) => ""),
    isInstalled: mock(async () => true),
    buildCommand: mock((_opts: AgentRunOptions) => ["claude"]),
    buildAllowedEnv: mock((_opts?: AgentRunOptions) => ({})),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// _rectificationDeps.escalateTier injection
// ─────────────────────────────────────────────────────────────────────────────

describe("_rectificationDeps", () => {
  test("exports escalateTier as an injectable function", () => {
    expect(_rectificationDeps).toBeDefined();
    expect(typeof (_rectificationDeps as Record<string, unknown>).escalateTier).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runRectificationLoop — escalation on exhaustion
// ─────────────────────────────────────────────────────────────────────────────

describe("runRectificationLoop — escalation on exhaustion", () => {
  const origGetAgent = _rectificationDeps.getAgent;
  const origRunVerification = _rectificationDeps.runVerification;

  let capturedInfos: Array<{ stage: string; message: string; data: unknown }> = [];
  let capturedWarns: Array<{ stage: string; message: string; data: unknown }> = [];

  beforeEach(() => {
    resetLogger();
    initLogger({ level: "debug", headless: true });
    capturedInfos = [];
    capturedWarns = [];

    const logger = getSafeLogger();
    if (logger) {
      const origInfo = logger.info.bind(logger);
      (logger as any).info = (stage: string, message: string, data?: unknown) => {
        capturedInfos.push({ stage, message, data });
        origInfo(stage, message, data);
      };
      const origWarn = logger.warn.bind(logger);
      (logger as any).warn = (stage: string, message: string, data?: unknown) => {
        capturedWarns.push({ stage, message, data });
        origWarn(stage, message, data);
      };
    }
  });

  afterEach(() => {
    _rectificationDeps.getAgent = origGetAgent;
    _rectificationDeps.runVerification = origRunVerification;
    if ("escalateTier" in _rectificationDeps) {
      (_rectificationDeps as any).escalateTier = ((_rectificationDeps as any)._origEscalateTier ?? (_rectificationDeps as any).escalateTier);
    }
    resetLogger();
    mock.restore();
  });

  test("fires escalation when escalateOnExhaustion=true, enabled=true, loop exhausted with failures", async () => {
    const agentRunCalls: AgentRunOptions[] = [];
    const agent = makeAgent({ success: false });
    agent.run = mock(async (opts: AgentRunOptions) => {
      agentRunCalls.push(opts);
      return { success: false, exitCode: 1, output: "failed", rateLimited: false, durationMs: 10, estimatedCost: 0 };
    });

    _rectificationDeps.getAgent = mock(() => agent as any);

    // All retries fail, escalation also fails verification
    _rectificationDeps.runVerification = mock(async () => ({
      success: false,
      output: FAILING_TEST_OUTPUT,
    }));

    const config = makeConfig();
    // maxRetries = 2, so loop runs 2 times, then escalation = 1 more = total 3
    await runRectificationLoop({
      config,
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
    });

    // Should have invoked agent maxRetries + 1 = 3 times
    expect(agentRunCalls.length).toBe(3);
  });

  test("escalated agent.run receives modelTier: 'powerful' when current tier is 'balanced'", async () => {
    const agentRunCalls: AgentRunOptions[] = [];
    const agent = {
      name: "claude",
      run: mock(async (opts: AgentRunOptions) => {
        agentRunCalls.push(opts);
        return { success: false, exitCode: 1, output: "failed", rateLimited: false, durationMs: 10, estimatedCost: 0 };
      }),
      complete: mock(async (_prompt: string) => ""),
      isInstalled: mock(async () => true),
      buildCommand: mock((_opts: AgentRunOptions) => ["claude"]),
      buildAllowedEnv: mock((_opts?: AgentRunOptions) => ({})),
    };

    _rectificationDeps.getAgent = mock(() => agent as any);

    _rectificationDeps.runVerification = mock(async () => ({
      success: false,
      output: FAILING_TEST_OUTPUT,
    }));

    const config = makeConfig({
      autoMode: {
        defaultAgent: "claude",
        complexityRouting: {
          simple: "fast",
          medium: "balanced",
          complex: "powerful",
          expert: "powerful",
        },
        escalation: {
          enabled: true,
          tierOrder: TIER_ORDER,
        },
      },
    } as Partial<NaxConfig>);

    // story.routing.complexity = "medium" → modelTier = "balanced"
    await runRectificationLoop({
      config,
      workdir: "/tmp/test",
      story: makeStory({ routing: { modelTier: "balanced", complexity: "medium" } }),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
    });

    // The last call (escalation attempt) should use 'powerful'
    expect(agentRunCalls.length).toBeGreaterThan(0);
    const escalationCall = agentRunCalls[agentRunCalls.length - 1];
    expect(escalationCall.modelTier).toBe("powerful");
  });

  test("no escalation and returns false when current tier is last in tierOrder", async () => {
    const agentRunCalls: AgentRunOptions[] = [];
    const agent = {
      name: "claude",
      run: mock(async (opts: AgentRunOptions) => {
        agentRunCalls.push(opts);
        return { success: false, exitCode: 1, output: "failed", rateLimited: false, durationMs: 10, estimatedCost: 0 };
      }),
      complete: mock(async (_prompt: string) => ""),
      isInstalled: mock(async () => true),
      buildCommand: mock((_opts: AgentRunOptions) => ["claude"]),
      buildAllowedEnv: mock((_opts?: AgentRunOptions) => ({})),
    };

    _rectificationDeps.getAgent = mock(() => agent as any);

    _rectificationDeps.runVerification = mock(async () => ({
      success: false,
      output: FAILING_TEST_OUTPUT,
    }));

    // Stub escalateTier to return null (already at last tier)
    ((_rectificationDeps as any)._origEscalateTier) = (_rectificationDeps as any).escalateTier;
    (_rectificationDeps as any).escalateTier = mock(() => null);

    const result = await runRectificationLoop({
      config: makeConfig(),
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
    });

    // Only maxRetries calls, no escalation
    expect(agentRunCalls.length).toBe(2); // maxRetries = 2
    expect(result).toBe(false);
  });

  test("returns true and logs info with both tier names when escalated verification succeeds", async () => {
    const agentRunCalls: AgentRunOptions[] = [];
    const agent = {
      name: "claude",
      run: mock(async (opts: AgentRunOptions) => {
        agentRunCalls.push(opts);
        return { success: true, exitCode: 0, output: "ok", rateLimited: false, durationMs: 10, estimatedCost: 0 };
      }),
      complete: mock(async (_prompt: string) => ""),
      isInstalled: mock(async () => true),
      buildCommand: mock((_opts: AgentRunOptions) => ["claude"]),
      buildAllowedEnv: mock((_opts?: AgentRunOptions) => ({})),
    };

    _rectificationDeps.getAgent = mock(() => agent as any);

    // Normal retries fail, escalated attempt's verification succeeds
    let verificationCallCount = 0;
    _rectificationDeps.runVerification = mock(async () => {
      verificationCallCount++;
      // First maxRetries verifications fail, escalation verification succeeds
      const maxRetries = 2;
      if (verificationCallCount <= maxRetries) {
        return { success: false, output: FAILING_TEST_OUTPUT };
      }
      return { success: true, output: PASSING_TEST_OUTPUT };
    });

    const result = await runRectificationLoop({
      config: makeConfig(),
      workdir: "/tmp/test",
      story: makeStory({ routing: { modelTier: "balanced", complexity: "medium" } }),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
    });

    expect(result).toBe(true);

    // Should log info message containing both tier names
    const escalationSuccessLog = capturedInfos.find(
      (i) => String(i.message).includes("balanced") && String(i.message).includes("powerful"),
    );
    expect(escalationSuccessLog).toBeDefined();
  });

  test("returns false and logs warn with 'escalated rectification also failed' when escalated verification fails", async () => {
    const agent = {
      name: "claude",
      run: mock(async (_opts: AgentRunOptions) => ({
        success: true,
        exitCode: 0,
        output: "ok",
        rateLimited: false,
        durationMs: 10,
        estimatedCost: 0,
      })),
      complete: mock(async (_prompt: string) => ""),
      isInstalled: mock(async () => true),
      buildCommand: mock((_opts: AgentRunOptions) => ["claude"]),
      buildAllowedEnv: mock((_opts?: AgentRunOptions) => ({})),
    };

    _rectificationDeps.getAgent = mock(() => agent as any);

    // All verifications fail (including escalated attempt)
    _rectificationDeps.runVerification = mock(async () => ({
      success: false,
      output: FAILING_TEST_OUTPUT,
    }));

    const result = await runRectificationLoop({
      config: makeConfig(),
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
    });

    expect(result).toBe(false);

    const warnLog = capturedWarns.find((w) =>
      String(w.message).includes("escalated rectification also failed"),
    );
    expect(warnLog).toBeDefined();
  });

  test("no escalation when escalateOnExhaustion=false, returns false", async () => {
    const agentRunCalls: AgentRunOptions[] = [];
    const agent = {
      name: "claude",
      run: mock(async (opts: AgentRunOptions) => {
        agentRunCalls.push(opts);
        return { success: false, exitCode: 1, output: "failed", rateLimited: false, durationMs: 10, estimatedCost: 0 };
      }),
      complete: mock(async (_prompt: string) => ""),
      isInstalled: mock(async () => true),
      buildCommand: mock((_opts: AgentRunOptions) => ["claude"]),
      buildAllowedEnv: mock((_opts?: AgentRunOptions) => ({})),
    };

    _rectificationDeps.getAgent = mock(() => agent as any);

    _rectificationDeps.runVerification = mock(async () => ({
      success: false,
      output: FAILING_TEST_OUTPUT,
    }));

    const config = makeConfig({
      execution: {
        sessionTimeoutSeconds: 120,
        rectification: {
          maxRetries: 2,
          abortOnIncreasingFailures: false,
          escalateOnExhaustion: false,
        },
        permissionProfile: "cautious",
      },
    } as Partial<NaxConfig>);

    const result = await runRectificationLoop({
      config,
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
    });

    // Only maxRetries calls, no escalation
    expect(agentRunCalls.length).toBe(2);
    expect(result).toBe(false);
  });

  test("no escalation when abortOnIncreasingFailures exits early (attempt < maxRetries)", async () => {
    const agentRunCalls: AgentRunOptions[] = [];
    const agent = {
      name: "claude",
      run: mock(async (opts: AgentRunOptions) => {
        agentRunCalls.push(opts);
        return { success: false, exitCode: 1, output: "failed", rateLimited: false, durationMs: 10, estimatedCost: 0 };
      }),
      complete: mock(async (_prompt: string) => ""),
      isInstalled: mock(async () => true),
      buildCommand: mock((_opts: AgentRunOptions) => ["claude"]),
      buildAllowedEnv: mock((_opts?: AgentRunOptions) => ({})),
    };

    _rectificationDeps.getAgent = mock(() => agent as any);

    // Return more failures than initial to trigger abortOnIncreasingFailures
    // Initial output has 1 failure; retry output has 5 failures
    const worseOutput =
      "✗ test1 [1ms]\n(fail) test1 [1ms]\nerror: err\n" +
      "✗ test2 [1ms]\n(fail) test2 [1ms]\nerror: err\n" +
      "✗ test3 [1ms]\n(fail) test3 [1ms]\nerror: err\n" +
      "✗ test4 [1ms]\n(fail) test4 [1ms]\nerror: err\n" +
      "✗ test5 [1ms]\n(fail) test5 [1ms]\nerror: err\n" +
      "5 passed, 5 failed [5ms]";

    _rectificationDeps.runVerification = mock(async () => ({
      success: false,
      output: worseOutput,
    }));

    const config = makeConfig({
      execution: {
        sessionTimeoutSeconds: 120,
        rectification: {
          maxRetries: 3, // set higher so early abort is at attempt 1 < 3
          abortOnIncreasingFailures: true,
          escalateOnExhaustion: true,
        },
        permissionProfile: "cautious",
      },
    } as Partial<NaxConfig>);

    const result = await runRectificationLoop({
      config,
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT, // 1 failure
    });

    // Should abort after 1 attempt (not maxRetries=3), so no escalation
    expect(agentRunCalls.length).toBe(1);
    expect(result).toBe(false);
  });

  test("total agent.run invocations equals maxRetries + 1 when escalation fires", async () => {
    const agentRunCalls: AgentRunOptions[] = [];
    const agent = {
      name: "claude",
      run: mock(async (opts: AgentRunOptions) => {
        agentRunCalls.push(opts);
        return { success: false, exitCode: 1, output: "failed", rateLimited: false, durationMs: 10, estimatedCost: 0 };
      }),
      complete: mock(async (_prompt: string) => ""),
      isInstalled: mock(async () => true),
      buildCommand: mock((_opts: AgentRunOptions) => ["claude"]),
      buildAllowedEnv: mock((_opts?: AgentRunOptions) => ({})),
    };

    _rectificationDeps.getAgent = mock(() => agent as any);

    _rectificationDeps.runVerification = mock(async () => ({
      success: false,
      output: FAILING_TEST_OUTPUT,
    }));

    const maxRetries = 3;
    const config = makeConfig({
      execution: {
        sessionTimeoutSeconds: 120,
        rectification: {
          maxRetries,
          abortOnIncreasingFailures: false,
          escalateOnExhaustion: true,
        },
        permissionProfile: "cautious",
      },
    } as Partial<NaxConfig>);

    await runRectificationLoop({
      config,
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
    });

    expect(agentRunCalls.length).toBe(maxRetries + 1);
  });
});
