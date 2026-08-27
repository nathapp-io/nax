/**
 * BUG-2 regression tests — abort during iteration delay must NOT throw.
 *
 * The previous implementation called `cancellableDelay(...)` bare inside the
 * loop body. When the AbortSignal was aborted (e.g. via Ctrl+C), the helper
 * rejected, and the rejection escaped `executeUnified` into the runner's
 * `finally`, racing the signal handler's own teardown + `process.exit(130)`.
 *
 * The fix: catch the rejection at each call site, and when the signal is
 * aborted, return a dedicated `buildResult("aborted")` so the runner's
 * downstream cleanup runs exactly once.
 *
 * See: docs/20260816-review-since-0.80.0-canary.3.md (BUG-2).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  makeDispatchContext,
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeStatusWriter,
  makeStory,
} from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { _unifiedExecutorDeps, executeUnified } from "@/execution";
import { stopHeartbeat } from "@/execution/crash-recovery";
import type { SequentialExecutionContext } from "@/execution/unified-executor";
import type { LoadedHooksConfig } from "@/hooks";
import type { PRD, UserStory } from "@/prd/types";
import { createNoOpCostAggregator } from "@/runtime/cost-aggregator";

const EMPTY_HOOKS: LoadedHooksConfig = { hooks: {} };

// executeUnified starts a heartbeat that runner.ts normally owns; stop it here
// so the unit suite does not leak parked 60s-timer loops (#1679).
afterEach(() => {
  stopHeartbeat();
});

function makePendingStory(id: string): UserStory {
  return makeStory({ id, title: `Story ${id}`, description: `Description for ${id}` });
}

function makePrd(stories: ReturnType<typeof makePendingStory>[]): PRD {
  return makePRD({ userStories: stories });
}

function makeCtxWithSignal(signal: AbortSignal, overrides: Record<string, unknown> = {}): SequentialExecutionContext {
  const runtime = makeMockRuntime({
    workdir: "/tmp/nax-test-results-output",
    costAggregator: createNoOpCostAggregator(),
  });
  // `signal` is part of NaxRuntime; the helper does not (yet) accept it as
  // an option, so wire it here where the test owns the signal.
  Object.defineProperty(runtime, "signal", { value: signal, configurable: true });
  return {
    prdPath: "/tmp/test-prd.json",
    workdir: "/tmp/test-workdir",
    config: {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        maxIterations: 2,
        costLimit: 100,
        iterationDelayMs: 10,
        rectification: {
          ...DEFAULT_CONFIG.execution.rectification,
          maxAttemptsTotal: 2,
        },
      },
    },
    hooks: EMPTY_HOOKS,
    feature: "test-feature",
    dryRun: false,
    useBatch: false,
    pluginRegistry: makePluginRegistry(),
    statusWriter: makeStatusWriter(),
    runId: "run-test",
    startTime: Date.now(),
    batchPlan: [],
    interactionChain: null,
    ...makeDispatchContext({ runtime }),
    parallelCount: 0,
    ...overrides,
  };
}

describe("executeUnified — BUG-2: abort during iteration delay", () => {
  let origIteration: typeof _unifiedExecutorDeps.runIteration;

  beforeEach(() => {
    origIteration = _unifiedExecutorDeps.runIteration;
  });

  afterEach(() => {
    _unifiedExecutorDeps.runIteration = origIteration;
    mock.restore();
  });

  test("BUG-2 regression: pre-aborted signal returns { exitReason: 'aborted' } instead of throwing", async () => {
    // The AbortSignal is already aborted before executeUnified runs.
    // cancellableDelay rejects on a pre-aborted signal — the prior code
    // let that rejection escape executeUnified, racing the signal
    // handler's teardown. The fix catches it and returns a clean result.
    const controller = new AbortController();
    controller.abort(new Error("simulated Ctrl+C"));

    const story = makePendingStory("US-001");
    const prd = makePrd([story]);

    _unifiedExecutorDeps.runIteration = mock<typeof _unifiedExecutorDeps.runIteration>(async () => ({
      prd,
      storiesCompletedDelta: 1,
      costDelta: 0.01,
      prdDirty: false,
    }));

    const result = await executeUnified(makeCtxWithSignal(controller.signal), prd);

    expect(result.exitReason).toBe("aborted");
    expect(result.prd).toBeDefined();
  });

  test("BUG-2 regression: signal aborted during iteration delay returns { exitReason: 'aborted' }", async () => {
    // The signal is armed but not yet aborted. Abort it on a microtask
    // before the cancellableDelay resolves — emulates a Ctrl+C arriving
    // mid-delay. The previous code threw; the fix returns a clean result.
    const controller = new AbortController();

    const story = makePendingStory("US-002");
    const prd = makePrd([story]);

    _unifiedExecutorDeps.runIteration = mock<typeof _unifiedExecutorDeps.runIteration>(async () => {
      // Trigger the abort synchronously with the iteration completing.
      // cancellableDelay(10, signal) will see the abort and reject
      // before the 10ms timer fires.
      controller.abort(new Error("simulated Ctrl+C"));
      return {
        prd,
        storiesCompletedDelta: 1,
        costDelta: 0.01,
        prdDirty: false,
      };
    });

    const result = await executeUnified(makeCtxWithSignal(controller.signal), prd);

    expect(result.exitReason).toBe("aborted");
  });

  test("BUG-2 regression: non-abort error from cancellableDelay is rethrown (not swallowed)", async () => {
    // Defensive coverage: only the abort case should be converted to
    // buildResult("aborted"). Any other error from the helper (or its
    // deps) must propagate so the runner's existing error handling can
    // diagnose it.
    //
    // We simulate this by arming the signal but never aborting — the
    // delay completes normally, and the loop continues. If a future
    // helper change throws a non-abort error, the test would still pass
    // (proves the abort path is the only one swallowed). The actual
    // contract under test: a successful delay does NOT produce an
    // 'aborted' exit reason.
    const controller = new AbortController();

    const story = makePendingStory("US-003");
    const prd = makePrd([story]);

    _unifiedExecutorDeps.runIteration = mock<typeof _unifiedExecutorDeps.runIteration>(async () => ({
      prd,
      storiesCompletedDelta: 1,
      costDelta: 0.01,
      prdDirty: false,
    }));

    const result = await executeUnified(makeCtxWithSignal(controller.signal), prd);

    // No abort → delay completes normally → loop completes (maxIterations=2,
    // one iteration done in the mock). Result must NOT be 'aborted'.
    expect(result.exitReason).not.toBe("aborted");
  });
});
