// RE-ARCH: keep
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
import { randomUUID } from "node:crypto";
import type { NaxConfig } from "../../../../src/config";
import type { PRD, UserStory } from "../../../../src/prd";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";
import { DEFAULT_TEST_FILE_PATTERNS, globsToTestRegex, globsToPathspec, extractTestDirs } from "../../../../src/test-runners/conventions";
import type { ResolvedTestPatterns } from "../../../../src/test-runners/resolver";
import type { VerificationResult } from "../../../../src/verification";
import type { ResolvedTestCommands } from "../../../../src/quality/command-resolver";
import { makeStory } from "../../../helpers";

/** Pre-built fallback patterns used to mock resolveTestFilePatterns without disk access */
const MOCK_RESOLVED_PATTERNS: ResolvedTestPatterns = {
  globs: DEFAULT_TEST_FILE_PATTERNS,
  pathspec: globsToPathspec(DEFAULT_TEST_FILE_PATTERNS),
  regex: globsToTestRegex(DEFAULT_TEST_FILE_PATTERNS),
  testDirs: extractTestDirs(DEFAULT_TEST_FILE_PATTERNS),
  resolution: "fallback",
};

const WORKDIR = `/tmp/nax-test-verify-${randomUUID()}`;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePRD(): PRD {
  return {
    project: "test",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [makeStory({ status: "in-progress", attempts: 1 })],
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
    workdir: WORKDIR,
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
    const origResolvePatterns = _verifyDeps.resolveTestFilePatterns;
    const origGetChangedTest = _smartRunnerDeps.getChangedTestFiles;
    const origGetChanged = _smartRunnerDeps.getChangedNonTestFiles;
    const origMapSource = _smartRunnerDeps.mapSourceToTests;

    _verifyDeps.resolveTestFilePatterns = mock(() => Promise.resolve(MOCK_RESOLVED_PATTERNS));
    _smartRunnerDeps.getChangedTestFiles = mock(() => Promise.resolve([]));
    _smartRunnerDeps.getChangedNonTestFiles = mock(() => Promise.resolve([]));
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
      _verifyDeps.resolveTestFilePatterns = origResolvePatterns;
      _smartRunnerDeps.getChangedTestFiles = origGetChangedTest;
      _smartRunnerDeps.getChangedNonTestFiles = origGetChanged;
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
    const origResolvePatterns = _verifyDeps.resolveTestFilePatterns;
    const origGetChangedTest = _smartRunnerDeps.getChangedTestFiles;
    const origGetChanged = _smartRunnerDeps.getChangedNonTestFiles;
    const origMapSource = _smartRunnerDeps.mapSourceToTests;

    _verifyDeps.resolveTestFilePatterns = mock(() => Promise.resolve(MOCK_RESOLVED_PATTERNS));
    _smartRunnerDeps.getChangedTestFiles = mock(() => Promise.resolve([]));
    _smartRunnerDeps.getChangedNonTestFiles = mock(() => Promise.resolve([]));
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
      _verifyDeps.resolveTestFilePatterns = origResolvePatterns;
      _smartRunnerDeps.getChangedTestFiles = origGetChangedTest;
      _smartRunnerDeps.getChangedNonTestFiles = origGetChanged;
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
    const origResolvePatterns = _verifyDeps.resolveTestFilePatterns;
    const origGetChangedTest = _smartRunnerDeps.getChangedTestFiles;
    const origGetChanged = _smartRunnerDeps.getChangedNonTestFiles;
    const origMapSource = _smartRunnerDeps.mapSourceToTests;

    _verifyDeps.resolveTestFilePatterns = mock(() => Promise.resolve(MOCK_RESOLVED_PATTERNS));
    _smartRunnerDeps.getChangedTestFiles = mock(() => Promise.resolve([]));
    _smartRunnerDeps.getChangedNonTestFiles = mock(() => Promise.resolve([]));
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
      _verifyDeps.resolveTestFilePatterns = origResolvePatterns;
      _smartRunnerDeps.getChangedTestFiles = origGetChangedTest;
      _smartRunnerDeps.getChangedNonTestFiles = origGetChanged;
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
    const origResolvePatterns = _verifyDeps.resolveTestFilePatterns;
    const origGetChangedTest = _smartRunnerDeps.getChangedTestFiles;
    const origGetChanged = _smartRunnerDeps.getChangedNonTestFiles;
    const origMapSource = _smartRunnerDeps.mapSourceToTests;

    _verifyDeps.resolveTestFilePatterns = mock(() => Promise.resolve(MOCK_RESOLVED_PATTERNS));
    _smartRunnerDeps.getChangedTestFiles = mock(() => Promise.resolve([]));
    _smartRunnerDeps.getChangedNonTestFiles = mock(() => Promise.resolve([]));
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
      _verifyDeps.resolveTestFilePatterns = origResolvePatterns;
      _smartRunnerDeps.getChangedTestFiles = origGetChangedTest;
      _smartRunnerDeps.getChangedNonTestFiles = origGetChanged;
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
    const origResolvePatterns = _verifyDeps.resolveTestFilePatterns;
    const origGetChangedTest = _smartRunnerDeps.getChangedTestFiles;
    const origGetChanged = _smartRunnerDeps.getChangedNonTestFiles;
    const origMapSource = _smartRunnerDeps.mapSourceToTests;

    _verifyDeps.resolveTestFilePatterns = mock(() => Promise.resolve(MOCK_RESOLVED_PATTERNS));
    _smartRunnerDeps.getChangedTestFiles = mock(() => Promise.resolve([]));
    _smartRunnerDeps.getChangedNonTestFiles = mock(() => Promise.resolve([]));
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
      _verifyDeps.resolveTestFilePatterns = origResolvePatterns;
      _smartRunnerDeps.getChangedTestFiles = origGetChangedTest;
      _smartRunnerDeps.getChangedNonTestFiles = origGetChanged;
      _smartRunnerDeps.mapSourceToTests = origMapSource;
    }
  });
});

