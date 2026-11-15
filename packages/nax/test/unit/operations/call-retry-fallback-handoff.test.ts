/**
 * US-013: the opt-in last-parseable dispatch handoff.
 *
 * Under `preferRetryFallbackOnNullParse`, a null `op.parse` result is replaced by the strategy's
 * recorded `retryFallback` when that fallback is a plain record — before `runPostParse`, so `verify`
 * observes it and the existing conditional `recover` still applies. A present non-record fallback
 * raises `CALL_OP_INVALID_FALLBACK` before either hook runs; a null/absent fallback keeps the null
 * result. Operations without the flag keep today's precedence on the throwing path.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { assertDefined, makeMockAgentManager, makeMockRuntime, makeSessionManager } from "@test/helpers";
import type { RetryStrategy } from "@/agents/retry";
import { ParseValidationError } from "@/agents/retry";
import { pickSelector } from "@/config";
import { NaxError } from "@/errors";
import { callOp, type RunOperation, type VerifyContext } from "@/operations";
import type { NaxRuntime } from "@/runtime";

const testSel = pickSelector("call-retry-fallback-handoff-test", "routing");
type TestConfig = ReturnType<typeof testSel.select>;
type Verdict = Record<string, unknown> | null;

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

/** The reply every dispatch in this file receives: non-empty, so the parse ladder (not the empty path) runs. */
const MALFORMED_REPLY = "I could not produce a verdict.";

function runtimeAnswering(reply = MALFORMED_REPLY): NaxRuntime {
  const agentManager = makeMockAgentManager({
    runWithFallbackFn: async (req) => {
      const { executeHop } = req;
      assertDefined(executeHop, "req.executeHop");
      const hop = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
      return { result: { ...hop.result, agentFallbacks: [] }, fallbacks: [] };
    },
    runAsSessionFn: async () => ({
      output: reply,
      estimatedCostUsd: 0.25,
      internalRoundTrips: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
    }),
  });
  const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
  createdRuntimes.push(runtime);
  return runtime;
}

