import { describe, expect, test } from "bun:test";
import { buildWorktreePipelineContext } from "@/execution/parallel-worker";

describe("buildWorktreePipelineContext", () => {
  test("deep-clones prd so concurrent stories never share one object", () => {
    const base = {
      prd: { feature: "f", userStories: [{ id: "US-001", status: "pending" }] },
      skipPrdPersistence: true,
    } as any;
    const story = { id: "US-001", title: "t", status: "pending", attempts: 0, passes: false } as any;
    const a = buildWorktreePipelineContext(base, story);
    const b = buildWorktreePipelineContext(base, story);
    expect(a.prd).not.toBe(base.prd);
    expect(a.prd).not.toBe(b.prd);
    expect(a.skipPrdPersistence).toBe(true); // inherited from base
    // Mutating one story's clone must not affect the base
    a.prd.userStories[0].status = "passed";
    expect(base.prd.userStories[0].status).toBe("pending");
  });
});
