/**
 * Tests for escalateOnExhaustion config field (RECT-001)
 *
 * Verifies that the escalateOnExhaustion field is properly defined,
 * defaults to true, and can be overridden to false.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { NaxConfigSchema } from "../../../src/config/schemas";
import { FIELD_DESCRIPTIONS } from "../../../src/cli/config-descriptions";
import type { RectificationConfig } from "../../../src/config/runtime-types";

describe("escalateOnExhaustion config field", () => {
  test("RectificationConfig type has escalateOnExhaustion field", () => {
    const rectConfig: RectificationConfig = {
      enabled: true,
      maxRetries: 2,
      fullSuiteTimeoutSeconds: 120,
      maxFailureSummaryChars: 2000,
      abortOnIncreasingFailures: true,
      escalateOnExhaustion: true,
    };
    expect(rectConfig.escalateOnExhaustion).toBe(true);
  });

  test("DEFAULT_CONFIG.execution.rectification.escalateOnExhaustion equals true", () => {
    expect(DEFAULT_CONFIG.execution.rectification.escalateOnExhaustion).toBe(true);
  });

  test("schema accepts escalateOnExhaustion: true", () => {
    const config = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        rectification: {
          ...DEFAULT_CONFIG.execution.rectification,
          escalateOnExhaustion: true,
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.execution.rectification.escalateOnExhaustion).toBe(true);
    }
  });

  test("schema accepts escalateOnExhaustion: false", () => {
    const config = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        rectification: {
          ...DEFAULT_CONFIG.execution.rectification,
          escalateOnExhaustion: false,
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.execution.rectification.escalateOnExhaustion).toBe(false);
    }
  });

  test("schema defaults escalateOnExhaustion to true when omitted", () => {
    const config = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        rectification: {
          enabled: true,
          maxRetries: 2,
          fullSuiteTimeoutSeconds: 120,
          maxFailureSummaryChars: 2000,
          abortOnIncreasingFailures: true,
          // escalateOnExhaustion intentionally omitted
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.execution.rectification.escalateOnExhaustion).toBe(true);
    }
  });

  test("FIELD_DESCRIPTIONS has execution.rectification.escalateOnExhaustion key", () => {
    const key = "execution.rectification.escalateOnExhaustion";
    expect(key in FIELD_DESCRIPTIONS).toBe(true);
  });

  test("FIELD_DESCRIPTIONS entry contains 'model tier escalation' phrase", () => {
    const key = "execution.rectification.escalateOnExhaustion";
    const description = FIELD_DESCRIPTIONS[key];
    expect(description !== undefined).toBe(true);
    if (description) {
      expect(description).toContain("model tier escalation");
    }
  });
});
