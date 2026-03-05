/**
 * Verify Stage — per-story regression gate skipping (US-003)
 *
 * When regressionGate.mode is 'deferred', the verify stage must skip
 * calling regression() for each story and return { action: "continue" }.
 * The full-suite regression runs once at the end in run-completion.ts.
 *
 * These tests FAIL until verify.ts checks regressionGate.mode before
 * calling _verifyDeps.regression().
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../../src/config";
import type { PRD, UserStory } from "../../../../src/prd";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";
import type { VerificationResult } from "../../../../src/verification";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeStory(overrides?: Partial<UserStory>): UserStory {
  return {
    id: "US-001",
    title: "Test Story",
    description: "Test",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "in-progress",
    passes: false,
    escalations: [],
    attempts: 1,
    ...overrides,
  };
}

function makePRD(): PRD {
  return {
    project: "test",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [makeStory()],
  };
}

function makeConfig(
  regressionMode?: "deferred" | "per-story" | "disabled",
): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    quality: {
      ...DEFAULT_CONFIG.quality,
      requireTests: true,
      commands: { test: "bun test" },
    },
    execution: {
      ...DEFAULT_CONFIG.execution,
      verificationTimeoutSeconds: 30,
      regressionGate: {
        enabled: true,
        timeoutSeconds: 30,
        acceptOnTimeout: true,
        ...(regressionMode !== undefined ? { mode: regressionMode } : {}),
      },
    },
  };
}

function makeContext(regressionMode?: "deferred" | "per-story" | "disabled") {
  const story = makeStory();
  return {
    config: makeConfig(regressionMode),
    prd: makePRD(),
    story,
    stories: [story],
    routing: {
      complexity: "simple" as const,
      modelTier: "fast" as const,
      testStrategy: "test-after" as const,
      reasoning: "test",
    },
    workdir: "/tmp/nax-test-verify",
    hooks: { hooks: {} },
  };
}

const SUCCESS_RESULT: VerificationResult = {
  status: "SUCCESS",
  success: true,
  countsTowardEscalation: true,
};

// ---------------------------------------------------------------------------
// Per-story regression gate skipping
// ---------------------------------------------------------------------------

describe("verifyStage - deferred mode skips per-story regression", () => {
  afterEach(() => {
    mock.restore();
  });

  test("does not call regression() when mode is 'deferred'", async () => {
    const { verifyStage, _verifyDeps } = await import(
      "../../../../src/pipeline/stages/verify"
    );
    const { _smartRunnerDeps } = await import(
      "../../../../src/verification/smart-runner"
    );

    let regressionCalled = false;
    const origRegression = _verifyDeps.regression;
    const origGetChanged = _smartRunnerDeps.getChangedSourceFiles;
    const origMapSource = _smartRunnerDeps.mapSourceToTests;

    _smartRunnerDeps.getChangedSourceFiles = mock(() => Promise.resolve([]));
    _smartRunnerDeps.mapSourceToTests = mock(() => Promise.resolve([]));
    _verifyDeps.regression = mock((): Promise<VerificationResult> => {
      regressionCalled = true;
      return Promise.resolve(SUCCESS_RESULT);
    });

    try {
      const ctx = makeContext("deferred");
      const result = await verifyStage.execute(ctx as Parameters<typeof verifyStage.execute>[0]);

      expect(regressionCalled).toBe(false);
      expect(result.action).toBe("continue");
    } finally {
      _verifyDeps.regression = origRegression;
      _smartRunnerDeps.getChangedSourceFiles = origGetChanged;
      _smartRunnerDeps.mapSourceToTests = origMapSource;
    }
  });

  test("does not call regression() when mode is unset (defaults to deferred)", async () => {
    const { verifyStage, _verifyDeps } = await import(
      "../../../../src/pipeline/stages/verify"
    );
    const { _smartRunnerDeps } = await import(
      "../../../../src/verification/smart-runner"
    );

    let regressionCalled = false;
    const origRegression = _verifyDeps.regression;
    const origGetChanged = _smartRunnerDeps.getChangedSourceFiles;
    const origMapSource = _smartRunnerDeps.mapSourceToTests;

    _smartRunnerDeps.getChangedSourceFiles = mock(() => Promise.resolve([]));
    _smartRunnerDeps.mapSourceToTests = mock(() => Promise.resolve([]));
    _verifyDeps.regression = mock((): Promise<VerificationResult> => {
      regressionCalled = true;
      return Promise.resolve(SUCCESS_RESULT);
    });

    try {
      // No mode → defaults to 'deferred'
      const ctx = makeContext(undefined);
      const result = await verifyStage.execute(ctx as Parameters<typeof verifyStage.execute>[0]);

      expect(regressionCalled).toBe(false);
      expect(result.action).toBe("continue");
    } finally {
      _verifyDeps.regression = origRegression;
      _smartRunnerDeps.getChangedSourceFiles = origGetChanged;
      _smartRunnerDeps.mapSourceToTests = origMapSource;
    }
  });

  test("still calls regression() when mode is 'per-story'", async () => {
    const { verifyStage, _verifyDeps } = await import(
      "../../../../src/pipeline/stages/verify"
    );
    const { _smartRunnerDeps } = await import(
      "../../../../src/verification/smart-runner"
    );

    let regressionCalled = false;
    const origRegression = _verifyDeps.regression;
    const origGetChanged = _smartRunnerDeps.getChangedSourceFiles;
    const origMapSource = _smartRunnerDeps.mapSourceToTests;

    _smartRunnerDeps.getChangedSourceFiles = mock(() => Promise.resolve([]));
    _smartRunnerDeps.mapSourceToTests = mock(() => Promise.resolve([]));
    _verifyDeps.regression = mock((): Promise<VerificationResult> => {
      regressionCalled = true;
      return Promise.resolve(SUCCESS_RESULT);
    });

    try {
      const ctx = makeContext("per-story");
      await verifyStage.execute(ctx as Parameters<typeof verifyStage.execute>[0]);

      expect(regressionCalled).toBe(true);
    } finally {
      _verifyDeps.regression = origRegression;
      _smartRunnerDeps.getChangedSourceFiles = origGetChanged;
      _smartRunnerDeps.mapSourceToTests = origMapSource;
    }
  });

  test("still calls regression() when mode is 'disabled' (disabled = deferred gate disabled, not per-story)", async () => {
    const { verifyStage, _verifyDeps } = await import(
      "../../../../src/pipeline/stages/verify"
    );
    const { _smartRunnerDeps } = await import(
      "../../../../src/verification/smart-runner"
    );

    let regressionCalled = false;
    const origRegression = _verifyDeps.regression;
    const origGetChanged = _smartRunnerDeps.getChangedSourceFiles;
    const origMapSource = _smartRunnerDeps.mapSourceToTests;

    _smartRunnerDeps.getChangedSourceFiles = mock(() => Promise.resolve([]));
    _smartRunnerDeps.mapSourceToTests = mock(() => Promise.resolve([]));
    _verifyDeps.regression = mock((): Promise<VerificationResult> => {
      regressionCalled = true;
      return Promise.resolve(SUCCESS_RESULT);
    });

    try {
      const ctx = makeContext("disabled");
      await verifyStage.execute(ctx as Parameters<typeof verifyStage.execute>[0]);

      expect(regressionCalled).toBe(true);
    } finally {
      _verifyDeps.regression = origRegression;
      _smartRunnerDeps.getChangedSourceFiles = origGetChanged;
      _smartRunnerDeps.mapSourceToTests = origMapSource;
    }
  });

  test("deferred mode returns continue even without running any tests", async () => {
    const { verifyStage, _verifyDeps } = await import(
      "../../../../src/pipeline/stages/verify"
    );
    const { _smartRunnerDeps } = await import(
      "../../../../src/verification/smart-runner"
    );

    const origRegression = _verifyDeps.regression;
    const origGetChanged = _smartRunnerDeps.getChangedSourceFiles;
    const origMapSource = _smartRunnerDeps.mapSourceToTests;

    _smartRunnerDeps.getChangedSourceFiles = mock(() => Promise.resolve([]));
    _smartRunnerDeps.mapSourceToTests = mock(() => Promise.resolve([]));
    // regression throws to ensure it's truly not called
    _verifyDeps.regression = mock((): Promise<VerificationResult> => {
      throw new Error("regression() must not be called in deferred mode");
    });

    try {
      const ctx = makeContext("deferred");
      const result = await verifyStage.execute(ctx as Parameters<typeof verifyStage.execute>[0]);
      // Should reach here without throwing
      expect(result.action).toBe("continue");
    } finally {
      _verifyDeps.regression = origRegression;
      _smartRunnerDeps.getChangedSourceFiles = origGetChanged;
      _smartRunnerDeps.mapSourceToTests = origMapSource;
    }
  });
});
