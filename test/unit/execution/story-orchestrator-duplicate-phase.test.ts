import { describe, expect, test } from "bun:test";
import { NaxError } from "../../../src/errors";
import { StoryOrchestratorBuilder } from "../../../src/execution/story-orchestrator";

const INPUT = { story: { id: "S1", title: "t" } as any, contextMarkdown: "c" };

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
      expect((err as NaxError).code).toBe("ORCHESTRATOR_PHASE_DUPLICATE");
    }
  });

  test("addTestWriter called twice throws ORCHESTRATOR_PHASE_DUPLICATE", () => {
    const b = new StoryOrchestratorBuilder();
    const writerInput = { story: { id: "S1", title: "t" } as any, contextMarkdown: "c" };
    b.addTestWriter(writerInput);
    expect(() => b.addTestWriter(writerInput)).toThrow(NaxError);
  });
});
