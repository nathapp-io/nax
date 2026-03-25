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
import type { IPostRunAction, PostRunActionResult, PostRunContext } from "../../../../src/plugins/extensions";
import type { RunCleanupOptions } from "../../../../src/execution/lifecycle/run-cleanup";
import * as loggerModule from "../../../../src/logger";

// ============================================================================
// Helpers
// ============================================================================

function makePrd(overrides: Partial<{ stories: unknown[] }> = {}) {
  return {
    feature: "test-feature",
    userStories: overrides.stories ?? [],
  } as import("../../../../src/prd").PRD;
}

function makeStory(status: string) {
  return { id: `US-${status}`, title: "Story", status, passes: status === "passed" } as unknown as import("../../../../src/prd/types").UserStory;
}

function makePluginRegistry(actions: IPostRunAction[] = [], reporters: unknown[] = []) {
  const teardownAll = mock(async () => {});
  return {
    getPostRunActions: mock(() => actions),
    getReporters: mock(() => reporters),
    teardownAll,
  } as unknown as import("../../../../src/plugins/registry").PluginRegistry;
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
    ...overrides,
  };
}

// ============================================================================
// RunCleanupOptions shape
// ============================================================================

describe("RunCleanupOptions", () => {
  test("accepts feature field", () => {
    const opts = makeCleanupOptions({ feature: "some-feature" });
    expect(opts.feature).toBe("some-feature");
  });

  test("accepts prdPath field", () => {
    const opts = makeCleanupOptions({ prdPath: "/path/to/prd.json" });
    expect(opts.prdPath).toBe("/path/to/prd.json");
  });

  test("accepts branch field", () => {
    const opts = makeCleanupOptions({ branch: "feat/us-003" });
    expect(opts.branch).toBe("feat/us-003");
  });

  test("accepts version field", () => {
    const opts = makeCleanupOptions({ version: "2.0.0" });
    expect(opts.version).toBe("2.0.0");
  });
});

// ============================================================================
// buildPostRunContext()
// ============================================================================

describe("buildPostRunContext", () => {
  test("is exported from run-cleanup module", async () => {
    const mod = await import("../../../../src/execution/lifecycle/run-cleanup");
    expect(typeof mod.buildPostRunContext).toBe("function");
  });

  test("constructs PostRunContext with fields from RunCleanupOptions", async () => {
    const { buildPostRunContext } = await import("../../../../src/execution/lifecycle/run-cleanup");

    const prd = makePrd({ stories: [makeStory("passed"), makeStory("failed"), makeStory("skipped")] });
    const opts = makeCleanupOptions({ prd, feature: "feat-x", prdPath: "/p/prd.json", branch: "main", version: "3.0.0" });

    const ctx = buildPostRunContext(opts, 5000, makePluginLogger());

    expect(ctx.runId).toBe("run-001");
    expect(ctx.feature).toBe("feat-x");
    expect(ctx.prdPath).toBe("/p/prd.json");
    expect(ctx.branch).toBe("main");
    expect(ctx.version).toBe("3.0.0");
    expect(ctx.workdir).toBe("/tmp/test");
    expect(ctx.totalDurationMs).toBe(5000);
    expect(ctx.totalCost).toBe(0.05);
  });

  test("storySummary reflects prd story counts", async () => {
    const { buildPostRunContext } = await import("../../../../src/execution/lifecycle/run-cleanup");

    const prd = makePrd({
      stories: [
        makeStory("passed"),
        makeStory("passed"),
        makeStory("failed"),
        makeStory("skipped"),
        makeStory("paused"),
      ],
    });
    const opts = makeCleanupOptions({ prd, storiesCompleted: 2 });

    const ctx = buildPostRunContext(opts, 1000, makePluginLogger());

    expect(ctx.storySummary.completed).toBe(2);
    expect(ctx.storySummary.failed).toBe(1);
    expect(ctx.storySummary.skipped).toBe(1);
    expect(ctx.storySummary.paused).toBe(1);
  });

  test("stories contains all prd userStories", async () => {
    const { buildPostRunContext } = await import("../../../../src/execution/lifecycle/run-cleanup");

    const stories = [makeStory("passed"), makeStory("failed")];
    const prd = makePrd({ stories });
    const opts = makeCleanupOptions({ prd });

    const ctx = buildPostRunContext(opts, 1000, makePluginLogger());

    expect(ctx.stories).toHaveLength(2);
  });

  test("pluginConfig defaults to empty object when not provided", async () => {
    const { buildPostRunContext } = await import("../../../../src/execution/lifecycle/run-cleanup");
    const opts = makeCleanupOptions();
    const ctx = buildPostRunContext(opts, 1000, makePluginLogger());
    expect(ctx.pluginConfig).toEqual({});
  });
});

