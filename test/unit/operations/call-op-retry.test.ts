import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _callOpDeps, callOp } from "../../../src/operations";
import type { CompleteOperation, RunOperation } from "../../../src/operations";
import type { RetryPreset } from "../../../src/agents/retry";
import { DEFAULT_CONFIG } from "../../../src/config";
import { makeMockAgentManager, makeSessionManager, makeTestRuntime } from "../../helpers";
import type { NaxRuntime } from "../../../src/runtime";
import { pickSelector } from "../../../src/config";
import type { CompleteResult } from "../../../src/agents/types";

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
const createdRuntimes: NaxRuntime[] = [];
beforeEach(() => {
  origSleep = _callOpDeps.sleep;
});
afterEach(async () => {
  _callOpDeps.sleep = origSleep;
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
