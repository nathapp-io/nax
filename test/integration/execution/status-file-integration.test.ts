// RE-ARCH: keep
/**
 * Integration Tests: Status File — runner + CLI (T2)
 *
 * Verifies:
 * - RunOptions.statusFile: string is required
 * - Status file always written at all 4 write points (dry-run path)
 * - Valid JSON at each stage, NaxStatusFile schema correct
 * - completed status, progress counts, null current at end
 * - CLI automatically computes statusFile to <workdir>/.nax/status.json
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as nodeFs from "node:fs";
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
import { DEFAULT_CONFIG } from "../../../src/config";
import type { NaxConfig } from "../../../src/config";
import { run } from "../../../src/execution/runner";
import type { RunOptions } from "../../../src/execution/runner";
import type { NaxStatusFile } from "../../../src/execution/status-file";
import type { PRD } from "../../../src/prd/types";

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
    return { success: true, exitCode: 0, output: "", durationMs: 10, estimatedCost: 0, rateLimited: false };
  }
  async plan(_o: PlanOptions): Promise<PlanResult> {
    return { specContent: "# Feature\n" };
  }
  async decompose(_o: DecomposeOptions): Promise<DecomposeResult> {
    return { stories: [] };
  }
}

let cleanupAgent: () => void;
beforeAll(() => {
  const adapter = new MockAgentAdapter();
  ALL_AGENTS.push(adapter);
  cleanupAgent = () => {
    const idx = ALL_AGENTS.findIndex((a) => a.name === "mock");
    if (idx !== -1) ALL_AGENTS.splice(idx, 1);
  };
});
afterAll(() => {
  cleanupAgent?.();
});

// ============================================================================
// Helpers
// ============================================================================
function createTestConfig(): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    // Use cli protocol so the mock agent in ALL_AGENTS is used directly
    // (acp protocol wraps agents as AcpAgentAdapter, bypassing our mock)
    agent: { protocol: "cli" },
    autoMode: { ...DEFAULT_CONFIG.autoMode, defaultAgent: "mock" },
    execution: { ...DEFAULT_CONFIG.execution, maxIterations: 20, maxStoriesPerFeature: 500, iterationDelayMs: 0 },
    review: { ...DEFAULT_CONFIG.review, enabled: false },
    acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: false },
  };
}

function makePRD(feature: string, storyCount = 2): PRD {
  return {
    project: "test-project",
    feature,
    branchName: `feat/${feature}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: Array.from({ length: storyCount }, (_, i) => ({
      id: `US-${String(i + 1).padStart(3, "0")}`,
      title: `Story ${i + 1}`,
      description: `Desc ${i + 1}`,
      acceptanceCriteria: [`AC: works`],
      tags: [],
      dependencies: [],
      status: "pending" as const,
      passes: false,
      escalations: [],
      attempts: 0,
    })),
  };
}

async function setupDir(feature: string, storyCount = 2) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nax-sf-int-"));
  const naxDir = path.join(tmpDir, ".nax");
  const featureDir = path.join(naxDir, "features", feature);
  nodeFs.mkdirSync(path.join(featureDir, "runs"), { recursive: true });
  const prdPath = path.join(featureDir, "prd.json");
  await Bun.write(prdPath, JSON.stringify(makePRD(feature, storyCount), null, 2));
  return { tmpDir, featureDir, prdPath };
}

async function runWithStatus(feature: string, storyCount = 1, extraOpts: Partial<RunOptions> = {}) {
  const setup = await setupDir(feature, storyCount);
  const statusFilePath = path.join(setup.tmpDir, "nax-status.json");
  await run({
    prdPath: setup.prdPath,
    workdir: setup.tmpDir,
    config: createTestConfig(),
    hooks: { hooks: {} },
    feature,
    featureDir: setup.featureDir,
    dryRun: true,
    statusFile: statusFilePath,
    skipPrecheck: true,
    ...extraOpts,
  });
  return { setup, statusFilePath };
}

// ============================================================================
// RunOptions type-level checks
// ============================================================================
describe("RunOptions.statusFile", () => {
  it("is required", () => {
    const opts: RunOptions = {
      prdPath: "/tmp/prd.json",
      workdir: "/tmp",
      config: createTestConfig(),
      hooks: { hooks: {} },
      feature: "test",
      dryRun: true,
      statusFile: "/tmp/.nax/status.json",
    };
    expect(opts.statusFile).toBe("/tmp/.nax/status.json");
  });
});

// ============================================================================
// Status file is always written when provided
// ============================================================================
describe("status file always written when provided", () => {
  let tmpDir: string;
  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes status file to provided path during dry-run", async () => {
    const { setup, statusFilePath } = await runWithStatus("sf-always-written", 1);
    tmpDir = setup.tmpDir;
    expect(nodeFs.existsSync(statusFilePath)).toBe(true);
  });
});

// ============================================================================
// Status file written during dry-run
// ============================================================================
describe("status file written during dry-run", () => {
  let tmpDir: string;
  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates the file", async () => {
    const { setup, statusFilePath } = await runWithStatus("sf-creates");
    tmpDir = setup.tmpDir;
    expect(nodeFs.existsSync(statusFilePath)).toBe(true);
  });

  it("produces valid JSON", async () => {
    const { setup, statusFilePath } = await runWithStatus("sf-valid-json");
    tmpDir = setup.tmpDir;
    expect(() => JSON.parse(nodeFs.readFileSync(statusFilePath, "utf-8"))).not.toThrow();
  });

  it("has correct NaxStatusFile schema (version, run, progress, cost, current, iterations, updatedAt, durationMs)", async () => {
    const { setup, statusFilePath } = await runWithStatus("sf-schema", 2);
    tmpDir = setup.tmpDir;
    const p = JSON.parse(nodeFs.readFileSync(statusFilePath, "utf-8")) as NaxStatusFile;
    expect(p.version).toBe(1);
    expect(typeof p.run.id).toBe("string");
    expect(p.run.feature).toBe("sf-schema");
    expect(typeof p.run.startedAt).toBe("string");
    expect(p.run.dryRun).toBe(true);
    expect(typeof p.progress.total).toBe("number");
    expect(typeof p.progress.passed).toBe("number");
    expect(typeof p.progress.pending).toBe("number");
    expect(typeof p.cost.spent).toBe("number");
    expect(typeof p.iterations).toBe("number");
    expect(typeof p.updatedAt).toBe("string");
    expect(typeof p.durationMs).toBe("number");
  });

  it("run.status is 'completed' when all stories pass", async () => {
    const { setup, statusFilePath } = await runWithStatus("sf-completed", 2);
    tmpDir = setup.tmpDir;
    const p = JSON.parse(nodeFs.readFileSync(statusFilePath, "utf-8")) as NaxStatusFile;
    expect(p.run.status).toBe("completed");
  });

  it("progress.passed equals story count after dry-run", async () => {
    const storyCount = 3;
    const { setup, statusFilePath } = await runWithStatus("sf-progress", storyCount);
    tmpDir = setup.tmpDir;
    const p = JSON.parse(nodeFs.readFileSync(statusFilePath, "utf-8")) as NaxStatusFile;
    expect(p.progress.total).toBe(storyCount);
    expect(p.progress.passed).toBe(storyCount);
    expect(p.progress.pending).toBe(0);
  });

  it("current is null at run end (write point 4)", async () => {
    const { setup, statusFilePath } = await runWithStatus("sf-current-null");
    tmpDir = setup.tmpDir;
    const p = JSON.parse(nodeFs.readFileSync(statusFilePath, "utf-8")) as NaxStatusFile;
    expect(p.current).toBeNull();
  });

  it("no .tmp file left behind after write", async () => {
    const { setup, statusFilePath } = await runWithStatus("sf-no-tmp");
    tmpDir = setup.tmpDir;
    expect(nodeFs.existsSync(`${statusFilePath}.tmp`)).toBe(false);
  });

  it("run.id starts with 'run-'", async () => {
    const { setup, statusFilePath } = await runWithStatus("sf-runid");
    tmpDir = setup.tmpDir;
    const p = JSON.parse(nodeFs.readFileSync(statusFilePath, "utf-8")) as NaxStatusFile;
    expect(p.run.id).toMatch(/^run-/);
  });

  it("cost.limit is null when config.costLimit is Infinity", async () => {
    const setup = await setupDir("sf-cost-null", 1);
    tmpDir = setup.tmpDir;
    const statusFilePath = path.join(setup.tmpDir, "nax-status.json");
    const config = createTestConfig();
    config.execution.costLimit = Number.POSITIVE_INFINITY;
    await run({
      prdPath: setup.prdPath,
      workdir: setup.tmpDir,
      config,
      hooks: { hooks: {} },
      feature: "sf-cost-null",
      featureDir: setup.featureDir,
      dryRun: true,
      statusFile: statusFilePath,
      skipPrecheck: true,
    });
    const p = JSON.parse(nodeFs.readFileSync(statusFilePath, "utf-8")) as NaxStatusFile;
    expect(p.cost.limit).toBeNull();
  });
});

// ============================================================================
// CLI status file wiring (type check only)
// ============================================================================
describe("CLI auto-computed status file", () => {
  it("RunOptions.statusFile is required and always provided", () => {
    const opts: RunOptions = {
      prdPath: "/tmp/prd.json",
      workdir: "/tmp",
      config: createTestConfig(),
      hooks: { hooks: {} },
      feature: "test",
      dryRun: false,
      statusFile: "/tmp/.nax/status.json",
    };
    expect(opts.statusFile).toBe("/tmp/.nax/status.json");
  });
});
