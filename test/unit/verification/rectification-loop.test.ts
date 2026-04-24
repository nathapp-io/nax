/**
 * Tests for runRectificationLoop — session context params
 *
 * Covers:
 * - runRectificationLoop passes featureName, storyId, and sessionRole to agent.run()
 * - runRectificationLoop works without featureName (backward compatibility)
 * - _rectificationDeps is injectable for testing without mock.module()
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentRunOptions } from "../../../src/agents/types";
import type { NaxConfig } from "../../../src/config";
import type { UserStory } from "../../../src/prd";
import { _rectificationDeps, runRectificationLoop } from "../../../src/verification/rectification-loop";
import { getSafeLogger, initLogger, resetLogger } from "../../../src/logger";
import { makeMockAgentManager } from "../../helpers";

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
      claude: {
        balanced: { provider: "anthropic", model: "claude-haiku-4-5" },
      },
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
    expect(_rectificationDeps).toHaveProperty("agentManager");
    expect(typeof _rectificationDeps.runVerification).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runRectificationLoop — session context params
// ─────────────────────────────────────────────────────────────────────────────

describe("runRectificationLoop — session context params", () => {
  const origAgentManager = _rectificationDeps.agentManager;
  const origRunVerification = _rectificationDeps.runVerification;
  const origEscalateTier = _rectificationDeps.escalateTier;

  afterEach(() => {
    _rectificationDeps.agentManager = origAgentManager;
    _rectificationDeps.runVerification = origRunVerification;
    _rectificationDeps.escalateTier = origEscalateTier;
    mock.restore();
  });

  test("passes featureName, storyId, and sessionRole='implementer' to agent.run()", async () => {
    const capturedRunOptions: Array<{ type: "run" | "runAs"; opts: any }> = [];

    const runFn = mock(async (agentName: string, opts: any) => {
      capturedRunOptions.push({ type: "run", opts: { ...opts, agent: agentName } });
      return { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 10, estimatedCost: 0, agentFallbacks: [] };
    });
    const runWithFallbackFn = mock(async (req: any) => ({ result: await runFn(req.runOptions.agent, req.runOptions), fallbacks: [] }));

    const mockAgentManager = makeMockAgentManager({
      runFn,
      runWithFallbackFn,
      runAs: mock(async (agentName: string, req: any) => {
        capturedRunOptions.push({ type: "runAs", opts: { ...req.runOptions, agent: agentName } });
        return { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 10, estimatedCost: 0, agentFallbacks: [] };
      }),
      completeWithFallbackFn: mock(async () => ({ result: { output: "", estimatedCost: 0 }, fallbacks: [] })),
      planAsFn: mock(async () => ({ result: { plan: "", estimatedCost: 0 }, fallbacks: [] })),
      decomposeAsFn: mock(async () => ({ result: { stories: [] }, fallbacks: [] })),
    });

    _rectificationDeps.agentManager = mockAgentManager;

    // Mock verification to return success so the loop exits after first attempt
    _rectificationDeps.runVerification = mock(async () => ({
      success: true,
      output: "1 pass, 0 fail",
      status: "SUCCESS" as const,
      countsTowardEscalation: true,
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

    expect(result.succeeded).toBe(true);
    expect(capturedRunOptions).toHaveLength(1);
    expect(capturedRunOptions[0].opts.featureName).toBe("my-feature");
    expect(capturedRunOptions[0].opts.storyId).toBe("TS-001");
    expect(capturedRunOptions[0].opts.sessionRole).toBe("implementer");
  });

  test("passes undefined featureName when not provided (backward compatibility)", async () => {
    const capturedOptions: AgentRunOptions[] = [];

    const mockAgent = {
      name: "claude",
      run: mock(async (_opts: AgentRunOptions) => {
        return { success: true, exitCode: 0, output: "done", rateLimited: false, durationMs: 10, estimatedCost: 0 };
      }),
      complete: mock(async (_prompt: string) => ""),
      isInstalled: mock(async () => true),
      buildCommand: mock((_opts: AgentRunOptions) => ["claude"]),
      buildAllowedEnv: mock((_opts?: AgentRunOptions) => ({})),
    };

    const mockAgentManager = makeMockAgentManager({
      getAgentFn: (_name: string) => mockAgent as unknown as import("../../../src/agents/types").AgentAdapter,
      runFn: mock(async (_agentName: string, opts: AgentRunOptions) => {
        capturedOptions.push(opts);
        return { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 10, estimatedCost: 0, agentFallbacks: [] };
      }),
    });

    _rectificationDeps.agentManager = mockAgentManager;

    _rectificationDeps.runVerification = mock(async () => ({
      success: true,
      output: "1 pass, 0 fail",
      status: "SUCCESS" as const,
      countsTowardEscalation: true,
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
    _rectificationDeps.agentManager = makeMockAgentManager({
      getAgentFn: () => undefined,
      runFn: mock(async () => ({ success: false, exitCode: 1, output: "failed", rateLimited: false, durationMs: 10, estimatedCost: 0, agentFallbacks: [] })),
    });

    _rectificationDeps.runVerification = mock(async () => ({
      success: false,
      status: "TEST_FAILURE" as const,
      output: FAILING_TEST_OUTPUT,
      countsTowardEscalation: true,
    }));

    const result = await runRectificationLoop({
      config: makeConfig(),
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
      featureName: "my-feature",
    });

    expect(result.succeeded).toBe(false);
  });

  test("includes raw test output in the rectification prompt when failed tests are unmapped", async () => {
    const capturedPrompts: string[] = [];
    const unmappedOutput = `
test/example.test.ts:
✓ passing test [0.5ms]
✗ compile failure 1 [1.2ms]
✗ compile failure 2 [1.3ms]

src/foo.ts:12:8 - error TS2304: Cannot find name 'missingSymbol'

3 passed, 2 failed [1.7ms]
    `.trim();

    _rectificationDeps.agentManager = makeMockAgentManager({
      runFn: mock(async (_agentName: string, opts: AgentRunOptions) => {
          capturedPrompts.push(opts.prompt);
          return { success: false, exitCode: 1, output: "failed", rateLimited: false, durationMs: 10, estimatedCost: 0, agentFallbacks: [] };
      }),
    });

    _rectificationDeps.runVerification = mock(async () => ({
      success: false,
      output: unmappedOutput,
      status: "TEST_FAILURE" as const,
      countsTowardEscalation: true,
    }));

    await runRectificationLoop({
      config: makeConfig({
        execution: {
          sessionTimeoutSeconds: 120,
          rectification: {
            maxRetries: 1,
            abortOnRegression: true,
          },
          permissionProfile: "cautious",
        },
      } as unknown as Partial<NaxConfig>),
      workdir: "/tmp/test",
      story: makeStory({ id: "TS-UNMAPPED" }),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: unmappedOutput,
    });

    expect(capturedPrompts).toHaveLength(1);
    expect(capturedPrompts[0]).toContain("Unmapped test failures (2 detected)");
    expect(capturedPrompts[0]).toContain("Structured test failure parsing returned no failure records");
    expect(capturedPrompts[0]).toContain("Cannot find name 'missingSymbol'");
  });

  test("uses _rectificationDeps.agentManager when no agentManager is provided in opts (ADR-018)", async () => {
    const config = makeConfig({
      agent: {
        protocol: "acp",
        maxInteractionTurns: 5,
      },
    } as unknown as Partial<NaxConfig>);

    // Set the injected agentManager (DI pattern — createManager no longer exists)
    _rectificationDeps.agentManager = makeMockAgentManager({
      runFn: mock(async () => ({ success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 10, estimatedCost: 0, agentFallbacks: [] })),
    });

    _rectificationDeps.runVerification = mock(async () => ({
      success: true,
      output: "1 pass, 0 fail",
      status: "SUCCESS" as const,
      countsTowardEscalation: true,
    }));

    const result = await runRectificationLoop({
      config,
      workdir: "/tmp/test",
      story: makeStory({ id: "TS-ACP" }),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
      // no agentManager in opts — uses _rectificationDeps.agentManager
    });

    expect(result.succeeded).toBe(true);
  });

  test("escalation works correctly with _rectificationDeps.agentManager (ADR-018)", async () => {
    const config = makeConfig({
      models: {
        claude: {
          fast: { provider: "anthropic", model: "claude-haiku-4-5" },
          balanced: { provider: "anthropic", model: "claude-haiku-4-5" },
        },
      },
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
          tierOrder: [
            { tier: "fast" },
            { tier: "balanced" },
          ],
        },
      },
      execution: {
        sessionTimeoutSeconds: 120,
        permissionProfile: "cautious",
        rectification: {
          maxRetries: 1,
          abortOnRegression: true,
          escalateOnExhaustion: true,
        },
      },
    } as unknown as Partial<NaxConfig>);

    let verifyCallCount = 0;

    // Set the injected agentManager (DI pattern — createManager no longer exists)
    _rectificationDeps.agentManager = makeMockAgentManager({
      runFn: mock(async () => ({ success: false, exitCode: 1, output: "failed", rateLimited: false, durationMs: 10, estimatedCost: 0, agentFallbacks: [] })),
    });

    _rectificationDeps.escalateTier = mock(() => ({ tier: "balanced", agent: "claude" }));

    _rectificationDeps.runVerification = mock(async () => {
      verifyCallCount += 1;
      return {
        success: false,
        status: "TEST_FAILURE" as const,
        output: "✗ still failing\n(fail) still failing",
        countsTowardEscalation: true,
      };
    });

    const result = await runRectificationLoop({
      config,
      workdir: "/tmp/test",
      story: makeStory({ id: "TS-ESC", routing: { complexity: "simple", modelTier: "fast" } as never }),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
    });

    expect(result.succeeded).toBe(false);
    expect(verifyCallCount).toBeGreaterThanOrEqual(1);
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

    _rectificationDeps.agentManager = makeMockAgentManager({
      getAgentFn: () => mockAgent as unknown as import("../../../src/agents/types").AgentAdapter,
      runFn: mock(async (agentName: string, opts: AgentRunOptions) => {
      capturedOptions.push(opts);
      return { success: false, exitCode: 1, output: "failed", rateLimited: false, durationMs: 10, estimatedCost: 0, agentFallbacks: [] };
      }),
      runAs: mock(async (_name: string, req: any) => {
      capturedOptions.push(req.runOptions);
      return { success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 10, estimatedCost: 0, agentFallbacks: [] };
      }),
    });

    _rectificationDeps.runVerification = mock(async () => ({
      success: false,
      status: "TEST_FAILURE" as const,
      output: "1 fail",
      countsTowardEscalation: true,
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

// ─────────────────────────────────────────────────────────────────────────────
// runRectificationLoop — logging failing test names
// ─────────────────────────────────────────────────────────────────────────────

describe("runRectificationLoop — logging failing test names", () => {
  const origAgentManager = _rectificationDeps.agentManager;
  const origRunVerification = _rectificationDeps.runVerification;

  let capturedWarns: Array<{ stage: string; message: string; data: unknown }> = [];

  beforeEach(() => {
    resetLogger();
    initLogger({ level: "warn", headless: true });
    capturedWarns = [];

    // Patch the logger to capture warn calls
    const logger = getSafeLogger();
    if (logger) {
      const origWarn = logger.warn.bind(logger);
      (logger as any).warn = (stage: string, message: string, data?: unknown) => {
        capturedWarns.push({ stage, message, data });
        // Call original to maintain normal behavior
        origWarn(stage, message, data);
      };
    }
  });

  afterEach(() => {
    _rectificationDeps.agentManager = origAgentManager;
    _rectificationDeps.runVerification = origRunVerification;
    resetLogger();
    mock.restore();
  });

  test("logs failingTests with all testName strings when 10 or fewer failures", async () => {
    const mockAgent = {
      name: "claude",
      run: mock(async (_opts: AgentRunOptions) => {
        return { success: false, exitCode: 1, output: "failed", rateLimited: false, durationMs: 10, estimatedCost: 0 };
      }),
      complete: mock(async (_prompt: string) => ""),
      isInstalled: mock(async () => true),
      buildCommand: mock((_opts: AgentRunOptions) => ["claude"]),
      buildAllowedEnv: mock((_opts?: AgentRunOptions) => ({})),
    };

    _rectificationDeps.agentManager = makeMockAgentManager({
      getAgentFn: () => mockAgent as unknown as import("../../../src/agents/types").AgentAdapter,
      runFn: mock(async () => ({ success: false, exitCode: 1, output: "failed", rateLimited: false, durationMs: 10, estimatedCost: 0, agentFallbacks: [] })),
      runAs: mock(async () => ({ success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 10, estimatedCost: 0, agentFallbacks: [] })),
    });

    const retryOutput = `
test/example.test.ts:
✓ passing test [0.5ms]
✗ first failing test [1.2ms]
✗ second failing test [1.3ms]

(fail) first failing test [1.2ms]
Error: Expected 1 to equal 2

(fail) second failing test [1.3ms]
Error: Expected true to be false

2 passed, 2 failed [1.7ms]
    `.trim();

    _rectificationDeps.runVerification = mock(async () => ({
      success: false,
      output: retryOutput,
      status: "TEST_FAILURE" as const,
      countsTowardEscalation: true,
    }));

    await runRectificationLoop({
      config: makeConfig(),
      workdir: "/tmp/test",
      story: makeStory({ id: "TS-001" }),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: "✗ test [1ms]\n(fail) test [1ms]\nerror: failed\n1 passed, 1 failed [1ms]",
    });

    const failingLog = capturedWarns.find((w) =>
      String(w.message).includes("still failing after attempt"),
    );
    expect(failingLog).toBeDefined();
    expect((failingLog?.data as Record<string, unknown>)?.failingTests).toBeDefined();
    const failingTests = (failingLog?.data as Record<string, unknown>)?.failingTests as string[];
    expect(Array.isArray(failingTests)).toBe(true);
    expect(failingTests.includes("first failing test")).toBe(true);
    expect(failingTests.includes("second failing test")).toBe(true);
  });

  test("logs failingTests (first 10) and totalFailingTests when more than 10 failures", async () => {
    const mockAgent = {
      name: "claude",
      run: mock(async (_opts: AgentRunOptions) => {
        return { success: false, exitCode: 1, output: "failed", rateLimited: false, durationMs: 10, estimatedCost: 0 };
      }),
      complete: mock(async (_prompt: string) => ""),
      isInstalled: mock(async () => true),
      buildCommand: mock((_opts: AgentRunOptions) => ["claude"]),
      buildAllowedEnv: mock((_opts?: AgentRunOptions) => ({})),
    };

    _rectificationDeps.agentManager = makeMockAgentManager({
      getAgentFn: () => mockAgent as unknown as import("../../../src/agents/types").AgentAdapter,
      runFn: mock(async () => ({ success: false, exitCode: 1, output: "failed", rateLimited: false, durationMs: 10, estimatedCost: 0, agentFallbacks: [] })),
      runAs: mock(async () => ({ success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 10, estimatedCost: 0, agentFallbacks: [] })),
    });

    // Create test output with 15 failures
    let retryOutput = "test/example.test.ts:\n";
    for (let i = 1; i <= 15; i++) {
      retryOutput += `✗ test ${i} [${i}ms]\n`;
    }
    retryOutput += "\n";
    for (let i = 1; i <= 15; i++) {
      retryOutput += `(fail) test ${i} [${i}ms]\nError: Test ${i} failed\n`;
    }
    retryOutput += "15 passed, 15 failed [100ms]";

    _rectificationDeps.runVerification = mock(async () => ({
      success: false,
      output: retryOutput,
      status: "TEST_FAILURE" as const,
      countsTowardEscalation: true,
    }));

    const initialOutput = `
test/example.test.ts:
✗ test 1 [1ms]

(fail) test 1 [1ms]
Error: Test failed

1 passed, 1 failed [1ms]
    `.trim();

    await runRectificationLoop({
      config: makeConfig(),
      workdir: "/tmp/test",
      story: makeStory({ id: "TS-002" }),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: initialOutput,
    });

    // Verify warn was called with truncated failingTests and totalFailingTests
    const failingLog = capturedWarns.find((w) =>
      String(w.message).includes("still failing after attempt"),
    );
    expect(failingLog).toBeDefined();
    const logData = failingLog?.data as Record<string, unknown>;
    const failingTests = logData?.failingTests as string[];
    expect(Array.isArray(failingTests)).toBe(true);
    expect(failingTests).toHaveLength(10);
    expect(logData?.totalFailingTests).toBe(15);
  });

  test("logs failingTests: [] and totalFailingTests when no structured failures but failed > 0", async () => {
    const mockAgent = {
      name: "claude",
      run: mock(async (_opts: AgentRunOptions) => {
        return { success: false, exitCode: 1, output: "failed", rateLimited: false, durationMs: 10, estimatedCost: 0 };
      }),
      complete: mock(async (_prompt: string) => ""),
      isInstalled: mock(async () => true),
      buildCommand: mock((_opts: AgentRunOptions) => ["claude"]),
      buildAllowedEnv: mock((_opts?: AgentRunOptions) => ({})),
    };

    _rectificationDeps.agentManager = makeMockAgentManager({
      getAgentFn: () => mockAgent as unknown as import("../../../src/agents/types").AgentAdapter,
      runFn: mock(async () => ({ success: false, exitCode: 1, output: "failed", rateLimited: false, durationMs: 10, estimatedCost: 0, agentFallbacks: [] })),
      runAs: mock(async () => ({ success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 10, estimatedCost: 0, agentFallbacks: [] })),
    });

    // Retry output with failures but no structured (fail) blocks
    // Parser will count ✗ marks but won't parse detailed failure info
    const retryOutput = `
test/example.test.ts:
✓ passing test [0.5ms]
✗ failing test 1 [1.2ms]
✗ failing test 2 [1.3ms]

3 passed, 2 failed [1.7ms]
    `.trim();

    _rectificationDeps.runVerification = mock(async () => ({
      success: false,
      output: retryOutput,
      status: "TEST_FAILURE" as const,
      countsTowardEscalation: true,
    }));

    await runRectificationLoop({
      config: makeConfig(),
      workdir: "/tmp/test",
      story: makeStory({ id: "TS-003" }),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
    });

    // Verify failingTests is empty array and totalFailingTests is set
    const failingLog = capturedWarns.find((w) =>
      String(w.message).includes("still failing after attempt"),
    );
    expect(failingLog).toBeDefined();
    const logData = failingLog?.data as Record<string, unknown>;
    expect((logData?.failingTests as string[])).toEqual([]);
    expect(logData?.totalFailingTests).toBe(2);
  });

  test("does not include totalFailingTests when 10 or fewer failures", async () => {
    const mockAgent = {
      name: "claude",
      run: mock(async (_opts: AgentRunOptions) => {
        return { success: false, exitCode: 1, output: "failed", rateLimited: false, durationMs: 10, estimatedCost: 0 };
      }),
      complete: mock(async (_prompt: string) => ""),
      isInstalled: mock(async () => true),
      buildCommand: mock((_opts: AgentRunOptions) => ["claude"]),
      buildAllowedEnv: mock((_opts?: AgentRunOptions) => ({})),
    };

    _rectificationDeps.agentManager = makeMockAgentManager({
      getAgentFn: () => mockAgent as unknown as import("../../../src/agents/types").AgentAdapter,
      runFn: mock(async () => ({ success: false, exitCode: 1, output: "failed", rateLimited: false, durationMs: 10, estimatedCost: 0, agentFallbacks: [] })),
      runAs: mock(async () => ({ success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 10, estimatedCost: 0, agentFallbacks: [] })),
    });

    const retryOutput = `
test/example.test.ts:
✗ test 1 [1ms]

(fail) test 1 [1ms]
Error: Test failed

1 passed, 1 failed [1ms]
    `.trim();

    _rectificationDeps.runVerification = mock(async () => ({
      success: false,
      output: retryOutput,
      status: "TEST_FAILURE" as const,
      countsTowardEscalation: true,
    }));

    await runRectificationLoop({
      config: makeConfig(),
      workdir: "/tmp/test",
      story: makeStory({ id: "TS-004" }),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
    });

    // Verify totalFailingTests is not present when <= 10 failures
    const failingLog = capturedWarns.find((w) =>
      String(w.message).includes("still failing after attempt"),
    );
    expect(failingLog).toBeDefined();
    const logData = failingLog?.data as Record<string, unknown>;
    expect("totalFailingTests" in logData).toBe(false);
  });

  test("stops successfully when retry output parses to zero remaining failures", async () => {
    let agentRunCount = 0;
    const mockAgent = {
      name: "claude",
      run: mock(async (_opts: AgentRunOptions) => {
        agentRunCount += 1;
        return { success: false, exitCode: 1, output: "failed", rateLimited: false, durationMs: 10, estimatedCost: 0 };
      }),
      complete: mock(async (_prompt: string) => ""),
      isInstalled: mock(async () => true),
      buildCommand: mock((_opts: AgentRunOptions) => ["claude"]),
      buildAllowedEnv: mock((_opts?: AgentRunOptions) => ({})),
    };

    const runFn = mock(async () => {
      agentRunCount += 1;
      return { success: false, exitCode: 1, output: "failed", rateLimited: false, durationMs: 10, estimatedCost: 0, agentFallbacks: [] };
    });
    _rectificationDeps.agentManager = makeMockAgentManager({
      getAgentFn: () => mockAgent as unknown as import("../../../src/agents/types").AgentAdapter,
      runFn,
      runAs: runFn,
    });

    let verificationCalls = 0;
    _rectificationDeps.runVerification = mock(async () => {
      verificationCalls += 1;
      return {
        success: false,
        status: "TEST_FAILURE" as const,
        output: "test/example.test.ts:\n✓ fixed test [1ms]\n1 passed, 0 failed [1ms]",
        countsTowardEscalation: true,
      };
    });

    const result = await runRectificationLoop({
      config: makeConfig(),
      workdir: "/tmp/test",
      story: makeStory({ id: "TS-ZERO" }),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
    });

    expect(result.succeeded).toBe(true);
    expect(agentRunCount).toBe(1);
    expect(verificationCalls).toBe(1);
  });
});
