/**
 * Verify Stage — Runtime Crash Detection (BUG-070)
 *
 * Tests that the verify stage classifies Bun runtime crashes as RUNTIME_CRASH
 * rather than TEST_FAILURE, preventing spurious tier escalation.
 *
 * Tests are RED until:
 * - "RUNTIME_CRASH" is added to VerifyStatus in orchestrator-types.ts
 * - verify.ts checks crash patterns before classifying as TEST_FAILURE
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";
import type { NaxConfig } from "../../../../src/config";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { PRD, UserStory } from "../../../../src/prd";
import type { VerificationResult } from "../../../../src/verification";

const WORKDIR = `/tmp/nax-test-verify-crash-${randomUUID()}`;

// ---------------------------------------------------------------------------
// Helpers
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

function makeConfig(): NaxConfig {
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
        mode: "per-story",
      },
    },
  };
}

function makeContext(): PipelineContext {
  const story = makeStory();
  return {
    config: makeConfig(),
    prd: makePRD(),
    story,
    stories: [story],
    routing: {
      complexity: "simple" as const,
      modelTier: "fast" as const,
      testStrategy: "test-after" as const,
      reasoning: "test",
    },
    workdir: WORKDIR,
    hooks: { hooks: {} },
    storyGitRef: "HEAD~1",
  } as PipelineContext;
}

/** Build a failed VerificationResult with crash output */
function crashResult(crashPattern: string): VerificationResult {
  return {
    status: "TEST_FAILURE",
    success: false,
    output: `bun test v1.3.7\n\n${crashPattern}\n\n`,
    countsTowardEscalation: true,
  };
}

/** Build a normal failed VerificationResult (tests ran, some failed) */
function testFailureResult(): VerificationResult {
  return {
    status: "TEST_FAILURE",
    success: false,
    output: [
      "bun test v1.3.7",
      "",
      "test/unit/foo.test.ts:",
      "  x it fails (2ms)",
      "    error: Expected 1 to equal 2",
      "",
      "1 fail",
    ].join("\n"),
    countsTowardEscalation: true,
  };
}

// ---------------------------------------------------------------------------
// RUNTIME_CRASH classification — each crash pattern
// ---------------------------------------------------------------------------

describe("verifyStage - sets RUNTIME_CRASH status for panic(main thread)", () => {
  afterEach(() => {
    mock.restore();
  });

  test("classifies panic(main thread) output as RUNTIME_CRASH", async () => {
    const { verifyStage, _verifyDeps } = await import(
      "../../../../src/pipeline/stages/verify"
    );
    const { _smartRunnerDeps } = await import(
      "../../../../src/verification/smart-runner"
    );

    const origRegression = _verifyDeps.regression;
    const origGetChanged = _smartRunnerDeps.getChangedSourceFiles;
    const origMapSource = _smartRunnerDeps.mapSourceToTests;

    _smartRunnerDeps.getChangedSourceFiles = mock(() => Promise.resolve(["src/foo.ts"]));
    _smartRunnerDeps.mapSourceToTests = mock(() => Promise.resolve(["test/unit/foo.test.ts"]));
    _verifyDeps.regression = mock(() => Promise.resolve(crashResult("panic(main thread)")));

    try {
      const ctx = makeContext();
      await verifyStage.execute(ctx as Parameters<typeof verifyStage.execute>[0]);

      // RED: status will be "TEST_FAILURE" until crash detection is implemented
      expect(ctx.verifyResult?.status).toBe("RUNTIME_CRASH");
    } finally {
      _verifyDeps.regression = origRegression;
      _smartRunnerDeps.getChangedSourceFiles = origGetChanged;
      _smartRunnerDeps.mapSourceToTests = origMapSource;
    }
  });
});

