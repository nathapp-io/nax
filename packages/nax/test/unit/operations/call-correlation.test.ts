/**
 * Tests for callId/scopeId correlation stamping in callOp (ACs 7-10).
 * Covers: newCorrelationId() format/uniqueness, callId stamping in
 * completeOptions and runOptions, caller-supplied callId preservation.
 */

import type { mock } from "bun:test";
import { afterEach, describe, expect, mock as mockFn, test } from "bun:test";
import {
  agentManagerInternals,
  assertCaughtInstanceOf,
  assertDefined,
  assertNaxError,
  makeMockAgentManager,
  makeMockRuntime,
  makeNaxConfig,
  makeSessionManager,
  makeTestRuntime,
} from "@test/helpers";
import { _agentManagerDeps } from "@/agents/manager";
import type { CompleteResult, TurnResult } from "@/agents/types";
import { type DEFAULT_CONFIG, pickSelector } from "@/config";
import { NaxError } from "@/errors";
import type { CompleteOperation, RunOperation } from "@/operations";
import { callOp, newCorrelationId } from "@/operations";
import { createNoOpCostAggregator, type NaxRuntime } from "@/runtime";

let runtime: NaxRuntime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

const testSel = pickSelector("routing-corr-test", "routing");

const echoCompleteOp: CompleteOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
  kind: "complete",
  name: "echo-corr-complete",
  stage: "run",
  config: testSel,
  build: (input) => ({
    role: { id: "role", content: "Echo.", overridable: false },
    task: { id: "task", content: input.text, overridable: false },
  }),
  parse: (output) => output.trim(),
};

const echoRunOp: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
  kind: "run",
  name: "echo-corr-run",
  stage: "run",
  config: testSel,
  session: { role: "implementer", lifetime: "fresh" },
  build: (input) => ({
    role: { id: "role", content: "Echo.", overridable: false },
    task: { id: "task", content: input.text, overridable: false },
  }),
  parse: (output) => output.trim(),
};

const okCompleteResult: CompleteResult = {
  output: "ok",
  tokenUsage: { inputTokens: 0, outputTokens: 0 },
  estimatedCostUsd: 0,
};

// ─── newCorrelationId (AC10) ────────────────────────────────────────────────

describe("newCorrelationId (AC10)", () => {
  const ID_PATTERN = /^[0-9a-z]+-[0-9a-z]+$/;

  test("produces a string matching /^[0-9a-z]+-[0-9a-z]+$/", () => {
    const id = newCorrelationId();
    expect(typeof id).toBe("string");
    expect(ID_PATTERN.test(id)).toBe(true);
  });

  test("produces strings of at most 16 characters", () => {
    for (let i = 0; i < 20; i++) {
      const id = newCorrelationId();
      expect(id.length).toBeLessThanOrEqual(16);
    }
  });

  test("10,000 sequential calls yield 10,000 distinct values", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      ids.add(newCorrelationId());
    }
    expect(ids.size).toBe(10_000);
  });

  test("stays unique across calls sharing the same Date.now() tick and the same random draw", () => {
    // Neutralize both entropy sources the pre-fix implementation relied on:
    // Date.now() can repeat within a millisecond, and Math.random() is fixed
    // here to the same value every call. Only the monotonic counter this fix
    // introduced can keep the ids distinct under these conditions.
    const originalNow = Date.now;
    const originalRandom = Math.random;
    const frozenNow = originalNow();
    Date.now = () => frozenNow;
    Math.random = () => 0.123456;
    try {
      const ids = new Set<string>();
      for (let i = 0; i < 500; i++) {
        ids.add(newCorrelationId());
      }
      expect(ids.size).toBe(500);
    } finally {
      Date.now = originalNow;
      Math.random = originalRandom;
    }
  });
});

// ─── callOp kind:complete — callId stamping (ACs 7, 8) ─────────────────────

