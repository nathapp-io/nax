import { describe, expect, test } from "bun:test";
import { assertNaxError, makeStory } from "@test/helpers";
import { NaxError } from "@/errors";
import { StoryOrchestratorBuilder } from "@/execution/story-orchestrator";

const INPUT = { story: makeStory({ id: "S1", title: "t" }), contextMarkdown: "c" };

describe("StoryOrchestratorBuilder — duplicate phase guard", () => {
  test("addImplementer called twice throws ORCHESTRATOR_PHASE_DUPLICATE", () => {
    const b = new StoryOrchestratorBuilder();
    b.addImplementer(INPUT);
    expect(() => b.addImplementer(INPUT)).toThrow(NaxError);
  });

  test("thrown NaxError has code ORCHESTRATOR_PHASE_DUPLICATE", () => {
    const b = new StoryOrchestratorBuilder();
    b.addImplementer(INPUT);
    try {
      b.addImplementer(INPUT);
      expect(true).toBe(false); // should not reach
    } catch (err) {
      assertNaxError(err);
      expect(err.code).toBe("ORCHESTRATOR_PHASE_DUPLICATE");
    }
  });

  test("addTestWriter called twice throws ORCHESTRATOR_PHASE_DUPLICATE", () => {
    const b = new StoryOrchestratorBuilder();
    const writerInput = { story: makeStory({ id: "S1", title: "t" }), contextMarkdown: "c" };
    b.addTestWriter(writerInput);
    expect(() => b.addTestWriter(writerInput)).toThrow(NaxError);
  });
});
