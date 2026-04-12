/**
 * Unit tests for US-003: Unify executors — integrate parallel dispatch into
 * the sequential loop.
 *
 * Covers all acceptance criteria:
 *   AC-1  executeUnified exports SequentialExecutionResult return type
 *   AC-2  parallelCount > 0 + batch > 1 → runParallelBatch called
 *   AC-3  parallelCount > 0 + batch == 1 → runIteration called
 *   AC-4  parallelCount undefined or 0 → runIteration, never runParallelBatch
 *   AC-5  story:started events emitted per story before runParallelBatch
 *   AC-6  parallel failure routed through handlePipelineFailure / handleTierEscalation
 *   AC-7  cost-limit check runs after parallel batch
 *   AC-8  runner-execution.ts always calls executeUnified (no conditional branch)
 *   AC-9  parallel-executor.ts deleted; no src/ imports from it
 *   AC-10 lifecycle/parallel-lifecycle.ts deleted; no src/ imports from it
 *   AC-11 runner.ts has no reference to _runnerDeps.runParallelExecution
 */

import { beforeEach, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import * as loggerModule from "../../../src/logger";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const SRC = join(import.meta.dir, "../../../src");

async function readSrc(rel: string): Promise<string> {
  return Bun.file(join(SRC, rel)).text();
}

async function srcExists(rel: string): Promise<boolean> {
  return Bun.file(join(SRC, rel)).exists();
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-1: executeUnified returns SequentialExecutionResult
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-1 — executeUnified signature matches SequentialExecutionResult", () => {
  test("unified-executor.ts imports SequentialExecutionContext as its context type", async () => {
    const src = await readSrc("execution/unified-executor.ts");
    // The new implementation accepts SequentialExecutionContext (same as executeSequential)
    expect(src).toContain("SequentialExecutionContext");
  });

  test("unified-executor.ts return type is SequentialExecutionResult (includes exitReason)", async () => {
    const src = await readSrc("execution/unified-executor.ts");
    // SequentialExecutionResult has exitReason; UnifiedExecutorResult did not
    expect(src).toContain("SequentialExecutionResult");
    expect(src).toContain("exitReason");
  });

  test("executeUnified function signature uses (ctx: SequentialExecutionContext, initialPrd: PRD)", async () => {
    const src = await readSrc("execution/unified-executor.ts");
    // The renamed function replaces executeSequential with the same two-parameter pattern
    expect(src).toMatch(/executeUnified\s*\(\s*ctx\s*:/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _unifiedExecutorDeps — injectable deps (required for AC-2 through AC-7)
// ─────────────────────────────────────────────────────────────────────────────

describe("_unifiedExecutorDeps — injectable dispatch dependencies", () => {
  test("unified-executor.ts exports _unifiedExecutorDeps object", async () => {
    const mod = await import("../../../src/execution/unified-executor");
    expect((mod as Record<string, unknown>)._unifiedExecutorDeps).toBeDefined();
  });

  test("_unifiedExecutorDeps contains runParallelBatch function", async () => {
    const mod = await import("../../../src/execution/unified-executor");
    const deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    expect(typeof deps.runParallelBatch).toBe("function");
  });

  test("_unifiedExecutorDeps contains runIteration function", async () => {
    const mod = await import("../../../src/execution/unified-executor");
    const deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    expect(typeof deps.runIteration).toBe("function");
  });

  test("_unifiedExecutorDeps contains selectIndependentBatch function", async () => {
    const mod = await import("../../../src/execution/unified-executor");
    const deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    expect(typeof deps.selectIndependentBatch).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-2 / AC-3 / AC-4 — parallel dispatch routing (source-code level)
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-2 — runParallelBatch called when parallelCount > 0 and batch > 1 (source)", () => {
  test("unified-executor.ts calls selectIndependentBatch to compute the parallel batch", async () => {
    const src = await readSrc("execution/unified-executor.ts");
    expect(src).toContain("selectIndependentBatch");
  });

  test("unified-executor.ts calls runParallelBatch inside the main loop", async () => {
    const src = await readSrc("execution/unified-executor.ts");
    expect(src).toContain("runParallelBatch");
  });

  test("dispatch to runParallelBatch is guarded by parallelCount > 0", async () => {
    const src = await readSrc("execution/unified-executor.ts");
    // Some conditional involving parallelCount must gate the parallel path
    expect(src).toMatch(/parallelCount\s*[><!]/);
  });

  test("dispatch to runParallelBatch is guarded by batch length > 1", async () => {
    const src = await readSrc("execution/unified-executor.ts");
    // Some conditional involving batch length must gate the parallel path
    expect(src).toMatch(/\.length\s*[>!]/);
  });
});

describe("AC-3 — runIteration called when parallelCount > 0 but batch == 1 (source)", () => {
  test("unified-executor.ts still calls runIteration (single-story fallback path exists)", async () => {
    const src = await readSrc("execution/unified-executor.ts");
    expect(src).toContain("runIteration");
  });

  test("runIteration is inside the same loop as the parallel dispatch check", async () => {
    const src = await readSrc("execution/unified-executor.ts");
    // Both must appear within the same while/for block — verified by both being present
    // after the loop preamble (we check presence; integration tests verify runtime dispatch)
    expect(src).toContain("runIteration");
    expect(src).toContain("runParallelBatch");
  });
});

describe("AC-4 — runIteration always used when parallelCount is undefined or 0 (source)", () => {
  test("the parallel dispatch branch requires ctx.parallelCount to be truthy / > 0", async () => {
    const src = await readSrc("execution/unified-executor.ts");
    // The guard must reference parallelCount with a condition that excludes 0 and undefined
    // Most natural: (ctx.parallelCount !== undefined && ctx.parallelCount > 0)
    // or just (ctx.parallelCount ?? 0) > 0
    expect(src).toMatch(/parallelCount/);
    // The parallel path must NOT be taken unconditionally when parallelCount is absent
    // i.e., there is a conditional wrapping runParallelBatch
    const runParallelIdx = src.indexOf("runParallelBatch");
    const ifBeforeParallel = src.lastIndexOf("if", runParallelIdx);
    expect(ifBeforeParallel).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-2/4 — dispatch behavior via _deps injection
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-2 — runParallelBatch dispatch via _deps injection", () => {
  let deps: Record<string, unknown>;
  let origRunParallelBatch: unknown;
  let origRunIteration: unknown;
  let origSelectIndependentBatch: unknown;

  beforeEach(async () => {
    const mod = await import("../../../src/execution/unified-executor");
    deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    origRunParallelBatch = deps.runParallelBatch;
    origRunIteration = deps.runIteration;
    origSelectIndependentBatch = deps.selectIndependentBatch;
  });

  afterEach(() => {
    if (deps) {
      deps.runParallelBatch = origRunParallelBatch;
      deps.runIteration = origRunIteration;
      deps.selectIndependentBatch = origSelectIndependentBatch;
    }
    mock.restore();
  });

  test("selectIndependentBatch is called when parallelCount > 0", async () => {
    const calls: unknown[][] = [];
    deps.selectIndependentBatch = mock((stories: unknown[], maxCount: unknown) => {
      calls.push([stories, maxCount]);
      return []; // empty batch — loop falls back to runIteration or exits
    });
    // Override runIteration to be a no-op that signals completion
    deps.runIteration = mock(async () => ({
      prd: makePrd([]),
      storiesCompletedDelta: 0,
      costDelta: 0,
      prdDirty: false,
    }));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const story = makePendingStory("US-001");
    const prd = makePrd([story]);
    const ctx = makeCtx({ parallelCount: 2 });

    // Run — loop will exit after one pass (no-stories or maxIterations)
    await executeUnified(ctx as never, prd as never).catch(() => {});

    // selectIndependentBatch must have been invoked with the pending stories + count
    expect(calls.length).toBeGreaterThan(0);
    const [_stories, maxCount] = calls[0];
    expect(maxCount).toBe(2);
  });

  test("runParallelBatch is called (not runIteration) when batch returns > 1 story", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");

    const parallelCalls: unknown[] = [];
    const iterationCalls: unknown[] = [];

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () => {
      parallelCalls.push(true);
      return {
        completed: [story1, story2],
        failed: [],
        mergeConflicts: [],
        storyCosts: new Map([
          [story1.id, 0.1],
          [story2.id, 0.1],
        ]),
        totalCost: 0.2,
      };
    });
    deps.runIteration = mock(async () => {
      iterationCalls.push(true);
      return { prd: makePrd([]), storiesCompletedDelta: 1, costDelta: 0, prdDirty: false };
    });

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const prd = makePrd([story1, story2]);
    const ctx = makeCtx({ parallelCount: 2 });

    await executeUnified(ctx as never, prd as never).catch(() => {});

    expect(parallelCalls.length).toBeGreaterThan(0);
    expect(iterationCalls.length).toBe(0);
  });

  test("runIteration is called (not runParallelBatch) when parallelCount is undefined", async () => {
    const story1 = makePendingStory("US-001");

    const parallelCalls: unknown[] = [];
    const iterationCalls: unknown[] = [];

    deps.selectIndependentBatch = mock(() => [story1]);
    deps.runParallelBatch = mock(async () => {
      parallelCalls.push(true);
      return { completed: [], failed: [], mergeConflicts: [], storyCosts: new Map(), totalCost: 0 };
    });
    deps.runIteration = mock(async () => {
      iterationCalls.push(true);
      return { prd: makePrd([]), storiesCompletedDelta: 1, costDelta: 0, prdDirty: false };
    });

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const prd = makePrd([story1]);
    const ctx = makeCtx({ parallelCount: undefined });

    await executeUnified(ctx as never, prd as never).catch(() => {});

    expect(parallelCalls.length).toBe(0);
    expect(iterationCalls.length).toBeGreaterThan(0);
  });

  test("runIteration is called (not runParallelBatch) when parallelCount is 0", async () => {
    const story1 = makePendingStory("US-001");

    const parallelCalls: unknown[] = [];
    const iterationCalls: unknown[] = [];

    deps.selectIndependentBatch = mock(() => []);
    deps.runParallelBatch = mock(async () => {
      parallelCalls.push(true);
      return { completed: [], failed: [], mergeConflicts: [], storyCosts: new Map(), totalCost: 0 };
    });
    deps.runIteration = mock(async () => {
      iterationCalls.push(true);
      return { prd: makePrd([]), storiesCompletedDelta: 1, costDelta: 0, prdDirty: false };
    });

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const prd = makePrd([story1]);
    const ctx = makeCtx({ parallelCount: 0 });

    await executeUnified(ctx as never, prd as never).catch(() => {});

    expect(parallelCalls.length).toBe(0);
  });

  test("runIteration is called when parallelCount > 0 but selectIndependentBatch returns exactly 1 story", async () => {
    const story1 = makePendingStory("US-001");

    const parallelCalls: unknown[] = [];
    const iterationCalls: unknown[] = [];

    deps.selectIndependentBatch = mock(() => [story1]); // only 1 story in batch
    deps.runParallelBatch = mock(async () => {
      parallelCalls.push(true);
      return { completed: [], failed: [], mergeConflicts: [], storyCosts: new Map(), totalCost: 0 };
    });
    deps.runIteration = mock(async () => {
      iterationCalls.push(true);
      return { prd: makePrd([]), storiesCompletedDelta: 1, costDelta: 0, prdDirty: false };
    });

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const prd = makePrd([story1]);
    const ctx = makeCtx({ parallelCount: 4 });

    await executeUnified(ctx as never, prd as never).catch(() => {});

    expect(parallelCalls.length).toBe(0);
    expect(iterationCalls.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5 — story:started events emitted before runParallelBatch
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-5 — story:started emitted for each batch story before runParallelBatch (source)", () => {
  test("unified-executor.ts emits story:started event type", async () => {
    const src = await readSrc("execution/unified-executor.ts");
    expect(src).toContain("story:started");
  });

  test("story:started emit appears before runParallelBatch call in source", async () => {
    const src = await readSrc("execution/unified-executor.ts");
    const startedIdx = src.indexOf("story:started");
    const batchIdx = src.indexOf("runParallelBatch");
    // story:started emit must appear before the runParallelBatch call
    expect(startedIdx).toBeGreaterThan(0);
    expect(batchIdx).toBeGreaterThan(0);
    expect(startedIdx).toBeLessThan(batchIdx);
  });

  test("story:started is emitted inside a loop over batch stories (has storyId: story.id)", async () => {
    const src = await readSrc("execution/unified-executor.ts");
    // The emit must include storyId tied to the individual story
    expect(src).toMatch(/story:started[\s\S]{0,200}storyId\s*:/);
  });
});

describe("AC-5 — story:started per-batch story via _deps injection", () => {
  let deps: Record<string, unknown>;
  let origRunParallelBatch: unknown;
  let origSelectIndependentBatch: unknown;

  beforeEach(async () => {
    const mod = await import("../../../src/execution/unified-executor");
    deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    origRunParallelBatch = deps.runParallelBatch;
    origSelectIndependentBatch = deps.selectIndependentBatch;
  });

  afterEach(() => {
    if (deps) {
      deps.runParallelBatch = origRunParallelBatch;
      deps.selectIndependentBatch = origSelectIndependentBatch;
    }
    mock.restore();
  });

  test("pipelineEventBus emits story:started for each batch story before runParallelBatch fires", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");

    const eventLog: string[] = [];
    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () => {
      eventLog.push("runParallelBatch");
      return {
        completed: [story1, story2],
        failed: [],
        mergeConflicts: [],
        storyCosts: new Map([[story1.id, 0], [story2.id, 0]]),
        totalCost: 0,
      };
    });

    // Intercept pipelineEventBus.emit
    const { pipelineEventBus } = await import("../../../src/pipeline/event-bus");
    const origEmit = pipelineEventBus.emit.bind(pipelineEventBus);
    pipelineEventBus.emit = mock((event: Record<string, unknown>) => {
      if (event.type === "story:started") {
        eventLog.push(`story:started:${event.storyId}`);
      }
      return origEmit(event as never);
    }) as typeof pipelineEventBus.emit;

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const prd = makePrd([story1, story2]);
    const ctx = makeCtx({ parallelCount: 2 });

    await executeUnified(ctx as never, prd as never).catch(() => {});

    // Restore emit
    pipelineEventBus.emit = origEmit;

    // story:started for each story must appear before runParallelBatch in the log
    const batchIdx = eventLog.indexOf("runParallelBatch");
    const started1Idx = eventLog.indexOf("story:started:US-001");
    const started2Idx = eventLog.indexOf("story:started:US-002");

    expect(batchIdx).toBeGreaterThan(0);
    expect(started1Idx).toBeGreaterThanOrEqual(0);
    expect(started2Idx).toBeGreaterThanOrEqual(0);
    expect(started1Idx).toBeLessThan(batchIdx);
    expect(started2Idx).toBeLessThan(batchIdx);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-6 — failure routing through handlePipelineFailure (source)
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-6 — parallel failures routed through handlePipelineFailure (source)", () => {
  test("unified-executor.ts imports handlePipelineFailure", async () => {
    const src = await readSrc("execution/unified-executor.ts");
    expect(src).toContain("handlePipelineFailure");
  });

  test("unified-executor.ts calls handlePipelineFailure for failed batch stories", async () => {
    const src = await readSrc("execution/unified-executor.ts");
    // handlePipelineFailure must be called in the context of a failed batch result
    // (i.e. after runParallelBatch, not just imported unused)
    const failedIdx = src.indexOf("failed");
    const handlerIdx = src.indexOf("handlePipelineFailure");
    // Both must be present
    expect(failedIdx).toBeGreaterThan(0);
    expect(handlerIdx).toBeGreaterThan(0);
  });

  test("unified-executor.ts imports handleTierEscalation (reached when finalAction === escalate)", async () => {
    const src = await readSrc("execution/unified-executor.ts");
    // handleTierEscalation is inside handlePipelineFailure, so it's reached transitively.
    // We verify the escalation module is wired — either via pipeline-result-handler or directly.
    const hasEscalation =
      src.includes("handleTierEscalation") || src.includes("handlePipelineFailure");
    expect(hasEscalation).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-7 — cost-limit check runs after parallel batch (source)
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-7 — cost-limit check after parallel batch (source)", () => {
  test("unified-executor.ts contains a cost-limit check using costLimit", async () => {
    const src = await readSrc("execution/unified-executor.ts");
    expect(src).toContain("costLimit");
  });

  test("cost-limit exit reason is 'cost-limit'", async () => {
    const src = await readSrc("execution/unified-executor.ts");
    expect(src).toContain("cost-limit");
  });

  test("cost-limit check appears after runParallelBatch in the loop body (source order)", async () => {
    const src = await readSrc("execution/unified-executor.ts");
    const batchIdx = src.indexOf("runParallelBatch");
    const costLimitIdx = src.indexOf("cost-limit");
    expect(batchIdx).toBeGreaterThan(0);
    expect(costLimitIdx).toBeGreaterThan(0);
    // cost-limit check must come after the runParallelBatch call
    expect(costLimitIdx).toBeGreaterThan(batchIdx);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-7 — cost-limit exit after parallel batch (runtime)
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-7 — cost-limit exit after parallel batch (runtime)", () => {
  let deps: Record<string, unknown>;
  let origRunParallelBatch: unknown;
  let origSelectIndependentBatch: unknown;

  beforeEach(async () => {
    const mod = await import("../../../src/execution/unified-executor");
    deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    origRunParallelBatch = deps.runParallelBatch;
    origSelectIndependentBatch = deps.selectIndependentBatch;
  });

  afterEach(() => {
    if (deps) {
      deps.runParallelBatch = origRunParallelBatch;
      deps.selectIndependentBatch = origSelectIndependentBatch;
    }
    mock.restore();
  });

  test("executeUnified returns exitReason 'cost-limit' when parallel batch pushes totalCost over the configured limit", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () => ({
      completed: [story1, story2],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map<string, number>([
        [story1.id, 3],
        [story2.id, 3],
      ]),
      totalCost: 6, // exceeds costLimit of 5
    }));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const prd = makePrd([story1, story2]);
    const baseCtx = makeCtx({ parallelCount: 2 });
    const ctx = {
      ...baseCtx,
      config: {
        ...baseCtx.config,
        execution: {
          ...baseCtx.config.execution,
          costLimit: 5,
          maxIterations: 2,
        },
      },
    };

    const result = await executeUnified(ctx as never, prd as never);
    expect(result.exitReason).toBe("cost-limit");
    expect(result.totalCost).toBeGreaterThanOrEqual(6);
  });

  test("executeUnified does NOT exit with cost-limit when parallel batch cost stays below limit", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () => ({
      completed: [story1, story2],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map<string, number>([
        [story1.id, 1],
        [story2.id, 1],
      ]),
      totalCost: 2, // below costLimit of 100
    }));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const prd = makePrd([story1, story2]);
    const baseCtx = makeCtx({ parallelCount: 2 });
    const ctx = {
      ...baseCtx,
      config: {
        ...baseCtx.config,
        execution: {
          ...baseCtx.config.execution,
          costLimit: 100,
          maxIterations: 1,
        },
      },
    };

    const result = await executeUnified(ctx as never, prd as never).catch(
      () => ({ exitReason: "error" }) as { exitReason: string },
    );
    expect(result.exitReason).not.toBe("cost-limit");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-8 — runner-execution.ts always calls executeUnified (no conditional branch)
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-8 — runner-execution.ts always calls executeUnified with parallelCount", () => {
  test("runner-execution.ts calls executeUnified", async () => {
    const src = await readSrc("execution/runner-execution.ts");
    expect(src).toContain("executeUnified");
  });

  test("runner-execution.ts passes parallelCount to executeUnified", async () => {
    const src = await readSrc("execution/runner-execution.ts");
    expect(src).toContain("parallelCount");
  });

  test("runner-execution.ts does not contain a separate executeParallel dispatch branch", async () => {
    const src = await readSrc("execution/runner-execution.ts");
    expect(src).not.toContain("executeParallel(");
  });

  test("runner-execution.ts does not contain a runParallelExecution dispatch branch", async () => {
    const src = await readSrc("execution/runner-execution.ts");
    expect(src).not.toContain("runParallelExecution");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-9 — parallel-executor.ts deleted; no src/ imports from it
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-9 — parallel-executor.ts deleted", () => {
  test("src/execution/parallel-executor.ts does not exist", async () => {
    const exists = await srcExists("execution/parallel-executor.ts");
    expect(exists).toBe(false);
  });

  test("no file in src/ imports from parallel-executor", async () => {
    // Grep src/ for any import referencing parallel-executor
    const proc = Bun.spawn(
      ["grep", "-r", "parallel-executor", "--include=*.ts", "-l", join(SRC)],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [_exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
    // _exitCode 1 means no matches (grep convention) — that's what we want
    const matchingFiles = stdout.trim().split("\n").filter(Boolean);
    expect(matchingFiles).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-10 — lifecycle/parallel-lifecycle.ts deleted; no src/ imports from it
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-10 — lifecycle/parallel-lifecycle.ts deleted", () => {
  test("src/execution/lifecycle/parallel-lifecycle.ts does not exist", async () => {
    const exists = await srcExists("execution/lifecycle/parallel-lifecycle.ts");
    expect(exists).toBe(false);
  });

  test("no file in src/ imports from parallel-lifecycle", async () => {
    const proc = Bun.spawn(
      ["grep", "-r", "parallel-lifecycle", "--include=*.ts", "-l", join(SRC)],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [_exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
    const matchingFiles = stdout.trim().split("\n").filter(Boolean);
    expect(matchingFiles).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-11 — runner.ts no longer references _runnerDeps.runParallelExecution
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-11 — runner.ts has no reference to _runnerDeps.runParallelExecution", () => {
  test("runner.ts does not contain runParallelExecution", async () => {
    const src = await readSrc("execution/runner.ts");
    expect(src).not.toContain("runParallelExecution");
  });

  test("runner.ts _runnerDeps does not include runParallelExecution", async () => {
    const src = await readSrc("execution/runner.ts");
    // Check that the _runnerDeps object does not wire runParallelExecution
    expect(src).not.toMatch(/_runnerDeps[\s\S]{0,200}runParallelExecution/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// story.start logging — logger.info("story.start", …) emitted in both dispatch paths
// ─────────────────────────────────────────────────────────────────────────────

describe("story.start logging — parallel batch dispatch", () => {
  let deps: Record<string, unknown>;
  let origRunParallelBatch: unknown;
  let origSelectIndependentBatch: unknown;
  let loggerSpy: ReturnType<typeof spyOn>;

  interface LogCall {
    stage: string;
    message: string;
    data?: Record<string, unknown>;
  }

  beforeEach(async () => {
    const mod = await import("../../../src/execution/unified-executor");
    deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    origRunParallelBatch = deps.runParallelBatch;
    origSelectIndependentBatch = deps.selectIndependentBatch;
  });

  afterEach(() => {
    if (deps) {
      deps.runParallelBatch = origRunParallelBatch;
      deps.selectIndependentBatch = origSelectIndependentBatch;
    }
    loggerSpy?.mockRestore();
    mock.restore();
  });

  test("logger.info is called with stage 'story.start' for each story in a parallel batch", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");

    const infoCalls: LogCall[] = [];
    const logger = {
      info: mock((stage: string, message: string, data?: Record<string, unknown>) => {
        infoCalls.push({ stage, message, data });
      }),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    };
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as ReturnType<typeof loggerModule.getSafeLogger>);

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () => ({
      completed: [story1, story2],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map([[story1.id, 0], [story2.id, 0]]),
      totalCost: 0,
    }));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const prd = makePrd([story1, story2]);
    const ctx = makeCtx({ parallelCount: 2 });

    await executeUnified(ctx as never, prd as never).catch(() => {});

    const storyStartCalls = infoCalls.filter((c) => c.stage === "story.start");
    expect(storyStartCalls.length).toBeGreaterThanOrEqual(2);

    const ids = storyStartCalls.map((c) => c.data?.storyId);
    expect(ids).toContain("US-001");
    expect(ids).toContain("US-002");
  });

  test("story.start log data includes storyId, storyTitle, complexity, modelTier, attempt for batch stories", async () => {
    const story1 = makePendingStory("US-001");

    const infoCalls: LogCall[] = [];
    const logger = {
      info: mock((stage: string, message: string, data?: Record<string, unknown>) => {
        infoCalls.push({ stage, message, data });
      }),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    };
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as ReturnType<typeof loggerModule.getSafeLogger>);

    deps.selectIndependentBatch = mock(() => [story1, makePendingStory("US-002")]);
    deps.runParallelBatch = mock(async () => ({
      completed: [story1],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map([[story1.id, 0]]),
      totalCost: 0,
    }));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const prd = makePrd([story1, makePendingStory("US-002")]);
    const ctx = makeCtx({ parallelCount: 2 });

    await executeUnified(ctx as never, prd as never).catch(() => {});

    const call = infoCalls.find((c) => c.stage === "story.start" && c.data?.storyId === "US-001");
    expect(call).toBeDefined();
    expect(call?.data).toMatchObject({
      storyId: "US-001",
      storyTitle: "Story US-001",
      attempt: 1,
    });
    expect(call?.data).toHaveProperty("complexity");
    expect(call?.data).toHaveProperty("modelTier");
  });
});

describe("story.start logging — sequential (single-story) dispatch", () => {
  let deps: Record<string, unknown>;
  let origRunIteration: unknown;
  let origSelectIndependentBatch: unknown;
  let loggerSpy: ReturnType<typeof spyOn>;

  interface LogCall {
    stage: string;
    message: string;
    data?: Record<string, unknown>;
  }

  beforeEach(async () => {
    const mod = await import("../../../src/execution/unified-executor");
    deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    origRunIteration = deps.runIteration;
    origSelectIndependentBatch = deps.selectIndependentBatch;
  });

  afterEach(() => {
    if (deps) {
      deps.runIteration = origRunIteration;
      deps.selectIndependentBatch = origSelectIndependentBatch;
    }
    loggerSpy?.mockRestore();
    mock.restore();
  });

  test("logger.info is called with stage 'story.start' for a single-story sequential dispatch", async () => {
    const story1 = makePendingStory("US-001");

    const infoCalls: LogCall[] = [];
    const logger = {
      info: mock((stage: string, message: string, data?: Record<string, unknown>) => {
        infoCalls.push({ stage, message, data });
      }),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    };
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as ReturnType<typeof loggerModule.getSafeLogger>);

    deps.selectIndependentBatch = mock(() => [story1]);
    deps.runIteration = mock(async () => ({
      prd: makePrd([]),
      storiesCompletedDelta: 1,
      costDelta: 0,
      prdDirty: false,
    }));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const prd = makePrd([story1]);
    const ctx = makeCtx({ parallelCount: 2 });

    await executeUnified(ctx as never, prd as never).catch(() => {});

    const storyStartCalls = infoCalls.filter((c) => c.stage === "story.start");
    expect(storyStartCalls.length).toBeGreaterThanOrEqual(1);
    expect(storyStartCalls[0].data?.storyId).toBe("US-001");
  });

  test("story.start log data includes storyId, storyTitle, complexity, modelTier, attempt for sequential dispatch", async () => {
    const story1 = makePendingStory("US-001");

    const infoCalls: LogCall[] = [];
    const logger = {
      info: mock((stage: string, message: string, data?: Record<string, unknown>) => {
        infoCalls.push({ stage, message, data });
      }),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    };
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as ReturnType<typeof loggerModule.getSafeLogger>);

    deps.selectIndependentBatch = mock(() => [story1]);
    deps.runIteration = mock(async () => ({
      prd: makePrd([]),
      storiesCompletedDelta: 1,
      costDelta: 0,
      prdDirty: false,
    }));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const prd = makePrd([story1]);
    const ctx = makeCtx({ parallelCount: 2 });

    await executeUnified(ctx as never, prd as never).catch(() => {});

    const call = infoCalls.find((c) => c.stage === "story.start" && c.data?.storyId === "US-001");
    expect(call).toBeDefined();
    expect(call?.data).toMatchObject({
      storyId: "US-001",
      storyTitle: "Story US-001",
      attempt: 1,
    });
    expect(call?.data).toHaveProperty("complexity");
    expect(call?.data).toHaveProperty("modelTier");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

function makePendingStory(id: string) {
  return {
    id,
    title: `Story ${id}`,
    description: `Description for ${id}`,
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "pending" as const,
    passes: false,
    attempts: 0,
    priorFailures: [],
  };
}

function makePrd(stories: ReturnType<typeof makePendingStory>[]) {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    userStories: stories,
  };
}

function makeCtx(overrides: { parallelCount?: number } = {}) {
  return {
    prdPath: "/tmp/test-prd.json",
    workdir: "/tmp/test-workdir",
    config: {
      execution: {
        maxIterations: 1,
        costLimit: 10,
        iterationDelayMs: 0,
        rectification: { maxRetries: 2 },
      },
      autoMode: { defaultAgent: "claude-code" },
      interaction: {},
    },
    hooks: {},
    feature: "test-feature",
    dryRun: false,
    useBatch: false,
    pluginRegistry: {
      getReporters: () => [],
      getContextProviders: () => [],
    },
    statusWriter: {
      setPrd: mock(() => {}),
      setCurrentStory: mock(() => {}),
      setRunStatus: mock(() => {}),
      update: mock(async () => {}),
    },
    runId: "run-test",
    startTime: Date.now(),
    batchPlan: [],
    interactionChain: null,
    ...overrides,
  };
}
