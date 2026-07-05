/**
 * Tests for `nax routing calibrate` command (src/cli/routing-calibrate.ts)
 *
 * The command composes `loadRunMetrics` (history) and the pure calibration
 * core (`computeBandStats` + `proposeAdjustments`) and, when `--apply` is
 * passed, writes the proposal back into the project's `.nax/config.json`.
 *
 * All I/O (load, write, stdout/stderr) is mocked via `_routingCalibrateDeps`
 * so the suite is hermetic. mirror: src/cli/routing-calibrate.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _routingCalibrateDeps, routingCalibrateCommand } from "../../../src/cli/routing-calibrate";
import type { NaxConfig } from "../../../src/config";
import { DEFAULT_CONFIG } from "../../../src/config";
import type { RunMetrics } from "../../../src/metrics";

type CalibrateDeps = typeof _routingCalibrateDeps;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const WORKDIR = "/fake/workdir";
const OUTPUT_DIR = "/fake/outputdir";
const PRIOR_MAPPING = {
  simple: "fast",
  medium: "balanced",
  complex: "powerful",
  expert: "powerful",
};

function makeNaxConfigWithMapping(mapping = PRIOR_MAPPING): NaxConfig {
  return {
    ...(structuredClone(DEFAULT_CONFIG) as NaxConfig),
    autoMode: {
      ...(structuredClone(DEFAULT_CONFIG) as NaxConfig).autoMode,
      complexityRouting: { ...mapping },
    },
    name: "fixture-project",
  };
}

/**
 * Build a `RunMetrics[]` fixture whose `simple` band reaches the upgrade
 * thresholds (escalationRate ≥ 0.3 and mismatchRate ≥ 0.25 against a
 * mapping where simple→fast, with observed finalTier differing — e.g.
 * "balanced" — to register a mismatch).
 */
function makeRunsWithEscalatingSimpleBand(): RunMetrics[] {
  const stories = [];
  // 10 stories in "simple" band, all escalated (attempts > 1) to drive
  // escalationRate=1.0 and finalTier=balanced to drive mismatchRate=1.0
  // (since mapping assigns "fast" but observed "balanced").
  for (let i = 0; i < 10; i++) {
    stories.push({
      storyId: `s-${i}`,
      complexity: "simple",
      modelTier: "fast",
      modelUsed: "haiku",
      agentUsed: "claude",
      attempts: 2,
      finalTier: "balanced",
      success: true,
      cost: 0.01,
      durationMs: 100,
      firstPassSuccess: false,
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:01:00Z",
    });
  }
  return [
    {
      runId: "run-1",
      feature: "fixture",
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:10:00Z",
      totalCost: 0.1,
      totalStories: 10,
      storiesCompleted: 10,
      storiesFailed: 0,
      totalDurationMs: 1000,
      stories,
    },
  ];
}

function makeCalibrateDepsFixture() {
  const writes: Array<{ workdir: string; config: NaxConfig }> = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  const deps: CalibrateDeps = {
    loadRunMetrics: mock(async (_outputDir: string): Promise<RunMetrics[]> => []),
    readConfig: mock(async (_workdir: string): Promise<NaxConfig | null> => null),
    writeConfig: mock(async (workdir: string, config: NaxConfig): Promise<void> => {
      writes.push({ workdir, config });
    }),
    stdout: mock((msg: string) => {
      stdoutLines.push(msg);
    }),
    stderr: mock((msg: string) => {
      stderrLines.push(msg);
    }),
  };

  return { deps, writes, stdoutLines, stderrLines };
}

// ─── Save / restore deps ────────────────────────────────────────────────────

let savedDeps: CalibrateDeps;

beforeEach(() => {
  savedDeps = { ..._routingCalibrateDeps };
});

afterEach(() => {
  Object.assign(_routingCalibrateDeps, savedDeps);
});

// ─── AC1: Threshold-breaching "simple" band → upgrade adjustment ─────────────

