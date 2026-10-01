/**
 * Tests for src/bakeoff/pipeline-adapter.ts
 *
 * Covers the "Adapt contestant contexts to real runs" story (US-003): the
 * pipeline adapter maps a `ContestantRunContext` onto a real `Runner.run()`
 * invocation and normalizes the result + `metrics.json` history back into a
 * `ContestantPipelineResult`.
 */

import { describe, expect, it, mock } from "bun:test";
import { makeNaxConfig, withDepsRestore } from "@test/helpers";
import type { ContestantRunContext } from "@/bakeoff";
import { _pipelineAdapterDeps, pipeline } from "@/bakeoff";
import type { RunOptions, RunResult } from "@/execution";
import type { RunMetrics } from "@/metrics";

withDepsRestore(_pipelineAdapterDeps, ["run", "loadRunMetrics"]);

function baseContext(overrides: Partial<ContestantRunContext> = {}): ContestantRunContext {
  const outputDir = "/tmp/bakeoff-out/bakeoff/my-feature/claude";
  const worktree = "/tmp/bakeoff-wt/bakeoff-contestant-claude";
  return {
    profile: "claude",
    config: makeNaxConfig({ outputDir }),
    worktree,
    outputDir,
    feature: "my-feature",
    ...overrides,
  };
}

function stubRun(overrides: Partial<RunResult> = {}) {
  const runSpy = mock(
    (_options: RunOptions): Promise<RunResult> =>
      Promise.resolve({
        success: true,
        iterations: 1,
        storiesCompleted: 0,
        totalCost: 0,
        durationMs: 0,
        ...overrides,
      }),
  );
  _pipelineAdapterDeps.run = runSpy;
  return runSpy;
}

function stubLoadRunMetrics(runs: RunMetrics[] = []) {
  const loadRunMetricsSpy = mock((_outputDir: string): Promise<RunMetrics[]> => Promise.resolve(runs));
  _pipelineAdapterDeps.loadRunMetrics = loadRunMetricsSpy;
  return loadRunMetricsSpy;
}

function makeStoryMetric(overrides: Partial<RunMetrics["stories"][number]> = {}): RunMetrics["stories"][number] {
  return {
    storyId: "s1",
    complexity: "low",
    modelTier: "fast",
    modelUsed: "m",
    attempts: 1,
    finalTier: "fast",
    success: true,
    cost: 0,
    durationMs: 0,
    firstPassSuccess: true,
    startedAt: "",
    completedAt: "",
    ...overrides,
  };
}

function makeRunMetrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    runId: "run-1",
    feature: "my-feature",
    startedAt: "",
    completedAt: "",
    totalCost: 0,
    totalStories: 0,
    storiesCompleted: 0,
    storiesFailed: 0,
    totalDurationMs: 0,
    stories: [],
    ...overrides,
  };
}

describe("pipeline (US-003 AC2-AC6: run() option mapping)", () => {
  it("AC2: workdir equals the context worktree", async () => {
    const ctx = baseContext();
    const runSpy = stubRun();
    stubLoadRunMetrics();

    await pipeline(ctx);

    expect(runSpy.mock.calls[0][0].workdir).toBe(ctx.worktree);
  });

  it("AC3: prdPath is located inside the context worktree", async () => {
    const ctx = baseContext();
    const runSpy = stubRun();
    stubLoadRunMetrics();

    await pipeline(ctx);

    expect(runSpy.mock.calls[0][0].prdPath.startsWith(ctx.worktree)).toBe(true);
  });

  it("AC4: prdPath names the context feature", async () => {
    const ctx = baseContext();
    const runSpy = stubRun();
    stubLoadRunMetrics();

    await pipeline(ctx);

    expect(runSpy.mock.calls[0][0].prdPath.includes(ctx.feature)).toBe(true);
  });

  it("AC5: statusFile is located inside the context outputDir", async () => {
    const ctx = baseContext();
    const runSpy = stubRun();
    stubLoadRunMetrics();

    await pipeline(ctx);

    expect(runSpy.mock.calls[0][0].statusFile.startsWith(ctx.outputDir)).toBe(true);
  });

  it("AC6: config equals the context config", async () => {
    const ctx = baseContext();
    const runSpy = stubRun();
    stubLoadRunMetrics();

    await pipeline(ctx);

    expect(runSpy.mock.calls[0][0].config).toEqual(ctx.config);
  });
});

