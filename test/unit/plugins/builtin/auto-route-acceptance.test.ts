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
 *
 * Fixture strategy: every test that depends on a proposal seeds `loadRunMetrics`
 * with real `RunMetrics` (story-level `attempts` / `finalTier`) so the
 * `loadRunMetrics → computeBandStats → proposeAdjustments` pipeline runs
 * through to its real output.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDefined } from "@test/helpers";
import type { RunMetrics, StoryMetrics } from "@/metrics";
import { _autoRouteDeps, type AutoRouteDeps, autoRoutePlugin, loadPlugins } from "@/plugins";
import type { PostRunContext } from "@/plugins/extensions";
import type { TierAdjustment } from "@/routing";

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
    outputDir: "/tmp/auto-route-output",
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

function makeStoryMetrics(input: {
  storyId: string;
  complexity: string;
  attempts: number;
  finalTier: string;
}): StoryMetrics {
  return {
    storyId: input.storyId,
    complexity: input.complexity,
    modelTier: "balanced",
    modelUsed: "sonnet",
    agentUsed: "claude",
    attempts: input.attempts,
    finalTier: input.finalTier,
    success: true,
    cost: 0.01,
    durationMs: 1000,
    firstPassSuccess: input.attempts === 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
  };
}

/**
 * History whose `medium` band has 8 stories with escalationRate=0.5 and
 * mismatchRate=0.5 — matches the AC fixture (4 escalated to "powerful",
 * 4 stayed on "balanced"). Default config thresholds (0.3/0.25) trigger
 * an upgrade for "medium" from "balanced" to "powerful".
 */
function makeAdjustmentHistory(): RunMetrics[] {
  const stories: StoryMetrics[] = [];
  for (let i = 0; i < 4; i++) {
    stories.push(
      makeStoryMetrics({
        storyId: `US-${100 + i}`,
        complexity: "medium",
        attempts: 2,
        finalTier: "powerful",
      }),
    );
  }
  for (let i = 0; i < 4; i++) {
    stories.push(
      makeStoryMetrics({
        storyId: `US-${200 + i}`,
        complexity: "medium",
        attempts: 1,
        finalTier: "balanced",
      }),
    );
  }
  return [
    {
      runId: "run-1",
      feature: "auto-route-plugin",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:10:00.000Z",
      totalCost: 0.08,
      totalStories: stories.length,
      storiesCompleted: stories.length,
      storiesFailed: 0,
      totalDurationMs: 600_000,
      stories,
    },
  ];
}

/**
 * Expected adjustment shape produced from `makeAdjustmentHistory()` via
 * the real `computeBandStats` + `proposeAdjustments` pipeline.
 */
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

/**
 * History whose `medium` band has only 7 stories — below `minSamples=8`.
 * `proposeAdjustments` records the band as `skipped` with reason
 * `insufficient-samples` and emits no adjustments.
 */
function makeBelowThresholdHistory(): RunMetrics[] {
  const stories: StoryMetrics[] = [];
  for (let i = 0; i < 7; i++) {
    stories.push(
      makeStoryMetrics({
        storyId: `US-${300 + i}`,
        complexity: "medium",
        attempts: 1,
        finalTier: "balanced",
      }),
    );
  }
  return [
    {
      runId: "run-2",
      feature: "auto-route-plugin",
      startedAt: "2026-01-02T00:00:00.000Z",
      completedAt: "2026-01-02T00:01:00.000Z",
      totalCost: 0.07,
      totalStories: stories.length,
      storiesCompleted: stories.length,
      storiesFailed: 0,
      totalDurationMs: 60_000,
      stories,
    },
  ];
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
    const postRunAction = autoRoutePlugin.extensions.postRunAction;
    assertDefined(postRunAction, "postRunAction");
    expect(await postRunAction.shouldRun(ctx)).toBe(false);
  });

  test("AC2 — returns false when injected history yields no band reaching minSamples", async () => {
    _autoRouteDeps.loadRunMetrics = (async () => makeBelowThresholdHistory()) as typeof _autoRouteDeps.loadRunMetrics;
    const ctx = makeContext();
    const postRunAction = autoRoutePlugin.extensions.postRunAction;
    assertDefined(postRunAction, "postRunAction");
    expect(await postRunAction.shouldRun(ctx)).toBe(false);
  });

  test("AC3 — returns true when enabled and history yields at least one adjustment", async () => {
    _autoRouteDeps.loadRunMetrics = (async () => makeAdjustmentHistory()) as typeof _autoRouteDeps.loadRunMetrics;
    const ctx = makeContext();
    const postRunAction = autoRoutePlugin.extensions.postRunAction;
    assertDefined(postRunAction, "postRunAction");
    expect(await postRunAction.shouldRun(ctx)).toBe(true);
  });

  test("normalizes an agent-qualified complexity rung before calibrating", async () => {
    _autoRouteDeps.loadRunMetrics = (async () => makeAdjustmentHistory()) as typeof _autoRouteDeps.loadRunMetrics;
    const ctx = makeContext({
      config: {
        autoRoute: {
          enabled: true,
          minSamples: 8,
          upgrade: { escalationRate: 0.3, mismatchRate: 0.25 },
          downgrade: { firstPassRate: 0.9, escalationRate: 0.05 },
        },
        autoMode: {
          complexityRouting: {
            simple: "fast",
            medium: { tier: "balanced", agent: "native" },
            complex: "powerful",
            expert: "powerful",
          },
        },
      },
    });
    const postRunAction = autoRoutePlugin.extensions.postRunAction;
    assertDefined(postRunAction, "postRunAction");

    expect(await postRunAction.shouldRun(ctx)).toBe(true);
  });
});

