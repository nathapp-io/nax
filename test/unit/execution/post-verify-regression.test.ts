/**
 * BUG-026: Regression gate timeout acceptance
 *
 * Tests that runPostAgentVerification:
 * - Returns passed when regression gate TIMES OUT and acceptOnTimeout=true (default)
 * - Returns failed when regression gate TIMES OUT and acceptOnTimeout=false
 * - Returns failed when regression gate returns TEST_FAILURE
 * - Defaults acceptOnTimeout to true when not set in config
 *
 * With the removal of scoped verification, post-verify now ONLY runs the full-suite regression gate.
 * These behavioral tests call the actual function with mocked dependencies.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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

const mockRevertStoriesOnFailure = mock(async (opts: any) => opts.prd);
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

/** Create a temp directory for test fixtures. */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nax-post-verify-"));
  return dir;
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
        mode: "per-story",
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
  };
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  // Wire _postVerifyDeps to mocks
  _postVerifyDeps.runVerification = mockRunVerification as typeof _postVerifyDeps.runVerification;
  _postVerifyDeps.revertStoriesOnFailure = mockRevertStoriesOnFailure as typeof _postVerifyDeps.revertStoriesOnFailure;
  _postVerifyDeps.runRectificationLoop = mockRunRectificationLoop as typeof _postVerifyDeps.runRectificationLoop;
  _postVerifyDeps.getExpectedFiles = () => [];
  _postVerifyDeps.savePRD = mock(async () => {}) as typeof _postVerifyDeps.savePRD;
  _postVerifyDeps.parseBunTestOutput = () => ({ failed: 0, passed: 5, failures: [] }) as any;
  mockRunVerification.mockClear();
  mockRevertStoriesOnFailure.mockClear();
  mockRunRectificationLoop.mockClear();
  _verificationResponses = [];
  _verificationCallIndex = 0;

  tempDir = makeTempDir();
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
    // Now only one call: regression gate times out with acceptOnTimeout=true
    _verificationResponses = [
      { success: false, status: "TIMEOUT", countsTowardEscalation: false },
    ];

    const config = makeConfig({ acceptOnTimeout: true });
    const story = makeStory();
    const prd = makePRD(story);

    const result = await runPostAgentVerification(makeOpts(tempDir, config, story, prd));

    expect(result.passed).toBe(true);
  });

  test("TIMEOUT + acceptOnTimeout=true → revertStoriesOnFailure is NOT called", async () => {
    _verificationResponses = [
      { success: false, status: "TIMEOUT", countsTowardEscalation: false },
    ];

    const config = makeConfig({ acceptOnTimeout: true });
    const story = makeStory();
    const prd = makePRD(story);

    await runPostAgentVerification(makeOpts(tempDir, config, story, prd));

    expect(mockRevertStoriesOnFailure).not.toHaveBeenCalled();
  });

  test("TIMEOUT + acceptOnTimeout=false → runPostAgentVerification returns failed", async () => {
    _verificationResponses = [
      { success: false, status: "TIMEOUT", countsTowardEscalation: false },
    ];

    const config = makeConfig({ acceptOnTimeout: false });
    const story = makeStory();
    const prd = makePRD(story);

    const result = await runPostAgentVerification(makeOpts(tempDir, config, story, prd));

    expect(result.passed).toBe(false);
  });

  test("TIMEOUT + acceptOnTimeout=false → revertStoriesOnFailure IS called", async () => {
    _verificationResponses = [
      { success: false, status: "TIMEOUT", countsTowardEscalation: false },
    ];

    const config = makeConfig({ acceptOnTimeout: false });
    const story = makeStory();
    const prd = makePRD(story);

    await runPostAgentVerification(makeOpts(tempDir, config, story, prd));

    expect(mockRevertStoriesOnFailure).toHaveBeenCalledTimes(1);
  });

  test("TIMEOUT + acceptOnTimeout not set → defaults to true → returns passed", async () => {
    _verificationResponses = [
      { success: false, status: "TIMEOUT", countsTowardEscalation: false },
    ];

    // No acceptOnTimeout — should default to true per BUG-026 spec
    const config = makeConfig({});
    const story = makeStory();
    const prd = makePRD(story);

    const result = await runPostAgentVerification(makeOpts(tempDir, config, story, prd));

    expect(result.passed).toBe(true);
  });

  test("TEST_FAILURE in regression gate → returns failed regardless of acceptOnTimeout", async () => {
    _verificationResponses = [
      { success: false, status: "TEST_FAILURE", countsTowardEscalation: true, output: "FAIL 1" },
    ];

    const config = makeConfig({ acceptOnTimeout: true });
    const story = makeStory();
    const prd = makePRD(story);

    const result = await runPostAgentVerification(makeOpts(tempDir, config, story, prd));

    expect(result.passed).toBe(false);
  });

  test("TEST_FAILURE in regression gate → revertStoriesOnFailure IS called", async () => {
    _verificationResponses = [
      { success: false, status: "TEST_FAILURE", countsTowardEscalation: true, output: "FAIL 1" },
    ];

    const config = makeConfig({ acceptOnTimeout: true });
    const story = makeStory();
    const prd = makePRD(story);

    await runPostAgentVerification(makeOpts(tempDir, config, story, prd));

    expect(mockRevertStoriesOnFailure).toHaveBeenCalledTimes(1);
  });

  test("full-suite regression gate passes → returns passed (one call to runVerification)", async () => {
    _verificationResponses = [
      { success: true, status: "SUCCESS", countsTowardEscalation: true, output: "pass 5" },
    ];

    const config = makeConfig({ acceptOnTimeout: true });
    const story = makeStory();
    const prd = makePRD(story);

    const result = await runPostAgentVerification(makeOpts(tempDir, config, story, prd));

    // Post-verify now ONLY runs the full-suite regression gate (no scoped verification)
    expect(result.passed).toBe(true);
    expect(mockRunVerification).toHaveBeenCalledTimes(1);
  });

  test("regression gate disabled → returns passed (skips regression gate)", async () => {
    _verificationResponses = [];

    const config = makeConfig({ enabled: false, timeoutSeconds: 120 });
    const story = makeStory();
    const prd = makePRD(story);

    const result = await runPostAgentVerification(makeOpts(tempDir, config, story, prd));

    expect(result.passed).toBe(true);
    // No verification calls when regression gate is disabled
    expect(mockRunVerification).toHaveBeenCalledTimes(0);
  });
});
