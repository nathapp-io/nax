import { describe, expect, test } from "bun:test";

describe("AC-ERROR: plan refine continuation prompt validity", () => {
  test("buildRefineContinuation does not include JSON code fences", async () => {
    const { PlanPromptBuilder } = await import("../../../src/prompts/builders/plan-builder");
    const prompt = new PlanPromptBuilder().buildRefineContinuation("/path/to/prd.json");
    expect(prompt).not.toContain("```json");
  });
});
