import { describe, expect, test } from "bun:test";
import type { AgentRoutingProfile } from "@/config";
import { PlanPromptBuilder } from "@/prompts";

const profiles: AgentRoutingProfile[] = [
  {
    id: "opencode-structural",
    target: { agent: "opencode", model: "fast" },
    strengths: ["mechanical edits"],
  },
  {
    id: "claude-final",
    target: { agent: "claude", model: "balanced" },
    strengths: ["design work"],
  },
];

describe("PlanPromptBuilder agent profiles", () => {
  test("build(): injects capability cards and an agentProfileId schema field when profiles exist", () => {
    const { taskContext, outputFormat } = new PlanPromptBuilder().build(
      "spec",
      "context",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      profiles,
    );
    expect(taskContext).toContain("## Agent Profiles");
    expect(taskContext).toContain("opencode-structural");
    expect(outputFormat).toContain("agentProfileId");
  });

  test("build(): omits cards and the schema field when no profiles", () => {
    const { taskContext, outputFormat } = new PlanPromptBuilder().build("spec", "context");
    expect(taskContext).not.toContain("## Agent Profiles");
    expect(outputFormat).not.toContain("agentProfileId");
  });

  test("buildDraft(): injects cards + agentProfileId schema field when profiles exist", () => {
    const { task } = new PlanPromptBuilder().buildDraft({
      feature: "f",
      branchName: "feat/f",
      specContent: "spec",
      codebaseContext: "context",
      manifestSection: "manifest",
      citationThreshold: 0.5,
      profiles,
    });
    expect(task.content).toContain("## Agent Profiles");
    expect(task.content).toContain("agentProfileId");
  });
});
