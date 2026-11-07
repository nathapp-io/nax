import { describe, expect, test } from "bun:test";
import * as stagesModule from "@/pipeline/stages";
import { getWorkflowPipeline } from "@/pipeline/stages";

describe("getWorkflowPipeline", () => {
  test("returns the six workflow stages in order", () => {
    const names = getWorkflowPipeline().map((s) => s.name);
    expect(names).toEqual(["queue-check", "routing", "constitution", "context", "workflow", "completion"]);
  });

  test("is memoised", () => {
    expect(getWorkflowPipeline()).toBe(getWorkflowPipeline());
  });

  test("exposes no default-pipeline API", () => {
    expect("getDefaultPipeline" in stagesModule).toBe(false);
    expect("defaultPipeline" in stagesModule).toBe(false);
  });

  // US-002 (pipeline-surface-delete): workflow mode builds its own prompts
  // through the workflow builders, so the prompt stage had no caller left and
  // is gone from the barrel entirely — no re-export, no alias.
  test("exposes no prompt stage", () => {
    expect("promptStage" in stagesModule).toBe(false);
  });
});
