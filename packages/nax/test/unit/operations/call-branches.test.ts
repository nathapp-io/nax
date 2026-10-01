/**
 * Characterisation tests for callOpDispatch branches nothing else pins.
 *
 * Written before the A6 cognitive-complexity drain (docs/plans/STATUS-complexity-drain.md)
 * so the refactor moves behaviour that is already pinned: the complete-kind retry
 * abort checks (before/during sleep), the complete-kind MAX_COMPLETE_RETRY_ATTEMPTS
 * exhaustion throw, the sessionName computation forwarded onto completeOptions,
 * the ctx.storyScratchDirs forwarding into the hop context, and the bare
 * parse-rethrow when no retry strategy is engaged. All green against the
 * unrefactored dispatch.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  assertCaughtInstanceOf,
  assertDefined,
  makeMockAgentManager,
  makeMockCallContext,
  makeSessionManager,
  makeTestRuntime,
} from "@test/helpers";
import { computeAcpHandle } from "@/agents";
import type { CompleteOptions } from "@/agents/types";
import { type DEFAULT_CONFIG, pickSelector } from "@/config";
import { NaxError } from "@/errors";
import type { BuildHopCallbackContext, CompleteOperation, RunOperation } from "@/operations";
import { _callOpDeps, callOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";

const testSel = pickSelector("call-branch-test", "routing");
type Cfg = Pick<typeof DEFAULT_CONFIG, "routing">;

const createdRuntimes: NaxRuntime[] = [];
let origSleep: typeof _callOpDeps.sleep;
let origBuildHopCallback: typeof _callOpDeps.buildHopCallback;
beforeEach(() => {
  origSleep = _callOpDeps.sleep;
  origBuildHopCallback = _callOpDeps.buildHopCallback;
});
afterEach(async () => {
  _callOpDeps.sleep = origSleep;
  _callOpDeps.buildHopCallback = origBuildHopCallback;
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

const alwaysRetryCompleteOp: CompleteOperation<string, string, Cfg> = {
  kind: "complete",
  name: "complete-retry-branch-op",
  stage: "run",
  config: testSel,
  build: (input) => ({
    role: { id: "role", content: "", overridable: false },
    task: { id: "task", content: input, overridable: false },
  }),
  parse: (output) => output,
  retry: {
    shouldRetry: (_failure, attempt) => (attempt < 5 ? { retry: true, delayMs: 100 } : { retry: false }),
  },
};

describe("callOpDispatch — complete-kind retry abort checks", () => {
  test("throws CALL_OP_ABORTED (before retry) when the signal is already aborted at the retry decision", async () => {
    let callCount = 0;
    const agentManager = makeMockAgentManager({
      completeAsWithFallbackFn: async () => {
        callCount++;
        throw new Error("transient");
      },
    });
    const runtime = makeTestRuntime({ agentManager });
    createdRuntimes.push(runtime);
    _callOpDeps.sleep = async () => {
      throw new Error("sleep must not run when the abort fires before it");
    };

    let thrown: unknown;
    try {
      await callOp(
        {
          runtime,
          packageView: runtime.packages.repo(),
          packageDir: "/tmp",
          agentName: "claude",
          storyId: "US-001",
          signal: AbortSignal.abort(),
        },
        alwaysRetryCompleteOp,
        "hello",
      );
    } catch (err) {
      thrown = err;
    }

    assertCaughtInstanceOf(thrown, NaxError, "callOp rejection");
    expect(thrown.code).toBe("CALL_OP_ABORTED");
    expect(thrown.message).toContain("aborted before retry");
    expect(callCount).toBe(1);
  });

  test("throws CALL_OP_ABORTED (during retry sleep) when the signal aborts inside the sleep", async () => {
    let callCount = 0;
    const agentManager = makeMockAgentManager({
      completeAsWithFallbackFn: async () => {
        callCount++;
        throw new Error("transient");
      },
    });
    const runtime = makeTestRuntime({ agentManager });
    createdRuntimes.push(runtime);
    const controller = new AbortController();
    _callOpDeps.sleep = async () => {
      controller.abort();
    };

    let thrown: unknown;
    try {
      await callOp(
        {
          runtime,
          packageView: runtime.packages.repo(),
          packageDir: "/tmp",
          agentName: "claude",
          storyId: "US-001",
          signal: controller.signal,
        },
        alwaysRetryCompleteOp,
        "hello",
      );
    } catch (err) {
      thrown = err;
    }

    assertCaughtInstanceOf(thrown, NaxError, "callOp rejection");
    expect(thrown.code).toBe("CALL_OP_ABORTED");
    expect(thrown.message).toContain("aborted during retry sleep");
    expect(callCount).toBe(1);
  });
});

describe("callOpDispatch — complete-kind retry budget exhaustion", () => {
  test("a strategy that always retries runs MAX attempts then throws CALL_OP_MAX_RETRIES", async () => {
    let callCount = 0;
    const agentManager = makeMockAgentManager({
      completeAsWithFallbackFn: async () => {
        callCount++;
        throw new Error("transient");
      },
    });
    const runtime = makeTestRuntime({ agentManager });
    createdRuntimes.push(runtime);
    _callOpDeps.sleep = async () => {};

    let thrown: unknown;
    try {
      await callOp(
        {
          runtime,
          packageView: runtime.packages.repo(),
          packageDir: "/tmp",
          agentName: "claude",
          storyId: "US-001",
        },
        {
          ...alwaysRetryCompleteOp,
          retry: { shouldRetry: () => ({ retry: true, delayMs: 0 }) },
        },
        "hello",
      );
    } catch (err) {
      thrown = err;
    }

    assertCaughtInstanceOf(thrown, NaxError, "callOp rejection");
    expect(thrown.code).toBe("CALL_OP_MAX_RETRIES");
    expect(thrown.message).toContain("exceeded MAX_COMPLETE_RETRY_ATTEMPTS");
    expect(callCount).toBe(21);
  });
});

describe("callOpDispatch — sessionName forwarded onto completeOptions", () => {
  function capturingManager(seenOpts: { current?: CompleteOptions }) {
    return makeMockAgentManager({
      completeAsWithFallbackFn: async (_agentName, _prompt, opts) => {
        seenOpts.current = opts;
        return {
          result: {
            output: "done",
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            estimatedCostUsd: 0,
          },
          fallbacks: [],
          dispatchesCompleted: 1,
        };
      },
    });
  }

  test("computes sessionName from packageDir/featureName/storyId/role when a sessionOverride role is set", async () => {
    const seenOpts: { current?: CompleteOptions } = {};
    const runtime = makeTestRuntime({ agentManager: capturingManager(seenOpts) });
    createdRuntimes.push(runtime);

    const result = await callOp(
      {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp/pkg-under-test",
        agentName: "claude",
        storyId: "US-009",
        featureName: "feat-a",
        sessionOverride: { role: "implementer" },
      },
      alwaysRetryCompleteOp,
      "hello",
    );

    expect(result).toBe("done");
    expect(seenOpts.current?.sessionName).toBe(
      computeAcpHandle("/tmp/pkg-under-test", "feat-a", "US-009", "implementer"),
    );
  });

  test("leaves sessionName unset for a complete-kind op with no sessionOverride role", async () => {
    const seenOpts: { current?: CompleteOptions } = {};
    const runtime = makeTestRuntime({ agentManager: capturingManager(seenOpts) });
    createdRuntimes.push(runtime);

    await callOp(
      {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp/pkg-under-test",
        agentName: "claude",
        storyId: "US-009",
        featureName: "feat-a",
      },
      alwaysRetryCompleteOp,
      "hello",
    );

    expect(seenOpts.current?.sessionName).toBeUndefined();
  });
});

describe("callOpDispatch — storyScratchDirs forwarded into the hop context", () => {
  test("forwards ctx.storyScratchDirs to buildHopCallback when non-empty", async () => {
    let seenScratchDirs: readonly string[] | undefined;
    _callOpDeps.buildHopCallback = (hopCtx: BuildHopCallbackContext) => {
      seenScratchDirs = hopCtx.storyScratchDirs;
      return async () => ({
        result: {
          success: true,
          exitCode: 0,
          output: "ok",
          rateLimited: false,
          durationMs: 0,
          estimatedCostUsd: 0,
        },
        bundle: undefined,
      });
    };

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        assertDefined(req.executeHop, "req.executeHop");
        const hop = await req.executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return {
          result: { ...hop.result, agentFallbacks: [] },
          fallbacks: [],
          dispatchesCompleted: 1,
        };
      },
    });
    const runtime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager({}) });
    createdRuntimes.push(runtime);

    const runEchoOp: RunOperation<{ text: string }, string, Cfg> = {
      kind: "run",
      name: "run-scratch-echo-op",
      stage: "run",
      config: testSel,
      session: { role: "implementer", lifetime: "fresh" },
      build: (input) => ({
        role: { id: "role", content: "", overridable: false },
        task: { id: "task", content: input.text, overridable: false },
      }),
      parse: (output) => output,
    };

    let failure: unknown;
    try {
      await callOp(
        makeMockCallContext({
          runtime,
          packageView: runtime.packages.repo(),
          packageDir: "/tmp",
          agentName: "claude",
          storyScratchDirs: ["/tmp/scratch-a", "/tmp/scratch-b"],
        }),
        runEchoOp,
        { text: "hi" },
      );
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeUndefined();

    expect(seenScratchDirs).toEqual(["/tmp/scratch-a", "/tmp/scratch-b"]);
  });
});

describe("callOpDispatch — bare parse failure with no retry engaged", () => {
  test("rethrows the original parse error when no retry, fallback, recover, or retry turn exists", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async () => ({
        result: {
          success: true,
          exitCode: 0,
          output: "raw agent output",
          rateLimited: false,
          durationMs: 1,
          estimatedCostUsd: 0,
          agentFallbacks: [],
        },
        fallbacks: [],
      }),
    });
    const runtime = makeTestRuntime({ agentManager });
    createdRuntimes.push(runtime);

    const noRetryStrictOp: RunOperation<{ id: string }, string, Cfg> = {
      kind: "run",
      name: "no-retry-strict-parse-op",
      stage: "plan",
      config: testSel,
      session: { role: "plan", lifetime: "fresh" },
      build: (input) => ({
        role: { id: "role", content: "", overridable: false },
        task: { id: "task", content: input.id, overridable: false },
      }),
      parse: (_output) => {
        throw new Error("parse always throws");
      },
    };

    let thrown: unknown;
    try {
      await callOp(
        {
          runtime,
          packageView: runtime.packages.repo(),
          packageDir: "/tmp",
          agentName: "claude",
          storyId: "US-001",
        },
        noRetryStrictOp,
        { id: "f1" },
      );
    } catch (err) {
      thrown = err;
    }

    assertCaughtInstanceOf(thrown, Error, "callOp rejection");
    expect(thrown.message).toBe("parse always throws");
    expect(thrown).not.toBeInstanceOf(NaxError);
  });
});