describe("routingCalibrateCommand — AC1: threshold-breaching band proposes upgrade", () => {
  test("AC1: returns a simple-band upgrade from fast → balanced", async () => {
    const runs = makeRunsWithEscalatingSimpleBand();
    const priorConfig = makeNaxConfigWithMapping();
    const { deps } = makeCalibrateDepsFixture();
    (deps.loadRunMetrics as ReturnType<typeof mock>).mockResolvedValueOnce(runs);
    (deps.readConfig as ReturnType<typeof mock>).mockResolvedValueOnce(priorConfig);

    const result = await routingCalibrateCommand(
      { apply: false, json: false, workdir: WORKDIR, outputDir: OUTPUT_DIR },
      deps,
    );

    const adj = result.proposal.adjustments.find((a) => a.band === "simple");
    expect(adj).toBeDefined();
    expect(adj?.from).toBe("fast");
    expect(adj?.to).toBe("balanced");
  });

  test("AC1 boundary: returns exit code 0 on a successful proposal", async () => {
    const runs = makeRunsWithEscalatingSimpleBand();
    const priorConfig = makeNaxConfigWithMapping();
    const { deps } = makeCalibrateDepsFixture();
    (deps.loadRunMetrics as ReturnType<typeof mock>).mockResolvedValueOnce(runs);
    (deps.readConfig as ReturnType<typeof mock>).mockResolvedValueOnce(priorConfig);

    const result = await routingCalibrateCommand(
      { apply: false, json: false, workdir: WORKDIR, outputDir: OUTPUT_DIR },
      deps,
    );

    expect(result.exitCode).toBe(0);
  });
});

// ─── AC2: --json mode emits proposal object with adjustments/keywordHints/skipped ─

describe("routingCalibrateCommand — AC2: --json mode emits JSON proposal", () => {
  test("AC2: --json writes a JSON line to stdout with the proposal shape", async () => {
    const runs = makeRunsWithEscalatingSimpleBand();
    const priorConfig = makeNaxConfigWithMapping();
    const { deps, stdoutLines } = makeCalibrateDepsFixture();
    (deps.loadRunMetrics as ReturnType<typeof mock>).mockResolvedValueOnce(runs);
    (deps.readConfig as ReturnType<typeof mock>).mockResolvedValueOnce(priorConfig);

    const result = await routingCalibrateCommand(
      { apply: false, json: true, workdir: WORKDIR, outputDir: OUTPUT_DIR },
      deps,
    );

    expect(result.exitCode).toBe(0);
    // Find the JSON line (the one starting with `{`).
    const jsonLine = stdoutLines.find((line) => line.startsWith("{"));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine ?? "null");
    expect(Array.isArray(parsed.adjustments)).toBe(true);
    expect(Array.isArray(parsed.keywordHints)).toBe(true);
    expect(Array.isArray(parsed.skipped)).toBe(true);
  });

  test("AC2 boundary: --json adjustments reflect the simple-band upgrade", async () => {
    const runs = makeRunsWithEscalatingSimpleBand();
    const priorConfig = makeNaxConfigWithMapping();
    const { deps, stdoutLines } = makeCalibrateDepsFixture();
    (deps.loadRunMetrics as ReturnType<typeof mock>).mockResolvedValueOnce(runs);
    (deps.readConfig as ReturnType<typeof mock>).mockResolvedValueOnce(priorConfig);

    await routingCalibrateCommand({ apply: false, json: true, workdir: WORKDIR, outputDir: OUTPUT_DIR }, deps);

    const jsonLine = stdoutLines.find((line) => line.startsWith("{"));
    const parsed = JSON.parse(jsonLine ?? "null");
    const adj = parsed.adjustments.find((a: { band: string }) => a.band === "simple");
    expect(adj?.from).toBe("fast");
    expect(adj?.to).toBe("balanced");
  });
});

// ─── AC3: read-only default — no writeConfig invocation ─────────────────────