describe("pipeline (US-003 AC7: results length)", () => {
  it("AC7: returns a results array whose length equals storiesCompleted", async () => {
    const ctx = baseContext();
    stubRun({ storiesCompleted: 3 });
    stubLoadRunMetrics();

    const result = await pipeline(ctx);

    expect(result.results.length).toBe(3);
  });

  it("AC7 (boundary): storiesCompleted of zero yields an empty results array", async () => {
    const ctx = baseContext();
    stubRun({ storiesCompleted: 0 });
    stubLoadRunMetrics();

    const result = await pipeline(ctx);

    expect(result.results.length).toBe(0);
  });
});

describe("pipeline (US-003 AC7: per-story status from run metrics)", () => {
  it("labels each story from its own success flag, not the overall result.success", async () => {
    const ctx = baseContext();
    // Partial-progress run: 2 of 5 stories passed before the run stopped,
    // so the overall result is unsuccessful even though those 2 stories did pass.
    stubRun({ success: false, storiesCompleted: 2 });
    stubLoadRunMetrics([
      makeRunMetrics({
        stories: [makeStoryMetric({ storyId: "s1", success: true }), makeStoryMetric({ storyId: "s2", success: true })],
      }),
    ]);

    const result = await pipeline(ctx);

    expect(result.results).toEqual([{ status: "passed" }, { status: "passed" }]);
  });

  it("falls back to the uniform result.success label when run metrics carry no stories", async () => {
    const ctx = baseContext();
    stubRun({ success: false, storiesCompleted: 2 });
    stubLoadRunMetrics([]);

    const result = await pipeline(ctx);

    expect(result.results).toEqual([{ status: "failed" }, { status: "failed" }]);
  });
});

describe("pipeline (US-003 AC8: loadRunMetrics invocation)", () => {
  it("AC8: invokes loadRunMetrics with the context outputDir", async () => {
    const ctx = baseContext();
    stubRun();
    const loadRunMetricsSpy = stubLoadRunMetrics();

    await pipeline(ctx);

    expect(loadRunMetricsSpy).toHaveBeenCalledWith(ctx.outputDir);
  });
});

describe("pipeline (US-003 AC9: per-story metrics)", () => {
  it("AC9: returns one metrics entry per story metric, carrying its cost and duration", async () => {
    const ctx = baseContext();
    stubRun({ storiesCompleted: 2 });
    stubLoadRunMetrics([
      makeRunMetrics({
        totalCost: 3,
        totalStories: 2,
        storiesCompleted: 2,
        totalDurationMs: 500,
        stories: [
          makeStoryMetric({ storyId: "s1", cost: 1, durationMs: 100 }),
          makeStoryMetric({ storyId: "s2", cost: 2, durationMs: 400, attempts: 2, firstPassSuccess: false }),
        ],
      }),
    ]);

    const result = await pipeline(ctx);

    expect(result.metrics.length).toBe(2);
    expect(result.metrics[0]).toMatchObject({ cost: 1, durationMs: 100 });
    expect(result.metrics[1]).toMatchObject({ cost: 2, durationMs: 400 });
  });
});

describe("pipeline (US-003 AC10: fallback metrics)", () => {
  it("AC10: when loadRunMetrics yields no entries, returns one metrics entry derived from totalCost/durationMs", async () => {
    const ctx = baseContext();
    stubRun({
      storiesCompleted: 1,
      totalCost: 7.5,
      durationMs: 12345,
    });
    stubLoadRunMetrics([]);

    const result = await pipeline(ctx);

    expect(result.metrics.length).toBe(1);
    expect(result.metrics[0]).toMatchObject({ cost: 7.5, durationMs: 12345 });
  });
});
