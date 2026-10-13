import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeNaxConfig, makePRD, makeStory } from "@test/helpers";
import { logStoryStart, storyModelName } from "@/execution/story-announce";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";

let logs: LogEntry[] = [];
beforeEach(() => {
  resetLogger();
  logs = [];
  initLogger({ level: "silent" });
  addSink((entry) => logs.push(entry));
});
afterEach(() => resetLogger());

const config = makeNaxConfig({
  models: { claude: { fast: "model-a", balanced: "model-b", powerful: "model-c" } },
});

describe("storyModelName", () => {
  test("resolves the tier to the agent's model id", () => {
    expect(storyModelName(config, "claude", "balanced", "claude")).toBe("model-b");
  });

  test("falls back to the default agent's entry, like dispatch does", () => {
    expect(storyModelName(config, "other", "fast", "claude")).toBe("model-a");
  });

  test("an unresolvable tier is not named instead of throwing", () => {
    expect(storyModelName(config, "claude", "no-such-tier", "claude")).toBeUndefined();
  });
});

describe("logStoryStart", () => {
  const story = makeStory({ id: "US-001" });
  const prd = makePRD({ userStories: [story] });

  test("carries the resolved model when the announcement has one", () => {
    logStoryStart(prd, story, { complexity: "medium", modelTier: "fast", agent: "claude", model: "model-a" });
    expect(logs[0]?.data).toMatchObject({ modelTier: "fast", agent: "claude", model: "model-a" });
  });

  test("omits the field when it has none", () => {
    logStoryStart(prd, story, { complexity: "medium", modelTier: "fast", agent: "claude" });
    expect(logs[0]?.data).not.toHaveProperty("model");
  });
});
