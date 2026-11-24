/**
 * callOp's complete-kind run-cancellation handling (US-003).
 *
 * The resolved run signal reaches `completeAsWithFallback`, an already-aborted
 * signal is refused BEFORE dispatch and one that dies during dispatch is
 * refused after it returns, and the resulting CALL_OP_ABORTED never consults
 * the retry policy. The post-dispatch check is the guarantee that an aborted
 * run's result is never parsed.
 *
 * Split out of `call.test.ts`, which is past the 650-line target.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { assertCaughtInstanceOf, makeMockAgentManager, makeMockCallContext, makeTestRuntime } from "@test/helpers";
import type { CompleteOptions, CompleteResult } from "@/agents/types";
import { type DEFAULT_CONFIG, pickSelector } from "@/config";
import { NaxError } from "@/errors";
import { type CompleteOperation, callOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";

const testSel = pickSelector("call-complete-abort-test", "routing");
type Cfg = Pick<typeof DEFAULT_CONFIG, "routing">;

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

const DISPATCHED: CompleteResult = {
  output: "dispatched output",
  tokenUsage: { inputTokens: 0, outputTokens: 0 },
  estimatedCostUsd: 0,
};

/** What `AgentManager.completeAsWithFallback` returns for one completed hop. */
function dispatchedOutcome(output = DISPATCHED.output) {
  return { result: { ...DISPATCHED, output }, fallbacks: [], dispatchesCompleted: 1 };
}

function makeOp(
  overrides: Partial<CompleteOperation<string, string, Cfg>> = {},
): CompleteOperation<string, string, Cfg> {
  return {
    kind: "complete",
    name: "complete-abort-op",
    stage: "run",
    config: testSel,
    build: (input) => ({
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: input, overridable: false },
    }),
    parse: (output) => output.trim(),
    ...overrides,
  };
}