// ---------------------------------------------------------------------------
// Monorepo orchestrator + {{package}} substitution
// ---------------------------------------------------------------------------

describe("verifyStage — monorepo orchestrator + {{package}}", () => {
  afterEach(() => {
    mock.restore();
  });

  function makeMonorepoContext(packageName: string | null = "@koda/cli") {
    const story = makeStory({ workdir: "apps/cli" });
    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      quality: {
        ...DEFAULT_CONFIG.quality,
        requireTests: true,
        commands: {
          test: "bunx turbo test",
          testScoped: "bunx turbo test --filter={{package}}",
        },
      },
      execution: {
        ...DEFAULT_CONFIG.execution,
        verificationTimeoutSeconds: 30,
        regressionGate: { enabled: true, mode: "deferred", timeoutSeconds: 30, acceptOnTimeout: true },
      },
    };
    return {
      config,
      rootConfig: config,
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
      _packageName: packageName,
    };
  }

  test("substitutes {{package}} from package.json name and runs scoped turbo command", async () => {
    const { verifyStage, _verifyDeps } = await import(
      "../../../../src/pipeline/stages/verify"
    );

    let capturedCommand: string | undefined;
    const origRegression = _verifyDeps.regression;
    const origResolve = _verifyDeps.resolveTestCommands;

    // Simulate SSOT returning a promoted orchestrator command (package found)
    _verifyDeps.resolveTestCommands = mock((): Promise<ResolvedTestCommands> =>
      Promise.resolve({
        rawTestCommand: "bunx turbo test",
        testCommand: "bunx turbo test --filter=@koda/cli",
        testScopedTemplate: undefined,
        isMonorepoOrchestrator: true,
        scopeFileThreshold: 10,
      }),
    );
    _verifyDeps.regression = mock((opts: { command: string }): Promise<VerificationResult> => {
      capturedCommand = opts.command;
      return Promise.resolve(SUCCESS_RESULT);
    });

    try {
      const ctx = makeMonorepoContext();
      await verifyStage.execute(ctx as unknown as Parameters<typeof verifyStage.execute>[0]);
      expect(capturedCommand).toBe("bunx turbo test --filter=@koda/cli");
    } finally {
      _verifyDeps.regression = origRegression;
      _verifyDeps.resolveTestCommands = origResolve;
    }
  });

  test("no package.json (non-JS project) — skips testScoped template, falls to deferred", async () => {
    const { verifyStage, _verifyDeps } = await import(
      "../../../../src/pipeline/stages/verify"
    );

    let capturedCommand: string | undefined;
    const origRegression = _verifyDeps.regression;
    const origResolve = _verifyDeps.resolveTestCommands;

    // Simulate SSOT returning no promotion (package.json absent → no resolved template)
    _verifyDeps.resolveTestCommands = mock((): Promise<ResolvedTestCommands> =>
      Promise.resolve({
        rawTestCommand: "bunx turbo test",
        testCommand: "bunx turbo test", // same as raw — no promotion
        testScopedTemplate: undefined,
        isMonorepoOrchestrator: true,
        scopeFileThreshold: 10,
      }),
    );
    _verifyDeps.regression = mock((opts: { command: string }): Promise<VerificationResult> => {
      capturedCommand = opts.command;
      return Promise.resolve(SUCCESS_RESULT);
    });

    try {
      const ctx = makeMonorepoContext(null);
      // mode is deferred → full suite skipped → continue without regression
      const result = await verifyStage.execute(ctx as unknown as Parameters<typeof verifyStage.execute>[0]);
      // No promotion → isFullSuite=true → deferred mode → skip
      expect(result.action).toBe("continue");
      expect(capturedCommand).toBeUndefined();
    } finally {
      _verifyDeps.regression = origRegression;
      _verifyDeps.resolveTestCommands = origResolve;
    }
  });

  test("runs full monorepo test when no story.workdir (no package context)", async () => {
    const { verifyStage, _verifyDeps } = await import(
      "../../../../src/pipeline/stages/verify"
    );

    let capturedCommand: string | undefined;
    const origRegression = _verifyDeps.regression;
    const origResolve = _verifyDeps.resolveTestCommands;

    // No workdir on story → SSOT returns no promotion
    _verifyDeps.resolveTestCommands = mock((): Promise<ResolvedTestCommands> =>
      Promise.resolve({
        rawTestCommand: "bunx turbo test",
        testCommand: "bunx turbo test", // same as raw — no promotion
        testScopedTemplate: undefined,
        isMonorepoOrchestrator: true,
        scopeFileThreshold: 10,
      }),
    );
    _verifyDeps.regression = mock((opts: { command: string }): Promise<VerificationResult> => {
      capturedCommand = opts.command;
      return Promise.resolve(SUCCESS_RESULT);
    });

    try {
      // No workdir on story — mode per-story forces full suite run
      const story = makeStory({ status: "in-progress", attempts: 1 });
      const config: NaxConfig = {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          requireTests: true,
          commands: { test: "bunx turbo test", testScoped: "bunx turbo test --filter={{package}}" },
        },
        execution: {
          ...DEFAULT_CONFIG.execution,
          verificationTimeoutSeconds: 30,
          regressionGate: { enabled: true, mode: "per-story", timeoutSeconds: 30, acceptOnTimeout: true },
        },
      };
      const ctx = {
        config,
        rootConfig: config,
        prd: makePRD(),
        story,
        stories: [story],
        routing: { complexity: "simple" as const, modelTier: "fast" as const, testStrategy: "test-after" as const, reasoning: "test" },
        workdir: WORKDIR,
        hooks: { hooks: {} },
      };
      await verifyStage.execute(ctx as unknown as Parameters<typeof verifyStage.execute>[0]);
      // No promotion → isFullSuite=true → per-story mode → runs "bunx turbo test"
      expect(capturedCommand).toBe("bunx turbo test");
    } finally {
      _verifyDeps.regression = origRegression;
      _verifyDeps.resolveTestCommands = origResolve;
    }
  });
});
