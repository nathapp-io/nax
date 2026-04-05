// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import type { VerifyContext } from "../../../../src/verification/orchestrator-types";
import {
  ScopedStrategy,
  _scopedDeps,
  isMonorepoOrchestratorCommand,
} from "../../../../src/verification/strategies/scoped";

function makeCtx(overrides: Partial<VerifyContext> = {}): VerifyContext {
  return {
    workdir: "/tmp/test-repo",
    testCommand: "bun test",
    timeoutSeconds: 60,
    storyId: "US-001",
    storyGitRef: "abc123",
    regressionMode: "deferred",
    acceptOnTimeout: true,
    ...overrides,
  };
}

function makeCtxWithThreshold(overrides: Partial<VerifyContext> = {}): VerifyContext {
  return {
    workdir: "/tmp/test-repo",
    testCommand: "bun test",
    timeoutSeconds: 60,
    storyId: "US-001",
    storyGitRef: "abc123",
    regressionMode: "deferred",
    acceptOnTimeout: true,
    config: {
      version: 1,
      models: {},
      autoMode: {
        enabled: false,
        defaultAgent: "claude",
        fallbackOrder: [],
        complexityRouting: { simple: "fast", medium: "balanced", complex: "powerful", expert: "powerful" },
        escalation: { enabled: false, tierOrder: [] },
      },
      routing: { strategy: "keyword" },
      execution: {
        maxIterations: 10,
        iterationDelayMs: 1000,
        costLimit: 10,
        sessionTimeoutSeconds: 3600,
        verificationTimeoutSeconds: 300,
        maxStoriesPerFeature: 10,
        rectification: {
          enabled: false,
          maxRetries: 0,
          fullSuiteTimeoutSeconds: 120,
          maxFailureSummaryChars: 1000,
          abortOnIncreasingFailures: false,
          escalateOnExhaustion: false,
          rethinkAtAttempt: 1,
          urgencyAtAttempt: 1,
        },
        regressionGate: { enabled: false, timeoutSeconds: 120, mode: "deferred" },
        contextProviderTokenBudget: 2000,
        smartTestRunner: true,
      },
      quality: {
        requireTypecheck: true,
        requireLint: true,
        requireTests: true,
        scopeTestThreshold: 10,
        commands: { test: "bun test" },
        forceExit: false,
        detectOpenHandles: true,
        detectOpenHandlesRetries: 1,
        gracePeriodMs: 5000,
        drainTimeoutMs: 2000,
        shell: "/bin/sh",
        stripEnvVars: [],
      },
      tdd: { maxRetries: 0, autoVerifyIsolation: false, autoApproveVerifier: false, strategy: "auto" },
      constitution: { enabled: false, path: "constitution.md", maxTokens: 1000 },
      analyze: { llmEnhanced: false, model: "balanced", fallbackToKeywords: false, maxCodebaseSummaryTokens: 500 },
      review: { enabled: false, checks: [], commands: {}, pluginMode: "per-story" },
      plan: { model: "balanced", outputPath: "spec.md", timeoutSeconds: 600 },
      acceptance: {
        enabled: false,
        maxRetries: 0,
        generateTests: false,
        testPath: ".nax-acceptance.test.ts",
        model: "fast",
        refinement: false,
        refinementConcurrency: 1,
        redGate: false,
        timeoutMs: 1800000,
        fix: { diagnoseModel: "fast", fixModel: "balanced", strategy: "diagnose-first", maxRetries: 0 },
      },
      context: {
        testCoverage: {
          enabled: false,
          detail: "names-only",
          maxTokens: 500,
          testPattern: "**/*.test.{ts,js}",
          scopeToStory: false,
        },
        autoDetect: { enabled: false, maxFiles: 5, traceImports: false },
        fileInjection: "disabled",
      },
      profile: "default",
    },
    ...overrides,
  };
}

