/**
 * Tests for src/prompts/builders/patch-builder.ts
 */

import { describe, expect, test } from "bun:test";
import { PatchPromptBuilder } from "@/prompts";

describe("PatchPromptBuilder", () => {
  test("builds a prompt with winner output", () => {
    const builder = new PatchPromptBuilder();
    const prompt = builder.build("Original proposal text", ["AC1", "AC2"]);

    expect(prompt).toContain("Original proposal text");
  });

  test("includes runner-up criteria in prompt", () => {
    const builder = new PatchPromptBuilder();
    const deltas = ["Add validation", "Improve error handling"];
    const prompt = builder.build("Original proposal", deltas);

    expect(prompt).toContain("Add validation");
    expect(prompt).toContain("Improve error handling");
  });

  test("includes maxDeltas count in prompt", () => {
    const builder = new PatchPromptBuilder();
    const deltas = ["Delta1", "Delta2", "Delta3"];
    const prompt = builder.build("Original proposal", deltas);

    expect(prompt).toContain("3");
  });

  test("formats deltas as numbered list", () => {
    const builder = new PatchPromptBuilder();
    const deltas = ["First delta", "Second delta"];
    const prompt = builder.build("Original", deltas);

    expect(prompt).toContain("1. First delta");
    expect(prompt).toContain("2. Second delta");
  });

  test("returns non-empty string", () => {
    const builder = new PatchPromptBuilder();
    const prompt = builder.build("Proposal", ["AC1"]);

    expect(prompt).toBeTruthy();
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("handles empty deltas array", () => {
    const builder = new PatchPromptBuilder();
    const prompt = builder.build("Proposal", []);

    expect(prompt).toContain("Proposal");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("handles multiline winner output", () => {
    const builder = new PatchPromptBuilder();
    const multilineOutput = `First line
Second line
Third line`;
    const prompt = builder.build(multilineOutput, ["Delta1"]);

    expect(prompt).toContain(multilineOutput);
  });
});
