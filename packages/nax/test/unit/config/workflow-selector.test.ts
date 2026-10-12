import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { workflowConfigSelector } from "@/config";

describe("workflowConfigSelector", () => {
  test("slices the keys workflow ops read", () => {
    const slice = workflowConfigSelector.select(makeNaxConfig({}));
    expect(Object.keys(slice).sort()).toEqual(
      ["agent", "autoMode", "execution", "finish", "models", "quality", "review", "workflow"].sort(),
    );
    expect(slice.workflow?.maxFixRounds).toBe(5);
    expect(slice.finish?.reviewers).toBeDefined();
  });
});
