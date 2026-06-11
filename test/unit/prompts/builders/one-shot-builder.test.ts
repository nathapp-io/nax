import { describe, expect, it } from "bun:test";
import type { AgentRoutingProfile } from "@/config";
import { OneShotPromptBuilder } from "@/prompts";

describe("agentProfileInstruction", () => {
  it("returns a non-empty string", () => {
    const result = OneShotPromptBuilder.agentProfileInstruction();
    expect(result.length).toBeGreaterThan(0);
  });

  it("contains 'agentProfileId' so the LLM knows the field name", () => {
    const result = OneShotPromptBuilder.agentProfileInstruction();
    expect(result).toContain("agentProfileId");
  });
});

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

  it("escapes pipe characters in cell values to preserve markdown table structure", () => {
    const profiles: AgentRoutingProfile[] = [
      {
        id: "pipe|profile",
        target: { agent: "claude|2", model: "fast|balanced" },
        strengths: ["strength|a", "strength|b"],
        costTier: "low|med",
      },
    ];

    const result = OneShotPromptBuilder.agentCapabilityCards(profiles);

    expect(result).toContain("pipe\\|profile");
    expect(result).toContain("claude\\|2");
    expect(result).toContain("fast\\|balanced");
    expect(result).toContain("strength\\|a, strength\\|b");
    expect(result).toContain("low\\|med");
    // The row must not contain unescaped pipes beyond the column delimiters
    const rows = result.split("\n").filter((l: string) => l.startsWith("| pipe"));
    expect(rows).toHaveLength(1);
    // A well-formed row has exactly 6 unescaped pipe chars (column delimiters)
    const unescapedPipes = (rows[0]!.match(/(?<!\\)\|/g) ?? []).length;
    expect(unescapedPipes).toBe(6);
  });

  it("neutralizes newlines in cell values to prevent broken table rows", () => {
    const profiles: AgentRoutingProfile[] = [
      {
        id: "newline-profile",
        target: { agent: "claude", model: "fast" },
        strengths: ["handles\nmulti-line\nstrengths", "also\r\nwindows"],
        costTier: "low",
      },
    ];

    const result = OneShotPromptBuilder.agentCapabilityCards(profiles);

    // Each row must be a single line — no embedded newlines
    const rows = result.split("\n").filter((l: string) => l.startsWith("| newline-profile"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toContain("\n");
    expect(rows[0]).not.toContain("\r");
    // Newlines replaced with spaces
    expect(rows[0]).toContain("handles multi-line strengths");
    expect(rows[0]).toContain("also windows");
  });
});
