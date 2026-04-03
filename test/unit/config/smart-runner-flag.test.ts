// RE-ARCH: keep
/**
 * Smart Test Runner Config Flag Tests (STR-004)
 *
 * Verifies that execution.smartTestRunner is present in the ExecutionConfig
 * interface, defaults to true in the Zod schema, and loads correctly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { loadConfig } from "../../../src/config/loader";
import { NaxConfigSchema } from "../../../src/config/schemas";
import { makeTempDir } from "../../helpers/temp";

describe("execution.smartTestRunner config flag", () => {
  let tempDir: string;
  let originalGlobalDir: string | undefined;

  beforeEach(() => {
    tempDir = makeTempDir("nax-str-004-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });
    originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = join(tempDir, ".global-nax");
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    if (originalGlobalDir === undefined) {
      process.env.NAX_GLOBAL_CONFIG_DIR = undefined;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
    }
  });

  test("DEFAULT_CONFIG has smartTestRunner: true", () => {
    expect(DEFAULT_CONFIG.execution.smartTestRunner).toBe(true);
  });

  test("Zod schema defaults smartTestRunner to enabled object when field is absent", () => {
    const minimal = {
      version: 1,
      models: {
        claude: {
          fast: { provider: "anthropic", model: "haiku" },
          balanced: { provider: "anthropic", model: "sonnet" },
          powerful: { provider: "anthropic", model: "opus" },
        },
      },
      autoMode: {
        enabled: true,
        defaultAgent: "claude",
        fallbackOrder: [],
        complexityRouting: { simple: "fast", medium: "balanced", complex: "powerful", expert: "powerful" },
        escalation: { enabled: true, tierOrder: [{ tier: "fast", attempts: 1 }] },
      },
      routing: { strategy: "keyword" },
      execution: {
        maxIterations: 10,
        iterationDelayMs: 0,
        costLimit: 1,
        sessionTimeoutSeconds: 60,
        maxStoriesPerFeature: 10,
        rectification: {
          enabled: true,
          maxRetries: 1,
          fullSuiteTimeoutSeconds: 30,
          maxFailureSummaryChars: 500,
          abortOnIncreasingFailures: true,
        },
        regressionGate: { enabled: true, timeoutSeconds: 30 },
        contextProviderTokenBudget: 100,
        // smartTestRunner intentionally omitted
      },
      quality: {
        requireTypecheck: true,
        requireLint: true,
        requireTests: true,
        commands: {},
        forceExit: false,
        detectOpenHandles: true,
        detectOpenHandlesRetries: 1,
        gracePeriodMs: 500,
        drainTimeoutMs: 0,
        shell: "/bin/sh",
        stripEnvVars: [],
      },
      tdd: { maxRetries: 0, autoVerifyIsolation: false, autoApproveVerifier: false },
      constitution: { enabled: false, path: "constitution.md", maxTokens: 100 },
      analyze: { llmEnhanced: false, model: "balanced", fallbackToKeywords: true, maxCodebaseSummaryTokens: 100 },
      review: { enabled: false, checks: [], commands: {} },
      plan: { model: "balanced", outputPath: "spec.md" },
      acceptance: { enabled: false, maxRetries: 0, generateTests: false, testPath: "acceptance.test.ts" },
      context: {
        testCoverage: {
          enabled: false,
          detail: "names-only",
          maxTokens: 50,
          testPattern: "**/*.test.ts",
          scopeToStory: false,
        },
        autoDetect: { enabled: false, maxFiles: 1, traceImports: false },
      },
    };

    const result = NaxConfigSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.execution.smartTestRunner).toEqual({
        enabled: true,
        testFilePatterns: ["test/**/*.test.ts"],
        fallback: "import-grep",
      });
    }
  });

  test("Zod schema coerces smartTestRunner: false to disabled config object", () => {
    const result = NaxConfigSchema.safeParse({
      ...buildMinimalConfig(),
      execution: { ...buildMinimalConfig().execution, smartTestRunner: false },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.execution.smartTestRunner).toEqual({
        enabled: false,
        testFilePatterns: ["test/**/*.test.ts"],
        fallback: "import-grep",
      });
    }
  });

  test("Zod schema coerces smartTestRunner: true to enabled config object", () => {
    const result = NaxConfigSchema.safeParse({
      ...buildMinimalConfig(),
      execution: { ...buildMinimalConfig().execution, smartTestRunner: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.execution.smartTestRunner).toEqual({
        enabled: true,
        testFilePatterns: ["test/**/*.test.ts"],
        fallback: "import-grep",
      });
    }
  });

  test("loadConfig defaults smartTestRunner to enabled object when not in project config", async () => {
    const configPath = join(tempDir, ".nax", "config.json");
    writeFileSync(configPath, JSON.stringify({ routing: { strategy: "keyword" } }, null, 2));

    const config = await loadConfig(join(tempDir, ".nax"));
    expect(config.execution.smartTestRunner).toEqual({
      enabled: true,
      testFilePatterns: ["test/**/*.test.ts"],
      fallback: "import-grep",
    });
  });

  test("loadConfig coerces smartTestRunner: false to disabled config object", async () => {
    const configPath = join(tempDir, ".nax", "config.json");
    writeFileSync(configPath, JSON.stringify({ execution: { smartTestRunner: false } }, null, 2));

    const config = await loadConfig(join(tempDir, ".nax"));
    expect(config.execution.smartTestRunner).toEqual({
      enabled: false,
      testFilePatterns: ["test/**/*.test.ts"],
      fallback: "import-grep",
    });
  });

  test("loadConfig normalizes to enabled object when field is absent (backward compat)", async () => {
    const configPath = join(tempDir, ".nax", "config.json");
    // Config without smartTestRunner field at all
    writeFileSync(configPath, JSON.stringify({}, null, 2));

    const config = await loadConfig(join(tempDir, ".nax"));
    expect(config.execution.smartTestRunner).toEqual({
      enabled: true,
      testFilePatterns: ["test/**/*.test.ts"],
      fallback: "import-grep",
    });
  });
});

