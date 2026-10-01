import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  assertDefined,
  makeMockAgentManager,
  makeMockRuntime,
  makeSessionManager,
  makeTestRuntime,
  withWarnSpy,
} from "@test/helpers";
import type { AgentFallbackRecord } from "@/agents/manager-types";
import type { RetryPreset, RetryStrategy } from "@/agents/retry";
import type { CompleteResult } from "@/agents/types";
import type { DEFAULT_CONFIG } from "@/config";
import { pickSelector } from "@/config";
import type { CallContext, CompleteOperation, RunOperation } from "@/operations";
import { _callOpDeps, callOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import type { SessionRole } from "@/session";

const testSel = pickSelector("retry-op-test", "routing");

// Minimal complete op used across all retry tests
const successOp: CompleteOperation<string, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
  kind: "complete",
  name: "retry-test-op",
  stage: "run",
  config: testSel,
  build: (input) => ({
    role: { id: "role", content: "", overridable: false },
    task: { id: "task", content: input, overridable: false },
  }),
  parse: (output) => output,
};

// Save/restore _callOpDeps.sleep around each test
let origSleep: typeof _callOpDeps.sleep;
let origReadFileOutput: typeof _callOpDeps.readFileOutput;
const createdRuntimes: NaxRuntime[] = [];
beforeEach(() => {
  origSleep = _callOpDeps.sleep;
  origReadFileOutput = _callOpDeps.readFileOutput;
});
afterEach(async () => {
  _callOpDeps.sleep = origSleep;
  _callOpDeps.readFileOutput = origReadFileOutput;
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

describe("callOp retry loop (kind:complete)", () => {
  test("no retry field — throws immediately on error", async () => {
    let callCount = 0;
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => {
        callCount++;
        throw new Error("transient");
      },
    });
    const runtime = makeTestRuntime({ agentManager });
    createdRuntimes.push(runtime);
    const ctx = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "US-001",
    };

    await expect(callOp(ctx, { ...successOp }, "hello")).rejects.toThrow("transient");
    expect(callCount).toBe(1);
  });

  test("retry: transient-network, maxAttempts:2 — retries once then throws", async () => {
    const sleepCalls: number[] = [];
    _callOpDeps.sleep = async (ms: number) => {
      sleepCalls.push(ms);
    };

    let callCount = 0;
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => {
        callCount++;
        throw new Error("transient");
      },
    });
    const runtime = makeTestRuntime({ agentManager });
    createdRuntimes.push(runtime);
    const ctx = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "US-001",
    };

    const preset: RetryPreset = { preset: "transient-network", maxAttempts: 2, baseDelayMs: 500 };

    await expect(callOp(ctx, { ...successOp, retry: preset }, "hello")).rejects.toThrow("transient");
    expect(callCount).toBe(2); // 1 initial + 1 retry
    expect(sleepCalls).toEqual([500]); // slept once (baseDelayMs at attempt 0)
  });

  test("retry: transient-network — succeeds on second attempt", async () => {
    const sleepCalls: number[] = [];
    _callOpDeps.sleep = async (ms: number) => {
      sleepCalls.push(ms);
    };

    let callCount = 0;
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => {
        callCount++;
        if (callCount === 1) throw new Error("transient");
        return {
          output: "pong",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
        } satisfies CompleteResult;
      },
    });
    const runtime = makeTestRuntime({ agentManager });
    createdRuntimes.push(runtime);
    const ctx = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "US-001",
    };

    const preset: RetryPreset = { preset: "transient-network", maxAttempts: 2, baseDelayMs: 500 };
    const result = await callOp(ctx, { ...successOp, retry: preset }, "hello");

    expect(result).toBe("pong");
    expect(callCount).toBe(2);
    expect(sleepCalls).toEqual([500]);
  });

  test("retry: function resolver returning undefined — no retry", async () => {
    const sleepCalls: number[] = [];
    _callOpDeps.sleep = async (ms: number) => {
      sleepCalls.push(ms);
    };

    let callCount = 0;
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => {
        callCount++;
        throw new Error("transient");
      },
    });
    const runtime = makeTestRuntime({ agentManager });
    createdRuntimes.push(runtime);
    const ctx = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "US-001",
    };

    // resolver returning undefined → no retry
    const opWithNullResolver: CompleteOperation<string, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
      ...successOp,
      retry: () => undefined,
    };

    await expect(callOp(ctx, opWithNullResolver, "hello")).rejects.toThrow("transient");
    expect(callCount).toBe(1);
    expect(sleepCalls).toHaveLength(0);
  });
});

