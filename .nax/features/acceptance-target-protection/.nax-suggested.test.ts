import { describe, expect, test } from "bun:test";

describe("acceptance-target-protection", () => {
  test("AC-1: buildNaxArtifactsSection('verifier') returns a non-empty string containing '.nax'", async () => {
    const { buildNaxArtifactsSection } = await import("../../../src/prompts/sections");
    const result = buildNaxArtifactsSection("verifier");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain(".nax");
  });
});