/** Capture the error callOp rejected with, so its code and message can be asserted. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected callOp to reject");
}

describe("callOp — complete-kind, signal does not abort (control)", () => {
  test("US-003 AC-7: returns the op's parsed result", async () => {
    const caller = new AbortController();
    const agentManager = makeMockAgentManager({
      completeAsWithFallbackFn: async () => dispatchedOutcome("  parsed me  "),
    });
    const runtime = makeTestRuntime({ agentManager });
    createdRuntimes.push(runtime);

    const result = await callOp(makeMockCallContext({ runtime, signal: caller.signal }), makeOp(), "hello");

    expect(result).toBe("parsed me");
    // The same fake AC-2 asserts is never called: with a live signal it IS the
    // dispatch, so that zero is a fact about the abort and not an unused mock.
    expect(agentManager.completeAsWithFallback).toHaveBeenCalledTimes(1);
    expect(caller.signal.aborted).toBe(false);
  });
});

describe("callOp — complete-kind, signal already aborted before dispatch", () => {
  test("US-003 AC-1: rejects with CALL_OP_ABORTED naming 'aborted before dispatch'", async () => {
    const agentManager = makeMockAgentManager({ completeAsWithFallbackFn: async () => dispatchedOutcome() });
    const runtime = makeTestRuntime({ agentManager });
    createdRuntimes.push(runtime);

    const thrown = await rejectionOf(
      callOp(makeMockCallContext({ runtime, signal: AbortSignal.abort() }), makeOp(), "hello"),
    );

    assertCaughtInstanceOf(thrown, NaxError, "callOp rejection");
    expect(thrown.code).toBe("CALL_OP_ABORTED");
    expect(thrown.message).toContain("aborted before dispatch");
  });

  test("US-003 AC-2: never calls completeAsWithFallback", async () => {
    const agentManager = makeMockAgentManager({ completeAsWithFallbackFn: async () => dispatchedOutcome() });
    const runtime = makeTestRuntime({ agentManager });
    createdRuntimes.push(runtime);

    // Asserted before the rejection: the call count is the claim under test, so
    // it must be the assertion that fails if the dispatch ever happens.
    let rejected: unknown;
    try {
      await callOp(makeMockCallContext({ runtime, signal: AbortSignal.abort() }), makeOp(), "hello");
    } catch (err) {
      rejected = err;
    }

    expect(agentManager.completeAsWithFallback).toHaveBeenCalledTimes(0);
    expect(rejected).toBeInstanceOf(NaxError);
  });
});

describe("callOp — complete-kind, signal aborted during dispatch", () => {
  /** Dispatch that cancels the run and then answers as if it had completed. */
  function abortingManager(caller: AbortController, output = DISPATCHED.output) {
    return makeMockAgentManager({
      completeAsWithFallbackFn: async () => {
        caller.abort(new Error("run cancelled"));
        return dispatchedOutcome(output);
      },
    });
  }

  test("US-003 AC-3: rejects with CALL_OP_ABORTED naming 'aborted during dispatch'", async () => {
    const caller = new AbortController();
    const runtime = makeTestRuntime({ agentManager: abortingManager(caller) });
    createdRuntimes.push(runtime);

    const thrown = await rejectionOf(
      callOp(makeMockCallContext({ runtime, signal: caller.signal }), makeOp(), "hello"),
    );

    assertCaughtInstanceOf(thrown, NaxError, "callOp rejection");
    expect(thrown.code).toBe("CALL_OP_ABORTED");
    expect(thrown.message).toContain("aborted during dispatch");
  });

  test("US-003 AC-4: never calls the op's parse", async () => {
    const caller = new AbortController();
    const runtime = makeTestRuntime({ agentManager: abortingManager(caller) });
    createdRuntimes.push(runtime);

    const parsed: string[] = [];
    const op = makeOp({
      parse: (output) => {
        parsed.push(output);
        return output.trim();
      },
    });

    await rejectionOf(callOp(makeMockCallContext({ runtime, signal: caller.signal }), op, "hello"));

    expect(parsed).toHaveLength(0);
  });

  test("US-003 AC-5: never consults the retry strategy, even when parse would throw", async () => {
    const caller = new AbortController();
    const runtime = makeTestRuntime({ agentManager: abortingManager(caller) });
    createdRuntimes.push(runtime);

    const retried: number[] = [];
    const op = makeOp({
      parse: () => {
        throw new Error("parse must not run on an aborted dispatch's output");
      },
      retry: {
        shouldRetry: (_failure, attempt) => {
          retried.push(attempt);
          return { retry: true, delayMs: 0 };
        },
      },
    });

    const thrown = await rejectionOf(callOp(makeMockCallContext({ runtime, signal: caller.signal }), op, "hello"));

    assertCaughtInstanceOf(thrown, NaxError, "callOp rejection");
    expect(thrown.code).toBe("CALL_OP_ABORTED");
    expect(retried).toHaveLength(0);
  });
});

describe("callOp — complete-kind carries the run's signal onto completeOptions", () => {
  function capturingManager(seen: { current?: CompleteOptions }) {
    return makeMockAgentManager({
      completeAsWithFallbackFn: async (_agentName, _prompt, opts) => {
        seen.current = opts;
        return dispatchedOutcome();
      },
    });
  }

  test("US-003 AC-6: ctx.signal, when the caller supplied one", async () => {
    const caller = new AbortController();
    const seen: { current?: CompleteOptions } = {};
    const runtime = makeTestRuntime({ agentManager: capturingManager(seen) });
    createdRuntimes.push(runtime);

    await callOp(makeMockCallContext({ runtime, signal: caller.signal }), makeOp(), "hello");

    expect(seen.current?.signal).toBe(caller.signal);
  });

  test("US-003 AC-6: ctx.runtime.signal when ctx.signal is unset", async () => {
    const parent = new AbortController();
    const seen: { current?: CompleteOptions } = {};
    const runtime = makeTestRuntime({ agentManager: capturingManager(seen), parentSignal: parent.signal });
    createdRuntimes.push(runtime);

    await callOp(makeMockCallContext({ runtime }), makeOp(), "hello");

    // Not the parent: the run owns its own controller and derives its signal
    // from the parent's, so the child is the one the request must observe.
    expect(seen.current?.signal).toBe(runtime.signal);
    parent.abort(new Error("run cancelled"));
    expect(seen.current?.signal?.aborted).toBe(true);
  });
});
