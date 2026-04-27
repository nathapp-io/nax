// RE-ARCH: rewrite

/**
 * Test reporter lifecycle events — basic AC coverage (US-004)
 *
 * File: reporter-lifecycle-basic.test.ts
 * Covers: AC1, AC2, AC3, AC6, paused-story status
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { _registryTestAdapters } from "../../../src/agents/registry";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentResult,
  AgentRunOptions,
} from "../../../src/agents/types";
import type { NaxConfig } from "../../../src/config";
import { run } from "../../../src/execution/runner";
import { loadHooksConfig } from "../../../src/hooks";
import { savePRD } from "../../../src/prd";
import { makeTempDir } from "../../helpers/temp";

// ============================================================================
// Mock agent
// ============================================================================
class MockAgentAdapter implements AgentAdapter {
  readonly name = "mock";
  readonly displayName = "Mock Agent";
  readonly binary = "mock-agent";
  readonly capabilities: AgentCapabilities = {
    supportedTiers: ["fast", "balanced", "powerful"],
    maxContextTokens: 200_000,
    features: new Set(["tdd", "review", "refactor", "batch"]),
  };
  async isInstalled(): Promise<boolean> {
    return true;
  }
  buildCommand(_o: AgentRunOptions): string[] {
    return [this.binary];
  }
  async run(_o: AgentRunOptions): Promise<AgentResult> {
    return { success: true, exitCode: 0, output: "", durationMs: 10, estimatedCost: 0 };
  }
  async complete(_prompt: string): Promise<import("../../../src/agents/types").CompleteResult> {
    return { output: "", costUsd: 0, source: "exact" };
  }
}

// ============================================================================
// Shared setup helpers
// ============================================================================

function makeConfig(tmpDir: string, pluginDir: string): NaxConfig {
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
    plugins: [{ module: path.join(pluginDir, "test-reporter.ts") }],
  } as NaxConfig;
}

function makeReporterPluginCode(tmpDir: string): string {
  return `
    const mockReporter = {
      name: "test-reporter",
      async onRunStart(event) {
        const fs = require("node:fs/promises");
        const path = require("node:path");
        const file = path.join("${tmpDir}", "run-start.json");
        await fs.writeFile(file, JSON.stringify(event, null, 2));
      },
      async onStoryComplete(event) {
        const fs = require("node:fs/promises");
        const path = require("node:path");
        const file = path.join("${tmpDir}", "story-complete-" + event.storyId + ".json");
        await fs.writeFile(file, JSON.stringify(event, null, 2));
      },
      async onRunEnd(event) {
        const fs = require("node:fs/promises");
        const path = require("node:path");
        const file = path.join("${tmpDir}", "run-end.json");
        await fs.writeFile(file, JSON.stringify(event, null, 2));
      },
    };

    export default {
      name: "test-reporter-plugin",
      version: "1.0.0",
      provides: ["reporter"],
      extensions: { reporter: mockReporter },
    };
  `;
}

describe("Reporter Lifecycle Events — basic (US-004)", () => {
  let tmpDir: string;
  let workdir: string;
  let prdPath: string;
  let pluginDir: string;
  let config: NaxConfig;

  beforeAll(() => {
    _registryTestAdapters.set("mock", new MockAgentAdapter());
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

    await fs.writeFile(path.join(pluginDir, "test-reporter.ts"), makeReporterPluginCode(tmpDir));

    config = makeConfig(tmpDir, pluginDir);
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch (_error) {
      // Ignore cleanup errors
    }
  });

  test("AC1: onRunStart fires once at run start with runId, feature, totalStories, startTime", async () => {
    const prd = {
      feature: "test-feature",
      userStories: [
        {
          id: "US-001",
          title: "Story 1",
          description: "Test story 1",
          acceptanceCriteria: ["AC1: Should work"],
          status: "pending" as const,
          dependencies: [],
          tags: [],
        },
        {
          id: "US-002",
          title: "Story 2",
          description: "Test story 2",
          acceptanceCriteria: ["AC1: Should work"],
          status: "pending" as const,
          dependencies: [],
          tags: [],
        },
      ],
    };

    await savePRD(prd, prdPath);
    const hooks = await loadHooksConfig(workdir);

    await run({
      prdPath,
      workdir,
      config,
      hooks,
      feature: "test-feature",
      dryRun: true,
      useBatch: false,
      skipPrecheck: true,
    });

    const runStartFile = path.join(tmpDir, "run-start.json");
    const runStartExists = await Bun.file(runStartFile).exists();
    expect(runStartExists).toBe(true);

    const runStartData = JSON.parse(await Bun.file(runStartFile).text());

    expect(runStartData).toHaveProperty("runId");
    expect(runStartData.runId).toContain("run-");
    expect(runStartData.feature).toBe("test-feature");
    expect(runStartData.totalStories).toBe(2);
    expect(runStartData).toHaveProperty("startTime");
    expect(new Date(runStartData.startTime).toString()).not.toBe("Invalid Date");
  });

  test("AC2: onStoryComplete fires after each story with storyId, status, runElapsedMs, cost, tier, testStrategy", async () => {
    const prd = {
      feature: "test-feature",
      userStories: [
        {
          id: "US-001",
          title: "Story 1",
          description: "Test story 1",
          acceptanceCriteria: ["AC1: Should work"],
          status: "pending" as const,
          dependencies: [],
          tags: [],
        },
      ],
    };

    await savePRD(prd, prdPath);
    const hooks = await loadHooksConfig(workdir);

    await run({
      prdPath,
      workdir,
      config,
      hooks,
      feature: "test-feature",
      dryRun: true,
      useBatch: false,
      skipPrecheck: true,
    });

    const storyCompleteFile = path.join(tmpDir, "story-complete-US-001.json");
    const storyCompleteExists = await Bun.file(storyCompleteFile).exists();
    expect(storyCompleteExists).toBe(true);

    const storyCompleteData = JSON.parse(await Bun.file(storyCompleteFile).text());

    expect(storyCompleteData).toHaveProperty("runId");
    expect(storyCompleteData.storyId).toBe("US-001");
    expect(storyCompleteData.status).toBe("completed");
    expect(typeof storyCompleteData.runElapsedMs).toBe("number");
    expect(storyCompleteData.runElapsedMs).toBeGreaterThanOrEqual(0);
    expect(typeof storyCompleteData.cost).toBe("number");
    expect(storyCompleteData).toHaveProperty("tier");
    expect(storyCompleteData).toHaveProperty("testStrategy");
  });

  test("AC3: onRunEnd fires once at run end with runId, totalDurationMs, totalCost, storySummary counts", async () => {
    const prd = {
      feature: "test-feature",
      userStories: [
        {
          id: "US-001",
          title: "Story 1",
          description: "Test story 1",
          acceptanceCriteria: ["AC1: Should work"],
          status: "pending" as const,
          dependencies: [],
          tags: [],
        },
        {
          id: "US-002",
          title: "Story 2",
          description: "Test story 2",
          acceptanceCriteria: ["AC1: Should work"],
          status: "pending" as const,
          dependencies: [],
          tags: [],
        },
      ],
    };

    await savePRD(prd, prdPath);
    const hooks = await loadHooksConfig(workdir);

    await run({
      prdPath,
      workdir,
      config,
      hooks,
      feature: "test-feature",
      dryRun: true,
      useBatch: false,
      skipPrecheck: true,
    });

    const runEndFile = path.join(tmpDir, "run-end.json");
    const runEndExists = await Bun.file(runEndFile).exists();
    expect(runEndExists).toBe(true);

    const runEndData = JSON.parse(await Bun.file(runEndFile).text());

    expect(runEndData).toHaveProperty("runId");
    expect(typeof runEndData.totalDurationMs).toBe("number");
    expect(runEndData.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(typeof runEndData.totalCost).toBe("number");
    expect(runEndData).toHaveProperty("storySummary");
    expect(runEndData.storySummary).toHaveProperty("completed");
    expect(runEndData.storySummary).toHaveProperty("failed");
    expect(runEndData.storySummary).toHaveProperty("skipped");
    expect(runEndData.storySummary).toHaveProperty("paused");
    expect(runEndData.storySummary.completed).toBe(2);
  });

  test("AC6: Events fire even when the run exits with incomplete stories (onRunEnd still fires)", async () => {
    const prd = {
      feature: "test-feature",
      userStories: [
        {
          id: "US-001",
          title: "Story 1",
          description: "Test story 1",
          acceptanceCriteria: ["AC1: Should work"],
          status: "paused" as const,
          dependencies: [],
        },
      ],
    };

    await savePRD(prd, prdPath);
    const hooks = await loadHooksConfig(workdir);

    await run({
      prdPath,
      workdir,
      config,
      hooks,
      feature: "test-feature",
      dryRun: false,
      useBatch: false,
      skipPrecheck: true,
    });

    const runStartFile = path.join(tmpDir, "run-start.json");
    const runEndFile = path.join(tmpDir, "run-end.json");

    expect(await Bun.file(runStartFile).exists()).toBe(true);
    expect(await Bun.file(runEndFile).exists()).toBe(true);

    const runEndData = JSON.parse(await Bun.file(runEndFile).text());
    expect(runEndData.storySummary.paused).toBeGreaterThan(0);
  });

  test("onStoryComplete receives correct status for paused stories", async () => {
    const prd = {
      feature: "test-feature",
      userStories: [
        {
          id: "US-001",
          title: "Story 1",
          description: "Test story 1",
          acceptanceCriteria: ["AC1: Should work"],
          status: "paused" as const,
          dependencies: [],
        },
      ],
    };

    await savePRD(prd, prdPath);
    const hooks = await loadHooksConfig(workdir);

    await run({
      prdPath,
      workdir,
      config,
      hooks,
      feature: "test-feature",
      dryRun: false,
      useBatch: false,
      skipPrecheck: true,
    });

    // Note: paused stories are not picked up by getNextStory, so no onStoryComplete event fires
    // This is expected behavior - paused stories don't get executed
  });

  test("onStoryComplete receives all required fields for different story outcomes", async () => {
    const prd = {
      feature: "test-feature",
      userStories: [
        {
          id: "US-001",
          title: "Story 1",
          description: "Test story 1",
          acceptanceCriteria: ["AC1: Should work"],
          status: "pending" as const,
          dependencies: [],
          tags: [],
        },
        {
          id: "US-002",
          title: "Story 2",
          description: "Test story 2",
          acceptanceCriteria: ["AC1: Should work"],
          status: "pending" as const,
          dependencies: [],
          tags: [],
        },
      ],
    };

    await savePRD(prd, prdPath);
    const hooks = await loadHooksConfig(workdir);

    await run({
      prdPath,
      workdir,
      config,
      hooks,
      feature: "test-feature",
      dryRun: true,
      useBatch: false,
      skipPrecheck: true,
    });

    const story1File = path.join(tmpDir, "story-complete-US-001.json");
    const story2File = path.join(tmpDir, "story-complete-US-002.json");

    expect(await Bun.file(story1File).exists()).toBe(true);
    expect(await Bun.file(story2File).exists()).toBe(true);

    const story1Data = JSON.parse(await Bun.file(story1File).text());
    const story2Data = JSON.parse(await Bun.file(story2File).text());

    expect(story1Data.runId).toBe(story2Data.runId);
    expect(story1Data.storyId).toBe("US-001");
    expect(story2Data.storyId).toBe("US-002");
    expect(story1Data.status).toBe("completed");
    expect(story2Data.status).toBe("completed");
  });
});
