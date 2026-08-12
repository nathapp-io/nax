import { describe, expect, test } from "bun:test";
import { classifyProviderRefusalFailure } from "@/agents/retry";

describe("classifyProviderRefusalFailure", () => {
  test("classifies the measured capacity-refusal literal as a retriable availability failure", () => {
    const failure = classifyProviderRefusalFailure("Selected model is at capacity. Please try a different model.");
    expect(failure).toEqual({
      category: "availability",
      outcome: "fail-rate-limit",
      retriable: true,
      message: "Selected model is at capacity. Please try a different model.",
    });
  });

  test("matches case-insensitively and trims surrounding whitespace", () => {
    const failure = classifyProviderRefusalFailure("  the SELECTED MODEL IS AT CAPACITY right now  ");
    expect(failure).not.toBeNull();
    expect(failure?.outcome).toBe("fail-rate-limit");
    expect(failure?.message).toBe("the SELECTED MODEL IS AT CAPACITY right now");
  });

  test("returns null for empty or whitespace-only output", () => {
    expect(classifyProviderRefusalFailure("")).toBeNull();
    expect(classifyProviderRefusalFailure("   ")).toBeNull();
  });

  test("returns null for a genuine review verdict", () => {
    const verdict = JSON.stringify({ passed: true, findings: [] });
    expect(classifyProviderRefusalFailure(verdict)).toBeNull();
  });

  test("returns null for unparseable prose that isn't a provider refusal", () => {
    expect(classifyProviderRefusalFailure("I reviewed the diff but couldn't reach a conclusion.")).toBeNull();
  });

  test("truncates an overlong message to 500 chars", () => {
    const long = `model is at capacity ${"x".repeat(600)}`;
    const failure = classifyProviderRefusalFailure(long);
    expect(failure?.message.length).toBe(500);
  });
});
