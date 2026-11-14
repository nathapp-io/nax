import { describe, expect, test } from "bun:test";
import { makeStoryLoopHarness, storyLoopFixtures } from "@test/helpers";
import { runStoryLoop } from "@/workflow/story-loop";
import type { StoryReviewVerdict, WorkflowFindingDraft } from "@/workflow/types";

const verdict = (findings: WorkflowFindingDraft[] = []): StoryReviewVerdict => ({
  ...storyLoopFixtures.PASS,
  spec: "fail",
  findings,
  mismatch: ["spec"],
});

describe("runStoryLoop verdict mismatches", () => {
  test("AC-1 and AC-2: empty mismatched review completes without a fix", async () => {
    const h = makeStoryLoopHarness({ review: [verdict()] });
    expect((await runStoryLoop(h.env)).state).toBe("complete");
    expect(h.turns.filter((t) => t.kind === "fix")).toEqual([]);
  });
  test.each([
    ["spec", "story review verdict inconsistent: spec fail without a blocking spec finding; findings kept"],
    ["quality", "story review verdict inconsistent: quality changes without a blocking finding; findings kept"],
  ] as const)("AC-3/4: records %s mismatch", async (kind, note) => {
    const h = makeStoryLoopHarness({ review: [{ ...verdict(), mismatch: [kind] }] });
    await runStoryLoop(h.env);
    expect(h.ledger).toContain(note);
  });
  test("records each kind once when both kinds are present", async () => {
    const h = makeStoryLoopHarness({ review: [{ ...verdict(), mismatch: ["spec", "quality", "spec"] }] });
    await runStoryLoop(h.env);
    expect(h.ledger.filter((line) => line.startsWith("story review verdict inconsistent:"))).toEqual([
      "story review verdict inconsistent: spec fail without a blocking spec finding; findings kept",
      "story review verdict inconsistent: quality changes without a blocking finding; findings kept",
    ]);
  });
  test("AC-5: records reviewer model", async () => {
    const h = makeStoryLoopHarness(
      { review: [verdict()] },
      { steps: { modelFor: () => ({ agentName: "native", model: "m1" }) } },
    );
    await runStoryLoop(h.env);
    expect(h.updates).toContainEqual({ verdictMismatch: { kinds: ["spec"], model: "m1" } });
  });
  test("AC-6: omits unknown reviewer model", async () => {
    const h = makeStoryLoopHarness({ review: [verdict()] });
    await runStoryLoop(h.env);
    expect(h.updates).toContainEqual({ verdictMismatch: { kinds: ["spec"] } });
  });
  test("AC-7: defers minor findings", async () => {
    const h = makeStoryLoopHarness({ review: [verdict([{ kind: "spec", severity: "minor", issue: "nit" }])] });
    await runStoryLoop(h.env);
    expect(h.updates.some((p) => p.deferredMinors === 1)).toBe(true);
  });
  test("AC-8: fixes blocking findings", async () => {
    const finding = { kind: "quality", severity: "important", issue: "bug" } as const;
    const h = makeStoryLoopHarness({ review: [verdict([finding])] });
    await runStoryLoop(h.env);
    const fix = h.turns.find((t) => t.kind === "fix");
    expect(fix).toMatchObject({ findings: [{ ...finding, id: "F1" }] });
  });
  test("AC-13: unparseable review remains unreviewed", async () => {
    const h = makeStoryLoopHarness({ review: [null] });
    expect((await runStoryLoop(h.env)).unreviewed).toBe(true);
  });
});
