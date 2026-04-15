// RE-ARCH: keep
/**
 * Smart Test Runner — Config Coercion Tests
 *
 * Tests that boolean/object config values are correctly coerced into
 * SmartTestRunnerConfig shape via NaxConfigSchema.
 */

import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "../../../src/config/schemas";
import type { SmartTestRunnerConfig } from "../../../src/config/types";

describe("SmartTestRunner config coercion", () => {
  function parseExecution(smartTestRunner: unknown) {
    const minimalConfig = {
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
        smartTestRunner,
      },
      quality: {
        requireTypecheck: false,
        requireLint: false,
        requireTests: false,
        commands: {},
        forceExit: false,
        detectOpenHandles: false,
        detectOpenHandlesRetries: 0,
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
    return NaxConfigSchema.safeParse(minimalConfig);
  }

  test("boolean true coerces to enabled object with defaults", () => {
    const result = parseExecution(true);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.execution.smartTestRunner).toEqual({
        enabled: true,
        fallback: "import-grep",
      });
    }
  });

  test("boolean false coerces to disabled object with defaults", () => {
    const result = parseExecution(false);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.execution.smartTestRunner).toEqual({
        enabled: false,
        fallback: "import-grep",
      });
    }
  });

  test("omitted field defaults to enabled object", () => {
    const result = parseExecution(undefined);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.execution.smartTestRunner).toEqual({
        enabled: true,
        fallback: "import-grep",
      });
    }
  });

  test("object with enabled: true is preserved as-is", () => {
    const result = parseExecution({
      enabled: true,
      testFilePatterns: ["test/custom/**/*.test.ts"],
      fallback: "import-grep",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.execution.smartTestRunner).toEqual({
        enabled: true,
        testFilePatterns: ["test/custom/**/*.test.ts"],
        fallback: "import-grep",
      });
    }
  });

  test("object with fallback: full-suite is accepted", () => {
    const result = parseExecution({
      enabled: true,
      testFilePatterns: ["test/**/*.test.ts"],
      fallback: "full-suite",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const cfg = result.data.execution.smartTestRunner as SmartTestRunnerConfig;
      expect(cfg.fallback).toBe("full-suite");
    }
  });

  test("custom testFilePatterns are preserved", () => {
    const patterns = ["test/unit/**/*.test.ts", "test/integration/**/*.test.ts"];
    const result = parseExecution({
      enabled: true,
      testFilePatterns: patterns,
      fallback: "import-grep",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const cfg = result.data.execution.smartTestRunner as SmartTestRunnerConfig;
      expect(cfg.testFilePatterns).toEqual(patterns);
    }
  });
});

// ---------------------------------------------------------------------------
// Pass 1: path convention mapping
// ---------------------------------------------------------------------------
