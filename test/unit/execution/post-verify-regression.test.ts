/**
 * BUG-026: Regression gate timeout accepts scoped pass instead of escalating
 *
 * Tests that runRegressionGate (via runPostAgentVerification):
 * - Returns passed when regression gate TIMES OUT and acceptOnTimeout=true (default)
 * - Returns failed when regression gate TIMES OUT and acceptOnTimeout=false
 * - Returns failed when regression gate returns TEST_FAILURE (existing behavior unchanged)
 * - Defaults acceptOnTimeout to true when not set in config
 *
 * These are behavioral tests that call the actual function with mocked dependencies.
 * They complement the type-level tests already in post-verify.test.ts.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { NaxConfig } from "../../../src/config";
import type { PRD, UserStory } from "../../../src/prd/types";
import type { StoryMetrics } from "../../../src/metrics";
import type { VerificationResult } from "../../../src/verification";

// ---------------------------------------------------------------------------
// Mock runVerification with call-order-based responses
// ---------------------------------------------------------------------------

type VerResult = Pick<VerificationResult, "success" | "status" | "countsTowardEscalation" | "output" | "error">;

let _verificationResponses: VerResult[] = [];
let _verificationCallIndex = 0;

const mockRunVerification = mock(async (): Promise<VerResult> => {
  const resp =
    _verificationResponses[_verificationCallIndex] ??
    _verificationResponses[_verificationResponses.length - 1];
  _verificationCallIndex++;
  return resp;
});

const mockRevertStoriesOnFailure = mock(async ({ prd }: { prd: PRD; [k: string]: unknown }) => prd);
const mockRunRectificationLoop = mock(async () => false);

// ---------------------------------------------------------------------------
// Static imports — uses _postVerifyDeps pattern (no mock.module() needed)
// ---------------------------------------------------------------------------

import { _postVerifyDeps, runPostAgentVerification } from "../../../src/execution/post-verify";

// ── Capture originals for afterEach restoration ───────────────────────────────
const _origPostVerifyDeps = { ..._postVerifyDeps };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Run a git command in a directory using Bun-native spawn. */
function gitSync(args: string[], cwd: string): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed in ${cwd}`);
  }
}

/** Read stdout from a git command. */
function gitOutput(args: string[], cwd: string): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  return new TextDecoder().decode(proc.stdout).trim();
}

/**
 * Create a temp git repo with two commits so that `git diff storyGitRef HEAD`
 * returns at least one test file — needed for the regression gate to activate.
 */
function makeGitRepo(): { dir: string; storyGitRef: string } {
  const dir = mkdtempSync(join(tmpdir(), "nax-bug026-"));

  gitSync(["init"], dir);
  gitSync(["config", "user.email", "test@example.com"], dir);
  gitSync(["config", "user.name", "test"], dir);

  // Initial commit → becomes storyGitRef
  writeFileSync(join(dir, "src.ts"), "export const x = 1;");
  gitSync(["add", "."], dir);
  gitSync(["commit", "-m", "initial"], dir);
  const storyGitRef = gitOutput(["rev-parse", "HEAD"], dir);

  // Second commit: adds a test file (changed after storyGitRef)
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(
    join(dir, "test", "example.test.ts"),
    'import { test, expect } from "bun:test";\ntest("x", () => expect(1).toBe(1));',
  );
  gitSync(["add", "."], dir);
  gitSync(["commit", "-m", "add test"], dir);

  return { dir, storyGitRef };
}

function makeConfig(
  regressionGateOverrides: Partial<NaxConfig["execution"]["regressionGate"]> = {},
): NaxConfig {
  return {
    version: 1,
    models: {
      fast: "claude-sonnet-4-5",
      balanced: "claude-sonnet-4-5",
      powerful: "claude-opus-4-6",
    },
    autoMode: {
      enabled: true,
      defaultAgent: "nax-agent-claude",
      fallbackOrder: ["nax-agent-claude"],
      complexityRouting: {
        simple: "fast",
        medium: "balanced",
        complex: "powerful",
        expert: "powerful",
      },
      escalation: {
        enabled: true,
        tierOrder: [],
      },
    },
    execution: {
      maxIterations: 100,
      iterationDelayMs: 0,
      costLimit: 50,
      sessionTimeoutSeconds: 600,
      verificationTimeoutSeconds: 30,
      maxStoriesPerFeature: 50,
      smartTestRunner: false,
      rectification: {
        enabled: false,
        maxRetries: 2,
        fullSuiteTimeoutSeconds: 120,
        maxFailureSummaryChars: 2000,
        abortOnIncreasingFailures: true,
      },
      regressionGate: {
        enabled: true,
        timeoutSeconds: 120,
        ...regressionGateOverrides,
      },
      contextProviderTokenBudget: 2000,
    },
    quality: {
      requireTypecheck: false,
      requireLint: false,
      requireTests: true,
      commands: { test: "bun test" },
      forceExit: false,
      detectOpenHandles: false,
      detectOpenHandlesRetries: 0,
      gracePeriodMs: 0,
      drainTimeoutMs: 0,
      shell: false,
      stripEnvVars: [],
      environmentalEscalationDivisor: 3,
    },
    tdd: {
      maxRetries: 2,
      autoVerifyIsolation: false,
      strategy: "off",
      autoApproveVerifier: false,
    },
    constitution: { enabled: false, path: "constitution.md", maxTokens: 2000 },
    analyze: {
      llmEnhanced: false,
      model: "balanced",
      fallbackToKeywords: true,
      maxCodebaseSummaryTokens: 4000,
    },
    review: { enabled: false, checks: [], commands: {} },
    plan: { model: "balanced", outputPath: "features" },
    acceptance: { enabled: false, maxRetries: 2, generateTests: false, testPath: "acceptance.test.ts" },
    routing: { strategy: "keyword" },
    context: {
      testCoverage: {
        enabled: false,
        detail: "names-only",
        maxTokens: 500,
        testPattern: "**/*.test.ts",
        scopeToStory: false,
      },
      autoDetect: { enabled: false, maxFiles: 10, traceImports: false },
    },
  } as unknown as NaxConfig;
}

function makeStory(id = "US-001"): UserStory {
  return {
    id,
    title: "Test story",
    description: "Test",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "in-progress",
    passes: false,
    escalations: [],
    attempts: 0,
    contextFiles: [],
  } as unknown as UserStory;
}

function makePRD(story: UserStory): PRD {
  return {
    id: "prd-001",
    title: "Test PRD",
    userStories: [story],
    version: "1.0",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as PRD;
}

function makeOpts(
  workdir: string,
  storyGitRef: string,
  config: NaxConfig,
  story: UserStory,
  prd: PRD,
) {
  return {
    config,
    prd,
    prdPath: join(workdir, "prd.json"),
    workdir,
    story,
    storiesToExecute: [story],
    allStoryMetrics: [] as StoryMetrics[],
    timeoutRetryCountMap: new Map<string, number>(),
    storyGitRef,
  };
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let tempDir: string;
let storyGitRef: string;

beforeEach(() => {
  // Wire _postVerifyDeps to mocks
  _postVerifyDeps.runVerification = mockRunVerification as typeof _postVerifyDeps.runVerification;
  _postVerifyDeps.parseTestOutput = () => ({ passCount: 5, failCount: 0, isEnvironmentalFailure: false }) as any;
  _postVerifyDeps.getEnvironmentalEscalationThreshold = () => 3;
  _postVerifyDeps.revertStoriesOnFailure = mockRevertStoriesOnFailure as typeof _postVerifyDeps.revertStoriesOnFailure;
  _postVerifyDeps.runRectificationLoop = mockRunRectificationLoop as typeof _postVerifyDeps.runRectificationLoop;
  _postVerifyDeps.getExpectedFiles = () => [];
  _postVerifyDeps.savePRD = mock(async () => {}) as typeof _postVerifyDeps.savePRD;
  _postVerifyDeps.appendProgress = mock(async () => {}) as typeof _postVerifyDeps.appendProgress;
  _postVerifyDeps.getTierConfig = () => undefined as any;
  _postVerifyDeps.parseBunTestOutput = () => ({ failed: 0, passed: 5, failures: [] }) as any;
  mockRunVerification.mockClear();
  mockRevertStoriesOnFailure.mockClear();
  mockRunRectificationLoop.mockClear();
  _verificationResponses = [];
  _verificationCallIndex = 0;

  const repo = makeGitRepo();
  tempDir = repo.dir;
  storyGitRef = repo.storyGitRef;
});

afterEach(() => {
  Object.assign(_postVerifyDeps, _origPostVerifyDeps);
  mock.restore();
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// BUG-026 behavioral tests
// ---------------------------------------------------------------------------

describe("BUG-026: regression gate TIMEOUT acceptance", () => {
  test("TIMEOUT + acceptOnTimeout=true → runPostAgentVerification returns passed", async () => {
    // Call 1: scoped verification passes; Call 2: regression gate times out
    _verificationResponses = [
      { success: true, status: "SUCCESS", countsTowardEscalation: true, output: "pass 5" },
      { success: false, status: "TIMEOUT", countsTowardEscalation: false },
    ];

    const config = makeConfig({ acceptOnTimeout: true });
    const story = makeStory();
    const prd = makePRD(story);

    const result = await runPostAgentVerification(makeOpts(tempDir, storyGitRef, config, story, prd));

    expect(result.passed).toBe(true);
  });

  test("TIMEOUT + acceptOnTimeout=true → revertStoriesOnFailure is NOT called", async () => {
    _verificationResponses = [
      { success: true, status: "SUCCESS", countsTowardEscalation: true, output: "pass 5" },
      { success: false, status: "TIMEOUT", countsTowardEscalation: false },
    ];

    const config = makeConfig({ acceptOnTimeout: true });
    const story = makeStory();
    const prd = makePRD(story);

    await runPostAgentVerification(makeOpts(tempDir, storyGitRef, config, story, prd));

    expect(mockRevertStoriesOnFailure).not.toHaveBeenCalled();
  });

  test("TIMEOUT + acceptOnTimeout=false → runPostAgentVerification returns failed", async () => {
    _verificationResponses = [
      { success: true, status: "SUCCESS", countsTowardEscalation: true, output: "pass 5" },
      { success: false, status: "TIMEOUT", countsTowardEscalation: false },
    ];

    const config = makeConfig({ acceptOnTimeout: false });
    const story = makeStory();
    const prd = makePRD(story);

    const result = await runPostAgentVerification(makeOpts(tempDir, storyGitRef, config, story, prd));

    expect(result.passed).toBe(false);
  });

  test("TIMEOUT + acceptOnTimeout=false → revertStoriesOnFailure IS called", async () => {
    _verificationResponses = [
      { success: true, status: "SUCCESS", countsTowardEscalation: true, output: "pass 5" },
      { success: false, status: "TIMEOUT", countsTowardEscalation: false },
    ];

    const config = makeConfig({ acceptOnTimeout: false });
    const story = makeStory();
    const prd = makePRD(story);

    await runPostAgentVerification(makeOpts(tempDir, storyGitRef, config, story, prd));

    expect(mockRevertStoriesOnFailure).toHaveBeenCalledTimes(1);
  });

  test("TIMEOUT + acceptOnTimeout not set → defaults to true → returns passed", async () => {
    _verificationResponses = [
      { success: true, status: "SUCCESS", countsTowardEscalation: true, output: "pass 5" },
      { success: false, status: "TIMEOUT", countsTowardEscalation: false },
    ];

    // No acceptOnTimeout — should default to true per BUG-026 spec
    const config = makeConfig({});
    const story = makeStory();
    const prd = makePRD(story);

    const result = await runPostAgentVerification(makeOpts(tempDir, storyGitRef, config, story, prd));

    expect(result.passed).toBe(true);
  });

  test("TEST_FAILURE in regression gate → returns failed regardless of acceptOnTimeout", async () => {
    _verificationResponses = [
      { success: true, status: "SUCCESS", countsTowardEscalation: true, output: "pass 5" },
      { success: false, status: "TEST_FAILURE", countsTowardEscalation: true, output: "FAIL 1" },
    ];

    const config = makeConfig({ acceptOnTimeout: true });
    const story = makeStory();
    const prd = makePRD(story);

    const result = await runPostAgentVerification(makeOpts(tempDir, storyGitRef, config, story, prd));

    expect(result.passed).toBe(false);
  });

  test("TEST_FAILURE in regression gate → revertStoriesOnFailure IS called", async () => {
    _verificationResponses = [
      { success: true, status: "SUCCESS", countsTowardEscalation: true, output: "pass 5" },
      { success: false, status: "TEST_FAILURE", countsTowardEscalation: true, output: "FAIL 1" },
    ];

    const config = makeConfig({ acceptOnTimeout: true });
    const story = makeStory();
    const prd = makePRD(story);

    await runPostAgentVerification(makeOpts(tempDir, storyGitRef, config, story, prd));

    expect(mockRevertStoriesOnFailure).toHaveBeenCalledTimes(1);
  });

  test("regression gate runs second → runVerification called twice (scoped + full suite)", async () => {
    _verificationResponses = [
      { success: true, status: "SUCCESS", countsTowardEscalation: true, output: "pass 5" },
      { success: false, status: "TIMEOUT", countsTowardEscalation: false },
    ];

    const config = makeConfig({ acceptOnTimeout: true });
    const story = makeStory();
    const prd = makePRD(story);

    await runPostAgentVerification(makeOpts(tempDir, storyGitRef, config, story, prd));

    // Once for scoped verification, once for regression gate
    expect(mockRunVerification).toHaveBeenCalledTimes(2);
  });

  test("regression gate disabled → only scoped test runs (one call to runVerification)", async () => {
    _verificationResponses = [
      { success: true, status: "SUCCESS", countsTowardEscalation: true, output: "pass 5" },
    ];

    const config = makeConfig({ enabled: false, timeoutSeconds: 120 });
    const story = makeStory();
    const prd = makePRD(story);

    const result = await runPostAgentVerification(makeOpts(tempDir, storyGitRef, config, story, prd));

    expect(result.passed).toBe(true);
    expect(mockRunVerification).toHaveBeenCalledTimes(1);
  });
});
