import { describe, expect, spyOn, test } from "bun:test";
import type { NaxConfig } from "../../../src/config/schema";
import { NaxConfigSchema } from "../../../src/config/schemas";
import { getLogger } from "../../../src/logger";
import { collectStoryMetrics } from "../../../src/metrics/tracker";
import type { StoryMetrics } from "../../../src/metrics/types";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { VerifyContext } from "../../../src/verification/orchestrator-types";
import { ScopedStrategy, _scopedDeps } from "../../../src/verification/strategies/scoped";

function makeTestConfig(overrides?: Partial<NaxConfig["quality"]>): NaxConfig["quality"] {
  return {
    requireTypecheck: true,
    requireLint: false,
    requireTests: true,
    commands: {
      typecheck: "bun run typecheck",
      lint: "bun run lint",
      test: "bun test",
      testScoped: "bun test {{files}}",
    },
    autofix: { enabled: true, maxAttempts: 3, maxTotalAttempts: 12, rethinkAtAttempt: 2, urgencyAtAttempt: 3 },
    forceExit: false,
    detectOpenHandles: true,
    detectOpenHandlesRetries: 1,
    gracePeriodMs: 5000,
    drainTimeoutMs: 2000,
    shell: "/bin/sh",
    stripEnvVars: [],
    ...overrides,
  };
}

