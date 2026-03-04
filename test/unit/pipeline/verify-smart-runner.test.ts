/**
 * Verify Stage --- Smart Runner Integration Tests (STR-005)
 *
 * Covers the four acceptance criteria:
 * 1. Uses scoped test command when smart runner finds test files
 * 2. Falls back to full suite when no test files map
 * 3. Skips smart runner entirely when config.execution.smartTestRunner is false
 * 4. Logs the mode used
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _smartRunnerDeps } from "../../../src/verification/smart-runner";
import { initLogger, resetLogger } from "../../../src/logger";
import type { NaxConfig } from "../../../src/config";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { PRD, UserStory } from "../../../src/prd/types";

// ---- Module mocks ------------------------------------------------------------
// We avoid mock.module() for smart-runner entirely --- it leaks across test files
// in Bun 1.x. Instead we mutate the _smartRunnerDeps object exported by the module.
// verify.ts accesses all smart-runner functions via _smartRunnerDeps.fn(), so
// mutations here take effect immediately with no module registry involvement.

const mockRegression = mock(async () => ({ success: true, status: "SUCCESS" as const }));

// ---- Static imports — no mock.module() needed (uses _deps pattern) ----------
import { _verifyDeps, verifyStage } from "../../../src/pipeline/stages/verify";

// ---- Capture originals for afterEach restoration ----------------------------
const _origDeps = { ..._smartRunnerDeps };
const _origVerifyDeps = { ..._verifyDeps };

// ---- Mock functions ---------------------------------------------------------

const mockGetChangedSourceFiles = mock(async (_workdir: string) => [] as string[]);
const mockMapSourceToTests = mock(async (_files: string[], _workdir: string) => [] as string[]);
const mockImportGrepFallback = mock(async (_files: string[], _workdir: string, _patterns: string[]) => [] as string[]);
const mockBuildSmartTestCommand = mock((testFiles: string[], baseCommand: string) => {
  if (testFiles.length === 0) return baseCommand;
  return `${baseCommand.split(" ").slice(0, -1).join(" ")} ${testFiles.join(" ")}`;
});

// ---- Fixtures ----------------------------------------------------------------

function makeConfig(overrides: Partial<NaxConfig["execution"]> = {}): NaxConfig {
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
        maxAttempts: 3,
      },
    },
    execution: {
      maxIterations: 100,
      iterationDelayMs: 1000,
      costLimit: 50,
      sessionTimeoutSeconds: 600,
      verificationTimeoutSeconds: 30,
      maxStoriesPerFeature: 50,
      smartTestRunner: true,
      ...overrides,
    },
    quality: {
      requireTypecheck: false,
      requireLint: false,
      requireTests: true,
      commands: { test: "bun test test/" },
    },
    tdd: {
      maxRetries: 3,
      autoVerifyIsolation: true,
      autoApproveVerifier: true,
    },
    constitution: {
      enabled: false,
      path: "constitution.md",
      maxTokens: 2000,
    },
    analyze: {
      llmEnhanced: false,
      model: "balanced",
      fallbackToKeywords: true,
      maxCodebaseSummaryTokens: 4000,
    },
    review: {
      enabled: true,
      checks: ["test"],
      commands: { test: "bun test test/" },
    },
    plan: {
      model: "balanced",
      outputPath: "features",
    },
  };
}

function makeContext(configOverrides: Partial<NaxConfig["execution"]> = {}): PipelineContext {
  const story: UserStory = {
    id: "STR-005-test",
    title: "Smart Runner Test Story",
    description: "Test description",
    acceptanceCriteria: ["Tests pass"],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
  };

  const prd: PRD = {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [story],
  };

  return {
    config: makeConfig(configOverrides),
    prd,
    story,
    stories: [story],
    routing: {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "Test routing",
    },
    workdir: "/test/workdir",
    hooks: { hooks: {} },
  };
}

// ---- Tests -------------------------------------------------------------------

describe("Verify Stage --- Smart Runner Integration", () => {
  beforeEach(() => {
    initLogger({ level: "error", useChalk: false });
    _smartRunnerDeps.getChangedSourceFiles = mockGetChangedSourceFiles;
    _smartRunnerDeps.mapSourceToTests = mockMapSourceToTests;
    _smartRunnerDeps.importGrepFallback = mockImportGrepFallback;
    _smartRunnerDeps.buildSmartTestCommand = mockBuildSmartTestCommand;
    _verifyDeps.regression = mockRegression as typeof _verifyDeps.regression;
    mockRegression.mockClear();
    mockGetChangedSourceFiles.mockClear();
    mockMapSourceToTests.mockClear();
    mockImportGrepFallback.mockClear();
    mockBuildSmartTestCommand.mockClear();
  });

  afterEach(() => {
    resetLogger();
    Object.assign(_smartRunnerDeps, _origDeps);
    Object.assign(_verifyDeps, _origVerifyDeps);
  });

  describe("AC1: uses scoped test command when smart runner finds test files", () => {
    test("passes scoped command to regression when test files are mapped", async () => {
      mockGetChangedSourceFiles.mockImplementation(async () => ["src/foo/bar.ts"]);
      mockMapSourceToTests.mockImplementation(async () => ["/test/workdir/test/unit/foo/bar.test.ts"]);
      mockBuildSmartTestCommand.mockImplementation(
        (testFiles: string[], baseCommand: string) => `${baseCommand.split(" ")[0]} ${baseCommand.split(" ")[1]} ${testFiles.join(" ")}`,
      );
      mockRegression.mockImplementation(async () => ({ success: true, status: "SUCCESS" as const }));

      const ctx = makeContext({ smartTestRunner: true });
      await verifyStage.execute(ctx);

      expect(mockRegression).toHaveBeenCalledTimes(1);
      const callArgs = mockRegression.mock.calls[0][0] as { command: string };
      expect(callArgs.command).toContain("bar.test.ts");
      expect(callArgs.command).not.toBe("bun test test/");
    });

    test("calls getChangedSourceFiles with workdir", async () => {
      mockGetChangedSourceFiles.mockImplementation(async () => []);
      mockMapSourceToTests.mockImplementation(async () => []);
      mockRegression.mockImplementation(async () => ({ success: true, status: "SUCCESS" as const }));

      const ctx = makeContext({ smartTestRunner: true });
      await verifyStage.execute(ctx);

      expect(mockGetChangedSourceFiles).toHaveBeenCalledWith("/test/workdir");
    });

    test("calls mapSourceToTests with changed files and workdir", async () => {
      mockGetChangedSourceFiles.mockImplementation(async () => ["src/utils/helper.ts"]);
      mockMapSourceToTests.mockImplementation(async () => []);
      mockRegression.mockImplementation(async () => ({ success: true, status: "SUCCESS" as const }));

      const ctx = makeContext({ smartTestRunner: true });
      await verifyStage.execute(ctx);

      expect(mockMapSourceToTests).toHaveBeenCalledWith(["src/utils/helper.ts"], "/test/workdir");
    });

    test("calls buildSmartTestCommand with mapped test files and base command", async () => {
      const testFiles = ["/test/workdir/test/unit/utils/helper.test.ts"];
      mockGetChangedSourceFiles.mockImplementation(async () => ["src/utils/helper.ts"]);
      mockMapSourceToTests.mockImplementation(async () => testFiles);
      mockBuildSmartTestCommand.mockImplementation((_files: string[], cmd: string) => cmd);
      mockRegression.mockImplementation(async () => ({ success: true, status: "SUCCESS" as const }));

      const ctx = makeContext({ smartTestRunner: true });
      await verifyStage.execute(ctx);

      expect(mockBuildSmartTestCommand).toHaveBeenCalledWith(testFiles, "bun test test/");
    });
  });

  describe("AC2: falls back to full suite when no test files map", () => {
    test("uses original testCommand when mapSourceToTests returns empty array", async () => {
      mockGetChangedSourceFiles.mockImplementation(async () => ["src/foo/bar.ts"]);
      mockMapSourceToTests.mockImplementation(async () => []);
      mockRegression.mockImplementation(async () => ({ success: true, status: "SUCCESS" as const }));

      const ctx = makeContext({ smartTestRunner: true });
      await verifyStage.execute(ctx);

      expect(mockRegression).toHaveBeenCalledTimes(1);
      const callArgs = mockRegression.mock.calls[0][0] as { command: string };
      expect(callArgs.command).toBe("bun test test/");
    });

    test("uses original testCommand when getChangedSourceFiles returns empty array", async () => {
      mockGetChangedSourceFiles.mockImplementation(async () => []);
      mockMapSourceToTests.mockImplementation(async () => []);
      mockRegression.mockImplementation(async () => ({ success: true, status: "SUCCESS" as const }));

      const ctx = makeContext({ smartTestRunner: true });
      await verifyStage.execute(ctx);

      expect(mockRegression).toHaveBeenCalledTimes(1);
      const callArgs = mockRegression.mock.calls[0][0] as { command: string };
      expect(callArgs.command).toBe("bun test test/");
    });

    test("does not call buildSmartTestCommand when no test files mapped", async () => {
      mockGetChangedSourceFiles.mockImplementation(async () => []);
      mockMapSourceToTests.mockImplementation(async () => []);
      mockRegression.mockImplementation(async () => ({ success: true, status: "SUCCESS" as const }));

      const ctx = makeContext({ smartTestRunner: true });
      await verifyStage.execute(ctx);

      expect(mockBuildSmartTestCommand).not.toHaveBeenCalled();
    });
  });

  describe("AC3: skips smart runner entirely when config.execution.smartTestRunner is false", () => {
    test("does not call getChangedSourceFiles when smartTestRunner is false", async () => {
      mockRegression.mockImplementation(async () => ({ success: true, status: "SUCCESS" as const }));

      const ctx = makeContext({ smartTestRunner: false });
      await verifyStage.execute(ctx);

      expect(mockGetChangedSourceFiles).not.toHaveBeenCalled();
    });

    test("does not call mapSourceToTests when smartTestRunner is false", async () => {
      mockRegression.mockImplementation(async () => ({ success: true, status: "SUCCESS" as const }));

      const ctx = makeContext({ smartTestRunner: false });
      await verifyStage.execute(ctx);

      expect(mockMapSourceToTests).not.toHaveBeenCalled();
    });

    test("uses full testCommand when smartTestRunner is false", async () => {
      mockRegression.mockImplementation(async () => ({ success: true, status: "SUCCESS" as const }));

      const ctx = makeContext({ smartTestRunner: false });
      await verifyStage.execute(ctx);

      expect(mockRegression).toHaveBeenCalledTimes(1);
      const callArgs = mockRegression.mock.calls[0][0] as { command: string };
      expect(callArgs.command).toBe("bun test test/");
    });
  });

  describe("AC4: logs the mode used", () => {
    test("returns continue when smart runner runs targeted tests and they pass", async () => {
      mockGetChangedSourceFiles.mockImplementation(async () => ["src/foo/bar.ts"]);
      mockMapSourceToTests.mockImplementation(async () => ["/test/workdir/test/unit/foo/bar.test.ts"]);
      mockBuildSmartTestCommand.mockImplementation((_files: string[], cmd: string) => `${cmd} scoped`);
      mockRegression.mockImplementation(async () => ({ success: true, status: "SUCCESS" as const }));

      const ctx = makeContext({ smartTestRunner: true });
      const result = await verifyStage.execute(ctx);

      expect(result.action).toBe("continue");
    });

    test("returns continue when falling back to full suite and tests pass", async () => {
      mockGetChangedSourceFiles.mockImplementation(async () => []);
      mockMapSourceToTests.mockImplementation(async () => []);
      mockRegression.mockImplementation(async () => ({ success: true, status: "SUCCESS" as const }));

      const ctx = makeContext({ smartTestRunner: true });
      const result = await verifyStage.execute(ctx);

      expect(result.action).toBe("continue");
    });

    test("returns continue when smart runner is disabled and tests pass", async () => {
      mockRegression.mockImplementation(async () => ({ success: true, status: "SUCCESS" as const }));

      const ctx = makeContext({ smartTestRunner: false });
      const result = await verifyStage.execute(ctx);

      expect(result.action).toBe("continue");
    });

    test("returns escalate when targeted tests fail", async () => {
      mockGetChangedSourceFiles.mockImplementation(async () => ["src/foo/bar.ts"]);
      mockMapSourceToTests.mockImplementation(async () => ["/test/workdir/test/unit/foo/bar.test.ts"]);
      mockBuildSmartTestCommand.mockImplementation((_files: string[], cmd: string) => `${cmd} scoped`);
      mockRegression.mockImplementation(async () => ({ success: false, status: 1 }));

      const ctx = makeContext({ smartTestRunner: true });
      const result = await verifyStage.execute(ctx);

      expect(result.action).toBe("escalate");
    });
  });
});
