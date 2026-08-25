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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { absentValue } from "@test/helpers";
import { Command } from "commander";
import { _routingCalibrateDeps, parseMinSamplesFlag, routingCalibrateCommand, runRoutingCalibrateCli } from "@/cli";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config";
import { NaxError } from "@/errors";
import type { RunMetrics } from "@/metrics";

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
function makeRunsWithNoBreachingBands(): RunMetrics[] {
  const stories = [];
  // 10 "simple" stories — first-pass success keeps firstPassRate=1 and
  // escalationRate=0, finalTier == mapped tier so mismatchRate=0; no proposal.
  for (let i = 0; i < 10; i++) {
    stories.push({
      storyId: `ok-${i}`,
      complexity: "simple",
      modelTier: "fast",
      modelUsed: "haiku",
      agentUsed: "claude",
      attempts: 1,
      finalTier: "fast",
      success: true,
      cost: 0.01,
      durationMs: 100,
      firstPassSuccess: true,
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:01:00Z",
    });
  }
  return [
    {
      runId: "run-quiet",
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
  test("AC5: --apply with non-empty history that yields zero adjustments does not invoke writeConfig", async () => {
    // Non-empty history that does not breach the upgrade or downgrade
    // thresholds → the proposal computation runs but produces zero
    // adjustments. AC5 says --apply in that case must not write config.
    const runs = makeRunsWithNoBreachingBands();
    const priorConfig = makeNaxConfigWithMapping();
    const { deps, writes } = makeCalibrateDepsFixture();
    (deps.loadRunMetrics as ReturnType<typeof mock>).mockResolvedValueOnce(runs);
    (deps.readConfig as ReturnType<typeof mock>).mockResolvedValueOnce(priorConfig);

    const result = await routingCalibrateCommand(
      { apply: true, json: false, workdir: WORKDIR, outputDir: OUTPUT_DIR },
      deps,
    );

    expect(result.exitCode).toBe(0);
    expect(result.proposal.adjustments).toHaveLength(0);
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
  test("AC7: empty RunMetrics[] completes with exit 0, does not invoke writeConfig, reports insufficient history", async () => {
    const priorConfig = makeNaxConfigWithMapping();
    const { deps, writes, stderrLines } = makeCalibrateDepsFixture();
    (deps.loadRunMetrics as ReturnType<typeof mock>).mockResolvedValueOnce([]);
    (deps.readConfig as ReturnType<typeof mock>).mockResolvedValueOnce(priorConfig);

    const result = await routingCalibrateCommand(
      { apply: false, json: false, workdir: WORKDIR, outputDir: OUTPUT_DIR },
      deps,
    );

    expect(result.exitCode).toBe(0);
    expect(writes).toHaveLength(0);
    const combined = stderrLines.join("\n").toLowerCase();
    expect(combined).toContain("insufficient");
    expect(combined).toContain("history");
  });

  test("AC7 boundary: --apply with empty history still does not invoke writeConfig", async () => {
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

// ─── CLI plumbing: bin/nax.ts parses --min-samples via the shared handler ───

describe("CLI plumbing — Commander-driven parse path for --min-samples", () => {
  /**
   * Build a Commander program that mirrors the `routing calibrate`
   * registration in `bin/nax.ts:1265`, wiring `.action()` to the production
   * handler (`runRoutingCalibrateCli`). The shared handler is what `bin/nax.ts`
   * itself calls, so a regression in the parse/forward path shows up here.
   */
  function buildRoutingCalibrateProgram(action: (options: Record<string, unknown>) => Promise<void>) {
    const program = new Command();
    const routingCmd = program.command("routing").description("Routing calibration helpers");
    routingCmd
      .command("calibrate")
      .description("Propose complexity→tier mapping adjustments from run history")
      .option("-d, --dir <path>", "Project directory", process.cwd())
      .option("--apply", "Write the proposed mapping into .nax/config.json", false)
      .option("--json", "Emit the proposal as JSON", false)
      .option("--min-samples <n>", "Override the per-band sample floor for this invocation")
      .action(action);
    return program;
  }

  test("AC6 plumbing: Commander-parsed --min-samples 20 reaches routingCalibrateCommand end-to-end", async () => {
    const runs = makeRunsWithEscalatingSimpleBand();
    const priorConfig = makeNaxConfigWithMapping();
    const { deps } = makeCalibrateDepsFixture();
    (deps.loadRunMetrics as ReturnType<typeof mock>).mockResolvedValueOnce(runs);
    (deps.readConfig as ReturnType<typeof mock>).mockResolvedValueOnce(priorConfig);

    const captured: Array<{ dir?: string; apply?: boolean; json?: boolean; minSamples?: string }> = [];
    const program = buildRoutingCalibrateProgram(async (options: Record<string, unknown>) => {
      captured.push(options as { dir?: string; apply?: boolean; json?: boolean; minSamples?: string });
      await runRoutingCalibrateCli(
        options as { dir?: string; apply?: boolean; json?: boolean; minSamples?: string },
        deps,
      );
    });

    await program.parseAsync(["node", "nax", "routing", "calibrate", "--min-samples", "20", "--dir", WORKDIR]);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.minSamples).toBe("20");
    expect(captured[0]?.dir).toBe(WORKDIR);

    const loads = (deps.loadRunMetrics as ReturnType<typeof mock>).mock.calls.length;
    expect(loads).toBe(1);
  });

  test("AC6 plumbing: a missing --min-samples flag arrives as undefined and does not set the floor", async () => {
    const runs = makeRunsWithEscalatingSimpleBand();
    const priorConfig = makeNaxConfigWithMapping();
    const { deps } = makeCalibrateDepsFixture();
    (deps.loadRunMetrics as ReturnType<typeof mock>).mockResolvedValueOnce(runs);
    (deps.readConfig as ReturnType<typeof mock>).mockResolvedValueOnce(priorConfig);

    const program = buildRoutingCalibrateProgram(async (options: Record<string, unknown>) => {
      await runRoutingCalibrateCli(
        options as { dir?: string; apply?: boolean; json?: boolean; minSamples?: string },
        deps,
      );
    });

    await program.parseAsync(["node", "nax", "routing", "calibrate", "--dir", WORKDIR]);

    expect((deps.loadRunMetrics as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    const adjustmentForwardedCalls = (deps.loadRunMetrics as ReturnType<typeof mock>).mock.calls;
    expect(adjustmentForwardedCalls[0]?.[0]).toBeDefined();
  });

  test("AC6 plumbing: --min-samples NaN returns exitCode=1 and reports the parse error", async () => {
    const { deps, stderrLines } = makeCalibrateDepsFixture();
    (deps.readConfig as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    const result = await runRoutingCalibrateCli({ dir: WORKDIR, apply: false, json: false, minSamples: "abc" }, deps);

    expect(result.exitCode).toBe(1);
    expect(stderrLines.join("\n")).toContain("--min-samples must be a non-negative integer");
  });

  test("parseMinSamplesFlag throws NaxError with INVALID_MIN_SAMPLES code on non-numeric input", () => {
    expect(() => parseMinSamplesFlag("abc")).toThrow();
    try {
      parseMinSamplesFlag("abc");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("INVALID_MIN_SAMPLES");
    }
  });

  test("parseMinSamplesFlag rejects mixed-alphanumeric tokens like '20abc'", () => {
    expect(() => parseMinSamplesFlag("20abc")).toThrow(/non-negative integer/);
    expect(() => parseMinSamplesFlag("20abc")).toThrow(NaxError);
    try {
      parseMinSamplesFlag("20abc");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("INVALID_MIN_SAMPLES");
    }
  });

  test("parseMinSamplesFlag rejects fractional tokens like '3.5'", () => {
    expect(() => parseMinSamplesFlag("3.5")).toThrow(/non-negative integer/);
    try {
      parseMinSamplesFlag("3.5");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("INVALID_MIN_SAMPLES");
    }
  });

  test("parseMinSamplesFlag rejects negative values like '-1'", () => {
    expect(() => parseMinSamplesFlag("-1")).toThrow(/non-negative integer/);
    try {
      parseMinSamplesFlag("-1");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("INVALID_MIN_SAMPLES");
    }
  });

  test("parseMinSamplesFlag rejects empty string", () => {
    expect(() => parseMinSamplesFlag("")).toThrow(/non-negative integer/);
  });

  test("parseMinSamplesFlag rejects leading or trailing whitespace", () => {
    expect(() => parseMinSamplesFlag(" 20")).toThrow(/non-negative integer/);
    expect(() => parseMinSamplesFlag("20 ")).toThrow(/non-negative integer/);
  });

  test("parseMinSamplesFlag returns the integer for valid input", () => {
    expect(parseMinSamplesFlag("20")).toBe(20);
    expect(parseMinSamplesFlag("0")).toBe(0);
    expect(parseMinSamplesFlag(undefined)).toBeUndefined();
  });
});

// ─── Partial project config overlay (no autoMode in .nax/config.json) ──────

describe("routingCalibrateCommand — partial project config overlay", () => {
  test("partial overlay without autoMode still computes a proposal and returns exit 0", async () => {
    const runs = makeRunsWithEscalatingSimpleBand();
    // Minimal overlay: project .nax/config.json containing only version + execution,
    // matching the partial-overlay style used everywhere else in this repo.
    const partialOverlay: NaxConfig = {
      ...(structuredClone(DEFAULT_CONFIG) as NaxConfig),
      autoMode: absentValue<NaxConfig["autoMode"]>(),
      name: "fixture-project",
    };
    const { deps, writes } = makeCalibrateDepsFixture();
    (deps.loadRunMetrics as ReturnType<typeof mock>).mockResolvedValueOnce(runs);
    (deps.readConfig as ReturnType<typeof mock>).mockResolvedValueOnce(partialOverlay);

    const result = await routingCalibrateCommand(
      { apply: false, json: false, workdir: WORKDIR, outputDir: OUTPUT_DIR },
      deps,
    );

    expect(result.exitCode).toBe(0);
    expect(writes).toHaveLength(0);
    const adj = result.proposal.adjustments.find((a) => a.band === "simple");
    expect(adj).toBeDefined();
    expect(adj?.from).toBe("fast");
    expect(adj?.to).toBe("balanced");
  });

  test("--apply with partial overlay merges against DEFAULT_CONFIG.autoMode", async () => {
    const runs = makeRunsWithEscalatingSimpleBand();
    const partialOverlay: NaxConfig = {
      ...(structuredClone(DEFAULT_CONFIG) as NaxConfig),
      autoMode: absentValue<NaxConfig["autoMode"]>(),
      name: "fixture-project",
    };
    const { deps, writes } = makeCalibrateDepsFixture();
    (deps.loadRunMetrics as ReturnType<typeof mock>).mockResolvedValueOnce(runs);
    (deps.readConfig as ReturnType<typeof mock>).mockResolvedValueOnce(partialOverlay);

    const result = await routingCalibrateCommand(
      { apply: true, json: false, workdir: WORKDIR, outputDir: OUTPUT_DIR },
      deps,
    );

    expect(result.exitCode).toBe(0);
    expect(result.wroteConfig).toBe(true);
    expect(writes).toHaveLength(1);
    const written = writes[0]?.config;
    expect(written).toBeDefined();
    expect(written?.autoMode.complexityRouting.simple).toBe("balanced");
    expect(written?.autoMode.complexityRouting.medium).toBe("balanced");
    expect(written?.autoMode.complexityRouting.complex).toBe("powerful");
    expect(written?.autoMode.complexityRouting.expert).toBe("powerful");
  });
});

// ─── Default readConfig delegates to the layered loadConfig ────────────────

describe("_routingCalibrateDeps.readConfig — delegates to the repo's layered loadConfig", () => {
  test("readConfig delegates to loadConfig, not the raw .nax/config.json only", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "nax-routing-test-"));
    try {
      mkdirSync(join(tmpDir, ".nax"), { recursive: true });
      writeFileSync(join(tmpDir, ".nax/config.json"), JSON.stringify({ version: 1 }));
      const result = await _routingCalibrateDeps.readConfig(tmpDir);
      expect(result).not.toBeNull();
      expect(result?.name).toBeDefined();
      expect(result?.autoMode).toBeDefined();
      expect(result?.autoMode.complexityRouting).toBeDefined();
      expect(result?.execution).toBeDefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
