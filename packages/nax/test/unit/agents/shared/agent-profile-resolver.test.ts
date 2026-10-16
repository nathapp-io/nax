import { describe, expect, test } from "bun:test";
import { resolveAgentAssignment } from "@/agents";
import type { AgentRoutingConfig, ModelsConfig } from "@/config";
import { addSink, initLogger, resetLogger } from "@/logger";

const models: ModelsConfig = {
  native: { cheap: "nax-ai-cheap" },
  opencode: { fast: "oc-fast" },
  claude: {
    fast: "claude-haiku-4-5",
    balanced: "claude-sonnet-4-5",
    powerful: "claude-opus-4-5",
  },
};

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
    expect(resolveAgentAssignment("claude-final", routing, "US-001", models, "claude")).toEqual({
      agent: "claude",
      agentProfileId: "claude-final",
      profileModelTier: "balanced",
    });
  });

  test("falls back to the default profile for an unknown id (never invents an agent)", () => {
    expect(resolveAgentAssignment("does-not-exist", routing, "US-001", models, "claude")).toEqual({
      agent: "opencode",
      agentProfileId: "opencode-structural",
      profileModelTier: "fast",
    });
  });

  test("falls back to the default profile when no id is selected", () => {
    expect(resolveAgentAssignment(undefined, routing, "US-001", models, "claude")).toEqual({
      agent: "opencode",
      agentProfileId: "opencode-structural",
      profileModelTier: "fast",
    });
  });

  test("returns null when routing is disabled", () => {
    expect(
      resolveAgentAssignment("claude-final", { ...routing, enabled: false }, "US-001", models, "claude"),
    ).toBeNull();
  });

  test("returns null when no profiles exist", () => {
    expect(
      resolveAgentAssignment("x", { ...routing, profiles: [], default: undefined }, "US-001", models, "claude"),
    ).toBeNull();
  });

  test("returns null for unknown id when no default is configured", () => {
    expect(resolveAgentAssignment("x", { ...routing, default: undefined }, "US-001", models, "claude")).toBeNull();
  });

  test("returns null for undefined agentRouting", () => {
    expect(resolveAgentAssignment("claude-final", undefined, "US-001", models, "claude")).toBeNull();
  });

  test("tier target sets profileModelTier, no pin (spec §4)", () => {
    const pinRouting: AgentRoutingConfig = {
      enabled: true,
      strategy: "off",
      default: undefined,
      profiles: [{ id: "p1", target: { agent: "native", model: "cheap" }, strengths: ["speed"] }],
    };
    const a = resolveAgentAssignment("p1", pinRouting, "US-001", models, "claude");
    expect(a).toEqual({ agent: "native", agentProfileId: "p1", profileModelTier: "cheap" });
  });

  test("a shorthand target is a model pin, not a tier (nax#2571)", () => {
    const shorthandRouting: AgentRoutingConfig = {
      enabled: true,
      strategy: "off",
      default: undefined,
      profiles: [{ id: "p1", target: { agent: "claude", model: "sonnet" }, strengths: ["quality"] }],
    };

    expect(resolveAgentAssignment("p1", shorthandRouting, "US-001", models, "claude")).toEqual({
      agent: "claude",
      agentProfileId: "p1",
      profileModelPin: "sonnet",
    });
  });

  test("literal target sets profileModelPin, no tier (spec §4)", () => {
    const pinRouting: AgentRoutingConfig = {
      enabled: true,
      strategy: "off",
      default: undefined,
      profiles: [{ id: "p1", target: { agent: "claude", model: "claude-opus-5-1" }, strengths: ["quality"] }],
    };
    const a = resolveAgentAssignment("p1", pinRouting, "US-001", models, "claude");
    expect(a).toEqual({ agent: "claude", agentProfileId: "p1", profileModelPin: "claude-opus-5-1" });
  });
});

describe("resolveAgentAssignment: shorthand names and effort suffixes (nax#2571)", () => {
  const shorthandModels: ModelsConfig = {
    claude: { fast: "haiku", balanced: "sonnet[medium]", powerful: "sonnet[medium]" },
    opencode: { fast: "oc-fast", powerful: "oc-powerful" },
  };
  const routingTo = (target: { agent: string; model: string }): AgentRoutingConfig => ({
    enabled: true,
    strategy: "off",
    default: "p",
    profiles: [{ id: "p", target, strengths: ["impl"] }],
  });

  test("a claude opus target is a model pin, not the powerful tier", () => {
    expect(
      resolveAgentAssignment("p", routingTo({ agent: "claude", model: "opus" }), "US-001", shorthandModels, "claude"),
    ).toEqual({ agent: "claude", agentProfileId: "p", profileModelPin: "opus" });
  });

  test("an opencode opus target is a model pin, not the opencode powerful tier", () => {
    expect(
      resolveAgentAssignment("p", routingTo({ agent: "opencode", model: "opus" }), "US-001", shorthandModels, "claude"),
    ).toEqual({ agent: "opencode", agentProfileId: "p", profileModelPin: "opus" });
  });

  test("a suffixed tier name is still that tier, and the dropped effort is reported", () => {
    const messages: string[] = [];
    resetLogger();
    initLogger({ level: "warn" });
    const removeSink = addSink((entry) => {
      if (entry.level === "warn") messages.push(entry.message);
    });
    try {
      expect(
        resolveAgentAssignment(
          "p",
          routingTo({ agent: "opencode", model: "fast[high]" }),
          "US-001",
          shorthandModels,
          "claude",
        ),
      ).toEqual({ agent: "opencode", agentProfileId: "p", profileModelTier: "fast" });
    } finally {
      removeSink();
      resetLogger();
    }
    expect(messages).toContain(
      "Profile target effort suffix is ignored: a profile assigns a tier rung, which carries no effort",
    );
  });
});
