import { describe, expect, test } from "bun:test";
import { resolveAgentAssignment } from "@/agents";
import type { AgentRoutingConfig } from "@/config";

const routing: AgentRoutingConfig = {
  enabled: true,
  strategy: "off",
  default: "opencode-structural",
  profiles: [
    { id: "opencode-structural", target: { agent: "opencode", model: "fast" }, strengths: ["mechanical"] },
    { id: "claude-final", target: { agent: "claude", model: "balanced" }, strengths: ["design"] },
  ],
};

describe("resolveAgentAssignment", () => {
  test("resolves a known profile id to its target agent + tier", () => {
    expect(resolveAgentAssignment("claude-final", routing, "US-001")).toEqual({
      agent: "claude",
      agentProfileId: "claude-final",
      profileModelTier: "balanced",
    });
  });

  test("falls back to the default profile for an unknown id (never invents an agent)", () => {
    expect(resolveAgentAssignment("does-not-exist", routing, "US-001")).toEqual({
      agent: "opencode",
      agentProfileId: "opencode-structural",
      profileModelTier: "fast",
    });
  });

  test("falls back to the default profile when no id is selected", () => {
    expect(resolveAgentAssignment(undefined, routing, "US-001")).toEqual({
      agent: "opencode",
      agentProfileId: "opencode-structural",
      profileModelTier: "fast",
    });
  });

  test("returns null when routing is disabled", () => {
    expect(resolveAgentAssignment("claude-final", { ...routing, enabled: false }, "US-001")).toBeNull();
  });

  test("returns null when no profiles exist", () => {
    expect(resolveAgentAssignment("x", { ...routing, profiles: [], default: undefined }, "US-001")).toBeNull();
  });

  test("returns null for unknown id when no default is configured", () => {
    expect(resolveAgentAssignment("x", { ...routing, default: undefined }, "US-001")).toBeNull();
  });

  test("returns null for undefined agentRouting", () => {
    expect(resolveAgentAssignment("claude-final", undefined, "US-001")).toBeNull();
  });
});