describe("verifyStage - sets RUNTIME_CRASH status for Segmentation fault", () => {
  afterEach(() => {
    mock.restore();
  });

  test("classifies Segmentation fault output as RUNTIME_CRASH", async () => {
    const { verifyStage, _verifyDeps } = await import(
      "../../../../src/pipeline/stages/verify"
    );
    const { _smartRunnerDeps } = await import(
      "../../../../src/verification/smart-runner"
    );

    const origRegression = _verifyDeps.regression;
    const origGetChanged = _smartRunnerDeps.getChangedSourceFiles;
    const origMapSource = _smartRunnerDeps.mapSourceToTests;

    _smartRunnerDeps.getChangedSourceFiles = mock(() => Promise.resolve(["src/foo.ts"]));
    _smartRunnerDeps.mapSourceToTests = mock(() => Promise.resolve(["test/unit/foo.test.ts"]));
    _verifyDeps.regression = mock(() => Promise.resolve(crashResult("Segmentation fault")));

    try {
      const ctx = makeContext();
      await verifyStage.execute(ctx as Parameters<typeof verifyStage.execute>[0]);

      expect(ctx.verifyResult?.status).toBe("RUNTIME_CRASH");
    } finally {
      _verifyDeps.regression = origRegression;
      _smartRunnerDeps.getChangedSourceFiles = origGetChanged;
      _smartRunnerDeps.mapSourceToTests = origMapSource;
    }
  });
});

describe("verifyStage - sets RUNTIME_CRASH status for Bun has crashed", () => {
  afterEach(() => {
    mock.restore();
  });

  test("classifies 'Bun has crashed' output as RUNTIME_CRASH", async () => {
    const { verifyStage, _verifyDeps } = await import(
      "../../../../src/pipeline/stages/verify"
    );
    const { _smartRunnerDeps } = await import(
      "../../../../src/verification/smart-runner"
    );

    const origRegression = _verifyDeps.regression;
    const origGetChanged = _smartRunnerDeps.getChangedSourceFiles;
    const origMapSource = _smartRunnerDeps.mapSourceToTests;

    _smartRunnerDeps.getChangedSourceFiles = mock(() => Promise.resolve(["src/foo.ts"]));
    _smartRunnerDeps.mapSourceToTests = mock(() => Promise.resolve(["test/unit/foo.test.ts"]));
    _verifyDeps.regression = mock(() => Promise.resolve(crashResult("Bun has crashed")));

    try {
      const ctx = makeContext();
      await verifyStage.execute(ctx as Parameters<typeof verifyStage.execute>[0]);

      expect(ctx.verifyResult?.status).toBe("RUNTIME_CRASH");
    } finally {
      _verifyDeps.regression = origRegression;
      _smartRunnerDeps.getChangedSourceFiles = origGetChanged;
      _smartRunnerDeps.mapSourceToTests = origMapSource;
    }
  });

  test("classifies 'oh no: Bun has crashed' output as RUNTIME_CRASH", async () => {
    const { verifyStage, _verifyDeps } = await import(
      "../../../../src/pipeline/stages/verify"
    );
    const { _smartRunnerDeps } = await import(
      "../../../../src/verification/smart-runner"
    );

    const origRegression = _verifyDeps.regression;
    const origGetChanged = _smartRunnerDeps.getChangedSourceFiles;
    const origMapSource = _smartRunnerDeps.mapSourceToTests;

    _smartRunnerDeps.getChangedSourceFiles = mock(() => Promise.resolve(["src/foo.ts"]));
    _smartRunnerDeps.mapSourceToTests = mock(() => Promise.resolve(["test/unit/foo.test.ts"]));
    _verifyDeps.regression = mock(() => Promise.resolve(crashResult("oh no: Bun has crashed")));

    try {
      const ctx = makeContext();
      await verifyStage.execute(ctx as Parameters<typeof verifyStage.execute>[0]);

      expect(ctx.verifyResult?.status).toBe("RUNTIME_CRASH");
    } finally {
      _verifyDeps.regression = origRegression;
      _smartRunnerDeps.getChangedSourceFiles = origGetChanged;
      _smartRunnerDeps.mapSourceToTests = origMapSource;
    }
  });
});

// ---------------------------------------------------------------------------
// RUNTIME_CRASH still returns escalate action
// ---------------------------------------------------------------------------

