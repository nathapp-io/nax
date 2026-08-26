import { describe, expect, test } from "bun:test";
import { makeDispatchContext, makePRD, makeStory } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { buildWorktreePipelineContext } from "@/execution/parallel-worker";

describe("buildWorktreePipelineContext", () => {
  test("deep-clones prd so concurrent stories never share one object", () => {
    const base: Parameters<typeof buildWorktreePipelineContext>[0] = {
      ...makeDispatchContext(),
      config: DEFAULT_CONFIG,
      rootConfig: DEFAULT_CONFIG,
      prd: makePRD({
        feature: "f",
        userStories: [makeStory({ id: "US-001", title: "t", status: "pending" })],
      }),
      projectDir: "/tmp",
      hooks: { hooks: {} },
      skipPrdPersistence: true,
    };
    const story = makeStory({ id: "US-001", title: "t", status: "pending", attempts: 0, passes: false });
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