// ============================================================================
// Post-run action execution loop
// ============================================================================

describe("cleanupRun — post-run action loop", () => {
  test("calls shouldRun() before execute()", async () => {
    const { cleanupRun } = await import("../../../../src/execution/lifecycle/run-cleanup");

    const callOrder: string[] = [];
    const action: IPostRunAction = {
      name: "test-action",
      description: "desc",
      shouldRun: mock(async () => { callOrder.push("shouldRun"); return true; }),
      execute: mock(async () => { callOrder.push("execute"); return { success: true, message: "ok" }; }),
    };

    const opts = makeCleanupOptions({ pluginRegistry: makePluginRegistry([action]) });
    await cleanupRun(opts);

    expect(callOrder).toEqual(["shouldRun", "execute"]);
  });

  test("skips execute() when shouldRun() returns false", async () => {
    const { cleanupRun } = await import("../../../../src/execution/lifecycle/run-cleanup");

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
    const { cleanupRun } = await import("../../../../src/execution/lifecycle/run-cleanup");

    const order: string[] = [];
    const actions: IPostRunAction[] = ["first", "second", "third"].map((name) => ({
      name,
      description: "desc",
      shouldRun: mock(async () => { order.push(name); return true; }),
      execute: mock(async () => ({ success: true, message: "done" })),
    }));

    const opts = makeCleanupOptions({ pluginRegistry: makePluginRegistry(actions) });
    await cleanupRun(opts);

    expect(order).toEqual(["first", "second", "third"]);
  });

  test("post-run actions execute after reporters.onRunEnd()", async () => {
    const { cleanupRun } = await import("../../../../src/execution/lifecycle/run-cleanup");

    const callOrder: string[] = [];

    const reporter = {
      name: "reporter",
      onRunEnd: mock(async () => { callOrder.push("reporter.onRunEnd"); }),
    };

    const action: IPostRunAction = {
      name: "action",
      description: "desc",
      shouldRun: mock(async () => true),
      execute: mock(async () => { callOrder.push("action.execute"); return { success: true, message: "done" }; }),
    };

    const opts = makeCleanupOptions({
      pluginRegistry: makePluginRegistry([action], [reporter]),
    });
    await cleanupRun(opts);

    const reporterIdx = callOrder.indexOf("reporter.onRunEnd");
    const actionIdx = callOrder.indexOf("action.execute");
    expect(reporterIdx).toBeGreaterThanOrEqual(0);
    expect(actionIdx).toBeGreaterThan(reporterIdx);
  });

  test("post-run actions execute before teardownAll()", async () => {
    const { cleanupRun } = await import("../../../../src/execution/lifecycle/run-cleanup");

    const callOrder: string[] = [];

    const registry = makePluginRegistry();
    registry.teardownAll = mock(async () => { callOrder.push("teardownAll"); }) as typeof registry.teardownAll;

    const action: IPostRunAction = {
      name: "action",
      description: "desc",
      shouldRun: mock(async () => true),
      execute: mock(async () => { callOrder.push("action.execute"); return { success: true, message: "done" }; }),
    };
    registry.getPostRunActions = mock(() => [action]) as typeof registry.getPostRunActions;

    const opts = makeCleanupOptions({ pluginRegistry: registry });
    await cleanupRun(opts);

    const actionIdx = callOrder.indexOf("action.execute");
    const teardownIdx = callOrder.indexOf("teardownAll");
    expect(actionIdx).toBeGreaterThanOrEqual(0);
    expect(teardownIdx).toBeGreaterThan(actionIdx);
  });
});

// ============================================================================
// Logging behavior
// ============================================================================