// ---------------------------------------------------------------------------
// Minimal valid config helper
// ---------------------------------------------------------------------------

function buildMinimalConfig() {
  return {
    version: 1,
    models: {
      claude: {
        fast: { provider: "anthropic", model: "haiku" },
        balanced: { provider: "anthropic", model: "sonnet" },
        powerful: { provider: "anthropic", model: "opus" },
      },
    },
    autoMode: {
      enabled: true,
      defaultAgent: "claude",
      fallbackOrder: [],
      complexityRouting: { simple: "fast", medium: "balanced", complex: "powerful", expert: "powerful" },
      escalation: { enabled: true, tierOrder: [{ tier: "fast", attempts: 1 }] },
    },
    routing: { strategy: "keyword" as const },
    execution: {
      maxIterations: 10,
      iterationDelayMs: 0,
      costLimit: 1,
      sessionTimeoutSeconds: 60,
      maxStoriesPerFeature: 10,
      rectification: {
        enabled: true,
        maxRetries: 1,
        fullSuiteTimeoutSeconds: 30,
        maxFailureSummaryChars: 500,
        abortOnIncreasingFailures: true,
      },
      regressionGate: { enabled: true, timeoutSeconds: 30 },
      contextProviderTokenBudget: 100,
    },
    quality: {
      requireTypecheck: true,
      requireLint: true,
      requireTests: true,
      commands: {},
      forceExit: false,
      detectOpenHandles: true,
      detectOpenHandlesRetries: 1,
      gracePeriodMs: 500,
      drainTimeoutMs: 0,
      shell: "/bin/sh",
      stripEnvVars: [],
    },
    tdd: { maxRetries: 0, autoVerifyIsolation: false, autoApproveVerifier: false },
    constitution: { enabled: false, path: "constitution.md", maxTokens: 100 },
    analyze: { llmEnhanced: false, model: "balanced", fallbackToKeywords: true, maxCodebaseSummaryTokens: 100 },
    review: { enabled: false, checks: [] as Array<"typecheck" | "lint" | "test">, commands: {} },
    plan: { model: "balanced", outputPath: "spec.md" },
    acceptance: { enabled: false, maxRetries: 0, generateTests: false, testPath: "acceptance.test.ts" },
    context: {
      testCoverage: {
        enabled: false,
        detail: "names-only" as const,
        maxTokens: 50,
        testPattern: "**/*.test.ts",
        scopeToStory: false,
      },
      autoDetect: { enabled: false, maxFiles: 1, traceImports: false },
    },
  };
}