function callCtxFor(runtime: NaxRuntime) {
  return { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-013" };
}

/** A strategy that exhausts on the first probe with the given fallback (one turn, one decision). */
function exhaustWith(fallback: unknown): RetryStrategy {
  return { shouldRetry: () => ({ retry: false, fallback }) };
}

interface OpDoubleOpts {
  readonly name: string;
  /** The value the recording strategy hands back as `retryFallback`. */
  readonly fallback: unknown;
  /** Set the opt-in flag on the operation double. */
  readonly preferRetryFallbackOnNullParse?: true;
  /** When true, `op.parse` throws instead of returning null. */
  readonly parseThrows?: boolean;
  readonly verify?: (parsed: Verdict, input: string, ctx: VerifyContext<TestConfig>) => Promise<Verdict>;
  readonly recover?: (input: string, ctx: VerifyContext<TestConfig>) => Promise<Verdict>;
}

/** A run op whose `parse` returns null for the malformed reply, with optional hooks. */
function handoffOp(opts: OpDoubleOpts): RunOperation<string, Verdict, TestConfig> {
  return {
    kind: "run",
    name: opts.name,
    stage: "run",
    config: testSel,
    session: { role: "implementer", lifetime: "fresh" },
    ...(opts.preferRetryFallbackOnNullParse === true ? { preferRetryFallbackOnNullParse: true as const } : {}),
    build: (input) => ({
      role: { id: "role", content: "You answer.", overridable: false },
      task: { id: "task", content: input, overridable: false },
    }),
    retry: () => exhaustWith(opts.fallback),
    parse: () => {
      if (opts.parseThrows === true) throw new ParseValidationError(`[${opts.name}] malformed reply`);
      return null;
    },
    ...(opts.verify ? { verify: opts.verify } : {}),
    ...(opts.recover ? { recover: opts.recover } : {}),
  };
}

interface HookLog {
  readonly verifyCalls: Verdict[];
  recoverCalls: number;
}

/** A verify that records what it observed and returns it unchanged. */
function recordingVerify(log: HookLog) {
  return async (parsed: Verdict): Promise<Verdict> => {
    log.verifyCalls.push(parsed);
    return parsed;
  };
}

/** The fallback every accepted-fallback case records: a plain object with real review evidence. */
function inconsistentVerdict(): Record<string, unknown> {
  return { spec: "fail", quality: "approved", findings: [{ id: "B1" }], inspectedFiles: ["src/a.ts"] };
}

describe("callOp opt-in retry-fallback handoff — AC-1: the plain-record fallback becomes the parse result", () => {
  test("returns the strategy's plain-record fallback when op.parse returns null", async () => {
    const fallback = inconsistentVerdict();
    const runtime = runtimeAnswering();

    const result = await callOp(
      callCtxFor(runtime),
      handoffOp({ name: "handoff-ac1", fallback, preferRetryFallbackOnNullParse: true }),
      "review",
    );

    expect(result).toEqual(fallback);
  });
});

describe("callOp opt-in retry-fallback handoff — AC-2: verify observes the fallback object", () => {
  test("hands the substituted fallback to a declared verify as the parsed value", async () => {
    const fallback = inconsistentVerdict();
    const log: HookLog = { verifyCalls: [], recoverCalls: 0 };
    const runtime = runtimeAnswering();

    const result = await callOp(
      callCtxFor(runtime),
      handoffOp({
        name: "handoff-ac2",
        fallback,
        preferRetryFallbackOnNullParse: true,
        verify: recordingVerify(log),
      }),
      "review",
    );

    expect(log.verifyCalls).toHaveLength(1);
    expect(log.verifyCalls[0]).toBe(fallback);
    expect(result).toEqual(fallback);
  });
});

describe("callOp opt-in retry-fallback handoff — AC-3: recover runs only when verify returns null", () => {
  test("skips recover when verify keeps the substituted fallback", async () => {
    const log: HookLog = { verifyCalls: [], recoverCalls: 0 };
    const runtime = runtimeAnswering();

    const result = await callOp(
      callCtxFor(runtime),
      handoffOp({
        name: "handoff-ac3-verified",
        fallback: inconsistentVerdict(),
        preferRetryFallbackOnNullParse: true,
        verify: recordingVerify(log),
        recover: async () => {
          log.recoverCalls += 1;
          return { recovered: true };
        },
      }),
      "review",
    );

    expect(log.recoverCalls).toBe(0);
    expect(result).toEqual(inconsistentVerdict());
  });

  test("runs recover when verify rejects the substituted fallback", async () => {
    const log: HookLog = { verifyCalls: [], recoverCalls: 0 };
    const runtime = runtimeAnswering();

    const result = await callOp(
      callCtxFor(runtime),
      handoffOp({
        name: "handoff-ac3-recovered",
        fallback: inconsistentVerdict(),
        preferRetryFallbackOnNullParse: true,
        verify: async (parsed) => {
          log.verifyCalls.push(parsed);
          return null;
        },
        recover: async () => {
          log.recoverCalls += 1;
          return { recovered: true };
        },
      }),
      "review",
    );

    expect(log.verifyCalls).toHaveLength(1);
    expect(log.recoverCalls).toBe(1);
    expect(result).toEqual({ recovered: true });
  });
});

describe("callOp opt-in retry-fallback handoff — AC-4: a null-prototype record is substituted", () => {
  test("returns a fallback whose prototype is null as the parse result", async () => {
    const nullProto: Record<string, unknown> = Object.create(null);
    Object.assign(nullProto, { spec: "fail", quality: "approved" });
    const runtime = runtimeAnswering();

    const result = await callOp(
      callCtxFor(runtime),
      handoffOp({ name: "handoff-ac4", fallback: nullProto, preferRetryFallbackOnNullParse: true }),
      "review",
    );

    expect(result).toBe(nullProto);
    expect(result?.spec).toBe("fail");
  });
});

describe("callOp opt-in retry-fallback handoff — AC-5: an array fallback is rejected", () => {
  test("raises CALL_OP_INVALID_FALLBACK naming the array", async () => {
    const runtime = runtimeAnswering();

    const thrown = await captureError(
      callOp(
        callCtxFor(runtime),
        handoffOp({ name: "handoff-ac5", fallback: ["a", "b"], preferRetryFallbackOnNullParse: true }),
        "review",
      ),
    );

    expect(thrown.code).toBe("CALL_OP_INVALID_FALLBACK");
    expect(thrown.message).toContain("array");
  });
});

/** `rejects` cannot read the NaxError `code`, so this captures the thrown error instead. */
async function captureError(run: Promise<unknown>): Promise<NaxError> {
  try {
    await run;
  } catch (err) {
    if (err instanceof NaxError) return err;
    throw err;
  }
  throw new Error("expected the dispatch to reject");
}

describe("callOp opt-in retry-fallback handoff — AC-6: a rejected array runs no post-parse hook", () => {
  test("calls neither verify nor recover when the array fallback is rejected", async () => {
    const log: HookLog = { verifyCalls: [], recoverCalls: 0 };
    const runtime = runtimeAnswering();

    const thrown = await captureError(
      callOp(
        callCtxFor(runtime),
        handoffOp({
          name: "handoff-ac6",
          fallback: ["a"],
          preferRetryFallbackOnNullParse: true,
          verify: recordingVerify(log),
          recover: async () => {
            log.recoverCalls += 1;
            return { recovered: true };
          },
        }),
        "review",
      ),
    );

    expect(thrown.code).toBe("CALL_OP_INVALID_FALLBACK");
    expect(log.verifyCalls).toHaveLength(0);
    expect(log.recoverCalls).toBe(0);
  });
});

describe("callOp opt-in retry-fallback handoff — AC-7: a class instance is rejected and substitutes nothing", () => {
  test("raises CALL_OP_INVALID_FALLBACK and runs no post-parse hook for a class instance", async () => {
    class BranchVerdict {
      readonly spec = "fail";
    }
    const log: HookLog = { verifyCalls: [], recoverCalls: 0 };
    const runtime = runtimeAnswering();

    const thrown = await captureError(
      callOp(
        callCtxFor(runtime),
        handoffOp({
          name: "handoff-ac7",
          fallback: new BranchVerdict(),
          preferRetryFallbackOnNullParse: true,
          verify: recordingVerify(log),
          recover: async () => {
            log.recoverCalls += 1;
            return { recovered: true };
          },
        }),
        "review",
      ),
    );

    expect(thrown.code).toBe("CALL_OP_INVALID_FALLBACK");
    expect(thrown.message).toContain("BranchVerdict");
    expect(log.verifyCalls).toHaveLength(0);
    expect(log.recoverCalls).toBe(0);
  });
});

describe("callOp opt-in retry-fallback handoff — AC-8: a null or absent fallback keeps the null result", () => {
  test("returns null when the strategy records a null fallback", async () => {
    const runtime = runtimeAnswering();

    const result = await callOp(
      callCtxFor(runtime),
      handoffOp({ name: "handoff-ac8-null", fallback: null, preferRetryFallbackOnNullParse: true }),
      "review",
    );

    expect(result).toBeNull();
  });

  test("returns null when the strategy records no fallback at all", async () => {
    const runtime = runtimeAnswering();

    const result = await callOp(
      callCtxFor(runtime),
      handoffOp({ name: "handoff-ac8-absent", fallback: undefined, preferRetryFallbackOnNullParse: true }),
      "review",
    );

    expect(result).toBeNull();
  });
});

describe("callOp without the flag — AC-14: the throwing path keeps today's precedence", () => {
  test("returns an array fallback spread through the existing throwing-path check", async () => {
    const runtime = runtimeAnswering();

    const result = await callOp(
      callCtxFor(runtime),
      handoffOp({ name: "handoff-ac14", fallback: ["a", "b"], parseThrows: true }),
      "review",
    );

    expect(result).toEqual({ 0: "a", 1: "b", estimatedCostUsd: 0.25 });
  });
});
