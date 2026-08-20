// RE-ARCH: keep
/**
 * Tests for src/precheck/checks.ts — Tier 1 Blocker checks
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionConfig, NaxConfig } from "@/config";
import type { PRD, UserStory } from "@/prd/types";
import { makeTempDir } from "@test/helpers";
import {
  checkCanonicalRulesLint,
  checkClaudeCLI,
  checkDependenciesInstalled,
  checkGitRepoExists,
  checkGitUserConfigured,
  checkPRDValid,
  checkStaleLock,
  checkWorkingTreeClean,
} from "@/precheck/checks";
import { _checkCanonicalRulesDeps } from "@/precheck/checks-system";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const createMockConfig = (overrides: Partial<ExecutionConfig> = {}): NaxConfig => ({
  execution: {
    maxIterations: 10,
    iterationDelayMs: 1000,
    maxCostUSD: 10,
    testCommand: "bun test",
    lintCommand: "bun run lint",
    typecheckCommand: "bun run typecheck",
    contextProviderTokenBudget: 2000,
    requireExplicitContextFiles: false,
    preflightExpectedFilesEnabled: false,
    cwd: process.cwd(),
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

// ─────────────────────────────────────────────────────────────────────────────
// Tier 1 Blockers
// ─────────────────────────────────────────────────────────────────────────────

describe("checkGitRepoExists (Tier 1 blocker)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir("nax-test-precheck-");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("passes when .git directory exists", async () => {
    mkdirSync(join(testDir, ".git"));

    const result = await checkGitRepoExists(testDir);

    expect(result.name).toBe("git-repo-exists");
    expect(result.tier).toBe("blocker");
    expect(result.passed).toBe(true);
    expect(result.message).toContain("git repository");
  });

  test("fails when .git directory does not exist", async () => {
    const result = await checkGitRepoExists(testDir);

    expect(result.name).toBe("git-repo-exists");
    expect(result.tier).toBe("blocker");
    expect(result.passed).toBe(false);
    expect(result.message).toContain("not a git repository");
  });

});

describe("checkWorkingTreeClean (Tier 1 blocker)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir("nax-test-precheck-");
    mkdirSync(join(testDir, ".git"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("uses git status --porcelain command", async () => {
    const result = await checkWorkingTreeClean(testDir);

    expect(result.name).toBe("working-tree-clean");
    expect(result.tier).toBe("blocker");
  });

  test("includes helpful message", async () => {
    const result = await checkWorkingTreeClean(testDir);

    expect(result.message).toBeDefined();
    expect(typeof result.message).toBe("string");
  });
});

describe("checkStaleLock (Tier 1 blocker)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir("nax-test-precheck-");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("passes when no lock file exists", async () => {
    const result = await checkStaleLock(testDir);

    expect(result.name).toBe("no-stale-lock");
    expect(result.tier).toBe("blocker");
    expect(result.passed).toBe(true);
    expect(result.message).toContain("No lock file");
  });

  test("passes when lock file is fresh (< 2 hours old)", async () => {
    const lockPath = join(testDir, "nax.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 12345, startedAt: new Date().toISOString() }));

    const result = await checkStaleLock(testDir);

    expect(result.passed).toBe(true);
    expect(result.message).toContain("Lock file is fresh");
  });

  test("fails when lock file is stale (> 2 hours old) and the holder PID is dead", async () => {
    const lockPath = join(testDir, "nax.lock");
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    // PID 999999 is astronomically unlikely to exist on any real system.
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: threeHoursAgo.toISOString() }));

    const result = await checkStaleLock(testDir);

    expect(result.name).toBe("no-stale-lock");
    expect(result.tier).toBe("blocker");
    expect(result.passed).toBe(false);
    expect(result.message).toContain("stale");
    expect(result.message).toContain("2 hours");
  });

  test("detects exactly 2 hours as the threshold when the holder PID is dead", async () => {
    const lockPath = join(testDir, "nax.lock");
    const twoHoursOneMinuteAgo = new Date(Date.now() - (2 * 60 * 60 * 1000 + 60 * 1000));
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: twoHoursOneMinuteAgo.toISOString() }));

    const result = await checkStaleLock(testDir);

    expect(result.passed).toBe(false);
  });

  test("does not flag an old lock as stale when the holder PID is still alive (clock-skew / sleep-resume guard)", async () => {
    // BUG-42: a system sleep/resume cycle or NTP skew can make Date.now() jump
    // relative to a stale-looking `startedAt`, even though the holder process
    // is still running. A live holder is authoritative and immune to clock
    // jumps — elapsed-time math alone is not.
    const lockPath = join(testDir, "nax.lock");
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: threeHoursAgo.toISOString() }));

    const result = await checkStaleLock(testDir);

    expect(result.passed).toBe(true);
  });
});

describe("checkPRDValid (Tier 1 blocker)", () => {
  test("passes when all stories have required fields", async () => {
    const prd = createMockPRD([
      createMockStory({ id: "US-001", title: "Story 1", description: "Description 1" }),
      createMockStory({ id: "US-002", title: "Story 2", description: "Description 2" }),
    ]);

    const result = await checkPRDValid(prd);

    expect(result.name).toBe("prd-valid");
    expect(result.tier).toBe("blocker");
    expect(result.passed).toBe(true);
    expect(result.message).toContain("valid");
  });

  test.each([
    ["id", { id: "", title: "Story", description: "Description" }, "id"],
    ["title", { id: "US-001", title: "", description: "Description" }, "title"],
    ["description", { id: "US-001", title: "Story", description: "" }, "description"],
  ])("fails when story is missing %s", async (_label, overrides, needle) => {
    const prd = createMockPRD([createMockStory(overrides)]);
    const result = await checkPRDValid(prd);
    expect(result.passed).toBe(false);
    expect(result.message).toContain(needle);
  });

  test("auto-defaults missing tags to empty array in-memory", async () => {
    const storyWithoutTags = {
      id: "US-001",
      title: "Story",
      description: "Description",
      acceptanceCriteria: [],
      dependencies: [],
      status: "pending" as const,
      passes: false,
      escalations: [],
      attempts: 0,
    } as any;

    const prd = createMockPRD([storyWithoutTags]);

    const result = await checkPRDValid(prd);

    expect(result.passed).toBe(true);
    expect(prd.userStories[0].tags).toEqual([]);
  });

  test("auto-defaults missing status to pending in-memory", async () => {
    const storyWithoutStatus = {
      id: "US-001",
      title: "Story",
      description: "Description",
      acceptanceCriteria: [],
      tags: [],
      dependencies: [],
      passes: false,
      escalations: [],
      attempts: 0,
    } as any;

    const prd = createMockPRD([storyWithoutStatus]);

    const result = await checkPRDValid(prd);

    expect(result.passed).toBe(true);
    expect(prd.userStories[0].status).toBe("pending");
  });

  test("auto-defaults missing storyPoints to 1 in-memory", async () => {
    const storyWithoutPoints = {
      id: "US-001",
      title: "Story",
      description: "Description",
      acceptanceCriteria: [],
      tags: [],
      dependencies: [],
      status: "pending" as const,
      passes: false,
      escalations: [],
      attempts: 0,
    } as any;

    const prd = createMockPRD([storyWithoutPoints]);

    const result = await checkPRDValid(prd);

    expect(result.passed).toBe(true);
  });

  test("checks all required fields per story", async () => {
    const prd = createMockPRD([
      createMockStory({ id: "US-001", title: "Good", description: "Good" }),
      createMockStory({ id: "", title: "Bad", description: "Missing ID" }),
    ]);

    const result = await checkPRDValid(prd);

    expect(result.passed).toBe(false);
  });
});

// Requires real `claude` binary — skipped by default, run with FULL=1.
import { fullTest as skipInCI } from "@test/helpers";

describe("checkClaudeCLI (Tier 1 blocker)", () => {
  skipInCI("runs claude --version command", async () => {
    const result = await checkClaudeCLI();

    expect(result.name).toBe("claude-cli-available");
    expect(result.tier).toBe("blocker");
  });

  skipInCI("returns blocker tier", async () => {
    const result = await checkClaudeCLI();

    expect(result.tier).toBe("blocker");
  });

  skipInCI("provides helpful error message on failure", async () => {
    const result = await checkClaudeCLI();

    if (!result.passed) {
      expect(result.message).toContain("claude");
    }
  });
});

describe("checkDependenciesInstalled (Tier 1 blocker)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir("nax-test-precheck-");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test.each([
    ["detects node_modules", "node_modules"],
    ["detects target (Rust)", "target"],
    ["detects venv (Python)", "venv"],
    ["detects vendor (PHP)", "vendor"],
  ])("%s", async (_label, dir) => {
    mkdirSync(join(testDir, dir));

    const result = await checkDependenciesInstalled(testDir);

    expect(result.name).toBe("dependencies-installed");
    expect(result.tier).toBe("blocker");
    expect(result.passed).toBe(true);
    expect(result.message).toContain(dir);
  });

  test("fails when no dependency directories exist", async () => {
    const result = await checkDependenciesInstalled(testDir);

    expect(result.passed).toBe(false);
    expect(result.message).toContain("No dependency");
  });

  test("is language-aware and checks all supported package managers", async () => {
    mkdirSync(join(testDir, "node_modules"));
    mkdirSync(join(testDir, "venv"));

    const result = await checkDependenciesInstalled(testDir);

    expect(result.passed).toBe(true);
  });
});

describe("checkCanonicalRulesLint (Tier 1 blocker)", () => {
  let testDir: string;
  let originalLoadCanonicalRules: typeof _checkCanonicalRulesDeps.loadCanonicalRules;

  beforeEach(() => {
    testDir = makeTempDir("nax-test-precheck-");
    originalLoadCanonicalRules = _checkCanonicalRulesDeps.loadCanonicalRules;
  });

  afterEach(() => {
    _checkCanonicalRulesDeps.loadCanonicalRules = originalLoadCanonicalRules;
    rmSync(testDir, { recursive: true, force: true });
  });

  test("passes when no canonical rules store exists", async () => {
    const result = await checkCanonicalRulesLint(testDir);

    expect(result.name).toBe("canonical-rules-lint");
    expect(result.tier).toBe("blocker");
    expect(result.passed).toBe(true);
    expect(result.message).toContain("passed");
  });

  test("passes when canonical rules are neutral", async () => {
    const rulesDir = join(testDir, ".nax", "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "style.md"), "Use clear naming.\nPrefer immutable updates.");

    const result = await checkCanonicalRulesLint(testDir);

    expect(result.passed).toBe(true);
    expect(result.message).toContain("1 file(s)");
  });

  test("fails when canonical rules contain banned markers", async () => {
    const rulesDir = join(testDir, ".nax", "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "bad.md"), "Do exactly what AGENTS.md says.");

    const result = await checkCanonicalRulesLint(testDir);

    expect(result.passed).toBe(false);
    expect(result.message).toContain("violation");
    expect(result.message).toContain("bad.md");
  });

  test("minimal integration lints repository root canonical rules", async () => {
    mkdirSync(join(testDir, ".nax", "rules"), { recursive: true });
    writeFileSync(join(testDir, ".nax", "rules", "root.md"), "Root guidance.");
    mkdirSync(join(testDir, "packages", "api", ".nax", "rules"), { recursive: true });
    writeFileSync(join(testDir, "packages", "api", ".nax", "rules", "api.md"), "API guidance.");

    const result = await checkCanonicalRulesLint(testDir);

    expect(result.passed).toBe(true);
    expect(result.message).toContain("1 file(s)");
    expect(result.message).toContain("1 root(s)");
  });

  test("fails with generic message when canonical loader throws non-neutrality error", async () => {
    _checkCanonicalRulesDeps.loadCanonicalRules = async () => {
      throw new Error("boom");
    };

    const result = await checkCanonicalRulesLint(testDir);

    expect(result.passed).toBe(false);
    expect(result.message).toContain("Canonical rules lint failed: boom");
  });
});

describe("checkGitUserConfigured (Tier 1 blocker)", () => {
  test("checks git config user.name and user.email", async () => {
    const result = await checkGitUserConfigured();

    expect(result.name).toBe("git-user-configured");
    expect(result.tier).toBe("blocker");
  });

  test("provides helpful message", async () => {
    const result = await checkGitUserConfigured();

    expect(result.message).toBeDefined();
    expect(typeof result.message).toBe("string");
  });
});
