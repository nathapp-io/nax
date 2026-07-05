import { describe, test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NaxConfigSchema } from "../../../src/config/schemas";
import {
  computeBandStats,
  proposeAdjustments,
} from "../../../src/routing/calibrate";
import type {
  BandStat,
  CalibrationThresholds,
} from "../../../src/routing/calibrate";
import type { RunMetrics, StoryMetrics } from "../../../src/metrics/types";
import {
  calibrate,
  parseArgs,
  _calibrateDeps,
} from "../../../src/cli/routing-calibrate";
import {
  autoRoutePlugin,
  _autoRouteDeps,
} from "../../../src/plugins/builtin/auto-route";
import { loadPlugins } from "../../../src/plugins/loader";
import type { PostRunContext } from "../../../src/plugins/extensions";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const DEFAULT_MAPPING = {
  simple: "fast",
  medium: "balanced",
  complex: "powerful",
  expert: "powerful",
} as const;

const DEFAULT_THRESHOLDS: CalibrationThresholds = {
  minSamples: 8,
  upgrade: { escalationRate: 0.3, mismatchRate: 0.25 },
  downgrade: { firstPassRate: 0.9, escalationRate: 0.05 },
};

let _storyCounter = 0;
function makeStory(overrides: Partial<StoryMetrics> = {}): StoryMetrics {
  return {
    storyId: `story-${++_storyCounter}`,
    complexity: "simple",
    modelTier: "fast",
    modelUsed: "claude-haiku-4-5",
    attempts: 1,
    finalTier: "fast",
    success: true,
    cost: 0.01,
    durationMs: 1000,
    firstPassSuccess: true,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

let _runCounter = 0;
function makeRun(stories: StoryMetrics[]): RunMetrics {
  return {
    runId: `run-${++_runCounter}`,
    feature: "test-feature",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    totalCost: stories.reduce((s, st) => s + st.cost, 0),
    totalStories: stories.length,
    storiesCompleted: stories.length,
    storiesFailed: 0,
    totalDurationMs: 5000,
    stories,
  };
}

type TestCtx = PostRunContext & Record<string, unknown>;

function makeCtx(overrides: Record<string, unknown> = {}): TestCtx {
  return {
    runId: "test-run",
    feature: "empirical-routing",
    workdir: "/tmp/test",
    prdPath: ".nax/features/empirical-routing/prd.json",
    branch: "feat/empirical-routing",
    totalDurationMs: 120_000,
    totalCost: 0.5,
    storySummary: { completed: 5, failed: 0, skipped: 0, paused: 0 },
    stories: [],
    version: "0.72.0",
    pluginConfig: {},
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    config: {
      autoRoute: {
        enabled: false,
        minSamples: 8,
        upgrade: { escalationRate: 0.3, mismatchRate: 0.25 },
        downgrade: { firstPassRate: 0.9, escalationRate: 0.05 },
      },
    },
    ...overrides,
  } as TestCtx;
}

function makeEnabledRouteConfig() {
  return {
    autoRoute: {
      enabled: true,
      minSamples: 8,
      upgrade: { escalationRate: 0.3, mismatchRate: 0.25 },
      downgrade: { firstPassRate: 0.9, escalationRate: 0.05 },
    },
  };
}

/**
 * 10 RunMetrics (one story each) for "simple" band:
 *   escalationRate = 0.4  (4/10 with attempts > 1)
 *   mismatchRate   = 0.3  (3/10 with finalTier != "fast")
 * Both breach the upgrade thresholds (0.3 and 0.25).
 */
function makeUpgradeFixtureRuns(): RunMetrics[] {
  return Array.from({ length: 10 }, (_, i) =>
    makeRun([
      makeStory({
        complexity: "simple",
        attempts: i < 4 ? 2 : 1,
        finalTier: i < 3 ? "balanced" : "fast",
        firstPassSuccess: true,
      }),
    ])
  );
}

// ---------------------------------------------------------------------------
// US-001: autoRoute config schema
// ---------------------------------------------------------------------------

describe("US-001: autoRoute config schema", () => {
  test("AC-1: NaxConfigSchema.parse({}) yields autoRoute.enabled === false", () => {
    const config = NaxConfigSchema.parse({}) as any;
    expect(config.autoRoute.enabled).toBe(false);
  });

  test("AC-2: NaxConfigSchema.parse({}) yields autoRoute.minSamples === 8", () => {
    const config = NaxConfigSchema.parse({}) as any;
    expect(config.autoRoute.minSamples).toBe(8);
  });

  test("AC-3: parse({}) yields autoRoute.upgrade.escalationRate === 0.3 and mismatchRate === 0.25", () => {
    const config = NaxConfigSchema.parse({}) as any;
    expect(config.autoRoute.upgrade.escalationRate).toBe(0.3);
    expect(config.autoRoute.upgrade.mismatchRate).toBe(0.25);
  });

  test("AC-4: parse({}) yields autoRoute.downgrade.firstPassRate === 0.9 and escalationRate === 0.05", () => {
    const config = NaxConfigSchema.parse({}) as any;
    expect(config.autoRoute.downgrade.firstPassRate).toBe(0.9);
    expect(config.autoRoute.downgrade.escalationRate).toBe(0.05);
  });

  test("AC-5: partial override { minSamples: 20 } preserves enabled === false default", () => {
    const config = NaxConfigSchema.parse({ autoRoute: { minSamples: 20 } }) as any;
    expect(config.autoRoute.minSamples).toBe(20);
    expect(config.autoRoute.enabled).toBe(false);
  });

  test("AC-6: safeParse({ autoRoute: { enabled: 'yes' } }).success === false", () => {
    const result = NaxConfigSchema.safeParse({ autoRoute: { enabled: "yes" } });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// US-002: computeBandStats
// ---------------------------------------------------------------------------

describe("US-002: computeBandStats", () => {
  test("AC-7: 10 'simple' stories, 4 with attempts > 1 → sampleCount=10, escalationRate=0.4", () => {
    const runs = Array.from({ length: 10 }, (_, i) =>
      makeRun([
        makeStory({
          complexity: "simple",
          attempts: i < 4 ? 2 : 1,
          finalTier: "fast",
          firstPassSuccess: true,
        }),
      ])
    );
    const stats = computeBandStats(runs, DEFAULT_MAPPING);
    const simple = stats.find((s) => s.band === "simple");
    expect(simple).toBeDefined();
    expect(simple!.sampleCount).toBe(10);
    expect(simple!.escalationRate).toBe(0.4);
  });

  test("AC-8: 9 of 10 'simple' stories with firstPassSuccess === true → firstPassRate === 0.9", () => {
    const runs = Array.from({ length: 10 }, (_, i) =>
      makeRun([
        makeStory({
          complexity: "simple",
          firstPassSuccess: i < 9,
          attempts: 1,
          finalTier: "fast",
        }),
      ])
    );
    const stats = computeBandStats(runs, DEFAULT_MAPPING);
    const simple = stats.find((s) => s.band === "simple");
    expect(simple).toBeDefined();
    expect(simple!.firstPassRate).toBe(0.9);
  });

  test("AC-9: 3 of 10 'simple' stories with finalTier='balanced' → mismatchRate=0.3 (mapping.simple='fast')", () => {
    const runs = Array.from({ length: 10 }, (_, i) =>
      makeRun([
        makeStory({
          complexity: "simple",
          finalTier: i < 3 ? "balanced" : "fast",
          attempts: 1,
          firstPassSuccess: true,
        }),
      ])
    );
    const stats = computeBandStats(runs, DEFAULT_MAPPING);
    const simple = stats.find((s) => s.band === "simple");
    expect(simple).toBeDefined();
    expect(simple!.mismatchRate).toBe(0.3);
  });

  test("AC-10: returns exactly 3 BandStats for 3 distinct complexities, no extras", () => {
    const runs = [
      makeRun([makeStory({ complexity: "simple" })]),
      makeRun([makeStory({ complexity: "medium" })]),
      makeRun([makeStory({ complexity: "complex" })]),
    ];
    const stats = computeBandStats(runs, DEFAULT_MAPPING);
    expect(stats).toHaveLength(3);
    const bands = stats.map((s) => s.band).sort();
    expect(bands).toEqual(["complex", "medium", "simple"]);
  });

  test("AC-11: empty runs array → empty BandStat array", () => {
    const stats = computeBandStats([], DEFAULT_MAPPING);
    expect(stats).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// US-003: proposeAdjustments
// ---------------------------------------------------------------------------

describe("US-003: proposeAdjustments", () => {
  test("AC-12: upgrade fires for simple→fast with escalationRate=0.4, mismatchRate=0.3", () => {
    const bandStat: BandStat = {
      band: "simple",
      sampleCount: 10,
      escalationRate: 0.4,
      mismatchRate: 0.3,
      firstPassRate: 0.6,
    };
    const result = proposeAdjustments([bandStat], DEFAULT_MAPPING, DEFAULT_THRESHOLDS);
    expect(result.adjustments).toHaveLength(1);
    const adj = result.adjustments[0];
    expect(adj.band).toBe("simple");
    expect(adj.from).toBe("fast");
    expect(adj.to).toBe("balanced");
    expect(adj.direction).toBe("upgrade");
    expect(result.skipped).toHaveLength(0);
    expect(result.keywordHints).toHaveLength(0);
  });

  test("AC-13: downgrade fires for complex→powerful with firstPassRate=0.95, escalationRate=0.02", () => {
    const bandStat: BandStat = {
      band: "complex",
      sampleCount: 12,
      escalationRate: 0.02,
      mismatchRate: 0.0,
      firstPassRate: 0.95,
    };
    const result = proposeAdjustments([bandStat], DEFAULT_MAPPING, DEFAULT_THRESHOLDS);
    expect(result.adjustments).toHaveLength(1);
    const adj = result.adjustments[0];
    expect(adj.band).toBe("complex");
    expect(adj.from).toBe("powerful");
    expect(adj.to).toBe("balanced");
    expect(adj.direction).toBe("downgrade");
    expect(result.skipped).toHaveLength(0);
  });

  test("AC-14: band below minSamples appears in skipped with correct fields, not in adjustments", () => {
    const bandStat: BandStat = {
      band: "expert",
      sampleCount: 3,
      escalationRate: 0.4,
      mismatchRate: 0.3,
      firstPassRate: 0.6,
    };
    const result = proposeAdjustments([bandStat], DEFAULT_MAPPING, DEFAULT_THRESHOLDS);
    expect(result.adjustments.some((a) => a.band === "expert")).toBe(false);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].band).toBe("expert");
    expect(result.skipped[0].sampleCount).toBe(3);
    expect(result.skipped[0].minSamples).toBe(8);
    expect(result.keywordHints).toHaveLength(0);
  });

  test("AC-15: no downgrade proposed when band is already at 'fast' (lowest rung)", () => {
    const bandStat: BandStat = {
      band: "simple",
      sampleCount: 10,
      escalationRate: 0.01,
      mismatchRate: 0.0,
      firstPassRate: 0.98,
    };
    // simple is already mapped to "fast" in DEFAULT_MAPPING
    const result = proposeAdjustments([bandStat], DEFAULT_MAPPING, DEFAULT_THRESHOLDS);
    expect(result.adjustments.some((a) => a.direction === "downgrade" && a.band === "simple")).toBe(false);
    expect(result.skipped.some((s) => s.band === "simple")).toBe(false);
  });

  test("AC-16: no upgrade proposed when band is already at 'powerful' (highest rung)", () => {
    const bandStat: BandStat = {
      band: "expert",
      sampleCount: 10,
      escalationRate: 0.9,
      mismatchRate: 0.9,
      firstPassRate: 0.1,
    };
    // expert is mapped to "powerful" in DEFAULT_MAPPING
    const result = proposeAdjustments([bandStat], DEFAULT_MAPPING, DEFAULT_THRESHOLDS);
    expect(result.adjustments.some((a) => a.direction === "upgrade" && a.band === "expert")).toBe(false);
    expect(result.skipped.some((s) => s.band === "expert")).toBe(false);
  });

  test("AC-17: one-rung max — simple→fast with extreme rates proposes balanced only, not powerful", () => {
    const bandStat: BandStat = {
      band: "simple",
      sampleCount: 10,
      escalationRate: 0.9,
      mismatchRate: 0.9,
      firstPassRate: 0.1,
    };
    const result = proposeAdjustments([bandStat], DEFAULT_MAPPING, DEFAULT_THRESHOLDS);
    expect(result.adjustments).toHaveLength(1);
    expect(result.adjustments[0].band).toBe("simple");
    expect(result.adjustments[0].from).toBe("fast");
    expect(result.adjustments[0].to).toBe("balanced");
    expect(result.adjustments.some((a) => a.to === "powerful")).toBe(false);
  });

  test("AC-18: hysteresis — escalationRate=0.15 and firstPassRate=0.7 fires neither rule", () => {
    const bandStat: BandStat = {
      band: "simple",
      sampleCount: 10,
      escalationRate: 0.15, // below upgrade threshold 0.3
      mismatchRate: 0.1,    // below upgrade threshold 0.25
      firstPassRate: 0.7,   // below downgrade threshold 0.9
    };
    const result = proposeAdjustments([bandStat], DEFAULT_MAPPING, DEFAULT_THRESHOLDS);
    expect(result.adjustments).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.keywordHints).toHaveLength(0);
  });

  test("AC-19: keyword hint for large-sample high-mismatch band references classify.ts, has no from/to", () => {
    // escalationRate below upgrade threshold → no upgrade adjustment
    // but mismatchRate high → keyword hint suggesting classifier review
    const bandStat: BandStat = {
      band: "simple",
      sampleCount: 15,
      escalationRate: 0.15, // below upgrade escalation threshold 0.3
      mismatchRate: 0.4,    // above upgrade mismatch threshold 0.25
      firstPassRate: 0.7,
    };
    const result = proposeAdjustments([bandStat], DEFAULT_MAPPING, DEFAULT_THRESHOLDS);
    expect(result.keywordHints.length).toBeGreaterThanOrEqual(1);
    const hint = result.keywordHints.find((h) => h.band === "simple");
    expect(hint).toBeDefined();
    expect(hint!.message).toContain("classify.ts");
    expect((hint as any).from).toBeUndefined();
    expect((hint as any).to).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// US-004: CLI routing-calibrate
// ---------------------------------------------------------------------------

describe("US-004: CLI routing-calibrate", () => {
  test("AC-20: calibrate with threshold-breaching 'simple' fixture → adjustment band=simple from=fast to=balanced", async () => {
    const fixtureRuns = makeUpgradeFixtureRuns();
    const origLoad = _calibrateDeps.loadRunMetrics;
    _calibrateDeps.loadRunMetrics = async () => fixtureRuns;
    try {
      const opts = parseArgs([]);
      const proposal = await calibrate(opts, _calibrateDeps);
      expect(proposal.adjustments.length).toBeGreaterThanOrEqual(1);
      const adj = proposal.adjustments.find(
        (a) => a.band === "simple" && a.from === "fast" && a.to === "balanced"
      );
      expect(adj).toBeDefined();
    } finally {
      _calibrateDeps.loadRunMetrics = origLoad;
    }
  });

  test("AC-21: --json mode emits a single line of valid JSON with adjustments, keywordHints, skipped", async () => {
    const fixtureRuns = makeUpgradeFixtureRuns();
    const origLoad = _calibrateDeps.loadRunMetrics;
    _calibrateDeps.loadRunMetrics = async () => fixtureRuns;
    const capturedChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (chunk: any, ...rest: any[]) => {
      capturedChunks.push(String(chunk));
      return true;
    };
    try {
      const opts = parseArgs(["--json"]);
      await calibrate(opts, _calibrateDeps);
    } finally {
      (process.stdout as any).write = origWrite;
      _calibrateDeps.loadRunMetrics = origLoad;
    }
    const output = capturedChunks.join("").trim();
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed.adjustments)).toBe(true);
    expect(Array.isArray(parsed.keywordHints)).toBe(true);
    expect(Array.isArray(parsed.skipped)).toBe(true);
    if (parsed.adjustments.length > 0) {
      const adj = parsed.adjustments[0];
      expect(typeof adj.band).toBe("string");
      expect(typeof adj.from).toBe("string");
      expect(typeof adj.to).toBe("string");
    }
    if (parsed.skipped.length > 0) {
      const sk = parsed.skipped[0];
      expect(typeof sk.band).toBe("string");
    }
  });

  test("AC-22: without --apply, writeConfig is never called", async () => {
    const fixtureRuns = makeUpgradeFixtureRuns();
    const origLoad = _calibrateDeps.loadRunMetrics;
    const origWrite = _calibrateDeps.writeConfig;
    let writeCount = 0;
    _calibrateDeps.loadRunMetrics = async () => fixtureRuns;
    _calibrateDeps.writeConfig = async () => { writeCount++; };
    try {
      const opts = parseArgs([]);
      await calibrate(opts, _calibrateDeps);
      expect(writeCount).toBe(0);
    } finally {
      _calibrateDeps.loadRunMetrics = origLoad;
      _calibrateDeps.writeConfig = origWrite;
    }
  });

  test("AC-23: --apply with adjustments calls writeConfig once; config has adjusted band and preserves others", async () => {
    const fixtureRuns = makeUpgradeFixtureRuns();
    const origLoad = _calibrateDeps.loadRunMetrics;
    const origWrite = _calibrateDeps.writeConfig;
    let writeCount = 0;
    let capturedConfig: any = null;
    _calibrateDeps.loadRunMetrics = async () => fixtureRuns;
    _calibrateDeps.writeConfig = async (_workdir: string, config: unknown) => {
      writeCount++;
      capturedConfig = config;
    };
    try {
      const opts = parseArgs(["--apply"]);
      await calibrate(opts, _calibrateDeps);
      expect(writeCount).toBe(1);
      const routing = capturedConfig?.autoMode?.complexityRouting;
      expect(routing).toBeDefined();
      // simple was upgraded from fast → balanced
      expect(routing.simple).toBe("balanced");
      // Other bands are preserved (present with some defined value)
      expect(routing.medium).toBeDefined();
      expect(routing.complex).toBeDefined();
    } finally {
      _calibrateDeps.loadRunMetrics = origLoad;
      _calibrateDeps.writeConfig = origWrite;
    }
  });

  test("AC-24: --apply with zero adjustments never calls writeConfig, exits with code 0 (no throw)", async () => {
    // 10 stories of "simple" where escalationRate=0.1 (below 0.3) and mismatchRate=0 → no upgrade
    const stories = Array.from({ length: 10 }, (_, i) =>
      makeStory({
        complexity: "simple",
        attempts: i === 0 ? 2 : 1, // only 1 escalation → 0.1 < 0.3
        finalTier: "fast",
        firstPassSuccess: true,
      })
    );
    const noAdjRuns = [makeRun(stories)];
    const origLoad = _calibrateDeps.loadRunMetrics;
    const origWrite = _calibrateDeps.writeConfig;
    let writeCount = 0;
    _calibrateDeps.loadRunMetrics = async () => noAdjRuns;
    _calibrateDeps.writeConfig = async () => { writeCount++; };
    try {
      const opts = parseArgs(["--apply"]);
      await expect(calibrate(opts, _calibrateDeps)).resolves.toBeDefined();
      expect(writeCount).toBe(0);
    } finally {
      _calibrateDeps.loadRunMetrics = origLoad;
      _calibrateDeps.writeConfig = origWrite;
    }
  });

  test("AC-25: --min-samples 20 causes band with sampleCount=10 to appear in skipped, not adjustments", async () => {
    // 10 stories of "medium" with threshold-breaching stats — but --min-samples 20 skips them
    const stories = Array.from({ length: 10 }, (_, i) =>
      makeStory({
        complexity: "medium",
        attempts: i < 4 ? 2 : 1,
        finalTier: i < 3 ? "powerful" : "balanced",
        firstPassSuccess: true,
      })
    );
    const fixtureRuns = [makeRun(stories)];
    const origLoad = _calibrateDeps.loadRunMetrics;
    _calibrateDeps.loadRunMetrics = async () => fixtureRuns;
    try {
      const opts = parseArgs(["--min-samples", "20"]);
      const proposal = await calibrate(opts, _calibrateDeps);
      const skippedMedium = proposal.skipped.find((s) => s.band === "medium");
      expect(skippedMedium).toBeDefined();
      expect(skippedMedium!.sampleCount).toBe(10);
      // The min-samples override (20) is reflected in the skipped entry
      expect(skippedMedium!.minSamples).toBe(20);
      expect(proposal.adjustments.some((a) => a.band === "medium")).toBe(false);
    } finally {
      _calibrateDeps.loadRunMetrics = origLoad;
    }
  });

  test("AC-26: empty history → no writeConfig call, no throw, resolves cleanly", async () => {
    const origLoad = _calibrateDeps.loadRunMetrics;
    const origWrite = _calibrateDeps.writeConfig;
    let writeCount = 0;
    _calibrateDeps.loadRunMetrics = async () => [];
    _calibrateDeps.writeConfig = async () => { writeCount++; };
    try {
      const opts = parseArgs(["--apply"]);
      await expect(calibrate(opts, _calibrateDeps)).resolves.toBeDefined();
      expect(writeCount).toBe(0);
    } finally {
      _calibrateDeps.loadRunMetrics = origLoad;
      _calibrateDeps.writeConfig = origWrite;
    }
  });
});

// ---------------------------------------------------------------------------
// US-005: auto-route post-run plugin
// ---------------------------------------------------------------------------

describe("US-005: auto-route plugin", () => {
  test("AC-27: shouldRun returns false when autoRoute.enabled === false", async () => {
    const ctx = makeCtx({ config: { autoRoute: { enabled: false } } });
    const result = await autoRoutePlugin.extensions.postRunAction!.shouldRun(ctx);
    expect(result).toBe(false);
  });

  test("AC-28: shouldRun returns false when no band reaches minSamples (nothing to propose)", async () => {
    // Only 3 stories of "simple" → sampleCount=3 < minSamples=8
    const fewRuns = Array.from({ length: 3 }, () =>
      makeRun([makeStory({ complexity: "simple", attempts: 2, finalTier: "balanced", firstPassSuccess: false })])
    );
    const origLoad = _autoRouteDeps.loadRunMetrics;
    _autoRouteDeps.loadRunMetrics = async () => fewRuns;
    try {
      const ctx = makeCtx({ config: makeEnabledRouteConfig() });
      const result = await autoRoutePlugin.extensions.postRunAction!.shouldRun(ctx);
      expect(result).toBe(false);
    } finally {
      _autoRouteDeps.loadRunMetrics = origLoad;
    }
  });

  test("AC-29: shouldRun returns true when enabled and history yields at least one adjustment", async () => {
    const fixtureRuns = makeUpgradeFixtureRuns();
    const origLoad = _autoRouteDeps.loadRunMetrics;
    _autoRouteDeps.loadRunMetrics = async () => fixtureRuns;
    try {
      const ctx = makeCtx({ config: makeEnabledRouteConfig() });
      const result = await autoRoutePlugin.extensions.postRunAction!.shouldRun(ctx);
      expect(result).toBe(true);
    } finally {
      _autoRouteDeps.loadRunMetrics = origLoad;
    }
  });

  test("AC-30: execute writes routing-proposal.json with parsed adjustments matching fixture", async () => {
    const fixtureRuns = makeUpgradeFixtureRuns();
    const origLoad = _autoRouteDeps.loadRunMetrics;
    const origWrite = _autoRouteDeps.writeFile;
    let writtenPath = "";
    let writtenContent = "";
    _autoRouteDeps.loadRunMetrics = async () => fixtureRuns;
    _autoRouteDeps.writeFile = async (filePath: string, content: string) => {
      writtenPath = filePath;
      writtenContent = content;
    };
    try {
      const ctx = makeCtx({ config: makeEnabledRouteConfig() });
      await autoRoutePlugin.extensions.postRunAction!.execute(ctx);
      expect(writtenPath.endsWith("routing-proposal.json")).toBe(true);
      const parsed = JSON.parse(writtenContent);
      const adj = parsed.adjustments.find(
        (a: any) => a.band === "simple" && a.from === "fast" && a.to === "balanced"
      );
      expect(adj).toBeDefined();
    } finally {
      _autoRouteDeps.loadRunMetrics = origLoad;
      _autoRouteDeps.writeFile = origWrite;
    }
  });

  test("AC-31: execute writes only the proposal artifact — never writes complexityRouting or autoMode path", async () => {
    const fixtureRuns = makeUpgradeFixtureRuns();
    const origLoad = _autoRouteDeps.loadRunMetrics;
    const origWrite = _autoRouteDeps.writeFile;
    const writtenPaths: string[] = [];
    _autoRouteDeps.loadRunMetrics = async () => fixtureRuns;
    _autoRouteDeps.writeFile = async (filePath: string) => {
      writtenPaths.push(filePath);
    };
    try {
      const ctx = makeCtx({ config: makeEnabledRouteConfig() });
      await autoRoutePlugin.extensions.postRunAction!.execute(ctx);
      expect(writtenPaths).toHaveLength(1);
      expect(writtenPaths[0]).toContain("routing-proposal.json");
      expect(writtenPaths.some((p) => p.includes("complexityRouting") || p.includes("autoMode"))).toBe(false);
    } finally {
      _autoRouteDeps.loadRunMetrics = origLoad;
      _autoRouteDeps.writeFile = origWrite;
    }
  });

  test("AC-32: execute returns { success: true } and logs error when writeFile rejects — does not throw", async () => {
    const fixtureRuns = makeUpgradeFixtureRuns();
    const origLoad = _autoRouteDeps.loadRunMetrics;
    const origWrite = _autoRouteDeps.writeFile;
    const errorCalls: unknown[][] = [];
    _autoRouteDeps.loadRunMetrics = async () => fixtureRuns;
    _autoRouteDeps.writeFile = async () => {
      throw new Error("write failed");
    };
    try {
      const ctx = makeCtx({
        config: makeEnabledRouteConfig(),
        logger: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: (...args: unknown[]) => { errorCalls.push(args); },
        },
      });
      const result = await autoRoutePlugin.extensions.postRunAction!.execute(ctx);
      expect(result.success).toBe(true);
      expect(errorCalls.length).toBeGreaterThan(0);
    } finally {
      _autoRouteDeps.loadRunMetrics = origLoad;
      _autoRouteDeps.writeFile = origWrite;
    }
  });

  test("AC-33: loadPlugins with nax-auto-route not disabled yields an action named 'nax-auto-route'", async () => {
    const root = await mkdtemp(join(tmpdir(), "auto-route-reg-"));
    const registry = await loadPlugins(
      join(root, "global"),
      join(root, "project"),
      [],
      root,
      [],
    );
    const actions = registry.getPostRunActions();
    expect(actions.some((a) => a.name === "nax-auto-route")).toBe(true);
  });
});