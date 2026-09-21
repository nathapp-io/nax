import { afterEach, describe, expect, test } from "bun:test";
import { assertDefined, makeMockAgentManager, makeMockRuntime, makeSessionManager } from "@test/helpers";
import { ladderSlotKey } from "@/agents/ladder-slot";
import type { AgentFallbackRecord } from "@/agents/manager-types";
import type { RetryStrategy } from "@/agents/retry";
import { makeParseRetryStrategy, ParseValidationError } from "@/agents/retry";
import { type DEFAULT_CONFIG, pickSelector } from "@/config";
import type { RunOperation } from "@/operations";
import { callOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const testSel = pickSelector("exhausted-fallback-test", "routing");
const createdRuntimes: NaxRuntime[] = [];

afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

/** Creates an agent manager that returns empty output from runAsSession. */
function makeEmptyOutputAgentManager(costUsd = 0) {
  return makeMockAgentManager({
    runWithFallbackFn: async (req) => {
      const { executeHop } = req;
      assertDefined(executeHop, "req.executeHop");
      const hopResult = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
      return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
    },
    runAsSessionFn: async () => ({
      output: "",
      estimatedCostUsd: costUsd,
      internalRoundTrips: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
    }),
  });
}

/** Creates a callOp context using the provided runtime. */
function makeCallCtx(runtime: NaxRuntime) {
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp",
    agentName: "claude",
    storyId: "US-001",
  };
}

/**
 * Creates a custom RetryStrategy that always exhausts immediately with the given fallback value.
 * This bypasses makeParseRetryStrategy's early return on empty lastOutput so we can test
 * callOp's empty-output path with retryFallback set.
 */
function makeAlwaysExhaustStrategy(fallback: unknown): RetryStrategy {
  return {
    shouldRetry(_failure, _attempt, _ctx) {
      // Immediately exhaust and provide fallback, regardless of output content.
      return { retry: false, fallback };
    },
  };
}

/**
 * Creates a RunOp where op.retry always exhausts with the given fallback value.
 * parse() throws on any output — every test using this fixture drives the
 * empty-output branch in callOp, so the parse never has to succeed.
 */
function makeOpWithFallback<O>(
  name: string,
  fallback: unknown,
): RunOperation<string, O, Pick<typeof DEFAULT_CONFIG, "routing">> {
  return {
    kind: "run",
    name,
    stage: "run",
    config: testSel,
    session: { role: "implementer", lifetime: "fresh" },
    build: (input) => ({
      role: { id: "role", content: "You process input.", overridable: false },
      task: { id: "task", content: input, overridable: false },
    }),
    retry: () => makeAlwaysExhaustStrategy(fallback),
    parse: () => {
      // The agents in these tests always return empty output, so callOp's
      // !rawOutput branch fires and this parse never runs.
      throw new ParseValidationError(`[${name}] empty output`);
    },
  };
}

