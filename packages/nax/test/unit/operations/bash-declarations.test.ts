/**
 * Who may ever hold Bash (spec §4 US-004's ceiling).
 *
 * Declaration is the CEILING, not a grant: every op below still gets zero Bash
 * unless a human wrote a `Bash(...)` allow rule (spec R4). The reviewer ops
 * that also declared Bash (nax#2500, sandboxed with their tree changes
 * reverted) were deleted with C1 wave B2b-2, and the four fix-strategy ops
 * that declared it (`rectifyOp`, `fullSuiteRectifyOp`, `implementerRectifyOp`,
 * `testWriterRectifyOp`) with pipeline-story-ops-delete US-001. The rows that
 * remain are the live workflow ops that carry a production dispatcher.
 */
import { describe, expect, test } from "bun:test";
import { planInteractiveOp, workflowBranchFixOp, workflowImplementOp, workflowRepairOp } from "@/operations";

describe("ops that may hold Bash", () => {
  test.each([
    ["workflow-implement", workflowImplementOp],
    ["workflow-branch-fix", workflowBranchFixOp],
    ["workflow-repair", workflowRepairOp],
  ] as const)("%s declares Bash", (_name, op) => {
    expect(op.tools).toContain("Bash");
  });
});

describe("ops that must never hold Bash", () => {
  // The plan op stays pinned NEGATIVE: it reads and writes the PRD, never the
  // shell, so a Bash rule that would let it run arbitrary commands is the exact
  // over-grant this table exists to catch.
  test.each([["plan", planInteractiveOp]] as const)("%s does not declare Bash", (_name, op) => {
    expect(op.tools ?? []).not.toContain("Bash");
  });
});
