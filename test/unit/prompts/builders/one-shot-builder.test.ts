import { describe, expect, it } from "bun:test";
import type { AgentRoutingProfile } from "@/config";
import { OneShotPromptBuilder } from "@/prompts";

describe("agentCapabilityCards", () => {
  it("returns empty string for empty profiles array", () => {
    expect(OneShotPromptBuilder.agentCapabilityCards([])).toBe("");
  });

  it("renders a single profile with costTier", () => {
    const profiles: AgentRoutingProfile[] = [
      {
        id: "profile-a",
        target: { agent: "claude", model: "balanced" },
        strengths: ["fast", "reliable"],
        costTier: "low",
      },
    ];

    const result = OneShotPromptBuilder.agentCapabilityCards(profiles);

    expect(result).toContain("## Agent Profiles");
    expect(result).toContain("| ID | Agent | Tier | Strengths | Cost |");
    expect(result).toContain("| profile-a | claude | balanced | fast, reliable | low |");
  });

  it("renders '—' in cost column when costTier is absent", () => {
    const profiles: AgentRoutingProfile[] = [
      {
        id: "profile-b",
        target: { agent: "claude", model: "fast" },
        strengths: ["cheap"],
      },
    ];

    const result = OneShotPromptBuilder.agentCapabilityCards(profiles);

    expect(result).toContain("| profile-b | claude | fast | cheap | — |");
  });

  it("renders all rows for multiple profiles", () => {
    const profiles: AgentRoutingProfile[] = [
      {
        id: "alpha",
        target: { agent: "claude", model: "fast" },
        strengths: ["speed"],
        costTier: "low",
      },
      {
        id: "beta",
        target: { agent: "claude", model: "powerful" },
        strengths: ["reasoning", "accuracy"],
        costTier: "high",
      },
    ];

    const result = OneShotPromptBuilder.agentCapabilityCards(profiles);

    expect(result).toContain("| alpha | claude | fast | speed | low |");
    expect(result).toContain("| beta | claude | powerful | reasoning, accuracy | high |");
  });
});