describe("routingCalibrateCommand — AC3: read-only default never writes config", () => {
  test("AC3: without --apply, writeConfig is never called", async () => {
    const runs = makeRunsWithEscalatingSimpleBand();
    const priorConfig = makeNaxConfigWithMapping();
    const { deps, writes } = makeCalibrateDepsFixture();
    (deps.loadRunMetrics as ReturnType<typeof mock>).mockResolvedValueOnce(runs);
    (deps.readConfig as ReturnType<typeof mock>).mockResolvedValueOnce(priorConfig);

    const result = await routingCalibrateCommand(
      { apply: false, json: false, workdir: WORKDIR, outputDir: OUTPUT_DIR },
      deps,
    );

    expect(result.exitCode).toBe(0);
    expect(writes).toHaveLength(0);
  });
});

// ─── AC4: --apply with adjustments writes merged config once ───────────────

describe("routingCalibrateCommand — AC4: --apply writes merged complexityRouting", () => {
  test("AC4: --apply with adjustments writes config exactly once", async () => {
    const runs = makeRunsWithEscalatingSimpleBand();
    const priorConfig = makeNaxConfigWithMapping();
    const { deps, writes } = makeCalibrateDepsFixture();
    (deps.loadRunMetrics as ReturnType<typeof mock>).mockResolvedValueOnce(runs);
    (deps.readConfig as ReturnType<typeof mock>).mockResolvedValueOnce(priorConfig);

    const result = await routingCalibrateCommand(
      { apply: true, json: false, workdir: WORKDIR, outputDir: OUTPUT_DIR },
      deps,
    );

    expect(result.exitCode).toBe(0);
    expect(writes).toHaveLength(1);
  });

  test("AC4 boundary: written complexityRouting replaces only the proposed band tiers", async () => {
    const runs = makeRunsWithEscalatingSimpleBand();
    const priorConfig = makeNaxConfigWithMapping({
      simple: "fast",
      medium: "balanced",
      complex: "powerful",
      expert: "powerful",
    });
    const { deps, writes } = makeCalibrateDepsFixture();
    (deps.loadRunMetrics as ReturnType<typeof mock>).mockResolvedValueOnce(runs);
    (deps.readConfig as ReturnType<typeof mock>).mockResolvedValueOnce(priorConfig);

    await routingCalibrateCommand({ apply: true, json: false, workdir: WORKDIR, outputDir: OUTPUT_DIR }, deps);

    expect(writes).toHaveLength(1);
    const written = writes[0]?.config;
    expect(written).toBeDefined();
    // simple was the proposed band — must move fast → balanced.
    expect(written?.autoMode.complexityRouting.simple).toBe("balanced");
    // Other bands must be preserved.
    expect(written?.autoMode.complexityRouting.medium).toBe("balanced");
    expect(written?.autoMode.complexityRouting.complex).toBe("powerful");
    expect(written?.autoMode.complexityRouting.expert).toBe("powerful");
  });

  test("AC4 boundary: writeConfig is invoked with the configured workdir", async () => {
    const runs = makeRunsWithEscalatingSimpleBand();
    const priorConfig = makeNaxConfigWithMapping();
    const { deps, writes } = makeCalibrateDepsFixture();
    (deps.loadRunMetrics as ReturnType<typeof mock>).mockResolvedValueOnce(runs);
    (deps.readConfig as ReturnType<typeof mock>).mockResolvedValueOnce(priorConfig);

    await routingCalibrateCommand({ apply: true, json: false, workdir: WORKDIR, outputDir: OUTPUT_DIR }, deps);

    expect(writes[0]?.workdir).toBe(WORKDIR);
  });
});

// ─── AC5: --apply with zero adjustments is a no-op write ───────────────────

