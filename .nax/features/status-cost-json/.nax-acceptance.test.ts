import { describe, expect, mock, test } from "bun:test";
import { calculateAggregateMetrics, getLastRun, toCostReport } from "../../../src/metrics";
import { dispatchStatusView, emitCostReportJson } from "../../../src/cli/status";
import type { RunMetrics, StoryMetrics } from "../../../src/metrics/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKDIR = "/tmp/nax-status-cost-json-acceptance";

function makeStory(overrides: Partial<StoryMetrics> = {}): StoryMetrics {
  return {
    storyId: "US-001",
    complexity: "medium",
    modelTier: "balanced",
    modelUsed: "claude-sonnet-4.5",
    attempts: 1,
    finalTier: "balanced",
    success: true,
    cost: 0.5,
    durationMs: 1000,
    firstPassSuccess: true,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    ...overrides,
  };
}

function makeRun(stories: StoryMetrics[], overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    runId: "run-001",
    feature: "test-feature",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T01:00:00.000Z",
    totalCost: stories.reduce((s, st) => s + st.cost, 0),
    totalStories: stories.length,
    storiesCompleted: stories.length,
    storiesFailed: 0,
    totalDurationMs: 3600000,
    stories,
    ...overrides,
  };
}

const REPORT_DEPS = {
  project: "myproj",
  now: () => "2026-01-01T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// AC-1: toCostReport([], deps) returns object, does not throw
// ---------------------------------------------------------------------------

describe("AC-1: toCostReport with empty runs returns a non-null object", () => {
  test("returns non-null object without throwing", () => {
    const result = toCostReport([], REPORT_DEPS);
    expect(typeof result === "object" && result !== null).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-2: schemaVersion === '1.0'
// ---------------------------------------------------------------------------

describe("AC-2: toCostReport schemaVersion is '1.0'", () => {
  test("schemaVersion is a string equal to '1.0'", () => {
    const result = toCostReport([], REPORT_DEPS);
    expect(typeof result.schemaVersion).toBe("string");
    expect(result.schemaVersion).toBe("1.0");
  });
});

// ---------------------------------------------------------------------------
// AC-3: generatedAt equals deps.now()
// ---------------------------------------------------------------------------

describe("AC-3: toCostReport.generatedAt equals deps.now()", () => {
  test("generatedAt equals the fixed timestamp returned by deps.now", () => {
    const result = toCostReport([], {
      project: "any",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    expect(result.generatedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// AC-4: project equals deps.project
// ---------------------------------------------------------------------------

describe("AC-4: toCostReport.project equals deps.project", () => {
  test("project field equals the injected project name", () => {
    const result = toCostReport([], { project: "myproj", now: () => "2026-01-01T00:00:00.000Z" });
    expect(result.project).toBe("myproj");
  });
});

// ---------------------------------------------------------------------------
// AC-5: empty runs → aggregate null, lastRun null, modelEfficiency []
// ---------------------------------------------------------------------------

describe("AC-5: toCostReport with empty runs has null aggregate/lastRun and empty modelEfficiency", () => {
  test("aggregate is null, lastRun is null, modelEfficiency is []", () => {
    const result = toCostReport([], REPORT_DEPS);
    expect(result.aggregate).toBeNull();
    expect(result.lastRun).toBeNull();
    expect(Array.isArray(result.modelEfficiency)).toBe(true);
    expect(result.modelEfficiency.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-6: aggregate fields match calculateAggregateMetrics
// ---------------------------------------------------------------------------

describe("AC-6: toCostReport aggregate matches calculateAggregateMetrics", () => {
  test("totalRuns, totalCost, avgCostPerStory equal calculateAggregateMetrics values", () => {
    const runs = [
      makeRun([
        makeStory({ storyId: "US-001", cost: 1.0, modelUsed: "sonnet" }),
        makeStory({ storyId: "US-002", cost: 2.0, modelUsed: "haiku" }),
      ]),
    ];
    const expected = calculateAggregateMetrics(runs);
    const result = toCostReport(runs, REPORT_DEPS);
    expect(result.aggregate).not.toBeNull();
    expect(result.aggregate!.totalRuns).toBe(expected.totalRuns);
    expect(result.aggregate!.totalCost).toBe(expected.totalCost);
    expect(result.aggregate!.avgCostPerStory).toBe(expected.avgCostPerStory);
  });
});

// ---------------------------------------------------------------------------
// AC-7: lastRun runId/feature match getLastRun
// ---------------------------------------------------------------------------

describe("AC-7: toCostReport lastRun matches getLastRun", () => {
  test("lastRun.runId and lastRun.feature equal those from getLastRun(runs)", () => {
    const runs = [
      makeRun([makeStory()], { runId: "run-first", feature: "feature-first" }),
      makeRun([makeStory()], { runId: "run-last", feature: "feature-last" }),
    ];
    const last = getLastRun(runs);
    const result = toCostReport(runs, REPORT_DEPS);
    expect(result.lastRun).not.toBeNull();
    expect(result.lastRun!.runId).toBe(last!.runId);
    expect(result.lastRun!.feature).toBe(last!.feature);
  });
});

// ---------------------------------------------------------------------------
// AC-8: stories sorted desc by cost, exact keys
// ---------------------------------------------------------------------------

describe("AC-8: toCostReport lastRun stories sorted descending by cost with exact keys", () => {
  test("stories[0].cost=0.9, stories[1].cost=0.2 with keys storyId/cost/model/attempts only", () => {
    const runs = [
      makeRun([
        makeStory({ storyId: "US-001", cost: 0.2, modelUsed: "haiku", attempts: 2 }),
        makeStory({ storyId: "US-002", cost: 0.9, modelUsed: "sonnet", attempts: 1 }),
      ]),
    ];
    const result = toCostReport(runs, REPORT_DEPS);
    expect(result.lastRun).not.toBeNull();
    const stories = result.lastRun!.stories;
    expect(stories.length).toBe(2);
    expect(stories[0].cost).toBe(0.9);
    expect(stories[1].cost).toBe(0.2);
    expect(Object.keys(stories[0]).sort()).toEqual(["attempts", "cost", "model", "storyId"].sort());
    expect(Object.keys(stories[1]).sort()).toEqual(["attempts", "cost", "model", "storyId"].sort());
  });
});

// ---------------------------------------------------------------------------
// AC-9: modelEfficiency sorted desc by totalCost, exact keys
// ---------------------------------------------------------------------------

describe("AC-9: toCostReport modelEfficiency sorted descending by totalCost with exact keys", () => {
  test("modelEfficiency[0].totalCost=3.0, [1].totalCost=1.0 with keys model/attempts/passRate/avgCost/totalCost", () => {
    const runs = [
      makeRun([
        makeStory({ storyId: "S-1", cost: 1.0, modelUsed: "claude-sonnet", attempts: 1, success: true }),
        makeStory({ storyId: "S-2", cost: 1.0, modelUsed: "claude-sonnet", attempts: 1, success: true }),
        makeStory({ storyId: "S-3", cost: 1.0, modelUsed: "claude-sonnet", attempts: 1, success: true }),
        makeStory({ storyId: "H-1", cost: 1.0, modelUsed: "claude-haiku", attempts: 1, success: true }),
      ]),
    ];
    const result = toCostReport(runs, REPORT_DEPS);
    const models = result.modelEfficiency;
    expect(models.length).toBe(2);
    expect(models[0].totalCost).toBe(3.0);
    expect(models[1].totalCost).toBe(1.0);
    const expectedKeys = ["attempts", "avgCost", "model", "passRate", "totalCost"].sort();
    expect(Object.keys(models[0]).sort()).toEqual(expectedKeys);
    expect(Object.keys(models[1]).sort()).toEqual(expectedKeys);
  });
});

// ---------------------------------------------------------------------------
// AC-10: lastRun.avgCostPerStory === 0 when totalStories === 0
// ---------------------------------------------------------------------------

describe("AC-10: toCostReport lastRun.avgCostPerStory is 0 (not NaN) when totalStories is 0", () => {
  test("avgCostPerStory equals 0 and is not NaN for a run with no stories", () => {
    const runs = [makeRun([])];
    const result = toCostReport(runs, REPORT_DEPS);
    expect(result.lastRun).not.toBeNull();
    expect(result.lastRun!.avgCostPerStory).toBe(0);
    expect(Number.isNaN(result.lastRun!.avgCostPerStory)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-11: no internal fields in aggregate, lastRun, or lastRun.stories
// ---------------------------------------------------------------------------

describe("AC-11: internal fields do not appear in CostReportV1 output", () => {
  test("aggregate, lastRun, and each story lack totalTokens/context/pollution/complexityAccuracy/fallback", () => {
    const runs = [
      makeRun([
        makeStory({ storyId: "US-001", cost: 0.5, modelUsed: "sonnet", attempts: 1 }),
      ]),
    ];
    const result = toCostReport(runs, REPORT_DEPS);
    expect(result.aggregate).not.toBeNull();
    expect(result.lastRun).not.toBeNull();
    const banned = ["totalTokens", "context", "pollution", "complexityAccuracy", "fallback"];
    for (const key of banned) {
      expect(key in result.aggregate!).toBe(false);
      expect(key in result.lastRun!).toBe(false);
    }
    for (const story of result.lastRun!.stories) {
      for (const key of banned) {
        expect(key in story).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AC-12: emitCostReportJson is importable from @/cli/status and is a function
// ---------------------------------------------------------------------------

describe("AC-12: emitCostReportJson is importable from @/cli/status", () => {
  test("emitCostReportJson is a function", async () => {
    const mod = await import("../../../src/cli/status");
    expect(typeof mod.emitCostReportJson).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// AC-13: stdout spy called once with JSON parseable to schemaVersion '1.0'
// ---------------------------------------------------------------------------

describe("AC-13: emitCostReportJson emits JSON with schemaVersion '1.0' to stdout", () => {
  test("stdout called once with a JSON string whose schemaVersion is '1.0'", async () => {
    const runs = [makeRun([makeStory()])];
    const stdoutSpy = mock((_s: string) => {});
    const deps = {
      loadRuns: mock(async (_outputDir: string) => runs),
      stdout: stdoutSpy,
    };
    await emitCostReportJson(WORKDIR, deps);
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const output = stdoutSpy.mock.calls[0][0] as string;
    expect(typeof output).toBe("string");
    const parsed = JSON.parse(output);
    expect(parsed.schemaVersion).toBe("1.0");
  });
});

// ---------------------------------------------------------------------------
// AC-14: injected toCostReport spy called with the runs from loadRuns (seam)
// ---------------------------------------------------------------------------

describe("AC-14: emitCostReportJson calls injected toCostReport with loaded runs", () => {
  test("toCostReport spy invoked exactly once with the runs array from loadRuns", async () => {
    const loadRunsResult = [makeRun([makeStory({ storyId: "US-seam" })])];
    const toCostReportSpy = mock((_r: RunMetrics[]) => ({
      schemaVersion: "1.0" as const,
      project: "test",
      generatedAt: "2026-01-01T00:00:00.000Z",
      aggregate: null,
      lastRun: null,
      modelEfficiency: [],
    }));
    const deps = {
      loadRuns: mock(async (_outputDir: string) => loadRunsResult),
      toCostReport: toCostReportSpy,
      stdout: mock((_s: string) => {}),
    };
    await emitCostReportJson(WORKDIR, deps);
    expect(toCostReportSpy).toHaveBeenCalledTimes(1);
    expect(toCostReportSpy).toHaveBeenCalledWith(loadRunsResult);
  });
});

// ---------------------------------------------------------------------------
// AC-15: empty loadRuns resolves without throwing, stdout emits aggregate null
// ---------------------------------------------------------------------------

describe("AC-15: emitCostReportJson with empty loadRuns resolves and emits aggregate:null", () => {
  test("resolves to undefined, stdout emits aggregate null and empty modelEfficiency", async () => {
    const stdoutSpy = mock((_s: string) => {});
    const deps = {
      loadRuns: mock(async (_outputDir: string) => [] as RunMetrics[]),
      stdout: stdoutSpy,
    };
    await expect(emitCostReportJson(WORKDIR, deps)).resolves.toBeUndefined();
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(stdoutSpy.mock.calls[0][0] as string);
    expect(parsed.aggregate).toBeNull();
    expect(parsed.modelEfficiency).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC-16: stdout string round-trips and ends with newline
// ---------------------------------------------------------------------------

describe("AC-16: emitCostReportJson stdout round-trips and ends with newline", () => {
  test("JSON.parse of stdout deep-equals the injected report and string ends with '\\n'", async () => {
    const fixedReport = {
      schemaVersion: "1.0" as const,
      project: "test",
      generatedAt: "2026-01-01T00:00:00.000Z",
      aggregate: null,
      lastRun: null,
      modelEfficiency: [] as never[],
    };
    const stdoutSpy = mock((_s: string) => {});
    const deps = {
      loadRuns: mock(async (_outputDir: string) => [] as RunMetrics[]),
      toCostReport: mock(async (_r: RunMetrics[]) => fixedReport),
      stdout: stdoutSpy,
    };
    await emitCostReportJson(WORKDIR, deps);
    const output = stdoutSpy.mock.calls[0][0] as string;
    expect(JSON.parse(output)).toEqual(fixedReport);
    expect(output.endsWith("\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-17: dispatchStatusView({ cost: true, json: true, last: true }) → emitCostReportJson
// ---------------------------------------------------------------------------

describe("AC-17: dispatchStatusView json+cost+last routes to emitCostReportJson only", () => {
  test("emitCostReportJson called once, displayLastRunMetrics not called", () => {
    const emitSpy = mock(async (_w: string) => {});
    const displayLastSpy = mock(async (_w: string) => {});
    const _deps = {
      emitCostReportJson: emitSpy,
      displayLastRunMetrics: displayLastSpy,
      displayModelEfficiency: mock(async (_w: string) => {}),
      displayFeatureStatus: mock(async (_w: string, _opts?: unknown) => {}),
      displayCostMetrics: mock(async (_w: string) => {}),
    };
    dispatchStatusView(WORKDIR, { cost: true, json: true, last: true }, _deps);
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(displayLastSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-18: dispatchStatusView({ cost: true, json: true, model: true }) → emitCostReportJson
// ---------------------------------------------------------------------------

describe("AC-18: dispatchStatusView json+cost+model routes to emitCostReportJson only", () => {
  test("emitCostReportJson called once, displayModelEfficiency not called", () => {
    const emitSpy = mock(async (_w: string) => {});
    const displayModelSpy = mock(async (_w: string) => {});
    const _deps = {
      emitCostReportJson: emitSpy,
      displayModelEfficiency: displayModelSpy,
      displayLastRunMetrics: mock(async (_w: string) => {}),
      displayFeatureStatus: mock(async (_w: string, _opts?: unknown) => {}),
      displayCostMetrics: mock(async (_w: string) => {}),
    };
    dispatchStatusView(WORKDIR, { cost: true, json: true, model: true }, _deps);
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(displayModelSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-19: dispatchStatusView({ cost: false, json: true }) → displayFeatureStatus
// ---------------------------------------------------------------------------

describe("AC-19: dispatchStatusView json without cost falls through to displayFeatureStatus", () => {
  test("displayFeatureStatus called once, emitCostReportJson not called", () => {
    const displayFeatureSpy = mock(async (_w: string, _opts?: unknown) => {});
    const emitSpy = mock(async (_w: string) => {});
    const _deps = {
      emitCostReportJson: emitSpy,
      displayFeatureStatus: displayFeatureSpy,
      displayCostMetrics: mock(async (_w: string) => {}),
      displayLastRunMetrics: mock(async (_w: string) => {}),
      displayModelEfficiency: mock(async (_w: string) => {}),
    };
    dispatchStatusView(WORKDIR, { cost: false, json: true }, _deps);
    expect(displayFeatureSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-20: emitCostReportJson propagates loadRuns I/O error
// ---------------------------------------------------------------------------

describe("AC-20: emitCostReportJson propagates loadRuns I/O errors", () => {
  test("rejects with the same error when loadRuns rejects", async () => {
    const ioError = new Error("ENOENT: run archive not found");
    const deps = {
      loadRuns: mock(async (_outputDir: string) => {
        throw ioError;
      }),
      stdout: mock((_s: string) => {}),
    };
    await expect(emitCostReportJson(WORKDIR, deps)).rejects.toThrow(ioError);
  });
});