import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _callOpDeps, callOp } from "@/operations";
import type { CompleteOperation, RunOperation } from "@/operations";
import type { RetryPreset } from "@/agents/retry";
import { DEFAULT_CONFIG } from "@/config";
import { makeMockAgentManager, makeSessionManager, makeTestRuntime } from "@test/helpers";
import type { NaxRuntime } from "@/runtime";
import { pickSelector } from "@/config";
import type { CompleteResult } from "@/agents/types";

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
        return { output: "pong", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 } satisfies CompleteResult;
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
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
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
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
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
    const shouldRetry = (failure: Error, attempt: number, ctx: { lastOutput?: string }) => {
      expect(failure).toBeInstanceOf(Error);
      expect(attempt).toBe(0);
      expect(ctx.lastOutput).toBe(fileOutput);
      return { retry: false };
    };

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
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
    const shouldRetry = (failure: Error, attempt: number, ctx: { lastOutput?: string }) => {
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
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
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
        result: { success: true, exitCode: 0, output: "File already valid.", rateLimited: false, durationMs: 1, estimatedCostUsd: 0, agentFallbacks: [] },
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
      parse: (_output) => { throw new Error("cannot parse chat ack"); },
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
});
