import { describe, expect, test } from "bun:test";
import { assertDefined } from "@test/helpers";
import { validatePlanOutput } from "@/prd";

describe("PRD sanitizer preserves agentProfileId", () => {
  test("keeps routing.agentProfileId emitted by the planner", () => {
    const raw = JSON.stringify({
      project: "p",
      feature: "f",
      branchName: "feat/f",
      userStories: [
        {
          id: "US-001",
          title: "t",
          description: "d",
          acceptanceCriteria: ["When X, then Y"],
          tags: [],
          dependencies: [],
          routing: {
            complexity: "medium",
            testStrategy: "tdd-simple",
            reasoning: "because",
            agentProfileId: "opencode-structural",
          },
        },
      ],
    });
    const prd = validatePlanOutput(raw, "f", "feat/f");
    const story = prd.userStories[0];
    assertDefined(story, "prd.userStories[0]");
    assertDefined(story.routing, "story.routing");
    expect(story.routing.agentProfileId).toBe("opencode-structural");
  });

  test("omits agentProfileId when the planner did not emit one", () => {
    const raw = JSON.stringify({
      project: "p",
      feature: "f",
      branchName: "feat/f",
      userStories: [
        {
          id: "US-001",
          title: "t",
          description: "d",
          acceptanceCriteria: ["When X, then Y"],
          tags: [],
          dependencies: [],
          routing: { complexity: "medium", testStrategy: "tdd-simple", reasoning: "because" },
        },
      ],
    });
    const prd = validatePlanOutput(raw, "f", "feat/f");
    const story = prd.userStories[0];
    assertDefined(story, "prd.userStories[0]");
    assertDefined(story.routing, "story.routing");
    expect(story.routing.agentProfileId).toBeUndefined();
  });
});