// ─── AC4–AC6: execute ──────────────────────────────────────────────────────

describe("autoRoutePlugin.execute", () => {
  test("AC4 — invokes _deps.writeFile exactly once with a routing-proposal.json path containing the adjustment", async () => {
    _autoRouteDeps.loadRunMetrics = (async () => makeAdjustmentHistory()) as typeof _autoRouteDeps.loadRunMetrics;
    const captured: Array<{ path: string; data: string }> = [];
    _autoRouteDeps.writeFile = (async (filePath, contents) => {
      captured.push({ path: filePath, data: contents });
    }) as typeof _autoRouteDeps.writeFile;

    const ctx = makeContext();
    const postRunAction = autoRoutePlugin.extensions.postRunAction;
    assertDefined(postRunAction, "postRunAction");
    await postRunAction.execute(ctx);

    const expectedAdjustment = makeAdjustment();

    expect(captured.length).toBe(1);
    expect(captured[0]?.path.endsWith("routing-proposal.json")).toBe(true);
    // Resolved directory must match the project outputDir, not cwd.
    expect(captured[0]?.path).toBe(`${ctx.outputDir}/routing-proposal.json`);
    const parsed = JSON.parse(captured[0]?.data ?? "{}") as {
      generatedAt: string;
      adjustments: TierAdjustment[];
    };
    // Artifact contract: generatedAt populated, adjustment matches the
    // computed proposal (no fabrication).
    expect(parsed.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.adjustments).toHaveLength(1);
    expect(parsed.adjustments[0]).toEqual(expectedAdjustment);
  });

  test("AC5 — happy path writes only to routing-proposal.json (no autoMode.complexityRouting write)", async () => {
    _autoRouteDeps.loadRunMetrics = (async () => makeAdjustmentHistory()) as typeof _autoRouteDeps.loadRunMetrics;
    const captured: Array<{ path: string; data: string }> = [];
    _autoRouteDeps.writeFile = (async (filePath, contents) => {
      captured.push({ path: filePath, data: contents });
    }) as typeof _autoRouteDeps.writeFile;

    const ctx = makeContext();
    const postRunAction = autoRoutePlugin.extensions.postRunAction;
    assertDefined(postRunAction, "postRunAction");
    await postRunAction.execute(ctx);

    expect(captured.length).toBe(1);
    expect(captured[0]?.path.endsWith("routing-proposal.json")).toBe(true);
    expect(captured[0]?.path).toBe(`${ctx.outputDir}/routing-proposal.json`);
    // No path referencing autoMode.complexityRouting
    const hasAutoModeWrite = captured.some((c) => c.path.includes("autoMode.complexityRouting"));
    expect(hasAutoModeWrite).toBe(false);
  });

  test("AC6 — returns { success: true }, logs via ctx.logger, does not throw when _deps.writeFile rejects", async () => {
    const warned: { value: { message: string; data?: Record<string, unknown> } | null } = { value: null };
    _autoRouteDeps.loadRunMetrics = (async () => makeAdjustmentHistory()) as typeof _autoRouteDeps.loadRunMetrics;
    _autoRouteDeps.writeFile = (async () => {
      throw new Error("disk full");
    }) as typeof _autoRouteDeps.writeFile;

    const ctx = makeContext({
      logger: {
        debug: () => {},
        info: () => {},
        warn: (message, data) => {
          warned.value = { message, ...(data !== undefined ? { data } : {}) };
        },
        error: () => {},
      },
    });

    let result:
      | Awaited<ReturnType<NonNullable<typeof autoRoutePlugin.extensions.postRunAction>["execute"]>>
      | undefined;
    let threw = false;
    const postRunAction = autoRoutePlugin.extensions.postRunAction;
    assertDefined(postRunAction, "postRunAction");
    try {
      result = await postRunAction.execute(ctx);
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result?.success).toBe(true);
    expect(warned.value).not.toBeNull();
    expect(warned.value?.message.toLowerCase()).toContain("auto-route");
  });
});

// ─── AC7: loader registration ──────────────────────────────────────────────

describe("loadPlugins — autoRoute registration", () => {
  test("AC7 — getPostRunActions() includes 'nax-auto-route' when not disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "autoroute-registration-"));
    const registry = await loadPlugins(join(root, "global"), join(root, "project"), [], root, []);
    const actions = registry.getPostRunActions();
    expect(actions.some((a) => a.name === PLUGIN_NAME)).toBe(true);
  });

  test("autoRoute is excluded from getPostRunActions() when 'nax-auto-route' is in disabledPlugins", async () => {
    const root = await mkdtemp(join(tmpdir(), "autoroute-registration-"));
    const registry = await loadPlugins(join(root, "global"), join(root, "project"), [], root, [PLUGIN_NAME]);
    const actions = registry.getPostRunActions();
    expect(actions.some((a) => a.name === PLUGIN_NAME)).toBe(false);
  });
});