describe("callOp retry loop (kind:run) — op.recover on parse exhaustion (#993)", () => {
  test("re-reads file output when a later send rewrites different same-length content", async () => {
    const outputPath = "/tmp/plan.json";
    const firstOutput = '{"analysis":"draft-v1"}';
    const secondOutput = '{"analysis":"final-v1"}';
    expect(firstOutput.length).toBe(secondOutput.length);

    let readCount = 0;
    _callOpDeps.readFileOutput = async () => {
      readCount++;
      return readCount === 1 ? firstOutput : secondOutput;
    };

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const { executeHop } = req;
        assertDefined(executeHop, "req.executeHop");
        const hopResult = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => ({
        output: "prd written",
        estimatedCostUsd: 0,
        internalRoundTrips: 1,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      }),
    });
    const runtime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    const runOp: RunOperation<string, { analysis: string }, Pick<typeof DEFAULT_CONFIG, "routing">> = {
      kind: "run",
      name: "file-output-refresh-op",
      stage: "plan",
      config: testSel,
      session: { role: "plan", lifetime: "fresh" },
      build: (input) => ({
        role: { id: "role", content: "", overridable: false },
        task: { id: "task", content: input, overridable: false },
      }),
      fileOutput: () => outputPath,
      hopBody: async (initialPrompt, ctx) => {
        await ctx.send(initialPrompt);
        return ctx.send("refine");
      },
      parse: (output) => JSON.parse(output) as { analysis: string },
    };

    const result = await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      runOp,
      "hello",
    );

    expect(result).toEqual({ analysis: "final-v1" });
    expect(readCount).toBe(2);
  });

  test("reuses the latest file snapshot when a later send leaves the file unchanged", async () => {
    const outputPath = "/tmp/plan.json";
    const fileOutput = '{"analysis":"draft-v1"}';

    let readCount = 0;
    _callOpDeps.readFileOutput = async () => {
      readCount++;
      return fileOutput;
    };

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const { executeHop } = req;
        assertDefined(executeHop, "req.executeHop");
        const hopResult = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => ({
        output: "prd written",
        estimatedCostUsd: 0,
        internalRoundTrips: 1,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      }),
    });
    const runtime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    const runOp: RunOperation<string, { analysis: string }, Pick<typeof DEFAULT_CONFIG, "routing">> = {
      kind: "run",
      name: "file-output-snapshot-op",
      stage: "plan",
      config: testSel,
      session: { role: "plan", lifetime: "fresh" },
      build: (input) => ({
        role: { id: "role", content: "", overridable: false },
        task: { id: "task", content: input, overridable: false },
      }),
      fileOutput: () => outputPath,
      hopBody: async (initialPrompt, ctx) => {
        await ctx.send(initialPrompt);
        return ctx.send("refine");
      },
      parse: (output) => JSON.parse(output) as { analysis: string },
      recover: async () => ({ analysis: "recover-should-not-win" }),
    };

    const result = await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      runOp,
      "hello",
    );

    expect(result).toEqual({ analysis: "draft-v1" });
    expect(readCount).toBe(2);
  });

  test("sendWithParseRetry probes substituted file output instead of the agent acknowledgement", async () => {
    const outputPath = "/tmp/plan.json";
    const fileOutput = '{"analysis":"draft-v1"}';
    let readCount = 0;
    _callOpDeps.readFileOutput = async () => {
      readCount++;
      return fileOutput;
    };

    let runCount = 0;
    const shouldRetry: RetryStrategy["shouldRetry"] = (failure, attempt, ctx) => {
      expect(failure).toBeInstanceOf(Error);
      expect(attempt).toBe(0);
      expect(ctx.lastOutput).toBe(fileOutput);
      return { retry: false };
    };

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const { executeHop } = req;
        assertDefined(executeHop, "req.executeHop");
        const hopResult = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => {
        runCount++;
        return {
          output: "prd written",
          estimatedCostUsd: 0,
          internalRoundTrips: 1,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    });
    const runtime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    const runOp: RunOperation<string, { analysis: string }, Pick<typeof DEFAULT_CONFIG, "routing">> = {
      kind: "run",
      name: "file-output-retry-op",
      stage: "plan",
      config: testSel,
      session: { role: "plan", lifetime: "fresh" },
      build: (input) => ({
        role: { id: "role", content: "", overridable: false },
        task: { id: "task", content: input, overridable: false },
      }),
      retry: { shouldRetry },
      fileOutput: () => outputPath,
      hopBody: async (initialPrompt, ctx) => ctx.sendWithParseRetry(initialPrompt),
      parse: (output) => JSON.parse(output) as { analysis: string },
    };

    const result = await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      runOp,
      "hello",
    );

    expect(result).toEqual({ analysis: "draft-v1" });
    expect(readCount).toBe(1);
    expect(runCount).toBe(1);
  });

  test("sendWithParseRetry re-reads substituted file output on retry attempts", async () => {
    const outputPath = "/tmp/plan.json";
    const firstOutput = '{"analysis":"draft-v1"}';
    const secondOutput = '{"analysis":"final-v1"}';
    expect(firstOutput.length).toBe(secondOutput.length);

    let readCount = 0;
    _callOpDeps.readFileOutput = async () => {
      readCount++;
      return readCount === 1 ? firstOutput : secondOutput;
    };

    let runCount = 0;
    const shouldRetry: RetryStrategy["shouldRetry"] = (failure, attempt, ctx) => {
      expect(failure).toBeInstanceOf(Error);
      if (attempt === 0) {
        expect(ctx.lastOutput).toBe(firstOutput);
        return { retry: true, delayMs: 0, nextPrompt: "retry" };
      }

      expect(attempt).toBe(1);
      expect(ctx.lastOutput).toBe(secondOutput);
      return { retry: false };
    };

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const { executeHop } = req;
        assertDefined(executeHop, "req.executeHop");
        const hopResult = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => {
        runCount++;
        return {
          output: "prd written",
          estimatedCostUsd: 0,
          internalRoundTrips: 1,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    });
    const runtime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    const runOp: RunOperation<string, { analysis: string }, Pick<typeof DEFAULT_CONFIG, "routing">> = {
      kind: "run",
      name: "file-output-retry-loop-op",
      stage: "plan",
      config: testSel,
      session: { role: "plan", lifetime: "fresh" },
      build: (input) => ({
        role: { id: "role", content: "", overridable: false },
        task: { id: "task", content: input, overridable: false },
      }),
      retry: { shouldRetry },
      fileOutput: () => outputPath,
      hopBody: async (initialPrompt, ctx) => ctx.sendWithParseRetry(initialPrompt),
      parse: (output) => JSON.parse(output) as { analysis: string },
    };

    const result = await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      runOp,
      "hello",
    );

    expect(result).toEqual({ analysis: "final-v1" });
    expect(readCount).toBe(2);
    expect(runCount).toBe(2);
  });

  test("op.parse throws after retry exhaustion AND op.recover returns non-null — returns recover value not TurnResult", async () => {
    _callOpDeps.sleep = async () => {};

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: {
          success: true,
          exitCode: 0,
          output: "File already valid.",
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
    createdRuntimes.push(runtime);

    const recovered = { userStories: [{ id: "US-001", title: "existing" }] };

    const runOp: RunOperation<string, typeof recovered, Pick<typeof DEFAULT_CONFIG, "routing">> = {
      kind: "run",
      name: "strict-parse-run-op",
      stage: "plan",
      config: testSel,
      session: { role: "plan", lifetime: "fresh" },
      build: (input) => ({
        role: { id: "role", content: "", overridable: false },
        task: { id: "task", content: input, overridable: false },
      }),
      parse: (_output) => {
        throw new Error("cannot parse chat ack");
      },
      retry: {
        shouldRetry: (_failure, attempt) =>
          attempt < 2 ? { retry: true, delayMs: 0, nextPrompt: "retry" } : { retry: false },
      },
      recover: async () => recovered,
    };

    const result = await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      runOp,
      "feature-x",
    );

    expect(result).toBe(recovered);
    expect(result.userStories[0]?.id).toBe("US-001");
  });

  /** A runtime whose hop actually executes, so sendWithParseRetry runs and sets lastRetryTurn. */
  function makeExhaustingRuntime(): NaxRuntime {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const { executeHop } = req;
        assertDefined(executeHop, "req.executeHop");
        const hopResult = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => ({
        output: "PRD written to disk.",
        estimatedCostUsd: 0,
        internalRoundTrips: 1,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      }),
    });
    const runtime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);
    return runtime;
  }

  /** Parse always throws, the strategy self-terminates at attempt 2 → envelope passthrough. */
  function makeExhaustingOp(
    name: string,
    recover?: () => Promise<{ analysis: string } | null>,
  ): RunOperation<string, { analysis: string }, Pick<typeof DEFAULT_CONFIG, "routing">> {
    return {
      kind: "run",
      name,
      stage: "plan",
      config: testSel,
      session: { role: "plan", lifetime: "fresh" },
      build: (input) => ({
        role: { id: "role", content: "", overridable: false },
        task: { id: "task", content: input, overridable: false },
      }),
      retry: {
        shouldRetry: (_failure, attempt) =>
          attempt < 2 ? { retry: true, delayMs: 0, nextPrompt: "retry" } : { retry: false },
      },
      hopBody: async (initialPrompt, ctx) => ctx.sendWithParseRetry(initialPrompt),
      parse: (_output) => {
        throw new Error("cannot parse chat ack");
      },
      ...(recover ? { recover } : {}),
    };
  }

  test("exhaustion warn reports that a declared recover returned null", async () => {
    _callOpDeps.sleep = async () => {};
    const runtime = makeExhaustingRuntime();

    await withWarnSpy(async (warnSpy) => {
      await callOp(
        { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
        makeExhaustingOp("recover-returns-null-op", async () => null),
        "feature-x",
      );

      const warn = warnSpy.mock.calls.find((c) => c[0] === "callop" && String(c[1]).includes("raw TurnResult"));
      expect(warn).toBeDefined();
      // The old message claimed "no recover" even when one ran and returned null,
      // which cost attribution time in #2124.
      expect(warn?.[1]).not.toContain("no recover");
      expect(warn?.[2]?.recover).toBe("returned-null");
    });
  });

  test("exhaustion warn reports when no recover was declared", async () => {
    _callOpDeps.sleep = async () => {};
    const runtime = makeExhaustingRuntime();

    await withWarnSpy(async (warnSpy) => {
      await callOp(
        { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-002" },
        makeExhaustingOp("no-recover-op"),
        "feature-x",
      );

      const warn = warnSpy.mock.calls.find((c) => c[0] === "callop" && String(c[1]).includes("raw TurnResult"));
      expect(warn?.[2]?.recover).toBe("not-declared");
    });
  });
});

