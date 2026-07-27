/**
 * runPrecheck canonical-rules-lint orchestrator behavior
 *
 * Ensures canonical rules neutrality violations surface as Tier 1 blockers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionConfig, NaxConfig } from "../../../src/config";
import type { PRD, UserStory } from "../../../src/prd/types";
import { runEnvironmentPrecheck, runPrecheck } from "../../../src/precheck";
import { _checkCliDeps } from "../../../src/precheck/checks-cli";
import { makeTempDir } from "../../helpers/temp";

const createMockConfig = (cwd: string, overrides: Partial<ExecutionConfig> = {}): NaxConfig => ({
  execution: {
    maxIterations: 10,
    iterationDelayMs: 0,
    maxCostUSD: 10,
    testCommand: "echo 'test'",
    lintCommand: "echo 'lint'",
    typecheckCommand: "echo 'typecheck'",
    contextProviderTokenBudget: 2000,
    requireExplicitContextFiles: false,
    preflightExpectedFilesEnabled: false,
    cwd,
    ...overrides,
  },
  autoMode: {
    enabled: false,
    defaultAgent: "test-agent",
    fallbackOrder: [],
    complexityRouting: {
      simple: "fast",
      medium: "balanced",
      complex: "powerful",
      expert: "ultra",
    },
    escalation: {
      enabled: true,
      tierOrder: [],
    },
  },
  quality: {
    minTestCoverage: 80,
  },
  tdd: {
    strategy: "auto",
    skipGeneratedVerificationTests: false,
  },
  models: {},
  rectification: {
    enabled: true,
    maxAttemptsTotal: 2,
    fullSuiteTimeoutSeconds: 120,
    maxFailureSummaryChars: 2000,
    abortOnIncreasingFailures: true,
  },
});

const createMockStory = (overrides: Partial<UserStory> = {}): UserStory => ({
  id: "US-001",
  title: "Test story",
  description: "Test description",
  acceptanceCriteria: ["AC1"],
  tags: [],
  dependencies: [],
  status: "pending",
  passes: false,
  escalations: [],
  attempts: 0,
  ...overrides,
});

const createMockPRD = (stories: UserStory[] = []): PRD => ({
  project: "test-project",
  feature: "test-feature",
  branchName: "test-branch",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  userStories: stories.length > 0 ? stories : [createMockStory()],
});

describe("runPrecheck canonical-rules-lint blocker", () => {
  let testDir: string;
  let originalSpawn: typeof _checkCliDeps.spawn;

  beforeEach(async () => {
    testDir = makeTempDir("nax-precheck-canonical-lint-");

    const git = (args: string[]) =>
      Bun.spawnSync(["git", ...args], { cwd: testDir, stdout: "ignore", stderr: "ignore" });

    git(["init"]);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", "test@test.com"]);
    writeFileSync(join(testDir, "README.md"), "# test");
    mkdirSync(join(testDir, "node_modules"), { recursive: true });
    git(["add", "."]);
    git(["commit", "-m", "init"]);

    originalSpawn = _checkCliDeps.spawn;
    _checkCliDeps.spawn = ((_args: string[], _opts: unknown) => ({
      exited: Promise.resolve(0),
      stdout: null,
      stderr: null,
    })) as typeof _checkCliDeps.spawn;
  });

  afterEach(() => {
    _checkCliDeps.spawn = originalSpawn;
    rmSync(testDir, { recursive: true, force: true });
  });

  test("adds canonical-rules-lint as Tier 1 blocker when neutrality lint fails", async () => {
    const rulesDir = join(testDir, ".nax", "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "bad.md"), "Follow AGENTS.md exactly.");

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { output, exitCode } = await runPrecheck(config, prd, { workdir: testDir, format: "json", silent: true });

    const blocker = output.blockers.find((check) => check.name === "canonical-rules-lint");
    expect(blocker).toBeDefined();
    expect(blocker?.passed).toBe(false);
    expect(output.passed).toBe(false);
    expect(exitCode).toBe(1);
  });

  test("blocks runEnvironmentPrecheck when canonical rules lint fails", async () => {
    const rulesDir = join(testDir, ".nax", "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "bad.md"), "Follow AGENTS.md exactly.");

    const config = createMockConfig(testDir);

    const result = await runEnvironmentPrecheck(config, testDir, { silent: true });

    expect(result.passed).toBe(false);
    const blocker = result.blockers.find((check) => check.name === "canonical-rules-lint");
    expect(blocker).toBeDefined();
    expect(blocker?.passed).toBe(false);
  });
});
