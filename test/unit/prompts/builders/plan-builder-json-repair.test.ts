/**
 * Unit tests for PlanPromptBuilder.jsonRepair()
 *
 * Verifies the static jsonRepair method produces a repair prompt that:
 * - Contains the word "JSON"
 * - Includes the parseError string passed as argument
 * - Is non-empty
 */

import { describe, expect, test } from "bun:test";
import { PlanPromptBuilder } from "@/prompts";

describe("PlanPromptBuilder.jsonRepair()", () => {
  test("static method exists and returns a string", () => {
    const result = PlanPromptBuilder.jsonRepair(0, "Invalid JSON");
    expect(typeof result).toBe("string");
  });

  test("returns non-empty string", () => {
    const result = PlanPromptBuilder.jsonRepair(0, "Invalid JSON");
    expect(result.length).toBeGreaterThan(0);
  });

  test("output contains the word JSON", () => {
    const result = PlanPromptBuilder.jsonRepair(0, "Invalid JSON");
    expect(result).toContain("JSON");
  });

  test("output includes the parseError string passed as argument", () => {
    const parseError = "JSON parse error: expected { at position 42";
    const result = PlanPromptBuilder.jsonRepair(0, parseError);
    expect(result).toContain(parseError);
  });

  test("output includes parseError with special characters", () => {
    const parseError = "Unexpected token } at line 5, column 12 — expected ]";
    const result = PlanPromptBuilder.jsonRepair(1, parseError);
    expect(result).toContain(parseError);
  });

  test("output includes parseError with empty string (should still work)", () => {
    const result = PlanPromptBuilder.jsonRepair(0, "");
    expect(result).toContain("JSON");
  });

  test("with different attempt numbers", () => {
    const error = "test error";
    const result0 = PlanPromptBuilder.jsonRepair(0, error);
    const result1 = PlanPromptBuilder.jsonRepair(1, error);
    const result2 = PlanPromptBuilder.jsonRepair(2, error);

    // All should contain the error
    expect(result0).toContain(error);
    expect(result1).toContain(error);
    expect(result2).toContain(error);

    // All should contain JSON
    expect(result0).toContain("JSON");
    expect(result1).toContain("JSON");
    expect(result2).toContain("JSON");
  });

  test("can be used in a prompt template", () => {
    const repair = PlanPromptBuilder.jsonRepair(0, "Trailing comma at line 20");
    expect(repair.length).toBeGreaterThan(50); // Long enough to be a real prompt
    expect(repair).toContain("complete PRD JSON");
  });
});