// ---------------------------------------------------------------------------
// Sticky target (nax#1964): a story stays on the agent it swapped to
// ---------------------------------------------------------------------------

const stickyTestSel = pickSelector("sticky-target-test", "routing");

function stickyHop(overrides: Partial<AgentFallbackRecord> = {}): AgentFallbackRecord {
  return {
    storyId: "US-001",
    priorAgent: "claude",
    newAgent: "codex",
    hop: 1,
    outcome: "fail-quota",
    category: "availability",
    timestamp: "2026-08-25T00:00:00.000Z",
    costUsd: 0.25,
    ...overrides,
  };
}

function makeStickyOp(
  name: string,
  tier?: string,
): RunOperation<string, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
  return {
    kind: "run",
    name,
    stage: "run",
    config: stickyTestSel,
    session: { role: "implementer", lifetime: "fresh" },
    ...(tier !== undefined ? { model: tier } : {}),
    build: (input) => ({
      role: { id: "role", content: "You process input.", overridable: false },
      task: { id: "task", content: input, overridable: false },
    }),
    parse: (output) => output,
  };
}

function managerSwapping(deadAgent: string, liveAgent: string, dispatched: string[]) {
  return makeMockAgentManager({
    runWithFallbackFn: async (req, primaryAgentOverride) => {
      const agent = primaryAgentOverride ?? deadAgent;
      dispatched.push(agent);
      const swapped = agent === deadAgent;
      const { executeHop } = req;
      assertDefined(executeHop, "req.executeHop");
      const hopResult = await executeHop(swapped ? liveAgent : agent, undefined, { kind: "primary" }, req.runOptions);
      const fallbacks = swapped ? [stickyHop({ priorAgent: deadAgent, newAgent: liveAgent })] : [];
      return {
        result: { ...hopResult.result, agentFallbacks: fallbacks },
        fallbacks,
        finalTarget: { agent: swapped ? liveAgent : agent },
        didSwap: swapped,
      };
    },
    runAsSessionFn: async () => ({
      output: "done",
      estimatedCostUsd: 0,
      internalRoundTrips: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
    }),
  });
}

