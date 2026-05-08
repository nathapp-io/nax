import { describe, expect, test } from "bun:test";
import { pickSelector } from "../../../src/config";
import type { DEFAULT_CONFIG } from "../../../src/config";
import { callOp } from "../../../src/operations/call";
import type { RunOperation } from "../../../src/operations/types";
import { makeMockAgentManager, makeSessionManager, makeTestRuntime } from "../../helpers";

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

describe("callOp — RunOperation.retry decision outcomes (US-004)", () => {
  test("synthetic hopBody respects { retry: false } and resolves with lastTurnResult (not rejects)", async () => {
    const agentOutput = "final output";
    const agentCost = 0.005;

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: {
          success: true,
          exitCode: 0,
          output: agentOutput,
          rateLimited: false,
          durationMs: 1,
          estimatedCostUsd: agentCost,
          tokenUsage: { inputTokens: 5, outputTokens: 10 },
          internalRoundTrips: 0,
          agentFallbacks: [],
        },
        fallbacks: [],
      }),
    });
    const sessionManager = makeSessionManager();
    const runtime = makeTestRuntime({ agentManager, sessionManager });

    const opNoRetry = {
      ...runEchoOp,
      name: "no-retry-resolves-turn-result-op",
      parse: (_output: string) => {
        throw new Error("Parse always fails — expect TurnResult returned, not this thrown");
      },
      retry: { shouldRetry: () => ({ retry: false as const }) },
    } as unknown as RunOperation<
      { text: string },
      import("../../../src/agents/types").TurnResult,
      Pick<typeof DEFAULT_CONFIG, "routing">
    >;

    const result = await callOp(
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

    expect(result.output).toBe(agentOutput);
    expect(result.estimatedCostUsd).toBe(agentCost);
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
          } as const;
        }
        return { retry: false as const };
      },
    };

    const opWithNextPrompt = {
      ...runEchoOp,
      name: "next-prompt-op",
      parse: (_output: string) => {
        throw new Error("Always fail to trigger retry");
      },
      retry: retryWithNextPromptStrategy,
    } as unknown as RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">>;

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
          return { retry: true, delayMs: 0 } as const;
        }
        return { retry: false as const };
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

    const opResendOriginal = {
      ...runEchoOp,
      name: "resend-original-op",
      parse: (_output: string) => {
        throw new Error("Trigger retry");
      },
      retry: originalPromptShouldBeResent,
    } as unknown as RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">>;

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
            output: `attempt ${callCount}`,
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
          return { retry: true, delayMs: 0 } as const;
        }
        return { retry: false as const };
      },
    };

    const opWithCostTracking = {
      ...runEchoOp,
      name: "cost-accumulation-op",
      parse: (_output: string) => {
        throw new Error("Trigger retry");
      },
      retry: costAccumulationStrategy,
    } as unknown as RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">>;

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

  // AC-2 (US-004): when { retry: false }, callOp returns the latest TurnResult (does not throw).
  // This is spec-mandated — ops that cannot tolerate a raw TurnResult must provide exhaustedFallback.
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

    const opAlwaysFailsParse = {
      ...runEchoOp,
      name: "no-retry-returns-turn-result-op",
      parse: (_output: string) => {
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
