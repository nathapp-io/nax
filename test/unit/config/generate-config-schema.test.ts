/**
 * Tests for generate config schema — ensures config.generate.agents
 * survives NaxConfigSchema.safeParse (BUG: was stripped by Zod because
 * GenerateConfigSchema was missing from NaxConfigSchema).
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { NaxConfigSchema } from "../../../src/config/schemas";

const BASE = DEFAULT_CONFIG as Record<string, unknown>;

describe("GenerateConfigSchema — config.generate.agents", () => {
  test("generate.agents survives safeParse with valid agent list", () => {
    const raw = {
      ...BASE,
      generate: { agents: ["claude", "opencode"] },
    };
    const result = NaxConfigSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.generate?.agents).toEqual(["claude", "opencode"]);
  });

  test("generate.agents with all valid agent types", () => {
    const allAgents = ["claude", "codex", "opencode", "cursor", "windsurf", "aider", "gemini"] as const;
    const raw = { ...BASE, generate: { agents: allAgents } };
    const result = NaxConfigSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.generate?.agents).toEqual(allAgents);
  });

  test("generate absent → config.generate is undefined", () => {
    const raw = { ...BASE };
    const result = NaxConfigSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.generate).toBeUndefined();
  });

  test("generate with no agents field → agents is undefined", () => {
    const raw = { ...BASE, generate: {} };
    const result = NaxConfigSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.generate?.agents).toBeUndefined();
  });

  test("generate.agents with invalid agent name → parse fails", () => {
    const raw = { ...BASE, generate: { agents: ["claude", "unknownagent"] } };
    const result = NaxConfigSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  test("generate.agents empty array is valid", () => {
    const raw = { ...BASE, generate: { agents: [] } };
    const result = NaxConfigSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.generate?.agents).toEqual([]);
  });
});
