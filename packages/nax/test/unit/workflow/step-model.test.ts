import { describe, expect, test } from "bun:test";
import { makeFeatureContext, makeMockCallContext, makeNaxConfig, makeStepContext, makeTestStory } from "@test/helpers";
import { resolveWorkflowConfig } from "@/config";
import { featureModelFor, storyModelFor } from "@/workflow/step-model";

const MODELS = {
  claude: { fast: "model-a", balanced: "model-b", powerful: "model-c" },
  native: { fast: "model-n1", balanced: "model-n2", powerful: "model-n3" },
};
const config = makeNaxConfig({ models: MODELS });
const story = makeTestStory({
  id: "US-001",
  routing: { complexity: "medium", modelTier: "fast", testStrategy: "tdd-simple", reasoning: "" },
});
const tierOrder = [
  { tier: "fast", attempts: 2 },
  { tier: "balanced", attempts: 2 },
  { tier: "powerful", attempts: 2 },
];

describe("storyModelFor", () => {
  const sc = makeStepContext({
    config,
    story,
    tierOrder,
    callCtx: makeMockCallContext({ config, agentName: "native" }),
  });
  const modelFor = storyModelFor(sc);

  test("the first implementer turn runs the routed model", () => {
    expect(modelFor("implementer", { kind: "implement" })).toEqual({ agentName: "native", model: "model-n1" });
  });

  test("a stepped-up fix round names the stepped-up model", () => {
    const turn = { kind: "fix" as const, round: 4, fresh: true, stepUps: 1, findings: [], uncommitted: [] };
    expect(modelFor("implementer", turn)?.model).toBe("model-n2");
  });

  test("reviews resolve through their own op model", () => {
    expect(modelFor("story-review")?.agentName).toBe("native");
    expect(modelFor("re-review")?.agentName).toBe("native");
  });
});

describe("featureModelFor", () => {
  test("names a model for each feature agent step", () => {
    const fc = makeFeatureContext({
      config,
      workflow: resolveWorkflowConfig(config),
      callCtx: makeMockCallContext({ config, agentName: "claude" }),
    });
    const modelFor = featureModelFor(fc);
    for (const step of ["branch-review", "branch-fix", "branch-rereview"] as const) {
      expect(modelFor(step)).toEqual({ agentName: "claude", model: "model-b" });
    }
  });
});
