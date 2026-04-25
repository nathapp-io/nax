/**
 * Tests for runPrecheck() story-size-gate routing behavior (US-001)
 *
 * Verifies that runPrecheck() routes story-size-gate results into the correct tier
 * based on the action config field:
 * - action === 'block' → Tier 1 blockers (fail-fast)
 * - action === 'warn'  → Tier 2 warnings
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PRD, UserStory } from "../../../src/prd/types";
import { _precheckDeps, runPrecheck } from "../../../src/precheck";
import type { StorySizeGateResult } from "../../../src/precheck/story-size-gate";
import { _checkCliDeps } from "../../../src/precheck/checks-cli";
import { cleanupTempDir, makeTempDir } from "../../helpers/temp";
import { makeNaxConfig } from "../../helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Temp repo setup — provides a clean git repo where tier 1 env checks pass
// ─────────────────────────────────────────────────────────────────────────────

let tempDir: string;

beforeAll(async () => {
  tempDir = makeTempDir("nax-routing-test-");

  // Create a clean git repo with an initial commit
  const git = (args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: tempDir, stdout: "pipe", stderr: "pipe" });

  git(["init"]);
  git(["config", "user.email", "test@test.com"]);
  git(["config", "user.name", "Test"]);

  // Create a minimal file so we can make an initial commit
  writeFileSync(join(tempDir, "README.md"), "# test");

  // Create node_modules dir to satisfy checkDependenciesInstalled
  mkdirSync(join(tempDir, "node_modules"), { recursive: true });

  git(["add", "."]);
  git(["commit", "-m", "init"]);
});

afterAll(() => {
  cleanupTempDir(tempDir);
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeConfig(action: "block" | "warn" | "skip") {
  return makeNaxConfig({
    precheck: {
      storySizeGate: {
        enabled: true,
        maxAcCount: 3,
        maxDescriptionLength: 2000,
        maxBulletPoints: 8,
        action,
        maxReplanAttempts: 3,
      },
    },
    version: 1,
    models: { claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" } },
    autoMode: {
      enabled: false,
      defaultAgent: "claude",
      fallbackOrder: ["claude"],
      complexityRouting: { simple: "fast", medium: "balanced", complex: "powerful", expert: "powerful" },
      escalation: { enabled: false, tierOrder: [] },
    },
    routing: { strategy: "keyword" },
    execution: {
      maxIterations: 10,
      iterationDelayMs: 1000,
      costLimit: 10,
      sessionTimeoutSeconds: 600,
      verificationTimeoutSeconds: 300,
      maxStoriesPerFeature: 100,
      rectification: {
        enabled: false,
        maxRetries: 0,
        fullSuiteTimeoutSeconds: 120,
        maxFailureSummaryChars: 2000,
        abortOnIncreasingFailures: false,
      },
      regressionGate: { enabled: false, timeoutSeconds: 120 },
      contextProviderTokenBudget: 2000,
    },
    quality: {
      requireTypecheck: false,
      requireLint: false,
      requireTests: false,
      commands: {},
      forceExit: false,
      detectOpenHandles: false,
      detectOpenHandlesRetries: 1,
      gracePeriodMs: 5000,
      drainTimeoutMs: 2000,
      shell: "/bin/sh",
      stripEnvVars: [],
    },
    tdd: { maxRetries: 0, autoVerifyIsolation: false, autoApproveVerifier: false, strategy: "off" },
    constitution: { enabled: false, path: "", maxTokens: 2000 },
    analyze: { llmEnhanced: false, model: "fast", fallbackToKeywords: true, maxCodebaseSummaryTokens: 5000 },
    review: { enabled: false, checks: [], commands: {} },
    plan: { model: "balanced", outputPath: "" },
    acceptance: { enabled: false, maxRetries: 0, generateTests: false, testPath: "" },
    context: {
      testCoverage: { enabled: false, detail: "names-only", maxTokens: 500, testPattern: "**/*.test.ts", scopeToStory: false },
      autoDetect: { enabled: false, maxFiles: 5, traceImports: false },
    },
  });
}