describe("callOp kind:complete — callId/scopeId forwarding (ACs 7, 8)", () => {
  test("opens and closes a scope when the caller supplies none", async () => {
    let observedScopeId: string | undefined;
    const agentManager = makeMockAgentManager({
      completeAsFn: async (_agentName, _prompt, opts) => {
        observedScopeId = opts?.scopeId;
        return okCompleteResult;
      },
    });
    const close = mockFn(() => {});
    const costAggregator = createNoOpCostAggregator();
    costAggregator.openScope = mockFn(() => ({
      scopeId: "call-op-scope",
      snapshot: () => costAggregator.snapshot(),
      close,
    }));
    runtime = makeTestRuntime({ agentManager, costAggregator });

    await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude" },
      echoCompleteOp,
      { text: "hi" },
    );

    expect(observedScopeId).toBe("call-op-scope");
    expect(costAggregator.openScope).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("closes an owned scope when dispatch throws", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => {
        throw new Error("dispatch failed");
      },
    });
    const close = mockFn(() => {});
    const costAggregator = createNoOpCostAggregator();
    costAggregator.openScope = mockFn(() => ({
      scopeId: "failed-call-scope",
      snapshot: () => costAggregator.snapshot(),
      close,
    }));
    runtime = makeTestRuntime({ agentManager, costAggregator });

    await expect(
      callOp(
        { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude" },
        echoCompleteOp,
        { text: "hi" },
      ),
    ).rejects.toThrow("dispatch failed");

    expect(close).toHaveBeenCalledTimes(1);
  });

  test("stamps a fresh callId when ctx.callId is absent", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => okCompleteResult,
    });
    runtime = makeTestRuntime({ agentManager });

    await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude" },
      echoCompleteOp,
      { text: "hi" },
    );

    const opts = (agentManager.completeAs as ReturnType<typeof mock>).mock.calls[0]?.[2] as
      | { callId?: string }
      | undefined;
    expect(typeof opts?.callId).toBe("string");
    expect(opts?.callId?.length).toBeGreaterThan(0);
  });

  test("uses caller-supplied ctx.callId and never overwrites it (AC7)", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => okCompleteResult,
    });
    runtime = makeTestRuntime({ agentManager });

    const pinnedCallId = "pinned-id-123";
    await callOp(
      {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        callId: pinnedCallId,
      },
      echoCompleteOp,
      { text: "hi" },
    );

    const opts = (agentManager.completeAs as ReturnType<typeof mock>).mock.calls[0]?.[2] as
      | { callId?: string }
      | undefined;
    expect(opts?.callId).toBe(pinnedCallId);
  });

  test("forwards ctx.scopeId to completeOptions (AC8)", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => okCompleteResult,
    });
    const costAggregator = createNoOpCostAggregator();
    costAggregator.openScope = mockFn(() => {
      throw new Error("caller-owned scope must not be replaced");
    });
    runtime = makeTestRuntime({ agentManager, costAggregator });

    await callOp(
      {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        scopeId: "review-round-1",
      },
      echoCompleteOp,
      { text: "hi" },
    );

    const opts = (agentManager.completeAs as ReturnType<typeof mock>).mock.calls[0]?.[2] as
      | { scopeId?: string }
      | undefined;
    expect(opts?.scopeId).toBe("review-round-1");
    expect(costAggregator.openScope).not.toHaveBeenCalled();
  });

  test("two calls without ctx.callId get distinct callIds", async () => {
    const callIds: string[] = [];
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => okCompleteResult,
    });
    runtime = makeTestRuntime({ agentManager });

    await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude" },
      echoCompleteOp,
      { text: "a" },
    );
    await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude" },
      echoCompleteOp,
      { text: "b" },
    );

    const calls = (agentManager.completeAs as ReturnType<typeof mock>).mock.calls;
    for (const call of calls) {
      const id = (call[2] as { callId?: string })?.callId;
      if (id) callIds.push(id);
    }
    expect(callIds).toHaveLength(2);
    expect(callIds[0]).not.toBe(callIds[1]);
  });
});

// ─── callOp kind:run — callId/scopeId forwarding (ACs 7, 9) ────────────────

