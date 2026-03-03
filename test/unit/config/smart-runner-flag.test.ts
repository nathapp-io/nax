/**
 * Smart Test Runner Config Flag Tests (STR-004)
 *
 * Verifies that execution.smartTestRunner is present in the ExecutionConfig
 * interface, defaults to true in the Zod schema, and loads correctly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalConfigPath, loadConfig } from "../../../src/config/loader";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { NaxConfigSchema } from "../../../src/config/schemas";

describe("execution.smartTestRunner config flag", () => {
  let tempDir: string;
  let globalBackup: string | null = null;

  beforeEach(() => {
    tempDir = join(tmpdir(), `nax-str-004-${Date.now()}`);
    mkdirSync(join(tempDir, "nax"), { recursive: true });

    const globalPath = globalConfigPath();
    if (existsSync(globalPath)) {
      globalBackup = `${globalPath}.test-backup-${Date.now()}`;
      renameSync(globalPath, globalBackup);
    }
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    if (globalBackup && existsSync(globalBackup)) {
      const globalPath = globalConfigPath();
      if (existsSync(globalPath)) rmSync(globalPath);
      renameSync(globalBackup, globalPath);
      globalBackup = null;
    }
  });

  test("DEFAULT_CONFIG has smartTestRunner: true", () => {
    expect(DEFAULT_CONFIG.execution.smartTestRunner).toBe(true);
  });

  test("Zod schema defaults smartTestRunner to true when field is absent", () => {
    const minimal = {
      version: 1,
      models: {
        fast: { provider: "anthropic", model: "haiku" },
        balanced: { provider: "anthropic", model: "sonnet" },
        powerful: { provider: "anthropic", model: "opus" },
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
        environmentalEscalationDivisor: 2,
      },
      tdd: { maxRetries: 0, autoVerifyIsolation: false, autoApproveVerifier: false },
      constitution: { enabled: false, path: "constitution.md", maxTokens: 100 },
      analyze: { llmEnhanced: false, model: "balanced", fallbackToKeywords: true, maxCodebaseSummaryTokens: 100 },
      review: { enabled: false, checks: [], commands: {} },
      plan: { model: "balanced", outputPath: "spec.md" },
      acceptance: { enabled: false, maxRetries: 0, generateTests: false, testPath: "acceptance.test.ts" },
      context: {
        testCoverage: { enabled: false, detail: "names-only", maxTokens: 50, testPattern: "**/*.test.ts", scopeToStory: false },
        autoDetect: { enabled: false, maxFiles: 1, traceImports: false },
      },
    };

    const result = NaxConfigSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.execution.smartTestRunner).toBe(true);
    }
  });

  test("Zod schema accepts smartTestRunner: false", () => {
    const result = NaxConfigSchema.safeParse({
      ...buildMinimalConfig(),
      execution: { ...buildMinimalConfig().execution, smartTestRunner: false },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.execution.smartTestRunner).toBe(false);
    }
  });

  test("Zod schema accepts smartTestRunner: true explicitly", () => {
    const result = NaxConfigSchema.safeParse({
      ...buildMinimalConfig(),
      execution: { ...buildMinimalConfig().execution, smartTestRunner: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.execution.smartTestRunner).toBe(true);
    }
  });

  test("loadConfig defaults smartTestRunner to true when not in project config", async () => {
    const configPath = join(tempDir, "nax", "config.json");
    writeFileSync(configPath, JSON.stringify({ routing: { strategy: "keyword" } }, null, 2));

    const config = await loadConfig(join(tempDir, "nax"));
    expect(config.execution.smartTestRunner).toBe(true);
  });

  test("loadConfig respects smartTestRunner: false from project config", async () => {
    const configPath = join(tempDir, "nax", "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ execution: { smartTestRunner: false } }, null, 2),
    );

    const config = await loadConfig(join(tempDir, "nax"));
    expect(config.execution.smartTestRunner).toBe(false);
  });

  test("loadConfig loads correctly without the field (backward compat)", async () => {
    const configPath = join(tempDir, "nax", "config.json");
    // Config without smartTestRunner field at all
    writeFileSync(configPath, JSON.stringify({}, null, 2));

    const config = await loadConfig(join(tempDir, "nax"));
    expect(config.execution.smartTestRunner).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Minimal valid config helper
// ---------------------------------------------------------------------------

function buildMinimalConfig() {
  return {
    version: 1,
    models: {
      fast: { provider: "anthropic", model: "haiku" },
      balanced: { provider: "anthropic", model: "sonnet" },
      powerful: { provider: "anthropic", model: "opus" },
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
      environmentalEscalationDivisor: 2,
    },
    tdd: { maxRetries: 0, autoVerifyIsolation: false, autoApproveVerifier: false },
    constitution: { enabled: false, path: "constitution.md", maxTokens: 100 },
    analyze: { llmEnhanced: false, model: "balanced", fallbackToKeywords: true, maxCodebaseSummaryTokens: 100 },
    review: { enabled: false, checks: [] as Array<"typecheck" | "lint" | "test">, commands: {} },
    plan: { model: "balanced", outputPath: "spec.md" },
    acceptance: { enabled: false, maxRetries: 0, generateTests: false, testPath: "acceptance.test.ts" },
    context: {
      testCoverage: { enabled: false, detail: "names-only" as const, maxTokens: 50, testPattern: "**/*.test.ts", scopeToStory: false },
      autoDetect: { enabled: false, maxFiles: 1, traceImports: false },
    },
  };
}
