import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../src/config";
import type { UserStory } from "../../../src/prd";
import { SessionTurnError } from "../../../src/agents/types";
import type { SessionHandle } from "../../../src/agents/types";
import { _rectificationDeps, runRectificationLoop } from "../../../src/verification/rectification-loop";
import { getSafeLogger, initLogger, resetLogger } from "../../../src/logger";
import { makeMockAgentManager, makeNaxConfig, makeSessionManager, makeTestRuntime } from "../../helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

const FAILING_TEST_OUTPUT =
  "✗ my test [1ms]\n(fail) my test [1ms]\nerror: Expected 1 to be 2";

function makeStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "TS-001",
    title: "Test story",
    description: "Test description",
    acceptanceCriteria: ["Test passes"],
    status: "pending",
    routing: { modelTier: "balanced" },
    ...overrides,
  } as UserStory;
}

function makeConfig(overrides: Partial<NaxConfig> = {}): NaxConfig {
  return makeNaxConfig({
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
        maxRetries: 3,
        abortOnRegression: true,
        escalateOnExhaustion: false,
      },
      sessionErrorRetryableMaxRetries: 3,
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
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-1: bindHandle errors are caught and don't propagate
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-1: When bindHandle throws, error is caught and loop continues", () => {
  const origAgentManager = _rectificationDeps.agentManager;
  const origRunVerification = _rectificationDeps.runVerification;

  beforeEach(() => {
    initLogger({ level: "error" });
  });

  afterEach(async () => {
    _rectificationDeps.agentManager = origAgentManager;
    _rectificationDeps.runVerification = origRunVerification;
    resetLogger();
  });

  test("bindHandle exception is caught; rectification returns final result", async () => {
    const story = makeStory({ id: "AC-1-test" });
    const config = makeConfig();
    const runtime = await makeTestRuntime();

    const bindHandleError = new Error("Session binding failed");
    const sessionManager = makeSessionManager({
      bindHandle: mock(() => {
        throw bindHandleError;
      }),
      openSession: mock(async () => ({
        id: "session-1",
        agentName: "claude",
        protocolIds: { runSessionId: "proto-123" },
      } as SessionHandle)),
      closeSession: mock(async () => {}),
    });

    const agentManager = makeMockAgentManager({
      runAsSession: mock(async () => ({
        output: "Fixed the issue",
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        estimatedCostUsd: 0.01,
        internalRoundTrips: 1,
      })),
      getDefault: () => "claude",
    });

    _rectificationDeps.agentManager = agentManager;
    _rectificationDeps.runVerification = mock(async () => ({
      success: true,
      status: "SUCCESS" as const,
      output: "",
      durationMs: 1000,
    }));

    // Override runtime's sessionManager with our mock
    const originalSessionManager = runtime.sessionManager;
    (runtime as any).sessionManager = sessionManager;

    try {
      const result = await runRectificationLoop({
        config,
        workdir: "/tmp/test",
        story,
        testCommand: "bun test",
        timeoutSeconds: 60,
        testOutput: FAILING_TEST_OUTPUT,
        agentManager,
        runtime,
        sessionId: "nax-session-123",
      });

      // Despite bindHandle throwing, the function should return a result
      expect(result).toBeDefined();
      expect(result.succeeded).toBe(true);

      // Verify bindHandle was called (and threw)
      expect(sessionManager.bindHandle).toHaveBeenCalled();
    } finally {
      (runtime as any).sessionManager = originalSessionManager;
      await runtime.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-2: SessionTurnError with retryable:true triggers session retry
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-2: SessionTurnError retryable:true triggers fresh session and retry", () => {
  const origAgentManager = _rectificationDeps.agentManager;
  const origRunVerification = _rectificationDeps.runVerification;

  beforeEach(() => {
    initLogger({ level: "error" });
  });

  afterEach(async () => {
    _rectificationDeps.agentManager = origAgentManager;
    _rectificationDeps.runVerification = origRunVerification;
    resetLogger();
  });

  test("retryable SessionTurnError closes stale handle, opens fresh session, retries", async () => {
    const story = makeStory({ id: "AC-2-test" });
    const config = makeConfig();
    const runtime = await makeTestRuntime();

    let runAsSessionCallCount = 0;
    let staleSessionClosed = false;

    const sessionManager = makeSessionManager({
      openSession: mock(async () => ({
        id: `session-${Date.now()}`,
        agentName: "claude",
      } as SessionHandle)),
      closeSession: mock(async (handle: SessionHandle) => {
        staleSessionClosed = true;
      }),
      bindHandle: mock(() => {}),
    });

    const agentManager = makeMockAgentManager({
      runAsSession: mock(async (agent: string, handle: SessionHandle, prompt: string) => {
        runAsSessionCallCount++;

        // First call: throw retryable error
        if (runAsSessionCallCount === 1) {
          throw new SessionTurnError({
            code: "QUEUE_DISCONNECTED_BEFORE_COMPLETION",
            message: "Session disconnected",
            retryable: true,
          });
        }

        // Second call: succeed
        return {
          output: "Fixed on retry",
          tokenUsage: { inputTokens: 100, outputTokens: 50 },
          estimatedCostUsd: 0.01,
          internalRoundTrips: 1,
        };
      }),
      getDefault: () => "claude",
    });

    _rectificationDeps.agentManager = agentManager;
    _rectificationDeps.runVerification = mock(async () => ({
      success: true,
      status: "SUCCESS" as const,
      output: "",
      durationMs: 1000,
    }));

    const originalSessionManager = runtime.sessionManager;
    (runtime as any).sessionManager = sessionManager;

    try {
      const result = await runRectificationLoop({
        config,
        workdir: "/tmp/test",
        story,
        testCommand: "bun test",
        timeoutSeconds: 60,
        testOutput: FAILING_TEST_OUTPUT,
        agentManager,
        runtime,
      });

      // Rectification should succeed after retry
      expect(result.succeeded).toBe(true);

      // Verify runAsSession was called twice (initial + retry)
      expect(runAsSessionCallCount).toBe(2);

      // Verify stale session was closed
      expect(staleSessionClosed).toBe(true);

      // Verify sessionManager.closeSession was called
      expect(sessionManager.closeSession).toHaveBeenCalled();
    } finally {
      (runtime as any).sessionManager = originalSessionManager;
      await runtime.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-3: No bindHandle call when sessionId is undefined
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-3: bindHandle not called when sessionId is undefined", () => {
  const origAgentManager = _rectificationDeps.agentManager;
  const origRunVerification = _rectificationDeps.runVerification;

  beforeEach(() => {
    initLogger({ level: "error" });
  });

  afterEach(async () => {
    _rectificationDeps.agentManager = origAgentManager;
    _rectificationDeps.runVerification = origRunVerification;
    resetLogger();
  });

  test("bindHandle never called when sessionId is not provided", async () => {
    const story = makeStory({ id: "AC-3-test" });
    const config = makeConfig();
    const runtime = await makeTestRuntime();

    const bindHandleMock = mock(() => {});

    const sessionManager = makeSessionManager({
      bindHandle: bindHandleMock,
      openSession: mock(async () => ({
        id: "session-1",
        agentName: "claude",
        protocolIds: { runSessionId: "proto-456" },
      } as SessionHandle)),
      closeSession: mock(async () => {}),
    });

    const agentManager = makeMockAgentManager({
      runAsSession: mock(async () => ({
        output: "Fixed without session tracking",
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        estimatedCostUsd: 0.01,
        internalRoundTrips: 1,
      })),
      getDefault: () => "claude",
    });

    _rectificationDeps.agentManager = agentManager;
    _rectificationDeps.runVerification = mock(async () => ({
      success: true,
      status: "SUCCESS" as const,
      output: "",
      durationMs: 1000,
    }));

    const originalSessionManager = runtime.sessionManager;
    (runtime as any).sessionManager = sessionManager;

    try {
      const result = await runRectificationLoop({
        config,
        workdir: "/tmp/test",
        story,
        testCommand: "bun test",
        timeoutSeconds: 60,
        testOutput: FAILING_TEST_OUTPUT,
        agentManager,
        runtime,
        // NOTE: sessionId is NOT provided
      });

      expect(result.succeeded).toBe(true);

      // Verify bindHandle was never called (because sessionId was undefined)
      expect(bindHandleMock).not.toHaveBeenCalled();
    } finally {
      (runtime as any).sessionManager = originalSessionManager;
      await runtime.close();
    }
  });

  test("bindHandle called when sessionId is provided and protocolIds present", async () => {
    const story = makeStory({ id: "AC-3-test-2" });
    const config = makeConfig();
    const runtime = await makeTestRuntime();

    const bindHandleMock = mock(() => {});

    const sessionManager = makeSessionManager({
      bindHandle: bindHandleMock,
      openSession: mock(async () => ({
        id: "session-1",
        agentName: "claude",
        protocolIds: { runSessionId: "proto-456" },
      } as SessionHandle)),
      closeSession: mock(async () => {}),
    });

    const agentManager = makeMockAgentManager({
      runAsSession: mock(async () => ({
        output: "Fixed with session tracking",
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        estimatedCostUsd: 0.01,
        internalRoundTrips: 1,
      })),
      getDefault: () => "claude",
    });

    _rectificationDeps.agentManager = agentManager;
    _rectificationDeps.runVerification = mock(async () => ({
      success: true,
      status: "SUCCESS" as const,
      output: "",
      durationMs: 1000,
    }));

    const originalSessionManager = runtime.sessionManager;
    (runtime as any).sessionManager = sessionManager;

    try {
      const result = await runRectificationLoop({
        config,
        workdir: "/tmp/test",
        story,
        testCommand: "bun test",
        timeoutSeconds: 60,
        testOutput: FAILING_TEST_OUTPUT,
        agentManager,
        runtime,
        sessionId: "nax-session-456", // NOW provided
      });

      expect(result.succeeded).toBe(true);

      // Verify bindHandle WAS called (because sessionId was provided)
      expect(bindHandleMock).toHaveBeenCalled();
    } finally {
      (runtime as any).sessionManager = originalSessionManager;
      await runtime.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-4: Session closure and retry on retryable error
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-4: Retryable SessionTurnError triggers closeSession and fresh session", () => {
  const origAgentManager = _rectificationDeps.agentManager;
  const origRunVerification = _rectificationDeps.runVerification;

  beforeEach(() => {
    initLogger({ level: "error" });
  });

  afterEach(async () => {
    _rectificationDeps.agentManager = origAgentManager;
    _rectificationDeps.runVerification = origRunVerification;
    resetLogger();
  });

  test("closeSession called on retryable error; fresh session opened for retry", async () => {
    const story = makeStory({ id: "AC-4-test" });
    const config = makeConfig();
    const runtime = await makeTestRuntime();

    const closeSessionMock = mock(async () => {});
    const openSessionMock = mock(async () => ({
      id: `session-${Math.random()}`,
      agentName: "claude",
    } as SessionHandle));

    let runAsSessionCount = 0;

    const sessionManager = makeSessionManager({
      openSession: openSessionMock,
      closeSession: closeSessionMock,
      bindHandle: mock(() => {}),
    });

    const agentManager = makeMockAgentManager({
      runAsSession: mock(async (agent: string, handle: SessionHandle, prompt: string) => {
        runAsSessionCount++;

        // First attempt: throw retryable error
        if (runAsSessionCount === 1) {
          throw new SessionTurnError({
            code: "QUEUE_DISCONNECTED_BEFORE_COMPLETION",
            message: "Transport error",
            retryable: true,
          });
        }

        // Subsequent attempts: succeed
        return {
          output: "Successfully fixed after retry",
          tokenUsage: { inputTokens: 100, outputTokens: 50 },
          estimatedCostUsd: 0.01,
          internalRoundTrips: 1,
        };
      }),
      getDefault: () => "claude",
    });

    _rectificationDeps.agentManager = agentManager;
    _rectificationDeps.runVerification = mock(async () => ({
      success: true,
      status: "SUCCESS" as const,
      output: "",
      durationMs: 1000,
    }));

    const originalSessionManager = runtime.sessionManager;
    (runtime as any).sessionManager = sessionManager;

    try {
      const result = await runRectificationLoop({
        config,
        workdir: "/tmp/test",
        story,
        testCommand: "bun test",
        timeoutSeconds: 60,
        testOutput: FAILING_TEST_OUTPUT,
        agentManager,
        runtime,
        sessionId: "nax-session-789",
      });

      expect(result.succeeded).toBe(true);

      // Verify closeSession was called for the stale handle
      expect(closeSessionMock).toHaveBeenCalled();

      // Verify openSession was called again to get a fresh handle
      // (initial open + reopen after error)
      expect(openSessionMock.mock.callCount).toBeGreaterThanOrEqual(2);

      // Verify runAsSession was called twice (initial + retry)
      expect(runAsSessionCount).toBe(2);
    } finally {
      (runtime as any).sessionManager = originalSessionManager;
      await runtime.close();
    }
  });

  test("finally block calls closeSession for held handle at loop exit", async () => {
    const story = makeStory({ id: "AC-4-test-finally" });
    const config = makeConfig();
    const runtime = await makeTestRuntime();

    const closeSessionMock = mock(async () => {});

    const sessionManager = makeSessionManager({
      openSession: mock(async () => ({
        id: "final-session",
        agentName: "claude",
      } as SessionHandle)),
      closeSession: closeSessionMock,
      bindHandle: mock(() => {}),
    });

    const agentManager = makeMockAgentManager({
      runAsSession: mock(async () => ({
        output: "Rectified successfully",
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        estimatedCostUsd: 0.01,
        internalRoundTrips: 1,
      })),
      getDefault: () => "claude",
    });

    _rectificationDeps.agentManager = agentManager;
    _rectificationDeps.runVerification = mock(async () => ({
      success: true,
      status: "SUCCESS" as const,
      output: "",
      durationMs: 1000,
    }));

    const originalSessionManager = runtime.sessionManager;
    (runtime as any).sessionManager = sessionManager;

    try {
      const result = await runRectificationLoop({
        config,
        workdir: "/tmp/test",
        story,
        testCommand: "bun test",
        timeoutSeconds: 60,
        testOutput: FAILING_TEST_OUTPUT,
        agentManager,
        runtime,
      });

      expect(result.succeeded).toBe(true);

      // Verify that the held session was closed in the finally block
      expect(closeSessionMock).toHaveBeenCalled();
    } finally {
      (runtime as any).sessionManager = originalSessionManager;
      await runtime.close();
    }
  });
});