describe("callOp kind:run — callId/scopeId forwarding (ACs 7, 9)", () => {
  test("opens and closes a scope when the caller supplies none", async () => {
    let observedScopeId: string | undefined;
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        observedScopeId = req.runOptions.scopeId;
        return {
          result: {
            success: true,
            exitCode: 0,
            output: "ran",
            rateLimited: false,
            durationMs: 1,
            estimatedCostUsd: 0,
            agentFallbacks: [],
          },
          fallbacks: [],
        };
      },
    });
    const close = mockFn(() => {});
    const costAggregator = createNoOpCostAggregator();
    costAggregator.openScope = mockFn(() => ({
      scopeId: "call-op-run-scope",
      snapshot: () => costAggregator.snapshot(),
      close,
    }));
    runtime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager(), costAggregator });

    await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude" },
      echoRunOp,
      { text: "hi" },
    );

    expect(observedScopeId).toBe("call-op-run-scope");
    expect(costAggregator.openScope).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("stamps a fresh callId in runOptions when ctx.callId is absent (AC7, AC9)", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: {
          success: true,
          exitCode: 0,
          output: "ran",
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

    await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude" },
      echoRunOp,
      { text: "hi" },
    );

    const req = (agentManager.runWithFallback as ReturnType<typeof mock>).mock.calls[0]?.[0] as
      | { runOptions?: { callId?: string } }
      | undefined;
    expect(typeof req?.runOptions?.callId).toBe("string");
    expect(req?.runOptions?.callId?.length).toBeGreaterThan(0);
  });

  test("uses caller-supplied ctx.callId in runOptions and never overwrites it (AC7)", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: {
          success: true,
          exitCode: 0,
          output: "ran",
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

    const pinnedCallId = "run-pinned-42";
    await callOp(
      {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        callId: pinnedCallId,
      },
      echoRunOp,
      { text: "hi" },
    );

    const req = (agentManager.runWithFallback as ReturnType<typeof mock>).mock.calls[0]?.[0] as
      | { runOptions?: { callId?: string } }
      | undefined;
    expect(req?.runOptions?.callId).toBe(pinnedCallId);
  });

  test("forwards ctx.scopeId to runOptions (AC9)", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: {
          success: true,
          exitCode: 0,
          output: "ran",
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

    await callOp(
      {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        scopeId: "phase-2-region",
      },
      echoRunOp,
      { text: "hi" },
    );

    const req = (agentManager.runWithFallback as ReturnType<typeof mock>).mock.calls[0]?.[0] as
      | { runOptions?: { scopeId?: string } }
      | undefined;
    expect(req?.runOptions?.scopeId).toBe("phase-2-region");
  });
});

// ---------------------------------------------------------------------------
// AC7 — exhaustion boundary (from call-exhaustion.test.ts)
// ---------------------------------------------------------------------------

const exhaustionSel = pickSelector("call-exhaustion-test", "routing");

function makeRunOp(name: string): RunOperation<string, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
  return {
    kind: "run",
    name,
    stage: "run",
    config: exhaustionSel,
    session: { role: "implementer", lifetime: "fresh" },
    build: (input) => ({
      role: { id: "role", content: "Echo the input.", overridable: false },
      task: { id: "task", content: input, overridable: false },
    }),
    parse: (output) => output.trim(),
  };
}

function makeCompleteOp(name: string): CompleteOperation<string, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
  return {
    kind: "complete",
    name,
    stage: "run",
    config: exhaustionSel,
    build: (input) => ({
      role: { id: "role", content: "Echo the input.", overridable: false },
      task: { id: "task", content: input, overridable: false },
    }),
    parse: (output) => output.trim(),
  };
}

const createdRuntimes: NaxRuntime[] = [];
const originalSleep = _agentManagerDeps.sleep;
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
  _agentManagerDeps.sleep = originalSleep;
});

function captureSleeps(): number[] {
  const slept: number[] = [];
  _agentManagerDeps.sleep = async (ms: number) => {
    slept.push(ms);
  };
  return slept;
}

describe("AC7: run-kind — all retries exhaust → CALL_OP_NO_OUTPUT", () => {
  test("maxRetryAttempts=0, no fallback, empty output → throws CALL_OP_NO_OUTPUT", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const { executeHop } = req;
        assertDefined(executeHop, "req.executeHop");
        const hop = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hop.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async (): Promise<TurnResult> => ({
        output: "",
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      }),
    });

    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    let thrown: unknown;
    try {
      await callOp(
        { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "us-001" },
        makeRunOp("run-exhaustion-no-retry"),
        "hello",
      );
    } catch (err) {
      thrown = err;
    }

    assertNaxError(thrown, "callOp rejection");
    expect(thrown.code).toBe("CALL_OP_NO_OUTPUT");
  });

  test("multiple retries all return empty → throws CALL_OP_NO_OUTPUT (not CALL_OP_PARSE_FAILED)", async () => {
    let hopCount = 0;
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const { executeHop } = req;
        assertDefined(executeHop, "req.executeHop");
        let lastHop = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        hopCount++;
        for (let attempt = 1; attempt <= 2; attempt++) {
          if (lastHop.result.adapterFailure?.outcome !== "fail-stale") break;
          lastHop = await executeHop("claude", undefined, { kind: "stale-retry", attempt }, req.runOptions);
          hopCount++;
        }
        return { result: { ...lastHop.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async (): Promise<TurnResult> => ({
        output: "",
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      }),
    });

    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    let thrown: unknown;
    try {
      await callOp(
        { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "us-002" },
        makeRunOp("run-exhaustion-after-retries"),
        "hello",
      );
    } catch (err) {
      thrown = err;
    }

    assertNaxError(thrown, "callOp rejection");
    expect(thrown.code).toBe("CALL_OP_NO_OUTPUT");
    expect(thrown.code).not.toBe("CALL_OP_PARSE_FAILED");
    expect(hopCount).toBe(3);
  });
});

