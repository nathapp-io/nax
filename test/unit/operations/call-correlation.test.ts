/**
 * Tests for callId/scopeId correlation stamping in callOp (ACs 7-10).
 * Covers: newCorrelationId() format/uniqueness, callId stamping in
 * completeOptions and runOptions, caller-supplied callId preservation.
 */

import type { mock } from "bun:test";
import { afterEach, describe, expect, test } from "bun:test";
import { makeMockAgentManager, makeSessionManager, makeTestRuntime } from "@test/helpers";
import type { CompleteResult } from "@/agents/types";
import type { DEFAULT_CONFIG } from "@/config";
import { pickSelector } from "@/config";
import type { CompleteOperation, RunOperation } from "@/operations";
import { callOp, newCorrelationId } from "@/operations";
import type { NaxRuntime } from "@/runtime";

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
    runtime = makeTestRuntime({ agentManager });

    await callOp(
      {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        scopeId: "debate-round-1",
      },
      echoCompleteOp,
      { text: "hi" },
    );

    const opts = (agentManager.completeAs as ReturnType<typeof mock>).mock.calls[0]?.[2] as
      | { scopeId?: string }
      | undefined;
    expect(opts?.scopeId).toBe("debate-round-1");
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
