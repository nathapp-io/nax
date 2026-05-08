import { describe, expect, test } from "bun:test";
import { pickSelector } from "../../../src/config";
import type { DEFAULT_CONFIG } from "../../../src/config";
import { NaxError } from "../../../src/errors";
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

  test("when both op.hopBody and op.retry are set, callOp throws OP_HOPBODY_RETRY_BOTH_SET", async () => {
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

    const opWithBothFields: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
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

    let thrown: Error | null = null;
    try {
      await callOp(
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
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).not.toBeNull();
    if (thrown instanceof NaxError) {
      expect(thrown.code).toBe("OP_HOPBODY_RETRY_BOTH_SET");
    }
    expect(thrown?.message).toContain("mutually exclusive");
    // Guard fires before any agent call
    expect(agentManager.runWithFallback).toHaveBeenCalledTimes(0);
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
    const runtime = makeTestRuntime({ agentManager, sessionManager });

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
      shouldRetry: () =>
        ({
          retry: true,
          delayMs: 0,
        }) as const,
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
});
