/**
 * US-004 — `buildNbfDeps` (src/execution/story-orchestrator/nbf-deps.ts).
 *
 * The dependency builder `ExecutionPlan.run` hands to `runNonBlockingFix` as its
 * override object. It always supplies `measureSourceDiff`; it supplies the
 * scoped fix review's `reviewFix` only when the `CallContext` carries the story
 * the review needs (`ctx.story`), because `runFixReview` requires a
 * `UserStory` and a `ReviewConfig`.
 *
 * The `reviewFix`-absent branch exists purely for callers that construct a
 * `CallContext` without a story (ad-hoc/CLI dispatch); the production execution
 * stage always populates `ctx.story`.
 */
import { describe, expect, test } from "bun:test";
import { makeFinding, makeMockCallContext, makeStory } from "@test/helpers";
import { buildNbfDeps } from "@/execution/story-orchestrator/nbf-deps";
import type { Finding } from "@/findings";

const FINDINGS: readonly Finding[] = [
  makeFinding({
    source: "adversarial-review",
    severity: "warning",
    category: "input",
    message: "the empty path skips",
  }),
];

describe("buildNbfDeps (US-004 AC10)", () => {
  test("US-004 AC10: returns no reviewFix when the call context carries no story", () => {
    const ctx = makeMockCallContext({ storyId: "us-004" });

    const deps = buildNbfDeps({ ctx, findings: FINDINGS });

    expect(deps.reviewFix).toBeUndefined();
  });

  test("US-004 AC10 boundary: the source-diff measurement is supplied whether or not there is a story", () => {
    const withoutStory = buildNbfDeps({ ctx: makeMockCallContext({ storyId: "us-004" }), findings: FINDINGS });
    const withStory = buildNbfDeps({
      ctx: makeMockCallContext({ storyId: "us-004", story: makeStory({ id: "us-004" }) }),
      findings: FINDINGS,
    });

    expect(typeof withoutStory.measureSourceDiff).toBe("function");
    expect(typeof withStory.measureSourceDiff).toBe("function");
  });

  test("US-004 AC10 boundary: a call context with a story gets a reviewFix function", () => {
    const ctx = makeMockCallContext({ storyId: "us-004", story: makeStory({ id: "us-004" }) });

    const deps = buildNbfDeps({ ctx, findings: FINDINGS });

    expect(typeof deps.reviewFix).toBe("function");
  });
});
