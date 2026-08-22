import { describe, expect, test } from "bun:test";
import { AgentRoutingConfigSchema, AgentRoutingProfileSchema, NaxConfigSchema } from "@/config";
import { InteractionConfigSchema } from "@/config/schemas-infra";

describe("AgentRoutingProfileSchema", () => {
  test("parses a minimal valid profile", () => {
    const result = AgentRoutingProfileSchema.parse({
      id: "claude-powerful",
      target: { agent: "claude", model: "powerful" },
      strengths: ["architecture"],
    });
    expect(result.id).toBe("claude-powerful");
    expect(result.target.agent).toBe("claude");
    expect(result.weaknesses).toBeUndefined();
  });

  test("parses a full profile", () => {
    const result = AgentRoutingProfileSchema.parse({
      id: "opencode-balanced",
      target: { agent: "opencode", model: "balanced" },
      strengths: ["general implementation", "frontend"],
      weaknesses: ["complex refactors"],
      costTier: "low",
      affinity: { taskTypes: ["feature"], domains: ["react"] },
    });
    expect(result.costTier).toBe("low");
    expect(result.affinity?.domains).toEqual(["react"]);
  });

  test("rejects empty id", () => {
    expect(() =>
      AgentRoutingProfileSchema.parse({
        id: "",
        target: { agent: "claude", model: "balanced" },
        strengths: ["x"],
      }),
    ).toThrow();
  });

  test("rejects empty strengths array", () => {
    expect(() =>
      AgentRoutingProfileSchema.parse({
        id: "x",
        target: { agent: "claude", model: "balanced" },
        strengths: [],
      }),
    ).toThrow();
  });
});

describe("AgentRoutingConfigSchema", () => {
  test("defaults to enabled=true, strategy=off, empty profiles", () => {
    const result = AgentRoutingConfigSchema.parse({});
    expect(result.enabled).toBe(true);
    expect(result.strategy).toBe("off");
    expect(result.profiles).toEqual([]);
  });

  test("accepts enabled=false to disable routing even with profiles", () => {
    const result = AgentRoutingConfigSchema.parse({
      enabled: false,
      profiles: [{ id: "claude-powerful", target: { agent: "claude", model: "powerful" }, strengths: ["arch"] }],
    });
    expect(result.enabled).toBe(false);
    expect(result.profiles).toHaveLength(1);
  });

  test("rejects duplicate profile ids", () => {
    expect(() =>
      AgentRoutingConfigSchema.parse({
        profiles: [
          { id: "dup", target: { agent: "claude", model: "balanced" }, strengths: ["x"] },
          { id: "dup", target: { agent: "opencode", model: "balanced" }, strengths: ["y"] },
        ],
      }),
    ).toThrow(/duplicate/i);
  });

  test("rejects unknown default profile id", () => {
    expect(() =>
      AgentRoutingConfigSchema.parse({
        default: "nonexistent",
        profiles: [{ id: "real-profile", target: { agent: "claude", model: "balanced" }, strengths: ["x"] }],
      }),
    ).toThrow(/default/i);
  });

  test('strategy "llm" with zero profiles is rejected', () => {
    const result = AgentRoutingConfigSchema.safeParse({ enabled: true, strategy: "llm", profiles: [] });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some((i: { message: string }) => i.message.includes("requires at least one profile")),
    ).toBe(true);
  });

  test('strategy "off" with zero profiles still parses (v1 default)', () => {
    const result = AgentRoutingConfigSchema.safeParse({ enabled: true, strategy: "off", profiles: [] });
    expect(result.success).toBe(true);
  });
});

describe("InteractionConfigSchema — per-trigger fallback/timeout (SEC-3, BUG-44)", () => {
  const trigger = (overrides: Record<string, unknown>) =>
    InteractionConfigSchema.safeParse({
      plugin: "cli",
      defaults: { timeout: 600000 },
      triggers: { "security-review": { enabled: true, ...overrides } },
    });

  test("rejects an unrecognized per-trigger fallback string instead of casting it through", () => {
    const result = trigger({ fallback: "abrt" });
    expect(result.success).toBe(false);
  });

  test("accepts each of the four canonical fallback values", () => {
    for (const value of ["continue", "skip", "escalate", "abort"]) {
      expect(trigger({ fallback: value }).success).toBe(true);
    }
  });

  test("rejects a negative or fractional per-trigger timeout (BUG-44)", () => {
    expect(trigger({ timeout: -1 }).success).toBe(false);
    expect(trigger({ timeout: 0.5 }).success).toBe(false);
    expect(trigger({ timeout: 0 }).success).toBe(false);
  });

  test("accepts a positive integer per-trigger timeout", () => {
    expect(trigger({ timeout: 5000 }).success).toBe(true);
  });

  // BUG-48 (D-9): a schema-level default here would be indistinguishable from
  // an explicit operator choice — see the matching comment in schemas-infra.ts.
  test("interaction.defaults.fallback has no baked-in schema default", () => {
    const result = InteractionConfigSchema.safeParse({ plugin: "cli", defaults: { timeout: 600000 }, triggers: {} });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.defaults.fallback).toBeUndefined();
  });

  test("a fully empty NaxConfig parse does not bake interaction.defaults.fallback either", () => {
    const parsed = NaxConfigSchema.parse({});
    expect(parsed.interaction.defaults.fallback).toBeUndefined();
  });
});