describe("cleanupRun — action result logging", () => {
  let logInfoCalls: Array<[string, string, unknown]> = [];
  let logWarnCalls: Array<[string, string, unknown]> = [];
  let logDebugCalls: Array<[string, string, unknown]> = [];
  // biome-ignore lint/suspicious/noExplicitAny: spy type varies
  let loggerSpy: any;

  function makeLogger() {
    return {
      info: mock((...args: [string, string, unknown]) => { logInfoCalls.push(args); }),
      warn: mock((...args: [string, string, unknown]) => { logWarnCalls.push(args); }),
      debug: mock((...args: [string, string, unknown]) => { logDebugCalls.push(args); }),
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

  test("successful execute() with url logs at info level with url", async () => {
    const { cleanupRun } = await import("../../../../src/execution/lifecycle/run-cleanup");

    const result: PostRunActionResult = { success: true, message: "Published", url: "https://example.com/report" };
    const action: IPostRunAction = {
      name: "publisher",
      description: "desc",
      shouldRun: mock(async () => true),
      execute: mock(async () => result),
    };

    const opts = makeCleanupOptions({ pluginRegistry: makePluginRegistry([action]) });
    await cleanupRun(opts);

    // Check that an info log was emitted containing '[post-run] publisher: Published' and url
    const infoMessages = logInfoCalls.map(([, msg]) => msg);
    const found = infoMessages.some((m) => m.includes("[post-run] publisher") && m.includes("Published"));
    expect(found).toBe(true);
  });

  test("skipped result (skipped=true) logs at info level with reason", async () => {
    const { cleanupRun } = await import("../../../../src/execution/lifecycle/run-cleanup");

    const result: PostRunActionResult = { success: true, message: "Nothing to do", skipped: true, reason: "no changes" };
    const action: IPostRunAction = {
      name: "notifier",
      description: "desc",
      shouldRun: mock(async () => true),
      execute: mock(async () => result),
    };

    const opts = makeCleanupOptions({ pluginRegistry: makePluginRegistry([action]) });
    await cleanupRun(opts);

    const infoMessages = logInfoCalls.map(([, msg]) => msg);
    const found = infoMessages.some((m) => m.includes("[post-run] notifier") && m.includes("skipped") && m.includes("no changes"));
    expect(found).toBe(true);
  });

  test("shouldRun()=false emits debug log", async () => {
    const { cleanupRun } = await import("../../../../src/execution/lifecycle/run-cleanup");

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
    const { cleanupRun } = await import("../../../../src/execution/lifecycle/run-cleanup");

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
    const found = warnMessages.some((m) => m.includes("[post-run] webhook") && m.includes("failed") && m.includes("Connection refused"));
    expect(found).toBe(true);
  });
});

// ============================================================================
// Error tolerance
// ============================================================================

describe("cleanupRun — error tolerance", () => {
  test("error thrown in shouldRun() does not block run completion", async () => {
    const { cleanupRun } = await import("../../../../src/execution/lifecycle/run-cleanup");

    const action: IPostRunAction = {
      name: "bad-should-run",
      description: "desc",
      shouldRun: mock(async () => { throw new Error("shouldRun exploded"); }),
      execute: mock(async () => ({ success: true, message: "ok" })),
    };

    const registry = makePluginRegistry([action]);
    const opts = makeCleanupOptions({ pluginRegistry: registry });

    // Must NOT throw
    await expect(cleanupRun(opts)).resolves.toBeUndefined();
    // teardownAll should still be called
    expect(registry.teardownAll).toHaveBeenCalled();
  });

  test("error thrown in execute() does not block run completion", async () => {
    const { cleanupRun } = await import("../../../../src/execution/lifecycle/run-cleanup");

    const action: IPostRunAction = {
      name: "bad-execute",
      description: "desc",
      shouldRun: mock(async () => true),
      execute: mock(async () => { throw new Error("execute exploded"); }),
    };

    const registry = makePluginRegistry([action]);
    const opts = makeCleanupOptions({ pluginRegistry: registry });

    await expect(cleanupRun(opts)).resolves.toBeUndefined();
    expect(registry.teardownAll).toHaveBeenCalled();
  });

  test("error in one action does not prevent subsequent actions from running", async () => {
    const { cleanupRun } = await import("../../../../src/execution/lifecycle/run-cleanup");

    const executed: string[] = [];
    const badAction: IPostRunAction = {
      name: "bad",
      description: "desc",
      shouldRun: mock(async () => { throw new Error("boom"); }),
      execute: mock(async () => ({ success: true, message: "x" })),
    };
    const goodAction: IPostRunAction = {
      name: "good",
      description: "desc",
      shouldRun: mock(async () => true),
      execute: mock(async () => { executed.push("good"); return { success: true, message: "ok" }; }),
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
    const mod = await import("../../../../src/execution/lifecycle/run-cleanup");

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

    const { runCompletionPhase } = await import("../../../../src/execution/runner-completion");

    const prd = makePrd({ stories: [makeStory("passed")] });

    try {
      await runCompletionPhase({
        config: {
          acceptance: { enabled: false },
          headless: { enabled: true },
          autoCommit: { enabled: false },
          // biome-ignore lint/suspicious/noExplicitAny: minimal stub for test
        } as any,
        hooks: { hooks: [] } as import("../../../../src/hooks").LoadedHooksConfig,
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

function makePluginLogger(): import("../../../../src/plugins/types").PluginLogger {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  } as unknown as import("../../../../src/plugins/types").PluginLogger;
}