/** Creates a RunOp with no retry strategy (retryFallback stays undefined). */
function makeOpNoRetry(
  name: string,
  recoverFn?: (input: string) => Promise<Record<string, unknown> | null>,
): RunOperation<string, Record<string, unknown>, Pick<typeof DEFAULT_CONFIG, "routing">> {
  return {
    kind: "run",
    name,
    stage: "run",
    config: testSel,
    session: { role: "implementer", lifetime: "fresh" },
    build: (input) => ({
      role: { id: "role", content: "You process input.", overridable: false },
      task: { id: "task", content: input, overridable: false },
    }),
    parse: (output) => {
      if (!output.trim()) throw new ParseValidationError(`[${name}] empty output`);
      return { result: output } as Record<string, unknown>;
    },
    ...(recoverFn
      ? { recover: async (input: string) => (await recoverFn(input)) as Record<string, unknown> | null }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// AC1: exhaustedFallback returns FAIL_OPEN merged with estimatedCostUsd
// ---------------------------------------------------------------------------

describe("callOp empty-output + exhaustedFallback — AC1: fallback returned with cost", () => {
  test("returns exhaustedFallback value merged with estimatedCostUsd when output is empty", async () => {
    const agentManager = makeEmptyOutputAgentManager(0.05);
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    const op = makeOpWithFallback<{
      passed: boolean;
      findings: unknown[];
      failOpen: boolean;
      estimatedCostUsd?: number;
    }>("fallback-cost-op", { passed: true, findings: [], failOpen: true });

    const result = await callOp(makeCallCtx(runtime), op, "hello");

    expect(result.passed).toBe(true);
    expect(result.failOpen).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.estimatedCostUsd).toBe(0.05);
  });
});

// ---------------------------------------------------------------------------
// AC2: no exhaustedFallback → throws CALL_OP_NO_OUTPUT
// ---------------------------------------------------------------------------

describe("callOp empty-output + no exhaustedFallback — AC2: throws CALL_OP_NO_OUTPUT", () => {
  test("throws CALL_OP_NO_OUTPUT when there is no retry strategy and output is empty", async () => {
    const agentManager = makeEmptyOutputAgentManager(0);
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    let thrown: { code?: string; message?: string } | null = null;
    try {
      await callOp(makeCallCtx(runtime), makeOpNoRetry("no-retry-op"), "hello");
    } catch (err) {
      thrown = err as { code?: string; message?: string };
    }

    expect(thrown).not.toBeNull();
    expect(thrown?.code).toBe("CALL_OP_NO_OUTPUT");
  });
});

// ---------------------------------------------------------------------------
// AC6a: exhaustedFallback returning null → throws CALL_OP_INVALID_FALLBACK
// ---------------------------------------------------------------------------

describe("callOp empty-output — AC6a: null fallback → CALL_OP_INVALID_FALLBACK", () => {
  test("throws CALL_OP_INVALID_FALLBACK when exhaustedFallback returns null", async () => {
    const agentManager = makeEmptyOutputAgentManager(0);
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    const op = makeOpWithFallback("null-fallback-op", null);

    let thrown: { code?: string } | null = null;
    try {
      await callOp(makeCallCtx(runtime), op, "hello");
    } catch (err) {
      thrown = err as { code?: string };
    }

    expect(thrown).not.toBeNull();
    expect(thrown?.code).toBe("CALL_OP_INVALID_FALLBACK");
  });
});

// ---------------------------------------------------------------------------
// AC6b: exhaustedFallback returning string → throws CALL_OP_INVALID_FALLBACK
// ---------------------------------------------------------------------------

describe("callOp empty-output — AC6b: string fallback → CALL_OP_INVALID_FALLBACK", () => {
  test("throws CALL_OP_INVALID_FALLBACK when exhaustedFallback returns a string", async () => {
    const agentManager = makeEmptyOutputAgentManager(0);
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    const op = makeOpWithFallback("string-fallback-op", "some string");

    let thrown: { code?: string } | null = null;
    try {
      await callOp(makeCallCtx(runtime), op, "hello");
    } catch (err) {
      thrown = err as { code?: string };
    }

    expect(thrown).not.toBeNull();
    expect(thrown?.code).toBe("CALL_OP_INVALID_FALLBACK");
  });
});

// ---------------------------------------------------------------------------
// AC6c/d: boolean and number fallbacks → CALL_OP_INVALID_FALLBACK
// ---------------------------------------------------------------------------

describe("callOp empty-output — AC6c: boolean fallback → CALL_OP_INVALID_FALLBACK", () => {
  test("throws CALL_OP_INVALID_FALLBACK when exhaustedFallback returns true", async () => {
    const agentManager = makeEmptyOutputAgentManager(0);
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    const op = makeOpWithFallback("bool-fallback-op", true);

    let thrown: { code?: string } | null = null;
    try {
      await callOp(makeCallCtx(runtime), op, "hello");
    } catch (err) {
      thrown = err as { code?: string };
    }

    expect(thrown).not.toBeNull();
    expect(thrown?.code).toBe("CALL_OP_INVALID_FALLBACK");
  });
});

describe("callOp empty-output — AC6d: number fallback → CALL_OP_INVALID_FALLBACK", () => {
  test("throws CALL_OP_INVALID_FALLBACK when exhaustedFallback returns a number", async () => {
    const agentManager = makeEmptyOutputAgentManager(0);
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    const op = makeOpWithFallback("number-fallback-op", 42);

    let thrown: { code?: string } | null = null;
    try {
      await callOp(makeCallCtx(runtime), op, "hello");
    } catch (err) {
      thrown = err as { code?: string };
    }

    expect(thrown).not.toBeNull();
    expect(thrown?.code).toBe("CALL_OP_INVALID_FALLBACK");
  });
});

// ---------------------------------------------------------------------------
// AC1 cost-merging: cumulative cost merged onto fallback
// ---------------------------------------------------------------------------

describe("callOp empty-output — AC1 cost-merging: cumulative cost in result", () => {
  test("estimatedCostUsd from runAsSession is merged onto fallback result", async () => {
    const agentManager = makeEmptyOutputAgentManager(0.07);
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    const op = makeOpWithFallback<{ passed: boolean; findings: unknown[]; estimatedCostUsd?: number }>(
      "cost-merge-op",
      { passed: true, findings: [] },
    );

    const result = await callOp(makeCallCtx(runtime), op, "hello");

    expect(result.estimatedCostUsd).toBe(0.07);
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC7a: op.recover returning non-null, no exhaustedFallback → returns recovered value
// ---------------------------------------------------------------------------

describe("callOp empty-output — AC7a: op.recover returns non-null value", () => {
  test("returns recovered value when op.recover returns non-null and no exhaustedFallback", async () => {
    const agentManager = makeEmptyOutputAgentManager(0);
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    const op = makeOpNoRetry("recover-non-null-op", async () => ({ passed: true, recovered: true }));

    const result = await callOp(makeCallCtx(runtime), op, "hello");

    expect(result.recovered).toBe(true);
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC7b: op.recover returning null, no exhaustedFallback → throws CALL_OP_NO_OUTPUT
// ---------------------------------------------------------------------------

describe("callOp empty-output — AC7b: op.recover returns null → CALL_OP_NO_OUTPUT", () => {
  test("throws CALL_OP_NO_OUTPUT when op.recover returns null and no exhaustedFallback", async () => {
    const agentManager = makeEmptyOutputAgentManager(0);
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    const op = makeOpNoRetry("recover-null-op", async () => null);

    let thrown: { code?: string } | null = null;
    try {
      await callOp(makeCallCtx(runtime), op, "hello");
    } catch (err) {
      thrown = err as { code?: string };
    }

    expect(thrown).not.toBeNull();
    expect(thrown?.code).toBe("CALL_OP_NO_OUTPUT");
  });
});

// ---------------------------------------------------------------------------
// AC7 ordering: exhaustedFallback wins over op.recover
// ---------------------------------------------------------------------------

describe("callOp empty-output — AC7 ordering: exhaustedFallback wins over op.recover", () => {
  test("returns exhaustedFallback result when both exhaustedFallback and op.recover are set", async () => {
    const agentManager = makeEmptyOutputAgentManager(0);
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    // Op has both: exhaustedFallback (via retry) and op.recover
    const op: RunOperation<string, Record<string, unknown>, Pick<typeof DEFAULT_CONFIG, "routing">> = {
      kind: "run",
      name: "fallback-beats-recover-op",
      stage: "run",
      config: testSel,
      session: { role: "implementer", lifetime: "fresh" },
      build: (input) => ({
        role: { id: "role", content: "You process input.", overridable: false },
        task: { id: "task", content: input, overridable: false },
      }),
      retry: () => makeAlwaysExhaustStrategy({ fromFallback: true }),
      parse: (output) => {
        if (!output.trim()) throw new ParseValidationError("[ordering-op] empty output");
        return { result: output };
      },
      recover: async () => ({ fromRecover: true }),
    };

    const result = await callOp(makeCallCtx(runtime), op, "hello");

    // exhaustedFallback should win — fromFallback is set, fromRecover is not
    expect(result.fromFallback).toBe(true);
    expect(result.fromRecover).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// No regression: non-empty output flows through op.parse unchanged
// ---------------------------------------------------------------------------

describe("callOp empty-output — no regression: non-empty output uses op.parse", () => {
  test("non-empty output is parsed normally, fallback is NOT used as output", async () => {
    // Even if retryFallback is set (strategy always exhausts), when rawOutput is non-empty
    // the !rawOutput branch does NOT fire — op.parse handles the output instead.
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const { executeHop } = req;
        assertDefined(executeHop, "req.executeHop");
        const hopResult = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => ({
        output: "hello world",
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      }),
    });
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    // Op with makeAlwaysExhaustStrategy (retryFallback is set), but parse succeeds for non-empty output.
    const op: RunOperation<string, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
      kind: "run",
      name: "non-empty-op",
      stage: "run",
      config: testSel,
      session: { role: "implementer", lifetime: "fresh" },
      build: (input) => ({
        role: { id: "role", content: "You echo input.", overridable: false },
        task: { id: "task", content: input, overridable: false },
      }),
      // Always-exhaust strategy sets retryFallback, but rawOutput is non-empty so this branch won't fire.
      retry: () => makeAlwaysExhaustStrategy({ fromFallback: true }),
      parse: (output) => output.trim(),
    };

    const result = await callOp(makeCallCtx(runtime), op, "hello");

    // op.parse ran and returned the trimmed output — the fallback was NOT returned
    expect(result).toBe("hello world");
  });
});

// ---------------------------------------------------------------------------
// BUG-62 regression: a provider-refusal turn (non-empty output, no op.recover,
// strict op.parse that throws on non-JSON) must still return exhaustedFallback,
// not a raw TurnResult — mirrors adversarialReviewOp's shape (strict parser +
// exhaustedFallback + no op.recover).
// ---------------------------------------------------------------------------

describe("callOp — BUG-62: provider-refusal turn with a strict parser returns exhaustedFallback", () => {
  test("returns the exhaustedFallback object, not a raw TurnResult, for a refusal-classified turn", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const { executeHop } = req;
        assertDefined(executeHop, "req.executeHop");
        const hopResult = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => ({
        output: "Selected model is at capacity. Please try a different model.",
        estimatedCostUsd: 0.01,
        internalRoundTrips: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      }),
    });
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    const FAIL_OPEN = { passed: true, findings: [] as unknown[], failOpen: true };
    const op: RunOperation<
      string,
      { passed: boolean; findings: unknown[]; failOpen?: boolean; looksLikeFail?: boolean; estimatedCostUsd?: number },
      Pick<typeof DEFAULT_CONFIG, "routing">
    > = {
      kind: "run",
      name: "strict-review-op",
      stage: "run",
      config: testSel,
      session: { role: "reviewer-semantic", lifetime: "fresh" },
      build: (input) => ({
        role: { id: "role", content: "You review a diff.", overridable: false },
        task: { id: "task", content: input, overridable: false },
      }),
      retry: () =>
        makeParseRetryStrategy({
          validate: (parsed) => parsed !== null && typeof parsed === "object",
          reviewerKind: "strict-review-op",
          prompts: { invalid: () => "reformat as JSON", truncated: () => "truncated — resend" },
          exhaustedFallback: () => FAIL_OPEN,
        }),
      // Strict — mirrors adversarialReviewOp: throws on non-JSON instead of degrading gracefully.
      parse: (output) => {
        return JSON.parse(output);
      },
    };

    const result = await callOp(makeCallCtx(runtime), op, "review this");

    // Must be the declared exhaustedFallback object (a typed O), never the raw
    // TurnResult passthrough — that would silently corrupt every downstream
    // consumer reading `.passed` / `.findings` off a shape that doesn't have them.
    expect(result).toEqual({ ...FAIL_OPEN, estimatedCostUsd: 0.01 });
    expect((result as { output?: unknown }).output).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fallback recording (nax#1707, nax#1964) — hops and sticky targets land on
// the run-scoped store. Absorbed from call-fallback-recording.test.ts.
// ---------------------------------------------------------------------------

const recordingTestSel = pickSelector("fallback-recording-test", "routing");

function recordingHop(overrides: Partial<AgentFallbackRecord> = {}): AgentFallbackRecord {
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

/** A manager whose runWithFallback reports `fallbacks` alongside a successful result. */
function managerReporting(fallbacks: AgentFallbackRecord[]) {
  return makeMockAgentManager({
    runWithFallbackFn: async (req) => {
      const { executeHop } = req;
      assertDefined(executeHop, "req.executeHop");
      const hopResult = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
      return { result: { ...hopResult.result, agentFallbacks: fallbacks }, fallbacks };
    },
    runAsSessionFn: async () => ({
      output: "done",
      estimatedCostUsd: 0,
      internalRoundTrips: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
    }),
  });
}

function makeRecordingOp(name: string): RunOperation<string, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
  return {
    kind: "run",
    name,
    stage: "run",
    config: recordingTestSel,
    session: { role: "implementer", lifetime: "fresh" },
    build: (input) => ({
      role: { id: "role", content: "You process input.", overridable: false },
      task: { id: "task", content: input, overridable: false },
    }),
    parse: (output) => output,
  };
}

function recordingRuntimeWith(fallbacks: AgentFallbackRecord[]): NaxRuntime {
  const runtime = makeMockRuntime({ agentManager: managerReporting(fallbacks) });
  createdRuntimes.push(runtime);
  return runtime;
}

/** A manager whose runWithFallback reports a swap AND the target it swapped to. */
function managerSwappingTo(newAgent: string) {
  const fallbacks = [recordingHop({ newAgent })];
  return makeMockAgentManager({
    runWithFallbackFn: async (req) => {
      const { executeHop } = req;
      assertDefined(executeHop, "req.executeHop");
      const hopResult = await executeHop(newAgent, undefined, { kind: "primary" }, req.runOptions);
      return {
        result: { ...hopResult.result, agentFallbacks: fallbacks },
        fallbacks,
        finalTarget: { agent: newAgent },
        didSwap: true,
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

/** A manager that retried a stale session without selecting a fallback target. */
function managerReportingStaleRetry() {
  const fallbacks = [recordingHop({ priorAgent: "claude", newAgent: "claude", outcome: "fail-stale" })];
  return makeMockAgentManager({
    runWithFallbackFn: async (req) => {
      const { executeHop } = req;
      assertDefined(executeHop, "req.executeHop");
      const hopResult = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
      return {
        result: { ...hopResult.result, agentFallbacks: fallbacks },
        fallbacks,
        finalTarget: { agent: "claude" },
        didSwap: false,
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

function recordingCtxFor(runtime: NaxRuntime, storyId?: string) {
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp",
    agentName: "claude",
    ...(storyId !== undefined ? { storyId } : {}),
  };
}

describe("callOp records agent-swap hops on the run-scoped store (#1707)", () => {
  test("appends the hops runWithFallback reported, keyed by story", async () => {
    const recorded = [recordingHop()];
    const runtime = recordingRuntimeWith(recorded);

    await callOp(recordingCtxFor(runtime, "US-001"), makeRecordingOp("record-one"), "input");

    expect(runtime.agentFallbacks.get("US-001")).toEqual(recorded);
  });

  test("accumulates hops across every op in the same story", async () => {
    const runtime = recordingRuntimeWith([recordingHop({ hop: 1 })]);

    await callOp(recordingCtxFor(runtime, "US-001"), makeRecordingOp("first-op"), "input");
    await callOp(recordingCtxFor(runtime, "US-001"), makeRecordingOp("second-op"), "input");

    expect(runtime.agentFallbacks.get("US-001")).toHaveLength(2);
  });

  test("keeps stories separate", async () => {
    const runtime = recordingRuntimeWith([recordingHop()]);

    await callOp(recordingCtxFor(runtime, "US-001"), makeRecordingOp("op-a"), "input");
    await callOp(recordingCtxFor(runtime, "US-002"), makeRecordingOp("op-b"), "input");

    expect(runtime.agentFallbacks.get("US-001")).toHaveLength(1);
    expect(runtime.agentFallbacks.get("US-002")).toHaveLength(1);
  });

  test("records nothing when the op ran with no swaps", async () => {
    const runtime = recordingRuntimeWith([]);

    await callOp(recordingCtxFor(runtime, "US-001"), makeRecordingOp("no-swap"), "input");

    expect(runtime.agentFallbacks.has("US-001")).toBe(false);
  });

  test("drops hops from an ad-hoc call that carries no storyId", async () => {
    const runtime = recordingRuntimeWith([recordingHop()]);

    await callOp(recordingCtxFor(runtime), makeRecordingOp("no-story"), "input");

    expect(runtime.agentFallbacks.size).toBe(0);
  });
});

describe("callOp records the target a story swapped to (nax#1964)", () => {
  test("records finalTarget on runtime.ladderSlots, keyed by the escalation rung and role", async () => {
    const runtime = makeMockRuntime({ agentManager: managerSwappingTo("codex") });
    createdRuntimes.push(runtime);

    await callOp(recordingCtxFor(runtime, "US-001"), makeRecordingOp("record-target"), "input");

    expect(runtime.ladderSlots.get(ladderSlotKey("US-001", "balanced", "claude", "implementer"))).toEqual({
      target: { agent: "codex" },
      depth: 0,
    });
  });

  test("records nothing when the op ran with no swaps", async () => {
    const runtime = recordingRuntimeWith([]);

    await callOp(recordingCtxFor(runtime, "US-001"), makeRecordingOp("no-swap"), "input");

    expect(runtime.ladderSlots.size).toBe(0);
  });

  test("does not make a stale retry sticky", async () => {
    const runtime = makeMockRuntime({ agentManager: managerReportingStaleRetry() });
    createdRuntimes.push(runtime);

    await callOp(recordingCtxFor(runtime, "US-001"), makeRecordingOp("stale-retry"), "input");

    expect(runtime.agentFallbacks.get("US-001")).toHaveLength(1);
    expect(runtime.ladderSlots.size).toBe(0);
  });
});
