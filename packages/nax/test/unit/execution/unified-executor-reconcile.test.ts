import { describe, expect, test } from "bun:test";
import { makeStory } from "@test/helpers";
import { reconcileBatchOutcome } from "@/execution/unified-executor";
import type { PRD } from "@/prd/types";

function prdWith(...ids: string[]): PRD {
  return {
    feature: "f",
    userStories: ids.map((id) => ({ id, status: "pending", attempts: 0, passes: false, title: id })),
  } as PRD;
}

describe("reconcileBatchOutcome (single PRD writer)", () => {
  test("marks completed stories passed", () => {
    const prd = prdWith("US-001", "US-002");
    reconcileBatchOutcome(prd, {
      completed: [makeStory({ id: "US-001", title: "t" })],
      mergeConflicts: [],
    });
    expect(prd.userStories.find((s) => s.id === "US-001")?.status).toBe("passed");
    expect(prd.userStories.find((s) => s.id === "US-002")?.status).toBe("pending");
  });

  test("does NOT touch failed stories (handlePipelineFailure owns them — no double attempts++)", () => {
    const prd = prdWith("US-001");
    prd.userStories[0].attempts = 1;
    reconcileBatchOutcome(prd, { completed: [], mergeConflicts: [] });
    expect(prd.userStories[0].attempts).toBe(1);
  });

  test("marks unrectified merge conflicts failed", () => {
    const prd = prdWith("US-001");
    reconcileBatchOutcome(prd, {
      completed: [],
      mergeConflicts: [{ story: makeStory({ id: "US-001" }), rectified: false, cost: 0 }],
    });
    expect(prd.userStories.find((s) => s.id === "US-001")?.status).toBe("failed");
  });

  test("marks rectified merge conflicts passed", () => {
    const prd = prdWith("US-001");
    reconcileBatchOutcome(prd, {
      completed: [],
      mergeConflicts: [{ story: makeStory({ id: "US-001" }), rectified: true, cost: 0 }],
    });
    expect(prd.userStories.find((s) => s.id === "US-001")?.status).toBe("passed");
  });
});