describe("verifyStage - crash output still returns escalate action", () => {
  afterEach(() => {
    mock.restore();
  });

  test("returns escalate action even when crash is detected", async () => {
    const { verifyStage, _verifyDeps } = await import(
      "../../../../src/pipeline/stages/verify"
    );
    const { _smartRunnerDeps } = await import(
      "../../../../src/verification/smart-runner"
    );

    const origRegression = _verifyDeps.regression;
    const origGetChanged = _smartRunnerDeps.getChangedSourceFiles;
    const origMapSource = _smartRunnerDeps.mapSourceToTests;

    _smartRunnerDeps.getChangedSourceFiles = mock(() => Promise.resolve(["src/foo.ts"]));
    _smartRunnerDeps.mapSourceToTests = mock(() => Promise.resolve(["test/unit/foo.test.ts"]));
    _verifyDeps.regression = mock(() => Promise.resolve(crashResult("panic(main thread)")));

    try {
      const ctx = makeContext();
      const result = await verifyStage.execute(ctx as Parameters<typeof verifyStage.execute>[0]);

      // Crash still escalates (but escalation handler will treat it differently)
      expect(result.action).toBe("escalate");
    } finally {
      _verifyDeps.regression = origRegression;
      _smartRunnerDeps.getChangedSourceFiles = origGetChanged;
      _smartRunnerDeps.mapSourceToTests = origMapSource;
    }
  });

  test("crash verifyResult has success=false", async () => {
    const { verifyStage, _verifyDeps } = await import(
      "../../../../src/pipeline/stages/verify"
    );
    const { _smartRunnerDeps } = await import(
      "../../../../src/verification/smart-runner"
    );

    const origRegression = _verifyDeps.regression;
    const origGetChanged = _smartRunnerDeps.getChangedSourceFiles;
    const origMapSource = _smartRunnerDeps.mapSourceToTests;

    _smartRunnerDeps.getChangedSourceFiles = mock(() => Promise.resolve(["src/foo.ts"]));
    _smartRunnerDeps.mapSourceToTests = mock(() => Promise.resolve(["test/unit/foo.test.ts"]));
    _verifyDeps.regression = mock(() => Promise.resolve(crashResult("Segmentation fault")));

    try {
      const ctx = makeContext();
      await verifyStage.execute(ctx as Parameters<typeof verifyStage.execute>[0]);

      expect(ctx.verifyResult?.success).toBe(false);
    } finally {
      _verifyDeps.regression = origRegression;
      _smartRunnerDeps.getChangedSourceFiles = origGetChanged;
      _smartRunnerDeps.mapSourceToTests = origMapSource;
    }
  });
});

// ---------------------------------------------------------------------------
// Normal test failure still classified as TEST_FAILURE (regression guard)
// ---------------------------------------------------------------------------

describe("verifyStage - normal test failure still produces TEST_FAILURE", () => {
  afterEach(() => {
    mock.restore();
  });

  test("non-crash failure output is classified as TEST_FAILURE", async () => {
    const { verifyStage, _verifyDeps } = await import(
      "../../../../src/pipeline/stages/verify"
    );
    const { _smartRunnerDeps } = await import(
      "../../../../src/verification/smart-runner"
    );

    const origRegression = _verifyDeps.regression;
    const origGetChanged = _smartRunnerDeps.getChangedSourceFiles;
    const origMapSource = _smartRunnerDeps.mapSourceToTests;

    _smartRunnerDeps.getChangedSourceFiles = mock(() => Promise.resolve(["src/foo.ts"]));
    _smartRunnerDeps.mapSourceToTests = mock(() => Promise.resolve(["test/unit/foo.test.ts"]));
    _verifyDeps.regression = mock(() => Promise.resolve(testFailureResult()));

    try {
      const ctx = makeContext();
      await verifyStage.execute(ctx as Parameters<typeof verifyStage.execute>[0]);

      // This should continue to work — non-crash failures = TEST_FAILURE
      expect(ctx.verifyResult?.status).toBe("TEST_FAILURE");
    } finally {
      _verifyDeps.regression = origRegression;
      _smartRunnerDeps.getChangedSourceFiles = origGetChanged;
      _smartRunnerDeps.mapSourceToTests = origMapSource;
    }
  });
});
