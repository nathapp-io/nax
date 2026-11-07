import { describe, expect, test } from "bun:test";
import { planInteractiveOp, workflowBranchFixOp, workflowImplementOp } from "@/operations";

// The file-mutating workflow ops: each one edits the story's tree, so it needs
// Delete and Git as well as Write/Edit. The six fix-strategy ops that used to
// sit here (`implementerOp`, `implementerRectifyOp`, `testWriterRectifyOp`,
// `testWriterOp`, `rectifyOp`, `fullSuiteRectifyOp`) were deleted with
// pipeline-story-ops-delete US-001, except `implementerOp` and `testWriterOp`,
// which survive but no longer carry a production dispatcher.
const FILE_MUTATING_OPS = [
  ["workflow-implement", workflowImplementOp],
  ["workflow-branch-fix", workflowBranchFixOp],
] as const;

describe("file-mutating ops declare Delete and Git", () => {
  test.each(FILE_MUTATING_OPS)("%s declares Delete", (_name, op) => {
    expect(op.tools).toContain("Delete");
  });

  test.each(FILE_MUTATING_OPS)("%s declares Git", (_name, op) => {
    expect(op.tools).toContain("Git");
  });

  test.each(FILE_MUTATING_OPS)("%s still declares Write and Edit", (_name, op) => {
    expect(op.tools).toContain("Write");
    expect(op.tools).toContain("Edit");
  });
});

describe("read-only ops gain neither", () => {
  test.each([["plan", planInteractiveOp]] as const)("%s does not declare Delete", (_name, op) => {
    expect(op.tools ?? []).not.toContain("Delete");
  });
});
