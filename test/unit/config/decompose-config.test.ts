/**
 * Unit Tests: DecomposeConfig schema and NaxConfig defaults (SD-003)
 *
 * Verifies that:
 * - DecomposeConfig is added to NaxConfig with all required fields
 * - DEFAULT_CONFIG.decompose has correct default values
 * - NaxConfigSchema validates decompose section correctly
 *
 * These tests FAIL until SD-003 is implemented.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { NaxConfigSchema } from "../../../src/config/schemas";

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT_CONFIG.decompose — presence and defaults
// ─────────────────────────────────────────────────────────────────────────────

describe("DEFAULT_CONFIG.decompose — presence", () => {
  test("DEFAULT_CONFIG has a decompose section", () => {
    // FAILS until SD-003 adds DecomposeConfig to NaxConfig and DEFAULT_CONFIG
    expect(DEFAULT_CONFIG).toHaveProperty("decompose");
    expect((DEFAULT_CONFIG as unknown as Record<string, unknown>).decompose).not.toBeUndefined();
  });
});

describe("DEFAULT_CONFIG.decompose — field defaults", () => {
  // Helper to read the (not-yet-typed) decompose config
  const decompose = () =>
    (DEFAULT_CONFIG as unknown as Record<string, unknown>).decompose as Record<string, unknown> | undefined;

  test("decompose.trigger defaults to 'auto'", () => {
    // FAILS until SD-003 sets trigger default
    expect(decompose()?.trigger).toBe("auto");
  });

  test("decompose.maxAcceptanceCriteria defaults to 6", () => {
    // FAILS until SD-003 sets maxAcceptanceCriteria default
    expect(decompose()?.maxAcceptanceCriteria).toBe(6);
  });

  test("decompose.maxSubstories defaults to 5", () => {
    // FAILS until SD-003 sets maxSubstories default
    expect(decompose()?.maxSubstories).toBe(5);
  });

  test("decompose.maxSubstoryComplexity defaults to 'medium'", () => {
    // FAILS until SD-003 sets maxSubstoryComplexity default
    expect(decompose()?.maxSubstoryComplexity).toBe("medium");
  });

  test("decompose.maxRetries defaults to 2", () => {
    // FAILS until SD-003 sets maxRetries default
    expect(decompose()?.maxRetries).toBe(2);
  });

  test("decompose.model defaults to 'balanced'", () => {
    // FAILS until SD-003 sets model default
    expect(decompose()?.model).toBe("balanced");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NaxConfigSchema — validates decompose section
// ─────────────────────────────────────────────────────────────────────────────

describe("NaxConfigSchema — decompose validation", () => {
  const validDecompose = {
    trigger: "auto",
    maxAcceptanceCriteria: 6,
    maxSubstories: 5,
    maxSubstoryComplexity: "medium",
    maxRetries: 2,
    model: "balanced",
  };

  test("schema accepts config with valid decompose section", () => {
    // FAILS until SD-003 adds decompose to NaxConfigSchema
    const config = { ...DEFAULT_CONFIG, decompose: validDecompose };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("schema accepts decompose.trigger of 'confirm'", () => {
    // FAILS until SD-003 adds decompose to NaxConfigSchema
    const config = { ...DEFAULT_CONFIG, decompose: { ...validDecompose, trigger: "confirm" } };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("schema accepts decompose.trigger of 'disabled'", () => {
    // FAILS until SD-003 adds decompose to NaxConfigSchema
    const config = { ...DEFAULT_CONFIG, decompose: { ...validDecompose, trigger: "disabled" } };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("schema rejects invalid decompose.trigger value", () => {
    // FAILS until SD-003 adds decompose to NaxConfigSchema with enum validation
    const config = { ...DEFAULT_CONFIG, decompose: { ...validDecompose, trigger: "unknown" } };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test("schema rejects negative maxAcceptanceCriteria", () => {
    // FAILS until SD-003 adds decompose to NaxConfigSchema with numeric validation
    const config = { ...DEFAULT_CONFIG, decompose: { ...validDecompose, maxAcceptanceCriteria: -1 } };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test("schema rejects negative maxSubstories", () => {
    // FAILS until SD-003 adds decompose to NaxConfigSchema with numeric validation
    const config = { ...DEFAULT_CONFIG, decompose: { ...validDecompose, maxSubstories: 0 } };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test("schema accepts valid maxSubstoryComplexity values", () => {
    // FAILS until SD-003 adds decompose to NaxConfigSchema
    for (const complexity of ["simple", "medium", "complex", "expert"]) {
      const config = { ...DEFAULT_CONFIG, decompose: { ...validDecompose, maxSubstoryComplexity: complexity } };
      const result = NaxConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    }
  });

  test("schema rejects invalid maxSubstoryComplexity value", () => {
    // FAILS until SD-003 adds decompose to NaxConfigSchema with enum validation
    const config = { ...DEFAULT_CONFIG, decompose: { ...validDecompose, maxSubstoryComplexity: "ultra" } };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});
