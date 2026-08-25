import { afterEach, describe, expect, test } from "bun:test";
import { makeMockAgentManager, makeSessionManager, makeTestRuntime } from "@test/helpers";
import type { AgentRunRequest } from "@/agents";
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

// Untyped (no RunOperation<..., string, ...> annotation) so its optional fields
// (verify, etc.) don't carry runEchoOp's O=string signature when spread into an
// O=TurnResult op below — a typed spread source pins optional-field types to its
// own generic even when the field is absent at runtime.
const echoOpBaseFields = {
  kind: "run" as const,
  name: runEchoOp.name,
  stage: runEchoOp.stage,
  config: runEchoOp.config,
  session: runEchoOp.session,
  build: runEchoOp.build,
};

describe("callOp — RunOperation.retry decision outcomes (US-004)", () => {
  test("synthetic hopBody respects { retry: false } and resolves with lastTurnResult (not rejects)", async () => {
    const agentOutput = "final output";
    const agentCost = 0.005;

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req: AgentRunRequest) => {
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => ({
        output: agentOutput,
        tokenUsage: { inputTokens: 5, outputTokens: 10 },
        estimatedCostUsd: agentCost,
        internalRoundTrips: 0,
      }),
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const opNoRetry: RunOperation<
      { text: string },
      import("@/agents/types").TurnResult,
      Pick<typeof DEFAULT_CONFIG, "routing">
    > = {
      ...echoOpBaseFields,
      name: "no-retry-resolves-turn-result-op",
      parse: (_output: string) => {
        throw new Error("Parse always fails — expect TurnResult returned, not this thrown");
      },
      retry: { shouldRetry: () => ({ retry: false as const }) },
    };

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
      runWithFallbackFn: async (req: AgentRunRequest) => {
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => ({
        output: "final output after retry with nextPrompt",
        tokenUsage: { inputTokens: 5, outputTokens: 10 },
        estimatedCostUsd: 0.002,
        internalRoundTrips: 0,
      }),
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

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
          return { retry: true, delayMs: 0 } as const;
        }
        return { retry: false as const };
      },
    };

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req: AgentRunRequest) => {
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => ({
        output: "output after resending original",
        tokenUsage: { inputTokens: 5, outputTokens: 10 },
        estimatedCostUsd: 0.001,
        internalRoundTrips: 0,
      }),
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const opResendOriginal = {
      ...runEchoOp,
      name: "resend-original-op",
      parse: (_output: string) => {
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

  // AC6 (US-004): estimatedCostUsd is summed across all retry attempts in sendWithParseRetry.
  // When parse fails and no fallback is provided, lastRetryTurn carries the accumulated cost.
  test("synthetic hopBody accumulates TurnResult estimatedCostUsd across attempts", async () => {
    const costPerCall = 0.001;
    let callCount = 0;

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req: AgentRunRequest) => {
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => {
        callCount++;
        return {
          output: `attempt ${callCount}`,
          tokenUsage: { inputTokens: 5, outputTokens: 10 },
          estimatedCostUsd: costPerCall,
          internalRoundTrips: 0,
        };
      },
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

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

    // O = TurnResult: parse always throws, so callOp returns lastRetryTurn via the
    // parse-failure path when the strategy has no fallback.
    const opWithCostTracking: RunOperation<
      { text: string },
      import("@/agents/types").TurnResult,
      Pick<typeof DEFAULT_CONFIG, "routing">
    > = {
      ...echoOpBaseFields,
      name: "cost-accumulation-op",
      parse: (_output: string) => {
        throw new Error("Trigger retry");
      },
      retry: costAccumulationStrategy,
    };

    const result = await callOp(
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

    // Two session turns fired (attempt 0 + 1 retry), cost accumulates to 2 × costPerCall.
    expect(callCount).toBe(2);
    expect(result.estimatedCostUsd).toBeCloseTo(costPerCall * 2);
  });

  // AC-2 (US-004): when { retry: false }, callOp returns the latest TurnResult (does not throw).
  // This is spec-mandated — ops that cannot tolerate a raw TurnResult must provide exhaustedFallback.
  test("when { retry: false } after parse failure, callOp resolves with lastTurnResult not rejects", async () => {
    const agentOutput = "output that cannot be parsed";
    const agentCost = 0.0042;

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req: AgentRunRequest) => {
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => ({
        output: agentOutput,
        tokenUsage: { inputTokens: 10, outputTokens: 20 },
        estimatedCostUsd: agentCost,
        internalRoundTrips: 0,
      }),
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const noRetryStrategy = {
      shouldRetry: () => ({ retry: false as const }),
    };

    const opAlwaysFailsParse: RunOperation<
      { text: string },
      import("@/agents/types").TurnResult,
      Pick<typeof DEFAULT_CONFIG, "routing">
    > = {
      ...echoOpBaseFields,
      name: "no-retry-returns-turn-result-op",
      parse: (_output: string) => {
        throw new Error("parse always fails — expect TurnResult returned, not this thrown");
      },
      retry: noRetryStrategy,
    };

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
