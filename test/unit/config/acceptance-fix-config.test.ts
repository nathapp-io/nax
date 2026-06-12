/**
 * AcceptanceFixConfig and DiagnosisResult tests
 *
 * Story US-001: Add AcceptanceFixConfig to config schema with defaults and DiagnosisResult type
 */

import { describe, expect, test } from "bun:test";
import type { DiagnosisResult } from "../../../src/acceptance/types";
import { DEFAULT_CONFIG, NaxConfigSchema } from "../../../src/config";
import type { AcceptanceFixConfig } from "../../../src/config/runtime-types";

describe("AcceptanceFixConfig type (US-001)", () => {
  test("NaxConfig.acceptance.fix has correct fields", () => {
    const fix: AcceptanceFixConfig = {
      diagnoseModel: "fast",
      fixModel: "balanced",
      strategy: "diagnose-first",
      maxRetries: 2,
    };
    expect(fix.diagnoseModel).toBe("fast");
    expect(fix.fixModel).toBe("balanced");
    expect(fix.strategy).toBe("diagnose-first");
    expect(fix.maxRetries).toBe(2);
  });

  test("strategy accepts 'implement-only'", () => {
    const fix: AcceptanceFixConfig = {
      diagnoseModel: "fast",
      fixModel: "balanced",
      strategy: "implement-only",
      maxRetries: 2,
    };
    expect(fix.strategy).toBe("implement-only");
  });
});

describe("DEFAULT_CONFIG.acceptance.fix (US-001)", () => {
  test("acceptance.fix equals expected defaults", () => {
    expect(DEFAULT_CONFIG.acceptance.fix).toEqual({
      diagnoseModel: "fast",
      fixModel: "balanced",
      strategy: "diagnose-first",
      maxRetries: 2,
    });
  });

  test.each([
    ["diagnoseModel" as const, "fast" as const],
    ["fixModel" as const, "balanced" as const],
    ["strategy" as const, "diagnose-first" as const],
    ["maxRetries" as const, 2 as const],
  ])("acceptance.fix.%s is %s", (field, expected) => {
    expect(DEFAULT_CONFIG.acceptance.fix[field]).toBe(expected);
  });
});

describe("DiagnosisResult interface (US-001)", () => {
  test("creates DiagnosisResult with required fields", () => {
    const result: DiagnosisResult = {
      verdict: "source_bug",
      reasoning: "The source code has a bug in the login function",
      confidence: 0.85,
    };
    expect(result.verdict).toBe("source_bug");
    expect(result.reasoning).toBe("The source code has a bug in the login function");
    expect(result.confidence).toBe(0.85);
  });

  test.each([
    ["test_bug" as const],
    ["both" as const],
  ])("verdict accepts '%s'", (verdict) => {
    const result: DiagnosisResult = { verdict, reasoning: "test", confidence: 0.9 };
    expect(result.verdict).toBe(verdict);
  });

  test.each([
    [0 as const],
    [1 as const],
  ])("confidence accepts %s", (confidence) => {
    const result: DiagnosisResult = { verdict: "source_bug", reasoning: "test", confidence };
    expect(result.confidence).toBe(confidence);
  });

  test("findings is optional", () => {
    const result: DiagnosisResult = {
      verdict: "source_bug",
      reasoning: "Source bug found",
      confidence: 0.8,
    };
    expect(result.findings).toBeUndefined();
  });

  test("findings can be provided", () => {
    const result: DiagnosisResult = {
      verdict: "test_bug",
      reasoning: "Test bug found",
      confidence: 0.8,
      findings: [
        { source: "acceptance-diagnose", severity: "error", category: "import-path", message: "Wrong import", fixTarget: "test" },
      ],
    };
    expect(result.findings?.length).toBe(1);
    expect(result.findings?.[0].message).toBe("Wrong import");
  });
});

describe("AcceptanceConfigSchema fix strategy validation (US-001)", () => {
  function baseAcceptanceFixConfig(fix: Record<string, unknown>): Record<string, unknown> {
    return {
      ...(DEFAULT_CONFIG as Record<string, unknown>),
      acceptance: {
        ...DEFAULT_CONFIG.acceptance,
        fix,
      },
    };
  }

  test.each([
    ["diagnose-first", true],
    ["implement-only", true],
    ["invalid-strategy", false],
    ["diagnose-only (wrong pattern)", false],
  ])("strategy '%s' accepted=%s", (strategy, expected) => {
    const config = baseAcceptanceFixConfig({ diagnoseModel: "fast", fixModel: "balanced", strategy, maxRetries: 2 });
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(expected);
  });

  test("fix object is optional (backwards compat)", () => {
    const config = {
      ...DEFAULT_CONFIG,
      acceptance: {
        ...DEFAULT_CONFIG.acceptance,
      },
    };
    delete (config.acceptance as Record<string, unknown>).fix;
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });
});

describe("AcceptanceConfigSchema generateModel field", () => {
  test("generateModel is absent from DEFAULT_CONFIG (optional)", () => {
    expect(DEFAULT_CONFIG.acceptance.generateModel).toBeUndefined();
  });

  test("generateModel accepts a tier string", () => {
    const config = {
      ...DEFAULT_CONFIG,
      acceptance: { ...DEFAULT_CONFIG.acceptance, generateModel: "balanced" },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.acceptance.generateModel).toBe("balanced");
    }
  });

  test("generateModel accepts an explicit agent/model object", () => {
    const config = {
      ...DEFAULT_CONFIG,
      acceptance: {
        ...DEFAULT_CONFIG.acceptance,
        generateModel: { agent: "opencode", model: "opencode-go/deepseek-v4-flash" },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.acceptance.generateModel).toEqual({
        agent: "opencode",
        model: "opencode-go/deepseek-v4-flash",
      });
    }
  });

  test("generateModel rejects an invalid value", () => {
    const config = {
      ...DEFAULT_CONFIG,
      acceptance: { ...DEFAULT_CONFIG.acceptance, generateModel: 123 },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test("config without generateModel still parses successfully (backwards compat)", () => {
    const config = { ...DEFAULT_CONFIG };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.acceptance.generateModel).toBeUndefined();
    }
  });
});
