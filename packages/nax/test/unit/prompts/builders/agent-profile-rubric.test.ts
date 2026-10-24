import { describe, expect, test } from "bun:test";
import { makeStory } from "@test/helpers";
import type { AgentRoutingProfile } from "@/config";
import { buildDecomposePromptSync, OneShotPromptBuilder, PlanPromptBuilder } from "@/prompts";

const COMPLEXITY_STEP =
  "3. If the story's complexity is `simple` or `medium`, also keep every profile step 1 did not eliminate whose Cost is lower than the Cost of every profile step 2 kept (low < medium < high), even when its affinity does not list the story's task type or domain. If step 2 kept none, keep the lowest-Cost profiles step 1 did not eliminate. Profiles whose Cost is — are ignored by this step, both as candidates and in the comparison.";
const PROFILE: AgentRoutingProfile = {
  id: "a",
  target: { agent: "claude", model: "balanced" },
  strengths: ["implementation"],
  costTier: "low",
};

function steps(): string[] {
  return OneShotPromptBuilder.agentProfileInstruction()
    .split("\n")
    .filter((line) => /^\d\./.test(line));
}

describe("OneShotPromptBuilder.agentProfileInstruction", () => {
  test("AC-1: returns exactly five ordered steps", () => {
    expect(steps().map((line) => line.slice(0, 2))).toEqual(["1.", "2.", "3.", "4.", "5."]);
  });
  test("AC-2: simple and medium admit strictly cheaper non-eliminated profiles despite affinity", () => {
    expect(steps()[2]).toBe(COMPLEXITY_STEP);
  });
  test.each([
    ["AC-3", "low < medium < high"],
    ["AC-4", "If step 2 kept none, keep the lowest-Cost profiles step 1 did not eliminate."],
    ["AC-5", "Profiles whose Cost is — are ignored by this step, both as candidates and in the comparison."],
  ])("%s: complexity step preserves cost semantics", (_ac, text) => {
    expect(steps()[2]).toContain(text);
  });
  test.each([
    ["AC-6", 0, "1. Eliminate any profile whose weaknesses conflict with the story."],
    [
      "AC-7",
      1,
      "2. Keep profiles whose strengths or affinity cover the story's main job (task type + primary domain).",
    ],
    ["AC-8", 3, "4. If more than one remains, choose the LOWEST cost profile."],
    ["AC-9", 4, "5. If none clearly fit, omit `agentProfileId` entirely — never invent a profile id."],
  ] as const)("%s: retains the existing rule wording", (_ac, index, text) => {
    expect(steps()[index]).toBe(text);
  });
});

describe("PlanPromptBuilder.build", () => {
  test("AC-10: taskContext includes the shared complexity step with one profile", () => {
    const parts = new PlanPromptBuilder().build(
      "spec",
      "context",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [PROFILE],
    );
    expect(parts.taskContext).toContain(COMPLEXITY_STEP);
  });
});

describe("buildDecomposePromptSync", () => {
  test.each([undefined, makeStory()])(
    "AC-11: includes the complexity step in both decompose modes (%j)",
    (targetStory) => {
      expect(
        buildDecomposePromptSync({ specContent: "spec", codebaseContext: "context", targetStory, profiles: [PROFILE] }),
      ).toContain(COMPLEXITY_STEP);
    },
  );
});