describe("AC7: complete-kind — all retries exhaust → parse receives empty string", () => {
  test("maxRetryAttempts=0, no fallback, empty output → callOp returns empty string (parse succeeds)", async () => {
    const slept = captureSleeps();
    const config = makeNaxConfig({
      agent: {
        idleWatchdog: { maxRetryAttempts: 0, enabled: true, idleTimeoutSeconds: 900 },
        fallback: { enabled: false, map: {}, maxHopsPerStory: 0, onQualityFailure: false, rebuildContext: false },
      },
    });
    const rt = makeTestRuntime({ config });
    createdRuntimes.push(rt);

    let callCount = 0;
    const adapter = {
      complete: async () => {
        callCount++;
        return {
          output: "",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
        };
      },
    };
    agentManagerInternals(rt.agentManager)._resolveRegistry = () => ({ getAgent: () => adapter });

    const result = await callOp(
      { runtime: rt, packageView: rt.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "us-003" },
      makeCompleteOp("complete-exhaustion-no-retry"),
      "hello",
    );

    expect(result).toBe("");
    expect(callCount).toBe(4);
    expect(slept).toEqual([2000, 4000, 8000]);
  });

  test("complete-kind exhaustion error code is NOT CALL_OP_PARSE_FAILED when parse rejects empty", async () => {
    captureSleeps();
    const config = makeNaxConfig({
      agent: {
        idleWatchdog: { maxRetryAttempts: 0, enabled: true, idleTimeoutSeconds: 900 },
        fallback: { enabled: false, map: {}, maxHopsPerStory: 0, onQualityFailure: false, rebuildContext: false },
      },
    });
    const rt = makeTestRuntime({ config });
    createdRuntimes.push(rt);

    const adapter = {
      complete: async () => ({
        output: "",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
      }),
    };
    agentManagerInternals(rt.agentManager)._resolveRegistry = () => ({ getAgent: () => adapter });

    const rejectEmptyOp: CompleteOperation<string, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
      kind: "complete",
      name: "reject-empty-parse",
      stage: "run",
      config: exhaustionSel,
      build: (input) => ({
        role: { id: "role", content: "Echo the input.", overridable: false },
        task: { id: "task", content: input, overridable: false },
      }),
      parse: (output) => {
        if (!output.trim()) throw new Error("parse-rejected-empty");
        return output.trim();
      },
    };

    let thrown: unknown;
    try {
      await callOp(
        { runtime: rt, packageView: rt.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "us-004" },
        rejectEmptyOp,
        "hello",
      );
    } catch (err) {
      thrown = err;
    }

    assertCaughtInstanceOf(thrown, Error, "callOp rejection");
    expect(thrown.message).toContain("parse-rejected-empty");
    expect(thrown).not.toBeInstanceOf(NaxError);
  });
});

describe("AC7: error code is CALL_OP_NO_OUTPUT specifically (run-kind)", () => {
  test("run-kind empty output throws with code CALL_OP_NO_OUTPUT", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const { executeHop } = req;
        assertDefined(executeHop, "req.executeHop");
        const hop = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hop.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async (): Promise<TurnResult> => ({
        output: "",
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      }),
    });

    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    let thrown: unknown;
    try {
      await callOp(
        { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "us-005" },
        makeRunOp("error-code-check"),
        "hello",
      );
    } catch (err) {
      thrown = err;
    }

    assertNaxError(thrown, "callOp rejection");
    expect(thrown.code).toBe("CALL_OP_NO_OUTPUT");
    expect(thrown.code).not.toBe("CALL_OP_PARSE_FAILED");
    expect(thrown?.code).not.toBe("CALL_OP_MAX_RETRIES");
    expect(thrown?.code).not.toBe("CALL_OP_ABORTED");
  });
});
