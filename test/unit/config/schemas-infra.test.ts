import { describe, expect, test } from "bun:test";
import { AgentProfileSchema, AgentRoutingConfigSchema } from "@/config";

describe("AgentProfileSchema", () => {
  test("parses a minimal valid profile", () => {
    const result = AgentProfileSchema.parse({
      id: "claude-powerful",
      target: { agent: "claude", model: "powerful" },
      strengths: ["architecture"],
    });
    expect(result.id).toBe("claude-powerful");
    expect(result.target.agent).toBe("claude");
    expect(result.weaknesses).toBeUndefined();
  });

  test("parses a full profile", () => {
    const result = AgentProfileSchema.parse({
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
      AgentProfileSchema.parse({
        id: "",
        target: { agent: "claude", model: "balanced" },
        strengths: ["x"],
      }),
    ).toThrow();
  });

  test("rejects empty strengths array", () => {
    expect(() =>
      AgentProfileSchema.parse({
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
      profiles: [
        { id: "claude-powerful", target: { agent: "claude", model: "powerful" }, strengths: ["arch"] },
      ],
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
        profiles: [
          { id: "real-profile", target: { agent: "claude", model: "balanced" }, strengths: ["x"] },
        ],
      }),
    ).toThrow(/default/i);
  });
});
