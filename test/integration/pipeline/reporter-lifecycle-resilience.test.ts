// RE-ARCH: rewrite

/**
 * Test reporter lifecycle events — error resilience and multi-reporter (US-004)
 *
 * File: reporter-lifecycle-resilience.test.ts
 * Covers: AC4 (reporter errors caught), AC5 (multiple reporters, error isolation)
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { _registryTestAdapters } from "@/agents/registry";
import type { NaxConfig } from "@/config";
import { run } from "@/execution/runner";
import { loadHooksConfig } from "@/hooks";
import { savePRD } from "@/prd";
import { makeAgentAdapter, makePRD, makeStory, makeTempDir } from "@test/helpers";

// ============================================================================
// Mock agent
// ============================================================================
const mockAgentAdapter = makeAgentAdapter({
  displayName: "Mock Agent",
  binary: "mock-agent",
  buildCommand: () => ["mock-agent"],
});

// ============================================================================
// Shared setup helpers
// ============================================================================

function makeBaseConfig(): Omit<NaxConfig, "plugins"> {
  return {
    agent: { protocol: "acp", default: "mock" },
    agents: { mock: { enabled: true } },
    routing: {
      strategy: "complexity",
      defaultTier: "fast",
      defaultTestStrategy: "unit",
    },
    autoMode: {
      complexityRouting: { simple: "fast", moderate: "balanced", complex: "advanced" },
      escalation: { enabled: false, tierOrder: [] },
    },
    execution: {
      maxIterations: 20,
      timeout: 1800000,
      costLimit: 100,
      iterationDelayMs: 0,
      maxStoriesPerFeature: 100,
    },
    analyze: { model: "balanced" },
    models: {
      fast: { model: "claude-3-5-haiku-20241022", apiKeyEnvVar: "ANTHROPIC_API_KEY" },
      balanced: { model: "claude-3-5-sonnet-20241022", apiKeyEnvVar: "ANTHROPIC_API_KEY" },
      advanced: { model: "claude-3-opus-20240229", apiKeyEnvVar: "ANTHROPIC_API_KEY" },
    },
    quality: { commands: {} },
    acceptance: { enabled: false, maxRetries: 3 },
  } as Omit<NaxConfig, "plugins">;
}

function minimalPrd(storyId = "US-001") {
  return makePRD({
    feature: "test-feature",
    userStories: [
      makeStory({
        id: storyId,
        title: "Story 1",
        description: "Test story 1",
        acceptanceCriteria: ["AC1: Should work"],
        status: "pending",
      }),
    ],
  });
}

describe("Reporter Lifecycle Events — resilience (US-004)", () => {
  let tmpDir: string;
  let workdir: string;
  let prdPath: string;
  let pluginDir: string;

  beforeAll(() => {
    _registryTestAdapters.set("mock", mockAgentAdapter);
  });

  afterAll(() => {
    _registryTestAdapters.delete("mock");
  });

  beforeEach(async () => {
    tmpDir = makeTempDir("nax-reporter-test-");
    workdir = tmpDir;
    prdPath = path.join(workdir, ".nax", "features", "test-feature", "prd.json");
    pluginDir = path.join(workdir, ".nax", "plugins");

    await fs.mkdir(path.dirname(prdPath), { recursive: true });
    await fs.mkdir(pluginDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch (_error) {
      // Ignore cleanup errors
    }
  });

  test("AC4: Reporter errors are caught and logged but never block execution", async () => {
    const failingPluginCode = `
      const failingReporter = {
        name: "failing-reporter",
        async onRunStart(event) { throw new Error("onRunStart intentional failure"); },
        async onStoryComplete(event) { throw new Error("onStoryComplete intentional failure"); },
        async onRunEnd(event) { throw new Error("onRunEnd intentional failure"); },
      };

      export default {
        name: "failing-reporter-plugin",
        version: "1.0.0",
        provides: ["reporter"],
        extensions: { reporter: failingReporter },
      };
    `;

    await fs.writeFile(path.join(pluginDir, "failing-reporter.ts"), failingPluginCode);

    const config = {
      ...makeBaseConfig(),
      plugins: [{ module: path.join(pluginDir, "failing-reporter.ts") }],
    } as NaxConfig;

    await savePRD(minimalPrd(), prdPath);
    const hooks = await loadHooksConfig(workdir);

    const result = await run({
      prdPath,
      workdir,
      statusFile: `${workdir}/status.json`,
      config,
      hooks,
      feature: "test-feature",
      dryRun: true,
      useBatch: false,
      skipPrecheck: true,
    });

    expect(result.success).toBe(true);
    expect(result.storiesCompleted).toBe(1);
  });

  test("AC5: Multiple reporters all receive events (not short-circuited on error)", async () => {
    const reporter1Code = `
      const reporter1 = {
        name: "reporter-1",
        async onRunStart(event) {
          const fs = require("node:fs/promises");
          const p = require("node:path");
          await fs.writeFile(p.join("${tmpDir}", "reporter-1-run-start.json"), JSON.stringify(event, null, 2));
        },
        async onStoryComplete(event) {
          const fs = require("node:fs/promises");
          const p = require("node:path");
          await fs.writeFile(p.join("${tmpDir}", "reporter-1-story-" + event.storyId + ".json"), JSON.stringify(event, null, 2));
        },
        async onRunEnd(event) {
          const fs = require("node:fs/promises");
          const p = require("node:path");
          await fs.writeFile(p.join("${tmpDir}", "reporter-1-run-end.json"), JSON.stringify(event, null, 2));
        },
      };
      export default { name: "reporter-1-plugin", version: "1.0.0", provides: ["reporter"], extensions: { reporter: reporter1 } };
    `;

    const reporter2Code = `
      const reporter2 = {
        name: "reporter-2",
        async onRunStart(event) {
          const fs = require("node:fs/promises");
          const p = require("node:path");
          await fs.writeFile(p.join("${tmpDir}", "reporter-2-run-start.json"), JSON.stringify(event, null, 2));
        },
        async onStoryComplete(event) {
          const fs = require("node:fs/promises");
          const p = require("node:path");
          await fs.writeFile(p.join("${tmpDir}", "reporter-2-story-" + event.storyId + ".json"), JSON.stringify(event, null, 2));
        },
        async onRunEnd(event) {
          const fs = require("node:fs/promises");
          const p = require("node:path");
          await fs.writeFile(p.join("${tmpDir}", "reporter-2-run-end.json"), JSON.stringify(event, null, 2));
        },
      };
      export default { name: "reporter-2-plugin", version: "1.0.0", provides: ["reporter"], extensions: { reporter: reporter2 } };
    `;

    await fs.writeFile(path.join(pluginDir, "reporter-1.ts"), reporter1Code);
    await fs.writeFile(path.join(pluginDir, "reporter-2.ts"), reporter2Code);

    const config = {
      ...makeBaseConfig(),
      plugins: [{ module: path.join(pluginDir, "reporter-1.ts") }, { module: path.join(pluginDir, "reporter-2.ts") }],
    } as NaxConfig;

    await savePRD(minimalPrd(), prdPath);
    const hooks = await loadHooksConfig(workdir);

    await run({
      prdPath,
      workdir,
      statusFile: `${workdir}/status.json`,
      config,
      hooks,
      feature: "test-feature",
      dryRun: true,
      useBatch: false,
      skipPrecheck: true,
    });

    expect(await Bun.file(path.join(tmpDir, "reporter-1-run-start.json")).exists()).toBe(true);
    expect(await Bun.file(path.join(tmpDir, "reporter-2-run-start.json")).exists()).toBe(true);
    expect(await Bun.file(path.join(tmpDir, "reporter-1-story-US-001.json")).exists()).toBe(true);
    expect(await Bun.file(path.join(tmpDir, "reporter-2-story-US-001.json")).exists()).toBe(true);
    expect(await Bun.file(path.join(tmpDir, "reporter-1-run-end.json")).exists()).toBe(true);
    expect(await Bun.file(path.join(tmpDir, "reporter-2-run-end.json")).exists()).toBe(true);
  });

  test("AC5 (edge case): Second reporter receives events even if first reporter fails", async () => {
    const failingReporterCode = `
      const failingReporter = {
        name: "failing-reporter",
        async onRunStart(event) { throw new Error("onRunStart failure"); },
        async onStoryComplete(event) { throw new Error("onStoryComplete failure"); },
        async onRunEnd(event) { throw new Error("onRunEnd failure"); },
      };
      export default { name: "failing-reporter-plugin", version: "1.0.0", provides: ["reporter"], extensions: { reporter: failingReporter } };
    `;

    const workingReporterCode = `
      const workingReporter = {
        name: "working-reporter",
        async onRunStart(event) {
          const fs = require("node:fs/promises");
          const p = require("node:path");
          await fs.writeFile(p.join("${tmpDir}", "working-run-start.json"), JSON.stringify(event, null, 2));
        },
        async onStoryComplete(event) {
          const fs = require("node:fs/promises");
          const p = require("node:path");
          await fs.writeFile(p.join("${tmpDir}", "working-story-" + event.storyId + ".json"), JSON.stringify(event, null, 2));
        },
        async onRunEnd(event) {
          const fs = require("node:fs/promises");
          const p = require("node:path");
          await fs.writeFile(p.join("${tmpDir}", "working-run-end.json"), JSON.stringify(event, null, 2));
        },
      };
      export default { name: "working-reporter-plugin", version: "1.0.0", provides: ["reporter"], extensions: { reporter: workingReporter } };
    `;

    await fs.writeFile(path.join(pluginDir, "failing-reporter.ts"), failingReporterCode);
    await fs.writeFile(path.join(pluginDir, "working-reporter.ts"), workingReporterCode);

    const config = {
      ...makeBaseConfig(),
      plugins: [
        { module: path.join(pluginDir, "failing-reporter.ts") },
        { module: path.join(pluginDir, "working-reporter.ts") },
      ],
    } as NaxConfig;

    await savePRD(minimalPrd(), prdPath);
    const hooks = await loadHooksConfig(workdir);

    await run({
      prdPath,
      workdir,
      statusFile: `${workdir}/status.json`,
      config,
      hooks,
      feature: "test-feature",
      dryRun: true,
      useBatch: false,
      skipPrecheck: true,
    });

    expect(await Bun.file(path.join(tmpDir, "working-run-start.json")).exists()).toBe(true);
    expect(await Bun.file(path.join(tmpDir, "working-story-US-001.json")).exists()).toBe(true);
    expect(await Bun.file(path.join(tmpDir, "working-run-end.json")).exists()).toBe(true);
  });
});
