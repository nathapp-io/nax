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
import type { NaxConfig } from "../../../src/config";
import type { UserStory } from "../../../src/prd";
import { _rectificationDeps, runRectificationLoop } from "../../../src/verification/rectification-loop";
import { getSafeLogger, initLogger, resetLogger } from "../../../src/logger";
import { makeMockAgentManager, makeMockRuntime, makeNaxConfig } from "../../helpers";

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
    routing: { modelTier: "balanced", complexity: "medium", testStrategy: "tdd-simple", reasoning: "test" },
    ...overrides,
  } as UserStory;
}

function makeConfig(overrides: Partial<NaxConfig> = {}): NaxConfig {
  return makeNaxConfig({
    autoMode: {
      defaultAgent: "claude",
      enabled: true,
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
      verificationTimeoutSeconds: 30,
      rectification: {
        maxRetries: 2,
        abortOnIncreasingFailures: false,
        escalateOnExhaustion: true,
      },
      permissionProfile: "cautious",
    },
    models: {
      claude: {
        fast: { provider: "anthropic", model: "claude-haiku-4-5" },
        balanced: { provider: "anthropic", model: "claude-sonnet-4-6" },
        powerful: { provider: "anthropic", model: "claude-opus-4-6" },
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
      shell: "bash",
      commands: { test: "bun test" },
    },
    ...overrides,
  });
}



function makeVerificationResult(success: boolean, output: string) {
  return {
    success,
    output,
    status: success ? ("SUCCESS" as const) : ("TEST_FAILURE" as const),
    countsTowardEscalation: true,
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
  const origAgentManager = _rectificationDeps.agentManager;
  const origRunVerification = _rectificationDeps.runVerification;
  const origEscalateTier = _rectificationDeps.escalateTier;

  let capturedInfos: Array<{ stage: string; message: string; data: unknown }> = [];
  let capturedWarns: Array<{ stage: string; message: string; data: unknown }> = [];

  beforeEach(() => {
    resetLogger();
    initLogger({ level: "silent" });
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
    _rectificationDeps.agentManager = origAgentManager;
    _rectificationDeps.runVerification = origRunVerification;
    _rectificationDeps.escalateTier = origEscalateTier;
    resetLogger();
    mock.restore();
  });

  test("fires escalation when escalateOnExhaustion=true, enabled=true, loop exhausted with failures", async () => {
    const runCalls: Array<{ type: "run" | "runAs" | "runAsSession"; opts: any }> = [];

    const mockAgentManager = makeMockAgentManager({
      getDefaultAgent: "claude",
    });
    const origRunAs = mockAgentManager.runAs.bind(mockAgentManager);
    const origRunAsSession = mockAgentManager.runAsSession.bind(mockAgentManager);

    mockAgentManager.runAsSession = mock(async (agentName: string, handle: any, prompt: string, opts: any) => {
      runCalls.push({ type: "runAsSession", opts });
      return origRunAsSession(agentName, handle, prompt, opts);
    });

    mockAgentManager.runAs = mock(async (agentName: string, req: any) => {
      runCalls.push({ type: "runAs", opts: req.runOptions });
      return origRunAs(agentName, req);
    });

    _rectificationDeps.agentManager = mockAgentManager as any;
    _rectificationDeps.runVerification = mock(async () =>
      makeVerificationResult(false, FAILING_TEST_OUTPUT),
    );

    const config = makeConfig();
    const runtime = makeMockRuntime();
    // maxRetries = 2, so loop runs 2 times, then escalation = 1 more = total 3
    await runRectificationLoop({
      config,
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
      agentManager: mockAgentManager,
      runtime,
    });

    // Should have invoked runAsSession/runAs maxRetries + 1 = 3 times
    expect(runCalls.length).toBe(3);
  });

  test("escalated agent.run receives modelTier: 'powerful' when current tier is 'balanced'", async () => {
    const runCalls: Array<{ type: "run" | "runAs" | "runAsSession"; opts: any }> = [];

    const mockAgentManager = makeMockAgentManager({
      getDefaultAgent: "claude",
    });
    const origRunAs = mockAgentManager.runAs.bind(mockAgentManager);
    const origRunAsSession = mockAgentManager.runAsSession.bind(mockAgentManager);

    mockAgentManager.runAsSession = mock(async (agentName: string, handle: any, prompt: string, opts: any) => {
      runCalls.push({ type: "runAsSession", opts });
      return origRunAsSession(agentName, handle, prompt, opts);
    });

    mockAgentManager.runAs = mock(async (agentName: string, req: any) => {
      runCalls.push({ type: "runAs", opts: req.runOptions });
      return origRunAs(agentName, req);
    });

    _rectificationDeps.agentManager = mockAgentManager as any;
    _rectificationDeps.runVerification = mock(async () =>
      makeVerificationResult(false, FAILING_TEST_OUTPUT),
    );

    const config = makeConfig();
    const runtime = makeMockRuntime();

    // story.routing.complexity = "medium" → modelTier = "balanced"
    await runRectificationLoop({
      config,
      workdir: "/tmp/test",
      story: makeStory({ routing: { modelTier: "balanced", complexity: "medium", testStrategy: "tdd-simple", reasoning: "test" } }),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
      agentManager: mockAgentManager,
      runtime,
    });

    // The last call (escalation attempt via runAs) should use 'powerful'
    expect(runCalls.length).toBeGreaterThan(0);
    const escalationCall = runCalls[runCalls.length - 1];
    expect(escalationCall.opts.modelTier).toBe("powerful");
  });

  test("no escalation and returns false when current tier is last in tierOrder", async () => {
    const runCalls: Array<{ type: "runAsSession"; opts: any }> = [];

    const mockAgentManager = makeMockAgentManager({
      getDefaultAgent: "claude",
    });
    const origRunAsSession = mockAgentManager.runAsSession.bind(mockAgentManager);

    mockAgentManager.runAsSession = mock(async (agentName: string, handle: any, prompt: string, opts: any) => {
      runCalls.push({ type: "runAsSession", opts });
      return origRunAsSession(agentName, handle, prompt, opts);
    });

    _rectificationDeps.agentManager = mockAgentManager as any;
    _rectificationDeps.runVerification = mock(async () =>
      makeVerificationResult(false, FAILING_TEST_OUTPUT),
    );

    // Stub escalateTier to return null (already at last tier)
    _rectificationDeps.escalateTier = mock(() => null);

    const runtime = makeMockRuntime();

    const result = await runRectificationLoop({
      config: makeConfig(),
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
      agentManager: mockAgentManager,
      runtime,
    });

    // Only maxRetries calls, no escalation
    expect(runCalls.length).toBe(2); // maxRetries = 2
    expect(result.succeeded).toBe(false);
  });

  test("returns true and logs info with both tier names when escalated verification succeeds", async () => {
    const mockAgentManager = makeMockAgentManager({
      getDefaultAgent: "claude",
    });

    _rectificationDeps.agentManager = mockAgentManager as any;

    // Normal retries fail, escalated attempt's verification succeeds
    let verificationCallCount = 0;
    _rectificationDeps.runVerification = mock(async () => {
      verificationCallCount++;
      // First maxRetries verifications fail, escalation verification succeeds
      const maxRetries = 2;
      if (verificationCallCount <= maxRetries) {
        return makeVerificationResult(false, FAILING_TEST_OUTPUT);
      }
      return makeVerificationResult(true, PASSING_TEST_OUTPUT);
    });

    const runtime = makeMockRuntime();

    const result = await runRectificationLoop({
      config: makeConfig(),
      workdir: "/tmp/test",
      story: makeStory({ routing: { modelTier: "balanced", complexity: "medium", testStrategy: "tdd-simple", reasoning: "test" } }),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
      agentManager: mockAgentManager,
      runtime,
    });

    expect(result.succeeded).toBe(true);

    // Should log info message containing both tier names
    const escalationSuccessLog = capturedInfos.find(
      (i) => String(i.message).includes("balanced") && String(i.message).includes("powerful"),
    );
    expect(escalationSuccessLog).toBeDefined();
  });

  test("returns false and logs warn with 'escalated rectification also failed' when escalated verification fails", async () => {
    const mockAgentManager = makeMockAgentManager({
      getDefaultAgent: "claude",
    });

    _rectificationDeps.agentManager = mockAgentManager as any;

    // All verifications fail (including escalated attempt)
    _rectificationDeps.runVerification = mock(async () =>
      makeVerificationResult(false, FAILING_TEST_OUTPUT),
    );

    const runtime = makeMockRuntime();

    const result = await runRectificationLoop({
      config: makeConfig(),
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
      agentManager: mockAgentManager,
      runtime,
    });

    expect(result.succeeded).toBe(false);

    const warnLog = capturedWarns.find((w) =>
      String(w.message).includes("escalated rectification also failed"),
    );
    expect(warnLog).toBeDefined();
  });

  test("no escalation when escalateOnExhaustion=false, returns false", async () => {
    const runCalls: Array<{ type: "runAsSession"; opts: any }> = [];

    const mockAgentManager = makeMockAgentManager({
      getDefaultAgent: "claude",
    });
    const origRunAsSession = mockAgentManager.runAsSession.bind(mockAgentManager);

    mockAgentManager.runAsSession = mock(async (agentName: string, handle: any, prompt: string, opts: any) => {
      runCalls.push({ type: "runAsSession", opts });
      return origRunAsSession(agentName, handle, prompt, opts);
    });

    _rectificationDeps.agentManager = mockAgentManager as any;
    _rectificationDeps.runVerification = mock(async () =>
      makeVerificationResult(false, FAILING_TEST_OUTPUT),
    );

    const config = makeConfig({
      execution: {
        sessionTimeoutSeconds: 120,
        verificationTimeoutSeconds: 30,
        rectification: {
          maxRetries: 2,
          abortOnIncreasingFailures: false,
          escalateOnExhaustion: false,
        },
        permissionProfile: "cautious",
      },
    } as any);

    const runtime = makeMockRuntime();

    const result = await runRectificationLoop({
      config,
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
      agentManager: mockAgentManager,
      runtime,
    });

    // Only maxRetries calls, no escalation
    expect(runCalls.length).toBe(2);
    expect(result.succeeded).toBe(false);
  });

  test("no escalation when abortOnIncreasingFailures exits early (attempt < maxRetries)", async () => {
    const runCalls: Array<{ type: "runAsSession"; opts: any }> = [];

    const mockAgentManager = makeMockAgentManager({
      getDefaultAgent: "claude",
    });
    const origRunAsSession = mockAgentManager.runAsSession.bind(mockAgentManager);

    mockAgentManager.runAsSession = mock(async (agentName: string, handle: any, prompt: string, opts: any) => {
      runCalls.push({ type: "runAsSession", opts });
      return origRunAsSession(agentName, handle, prompt, opts);
    });

    _rectificationDeps.agentManager = mockAgentManager as any;

    // The pre-check (first runVerification call) establishes the full-suite baseline.
    // Subsequent calls (post-attempt verify) return 5 failures to trigger abort.
    // Initial testOutput has 1 failure; pre-check confirms 1; post-attempt shows 5 → regression.
    const worseOutput =
      "✗ test1 [1ms]\n(fail) test1 [1ms]\nerror: err\n" +
      "✗ test2 [1ms]\n(fail) test2 [1ms]\nerror: err\n" +
      "✗ test3 [1ms]\n(fail) test3 [1ms]\nerror: err\n" +
      "✗ test4 [1ms]\n(fail) test4 [1ms]\nerror: err\n" +
      "✗ test5 [1ms]\n(fail) test5 [1ms]\nerror: err\n" +
      "5 passed, 5 failed [5ms]";

    let verifyCallCount = 0;
    _rectificationDeps.runVerification = mock(async () => {
      // First call is the pre-check: return the same 1-failure baseline as testOutput.
      // Subsequent calls are post-attempt verifies: return 5 failures (regression).
      verifyCallCount++;
      if (verifyCallCount === 1) return makeVerificationResult(false, FAILING_TEST_OUTPUT);
      return makeVerificationResult(false, worseOutput);
    });

    const config = makeConfig({
      execution: {
        sessionTimeoutSeconds: 120,
        verificationTimeoutSeconds: 30,
        rectification: {
          maxRetries: 3, // set higher so early abort is at attempt 1 < 3
          abortOnIncreasingFailures: true,
          escalateOnExhaustion: true,
        },
        permissionProfile: "cautious",
      },
    } as any);

    const runtime = makeMockRuntime();

    const result = await runRectificationLoop({
      config,
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT, // 1 failure
      agentManager: mockAgentManager,
      runtime,
    });

    // Should abort after 1 attempt (not maxRetries=3), so no escalation
    expect(runCalls.length).toBe(1);
    expect(result.succeeded).toBe(false);
  });

  test("total agent.run invocations equals maxRetries + 1 when escalation fires", async () => {
    const runCalls: Array<{ type: "runAsSession" | "runAs"; opts: any }> = [];

    const mockAgentManager = makeMockAgentManager({
      getDefaultAgent: "claude",
    });
    const origRunAs = mockAgentManager.runAs.bind(mockAgentManager);
    const origRunAsSession = mockAgentManager.runAsSession.bind(mockAgentManager);

    mockAgentManager.runAsSession = mock(async (agentName: string, handle: any, prompt: string, opts: any) => {
      runCalls.push({ type: "runAsSession", opts });
      return origRunAsSession(agentName, handle, prompt, opts);
    });

    mockAgentManager.runAs = mock(async (agentName: string, req: any) => {
      runCalls.push({ type: "runAs", opts: req.runOptions });
      return origRunAs(agentName, req);
    });

    _rectificationDeps.agentManager = mockAgentManager as any;
    _rectificationDeps.runVerification = mock(async () =>
      makeVerificationResult(false, FAILING_TEST_OUTPUT),
    );

    const maxRetries = 3;
    const config = makeConfig({
      execution: {
        sessionTimeoutSeconds: 120,
        verificationTimeoutSeconds: 30,
        rectification: {
          maxRetries,
          abortOnIncreasingFailures: false,
          escalateOnExhaustion: true,
        },
        permissionProfile: "cautious",
      },
    } as any);

    const runtime = makeMockRuntime();

    await runRectificationLoop({
      config,
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
      agentManager: mockAgentManager,
      runtime,
    });

    expect(runCalls.length).toBe(maxRetries + 1);
  });
});