function makeStickyCompleteOp(name: string): CompleteOperation<string, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
  return {
    kind: "complete",
    name,
    stage: "complete",
    config: stickyTestSel,
    build: (input) => ({
      role: { id: "role", content: "You process input.", overridable: false },
      task: { id: "task", content: input, overridable: false },
    }),
    parse: (output) => output,
  };
}

function managerSwappingComplete(deadAgent: string, liveAgent: string, dispatched: string[]) {
  return makeMockAgentManager({
    completeAsWithFallbackFn: async (agentName) => {
      dispatched.push(agentName);
      const swapped = agentName === deadAgent;
      const fallbacks = swapped ? [stickyHop({ priorAgent: deadAgent, newAgent: liveAgent })] : [];
      return {
        result: { output: "done", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 },
        fallbacks,
        finalTarget: { agent: swapped ? liveAgent : agentName },
        didSwap: swapped,
        dispatchesCompleted: 1,
      };
    },
  });
}

function managerSwappingRunAndComplete(
  deadAgent: string,
  liveAgent: string,
  dispatchedRun: string[],
  dispatchedComplete: string[],
) {
  return makeMockAgentManager({
    runWithFallbackFn: async (req, primaryAgentOverride) => {
      const agent = primaryAgentOverride ?? deadAgent;
      dispatchedRun.push(agent);
      const swapped = agent === deadAgent;
      const { executeHop } = req;
      assertDefined(executeHop, "req.executeHop");
      const hopResult = await executeHop(swapped ? liveAgent : agent, undefined, { kind: "primary" }, req.runOptions);
      const fallbacks = swapped ? [stickyHop({ priorAgent: deadAgent, newAgent: liveAgent })] : [];
      return {
        result: { ...hopResult.result, agentFallbacks: fallbacks },
        fallbacks,
        finalTarget: { agent: swapped ? liveAgent : agent },
        didSwap: swapped,
      };
    },
    completeAsWithFallbackFn: async (agentName) => {
      dispatchedComplete.push(agentName);
      return {
        result: { output: "done", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 },
        fallbacks: [],
        dispatchesCompleted: 1,
      };
    },
    runAsSessionFn: async () => ({
      output: "done",
      estimatedCostUsd: 0,
      internalRoundTrips: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
    }),
  });
}

