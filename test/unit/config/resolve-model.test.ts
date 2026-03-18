/**
 * Tests for resolveModel() alias resolution
 *
 * Covers:
 * - Known aliases (sonnet, haiku, opus) map to real model IDs
 * - Real model IDs pass through unchanged
 * - Case-insensitive alias matching
 * - Provider is inferred correctly after alias resolution
 */

import { describe, expect, test } from "bun:test";
import { resolveModel } from "../../../src/config/schema-types";

describe("resolveModel alias resolution", () => {
  test("'sonnet' alias resolves to a real claude model ID", () => {
    const result = resolveModel("sonnet");
    expect(result.model).not.toBe("sonnet");
    expect(result.model).toMatch(/^claude-/);
    expect(result.provider).toBe("anthropic");
  });

  test("'haiku' alias resolves to a real claude model ID", () => {
    const result = resolveModel("haiku");
    expect(result.model).not.toBe("haiku");
    expect(result.model).toMatch(/^claude-/);
    expect(result.provider).toBe("anthropic");
  });

  test("'opus' alias resolves to a real claude model ID", () => {
    const result = resolveModel("opus");
    expect(result.model).not.toBe("opus");
    expect(result.model).toMatch(/^claude-/);
    expect(result.provider).toBe("anthropic");
  });

  test("real model ID passes through unchanged", () => {
    const result = resolveModel("claude-sonnet-4-5");
    expect(result.model).toBe("claude-sonnet-4-5");
    expect(result.provider).toBe("anthropic");
  });

  test("full model object passes through unchanged", () => {
    const def = { provider: "anthropic", model: "claude-opus-4-5" };
    const result = resolveModel(def);
    expect(result).toBe(def);
  });

  test("alias matching is case-insensitive", () => {
    const lower = resolveModel("sonnet");
    const upper = resolveModel("SONNET");
    const mixed = resolveModel("Sonnet");
    expect(lower.model).toBe(upper.model);
    expect(lower.model).toBe(mixed.model);
  });

  test("unknown string passes through (not silently dropped)", () => {
    const result = resolveModel("my-custom-model");
    expect(result.model).toBe("my-custom-model");
  });

  test("gpt-4o passes through with openai provider", () => {
    const result = resolveModel("gpt-4o");
    expect(result.model).toBe("gpt-4o");
    expect(result.provider).toBe("openai");
  });
});
