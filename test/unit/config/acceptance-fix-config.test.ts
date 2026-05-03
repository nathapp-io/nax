/**
 * AcceptanceFixConfig and DiagnosisResult tests
 *
 * Story US-001: Add AcceptanceFixConfig to config schema with defaults and DiagnosisResult type
 */

import { describe, expect, test } from "bun:test";
import type { DiagnosisResult } from "../../../src/acceptance/types";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import type { AcceptanceFixConfig } from "../../../src/config/runtime-types";
import { NaxConfigSchema } from "../../../src/config/schemas";

describe("AcceptanceFixConfig type (US-001)", () => {
  test("NaxConfig.acceptance.fix has correct fields", () => {
    const fix: AcceptanceFixConfig = {
      diagnoseModel: "fast",
      fixModel: "balanced",
      strategy: "diagnose-first",
      maxRetries: 2,
      cycleV2: false,
    };
    expect(fix.diagnoseModel).toBe("fast");
    expect(fix.fixModel).toBe("balanced");
    expect(fix.strategy).toBe("diagnose-first");
    expect(fix.maxRetries).toBe(2);
    expect(fix.cycleV2).toBe(false);
  });

  test("strategy accepts 'implement-only'", () => {
    const fix: AcceptanceFixConfig = {
      diagnoseModel: "fast",
      fixModel: "balanced",
      strategy: "implement-only",
      maxRetries: 2,
      cycleV2: false,
    };
    expect(fix.strategy).toBe("implement-only");
  });

  test("cycleV2 defaults to false in schema", () => {
    const fix: AcceptanceFixConfig = {
      diagnoseModel: "fast",
      fixModel: "balanced",
      strategy: "diagnose-first",
      maxRetries: 2,
      cycleV2: false,
    };
    expect(fix.cycleV2).toBe(false);
  });
});

describe("DEFAULT_CONFIG.acceptance.fix (US-001)", () => {
  test("acceptance.fix equals expected defaults", () => {
    expect(DEFAULT_CONFIG.acceptance.fix).toEqual({
      diagnoseModel: "fast",
      fixModel: "balanced",
      strategy: "diagnose-first",
      maxRetries: 2,
      cycleV2: false,
    });
  });

  test("acceptance.fix.diagnoseModel is 'fast'", () => {
    expect(DEFAULT_CONFIG.acceptance.fix.diagnoseModel).toBe("fast");
  });

  test("acceptance.fix.fixModel is 'balanced'", () => {
    expect(DEFAULT_CONFIG.acceptance.fix.fixModel).toBe("balanced");
  });

  test("acceptance.fix.strategy is 'diagnose-first'", () => {
    expect(DEFAULT_CONFIG.acceptance.fix.strategy).toBe("diagnose-first");
  });

  test("acceptance.fix.maxRetries is 2", () => {
    expect(DEFAULT_CONFIG.acceptance.fix.maxRetries).toBe(2);
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

  test("verdict accepts 'test_bug'", () => {
    const result: DiagnosisResult = {
      verdict: "test_bug",
      reasoning: "The test is incorrect",
      confidence: 0.9,
    };
    expect(result.verdict).toBe("test_bug");
  });

  test("verdict accepts 'both'", () => {
    const result: DiagnosisResult = {
      verdict: "both",
      reasoning: "Both source and test have issues",
      confidence: 0.75,
    };
    expect(result.verdict).toBe("both");
  });

  test("confidence accepts 0", () => {
    const result: DiagnosisResult = {
      verdict: "source_bug",
      reasoning: "No confidence in the analysis",
      confidence: 0,
    };
    expect(result.confidence).toBe(0);
  });

  test("confidence accepts 1", () => {
    const result: DiagnosisResult = {
      verdict: "test_bug",
      reasoning: "Certain about the test bug",
      confidence: 1,
    };
    expect(result.confidence).toBe(1);
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

  test("accepts 'diagnose-first' strategy", () => {
    const config = baseAcceptanceFixConfig({
      diagnoseModel: "fast",
      fixModel: "balanced",
      strategy: "diagnose-first",
      maxRetries: 2,
    });
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("accepts 'implement-only' strategy", () => {
    const config = baseAcceptanceFixConfig({
      diagnoseModel: "fast",
      fixModel: "balanced",
      strategy: "implement-only",
      maxRetries: 2,
    });
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("rejects unknown strategy value", () => {
    const config = baseAcceptanceFixConfig({
      diagnoseModel: "fast",
      fixModel: "balanced",
      strategy: "invalid-strategy",
      maxRetries: 2,
    });
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test("rejects strategy value 'diagnose-only' (wrong pattern)", () => {
    const config = baseAcceptanceFixConfig({
      diagnoseModel: "fast",
      fixModel: "balanced",
      strategy: "diagnose-only",
      maxRetries: 2,
    });
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
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
