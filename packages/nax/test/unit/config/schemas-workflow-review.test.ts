import { describe, expect, test } from "bun:test";
import { FIELD_DESCRIPTIONS } from "@/cli/config-descriptions";
import { NaxConfigSchema, WORKFLOW_REVIEW_DEFAULTS } from "@/config";

describe("workflow.review defaults (US-002)", () => {
  test("AC-1: NaxConfigSchema.parse({}) fills the coverage retry default", () => {
    expect(NaxConfigSchema.parse({}).workflow.review).toEqual({ coverageRetries: 3 });
  });

  test("AC-2: WORKFLOW_REVIEW_DEFAULTS is the parsed review object", () => {
    expect(WORKFLOW_REVIEW_DEFAULTS).toEqual({ coverageRetries: 3 });
  });

  test("AC-4: review.coverageRetries: -1 fails to parse", () => {
    expect(NaxConfigSchema.safeParse({ workflow: { review: { coverageRetries: -1 } } }).success).toBe(false);
  });

  test("AC-5: review.coverageRetries: 0 is kept — the budget can be switched off", () => {
    const parsed = NaxConfigSchema.safeParse({ workflow: { review: { coverageRetries: 0 } } });
    if (!parsed.success) throw new Error(`coverageRetries: 0 should parse: ${parsed.error.message}`);
    expect(parsed.data.workflow.review.coverageRetries).toBe(0);
  });

  test("an explicit coverage retry budget is retained", () => {
    const parsed = NaxConfigSchema.parse({ workflow: { review: { coverageRetries: 1 } } });
    expect(parsed.workflow.review).toEqual({ coverageRetries: 1 });
  });
});

describe("workflow.review CLI descriptions (AC-14)", () => {
  test.each(["workflow.review", "workflow.review.coverageRetries"])(
    "AC-14: %s has a non-empty description",
    (key) => {
      expect(FIELD_DESCRIPTIONS[key]).toBeString();
      expect(FIELD_DESCRIPTIONS[key].trim().length).toBeGreaterThan(0);
    },
  );
});
