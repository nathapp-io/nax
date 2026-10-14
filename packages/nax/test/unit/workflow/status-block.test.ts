/**
 * The status.json `workflow` block (spec §9, P4-R12). US-004 adds the `passed`
 * projection: the feature workflow's own verdict rides the block, so a reader that
 * only has status.json can see why the run reports what it does.
 */
import { describe, expect, test } from "bun:test";
import { workflowStatusBlock } from "@/workflow/status-block";
import type { StorySummary } from "@/workflow/types";

const STORIES: readonly StorySummary[] = [
  { id: "US-001", title: "A", state: "complete", rounds: 2, unreviewed: false, flagged: 0 },
];

describe("workflowStatusBlock — passed projection (US-004)", () => {
  test("a passed feature workflow is projected onto the block", () => {
    const block = workflowStatusBlock(STORIES, "done", { outcome: "draft", passed: true });
    expect(block.passed).toBe(true);
    expect(block.outcome).toBe("draft");
  });

  test("a failed feature workflow is projected as false, not dropped", () => {
    const block = workflowStatusBlock(STORIES, "done", { outcome: "ready", passed: false });
    expect(block.passed).toBe(false);
    expect("passed" in block).toBe(true);
    expect(block.outcome).toBe("ready");
  });

  test("a record with no verdict leaves the key off the block", () => {
    const block = workflowStatusBlock(STORIES, "publish", { outcome: "draft" });
    expect("passed" in block).toBe(false);
    expect(block.outcome).toBe("draft");
  });

  test("no record at all leaves the key off the block", () => {
    const block = workflowStatusBlock(STORIES, "repo-gates");
    expect("passed" in block).toBe(false);
    expect(block).toEqual({ step: "repo-gates", stories: { "US-001": { state: "complete", round: 2 } } });
  });
});

describe("workflowStatusBlock — flagged projection (US-005)", () => {
  test("the ids flagged for a human ride the block, in ledger order", () => {
    const block = workflowStatusBlock(STORIES, "done", { outcome: "local-only", flaggedDecisions: ["D-1", "D-3"] });
    expect(block.flagged).toEqual(["D-1", "D-3"]);
  });

  test("an empty list leaves the key off the block", () => {
    const block = workflowStatusBlock(STORIES, "done", { outcome: "ready", flaggedDecisions: [] });
    expect("flagged" in block).toBe(false);
    expect(block.outcome).toBe("ready");
  });

  test("a record that never collected leaves the key off the block", () => {
    const block = workflowStatusBlock(STORIES, "done", { outcome: "ready" });
    expect("flagged" in block).toBe(false);
  });
});
