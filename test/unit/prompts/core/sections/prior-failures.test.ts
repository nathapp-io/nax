/**
 * Tests for priorFailuresSection() in src/prompts/core/sections/prior-failures.ts
 *
 * This section is reserved for use by AcceptancePromptBuilder (Phase 4, unused)
 * and RectifierPromptBuilder (Phase 5).
 */

import { describe, expect, test } from "bun:test";
import { priorFailuresSection } from "../../../../../src/prompts/core/sections/prior-failures";

describe("priorFailuresSection()", () => {
  test("returns null when failures array is empty", () => {
    expect(priorFailuresSection([])).toBeNull();
  });

  test("returns a PromptSection with id 'prior-failures' for non-empty input", () => {
    const result = priorFailuresSection([{ message: "assertion failed" }]);
    expect(result).not.toBeNull();
    expect(result?.id).toBe("prior-failures");
    expect(result?.overridable).toBe(false);
  });

  test("includes the failure message in content", () => {
    const result = priorFailuresSection([{ message: "null pointer exception" }]);
    expect(result?.content).toContain("null pointer exception");
  });

  test("includes PRIOR FAILURES header", () => {
    const result = priorFailuresSection([{ message: "x" }]);
    expect(result?.content).toContain("# PRIOR FAILURES");
  });

  test("numbers multiple failures sequentially", () => {
    const result = priorFailuresSection([{ message: "first" }, { message: "second" }]);
    expect(result?.content).toContain("## Failure 1");
    expect(result?.content).toContain("## Failure 2");
  });

  test("includes test name in heading when provided", () => {
    const result = priorFailuresSection([{ test: "AC-1: handles empty input", message: "x" }]);
    expect(result?.content).toContain("## Failure 1 — AC-1: handles empty input");
  });

  test("includes file path when provided", () => {
    const result = priorFailuresSection([{ file: "src/foo.ts", message: "x" }]);
    expect(result?.content).toContain("File: src/foo.ts");
  });

  test("includes output in fenced code block when provided", () => {
    const result = priorFailuresSection([{ message: "x", output: "stderr: panic" }]);
    expect(result?.content).toContain("```\nstderr: panic\n```");
  });

  test("omits file line when file is not provided", () => {
    const result = priorFailuresSection([{ message: "x" }]);
    expect(result?.content).not.toContain("File:");
  });
});
