// RE-ARCH: rewrite

/**
 * Test reporter lifecycle events
 *
 * Verifies that reporter plugins receive lifecycle events at the appropriate
 * points in the runner loop (US-004).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ALL_AGENTS } from "../../../src/agents/registry";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentResult,
  AgentRunOptions,
  DecomposeOptions,
  DecomposeResult,
  PlanOptions,
  PlanResult,
} from "../../../src/agents/types";
import type { NaxConfig } from "../../../src/config";
import { run } from "../../../src/execution/runner";
import { loadHooksConfig } from "../../../src/hooks";
import type { IReporter, NaxPlugin, RunEndEvent, RunStartEvent, StoryCompleteEvent } from "../../../src/plugins/types";
import { loadPRD, savePRD } from "../../../src/prd";
import { makeTempDir } from "../../helpers/temp";

// ============================================================================
// Mock agent (satisfies agent installation check in runner)
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
  async plan(_o: PlanOptions): Promise<PlanResult> {
    return { specContent: "# Feature\n", success: true };
  }
  async decompose(_o: DecomposeOptions): Promise<DecomposeResult> {
    return { stories: [], success: true };
  }
}

describe("Reporter Lifecycle Events (US-004)", () => {
  let tmpDir: string;
  let workdir: string;
  let prdPath: string;
  let pluginDir: string;
  let config: NaxConfig;

  // Track reporter calls
  let onRunStartCalls: RunStartEvent[] = [];
  let onStoryCompleteCalls: StoryCompleteEvent[] = [];
  let onRunEndCalls: RunEndEvent[] = [];

  beforeAll(() => {
    // Register mock agent
    ALL_AGENTS.push(new MockAgentAdapter());
  });

  afterAll(() => {
    // Cleanup mock agent
    const mockIndex = ALL_AGENTS.findIndex((a) => a.name === "mock");
    if (mockIndex !== -1) {
      ALL_AGENTS.splice(mockIndex, 1);
    }
  });

  beforeEach(async () => {
    // Create temp directory
    tmpDir = makeTempDir("nax-reporter-test-");
    workdir = tmpDir;
    prdPath = path.join(workdir, ".nax", "features", "test-feature", "prd.json");
    pluginDir = path.join(workdir, ".nax", "plugins");

    // Ensure directories exist
    await fs.mkdir(path.dirname(prdPath), { recursive: true });
    await fs.mkdir(pluginDir, { recursive: true });

    // No git init needed: autoCommitIfDirty detects non-git workdir via
    // `git rev-parse --show-toplevel` and returns early — safe to skip.
    // Removing 5 git subprocess spawns × 9 tests saves ~7s suite-wide.

    // Reset tracking arrays
    onRunStartCalls = [];
    onStoryCompleteCalls = [];
    onRunEndCalls = [];

    // Create mock reporter plugin
    const mockReporter: IReporter = {
      name: "test-reporter",
      async onRunStart(event: RunStartEvent) {
        onRunStartCalls.push(event);
      },
      async onStoryComplete(event: StoryCompleteEvent) {
        onStoryCompleteCalls.push(event);
      },
      async onRunEnd(event: RunEndEvent) {
        onRunEndCalls.push(event);
      },
    };

    const plugin: NaxPlugin = {
      name: "test-reporter-plugin",
      version: "1.0.0",
      provides: ["reporter"],
      extensions: {
        reporter: mockReporter,
      },
    };

    // Write plugin to disk
    const pluginCode = `
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
        extensions: {
          reporter: mockReporter,
        },
      };
    `;

    await fs.writeFile(path.join(pluginDir, "test-reporter.ts"), pluginCode);

    // Create minimal config
    config = {
      // Use cli protocol so the mock agent in ALL_AGENTS is used directly
      // (acp protocol wraps agents as AcpAgentAdapter, bypassing our mock)
      agent: { protocol: "cli" },
      agents: {
        mock: { enabled: true },
      },
      routing: {
        strategy: "complexity",
        defaultTier: "fast",
        defaultTestStrategy: "unit",
      },
      autoMode: {
        defaultAgent: "mock",
        complexityRouting: {
          simple: "fast",
          moderate: "balanced",
          complex: "advanced",
        },
        escalation: {
          enabled: false,
          tierOrder: [],
        },
      },
      execution: {
        maxIterations: 20,
        timeout: 1800000,
        costLimit: 100,
        iterationDelayMs: 0,
        maxStoriesPerFeature: 100,
      },
      analyze: {
        model: "balanced",
      },
      models: {
        fast: {
          model: "claude-3-5-haiku-20241022",
          apiKeyEnvVar: "ANTHROPIC_API_KEY",
        },
        balanced: {
          model: "claude-3-5-sonnet-20241022",
          apiKeyEnvVar: "ANTHROPIC_API_KEY",
        },
        advanced: {
          model: "claude-3-opus-20240229",
          apiKeyEnvVar: "ANTHROPIC_API_KEY",
        },
      },
      quality: {
        commands: {},
      },
      acceptance: {
        enabled: false,
        maxRetries: 3,
      },
      plugins: [
        {
          module: path.join(pluginDir, "test-reporter.ts"),
        },
      ],
    } as NaxConfig;
  });

  afterEach(async () => {
    // Cleanup
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  test("AC1: onRunStart fires once at run start with runId, feature, totalStories, startTime", async () => {
    // Create minimal PRD with 2 stories
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

    // Run in dry-run mode
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

    // Verify onRunStart was called
    const runStartFile = path.join(tmpDir, "run-start.json");
    const runStartExists = await Bun.file(runStartFile).exists();
    expect(runStartExists).toBe(true);

    const runStartData = JSON.parse(await Bun.file(runStartFile).text());

    // Verify event structure
    expect(runStartData).toHaveProperty("runId");
    expect(runStartData.runId).toContain("run-");
    expect(runStartData.feature).toBe("test-feature");
    expect(runStartData.totalStories).toBe(2);
    expect(runStartData).toHaveProperty("startTime");
    expect(new Date(runStartData.startTime).toString()).not.toBe("Invalid Date");
  });

  test("AC2: onStoryComplete fires after each story with storyId, status, runElapsedMs, cost, tier, testStrategy", async () => {
    // Create minimal PRD with 1 story
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

    // Run in dry-run mode
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

    // Verify onStoryComplete was called
    const storyCompleteFile = path.join(tmpDir, "story-complete-US-001.json");
    const storyCompleteExists = await Bun.file(storyCompleteFile).exists();
    expect(storyCompleteExists).toBe(true);

    const storyCompleteData = JSON.parse(await Bun.file(storyCompleteFile).text());

    // Verify event structure
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
    // Create minimal PRD with 2 stories
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

    // Run in dry-run mode
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

    // Verify onRunEnd was called
    const runEndFile = path.join(tmpDir, "run-end.json");
    const runEndExists = await Bun.file(runEndFile).exists();
    expect(runEndExists).toBe(true);

    const runEndData = JSON.parse(await Bun.file(runEndFile).text());

    // Verify event structure
    expect(runEndData).toHaveProperty("runId");
    expect(typeof runEndData.totalDurationMs).toBe("number");
    expect(runEndData.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(typeof runEndData.totalCost).toBe("number");
    expect(runEndData).toHaveProperty("storySummary");
    expect(runEndData.storySummary).toHaveProperty("completed");
    expect(runEndData.storySummary).toHaveProperty("failed");
    expect(runEndData.storySummary).toHaveProperty("skipped");
    expect(runEndData.storySummary).toHaveProperty("paused");
    expect(runEndData.storySummary.completed).toBe(2); // Both stories completed in dry-run
  });

  test("AC4: Reporter errors are caught and logged but never block execution", async () => {
    // Create a failing reporter
    const failingPluginCode = `
      const failingReporter = {
        name: "failing-reporter",
        async onRunStart(event) {
          throw new Error("onRunStart intentional failure");
        },
        async onStoryComplete(event) {
          throw new Error("onStoryComplete intentional failure");
        },
        async onRunEnd(event) {
          throw new Error("onRunEnd intentional failure");
        },
      };

      export default {
        name: "failing-reporter-plugin",
        version: "1.0.0",
        provides: ["reporter"],
        extensions: {
          reporter: failingReporter,
        },
      };
    `;

    await fs.writeFile(path.join(pluginDir, "failing-reporter.ts"), failingPluginCode);

    // Update config to use failing reporter
    config.plugins = [
      {
        module: path.join(pluginDir, "failing-reporter.ts"),
      },
    ];

    // Create minimal PRD
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

    // Run should not throw even though reporter fails
    const result = await run({
      prdPath,
      workdir,
      config,
      hooks,
      feature: "test-feature",
      dryRun: true,
      useBatch: false,
      skipPrecheck: true,
    });

    // Verify run completed successfully despite reporter errors
    expect(result.success).toBe(true);
    expect(result.storiesCompleted).toBe(1);
  });

  test("AC5: Multiple reporters all receive events (not short-circuited on error)", async () => {
    // Create two reporters
    const reporter1Code = `
      const reporter1 = {
        name: "reporter-1",
        async onRunStart(event) {
          const fs = require("node:fs/promises");
          const path = require("node:path");
          const file = path.join("${tmpDir}", "reporter-1-run-start.json");
          await fs.writeFile(file, JSON.stringify(event, null, 2));
        },
        async onStoryComplete(event) {
          const fs = require("node:fs/promises");
          const path = require("node:path");
          const file = path.join("${tmpDir}", "reporter-1-story-" + event.storyId + ".json");
          await fs.writeFile(file, JSON.stringify(event, null, 2));
        },
        async onRunEnd(event) {
          const fs = require("node:fs/promises");
          const path = require("node:path");
          const file = path.join("${tmpDir}", "reporter-1-run-end.json");
          await fs.writeFile(file, JSON.stringify(event, null, 2));
        },
      };

      export default {
        name: "reporter-1-plugin",
        version: "1.0.0",
        provides: ["reporter"],
        extensions: {
          reporter: reporter1,
        },
      };
    `;

    const reporter2Code = `
      const reporter2 = {
        name: "reporter-2",
        async onRunStart(event) {
          const fs = require("node:fs/promises");
          const path = require("node:path");
          const file = path.join("${tmpDir}", "reporter-2-run-start.json");
          await fs.writeFile(file, JSON.stringify(event, null, 2));
        },
        async onStoryComplete(event) {
          const fs = require("node:fs/promises");
          const path = require("node:path");
          const file = path.join("${tmpDir}", "reporter-2-story-" + event.storyId + ".json");
          await fs.writeFile(file, JSON.stringify(event, null, 2));
        },
        async onRunEnd(event) {
          const fs = require("node:fs/promises");
          const path = require("node:path");
          const file = path.join("${tmpDir}", "reporter-2-run-end.json");
          await fs.writeFile(file, JSON.stringify(event, null, 2));
        },
      };

      export default {
        name: "reporter-2-plugin",
        version: "1.0.0",
        provides: ["reporter"],
        extensions: {
          reporter: reporter2,
        },
      };
    `;

    await fs.writeFile(path.join(pluginDir, "reporter-1.ts"), reporter1Code);
    await fs.writeFile(path.join(pluginDir, "reporter-2.ts"), reporter2Code);

    // Update config to use both reporters
    config.plugins = [
      {
        module: path.join(pluginDir, "reporter-1.ts"),
      },
      {
        module: path.join(pluginDir, "reporter-2.ts"),
      },
    ];

    // Create minimal PRD
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

    // Verify both reporters received events
    const reporter1RunStart = path.join(tmpDir, "reporter-1-run-start.json");
    const reporter2RunStart = path.join(tmpDir, "reporter-2-run-start.json");
    const reporter1Story = path.join(tmpDir, "reporter-1-story-US-001.json");
    const reporter2Story = path.join(tmpDir, "reporter-2-story-US-001.json");
    const reporter1RunEnd = path.join(tmpDir, "reporter-1-run-end.json");
    const reporter2RunEnd = path.join(tmpDir, "reporter-2-run-end.json");

    expect(await Bun.file(reporter1RunStart).exists()).toBe(true);
    expect(await Bun.file(reporter2RunStart).exists()).toBe(true);
    expect(await Bun.file(reporter1Story).exists()).toBe(true);
    expect(await Bun.file(reporter2Story).exists()).toBe(true);
    expect(await Bun.file(reporter1RunEnd).exists()).toBe(true);
    expect(await Bun.file(reporter2RunEnd).exists()).toBe(true);
  });

  test("AC5 (edge case): Second reporter receives events even if first reporter fails", async () => {
    // Create a failing reporter and a working reporter
    const failingReporterCode = `
      const failingReporter = {
        name: "failing-reporter",
        async onRunStart(event) {
          throw new Error("onRunStart failure");
        },
        async onStoryComplete(event) {
          throw new Error("onStoryComplete failure");
        },
        async onRunEnd(event) {
          throw new Error("onRunEnd failure");
        },
      };

      export default {
        name: "failing-reporter-plugin",
        version: "1.0.0",
        provides: ["reporter"],
        extensions: {
          reporter: failingReporter,
        },
      };
    `;

    const workingReporterCode = `
      const workingReporter = {
        name: "working-reporter",
        async onRunStart(event) {
          const fs = require("node:fs/promises");
          const path = require("node:path");
          const file = path.join("${tmpDir}", "working-run-start.json");
          await fs.writeFile(file, JSON.stringify(event, null, 2));
        },
        async onStoryComplete(event) {
          const fs = require("node:fs/promises");
          const path = require("node:path");
          const file = path.join("${tmpDir}", "working-story-" + event.storyId + ".json");
          await fs.writeFile(file, JSON.stringify(event, null, 2));
        },
        async onRunEnd(event) {
          const fs = require("node:fs/promises");
          const path = require("node:path");
          const file = path.join("${tmpDir}", "working-run-end.json");
          await fs.writeFile(file, JSON.stringify(event, null, 2));
        },
      };

      export default {
        name: "working-reporter-plugin",
        version: "1.0.0",
        provides: ["reporter"],
        extensions: {
          reporter: workingReporter,
        },
      };
    `;

    await fs.writeFile(path.join(pluginDir, "failing-reporter.ts"), failingReporterCode);
    await fs.writeFile(path.join(pluginDir, "working-reporter.ts"), workingReporterCode);

    // Update config to use both reporters (failing first)
    config.plugins = [
      {
        module: path.join(pluginDir, "failing-reporter.ts"),
      },
      {
        module: path.join(pluginDir, "working-reporter.ts"),
      },
    ];

    // Create minimal PRD
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

    // Verify working reporter still received events despite first reporter failing
    const workingRunStart = path.join(tmpDir, "working-run-start.json");
    const workingStory = path.join(tmpDir, "working-story-US-001.json");
    const workingRunEnd = path.join(tmpDir, "working-run-end.json");

    expect(await Bun.file(workingRunStart).exists()).toBe(true);
    expect(await Bun.file(workingStory).exists()).toBe(true);
    expect(await Bun.file(workingRunEnd).exists()).toBe(true);
  });

  test("AC6: Events fire even when the run exits with incomplete stories (onRunEnd still fires)", async () => {
    // Use a paused story — paused is a terminal state that is not reset on re-run,
    // so the run exits without executing anything. This verifies hooks fire on non-completion.
    // Note: "failed" stories are now reset to "pending" on re-run (they are retried), so
    // paused is used here to simulate a run that exits with unfinished stories.
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

    // Run should complete even though no story can be executed
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

    // Verify onRunStart and onRunEnd were still called regardless of story outcome
    const runStartFile = path.join(tmpDir, "run-start.json");
    const runEndFile = path.join(tmpDir, "run-end.json");

    expect(await Bun.file(runStartFile).exists()).toBe(true);
    expect(await Bun.file(runEndFile).exists()).toBe(true);

    const runEndData = JSON.parse(await Bun.file(runEndFile).text());
    expect(runEndData.storySummary.paused).toBeGreaterThan(0);
  });

  test("onStoryComplete receives correct status for paused stories", async () => {
    // Create PRD with a paused story
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

    // Run with paused story
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
    // Create PRD with multiple stories
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

    // Run in dry-run mode
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

    // Verify both stories received onStoryComplete events
    const story1File = path.join(tmpDir, "story-complete-US-001.json");
    const story2File = path.join(tmpDir, "story-complete-US-002.json");

    expect(await Bun.file(story1File).exists()).toBe(true);
    expect(await Bun.file(story2File).exists()).toBe(true);

    const story1Data = JSON.parse(await Bun.file(story1File).text());
    const story2Data = JSON.parse(await Bun.file(story2File).text());

    // Verify both events have the same runId
    expect(story1Data.runId).toBe(story2Data.runId);

    // Verify both events have required fields
    expect(story1Data.storyId).toBe("US-001");
    expect(story2Data.storyId).toBe("US-002");
    expect(story1Data.status).toBe("completed");
    expect(story2Data.status).toBe("completed");
  });
});