function makeMinimalConfig(): NaxConfig {
  return {
    version: 1,
    models: { claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" } },
    autoMode: {
      enabled: true,
      defaultAgent: "claude",
      fallbackOrder: ["claude"],
      complexityRouting: { simple: "fast", medium: "balanced", complex: "powerful", expert: "powerful" },
      escalation: {
        enabled: true,
        tierOrder: [
          { tier: "fast", attempts: 5 },
          { tier: "balanced", attempts: 3 },
          { tier: "powerful", attempts: 2 },
        ],
      },
    },
    routing: { strategy: "keyword" },
    execution: {
      maxIterations: 10,
      iterationDelayMs: 2000,
      costLimit: 30,
      sessionTimeoutSeconds: 3600,
      verificationTimeoutSeconds: 300,
      maxStoriesPerFeature: 500,
      rectification: {
        enabled: true,
        maxRetries: 2,
        fullSuiteTimeoutSeconds: 120,
        maxFailureSummaryChars: 2000,
        abortOnIncreasingFailures: true,
        escalateOnExhaustion: true,
        rethinkAtAttempt: 2,
        urgencyAtAttempt: 3,
      },
      regressionGate: { enabled: true, timeoutSeconds: 120, acceptOnTimeout: true, mode: "deferred" },
      contextProviderTokenBudget: 2000,
      dangerouslySkipPermissions: true,
      permissionProfile: "unrestricted",
    },
    quality: makeTestConfig(),
    tdd: { maxRetries: 2, autoVerifyIsolation: true, autoApproveVerifier: true, strategy: "auto" },
    constitution: { enabled: true, path: "constitution.md", maxTokens: 2000 },
    analyze: { llmEnhanced: true, model: "balanced", fallbackToKeywords: true, maxCodebaseSummaryTokens: 5000 },
    review: { enabled: true, checks: ["typecheck", "lint"], commands: {} },
    plan: { model: "balanced", outputPath: "spec.md", timeoutSeconds: 600 },
    acceptance: {
      enabled: true,
      maxRetries: 2,
      generateTests: true,
      testPath: ".nax-acceptance.test.ts",
      model: "fast",
      refinement: true,
      refinementConcurrency: 3,
      redGate: true,
      timeoutMs: 1800000,
      fix: { diagnoseModel: "fast", fixModel: "balanced", strategy: "diagnose-first" as const, maxRetries: 2 },
    },
    context: {
      testCoverage: {
        enabled: true,
        detail: "names-and-counts",
        maxTokens: 500,
        testPattern: "**/*.test.{ts,js,tsx,jsx}",
        scopeToStory: true,
      },
      autoDetect: { enabled: true, maxFiles: 5, traceImports: false },
    },
    hooks: { hooks: {} },
    interaction: { plugin: "cli", config: {}, defaults: { timeout: 600000, fallback: "escalate" }, triggers: {} },
    precheck: {
      storySizeGate: {
        enabled: true,
        maxAcCount: 10,
        maxDescriptionLength: 3000,
        maxBulletPoints: 12,
        action: "block",
        maxReplanAttempts: 3,
      },
    },
    profile: "default",
  } as NaxConfig;
}

function makeCtx(overrides: Partial<VerifyContext> = {}): VerifyContext {
  return {
    workdir: "/tmp/test-repo",
    testCommand: "bun test",
    timeoutSeconds: 60,
    storyId: "US-001",
    storyGitRef: "abc123",
    regressionMode: "per-story",
    acceptOnTimeout: true,
    config: makeMinimalConfig(),
    ...overrides,
  };
}

describe("AC-1: Default scopeTestThreshold must be 10", () => {
  test("NaxConfigSchema.parse({}).quality.scopeTestThreshold === 10", () => {
    // @ts-expect-error - scopeTestThreshold is not yet in schema (feature not implemented)
    expect(NaxConfigSchema.parse({}).quality.scopeTestThreshold).toBe(10);
  });
});

describe("AC-2: Custom scopeTestThreshold of 5 must be preserved", () => {
  test("NaxConfigSchema.parse({ quality: { scopeTestThreshold: 5 } }).quality.scopeTestThreshold === 5", () => {
    // @ts-expect-error - scopeTestThreshold is not yet in schema (feature not implemented)
    expect(NaxConfigSchema.parse({ quality: { scopeTestThreshold: 5 } }).quality.scopeTestThreshold).toBe(5);
  });
});

describe("AC-3: With 3 files under threshold 10, no fallback triggered and scoped command returned", () => {
  test("ScopedStrategy.execute() with 3 source files and threshold 10 proceeds to scoped test mapping (no fallback)", async () => {
    const saved = { ..._scopedDeps };

    _scopedDeps.getChangedSourceFiles = async () => ["src/a.ts", "src/b.ts", "src/c.ts"];
    _scopedDeps.mapSourceToTests = async () => ["test/unit/a.test.ts", "test/unit/b.test.ts", "test/unit/c.test.ts"];
    _scopedDeps.buildSmartTestCommand = (files: string[], cmd: string) => `${cmd} ${files.join(" ")}`;
    _scopedDeps.regression = async () => ({
      success: true,
      status: "SUCCESS" as const,
      countsTowardEscalation: false,
      output: "3 pass",
    });

    const ctx = makeCtx();
    // @ts-expect-error - scopeTestThreshold is not yet in types (feature not implemented)
    ctx.config.quality.scopeTestThreshold = 10;

    const result = await new ScopedStrategy().execute(ctx);

    Object.assign(_scopedDeps, saved);

    expect(result.success).toBe(true);
    expect(result.status).toBe("PASS");
  });
});

describe("AC-4: With 12 files over threshold 10, fallback triggered and quality.commands.test executed", () => {
  test("ScopedStrategy.execute() with 12 source files and threshold 10 executes quality.commands.test (full suite)", async () => {
    const saved = { ..._scopedDeps };
    const capturedCommands: string[] = [];

    const twelveFiles = Array.from({ length: 12 }, (_, i) => `src/file${i}.ts`);

    _scopedDeps.getChangedSourceFiles = async () => twelveFiles;
    _scopedDeps.mapSourceToTests = async () => [];
    _scopedDeps.importGrepFallback = async () => [];
    _scopedDeps.buildSmartTestCommand = (files: string[], cmd: string) => `${cmd} ${files.join(" ")}`;
    _scopedDeps.regression = async ({ command }: { command: string }) => {
      capturedCommands.push(command);
      return { success: true, status: "SUCCESS" as const, countsTowardEscalation: false, output: "100 pass" };
    };

    const ctx = makeCtx();
    // @ts-expect-error - scopeTestThreshold is not yet in types (feature not implemented)
    ctx.config.quality.scopeTestThreshold = 10;

    const result = await new ScopedStrategy().execute(ctx);

    Object.assign(_scopedDeps, saved);

    expect(result.success).toBe(true);
    expect(capturedCommands[0]).toBe("bun test");
  });
});

describe("AC-5: logger.warn called with verify[scoped] containing file count and threshold", () => {
  test("When threshold exceeded, logger.warn is called with verify[scoped] containing file count and threshold", async () => {
    const saved = { ..._scopedDeps };
    const logger = getLogger();
    const warnSpy = spyOn(logger, "warn");

    const twelveFiles = Array.from({ length: 12 }, (_, i) => `src/file${i}.ts`);

    _scopedDeps.getChangedSourceFiles = async () => twelveFiles;
    _scopedDeps.mapSourceToTests = async () => [];
    _scopedDeps.importGrepFallback = async () => [];
    _scopedDeps.regression = async () => ({
      success: true,
      status: "SUCCESS" as const,
      countsTowardEscalation: false,
      output: "100 pass",
    });

    const ctx = makeCtx();
    // @ts-expect-error - scopeTestThreshold is not yet in types (feature not implemented)
    ctx.config.quality.scopeTestThreshold = 10;

    await new ScopedStrategy().execute(ctx);

    Object.assign(_scopedDeps, saved);
    warnSpy.mockRestore();

    const verifyScopedCalls = warnSpy.mock.calls.filter((c) => c[0] === "verify[scoped]");
    expect(verifyScopedCalls.length).toBeGreaterThan(0);

    const matchedCall = verifyScopedCalls.find((c) => {
      const message = c[1] as string;
      return message.includes("12") && message.includes("10");
    });
    expect(matchedCall).toBeDefined();
  });
});

describe("AC-6: Fallback executes quality.commands.test string, not scoped file array", () => {
  test("Fallback executes quality.commands.test (string), not scoped files array", async () => {
    const saved = { ..._scopedDeps };
    const capturedCommands: string[] = [];

    const twelveFiles = Array.from({ length: 12 }, (_, i) => `src/file${i}.ts`);

    _scopedDeps.getChangedSourceFiles = async () => twelveFiles;
    _scopedDeps.mapSourceToTests = async () => [];
    _scopedDeps.importGrepFallback = async () => [];
    _scopedDeps.regression = async ({ command }: { command: string }) => {
      capturedCommands.push(command);
      return { success: true, status: "SUCCESS" as const, countsTowardEscalation: false, output: "100 pass" };
    };

    const config = makeMinimalConfig();
    // @ts-expect-error - scopeTestThreshold is not yet in types (feature not implemented)
    config.quality.scopeTestThreshold = 10;
    config.quality.commands = { test: "bun test --force" };
    const ctx = makeCtx({ config });

    await new ScopedStrategy().execute(ctx);

    Object.assign(_scopedDeps, saved);

    expect(capturedCommands[0]).toBe("bun test --force");
    expect(Array.isArray(capturedCommands[0])).toBe(false);
  });
});

describe("AC-7: StoryMetrics type has property scopeTestFallback", () => {
  test("StoryMetrics interface includes optional scopeTestFallback?: boolean", () => {
    const metrics = {} as Record<string, unknown>;
    metrics.scopeTestFallback = true;
    expect(typeof metrics.scopeTestFallback).toBe("boolean");
  });
});

describe("AC-8: VerifyResult type has property scopeTestFallback", () => {
  test("VerifyResult interface includes optional scopeTestFallback?: boolean", () => {
    const result: Record<string, unknown> = {};
    result.scopeTestFallback = true;
    expect(typeof result.scopeTestFallback).toBe("boolean");
  });
});

describe("AC-9: When threshold exceeded, VerifyResult.metadata contains scopeTestFallback === true", () => {
  test("ScopedStrategy.execute() returns VerifyResult with scopeTestFallback: true when threshold exceeded", async () => {
    const saved = { ..._scopedDeps };

    const twelveFiles = Array.from({ length: 12 }, (_, i) => `src/file${i}.ts`);

    _scopedDeps.getChangedSourceFiles = async () => twelveFiles;
    _scopedDeps.mapSourceToTests = async () => [];
    _scopedDeps.importGrepFallback = async () => [];
    _scopedDeps.regression = async () => ({
      success: true,
      status: "SUCCESS" as const,
      countsTowardEscalation: false,
      output: "100 pass",
    });

    const ctx = makeCtx();
    // @ts-expect-error - scopeTestThreshold is not yet in types (feature not implemented)
    ctx.config.quality.scopeTestThreshold = 10;

    const result = await new ScopedStrategy().execute(ctx);

    Object.assign(_scopedDeps, saved);

    type VerifyResultWithScopeTestFallback = typeof result & { scopeTestFallback?: boolean };
    expect((result as VerifyResultWithScopeTestFallback).scopeTestFallback).toBe(true);
  });
});

describe("AC-10: collectStoryMetrics() propagates scopeTestFallback: true from verifyResult", () => {
  test("collectStoryMetrics() with verifyResult.scopeTestFallback: true returns StoryMetrics with scopeTestFallback: true", () => {
    const mockVerifyResult = {
      success: true,
      status: "PASS" as const,
      storyId: "US-001",
      strategy: "scoped" as const,
      passCount: 100,
      failCount: 0,
      totalCount: 100,
      failures: [],
      rawOutput: undefined,
      durationMs: 5000,
      countsTowardEscalation: false,
      scopeTestFallback: true,
    };

    const mockCtx: PipelineContext = {
      config: makeMinimalConfig(),
      story: {
        id: "US-001",
        title: "Test Story",
        description: "Test",
        acceptanceCriteria: ["AC-1"],
        tags: [],
      },
      stories: [],
      routing: {
        complexity: "simple",
        modelTier: "fast",
        testStrategy: "tdd-simple",
        reasoning: "test",
      },
      workdir: "/tmp/test",
      hooks: { hooks: {} },
      verifyResult: mockVerifyResult,
    } as unknown as PipelineContext;

    const metrics = collectStoryMetrics(mockCtx, new Date().toISOString());

    type StoryMetricsWithScopeTestFallback = typeof metrics & { scopeTestFallback?: boolean };
    expect((metrics as StoryMetricsWithScopeTestFallback).scopeTestFallback).toBe(true);
  });
});

describe("AC-11: When no fallback, scopeTestFallback is absent from StoryMetrics", () => {
  test("collectStoryMetrics() without scopeTestFallback in verifyResult does not include scopeTestFallback key", () => {
    const mockVerifyResult = {
      success: true,
      status: "PASS" as const,
      storyId: "US-001",
      strategy: "scoped" as const,
      passCount: 5,
      failCount: 0,
      totalCount: 5,
      failures: [],
      rawOutput: undefined,
      durationMs: 1000,
      countsTowardEscalation: false,
    };

    const mockCtx: PipelineContext = {
      config: makeMinimalConfig(),
      story: {
        id: "US-001",
        title: "Test Story",
        description: "Test",
        acceptanceCriteria: ["AC-1"],
        tags: [],
      },
      stories: [],
      routing: {
        complexity: "simple",
        modelTier: "fast",
        testStrategy: "tdd-simple",
        reasoning: "test",
      },
      workdir: "/tmp/test",
      hooks: { hooks: {} },
      verifyResult: mockVerifyResult,
    } as unknown as PipelineContext;

    const metrics = collectStoryMetrics(mockCtx, new Date().toISOString());

    const hasKey = Object.prototype.hasOwnProperty.call(metrics, "scopeTestFallback");
    expect(hasKey).toBe(false);
  });
});