function makeStickyCtx(opts: {
  runtime: NaxRuntime;
  storyId: string;
  agentName: string;
  sessionRole?: SessionRole;
}): CallContext {
  return {
    runtime: opts.runtime,
    packageView: opts.runtime.packages.repo(),
    packageDir: "/tmp",
    agentName: opts.agentName,
    storyId: opts.storyId,
    ...(opts.sessionRole !== undefined ? { sessionOverride: { role: opts.sessionRole } } : {}),
  };
}

describe("callOp sticks a story to the agent it swapped to (#1964)", () => {
  test("a later op of the same story dispatches on the agent the earlier op swapped to", async () => {
    const dispatched: string[] = [];
    const runtime = makeMockRuntime({ agentManager: managerSwapping("native", "claude", dispatched) });
    createdRuntimes.push(runtime);
    const ctx = makeStickyCtx({ runtime, storyId: "US-001", agentName: "native" });

    await callOp(ctx, makeStickyOp("op-one"), "work");
    await callOp(ctx, makeStickyOp("op-two"), "work");

    expect(dispatched).toEqual(["native", "claude"]);
  });

  test("a different story is unaffected by another story's swap", async () => {
    const dispatched: string[] = [];
    const runtime = makeMockRuntime({ agentManager: managerSwapping("native", "claude", dispatched) });
    createdRuntimes.push(runtime);

    await callOp(makeStickyCtx({ runtime, storyId: "US-001", agentName: "native" }), makeStickyOp("op-one"), "work");
    await callOp(makeStickyCtx({ runtime, storyId: "US-002", agentName: "native" }), makeStickyOp("op-two"), "work");

    expect(dispatched).toEqual(["native", "native"]);
  });

  test("an escalated tier gets a fresh agent choice", async () => {
    const dispatched: string[] = [];
    const runtime = makeMockRuntime({ agentManager: managerSwapping("native", "claude", dispatched) });
    createdRuntimes.push(runtime);

    await callOp(
      makeStickyCtx({ runtime, storyId: "US-001", agentName: "native" }),
      makeStickyOp("op-one", "balanced"),
      "work",
    );
    await callOp(
      makeStickyCtx({ runtime, storyId: "US-001", agentName: "native" }),
      makeStickyOp("op-two", "powerful"),
      "work",
    );

    expect(dispatched).toEqual(["native", "native"]);
  });

  test("a later complete-kind op of the same story dispatches on the agent an earlier complete-kind op swapped to", async () => {
    const dispatched: string[] = [];
    const runtime = makeMockRuntime({ agentManager: managerSwappingComplete("native", "claude", dispatched) });
    createdRuntimes.push(runtime);
    const ctx = makeStickyCtx({ runtime, storyId: "US-001", agentName: "native" });

    await callOp(ctx, makeStickyCompleteOp("complete-op-one"), "work");
    await callOp(ctx, makeStickyCompleteOp("complete-op-two"), "work");

    expect(dispatched).toEqual(["native", "claude"]);
  });

  test("a complete-kind op honours the target a run-kind op of the same story and role already swapped to", async () => {
    const dispatchedRun: string[] = [];
    const dispatchedComplete: string[] = [];
    const runtime = makeMockRuntime({
      agentManager: managerSwappingRunAndComplete("native", "claude", dispatchedRun, dispatchedComplete),
    });
    createdRuntimes.push(runtime);
    const ctx = makeStickyCtx({ runtime, storyId: "US-001", agentName: "native", sessionRole: "implementer" });

    await callOp(ctx, makeStickyOp("run-op"), "work");
    await callOp(ctx, makeStickyCompleteOp("complete-op"), "work");

    expect(dispatchedRun).toEqual(["native"]);
    expect(dispatchedComplete).toEqual(["claude"]);
  });

  test("a complete-kind op with no sessionOverride does NOT inherit another role's swap (#1965 D4)", async () => {
    const dispatchedRun: string[] = [];
    const dispatchedComplete: string[] = [];
    const runtime = makeMockRuntime({
      agentManager: managerSwappingRunAndComplete("native", "claude", dispatchedRun, dispatchedComplete),
    });
    createdRuntimes.push(runtime);
    const ctx = makeStickyCtx({ runtime, storyId: "US-001", agentName: "native" });

    await callOp(ctx, makeStickyOp("run-op"), "work");
    await callOp(ctx, makeStickyCompleteOp("complete-op"), "work");

    expect(dispatchedRun).toEqual(["native"]);
    expect(dispatchedComplete).toEqual(["native"]);
  });
});
