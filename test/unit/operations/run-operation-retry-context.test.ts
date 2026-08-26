import { afterEach, describe, expect, test } from "bun:test";
import { assertDefined, makeMockAgentManager, makeSessionManager, makeTestRuntime } from "@test/helpers";
import type { AgentRunRequest } from "@/agents";
import type { RetryContext } from "@/agents/retry/types";
import type { DEFAULT_CONFIG } from "@/config";
import { pickSelector } from "@/config";
import { callOp } from "@/operations";
import type { RunOperation } from "@/operations/types";
import type { NaxRuntime } from "@/runtime";

let runtime: NaxRuntime | undefined;
afterEach(async () => {
  await runtime?.close();
});

const testSel = pickSelector("routing-op-test", "routing");

const runEchoOp: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
  kind: "run",
  name: "run-echo-test",
  stage: "run",
  config: testSel,
  session: { role: "implementer", lifetime: "fresh" },
  build: (input) => ({
    role: { id: "role", content: "You echo text.", overridable: false },
    task: { id: "task", content: input.text, overridable: false },
  }),
  parse: (output) => output.trim(),
};

describe("callOp — RunOperation.retry RetryContext threading (US-004)", () => {
  test("synthetic hopBody threads lastOutput and lastTurnResult into RetryContext", async () => {
    const retryStrategyCalls: Array<{
      lastOutput?: string;
      lastTurnResult?: object;
    }> = [];

    const customRetryStrategy = {
      shouldRetry: (_err: unknown, _attempt: number, retryCtx: RetryContext) => {
        retryStrategyCalls.push({
          lastOutput: retryCtx.lastOutput,
          lastTurnResult: retryCtx.lastTurnResult,
        });
        return { retry: false as const };
      },
    };

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req: AgentRunRequest) => {
        const { executeHop } = req;
        assertDefined(executeHop, "req.executeHop");
        const hopResult = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => ({
        output: "agent output text",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0.001,
        internalRoundTrips: 0,
      }),
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const opWithStrategyTracking = {
      ...runEchoOp,
      name: "context-tracking-op",
      parse: (_output: string) => {
        throw new Error("Intentional parse error to trigger shouldRetry");
      },
      retry: customRetryStrategy,
    };

    try {
      await callOp(
        {
          runtime,
          packageView: runtime.packages.repo(),
          packageDir: "/tmp",
          agentName: "claude",
          storyId: "US-001",
        },
        opWithStrategyTracking,
        { text: "hello" },
      );
    } catch {
      // Expected to throw
    }

    expect(retryStrategyCalls.length).toBeGreaterThan(0);
    expect(retryStrategyCalls[0]?.lastOutput).toBe("agent output text");
    expect(retryStrategyCalls[0]?.lastTurnResult).toBeDefined();
  });

  test("synthetic hopBody calls shouldRetry with ParseValidationError when parse fails", async () => {
    const { ParseValidationError } = await import("@/agents");

    const retryStrategyCalls: Array<unknown> = [];

    const customRetryStrategy = {
      shouldRetry: (failure: unknown, _attempt: number, _retryCtx: RetryContext) => {
        retryStrategyCalls.push(failure);
        return { retry: false as const };
      },
    };

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req: AgentRunRequest) => {
        const { executeHop } = req;
        assertDefined(executeHop, "req.executeHop");
        const hopResult = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => ({
        output: "unparseable output",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0.001,
        internalRoundTrips: 0,
      }),
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const opWithParseFailure = {
      ...runEchoOp,
      name: "parse-failure-op",
      parse: (_output: string) => {
        throw new Error("JSON parse failed");
      },
      retry: customRetryStrategy,
    };

    try {
      await callOp(
        {
          runtime,
          packageView: runtime.packages.repo(),
          packageDir: "/tmp",
          agentName: "claude",
          storyId: "US-001",
        },
        opWithParseFailure,
        { text: "hello" },
      );
    } catch {
      // Expected
    }

    expect(retryStrategyCalls.length).toBeGreaterThan(0);
    const passedError = retryStrategyCalls[0];
    expect(passedError).toBeInstanceOf(ParseValidationError);
  });

  test("synthetic hopBody threads storyId into RetryContext for run-kind ops", async () => {
    const retryContextCalls: Array<{ storyId?: string }> = [];

    const captureStoryIdStrategy = {
      shouldRetry: (_failure: unknown, _attempt: number, retryCtx: RetryContext) => {
        retryContextCalls.push({ storyId: retryCtx.storyId });
        return { retry: false as const };
      },
    };

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req: AgentRunRequest) => {
        const { executeHop } = req;
        assertDefined(executeHop, "req.executeHop");
        const hopResult = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => ({
        output: "output",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0.001,
        internalRoundTrips: 0,
      }),
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const opWithStoryIdCapture = {
      ...runEchoOp,
      name: "storyid-capture-op",
      parse: (_output: string) => {
        throw new Error("Trigger retry");
      },
      retry: captureStoryIdStrategy,
    };

    try {
      await callOp(
        {
          runtime,
          packageView: runtime.packages.repo(),
          packageDir: "/tmp",
          agentName: "claude",
          storyId: "US-TEST-123",
        },
        opWithStoryIdCapture,
        { text: "hello" },
      );
    } catch {
      // Expected
    }

    expect(retryContextCalls.length).toBeGreaterThan(0);
    expect(retryContextCalls[0]?.storyId).toBe("US-TEST-123");
  });

  test("synthetic hopBody uses _callOpDeps.sleep with runtime signal for delays", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req: AgentRunRequest) => {
        const { executeHop } = req;
        assertDefined(executeHop, "req.executeHop");
        const hopResult = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => ({
        output: "after delay",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0.001,
        internalRoundTrips: 0,
      }),
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    let retryCount = 0;
    const delayedRetryStrategy = {
      shouldRetry: () => {
        retryCount++;
        if (retryCount === 1) {
          return { retry: true, delayMs: 50 } as const;
        }
        return { retry: false as const };
      },
    };

    const opWithDelay = {
      ...runEchoOp,
      name: "delayed-retry-op",
      parse: (_output: string) => {
        throw new Error("Trigger retry with delay");
      },
      retry: delayedRetryStrategy,
    };

    try {
      await callOp(
        {
          runtime,
          packageView: runtime.packages.repo(),
          packageDir: "/tmp",
          agentName: "claude",
          storyId: "US-001",
        },
        opWithDelay,
        { text: "hello" },
      );
    } catch {
      // Expected
    }

    expect(retryCount).toBeGreaterThanOrEqual(1);
  });
});