describe("ScopedStrategy", () => {
  test("name is scoped", () => {
    expect(new ScopedStrategy().name).toBe("scoped");
  });

  test("returns SKIPPED when deferred mode and no mapped tests", async () => {
    const saved = { ..._scopedDeps };
    _scopedDeps.getChangedSourceFiles = async () => [];
    _scopedDeps.mapSourceToTests = async () => [];
    _scopedDeps.importGrepFallback = async () => [];

    const result = await new ScopedStrategy().execute(makeCtx({ regressionMode: "deferred" }));

    Object.assign(_scopedDeps, saved);

    expect(result.status).toBe("SKIPPED");
    expect(result.success).toBe(true);
    expect(result.countsTowardEscalation).toBe(false);
  });

  test("runs full suite when inline mode and no mapped tests", async () => {
    const saved = { ..._scopedDeps };
    _scopedDeps.getChangedSourceFiles = async () => [];
    _scopedDeps.mapSourceToTests = async () => [];
    _scopedDeps.importGrepFallback = async () => [];
    _scopedDeps.regression = async () => ({
      success: true,
      status: "SUCCESS" as const,
      countsTowardEscalation: false,
      output: "1 pass",
    });

    const result = await new ScopedStrategy().execute(makeCtx({ regressionMode: "inline" }));

    Object.assign(_scopedDeps, saved);

    expect(result.success).toBe(true);
    expect(result.status).toBe("PASS");
  });

  test("returns PASS when tests pass", async () => {
    const saved = { ..._scopedDeps };
    _scopedDeps.getChangedSourceFiles = async () => ["src/foo.ts"];
    _scopedDeps.mapSourceToTests = async () => ["test/unit/foo.test.ts"];
    _scopedDeps.buildSmartTestCommand = (_files: string[], cmd: string) => `${cmd} test/unit/foo.test.ts`;
    _scopedDeps.regression = async () => ({
      success: true,
      status: "SUCCESS" as const,
      countsTowardEscalation: false,
      output: "5 pass\n0 fail",
    });

    const result = await new ScopedStrategy().execute(makeCtx());

    Object.assign(_scopedDeps, saved);

    expect(result.success).toBe(true);
    expect(result.status).toBe("PASS");
    expect(result.strategy).toBe("scoped");
  });

  test("returns TEST_FAILURE when tests fail", async () => {
    const saved = { ..._scopedDeps };
    _scopedDeps.getChangedSourceFiles = async () => ["src/foo.ts"];
    _scopedDeps.mapSourceToTests = async () => ["test/unit/foo.test.ts"];
    _scopedDeps.buildSmartTestCommand = (_files: string[], cmd: string) => cmd;
    _scopedDeps.regression = async () => ({
      success: false,
      status: "TEST_FAILURE" as const,
      countsTowardEscalation: true,
      output: "(fail) foo > bar\n1 fail",
    });

    const result = await new ScopedStrategy().execute(makeCtx());

    Object.assign(_scopedDeps, saved);

    expect(result.success).toBe(false);
    expect(result.status).toBe("TEST_FAILURE");
    expect(result.countsTowardEscalation).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isMonorepoOrchestratorCommand
// ---------------------------------------------------------------------------

describe("isMonorepoOrchestratorCommand", () => {
  test("turbo run test --filter=...[HEAD~1] is a monorepo orchestrator command", () => {
    expect(isMonorepoOrchestratorCommand("turbo run test --filter=...[HEAD~1]")).toBe(true);
  });

  test("nx affected --target=test is a monorepo orchestrator command", () => {
    expect(isMonorepoOrchestratorCommand("nx affected --target=test")).toBe(true);
  });

  test("bun test is not a monorepo orchestrator command", () => {
    expect(isMonorepoOrchestratorCommand("bun test")).toBe(false);
  });

  test("npm test is not a monorepo orchestrator command", () => {
    expect(isMonorepoOrchestratorCommand("npm test")).toBe(false);
  });

  test("pnpm run --recursive test is not a monorepo orchestrator command", () => {
    expect(isMonorepoOrchestratorCommand("pnpm run --recursive test")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ScopedStrategy — monorepo orchestrator bypass
// ---------------------------------------------------------------------------

describe("ScopedStrategy — monorepo orchestrator bypass", () => {
  test("turbo command: skips smart runner and runs command as-is (not deferred)", async () => {
    const capturedCommands: string[] = [];
    const saved = { ..._scopedDeps };

    _scopedDeps.getChangedSourceFiles = async () => ["src/foo.ts"];
    _scopedDeps.mapSourceToTests = async () => [];
    _scopedDeps.regression = async ({
      command,
    }: { command: string; workdir: string; timeoutSeconds: number; acceptOnTimeout?: boolean }) => {
      capturedCommands.push(command);
      return { success: true, status: "PASS" as const, countsTowardEscalation: false, output: "1 pass" };
    };

    const turboCtx = makeCtx({
      testCommand: "turbo run test --filter=...[HEAD~1]",
      regressionMode: "deferred",
    });
    const result = await new ScopedStrategy().execute(turboCtx);

    Object.assign(_scopedDeps, saved);

    expect(result.status).not.toBe("SKIPPED");
    expect(result.success).toBe(true);
    expect(capturedCommands[0]).toBe("turbo run test --filter=...[HEAD~1]");
  });

  test("nx command: runs as-is without smart runner interference", async () => {
    const capturedCommands: string[] = [];
    const saved = { ..._scopedDeps };

    _scopedDeps.getChangedSourceFiles = async () => ["src/foo.ts"];
    _scopedDeps.mapSourceToTests = async () => [];
    _scopedDeps.regression = async ({
      command,
    }: { command: string; workdir: string; timeoutSeconds: number; acceptOnTimeout?: boolean }) => {
      capturedCommands.push(command);
      return { success: true, status: "PASS" as const, countsTowardEscalation: false, output: "1 pass" };
    };

    const nxCtx = makeCtx({
      testCommand: "nx affected --target=test",
      regressionMode: "deferred",
    });
    await new ScopedStrategy().execute(nxCtx);

    Object.assign(_scopedDeps, saved);

    expect(capturedCommands[0]).toBe("nx affected --target=test");
  });

  test("non-orchestrator command still defers in deferred mode when no tests mapped", async () => {
    const saved = { ..._scopedDeps };

    _scopedDeps.getChangedSourceFiles = async () => [];
    _scopedDeps.mapSourceToTests = async () => [];

    const ctx = makeCtx({ testCommand: "bun test", regressionMode: "deferred" });
    const result = await new ScopedStrategy().execute(ctx);

    Object.assign(_scopedDeps, saved);

    expect(result.status).toBe("SKIPPED");
  });
});

// ---------------------------------------------------------------------------
// ScopedStrategy — scopeTestThreshold fallback
// ---------------------------------------------------------------------------

describe("ScopedStrategy — scopeTestThreshold fallback (US-001)", () => {
  function makeCtxWithThreshold(overrides: Partial<VerifyContext> = {}): VerifyContext {
    return {
      workdir: "/tmp/test-repo",
      testCommand: "bun test",
      timeoutSeconds: 60,
      storyId: "US-001",
      storyGitRef: "abc123",
      regressionMode: "deferred",
      acceptOnTimeout: true,
      config: {
        version: 1,
        models: {},
        autoMode: {
          enabled: false,
          defaultAgent: "claude",
          fallbackOrder: [],
          complexityRouting: { simple: "fast", medium: "balanced", complex: "powerful", expert: "powerful" },
          escalation: { enabled: false, tierOrder: [] },
        },
        routing: { strategy: "keyword" },
        execution: {
          maxIterations: 10,
          iterationDelayMs: 1000,
          costLimit: 10,
          sessionTimeoutSeconds: 3600,
          verificationTimeoutSeconds: 300,
          maxStoriesPerFeature: 10,
          rectification: {
            enabled: false,
            maxRetries: 0,
            fullSuiteTimeoutSeconds: 120,
            maxFailureSummaryChars: 1000,
            abortOnIncreasingFailures: false,
            escalateOnExhaustion: false,
            rethinkAtAttempt: 1,
            urgencyAtAttempt: 1,
          },
          regressionGate: { enabled: false, timeoutSeconds: 120, mode: "deferred" },
          contextProviderTokenBudget: 2000,
          smartTestRunner: true,
        },
        quality: {
          requireTypecheck: true,
          requireLint: true,
          requireTests: true,
          scopeTestThreshold: 10,
          commands: { test: "bun test" },
          forceExit: false,
          detectOpenHandles: true,
          detectOpenHandlesRetries: 1,
          gracePeriodMs: 5000,
          drainTimeoutMs: 2000,
          shell: "/bin/sh",
          stripEnvVars: [],
        },
        tdd: { maxRetries: 0, autoVerifyIsolation: false, autoApproveVerifier: false, strategy: "auto" },
        constitution: { enabled: false, path: "constitution.md", maxTokens: 1000 },
        analyze: { llmEnhanced: false, model: "balanced", fallbackToKeywords: false, maxCodebaseSummaryTokens: 500 },
        review: { enabled: false, checks: [], commands: {}, pluginMode: "per-story" },
        plan: { model: "balanced", outputPath: "spec.md", timeoutSeconds: 600 },
        acceptance: {
          enabled: false,
          maxRetries: 0,
          generateTests: false,
          testPath: ".nax-acceptance.test.ts",
          model: "fast",
          refinement: false,
          refinementConcurrency: 1,
          redGate: false,
          timeoutMs: 1800000,
          fix: { diagnoseModel: "fast", fixModel: "balanced", strategy: "diagnose-first", maxRetries: 0 },
        },
        context: {
          testCoverage: {
            enabled: false,
            detail: "names-only",
            maxTokens: 500,
            testPattern: "**/*.test.{ts,js}",
            scopeToStory: false,
          },
          autoDetect: { enabled: false, maxFiles: 5, traceImports: false },
          fileInjection: "disabled",
        },
        profile: "default",
      },
      ...overrides,
    };
  }

  test("with 3 source files and threshold 10, proceeds to scoped test mapping (no fallback)", async () => {
    const saved = { ..._scopedDeps };
    const capturedCommands: string[] = [];

    _scopedDeps.getChangedSourceFiles = async () => ["src/foo.ts", "src/bar.ts", "src/baz.ts"];
    _scopedDeps.mapSourceToTests = async () => [
      "test/unit/foo.test.ts",
      "test/unit/bar.test.ts",
      "test/unit/baz.test.ts",
    ];
    _scopedDeps.buildSmartTestCommand = (_files: string[], cmd: string) => {
      capturedCommands.push(`scoped:${_files.join(",")}`);
      return `${cmd} ${_files.join(" ")}`;
    };
    _scopedDeps.regression = async ({
      command,
    }: { command: string; workdir: string; timeoutSeconds: number; acceptOnTimeout?: boolean }) => {
      capturedCommands.push(`regression:${command}`);
      return { success: true, status: "SUCCESS" as const, countsTowardEscalation: false, output: "3 pass" };
    };

    const ctx = makeCtxWithThreshold({ regressionMode: "inline" });
    const result = await new ScopedStrategy().execute(ctx);

    Object.assign(_scopedDeps, saved);

    expect(result.success).toBe(true);
    expect(result.status).toBe("PASS");
    expect(capturedCommands.some((c) => c.startsWith("scoped:"))).toBe(true);
    expect(
      capturedCommands.some((c) => c.includes("foo.test.ts") && c.includes("bar.test.ts") && c.includes("baz.test.ts")),
    ).toBe(true);
  });

  test("with 12 source files and threshold 10, executes quality.commands.test instead of scoped command", async () => {
    const saved = { ..._scopedDeps };
    const capturedCommands: string[] = [];

    const manyFiles = Array.from({ length: 12 }, (_, i) => `src/file${i}.ts`);
    const manyTests = Array.from({ length: 12 }, (_, i) => `test/unit/file${i}.test.ts`);

    _scopedDeps.getChangedSourceFiles = async () => manyFiles;
    _scopedDeps.mapSourceToTests = async () => manyTests;
    _scopedDeps.buildSmartTestCommand = (_files: string[], cmd: string) => {
      capturedCommands.push(`scoped:${_files.length} files`);
      return `${cmd} ${_files.join(" ")}`;
    };
    _scopedDeps.regression = async ({
      command,
    }: { command: string; workdir: string; timeoutSeconds: number; acceptOnTimeout?: boolean }) => {
      capturedCommands.push(`regression:${command}`);
      return { success: true, status: "SUCCESS" as const, countsTowardEscalation: false, output: "100 pass" };
    };

    const ctx = makeCtxWithThreshold({ regressionMode: "inline" });
    const result = await new ScopedStrategy().execute(ctx);

    Object.assign(_scopedDeps, saved);

    expect(result.success).toBe(true);
    expect(result.status).toBe("PASS");
    expect(capturedCommands.some((c) => c === "regression:bun test")).toBe(true);
    expect(capturedCommands.some((c) => c.startsWith("scoped:"))).toBe(false);
  });

  test("when fallback triggers, the test command used is quality.commands.test (not scoped file list)", async () => {
    const saved = { ..._scopedDeps };
    let regressionCommand = "";

    const manyFiles = Array.from({ length: 12 }, (_, i) => `src/file${i}.ts`);

    _scopedDeps.getChangedSourceFiles = async () => manyFiles;
    _scopedDeps.mapSourceToTests = async () => manyFiles;
    _scopedDeps.regression = async ({
      command,
    }: { command: string; workdir: string; timeoutSeconds: number; acceptOnTimeout?: boolean }) => {
      regressionCommand = command;
      return { success: true, status: "SUCCESS" as const, countsTowardEscalation: false, output: "1 pass" };
    };

    const ctx = makeCtxWithThreshold({ regressionMode: "inline" });
    await new ScopedStrategy().execute(ctx);

    Object.assign(_scopedDeps, saved);

    expect(regressionCommand).toBe("bun test");
    expect(regressionCommand).not.toContain("src/file0.ts");
    expect(regressionCommand).not.toContain("src/file");
  });
});

// ---------------------------------------------------------------------------
// ScopedStrategy — scopeTestFallback flag (US-002)
// ---------------------------------------------------------------------------

describe("ScopedStrategy — scopeTestFallback flag (US-002)", () => {
  test("when fallback triggers due to threshold, verify result includes scopeTestFallback: true", async () => {
    const saved = { ..._scopedDeps };

    const manyFiles = Array.from({ length: 12 }, (_, i) => `src/file${i}.ts`);

    _scopedDeps.getChangedSourceFiles = async () => manyFiles;
    _scopedDeps.mapSourceToTests = async () => manyFiles;
    _scopedDeps.regression = async () => ({
      success: true,
      status: "SUCCESS" as const,
      countsTowardEscalation: false,
      output: "100 pass",
    });

    const ctx = makeCtxWithThreshold({ regressionMode: "inline" });
    const result = await new ScopedStrategy().execute(ctx);

    Object.assign(_scopedDeps, saved);

    expect(result.scopeTestFallback).toBe(true);
  });

  test("when scoped strategy runs normally (no fallback), scopeTestFallback is absent", async () => {
    const saved = { ..._scopedDeps };

    _scopedDeps.getChangedSourceFiles = async () => ["src/foo.ts", "src/bar.ts", "src/baz.ts"];
    _scopedDeps.mapSourceToTests = async () => [
      "test/unit/foo.test.ts",
      "test/unit/bar.test.ts",
      "test/unit/baz.test.ts",
    ];
    _scopedDeps.buildSmartTestCommand = (_files: string[], cmd: string) => `${cmd} ${_files.join(" ")}`;
    _scopedDeps.regression = async () => ({
      success: true,
      status: "SUCCESS" as const,
      countsTowardEscalation: false,
      output: "3 pass",
    });

    const ctx = makeCtxWithThreshold({ regressionMode: "inline" });
    const result = await new ScopedStrategy().execute(ctx);

    Object.assign(_scopedDeps, saved);

    expect(result.scopeTestFallback).toBeUndefined();
  });
});
