/**
 * US-004: the pure downgrade rule that makes a workflow-mode run report the feature
 * workflow's verdict. Only a "completed" run with an explicit negative verdict is
 * downgraded; every other status (including the undefined one a mock writer reports)
 * is returned unchanged.
 */
import { describe, expect, test } from "bun:test";
import { workflowFinalRunStatus } from "@/execution/lifecycle/workflow-run-status";

describe("workflowFinalRunStatus (US-004)", () => {
  test("a completed run whose feature workflow failed becomes failed", () => {
    expect(workflowFinalRunStatus("completed", false)).toBe("failed");
  });

  test("a completed run whose feature workflow passed stays completed", () => {
    expect(workflowFinalRunStatus("completed", true)).toBe("completed");
  });

  test("pipeline mode (no workflow verdict) leaves a completed run completed", () => {
    expect(workflowFinalRunStatus("completed", undefined)).toBe("completed");
  });

  test("a writer that never had a run status stays undefined", () => {
    expect(workflowFinalRunStatus(undefined, false)).toBeUndefined();
  });

  test("a cost-limit stop and an already-failed run are both left alone", () => {
    expect(workflowFinalRunStatus("cost-limit", false)).toBe("cost-limit");
    expect(workflowFinalRunStatus("failed", false)).toBe("failed");
  });

  test.each(["running", "stalled", "crashed", "precheck-failed", "aborted"] as const)(
    "a %s run is not downgraded by a failed feature workflow",
    (status) => {
      expect(workflowFinalRunStatus(status, false)).toBe(status);
    },
  );

  test.each(["running", "failed", "stalled", "crashed", "precheck-failed", "cost-limit", "aborted"] as const)(
    "a %s run is returned unchanged when the workflow passed",
    (status) => {
      expect(workflowFinalRunStatus(status, true)).toBe(status);
    },
  );
});
