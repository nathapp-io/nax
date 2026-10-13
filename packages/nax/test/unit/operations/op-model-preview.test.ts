import { describe, expect, test } from "bun:test";
import { makeMockCallContext, makeNaxConfig, makeTestStory } from "@test/helpers";
import { ladderSlotKey } from "@/agents/ladder-slot";
import { previewOpModel, workflowImplementOp, workflowStoryReviewOp } from "@/operations";
import type { UserStory } from "@/prd";

const MODELS = {
  claude: { fast: "model-a", balanced: "model-b", powerful: "model-c" },
  native: { fast: "model-n1", balanced: "model-n2", powerful: "model-n3" },
};
const routed = (modelTier: "fast" | "balanced" | "powerful"): UserStory =>
  makeTestStory({
    id: "US-001",
    routing: { complexity: "medium", modelTier, testStrategy: "tdd-simple", reasoning: "" },
  });
const implementer = (story: UserStory, model?: "fast" | "balanced" | "powerful") => ({
  story,
  prompt: "",
  timeoutMs: 1,
  reportPath: "/r.md",
  ...(model !== undefined ? { model } : {}),
});

describe("previewOpModel", () => {
  const config = makeNaxConfig({ models: MODELS });

  test("names the agent and model a routed story's implementer will run on", () => {
    const ctx = makeMockCallContext({ config, agentName: "native" });
    expect(previewOpModel(ctx, workflowImplementOp, implementer(routed("fast")))).toEqual({
      agentName: "native",
      model: "model-n1",
    });
  });

  test("an explicit model (a fix step-up) wins over the story's routing", () => {
    const ctx = makeMockCallContext({ config, agentName: "native" });
    expect(previewOpModel(ctx, workflowImplementOp, implementer(routed("fast"), "balanced"))?.model).toBe("model-n2");
  });

  test("a review op falls back to its configured model, then the balanced tier", () => {
    const ctx = makeMockCallContext({ config, agentName: "claude" });
    const preview = previewOpModel(ctx, workflowStoryReviewOp, { prompt: "", timeoutMs: 1 });
    expect(preview).toEqual({ agentName: "claude", model: "model-b" });
  });

  test("a story that already swapped to another endpoint names the swapped one", () => {
    const ctx = makeMockCallContext({ config, agentName: "native", storyId: "US-001" });
    ctx.runtime.ladderSlots.set(ladderSlotKey("US-001", "fast", "native", "wf-implementer"), {
      target: { agent: "claude", tier: "fast" },
      depth: 1,
    });
    expect(previewOpModel(ctx, workflowImplementOp, implementer(routed("fast")))).toEqual({
      agentName: "claude",
      model: "model-a",
    });
  });

  test("returns undefined instead of throwing when the model cannot be resolved", () => {
    const ctx = makeMockCallContext({ config: makeNaxConfig({ models: {} }), agentName: "ghost" });
    expect(previewOpModel(ctx, workflowImplementOp, implementer(routed("fast")))).toBeUndefined();
  });
});
