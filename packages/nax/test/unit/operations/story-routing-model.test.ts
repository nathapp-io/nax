import { describe, expect, test } from "bun:test";
import { makeStory } from "@test/helpers";
import { storyRoutingModel } from "@/operations/story-routing-model";

describe("storyRoutingModel", () => {
  test("returns the story's current tier", () => {
    const story = makeStory({
      routing: { complexity: "simple", modelTier: "powerful", testStrategy: "tdd-simple", reasoning: "" },
    });
    expect(storyRoutingModel(story)).toBe("powerful");
  });

  test("prefers a profile's literal pin over the tier", () => {
    const story = makeStory({
      routing: {
        complexity: "simple",
        agent: "native",
        profileModelPin: "openai-codex/gpt-5.6-terra",
        modelTier: "balanced",
        testStrategy: "tdd-simple",
        reasoning: "",
      },
    });
    expect(storyRoutingModel(story)).toEqual({ agent: "native", model: "openai-codex/gpt-5.6-terra" });
  });

  test("returns undefined for a story with no routing", () => {
    expect(storyRoutingModel(makeStory({}))).toBeUndefined();
  });

  test("ignores a pin with no agent to dispatch it on", () => {
    const story = makeStory({
      routing: {
        complexity: "simple",
        profileModelPin: "openai-codex/gpt-5.6-terra",
        modelTier: "fast",
        testStrategy: "tdd-simple",
        reasoning: "",
      },
    });
    expect(storyRoutingModel(story)).toBe("fast");
  });
});