describe("routingCalibrateCommand — AC5: --apply with no proposals is a no-op write", () => {
  test("AC5: when there are no adjustments, --apply does not invoke writeConfig", async () => {
    // Empty history → no proposal adjustments at all
    const priorConfig = makeNaxConfigWithMapping();
    const { deps, writes } = makeCalibrateDepsFixture();
    (deps.loadRunMetrics as ReturnType<typeof mock>).mockResolvedValueOnce([]);
    (deps.readConfig as ReturnType<typeof mock>).mockResolvedValueOnce(priorConfig);

    const result = await routingCalibrateCommand(
      { apply: true, json: false, workdir: WORKDIR, outputDir: OUTPUT_DIR },
      deps,
    );

    expect(result.exitCode).toBe(0);
    expect(writes).toHaveLength(0);
  });
});

// ─── AC6: --min-samples skips bands below the override floor ───────────────

describe("routingCalibrateCommand — AC6: --min-samples override marks bands as skipped", () => {
  test("AC6: --min-samples 20 with a simple-band sampleCount of 10 yields a skipped entry", async () => {
    const runs = makeRunsWithEscalatingSimpleBand(); // simple sampleCount=10
    const priorConfig = makeNaxConfigWithMapping();
    const { deps } = makeCalibrateDepsFixture();
    (deps.loadRunMetrics as ReturnType<typeof mock>).mockResolvedValueOnce(runs);
    (deps.readConfig as ReturnType<typeof mock>).mockResolvedValueOnce(priorConfig);

    const result = await routingCalibrateCommand(
      { apply: false, json: false, minSamples: 20, workdir: WORKDIR, outputDir: OUTPUT_DIR },
      deps,
    );

    const skipped = result.proposal.skipped.find((s) => s.complexity === "simple");
    expect(skipped).toBeDefined();
    expect(skipped?.reason).toBe("insufficient-samples");
    expect(skipped?.sampleCount).toBe(10);
    expect(skipped?.minSamples).toBe(20);
    // And no upgrade adjustment for simple should be proposed.
    const adj = result.proposal.adjustments.find((a) => a.band === "simple");
    expect(adj).toBeUndefined();
  });
});

// ─── AC7: empty history → insufficient history, no throw, no write ─────────

describe("routingCalibrateCommand — AC7: empty history is insufficient, no throw, no write", () => {
  test("AC7: empty RunMetrics[] completes with exit 0, does not invoke writeConfig", async () => {
    const priorConfig = makeNaxConfigWithMapping();
    const { deps, writes } = makeCalibrateDepsFixture();
    (deps.loadRunMetrics as ReturnType<typeof mock>).mockResolvedValueOnce([]);
    (deps.readConfig as ReturnType<typeof mock>).mockResolvedValueOnce(priorConfig);

    const result = await routingCalibrateCommand(
      { apply: false, json: false, workdir: WORKDIR, outputDir: OUTPUT_DIR },
      deps,
    );

    expect(result.exitCode).toBe(0);
    expect(writes).toHaveLength(0);
  });
});

// ─── Mock sanity: deps were called with the expected arguments ───────────────

describe("routingCalibrateCommand — dep plumbing", () => {
  test("loadRunMetrics is invoked with the configured outputDir", async () => {
    const priorConfig = makeNaxConfigWithMapping();
    const { deps } = makeCalibrateDepsFixture();
    (deps.loadRunMetrics as ReturnType<typeof mock>).mockResolvedValueOnce([]);
    (deps.readConfig as ReturnType<typeof mock>).mockResolvedValueOnce(priorConfig);

    await routingCalibrateCommand({ apply: false, json: false, workdir: WORKDIR, outputDir: OUTPUT_DIR }, deps);

    const spy = deps.loadRunMetrics as ReturnType<typeof mock>;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe(OUTPUT_DIR);
  });

  test("readConfig is invoked with the configured workdir", async () => {
    const { deps } = makeCalibrateDepsFixture();
    (deps.loadRunMetrics as ReturnType<typeof mock>).mockResolvedValueOnce([]);
    (deps.readConfig as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    await routingCalibrateCommand({ apply: false, json: false, workdir: WORKDIR, outputDir: OUTPUT_DIR }, deps);

    const spy = deps.readConfig as ReturnType<typeof mock>;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe(WORKDIR);
  });
});
