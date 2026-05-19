/**
 * Unit tests for `isAmbiguousOutput` — pure helper exported from
 * src/pipeline/stages/execution-helpers.ts. The previous integration-style
 * coverage in `execution-ambiguity.test.ts` was retired with the US-004
 * dispatch refactor; the trigger-wiring side (interaction chain) is covered
 * by `interaction/triggers.ts` tests. This file pins the keyword-matching
 * contract directly.
 */

import { describe, expect, test } from "bun:test";
import { isAmbiguousOutput } from "../../../../src/pipeline/stages/execution-helpers";

describe("isAmbiguousOutput", () => {
  test("returns false for empty output", () => {
    expect(isAmbiguousOutput("")).toBe(false);
  });

  test("returns false for clear output with no ambiguity signals", () => {
    expect(isAmbiguousOutput("Done. Wrote 12 tests and all passed.")).toBe(false);
  });

  test.each([
    "The requirement is unclear — should it support negative numbers?",
    "This is ambiguous between two interpretations.",
    "I need clarification on the expected error message.",
    "Please clarify whether retries should be exponential or linear.",
    "Which one of these endpoints should I update?",
    "Not sure which method is the canonical entry point.",
  ])("returns true for ambiguity keyword: %s", (output) => {
    expect(isAmbiguousOutput(output)).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(isAmbiguousOutput("THIS IS AMBIGUOUS")).toBe(true);
    expect(isAmbiguousOutput("Please Clarify the spec")).toBe(true);
  });
});
