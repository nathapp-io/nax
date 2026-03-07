// RE-ARCH: keep
/**
 * Config Schema Validation for lintCommand and typecheckCommand (US-005)
 *
 * Verifies that config schema accepts lintCommand and typecheckCommand
 */

import { describe, expect, test } from "bun:test";
import { type NaxConfig, NaxConfigSchema } from "../../../src/config/schema";
import { DEFAULT_CONFIG } from "../../../src/config/schema";

describe("Config Schema: lintCommand and typecheckCommand (US-005)", () => {
  test("accepts lintCommand as string", () => {
    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        lintCommand: "eslint .",
      },
    };

    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("accepts typecheckCommand as string", () => {
    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        typecheckCommand: "tsc --noEmit",
      },
    };

    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("accepts lintCommand as null (explicitly disabled)", () => {
    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        lintCommand: null,
      },
    };

    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("accepts typecheckCommand as null (explicitly disabled)", () => {
    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        typecheckCommand: null,
      },
    };

    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("accepts both lintCommand and typecheckCommand undefined (auto-detect)", () => {
    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        // lintCommand and typecheckCommand are undefined (omitted)
      },
    };

    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("accepts both commands configured together", () => {
    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        lintCommand: "eslint .",
        typecheckCommand: "tsc --noEmit",
      },
    };

    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("rejects lintCommand as number (invalid type)", () => {
    const config = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        lintCommand: 123, // invalid type
      },
    };

    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test("rejects typecheckCommand as boolean (invalid type)", () => {
    const config = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        typecheckCommand: true, // invalid type
      },
    };

    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});
