/**
 * Auto-Route Plugin — Acceptance Criteria Tests
 *
 * Mirrors every AC for the assembly story (US-005):
 *  - AC1: shouldRun returns false when ctx.config.autoRoute.enabled === false
 *  - AC2: shouldRun returns false when no band reaches minSamples
 *  - AC3: shouldRun returns true when plugin is enabled and at least one adjustment is produced
 *  - AC4: execute writes a proposal artifact via _deps.writeFile exactly once with
 *         parsed-JSON `adjustments` containing the computed adjustment
 *  - AC5: execute writes to routing-proposal.json only — no autoMode.complexityRouting write
 *  - AC6: execute returns { success: true }, logs via ctx.logger, and does not throw when
 *         _deps.writeFile rejects
 *  - AC7: loadPlugins registers "nax-auto-route" when not in the disabled set
 *
 * The plugin module exposes `_autoRouteDeps` for test injection — no mock.module().
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PostRunContext } from "@/plugins/extensions";
import { loadPlugins } from "@/plugins";
import { autoRoutePlugin, _autoRouteDeps } from "@/plugins/builtin/auto-route";
import type { AutoRouteDeps } from "@/plugins/builtin/auto-route/types";
import type { CalibrationProposal, TierAdjustment } from "@/routing/calibrate/types";

const PLUGIN_NAME = "nax-auto-route";

function makeContext(overrides: Partial<PostRunContext> = {}): PostRunContext {
  return {
    runId: "run-1",
    feature: "auto-route-plugin",
    workdir: "/tmp/workdir",
    prdPath: "/tmp/workdir/prd.json",
    branch: "nax/auto-route",
    totalDurationMs: 60_000,
    totalCost: 0.42,
    storySummary: { completed: 2, failed: 0, skipped: 0, paused: 0 },
    stories: [],
    version: "0.1.0",
    pluginConfig: {},
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    config: {
      autoRoute: {
        enabled: true,
        minSamples: 8,
        upgrade: { escalationRate: 0.3, mismatchRate: 0.25 },
        downgrade: { firstPassRate: 0.9, escalationRate: 0.05 },
      },
    },
    ...overrides,
  };
}

function makeProposal(adjustments: TierAdjustment[]): CalibrationProposal {
  return {
    generatedAt: "2026-07-05T00:00:00.000Z",
    bandStats: [],
    adjustments,
    hints: [],
    skipped: [],
  };
}

function makeAdjustment(): TierAdjustment {
  return {
    band: "medium",
    complexity: "medium",
    from: "balanced",
    to: "powerful",
    fromTier: "balanced",
    toTier: "powerful",
    direction: "upgrade",
    rationale: "escalationRate=0.5 ≥ 0.3, mismatchRate=0.5 ≥ 0.25",
  };
}

let saved: Pick<AutoRouteDeps, "loadRunMetrics" | "writeFile"> & {
  proposeAdjustments: typeof _autoRouteDeps.proposeAdjustments;
  computeBandStats: typeof _autoRouteDeps.computeBandStats;
};

beforeEach(() => {
  saved = {
    loadRunMetrics: _autoRouteDeps.loadRunMetrics,
    writeFile: _autoRouteDeps.writeFile,
    proposeAdjustments: _autoRouteDeps.proposeAdjustments,
    computeBandStats: _autoRouteDeps.computeBandStats,
  };
  _autoRouteDeps.loadRunMetrics = (async () => []) as typeof _autoRouteDeps.loadRunMetrics;
  _autoRouteDeps.writeFile = (async () => {
    // no-op default
  }) as typeof _autoRouteDeps.writeFile;
});

afterEach(() => {
  _autoRouteDeps.loadRunMetrics = saved.loadRunMetrics;
  _autoRouteDeps.writeFile = saved.writeFile;
  _autoRouteDeps.proposeAdjustments = saved.proposeAdjustments;
  _autoRouteDeps.computeBandStats = saved.computeBandStats;
});

// ─── Plugin metadata ────────────────────────────────────────────────────────

describe("autoRoutePlugin — metadata", () => {
  test("name is nax-auto-route", () => {
    expect(autoRoutePlugin.name).toBe(PLUGIN_NAME);
  });

  test("provides a post-run-action extension", () => {
    expect(autoRoutePlugin.provides).toContain("post-run-action");
    expect(autoRoutePlugin.extensions.postRunAction).toBeDefined();
    expect(autoRoutePlugin.extensions.postRunAction?.name).toBe(PLUGIN_NAME);
  });
});

// ─── AC1–AC3: shouldRun ─────────────────────────────────────────────────────

describe("autoRoutePlugin.shouldRun", () => {
  test("AC1 — returns false when ctx.config.autoRoute.enabled === false", async () => {
    const ctx = makeContext({
      config: {
        autoRoute: {
          enabled: false,
          minSamples: 8,
          upgrade: { escalationRate: 0.3, mismatchRate: 0.25 },
          downgrade: { firstPassRate: 0.9, escalationRate: 0.05 },
        },
      },
    });
    expect(await autoRoutePlugin.extensions.postRunAction!.shouldRun(ctx)).toBe(false);
  });

  test("AC2 — returns false when injected history yields no band reaching minSamples", async () => {
    // Mock history with sampleCount well below minSamples (8)
    _autoRouteDeps.loadRunMetrics = (async () => [
      {
        runId: "run-1",
        feature: "x",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:01:00.000Z",
        totalCost: 0,
        totalDurationMs: 0,
        stories: [],
      },
    ]) as typeof _autoRouteDeps.loadRunMetrics;
    const ctx = makeContext();
    expect(await autoRoutePlugin.extensions.postRunAction!.shouldRun(ctx)).toBe(false);
  });

  test("AC3 — returns true when enabled and history yields at least one adjustment", async () => {
    const adjustment = makeAdjustment();
    _autoRouteDeps.proposeAdjustments = (() => makeProposal([adjustment])) as typeof _autoRouteDeps.proposeAdjustments;
    const ctx = makeContext();
    expect(await autoRoutePlugin.extensions.postRunAction!.shouldRun(ctx)).toBe(true);
  });
});

// ─── AC4–AC6: execute ──────────────────────────────────────────────────────

describe("autoRoutePlugin.execute", () => {
  test("AC4 — invokes _deps.writeFile exactly once with a routing-proposal.json path containing the adjustment", async () => {
    const adjustment = makeAdjustment();
    _autoRouteDeps.proposeAdjustments = (() => makeProposal([adjustment])) as typeof _autoRouteDeps.proposeAdjustments;
    const captured: Array<{ path: string; data: string }> = [];
    _autoRouteDeps.writeFile = (async (filePath, contents) => {
      captured.push({ path: filePath, data: contents });
    }) as typeof _autoRouteDeps.writeFile;

    const ctx = makeContext();
    await autoRoutePlugin.extensions.postRunAction!.execute(ctx);

    expect(captured.length).toBe(1);
    expect(captured[0]?.path.endsWith("routing-proposal.json")).toBe(true);
    const parsed = JSON.parse(captured[0]?.data ?? "{}") as {
      adjustments: TierAdjustment[];
    };
    expect(parsed.adjustments).toHaveLength(1);
    expect(parsed.adjustments[0]).toEqual(adjustment);
  });

  test("AC5 — happy path writes only to routing-proposal.json (no autoMode.complexityRouting write)", async () => {
    const adjustment = makeAdjustment();
    _autoRouteDeps.proposeAdjustments = (() => makeProposal([adjustment])) as typeof _autoRouteDeps.proposeAdjustments;
    const captured: Array<{ path: string; data: string }> = [];
    _autoRouteDeps.writeFile = (async (filePath, contents) => {
      captured.push({ path: filePath, data: contents });
    }) as typeof _autoRouteDeps.writeFile;

    const ctx = makeContext();
    await autoRoutePlugin.extensions.postRunAction!.execute(ctx);

    expect(captured.length).toBe(1);
    expect(captured[0]?.path.endsWith("routing-proposal.json")).toBe(true);
    // No path referencing autoMode.complexityRouting
    const hasAutoModeWrite = captured.some((c) => c.path.includes("autoMode.complexityRouting"));
    expect(hasAutoModeWrite).toBe(false);
  });

  test("AC6 — returns { success: true }, logs via ctx.logger, does not throw when _deps.writeFile rejects", async () => {
    let warned: { message: string; data?: Record<string, unknown> } | null = null;
    _autoRouteDeps.writeFile = (async () => {
      throw new Error("disk full");
    }) as typeof _autoRouteDeps.writeFile;

    const ctx = makeContext({
      logger: {
        debug: () => {},
        info: () => {},
        warn: (message, data) => {
          warned = { message, ...(data !== undefined ? { data } : {}) };
        },
        error: () => {},
      },
    });

    let result;
    let threw = false;
    try {
      result = await autoRoutePlugin.extensions.postRunAction!.execute(ctx);
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result?.success).toBe(true);
    expect(warned).not.toBeNull();
    expect(warned?.message.toLowerCase()).toContain("auto-route");
  });
});

// ─── AC7: loader registration ──────────────────────────────────────────────

describe("loadPlugins — autoRoute registration", () => {
  test("AC7 — getPostRunActions() includes 'nax-auto-route' when not disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "autoroute-registration-"));
    const registry = await loadPlugins(
      join(root, "global"),
      join(root, "project"),
      [],
      root,
      [],
    );
    const actions = registry.getPostRunActions();
    expect(actions.some((a) => a.name === PLUGIN_NAME)).toBe(true);
  });

  test("autoRoute is excluded from getPostRunActions() when 'nax-auto-route' is in disabledPlugins", async () => {
    const root = await mkdtemp(join(tmpdir(), "autoroute-registration-"));
    const registry = await loadPlugins(
      join(root, "global"),
      join(root, "project"),
      [],
      root,
      [PLUGIN_NAME],
    );
    const actions = registry.getPostRunActions();
    expect(actions.some((a) => a.name === PLUGIN_NAME)).toBe(false);
  });
});