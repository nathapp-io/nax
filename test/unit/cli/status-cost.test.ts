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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";
import { emitCostReportJson, type CostReportEmitDeps } from "@/cli";
import type { CostReportV1 } from "@/metrics";

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
  modelEfficiency: [
    { model: "claude-sonnet-4-5", attempts: 1, passRate: 1, avgCost: 0.5, totalCost: 0.5 },
  ],
};

function makeDeps(overrides: Partial<CostReportEmitDeps> = {}): CostReportEmitDeps {
  return {
    loadRuns: mock(async () => []),
    resolveProject: mock(async () => "myproj"),
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

    const barrelSrc = readFileSync(
      join(import.meta.dir, "../../../src/cli/status.ts"),
      "utf8",
    );
    expect(barrelSrc).toMatch(/export\s*\{[\s\S]*?\bemitCostReportJson\b[\s\S]*?\}\s*from\s+["']\.\/status-cost["']/);
  });
});

// ---------------------------------------------------------------------------
// AC-2: stdout receives exactly one JSON string with schemaVersion === "1.0"
// ---------------------------------------------------------------------------

describe("emitCostReportJson — AC2: stdout payload schemaVersion", () => {
  test("AC2: with non-empty runs and stdout spy, stdout is called once with a string whose JSON.parse has schemaVersion === '1.0'", async () => {
    const stdout = mock(() => {});
    const deps = makeDeps({
      loadRuns: mock(async () => [{ runId: "r1", feature: "f1" }] as never),
      stdout,
    });

    await emitCostReportJson("/tmp/workdir", deps);

    expect(stdout.mock.calls).toHaveLength(1);
    const out = stdout.mock.calls[0]?.[0];
    expect(typeof out).toBe("string");
    const parsed = JSON.parse(out as string);
    expect(parsed.schemaVersion).toBe("1.0");
  });
});

// ---------------------------------------------------------------------------
// AC-3: toCostReport receives runs array from loadRuns
// ---------------------------------------------------------------------------

describe("emitCostReportJson — AC3: toCostReport receives injected runs", () => {
  test("AC3: toCostReport is invoked exactly once with the runs array returned by loadRuns", async () => {
    const injectedRuns = [{ runId: "r1", feature: "f1" }, { runId: "r2", feature: "f2" }] as never;
    const toCostReport = mock(() => FIXED_REPORT);
    const deps = makeDeps({
      loadRuns: mock(async () => injectedRuns),
      toCostReport,
    });

    await emitCostReportJson("/tmp/workdir", deps);

    expect(toCostReport.mock.calls).toHaveLength(1);
    expect(toCostReport.mock.calls[0]?.[0]).toBe(injectedRuns);
  });
});

// ---------------------------------------------------------------------------
// AC-4: empty runs → aggregate=null, modelEfficiency=[]
// ---------------------------------------------------------------------------

describe("emitCostReportJson — AC4: empty runs safety", () => {
  test("AC4: with loadRuns resolving to [], does not throw and stdout string parses to { aggregate: null, modelEfficiency: [] }", async () => {
    const stdout = mock(() => {});
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
    const parsed = JSON.parse(stdout.mock.calls[0]?.[0] as string);
    expect(parsed.aggregate).toBeNull();
    expect(parsed.modelEfficiency).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC-5: stdout string deep-equals the report + contains a newline
// ---------------------------------------------------------------------------

describe("emitCostReportJson — AC5: stdout deep-equals report", () => {
  test("AC5: JSON.parse(stdout) deep-equals the report returned by toCostReport and the string contains a newline", async () => {
    const stdout = mock(() => {});
    const deps = makeDeps({
      loadRuns: mock(async () => [{ runId: "r1" }] as never),
      toCostReport: mock(() => FIXED_REPORT),
      stdout,
    });

    await emitCostReportJson("/tmp/workdir", deps);

    expect(stdout.mock.calls).toHaveLength(1);
    const out = stdout.mock.calls[0]?.[0] as string;
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