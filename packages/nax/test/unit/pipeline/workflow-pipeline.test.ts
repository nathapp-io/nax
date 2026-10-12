import { describe, expect, test } from "bun:test";
import { getDefaultPipeline, getWorkflowPipeline } from "@/pipeline/stages";

describe("getWorkflowPipeline", () => {
  test("swaps prompt, optimizer and execution for one workflow stage", () => {
    const names = getWorkflowPipeline().map((s) => s.name);
    const defaults = getDefaultPipeline().map((s) => s.name);
    expect(names).toEqual([...defaults.slice(0, 4), "workflow", ...defaults.slice(-1)]);
    expect(names).not.toContain("execution");
    expect(names).not.toContain("prompt");
  });

  test("is memoised", () => {
    expect(getWorkflowPipeline()).toBe(getWorkflowPipeline());
  });
});
