import { describe, expect, it } from "bun:test";
import { assertDefined } from "@test/helpers";
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
    expect(result).toContain("| ID | Agent | Tier | Strengths | Weaknesses | Affinity | Cost |");
    expect(result).toContain("| profile-a | claude | balanced | fast, reliable | — | — | low |");
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

    expect(result).toContain("| profile-b | claude | fast | cheap | — | — | — |");
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

    expect(result).toContain("| alpha | claude | fast | speed | — | — | low |");
    expect(result).toContain("| beta | claude | powerful | reasoning, accuracy | — | — | high |");
  });

  it("escapes pipe characters in cell values to preserve markdown table structure", () => {
    const profiles: AgentRoutingProfile[] = [
      {
        id: "pipe|profile",
        target: { agent: "claude|2", model: "fast|balanced" },
        strengths: ["strength|a", "strength|b"],
        costTier: "low",
      },
    ];

    const result = OneShotPromptBuilder.agentCapabilityCards(profiles);

    expect(result).toContain("pipe\\|profile");
    expect(result).toContain("claude\\|2");
    expect(result).toContain("fast\\|balanced");
    expect(result).toContain("strength\\|a, strength\\|b");
    expect(result).toContain("low");
    // The row must not contain unescaped pipes beyond the column delimiters
    const rows = result.split("\n").filter((l: string) => l.startsWith("| pipe"));
    expect(rows).toHaveLength(1);
    const firstRow = rows[0];
    assertDefined(firstRow, "rows[0]");
    // A well-formed row has exactly 8 unescaped pipe chars (column delimiters for 7 columns)
    const unescapedPipes = (firstRow.match(/(?<!\\)\|/g) ?? []).length;
    expect(unescapedPipes).toBe(8);
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

describe("agentCapabilityCards — weaknesses and affinity", () => {
  const profile: AgentRoutingProfile = {
    id: "oc-fast",
    target: { agent: "opencode", model: "fast" as const },
    strengths: ["general implementation"],
    weaknesses: ["complex refactors", "TS generics"],
    affinity: { taskTypes: ["crud"], domains: ["backend"] },
    costTier: "low" as const,
  };

  it("renders weaknesses in the card row", () => {
    const cards = OneShotPromptBuilder.agentCapabilityCards([profile]);
    expect(cards).toContain("Weaknesses");
    expect(cards).toContain("complex refactors; TS generics");
  });

  it("renders affinity taskTypes and domains in the card row", () => {
    const cards = OneShotPromptBuilder.agentCapabilityCards([profile]);
    expect(cards).toContain("Affinity");
    expect(cards).toContain("crud, backend");
  });

  it("renders em-dash placeholders when weaknesses/affinity are absent", () => {
    const bare: AgentRoutingProfile = {
      id: "p1",
      target: { agent: "claude", model: "powerful" as const },
      strengths: ["arch"],
    };
    const cards = OneShotPromptBuilder.agentCapabilityCards([bare]);
    const row = cards.split("\n").find((l: string) => l.startsWith("| p1 |"));
    expect(row).toBeDefined();
    expect(row).toContain("| — | — |");
  });
});

describe("agentProfileInstruction — ordered rubric", () => {
  it("carries the ordered elimination procedure", () => {
    const text = OneShotPromptBuilder.agentProfileInstruction();
    expect(text).toContain("1. Eliminate any profile whose weaknesses conflict");
    expect(text).toContain("LOWEST cost");
    expect(text).toContain("omit `agentProfileId`");
    expect(text).toContain("never invent");
  });
});
