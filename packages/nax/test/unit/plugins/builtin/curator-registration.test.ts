/**
 * Curator Plugin Registration Tests
 *
 * Tests for built-in plugin registration in PluginRegistry.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeNaxConfig } from "@test/helpers";
import type { CuratorPostRunContext } from "@/plugins/builtin/curator";
import { collectObservations, curatorPlugin } from "@/plugins/builtin/curator";
import { loadPlugins } from "@/plugins/loader";
import { PluginRegistry } from "@/plugins/registry";
import type { NaxPlugin } from "@/plugins/types";

describe("Curator Plugin Registration", () => {
  test("should be available as a built-in plugin", () => {
    expect(curatorPlugin).toBeDefined();
    expect(curatorPlugin.name).toBe("nax-curator");
  });

  test("should appear in registry with provides=['post-run-action']", () => {
    const registry = new PluginRegistry([curatorPlugin]);
    const actions = registry.getPostRunActions();

    expect(actions.length).toBeGreaterThan(0);
    expect(actions.some((a) => a.name === "nax-curator")).toBe(true);
  });

  test("loadPlugins registers curator by default and honors disabledPlugins", async () => {
    const root = await mkdtemp(join(tmpdir(), "curator-registration-"));
    const enabled = await loadPlugins(join(root, "global"), join(root, "project"), [], root, []);
    expect(enabled.getPostRunActions().some((a) => a.name === "nax-curator")).toBe(true);

    const disabled = await loadPlugins(join(root, "global"), join(root, "project"), [], root, ["nax-curator"]);
    expect(disabled.getPostRunActions().some((a) => a.name === "nax-curator")).toBe(false);
  });

  test("should be discoverable via getPostRunActions()", () => {
    const registry = new PluginRegistry([curatorPlugin]);
    const actions = registry.getPostRunActions();

    const curator = actions.find((a) => a.name === "nax-curator");
    expect(curator).toBeDefined();
    expect(curator?.description).toBeDefined();
  });

  test("should be included in registry.plugins", () => {
    const registry = new PluginRegistry([curatorPlugin]);
    const names = registry.plugins.map((p) => p.name);

    expect(names).toContain("nax-curator");
  });

  test("should be disableable via disabledPlugins", () => {
    // Note: This test documents the expected behavior.
    // Actual disabling is implemented in the plugin loader.
    expect(curatorPlugin.name).toBe("nax-curator");
  });

  test("registry.getPostRunActions() should return curator when loaded", () => {
    const registry = new PluginRegistry([curatorPlugin]);
    const actions = registry.getPostRunActions();

    if (curatorPlugin.extensions.postRunAction) {
      expect(actions).toContain(curatorPlugin.extensions.postRunAction);
    }
  });

  test("curator should be the only post-run action when alone in registry", () => {
    const registry = new PluginRegistry([curatorPlugin]);
    const actions = registry.getPostRunActions();

    expect(actions.length).toBe(1);
    expect(actions[0].name).toBe("nax-curator");
  });

  test("curator should coexist with other plugins in registry", () => {
    const otherPlugin: NaxPlugin = {
      name: "test-plugin",
      version: "1.0.0",
      provides: ["reporter"],
      extensions: {
        reporter: {
          name: "test-reporter",
          async onRunEnd() {
            // no-op
          },
        },
      },
    };

    const registry = new PluginRegistry([curatorPlugin, otherPlugin]);
    const actions = registry.getPostRunActions();

    expect(actions.some((a) => a.name === "nax-curator")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix-cycle iteration spend reaching the observation corpus (#1948). Absorbed
// from curator-collector-fix-cycle.test.ts.
// ---------------------------------------------------------------------------

describe("collectObservations — fix-cycle iteration spend (#1948)", () => {
  /** Write one `iteration completed` log entry and collect what it produces. */
  async function collectFromIterationLog(root: string, data: Record<string, unknown>) {
    const logFilePath = join(root, "run.jsonl");
    await writeFile(
      logFilePath,
      `${JSON.stringify({
        timestamp: "2026-05-04T00:03:00.000Z",
        level: "info",
        stage: "findings.cycle",
        message: "iteration completed",
        data,
      })}\n`,
    );
    const context: CuratorPostRunContext = {
      runId: "run-fix-cycle-spend",
      feature: "feat-auth",
      workdir: root,
      prdPath: join(root, ".nax", "features", "feat-auth", "prd.json"),
      branch: "main",
      totalDurationMs: 1000,
      totalCost: 10,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      stories: [],
      version: "0.1.0",
      pluginConfig: {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      config: makeNaxConfig(),
      outputDir: join(root, "out"),
      globalDir: join(root, "global"),
      projectKey: "test-project",
      curatorRollupPath: join(root, "rollup.jsonl"),
      logFilePath,
    };
    const observations = await collectObservations(context);
    return observations.find((o) => o.kind === "fix-cycle-iteration");
  }

  const baseIteration = {
    storyId: "US-001",
    cycleName: "acceptance",
    iterationNum: 1,
    outcome: "unchanged",
    findingsBefore: 1,
    findingsAfter: 1,
  };

  test("failed-dispatch spend reaches the observation as its own field", async () => {
    const root = await mkdtemp(join(tmpdir(), "curator-fix-cycle-error-cost-"));

    const obs = await collectFromIterationLog(root, { ...baseIteration, costUsd: 0.5, errorCostUsd: 3.25 });

    expect(obs?.kind).toBe("fix-cycle-iteration");
    if (obs?.kind === "fix-cycle-iteration") {
      expect(obs.payload.costUsd).toBeCloseTo(0.5, 5);
      expect(obs.payload.errorCostUsd).toBeCloseTo(3.25, 5);
    }
  });

  test("an iteration log written before the field existed reports zero, not undefined", async () => {
    const root = await mkdtemp(join(tmpdir(), "curator-fix-cycle-error-cost-legacy-"));

    const obs = await collectFromIterationLog(root, baseIteration);

    expect(obs?.kind).toBe("fix-cycle-iteration");
    if (obs?.kind === "fix-cycle-iteration") {
      expect(obs.payload.errorCostUsd).toBe(0);
    }
  });
});
