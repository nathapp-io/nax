import { afterEach, describe, expect, test } from "bun:test";
import { callOp } from "../../../src/operations";
import type { RunOperation } from "../../../src/operations";
import { DEFAULT_CONFIG, pickSelector } from "../../../src/config";
import { ParseValidationError } from "../../../src/agents/retry";
import type { RetryStrategy } from "../../../src/agents/retry";
import { makeMockAgentManager, makeMockRuntime, makeSessionManager } from "../../helpers";
import type { NaxRuntime } from "../../../src/runtime";

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
      const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
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
 * parse() throws on empty output to ensure the empty-output branch in callOp fires.
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
    parse: (output) => {
      // Throw on empty output so callOp's !rawOutput branch fires after sendWithParseRetry.
      if (!output.trim()) throw new ParseValidationError(`[${name}] empty output`);
      return output as unknown as O;
    },
  };
}

/** Creates a RunOp with no retry strategy (retryFallback stays undefined). */
function makeOpNoRetry(
  name: string,
  recoverFn?: (input: string) => Promise<unknown> | null,
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

    const op = makeOpWithFallback<{ passed: boolean; findings: unknown[]; failOpen: boolean }>(
      "fallback-cost-op",
      { passed: true, findings: [], failOpen: true },
    );

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
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
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
