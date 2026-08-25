/**
 * run-cleanup.ts — Tests for US-003
 *
 * Tests for:
 * - RunCleanupOptions extended fields (feature, prdPath, branch, version)
 * - buildPostRunContext() helper
 * - Post-run action execution loop (shouldRun → execute)
 * - Logging behavior for each action result type
 * - Error tolerance (exceptions in shouldRun/execute don't block run)
 * - Execution order guarantees
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { _runCleanupDeps, cleanupRun } from "@/execution";
import type { RunCleanupOptions } from "@/execution/lifecycle/run-cleanup";
import type { HookContext } from "@/hooks";
import * as loggerModule from "@/logger";
import type { IPostRunAction, PostRunActionResult, PostRunContext } from "@/plugins/extensions";
import type { PRD, StoryStatus } from "@/prd/types";
import { makeDispatchContext, makePluginRegistry as makePluginRegistryHelper, makeStory } from "@test/helpers";

// ============================================================================
// Helpers
// ============================================================================

function makePrd(overrides: Partial<{ stories: unknown[] }> = {}) {
  return {
    feature: "test-feature",
    userStories: overrides.stories ?? [],
  } as PRD;
}

function storyWithStatus(status: StoryStatus) {
  return makeStory({
    id: `US-${status}`,
    title: "Story",
    status,
    passes: status === "passed",
  });
}

function makePluginRegistry(actions: IPostRunAction[] = [], reporters: unknown[] = []) {
  const teardownAll = mock(async () => {});
  return makePluginRegistryHelper({
    getPostRunActions: mock(() => actions),
    getPostRunActionRegistrations: mock(() =>
      actions.map((action) => ({ pluginName: `plugin-${action.name}`, action })),
    ),
    getReporters: mock(() => reporters),
    teardownAll,
  });
}

function makeCleanupOptions(overrides: Partial<RunCleanupOptions> = {}): RunCleanupOptions {
  return {
    runId: "run-001",
    startTime: Date.now() - 1000,
    totalCost: 0.05,
    storiesCompleted: 1,
    prd: makePrd(),
    pluginRegistry: makePluginRegistry(),
    workdir: "/tmp/test",
    interactionChain: null,
    feature: "my-feature",
    prdPath: "/tmp/test/.nax/features/my-feature/prd.json",
    branch: "feat/my-feature",
    version: "1.2.3",
    hooks: { hooks: {} },
    ...overrides,
  };
}

// ============================================================================
// RunCleanupOptions shape
// ============================================================================

describe("RunCleanupOptions", () => {
  test("accepts feature, prdPath, branch, and version fields", () => {
    expect(makeCleanupOptions({ feature: "some-feature" }).feature).toBe("some-feature");
    expect(makeCleanupOptions({ prdPath: "/path/to/prd.json" }).prdPath).toBe("/path/to/prd.json");
    expect(makeCleanupOptions({ branch: "feat/us-003" }).branch).toBe("feat/us-003");
    expect(makeCleanupOptions({ version: "2.0.0" }).version).toBe("2.0.0");
  });

  test("runner.ts closes runtime from finally so failure paths flush runtime sinks", async () => {
    const runnerSource = await Bun.file(
      new URL("../../../../src/execution/runner.ts", import.meta.url).pathname,
    ).text();
    const finallyMatch = runnerSource.match(/finally \{[\s\S]*?await runtime\.close\(\);[\s\S]*?\n {2}\}/m);
    expect(finallyMatch).not.toBeNull();
  });
});

// ============================================================================
// buildPostRunContext()
// ============================================================================

describe("buildPostRunContext", () => {
  test("is exported, constructs PostRunContext with fields, stories from prd, and empty pluginConfig", async () => {
    const { buildPostRunContext } = await import("@/execution/lifecycle/run-cleanup");
    expect(typeof buildPostRunContext).toBe("function");

    const prd = makePrd({ stories: [storyWithStatus("passed"), storyWithStatus("failed")] });
    const opts = makeCleanupOptions({
      prd,
      feature: "feat-x",
      prdPath: "/p/prd.json",
      branch: "main",
      version: "3.0.0",
    });
    const ctx = buildPostRunContext(opts, 5000, makePluginLogger());

    expect(ctx.runId).toBe("run-001");
    expect(ctx.feature).toBe("feat-x");
    expect(ctx.prdPath).toBe("/p/prd.json");
    expect(ctx.branch).toBe("main");
    expect(ctx.version).toBe("3.0.0");
    expect(ctx.workdir).toBe("/tmp/test");
    expect(ctx.totalDurationMs).toBe(5000);
    expect(ctx.totalCost).toBe(0.05);
    expect(ctx.stories).toHaveLength(2);
    expect(ctx.pluginConfig).toEqual({});
  });

  test("populates runStartedAt from the run's startTime (#1422)", async () => {
    // The curator scopes its observations with this value. If the producer stops
    // setting it, every collector silently falls back to "no scoping" and the
    // cumulative-count defect returns — with the consumer-side tests still green,
    // because they inject runStartedAt directly.
    const { buildPostRunContext } = await import("@/execution/lifecycle/run-cleanup");
    const startTime = Date.parse("2026-08-01T12:00:00.000Z");
    const ctx = buildPostRunContext(makeCleanupOptions({ startTime }), 5000, makePluginLogger());
    expect(ctx.runStartedAt).toBe(startTime);
  });

  test("storySummary reflects prd story counts", async () => {
    const { buildPostRunContext } = await import("@/execution/lifecycle/run-cleanup");

    const prd = makePrd({
      stories: [
        storyWithStatus("passed"),
        storyWithStatus("passed"),
        storyWithStatus("failed"),
        storyWithStatus("skipped"),
        storyWithStatus("paused"),
      ],
    });
    const opts = makeCleanupOptions({ prd, storiesCompleted: 2 });

    const ctx = buildPostRunContext(opts, 1000, makePluginLogger());

    expect(ctx.storySummary.completed).toBe(2);
    expect(ctx.storySummary.failed).toBe(1);
    expect(ctx.storySummary.skipped).toBe(1);
    expect(ctx.storySummary.paused).toBe(1);
  });
});

// ============================================================================
// Post-run action execution loop
// ============================================================================

describe("cleanupRun — post-run action loop", () => {
  test("calls shouldRun() before execute()", async () => {
    const { cleanupRun } = await import("@/execution/lifecycle/run-cleanup");

    const callOrder: string[] = [];
    const action: IPostRunAction = {
      name: "test-action",
      description: "desc",
      shouldRun: mock(async () => {
        callOrder.push("shouldRun");
        return true;
      }),
      execute: mock(async () => {
        callOrder.push("execute");
        return { success: true, message: "ok" };
      }),
    };

    const opts = makeCleanupOptions({ pluginRegistry: makePluginRegistry([action]) });
    await cleanupRun(opts);

    expect(callOrder).toEqual(["shouldRun", "execute"]);
  });

  test("skips execute() when shouldRun() returns false", async () => {
    const { cleanupRun } = await import("@/execution/lifecycle/run-cleanup");

    const action: IPostRunAction = {
      name: "skip-me",
      description: "desc",
      shouldRun: mock(async () => false),
      execute: mock(async () => ({ success: true, message: "should not run" })),
    };

    const opts = makeCleanupOptions({ pluginRegistry: makePluginRegistry([action]) });
    await cleanupRun(opts);

    expect(action.execute).not.toHaveBeenCalled();
  });

  test("executes multiple actions in registration order", async () => {
    const { cleanupRun } = await import("@/execution/lifecycle/run-cleanup");

    const order: string[] = [];
    const actions: IPostRunAction[] = ["first", "second", "third"].map((name) => ({
      name,
      description: "desc",
      shouldRun: mock(async () => {
        order.push(name);
        return true;
      }),
      execute: mock(async () => ({ success: true, message: "done" })),
    }));

    const opts = makeCleanupOptions({ pluginRegistry: makePluginRegistry(actions) });
    await cleanupRun(opts);

    expect(order).toEqual(["first", "second", "third"]);
  });

  test("post-run actions execute after reporters.onRunEnd() and before teardownAll()", async () => {
    const { cleanupRun } = await import("@/execution/lifecycle/run-cleanup");
    const callOrder: string[] = [];

    const reporter = {
      name: "reporter",
      onRunEnd: mock(async () => {
        callOrder.push("reporter.onRunEnd");
      }),
    };
    const registry = makePluginRegistry([], [reporter]);
    registry.teardownAll = mock(async () => {
      callOrder.push("teardownAll");
    }) as typeof registry.teardownAll;

    const action: IPostRunAction = {
      name: "action",
      description: "desc",
      shouldRun: mock(async () => true),
      execute: mock(async () => {
        callOrder.push("action.execute");
        return { success: true, message: "done" };
      }),
    };
    registry.getPostRunActionRegistrations = mock(() => [{ pluginName: "action-plugin", action }]);

    const opts = makeCleanupOptions({ pluginRegistry: registry });
    await cleanupRun(opts);

    const reporterIdx = callOrder.indexOf("reporter.onRunEnd");
    const actionIdx = callOrder.indexOf("action.execute");
    const teardownIdx = callOrder.indexOf("teardownAll");
    expect(reporterIdx).toBeGreaterThanOrEqual(0);
    expect(actionIdx).toBeGreaterThan(reporterIdx);
    expect(teardownIdx).toBeGreaterThan(actionIdx);
  });
});

describe("cleanupRun — on-post-run-action hook", () => {
  const originalFireHook = _runCleanupDeps.fireHook;

  afterEach(() => {
    _runCleanupDeps.fireHook = originalFireHook;
  });

  test.each([
    ["succeeded", { success: true, message: "published", url: "https://example.com/result" }],
    ["failed", { success: false, message: "connection refused" }],
    ["skipped", { success: true, message: "nothing", skipped: true, reason: "no changes" }],
  ] as const)("fires once with plugin metadata for a %s result", async (status, result) => {
    const calls: Array<{ event: string; ctx: HookContext }> = [];
    _runCleanupDeps.fireHook = mock(async (_hooks, event, ctx) => {
      calls.push({ event, ctx });
    });
    const action: IPostRunAction = {
      name: "publisher",
      description: "desc",
      shouldRun: async () => true,
      execute: async () => result,
    };

    await cleanupRun(makeCleanupOptions({ pluginRegistry: makePluginRegistry([action]) }));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      event: "on-post-run-action",
      ctx: { pluginName: "plugin-publisher", actionName: "publisher", status },
    });
  });

  test("fires skipped when shouldRun is false and error when action evaluation throws", async () => {
    const statuses: string[] = [];
    _runCleanupDeps.fireHook = mock(async (_hooks, _event, ctx) => {
      statuses.push(ctx.status ?? "");
    });
    const actions: IPostRunAction[] = [
      {
        name: "skip",
        description: "desc",
        shouldRun: async () => false,
        execute: async () => ({ success: true, message: "x" }),
      },
      {
        name: "error",
        description: "desc",
        shouldRun: async () => {
          throw new Error("boom");
        },
        execute: async () => ({ success: true, message: "x" }),
      },
    ];

    await cleanupRun(makeCleanupOptions({ pluginRegistry: makePluginRegistry(actions) }));

    expect(statuses).toEqual(["skipped", "error"]);
  });

  test("a hook failure does not prevent the next post-run action", async () => {
    const executed: string[] = [];
    _runCleanupDeps.fireHook = mock(async () => {
      throw new Error("hook crashed");
    });
    const actions: IPostRunAction[] = ["first", "second"].map((name) => ({
      name,
      description: "desc",
      shouldRun: async () => true,
      execute: async () => {
        executed.push(name);
        return { success: true, message: "ok" };
      },
    }));

    await cleanupRun(makeCleanupOptions({ pluginRegistry: makePluginRegistry(actions) }));

    expect(executed).toEqual(["first", "second"]);
  });
});

// ============================================================================
// Logging behavior
// ============================================================================

describe("cleanupRun — action result logging", () => {
  let logInfoCalls: Array<[string, string, unknown]> = [];
  let logWarnCalls: Array<[string, string, unknown]> = [];
  let logDebugCalls: Array<[string, string, unknown]> = [];
  let loggerSpy: any;

  function makeLogger() {
    return {
      info: mock((...args: [string, string, unknown]) => {
        logInfoCalls.push(args);
      }),
      warn: mock((...args: [string, string, unknown]) => {
        logWarnCalls.push(args);
      }),
      debug: mock((...args: [string, string, unknown]) => {
        logDebugCalls.push(args);
      }),
      error: mock(() => {}),
    };
  }

  beforeEach(() => {
    logInfoCalls = [];
    logWarnCalls = [];
    logDebugCalls = [];
    // Wire the local mock logger into getSafeLogger so cleanupRun's internal logging is captured
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(makeLogger() as any);
  });

  afterEach(() => {
    loggerSpy?.mockRestore();
  });

  test("successful execute() logs at info level; skipped result logs at info level with reason", async () => {
    const { cleanupRun } = await import("@/execution/lifecycle/run-cleanup");

    const successAction: IPostRunAction = {
      name: "publisher",
      description: "desc",
      shouldRun: mock(async () => true),
      execute: mock(
        async () => ({ success: true, message: "Published", url: "https://example.com/report" }) as PostRunActionResult,
      ),
    };
    await cleanupRun(makeCleanupOptions({ pluginRegistry: makePluginRegistry([successAction]) }));
    const infoMessages1 = logInfoCalls.map(([, msg]) => msg);
    expect(infoMessages1.some((m) => m.includes("[post-run] publisher") && m.includes("Published"))).toBe(true);

    logInfoCalls = [];
    const skippedAction: IPostRunAction = {
      name: "notifier",
      description: "desc",
      shouldRun: mock(async () => true),
      execute: mock(
        async () =>
          ({ success: true, message: "Nothing to do", skipped: true, reason: "no changes" }) as PostRunActionResult,
      ),
    };
    await cleanupRun(makeCleanupOptions({ pluginRegistry: makePluginRegistry([skippedAction]) }));
    const infoMessages2 = logInfoCalls.map(([, msg]) => msg);
    expect(
      infoMessages2.some((m) => m.includes("[post-run] notifier") && m.includes("skipped") && m.includes("no changes")),
    ).toBe(true);
  });

  test("shouldRun()=false emits debug log", async () => {
    const { cleanupRun } = await import("@/execution/lifecycle/run-cleanup");

    const action: IPostRunAction = {
      name: "skipped-action",
      description: "desc",
      shouldRun: mock(async () => false),
      execute: mock(async () => ({ success: true, message: "x" })),
    };

    const opts = makeCleanupOptions({ pluginRegistry: makePluginRegistry([action]) });
    await cleanupRun(opts);

    const debugMessages = logDebugCalls.map(([, msg]) => msg);
    const found = debugMessages.some((m) => m.includes("skipped-action"));
    expect(found).toBe(true);
  });

  test("failed result (success=false) logs at warn level", async () => {
    const { cleanupRun } = await import("@/execution/lifecycle/run-cleanup");

    const result: PostRunActionResult = { success: false, message: "Connection refused" };
    const action: IPostRunAction = {
      name: "webhook",
      description: "desc",
      shouldRun: mock(async () => true),
      execute: mock(async () => result),
    };

    const opts = makeCleanupOptions({ pluginRegistry: makePluginRegistry([action]) });
    await cleanupRun(opts);

    const warnMessages = logWarnCalls.map(([, msg]) => msg);
    const found = warnMessages.some(
      (m) => m.includes("[post-run] webhook") && m.includes("failed") && m.includes("Connection refused"),
    );
    expect(found).toBe(true);
  });

  test("forwards the action's structured data to the logger", async () => {
    const { cleanupRun } = await import("@/execution");

    // Every post-run action logs its cause through this argument — nax-finish
    // passes the finish flow's stdout/stderr, and each plugin's catch path
    // passes `{ error }`. Dropping it left bare messages with no cause.
    const action: IPostRunAction = {
      name: "webhook",
      description: "desc",
      shouldRun: mock(async () => true),
      execute: mock(async (ctx: PostRunContext) => {
        ctx.logger.warn("subprocess produced no result", { exitCode: 1, stderr: "Bun is not defined" });
        ctx.logger.info("progress", { step: 2 });
        return { success: true, message: "done" } as PostRunActionResult;
      }),
    };

    await cleanupRun(makeCleanupOptions({ pluginRegistry: makePluginRegistry([action]) }));

    const warned = logWarnCalls.find(([, msg]) => msg === "subprocess produced no result");
    expect(warned?.[0]).toBe("post-run");
    expect(warned?.[2]).toEqual({ exitCode: 1, stderr: "Bun is not defined" });
    expect(logInfoCalls.find(([, msg]) => msg === "progress")?.[2]).toEqual({ step: 2 });
  });
});

// ============================================================================
// Error tolerance
// ============================================================================

describe("cleanupRun — error tolerance", () => {
  test("error thrown in shouldRun() or execute() does not block run completion; teardownAll still called", async () => {
    const { cleanupRun } = await import("@/execution/lifecycle/run-cleanup");

    const shouldRunAction: IPostRunAction = {
      name: "bad-should-run",
      description: "desc",
      shouldRun: mock(async () => {
        throw new Error("shouldRun exploded");
      }),
      execute: mock(async () => ({ success: true, message: "ok" })),
    };
    const shouldRunRegistry = makePluginRegistry([shouldRunAction]);
    await expect(cleanupRun(makeCleanupOptions({ pluginRegistry: shouldRunRegistry }))).resolves.toBeUndefined();
    expect(shouldRunRegistry.teardownAll).toHaveBeenCalled();

    const executeAction: IPostRunAction = {
      name: "bad-execute",
      description: "desc",
      shouldRun: mock(async () => true),
      execute: mock(async () => {
        throw new Error("execute exploded");
      }),
    };
    const executeRegistry = makePluginRegistry([executeAction]);
    await expect(cleanupRun(makeCleanupOptions({ pluginRegistry: executeRegistry }))).resolves.toBeUndefined();
    expect(executeRegistry.teardownAll).toHaveBeenCalled();
  });

  test("error in one action does not prevent subsequent actions from running", async () => {
    const { cleanupRun } = await import("@/execution/lifecycle/run-cleanup");

    const executed: string[] = [];
    const badAction: IPostRunAction = {
      name: "bad",
      description: "desc",
      shouldRun: mock(async () => {
        throw new Error("boom");
      }),
      execute: mock(async () => ({ success: true, message: "x" })),
    };
    const goodAction: IPostRunAction = {
      name: "good",
      description: "desc",
      shouldRun: mock(async () => true),
      execute: mock(async () => {
        executed.push("good");
        return { success: true, message: "ok" };
      }),
    };

    const opts = makeCleanupOptions({ pluginRegistry: makePluginRegistry([badAction, goodAction]) });
    await cleanupRun(opts);

    expect(executed).toContain("good");
  });
});

// ============================================================================
// runner.ts finally block — new fields
// ============================================================================

describe("runner.ts — cleanupRun receives feature/prdPath/branch/version", () => {
  test("RunCleanupOptions interface requires feature, prdPath, branch, version fields", async () => {
    // Compile-time + runtime check: all four new fields must be present and typed as strings.
    // This fails until RunCleanupOptions is extended with these fields in run-cleanup.ts.
    const mod = await import("@/execution/lifecycle/run-cleanup");

    // Build a full RunCleanupOptions — TypeScript will reject this if fields are missing
    const opts: RunCleanupOptions = {
      runId: "run-test",
      startTime: Date.now(),
      totalCost: 0,
      storiesCompleted: 0,
      prd: makePrd(),
      pluginRegistry: makePluginRegistry(),
      workdir: "/tmp/test",
      interactionChain: null,
      feature: "my-feature",
      prdPath: "/path/prd.json",
      branch: "feat/test",
      version: "1.0.0",
      hooks: { hooks: {} },
    };

    expect(opts.feature).toBe("my-feature");
    expect(opts.prdPath).toBe("/path/prd.json");
    expect(opts.branch).toBe("feat/test");
    expect(opts.version).toBe("1.0.0");

    // Verify runner.ts actually passes these to cleanupRun.
    // We check the runner source includes the new fields in its cleanupRun() call.
    const runnerSource = await Bun.file(
      new URL("../../../../src/execution/runner.ts", import.meta.url).pathname,
    ).text();
    expect(runnerSource).toContain("feature");
    expect(runnerSource).toContain("prdPath");
    expect(runnerSource).toContain("branch");
    expect(runnerSource).toContain("version");
    // Must pass them inside the cleanupRun call block (not just as variable declarations)
    const cleanupCallMatch = runnerSource.match(/cleanupRun\(\{[\s\S]*?\}\)/m);
    expect(cleanupCallMatch).not.toBeNull();
    const cleanupBlock = cleanupCallMatch![0];
    expect(cleanupBlock).toContain("feature");
    expect(cleanupBlock).toContain("prdPath");
    expect(cleanupBlock).toContain("branch");
    expect(cleanupBlock).toContain("version");
    expect(cleanupBlock).toContain("hooks");
  });
});

// ============================================================================
// runner-completion.ts — must NOT call post-run actions
// ============================================================================

describe("runner-completion.ts — does not invoke post-run actions", () => {
  test("runCompletionPhase does not call getPostRunActions()", async () => {
    // runner-completion.ts must not touch post-run actions; that's cleanupRun's job.
    // We verify this by checking that getPostRunActions is never called during
    // a minimal runCompletionPhase() invocation.

    const registry = makePluginRegistry();
    const getPostRunActionsSpy = mock(() => []);
    registry.getPostRunActions = getPostRunActionsSpy as typeof registry.getPostRunActions;

    const { runCompletionPhase } = await import("@/execution/runner-completion");

    const prd = makePrd({ stories: [storyWithStatus("passed")] });

    try {
      await runCompletionPhase({
        config: {
          acceptance: { enabled: false },
          headless: { enabled: true },
          autoCommit: { enabled: false },
        } as any,
        hooks: { hooks: [] } as import("@/hooks").LoadedHooksConfig,
        feature: "test-feat",
        workdir: "/tmp/test",
        statusFile: "/tmp/test/status.json",
        runId: "run-001",
        startedAt: new Date().toISOString(),
        startTime: Date.now() - 500,
        formatterMode: "quiet",
        headless: true,
        prd,
        allStoryMetrics: [],
        totalCost: 0,
        storiesCompleted: 1,
        iterations: 1,
        statusWriter: { write: mock(async () => {}) },
        pluginRegistry: registry,
        prdPath: "/tmp/test/.nax/features/test-feat/prd.json",
        ...makeDispatchContext(),
      });
    } catch {
      // runCompletionPhase may throw in this minimal context — that's fine
      // We only care that getPostRunActions was NOT called
    }

    expect(getPostRunActionsSpy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Helpers (private)
// ============================================================================

function makePluginLogger(): import("@/plugins/types").PluginLogger {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
}

// ============================================================================
// BUG-15: runtime-crash retry budget is reset at run teardown
// ============================================================================

describe("cleanupRun — resets runtime-crash retry budget (BUG-15)", () => {
  test("calls resetRuntimeCrashRetryCounts during teardown", async () => {
    const { resetRuntimeCrashRetryCounts } = await import("@/execution/escalation");
    const resetMock = mock(() => {});
    const originalReset = _runCleanupDeps.resetRuntimeCrashRetryCounts;
    _runCleanupDeps.resetRuntimeCrashRetryCounts = resetMock;

    try {
      const pluginRegistry = makePluginRegistry();
      await cleanupRun(makeCleanupOptions({ pluginRegistry }));
      expect(resetMock).toHaveBeenCalled();
    } finally {
      _runCleanupDeps.resetRuntimeCrashRetryCounts = originalReset;
    }
  });
});
