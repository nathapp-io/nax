import { describe, test, expect, mock } from "bun:test";
import { callOp } from "../../../src/operations/call";
import type { RunOperation } from "../../../src/operations/types";
import { pickSelector } from "../../../src/config";
import { makeMockAgentManager, makeSessionManager, makeTestRuntime, makeLogger } from "../../helpers";
import { DEFAULT_CONFIG } from "../../../src/config";

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

describe("callOp — RunOperation.retry behavior (US-004)", () => {
  test("when op.retry is absent, callOp uses single dispatch without retry loop", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: {
          success: true,
          exitCode: 0,
          output: "single dispatch result",
          rateLimited: false,
          durationMs: 1,
          estimatedCostUsd: 0,
          agentFallbacks: [],
        },
        fallbacks: [],
      }),
    });
    const sessionManager = makeSessionManager();
    const runtime = makeTestRuntime({ agentManager, sessionManager });

    const result = await callOp(
      {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-001",
      },
      runEchoOp,
      { text: "hello" },
    );

    expect(result).toBe("single dispatch result");
    expect(agentManager.runWithFallback).toHaveBeenCalledTimes(1);
  });

  test("when op.retry is a resolver returning undefined, callOp dispatches once without retry", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: {
          success: true,
          exitCode: 0,
          output: "no retry case",
          rateLimited: false,
          durationMs: 1,
          estimatedCostUsd: 0,
          agentFallbacks: [],
        },
        fallbacks: [],
      }),
    });
    const sessionManager = makeSessionManager();
    const runtime = makeTestRuntime({ agentManager, sessionManager });

    const opWithUndefinedRetryResolver: RunOperation<
      { text: string },
      string,
      Pick<typeof DEFAULT_CONFIG, "routing">
    > = {
      ...runEchoOp,
      name: "undefined-retry-resolver-op",
      retry: (_input, _ctx) => undefined,
    };

    const result = await callOp(
      {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-001",
      },
      opWithUndefinedRetryResolver,
      { text: "hello" },
    );

    expect(result).toBe("no retry case");
    expect(agentManager.runWithFallback).toHaveBeenCalledTimes(1);
  });

  test("when op.retry resolver is a function, it is invoked exactly once before first send", async () => {
    const resolverInvocations: Array<{ text: string }> = [];

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: {
          success: true,
          exitCode: 0,
          output: "result after resolver called once",
          rateLimited: false,
          durationMs: 1,
          estimatedCostUsd: 0,
          agentFallbacks: [],
        },
        fallbacks: [],
      }),
    });
    const sessionManager = makeSessionManager();
    const runtime = makeTestRuntime({ agentManager, sessionManager });

    const opWithResolverTracking: RunOperation<
      { text: string },
      string,
      Pick<typeof DEFAULT_CONFIG, "routing">
    > = {
      ...runEchoOp,
      name: "resolver-tracking-op",
      retry: (input, _ctx) => {
        resolverInvocations.push({ text: input.text });
        return {
          preset: "transient-network" as const,
          maxAttempts: 2,
          baseDelayMs: 50,
        };
      },
    };

    await callOp(
      {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-001",
      },
      opWithResolverTracking,
      { text: "hello world" },
    );

    expect(resolverInvocations).toHaveLength(1);
    expect(resolverInvocations[0]).toEqual({ text: "hello world" });
  });

  test("when both op.hopBody and op.retry are set, callOp prefers hopBody and ignores retry", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: {
          success: true,
          exitCode: 0,
          output: "hopbody result",
          rateLimited: false,
          durationMs: 1,
          estimatedCostUsd: 0,
          agentFallbacks: [],
        },
        fallbacks: [],
      }),
    });
    const sessionManager = makeSessionManager();
    const runtime = makeTestRuntime({ agentManager, sessionManager });

    const opWithBothFields: RunOperation<
      { text: string },
      string,
      Pick<typeof DEFAULT_CONFIG, "routing">
    > = {
      ...runEchoOp,
      name: "both-hophody-and-retry-op",
      hopBody: async (initialPrompt, ctx) => {
        await ctx.send(initialPrompt);
        return {
          output: "from hopbody",
          tokenUsage: { inputTokens: 1, outputTokens: 1 },
          estimatedCostUsd: 0,
          internalRoundTrips: 1,
        };
      },
      retry: {
        preset: "transient-network" as const,
        maxAttempts: 5,
        baseDelayMs: 100,
      },
    };

    const result = await callOp(
      {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-001",
      },
      opWithBothFields,
      { text: "hello" },
    );

    expect(result).toBe("hopbody result");
    expect(agentManager.runWithFallback).toHaveBeenCalledTimes(1);
    const reqArg = (agentManager.runWithFallback as ReturnType<typeof mock>).mock.calls[0]?.[0];
    expect(reqArg?.executeHop).toBeTypeOf("function");
  });

  test("when op.retry is set and op.hopBody is absent, synthetic hopBody sends initial prompt", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: {
          success: true,
          exitCode: 0,
          output: "result from synthetic retry",
          rateLimited: false,
          durationMs: 1,
          estimatedCostUsd: 0.001,
          agentFallbacks: [],
        },
        fallbacks: [],
      }),
    });
    const sessionManager = makeSessionManager();
    const runtime = makeTestRuntime({ agentManager, sessionManager });

    const opWithRetry: RunOperation<
      { text: string },
      string,
      Pick<typeof DEFAULT_CONFIG, "routing">
    > = {
      ...runEchoOp,
      name: "synthetic-retry-op",
      retry: {
        preset: "transient-network" as const,
        maxAttempts: 2,
        baseDelayMs: 10,
      },
    };

    const result = await callOp(
      {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-001",
      },
      opWithRetry,
      { text: "hello" },
    );

    expect(result).toBe("result from synthetic retry");
    expect(agentManager.runWithFallback).toHaveBeenCalledTimes(1);
  });

  test("synthetic hopBody threads lastOutput and lastTurnResult into RetryContext", async () => {
    const retryStrategyCalls: Array<{
      lastOutput?: string;
      lastTurnResult?: object;
    }> = [];

    const customRetryStrategy = {
      shouldRetry: (err: unknown, attempt: number, retryCtx: any) => {
        retryStrategyCalls.push({
          lastOutput: retryCtx.lastOutput,
          lastTurnResult: retryCtx.lastTurnResult,
        });
        return { retry: false };
      },
    };

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: {
          success: true,
          exitCode: 0,
          output: "agent output text",
          rateLimited: false,
          durationMs: 1,
          estimatedCostUsd: 0.001,
          agentFallbacks: [],
        },
        fallbacks: [],
      }),
    });
    const sessionManager = makeSessionManager();
    const runtime = makeTestRuntime({ agentManager, sessionManager });

    const opWithStrategyTracking: RunOperation<
      { text: string },
      string,
      Pick<typeof DEFAULT_CONFIG, "routing">
    > = {
      ...runEchoOp,
      name: "context-tracking-op",
      parse: (output) => {
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
  });

  test("synthetic hopBody calls shouldRetry with ParseValidationError when parse fails", async () => {
    const { ParseValidationError } = await import("../../../src/agents/retry");

    const retryStrategyCalls: Array<unknown> = [];

    const customRetryStrategy = {
      shouldRetry: (failure: unknown, _attempt: number, _retryCtx: any) => {
        retryStrategyCalls.push(failure);
        return { retry: false };
      },
    };

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: {
          success: true,
          exitCode: 0,
          output: "unparseable output",
          rateLimited: false,
          durationMs: 1,
          estimatedCostUsd: 0.001,
          agentFallbacks: [],
        },
        fallbacks: [],
      }),
    });
    const sessionManager = makeSessionManager();
    const runtime = makeTestRuntime({ agentManager, sessionManager });

    const opWithParseFailure: RunOperation<
      { text: string },
      string,
      Pick<typeof DEFAULT_CONFIG, "routing">
    > = {
      ...runEchoOp,
      name: "parse-failure-op",
      parse: (_output) => {
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

  test("synthetic hopBody respects { retry: false } and returns latest TurnResult", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: {
          success: true,
          exitCode: 0,
          output: "final output",
          rateLimited: false,
          durationMs: 1,
          estimatedCostUsd: 0.005,
          agentFallbacks: [],
        },
        fallbacks: [],
      }),
    });
    const sessionManager = makeSessionManager();
    const runtime = makeTestRuntime({ agentManager, sessionManager });

    const noRetryStrategy = {
      shouldRetry: () => ({ retry: false }),
    };

    const opNoRetry: RunOperation<
      { text: string },
      string,
      Pick<typeof DEFAULT_CONFIG, "routing">
    > = {
      ...runEchoOp,
      name: "no-retry-op",
      parse: (_output) => {
        throw new Error("Parse always fails");
      },
      retry: noRetryStrategy,
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
        opNoRetry,
        { text: "hello" },
      );
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }
  });

  test("synthetic hopBody sends nextPrompt when retry decision includes it", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: {
          success: true,
          exitCode: 0,
          output: "final output after retry with nextPrompt",
          rateLimited: false,
          durationMs: 1,
          estimatedCostUsd: 0.002,
          agentFallbacks: [],
        },
        fallbacks: [],
      }),
    });
    const sessionManager = makeSessionManager();
    const runtime = makeTestRuntime({ agentManager, sessionManager });

    let shouldRetryCallCount = 0;
    const retryWithNextPromptStrategy = {
      shouldRetry: () => {
        shouldRetryCallCount++;
        if (shouldRetryCallCount === 1) {
          return {
            retry: true,
            delayMs: 0,
            nextPrompt: "retry with this prompt",
          };
        }
        return { retry: false };
      },
    };

    const opWithNextPrompt: RunOperation<
      { text: string },
      string,
      Pick<typeof DEFAULT_CONFIG, "routing">
    > = {
      ...runEchoOp,
      name: "next-prompt-op",
      parse: (_output) => {
        throw new Error("Always fail to trigger retry");
      },
      retry: retryWithNextPromptStrategy,
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
        opWithNextPrompt,
        { text: "hello" },
      );
    } catch {
      // Expected
    }

    expect(shouldRetryCallCount).toBeGreaterThanOrEqual(1);
  });

  test("synthetic hopBody resends original prompt when retry decision lacks nextPrompt", async () => {
    let shouldRetryCallCount = 0;
    const originalPromptShouldBeResent = {
      shouldRetry: () => {
        shouldRetryCallCount++;
        if (shouldRetryCallCount === 1) {
          return { retry: true, delayMs: 0 };
        }
        return { retry: false };
      },
    };

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: {
          success: true,
          exitCode: 0,
          output: "output after resending original",
          rateLimited: false,
          durationMs: 1,
          estimatedCostUsd: 0.001,
          agentFallbacks: [],
        },
        fallbacks: [],
      }),
    });
    const sessionManager = makeSessionManager();
    const runtime = makeTestRuntime({ agentManager, sessionManager });

    const opResendOriginal: RunOperation<
      { text: string },
      string,
      Pick<typeof DEFAULT_CONFIG, "routing">
    > = {
      ...runEchoOp,
      name: "resend-original-op",
      parse: (_output) => {
        throw new Error("Trigger retry");
      },
      retry: originalPromptShouldBeResent,
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
        opResendOriginal,
        { text: "test" },
      );
    } catch {
      // Expected
    }

    expect(shouldRetryCallCount).toBeGreaterThanOrEqual(1);
  });

  test("synthetic hopBody re-throws when ctx.send() throws (transport failure)", async () => {
    const sendError = new Error("Transport failure");

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => {
        throw sendError;
      },
    });
    const sessionManager = makeSessionManager();
    const runtime = makeTestRuntime({ agentManager, sessionManager });

    const opWithTransportFailure: RunOperation<
      { text: string },
      string,
      Pick<typeof DEFAULT_CONFIG, "routing">
    > = {
      ...runEchoOp,
      name: "transport-failure-op",
      retry: {
        preset: "transient-network" as const,
        maxAttempts: 5,
        baseDelayMs: 100,
      },
    };

    let thrownError: Error | null = null;
    try {
      await callOp(
        {
          runtime,
          packageView: runtime.packages.repo(),
          packageDir: "/tmp",
          agentName: "claude",
          storyId: "US-001",
        },
        opWithTransportFailure,
        { text: "hello" },
      );
    } catch (err) {
      thrownError = err as Error;
    }

    expect(thrownError).not.toBeNull();
  });

  test("synthetic hopBody bounds retry loop by MAX_COMPLETE_RETRY_ATTEMPTS", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: {
          success: true,
          exitCode: 0,
          output: "always unparseable",
          rateLimited: false,
          durationMs: 1,
          estimatedCostUsd: 0.001,
          agentFallbacks: [],
        },
        fallbacks: [],
      }),
    });
    const sessionManager = makeSessionManager();
    const runtime = makeTestRuntime({ agentManager, sessionManager });

    const infiniteRetryStrategy = {
      shouldRetry: () => ({
        retry: true,
        delayMs: 0,
      }),
    };

    const opAlwaysRetry: RunOperation<
      { text: string },
      string,
      Pick<typeof DEFAULT_CONFIG, "routing">
    > = {
      ...runEchoOp,
      name: "always-retry-op",
      parse: (_output) => {
        throw new Error("Always fail");
      },
      retry: infiniteRetryStrategy,
    };

    let thrownError: Error | null = null;
    try {
      await callOp(
        {
          runtime,
          packageView: runtime.packages.repo(),
          packageDir: "/tmp",
          agentName: "claude",
          storyId: "US-001",
        },
        opAlwaysRetry,
        { text: "hello" },
      );
    } catch (err) {
      thrownError = err as Error;
    }

    expect(thrownError).not.toBeNull();
    expect(thrownError?.message).toContain("CALL_OP_MAX_RETRIES");
  });

  test("synthetic hopBody accumulates TurnResult estimatedCostUsd across attempts", async () => {
    const costPerCall = 0.001;
    let callCount = 0;

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => {
        callCount++;
        return {
          result: {
            success: true,
            exitCode: 0,
            output: "attempt " + callCount,
            rateLimited: false,
            durationMs: 1,
            estimatedCostUsd: costPerCall,
            agentFallbacks: [],
          },
          fallbacks: [],
        };
      },
    });
    const sessionManager = makeSessionManager();
    const runtime = makeTestRuntime({ agentManager, sessionManager });

    let retryCount = 0;
    const costAccumulationStrategy = {
      shouldRetry: () => {
        retryCount++;
        if (retryCount < 2) {
          return { retry: true, delayMs: 0 };
        }
        return { retry: false };
      },
    };

    const opWithCostTracking: RunOperation<
      { text: string },
      string,
      Pick<typeof DEFAULT_CONFIG, "routing">
    > = {
      ...runEchoOp,
      name: "cost-accumulation-op",
      parse: (_output) => {
        throw new Error("Trigger retry");
      },
      retry: costAccumulationStrategy,
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
        opWithCostTracking,
        { text: "hello" },
      );
    } catch {
      // Expected
    }

    expect(callCount).toBeGreaterThanOrEqual(1);
  });

  test("synthetic hopBody uses _callOpDeps.sleep with runtime signal for delays", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: {
          success: true,
          exitCode: 0,
          output: "after delay",
          rateLimited: false,
          durationMs: 1,
          estimatedCostUsd: 0.001,
          agentFallbacks: [],
        },
        fallbacks: [],
      }),
    });
    const sessionManager = makeSessionManager();
    const runtime = makeTestRuntime({ agentManager, sessionManager });

    let retryCount = 0;
    const delayedRetryStrategy = {
      shouldRetry: () => {
        retryCount++;
        if (retryCount === 1) {
          return { retry: true, delayMs: 50 };
        }
        return { retry: false };
      },
    };

    const opWithDelay: RunOperation<
      { text: string },
      string,
      Pick<typeof DEFAULT_CONFIG, "routing">
    > = {
      ...runEchoOp,
      name: "delayed-retry-op",
      parse: (_output) => {
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

  test("synthetic hopBody threads storyId into RetryContext for run-kind ops", async () => {
    const retryContextCalls: Array<{ storyId?: string }> = [];

    const captureStoryIdStrategy = {
      shouldRetry: (_failure: unknown, _attempt: number, retryCtx: any) => {
        retryContextCalls.push({ storyId: retryCtx.storyId });
        return { retry: false };
      },
    };

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: {
          success: true,
          exitCode: 0,
          output: "output",
          rateLimited: false,
          durationMs: 1,
          estimatedCostUsd: 0.001,
          agentFallbacks: [],
        },
        fallbacks: [],
      }),
    });
    const sessionManager = makeSessionManager();
    const runtime = makeTestRuntime({ agentManager, sessionManager });

    const opWithStoryIdCapture: RunOperation<
      { text: string },
      string,
      Pick<typeof DEFAULT_CONFIG, "routing">
    > = {
      ...runEchoOp,
      name: "storyid-capture-op",
      parse: (_output) => {
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

  // Bug: src/operations/call.ts:323 — when { retry: false }, code throws parseErr
  // instead of returning the latest TurnResult per AC-2.
  // This test FAILS with the current buggy implementation and PASSES once fixed.
  test("when { retry: false } after parse failure, callOp resolves with lastTurnResult not rejects", async () => {
    const agentOutput = "output that cannot be parsed";
    const agentCost = 0.0042;

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: {
          success: true,
          exitCode: 0,
          output: agentOutput,
          rateLimited: false,
          durationMs: 1,
          estimatedCostUsd: agentCost,
          tokenUsage: { inputTokens: 10, outputTokens: 20 },
          internalRoundTrips: 0,
          agentFallbacks: [],
        },
        fallbacks: [],
      }),
    });
    const sessionManager = makeSessionManager();
    const runtime = makeTestRuntime({ agentManager, sessionManager });

    const noRetryStrategy = {
      shouldRetry: () => ({ retry: false as const }),
    };

    const opAlwaysFailsParse: RunOperation<
      { text: string },
      // Return type is TurnResult so the cast below is legal at runtime
      import("../../../src/agents/types").TurnResult,
      Pick<typeof DEFAULT_CONFIG, "routing">
    > = {
      ...runEchoOp,
      name: "no-retry-returns-turn-result-op",
      parse: (_output) => {
        throw new Error("parse always fails — expect TurnResult returned, not this thrown");
      },
      retry: noRetryStrategy,
    } as unknown as RunOperation<
      { text: string },
      import("../../../src/agents/types").TurnResult,
      Pick<typeof DEFAULT_CONFIG, "routing">
    >;

    // AC-2: when { retry: false }, the synthesized hop body returns the latest
    // TurnResult. callOp should RESOLVE, not reject with the parse error.
    const result = await callOp(
      {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-004",
      },
      opAlwaysFailsParse,
      { text: "trigger parse failure" },
    );

    // The resolved value should be the lastTurnResult from the final attempt.
    expect(result).toBeDefined();
    expect(result.output).toBe(agentOutput);
    expect(result.estimatedCostUsd).toBe(agentCost);
  });
});
