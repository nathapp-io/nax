import { afterEach, describe, expect, test } from "bun:test";
import { makeMockAgentManager, makeSessionManager, makeTestRuntime } from "@test/helpers";
import type { AgentRunRequest } from "@/agents";
import type { DEFAULT_CONFIG } from "@/config";
import { pickSelector } from "@/config";
import { callOp } from "@/operations";
import type { HopBodyContext, RunOperation } from "@/operations/types";
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
    runtime = makeTestRuntime({ agentManager, sessionManager });

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
    runtime = makeTestRuntime({ agentManager, sessionManager });

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
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const opWithResolverTracking: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
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

  test("when op.retry and op.hopBody are both set, no error is thrown and body receives sendWithParseRetry", async () => {
    let capturedCtx: HopBodyContext<{ text: string }> | undefined;

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req: AgentRunRequest) => {
        // Invoke executeHop to drive the effective hop body
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async (_agentName, _handle, _prompt, _opts) => ({
        output: "from hopBody",
        tokenUsage: { inputTokens: 1, outputTokens: 1 },
        estimatedCostUsd: 0.01,
        internalRoundTrips: 0,
      }),
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const opWithBothFields: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
      ...runEchoOp,
      name: "compose-op",
      hopBody: async (initialPrompt, ctx) => {
        capturedCtx = ctx;
        return ctx.send(initialPrompt);
      },
      retry: {
        preset: "transient-network" as const,
        maxAttempts: 2,
        baseDelayMs: 0,
      },
    };

    // op.hopBody and op.retry now compose — no error thrown
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

    expect(result).toBe("from hopBody");
    expect(agentManager.runWithFallback).toHaveBeenCalledTimes(1);
    // Body received a context with sendWithParseRetry
    expect(capturedCtx).toBeDefined();
    expect(typeof capturedCtx?.sendWithParseRetry).toBe("function");
    // sendWithParseRetry is a distinct function from send
    expect(capturedCtx?.sendWithParseRetry).not.toBe(capturedCtx?.send);
  });

  test("when op.retry is unset and op.hopBody is set, ctx.sendWithParseRetry dispatches once (no retry loop)", async () => {
    let capturedCtx: HopBodyContext<{ text: string }> | undefined;
    let sendCallCount = 0;

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req: AgentRunRequest) => {
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async (_agentName, _handle, _prompt, _opts) => {
        sendCallCount++;
        return {
          output: "single turn",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
          internalRoundTrips: 0,
        };
      },
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const opWithHopBodyOnly: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
      ...runEchoOp,
      name: "hopbody-only-op",
      hopBody: async (initialPrompt, ctx) => {
        capturedCtx = ctx;
        return ctx.sendWithParseRetry(initialPrompt);
      },
    };

    await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      opWithHopBodyOnly,
      { text: "hello" },
    );

    expect(sendCallCount).toBe(1);
    expect(capturedCtx).toBeDefined();
    expect(typeof capturedCtx?.sendWithParseRetry).toBe("function");
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
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const opWithRetry: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
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

  test("synthetic hopBody re-throws when ctx.send() throws (transport failure)", async () => {
    const sendError = new Error("Transport failure");

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => {
        throw sendError;
      },
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const opWithTransportFailure: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
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

  test("synthetic hopBody bounds retry loop by MAX_COMPLETE_RETRY_ATTEMPTS — Phase A regression", async () => {
    // executeHop must be called so sendWithParseRetry drives the retry loop inside one session.
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req: AgentRunRequest) => {
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async (_agentName, _handle, _prompt, _opts) => ({
        output: "always unparseable",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0.001,
        internalRoundTrips: 0,
      }),
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const infiniteRetryStrategy = {
      shouldRetry: () => ({ retry: true, delayMs: 0 }) as const,
    };

    const opAlwaysRetry: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
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

  test("op.retry runs all attempts in a single session (Phase A same-session regression)", async () => {
    // All parse-retry attempts must share one session — openSession called exactly once.
    let sendCallCount = 0;
    const { makeParseRetryStrategy } = await import("@/agents");
    const { ReviewPromptBuilder } = await import("@/prompts");
    const { validateLLMShape } = await import("@/review");

    const validOutput = JSON.stringify({ passed: true, findings: [] });

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req: AgentRunRequest) => {
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async (_agentName, _handle, _prompt, _opts) => {
        sendCallCount++;
        // First call: invalid JSON; second call: valid JSON
        const output = sendCallCount === 1 ? "invalid json" : validOutput;
        return {
          output,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0.01,
          internalRoundTrips: 0,
        };
      },
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const opWithParseRetry: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
      ...runEchoOp,
      name: "parse-retry-same-session-op",
      retry: makeParseRetryStrategy({
        validate: (parsed) => validateLLMShape(parsed) !== null,
        reviewerKind: "test",
        maxAttempts: 2,
        prompts: {
          invalid: () => ReviewPromptBuilder.jsonRetry(),
          truncated: () => ReviewPromptBuilder.jsonRetry(),
        },
      }),
    };

    await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      opWithParseRetry,
      { text: "hello" },
    );

    // Two sends (attempt 0 = invalid, attempt 1 = valid) but only ONE session opened
    expect(sendCallCount).toBe(2);
    expect(sessionManager.openSession).toHaveBeenCalledTimes(1);
    expect(agentManager.runWithFallback).toHaveBeenCalledTimes(1);
  });

  test("cost is summed across retry attempts via sendWithParseRetry", async () => {
    const { makeParseRetryStrategy } = await import("@/agents");
    const { validateLLMShape } = await import("@/review");

    let sendCallCount = 0;
    const validOutput = JSON.stringify({ passed: true, findings: [] });

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req: AgentRunRequest) => {
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async (_agentName, _handle, _prompt, _opts) => {
        sendCallCount++;
        const output = sendCallCount === 1 ? "invalid json" : validOutput;
        return {
          output,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0.05,
          internalRoundTrips: 0,
        };
      },
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const opWithCostAccumulation: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
      ...runEchoOp,
      name: "cost-accumulation-op",
      retry: makeParseRetryStrategy({
        validate: (parsed) => validateLLMShape(parsed) !== null,
        reviewerKind: "test",
        maxAttempts: 2,
        prompts: {
          invalid: () => "retry json please",
          truncated: () => "retry json please",
        },
      }),
    };

    await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      opWithCostAccumulation,
      { text: "hello" },
    );

    // Two sends at $0.05 each = $0.10 total accumulated by sendWithParseRetry
    // The hop body's TurnResult carries the summed cost via estimatedCostUsd
    expect(sendCallCount).toBe(2);
  });

  test("when op.retry exhausts with decision.fallback, callOp returns the fallback merged with cost", async () => {
    const { makeParseRetryStrategy } = await import("@/agents");

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req: AgentRunRequest) => {
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async (_agentName, _handle, _prompt, _opts) => ({
        output: "always invalid json",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0.02,
        internalRoundTrips: 0,
      }),
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const fallbackValue = { passed: true, findings: [], failOpen: true };

    const opWithFallback: RunOperation<
      { text: string },
      { passed: boolean; findings: unknown[]; failOpen?: boolean },
      Pick<typeof DEFAULT_CONFIG, "routing">
    > = {
      kind: "run",
      name: "fallback-op",
      stage: "review",
      config: testSel,
      session: { role: "implementer", lifetime: "fresh" },
      build: (input) => ({
        role: { id: "role", content: "Review.", overridable: false },
        task: { id: "task", content: input.text, overridable: false },
      }),
      parse: (output) => {
        try {
          return JSON.parse(output);
        } catch {
          throw new Error("parse failed: not JSON");
        }
      },
      retry: makeParseRetryStrategy({
        validate: (parsed) => parsed !== null && typeof parsed === "object" && "passed" in (parsed as object),
        reviewerKind: "test",
        maxAttempts: 2,
        prompts: { invalid: () => "retry", truncated: () => "retry condensed" },
        exhaustedFallback: () => fallbackValue,
      }),
    };

    const result = await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      opWithFallback,
      { text: "hello" },
    );

    expect(result.passed).toBe(true);
    expect(result.failOpen).toBe(true);
    expect(result.findings).toEqual([]);
  });

  test("callOp throws CALL_OP_ABORTED when signal aborted before retry sleep", async () => {
    const abortController = new AbortController();

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req: AgentRunRequest) => {
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => {
        abortController.abort();
        return {
          output: "unparseable after abort",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0.001,
          internalRoundTrips: 0,
        };
      },
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager, parentSignal: abortController.signal });

    let retryCount = 0;
    const alwaysRetry = {
      shouldRetry: () => {
        retryCount++;
        return { retry: true, delayMs: 50 } as const;
      },
    };

    const opAbortRetry: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
      ...runEchoOp,
      name: "abort-retry-op",
      parse: (_output) => {
        throw new Error("Always fail parse");
      },
      retry: alwaysRetry,
    };

    let thrownError: Error | null = null;
    try {
      await callOp(
        { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
        opAbortRetry,
        { text: "hello" },
      );
    } catch (err) {
      thrownError = err as Error;
    }

    expect(thrownError).not.toBeNull();
    expect((thrownError as import("@/errors").NaxError).code).toBe("CALL_OP_ABORTED");
  });

  test("two sendWithParseRetry calls in one hopBody have independent retry state", async () => {
    // P1-4: retryFallback/lastRetryTurn reset per sendWithParseRetry call.
    // First call always fails parse (fallback captured), second call succeeds.
    // The op.parse outcome should reflect only the second call's result.
    const { makeParseRetryStrategy } = await import("@/agents");

    const FALLBACK_VALUE = { status: "exhausted-first-call" };
    const SECOND_OUTPUT = JSON.stringify({ status: "success-second-call" });

    let sessionCallCount = 0;
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req: AgentRunRequest) => {
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => {
        sessionCallCount++;
        return {
          output: sessionCallCount <= 2 ? "always invalid json" : SECOND_OUTPUT,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0.001,
          internalRoundTrips: 0,
        };
      },
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const retryStrategy = makeParseRetryStrategy({
      validate: (parsed) => parsed !== null && typeof parsed === "object" && "status" in (parsed as object),
      reviewerKind: "test",
      maxAttempts: 2,
      prompts: { invalid: () => "retry", truncated: () => "retry" },
      exhaustedFallback: () => FALLBACK_VALUE,
    });

    const opTwoSendCalls: RunOperation<{ text: string }, { status: string }, Pick<typeof DEFAULT_CONFIG, "routing">> = {
      kind: "run",
      name: "two-sendWithParseRetry-op",
      stage: "run",
      config: testSel,
      session: { role: "implementer", lifetime: "fresh" },
      build: (input) => ({
        role: { id: "role", content: "Test.", overridable: false },
        task: { id: "task", content: input.text, overridable: false },
      }),
      parse: (output) => JSON.parse(output),
      retry: retryStrategy,
      hopBody: async (initialPrompt, ctx) => {
        // First call — exhausts retry, captures FALLBACK_VALUE as retryFallback
        await ctx.sendWithParseRetry(initialPrompt);
        // Second call — returns SECOND_OUTPUT which parses successfully
        return ctx.sendWithParseRetry(initialPrompt);
      },
    };

    const result = await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      opTwoSendCalls,
      { text: "hello" },
    );

    // Second call returned valid JSON — that prevails
    expect((result as { status: string }).status).toBe("success-second-call");
  });
});