function makeLargeStory(id: string): UserStory {
  return {
    id,
    title: "Large story",
    description: "Short description",
    acceptanceCriteria: Array(8).fill("AC"),
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
  };
}

function makePRD(stories: UserStory[]): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    userStories: stories,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock setup
// ─────────────────────────────────────────────────────────────────────────────

let origCheckStorySizeGate: typeof _precheckDeps.checkStorySizeGate;
let origSpawn: typeof _checkCliDeps.spawn;

beforeEach(() => {
  origCheckStorySizeGate = _precheckDeps.checkStorySizeGate;
  origSpawn = _checkCliDeps.spawn;

  // Mock agent CLI check to always succeed — avoids dependency on installed CLI tools
  _checkCliDeps.spawn = ((_args: string[], _opts: unknown) => ({
    exited: Promise.resolve(0),
    stdout: null,
    stderr: null,
  })) as typeof _checkCliDeps.spawn;
});

afterEach(() => {
  _precheckDeps.checkStorySizeGate = origCheckStorySizeGate;
  _checkCliDeps.spawn = origSpawn;
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("runPrecheck — story-size-gate routing (US-001)", () => {
  test("places story-size-gate in Tier 1 blockers when action is 'block' and check fails", async () => {
    const config = makeConfig("block");
    const prd = makePRD([makeLargeStory("US-001")]);

    // Mock checkStorySizeGate to return a blocker result (new behavior for action === 'block')
    _precheckDeps.checkStorySizeGate = async (_c: NaxConfig, _p: PRD): Promise<StorySizeGateResult> => ({
      check: {
        name: "story-size-gate",
        tier: "blocker",
        passed: false,
        message: "Story US-001 too large. Run nax plan --decompose US-001",
      },
      flaggedStories: [
        {
          storyId: "US-001",
          signals: {
            acCount: { value: 8, threshold: 3, flagged: true },
            descriptionLength: { value: 17, threshold: 2000, flagged: false },
            bulletPoints: { value: 0, threshold: 8, flagged: false },
          },
          recommendation: "Story US-001 is too large",
        },
      ],
      flaggedStoryIds: ["US-001"],
    });

    const { output } = await runPrecheck(config, prd, { workdir: tempDir, silent: true });

    const blockingCheck = output.blockers.find((b) => b.name === "story-size-gate");
    expect(blockingCheck).toBeDefined();
    expect(blockingCheck?.tier).toBe("blocker");
    expect(output.passed).toBe(false);
  });

  test("places story-size-gate in Tier 2 warnings when action is 'warn' and check fails", async () => {
    const config = makeConfig("warn");
    const prd = makePRD([makeLargeStory("US-001")]);

    // Mock checkStorySizeGate to return a warning result (existing behavior for action === 'warn')
    _precheckDeps.checkStorySizeGate = async (_c: NaxConfig, _p: PRD): Promise<StorySizeGateResult> => ({
      check: {
        name: "story-size-gate",
        tier: "warning",
        passed: false,
        message: "1 large story detected: US-001",
      },
      flaggedStories: [
        {
          storyId: "US-001",
          signals: {
            acCount: { value: 8, threshold: 3, flagged: true },
            descriptionLength: { value: 17, threshold: 2000, flagged: false },
            bulletPoints: { value: 0, threshold: 8, flagged: false },
          },
          recommendation: "Story US-001 is too large",
        },
      ],
      flaggedStoryIds: ["US-001"],
    });

    const { output } = await runPrecheck(config, prd, { workdir: tempDir, silent: true });

    const warningCheck = output.warnings.find((w) => w.name === "story-size-gate");
    expect(warningCheck).toBeDefined();
    expect(warningCheck?.tier).toBe("warning");
    // Must NOT be in blockers
    const blockingCheck = output.blockers.find((b) => b.name === "story-size-gate");
    expect(blockingCheck).toBeUndefined();
  });
});
