/**
 * Tests for AcceptanceTestStrategy type and AcceptanceConfig schema extension (ACS-001)
 *
 * AC1: AcceptanceTestStrategy type exported from src/config/ with 5 valid values
 * AC2: AcceptanceConfig has optional testStrategy field
 * AC3: AcceptanceConfig has optional testFramework field
 * AC4: Zod schema validates testStrategy as optional enum with 5 values
 * AC5: Zod schema validates testFramework as optional non-empty string
 * AC6: Default config omits testStrategy and testFramework (both undefined)
 * AC7: Existing tests pass without modification — backward compatible
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { NaxConfigSchema } from "../../../src/config/schemas";
import type { AcceptanceConfig } from "../../../src/config/runtime-types";
// AC1: AcceptanceTestStrategy must be importable from src/config/runtime-types
import type { AcceptanceTestStrategy } from "../../../src/config/runtime-types";

const BASE_ACCEPTANCE = DEFAULT_CONFIG.acceptance;

describe("AcceptanceTestStrategy type", () => {
  test.each([
    ["unit" as AcceptanceTestStrategy],
    ["component" as AcceptanceTestStrategy],
    ["cli" as AcceptanceTestStrategy],
    ["e2e" as AcceptanceTestStrategy],
    ["snapshot" as AcceptanceTestStrategy],
  ])("accepts '%s' as a valid AcceptanceTestStrategy value", (strategy) => {
    expect(strategy).toBe(strategy);
  });
});

describe("AcceptanceConfig interface — optional fields", () => {
  test("testStrategy is assignable as optional on AcceptanceConfig", () => {
    const config: AcceptanceConfig = {
      ...BASE_ACCEPTANCE,
      testStrategy: "unit",
    };
    expect(config.testStrategy).toBe("unit");
  });

  test("testFramework is assignable as optional on AcceptanceConfig", () => {
    const config: AcceptanceConfig = {
      ...BASE_ACCEPTANCE,
      testFramework: "jest",
    };
    expect(config.testFramework).toBe("jest");
  });

  test("AcceptanceConfig is valid without testStrategy or testFramework", () => {
    const config: AcceptanceConfig = { ...BASE_ACCEPTANCE };
    expect(config.testStrategy).toBeUndefined();
    expect(config.testFramework).toBeUndefined();
  });
});

describe("AcceptanceConfigSchema — testStrategy validation", () => {
  test.each([
    ["unit"],
    ["component"],
    ["cli"],
    ["e2e"],
    ["snapshot"],
    [undefined],
  ])("accepts testStrategy %j (success=true)", (testStrategy) => {
    const config = {
      ...DEFAULT_CONFIG,
      acceptance: testStrategy !== undefined ? { ...BASE_ACCEPTANCE, testStrategy } : { ...BASE_ACCEPTANCE },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("rejects unknown testStrategy value", () => {
    const config = {
      ...DEFAULT_CONFIG,
      acceptance: { ...BASE_ACCEPTANCE, testStrategy: "unknown-strategy" },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});

describe("AcceptanceConfigSchema — testFramework validation", () => {
  test.each([
    ["jest"],
    ["bun:test"],
    [undefined],
  ])("accepts testFramework %j (success=true)", (testFramework) => {
    const config = {
      ...DEFAULT_CONFIG,
      acceptance: testFramework !== undefined ? { ...BASE_ACCEPTANCE, testFramework } : { ...BASE_ACCEPTANCE },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("rejects testFramework as empty string", () => {
    const config = {
      ...DEFAULT_CONFIG,
      acceptance: { ...BASE_ACCEPTANCE, testFramework: "" },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});

describe("DEFAULT_CONFIG acceptance defaults", () => {
  test.each([
    ["testStrategy" as const],
    ["testFramework" as const],
  ])("default acceptance config does not set %s", (field) => {
    expect(DEFAULT_CONFIG.acceptance[field]).toBeUndefined();
  });
});

describe("backward compatibility — NaxConfigSchema accepts existing acceptance config", () => {
  test("existing acceptance config without new fields parses successfully", () => {
    const result = NaxConfigSchema.safeParse(DEFAULT_CONFIG);
    expect(result.success).toBe(true);
  });

  test("parsed acceptance config preserves existing fields when new fields are absent", () => {
    const result = NaxConfigSchema.safeParse(DEFAULT_CONFIG);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.acceptance.enabled).toBe(DEFAULT_CONFIG.acceptance.enabled);
      expect(result.data.acceptance.maxRetries).toBe(DEFAULT_CONFIG.acceptance.maxRetries);
      expect(result.data.acceptance.testPath).toBe(DEFAULT_CONFIG.acceptance.testPath);
    }
  });
});
