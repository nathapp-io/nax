/**
 * AcceptanceFixConfig tests
 *
 * Story US-001: Add AcceptanceFixConfig to config schema with defaults
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, NaxConfigSchema } from "@/config";
import type { AcceptanceFixConfig } from "@/config/runtime-types";

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

describe("AcceptanceConfigSchema fix strategy validation (US-001)", () => {
  function baseAcceptanceFixConfig(fix: Record<string, unknown>): Record<string, unknown> {
    return {
      ...DEFAULT_CONFIG,
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
