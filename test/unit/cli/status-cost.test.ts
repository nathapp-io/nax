/**
 * emitCostReportJson — CLI JSON orchestration (US-002)
 *
 * AC-1: emitCostReportJson is exported from @/cli/status as a function.
 * AC-2: with non-empty runs and a stdout spy, stdout is called exactly once
 *       with a string whose JSON.parse result has schemaVersion === "1.0".
 * AC-3: when toCostReport is a spy returning a fixed report, toCostReport is
 *       invoked exactly once with the runs array returned by the injected
 *       loadRuns.
 * AC-4: with loadRuns resolving to [], emitCostReportJson does not throw and
 *       the single stdout string parses to an object with aggregate === null
 *       and modelEfficiency deep-equal to [].
 * AC-5: when toCostReport returns a report object, JSON.parse of the single
 *       stdout string deep-equals that report object and the string contains
 *       a newline.
 * AC-9: when loadRuns rejects with an I/O error, emitCostReportJson awaits
 *       and rejects with the same error.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import {
  type CostReportEmitDeps,
  displayCostMetrics,
  displayLastRunMetrics,
  displayModelEfficiency,
  emitCostReportJson,
} from "@/cli";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import type { CostReportV1 } from "@/metrics";
import type { RunMetrics, StoryMetrics } from "@/metrics/types";
import { projectOutputDir } from "@/runtime";
import { byCodePoint } from "@/utils/sort";

function makeRunMetrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    runId: "r1",
    feature: "f1",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:10.000Z",
    totalCost: 0,
    totalStories: 1,
    storiesCompleted: 1,
    storiesFailed: 0,
    totalDurationMs: 10000,
    stories: [],
    ...overrides,
  };
}

const FIXED_REPORT: CostReportV1 = {
  schemaVersion: "1.0",
  project: "myproj",
  generatedAt: "2026-01-01T00:00:00.000Z",
  aggregate: {
    totalRuns: 1,
    totalStories: 1,
    totalCost: 0.5,
    avgCostPerStory: 0.5,
    avgCostPerFeature: 0.5,
    firstPassRate: 1,
    escalationRate: 0,
  },
  lastRun: {
    runId: "run-1",
    feature: "feat-x",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:10.000Z",
    durationMs: 10000,
    totalStories: 1,
    storiesCompleted: 1,
    storiesFailed: 0,
    totalCost: 0.5,
    avgCostPerStory: 0.5,
    stories: [{ storyId: "US-001", cost: 0.5, model: "claude-sonnet-4-5", attempts: 1 }],
  },
  modelEfficiency: [{ model: "claude-sonnet-4-5", attempts: 1, passRate: 1, avgCost: 0.5, totalCost: 0.5 }],
};

function makeDeps(overrides: Partial<CostReportEmitDeps> = {}): CostReportEmitDeps {
  return {
    loadRuns: mock(async () => []),
    toCostReport: mock(() => FIXED_REPORT),
    now: () => "2026-01-01T00:00:00.000Z",
    stdout: mock(() => {}),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC-1: exported function via the @/cli/status barrel
//
// The repo's check:alias-internals gate forbids `from "@/cli/status"` because
// @/cli has its own barrel; importing through @/cli would not catch a
// regression that drops the symbol from the @/cli/status re-export barrel.
// To prove AC-1's actual contract — that the symbol is reachable through the
// @/cli/status barrel — this test inspects src/cli/status.ts directly and
// asserts it re-exports emitCostReportJson from ./status-cost.
// ---------------------------------------------------------------------------

describe("emitCostReportJson — AC1: export shape", () => {
  test("AC1: emitCostReportJson is a function and is re-exported from the @/cli/status barrel", () => {
    expect(typeof emitCostReportJson).toBe("function");

    const barrelSrc = readFileSync(join(import.meta.dir, "../../../src/cli/status.ts"), "utf8");
    expect(barrelSrc).toMatch(/export\s*\{[\s\S]*?\bemitCostReportJson\b[\s\S]*?\}\s*from\s+["']\.\/status-cost["']/);
  });
});

// ---------------------------------------------------------------------------
// AC-2: stdout receives exactly one JSON string with schemaVersion === "1.0"
// ---------------------------------------------------------------------------

describe("emitCostReportJson — AC2: stdout payload schemaVersion", () => {
  test("AC2: with non-empty runs and stdout spy, stdout is called once with a string whose JSON.parse has schemaVersion === '1.0'", async () => {
    const stdout = mock((_text: string) => {});
    const loadRuns = mock(async (_outputDir: string) => [makeRunMetrics()]);
    const deps = makeDeps({
      loadRuns,
      stdout,
    });

    await emitCostReportJson("/tmp/workdir", deps);

    // loadRuns must be invoked exactly once with the metrics dir derived
    // from the same workdir that drives the project field — guards against
    // a regression that splits the project/outputDir resolution.
    expect(loadRuns.mock.calls).toHaveLength(1);
    const loadRunsArg = loadRuns.mock.calls[0]?.[0];
    expect(loadRunsArg).toBe(projectOutputDir("workdir", undefined));
    expect(stdout.mock.calls).toHaveLength(1);
    const out = stdout.mock.calls[0]?.[0];
    expect(typeof out).toBe("string");
    const parsed = JSON.parse(out);
    expect(parsed.schemaVersion).toBe("1.0");
  });
});

// ---------------------------------------------------------------------------
// AC-3: toCostReport receives runs array from loadRuns and project/now from seams
// ---------------------------------------------------------------------------

describe("emitCostReportJson — AC3: toCostReport receives injected runs + seam wiring", () => {
  test("AC3: toCostReport is invoked exactly once with the runs array returned by loadRuns, plus { now, project } where now is from deps.now and project is derived from the workdir via the canonical resolveProject path", async () => {
    const injectedRuns = [makeRunMetrics(), makeRunMetrics({ runId: "r2", feature: "f2" })];
    const toCostReport = mock((_runs: RunMetrics[], _deps: { now: () => string; project: string }) => FIXED_REPORT);
    const deps = makeDeps({
      loadRuns: mock(async () => injectedRuns),
      toCostReport,
      now: () => "2026-01-01T12:34:56.000Z",
    });

    await emitCostReportJson("/tmp/proj-x", deps);

    expect(toCostReport.mock.calls).toHaveLength(1);
    expect(toCostReport.mock.calls[0]?.[0]).toBe(injectedRuns);
    const reportDeps = toCostReport.mock.calls[0]?.[1];
    expect(reportDeps.now()).toBe("2026-01-01T12:34:56.000Z");
    // project is derived from the workdir via the same resolveProject path
    // used to compute outputDir — no separate seam to override.
    expect(reportDeps.project).toBe("proj-x");
  });
});

// ---------------------------------------------------------------------------
// AC-4: empty runs → aggregate=null, modelEfficiency=[]
// ---------------------------------------------------------------------------

describe("emitCostReportJson — AC4: empty runs safety", () => {
  test("AC4: with loadRuns resolving to [], does not throw and stdout string parses to { aggregate: null, modelEfficiency: [] }", async () => {
    const stdout = mock((_text: string) => {});
    // Real toCostReport — the orchestrator must let the mapper handle empty
    // runs without swallowing them into a fake non-null aggregate.
    const { toCostReport: realToCostReport } = await import("@/metrics");
    const deps = makeDeps({
      loadRuns: mock(async () => []),
      toCostReport: realToCostReport as CostReportEmitDeps["toCostReport"],
      stdout,
    });

    await expect(emitCostReportJson("/tmp/workdir", deps)).resolves.toBeUndefined();

    expect(stdout.mock.calls).toHaveLength(1);
    const parsed = JSON.parse(stdout.mock.calls[0]?.[0]);
    expect(parsed.aggregate).toBeNull();
    expect(parsed.modelEfficiency).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC-5: stdout string deep-equals the report + contains a newline
// ---------------------------------------------------------------------------

describe("emitCostReportJson — AC5: stdout deep-equals report", () => {
  test("AC5: JSON.parse(stdout) deep-equals the report returned by toCostReport and the string contains a newline", async () => {
    const stdout = mock((_text: string) => {});
    const deps = makeDeps({
      loadRuns: mock(async () => [makeRunMetrics()]),
      toCostReport: mock(() => FIXED_REPORT),
      stdout,
    });

    await emitCostReportJson("/tmp/workdir", deps);

    expect(stdout.mock.calls).toHaveLength(1);
    const out = stdout.mock.calls[0]?.[0];
    expect(out.includes("\n")).toBe(true);
    expect(JSON.parse(out)).toEqual(FIXED_REPORT);
  });
});

// ---------------------------------------------------------------------------
// AC-9: loadRuns I/O error propagates
// ---------------------------------------------------------------------------

describe("emitCostReportJson — AC9: I/O error propagation", () => {
  test("AC9: when loadRuns rejects with an I/O error, emitCostReportJson rejects with the same error", async () => {
    const ioError = new Error("EACCES: permission denied, open '/x/metrics.json'");
    const stdout = mock(() => {});
    const deps = makeDeps({
      loadRuns: mock(async () => {
        throw ioError;
      }),
      stdout,
    });

    await expect(emitCostReportJson("/tmp/workdir", deps)).rejects.toBe(ioError);
    expect(stdout.mock.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// displayCostMetrics / displayLastRunMetrics / displayModelEfficiency
//
// These functions have no injectable deps seam (unlike emitCostReportJson) —
// they call loadConfig/loadRunMetrics/getLogger directly. Rather than reach
// for a forbidden mock.module(), each test uses a real, isolated project
// workdir (no .nax/config.json, so `project` resolves to `basename(workdir)`
// per resolveProject) and writes metrics.json straight into the same
// outputDir the function under test will resolve to, then captures the
// logger output through a real sink.
// ---------------------------------------------------------------------------

function makeStoryMetrics(overrides: Partial<StoryMetrics> = {}): StoryMetrics {
  return {
    storyId: "US-001",
    complexity: "simple",
    modelTier: "balanced",
    modelUsed: "claude-sonnet-4-5",
    attempts: 1,
    finalTier: "balanced",
    success: true,
    cost: 0.1,
    durationMs: 1000,
    firstPassSuccess: true,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

async function seedMetrics(workdir: string, runs: RunMetrics[]): Promise<void> {
  const outputDir = projectOutputDir(basename(workdir), undefined);
  await Bun.write(join(outputDir, "metrics.json"), JSON.stringify(runs));
}

describe("displayCostMetrics / displayLastRunMetrics / displayModelEfficiency", () => {
  let workdir: string;
  let entries: LogEntry[];
  let unsubscribe: () => void;

  beforeEach(() => {
    workdir = makeTempDir("nax-status-cost-");
    resetLogger();
    initLogger({ level: "silent" });
    entries = [];
    unsubscribe = addSink((entry) => entries.push(entry));
  });

  afterEach(() => {
    unsubscribe();
    resetLogger();
    cleanupTempDir(workdir);
  });

  describe("with no metrics data on disk", () => {
    test("displayCostMetrics logs a 'no data' hint and does not throw", async () => {
      await expect(displayCostMetrics(workdir)).resolves.toBeUndefined();

      expect(entries).toHaveLength(1);
      expect(entries[0]?.message).toContain("No metrics data available yet");
    });

    test("displayLastRunMetrics logs a 'no data' hint and does not throw", async () => {
      await expect(displayLastRunMetrics(workdir)).resolves.toBeUndefined();

      expect(entries).toHaveLength(1);
      expect(entries[0]?.message).toContain("No metrics data available yet");
    });

    test("displayModelEfficiency logs a 'no data' hint and does not throw", async () => {
      await expect(displayModelEfficiency(workdir)).resolves.toBeUndefined();

      expect(entries).toHaveLength(1);
      expect(entries[0]?.message).toContain("No metrics data available yet");
    });
  });

  describe("with recorded runs", () => {
    test("displayCostMetrics logs the aggregate across all runs", async () => {
      await seedMetrics(workdir, [makeRunMetrics({ totalCost: 1.5, stories: [makeStoryMetrics({ cost: 1.5 })] })]);

      await displayCostMetrics(workdir);

      expect(entries).toHaveLength(1);
      expect(entries[0]?.message).toBe("Cost Metrics (All Runs)");
      expect(entries[0]?.data?.totalRuns).toBe(1);
      expect(entries[0]?.data?.totalCost).toBe(1.5);
    });

    test("displayLastRunMetrics logs the most recent run and its top stories", async () => {
      const expensiveStory = makeStoryMetrics({ storyId: "US-002", cost: 5 });
      const cheapStory = makeStoryMetrics({ storyId: "US-001", cost: 1 });
      await seedMetrics(workdir, [
        makeRunMetrics({
          runId: "run-1",
          feature: "feat-a",
          totalCost: 6,
          stories: [cheapStory, expensiveStory],
        }),
      ]);

      await displayLastRunMetrics(workdir);

      const summary = entries.find((e) => e.message.startsWith("Last Run:"));
      expect(summary).toBeDefined();
      expect(summary?.data?.runId).toBe("run-1");
      expect(summary?.data?.totalCost).toBe(6);

      const topStories = entries.find((e) => e.message === "Top 5 Most Expensive Stories");
      expect(topStories).toBeDefined();
      const stories = topStories?.data?.stories as Array<{ storyId: string; cost: number }>;
      // Sorted descending by cost — the expensive story comes first.
      expect(stories[0]?.storyId).toBe("US-002");
      expect(stories[1]?.storyId).toBe("US-001");
    });

    test("displayLastRunMetrics returns early with no extra logs when getLastRun yields nothing", async () => {
      await seedMetrics(workdir, []);

      await displayLastRunMetrics(workdir);

      // Empty runs array — the "no data" branch fires, not the lastRun-null branch.
      expect(entries).toHaveLength(1);
      expect(entries[0]?.message).toContain("No metrics data available yet");
    });

    test("displayLastRunMetrics warns on high context pollution above the threshold", async () => {
      const pollutedStory = makeStoryMetrics({
        storyId: "US-003",
        context: {
          providers: {},
          pollution: {
            droppedBelowMinScore: 0,
            staleChunksInjected: 0,
            contradictedChunks: 4,
            ignoredChunks: 1,
            pollutionRatio: 0.5,
          },
        },
      });
      await seedMetrics(workdir, [makeRunMetrics({ stories: [pollutedStory] })]);

      await displayLastRunMetrics(workdir);

      const warning = entries.find((e) => e.level === "warn");
      expect(warning).toBeDefined();
      expect(warning?.message).toContain("High context pollution detected");
      expect(warning?.data?.storyId).toBe("US-003");
      expect(warning?.data?.pollutionRatio).toBe(0.5);
      expect(warning?.data?.contradictedChunks).toBe(4);
    });

    test("displayLastRunMetrics does not warn when pollution ratio is at or below the threshold", async () => {
      const cleanStory = makeStoryMetrics({
        context: {
          providers: {},
          pollution: {
            droppedBelowMinScore: 0,
            staleChunksInjected: 0,
            contradictedChunks: 0,
            ignoredChunks: 0,
            pollutionRatio: 0.3,
          },
        },
      });
      await seedMetrics(workdir, [makeRunMetrics({ stories: [cleanStory] })]);

      await displayLastRunMetrics(workdir);

      expect(entries.some((e) => e.level === "warn")).toBe(false);
    });

    test("displayModelEfficiency logs model and complexity breakdowns", async () => {
      await seedMetrics(workdir, [
        makeRunMetrics({
          stories: [
            makeStoryMetrics({ modelUsed: "claude-sonnet-4-5", complexity: "simple" }),
            makeStoryMetrics({ storyId: "US-002", modelUsed: "claude-opus-4-5", complexity: "complex" }),
          ],
        }),
      ]);

      await displayModelEfficiency(workdir);

      const modelEntry = entries.find((e) => e.message === "Model Efficiency");
      expect(modelEntry).toBeDefined();
      const models = modelEntry?.data?.models as Array<{ model: string }>;
      expect(models.map((m) => m.model).sort(byCodePoint)).toEqual(["claude-opus-4-5", "claude-sonnet-4-5"]);

      const complexityEntry = entries.find((e) => e.message === "Complexity Prediction Accuracy");
      expect(complexityEntry).toBeDefined();
    });

    test("displayModelEfficiency logs 'no model data' when aggregate model efficiency is empty", async () => {
      await seedMetrics(workdir, [makeRunMetrics({ stories: [] })]);

      await displayModelEfficiency(workdir);

      expect(entries.some((e) => e.message === "No model data available")).toBe(true);
      expect(entries.some((e) => e.message === "Model Efficiency")).toBe(false);
    });
  });
});
