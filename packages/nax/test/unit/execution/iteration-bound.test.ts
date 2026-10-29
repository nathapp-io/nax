/**
 * nax#2706 — workflow mode bounds its loop by the work left, not execution.maxIterations.
 */

import { describe, expect, test } from "bun:test";
import { makeNaxConfig, makePRD } from "@test/helpers";
import { loopIterationLimit, progressSignature, workflowIterationsRemaining } from "@/execution/iteration-bound";
import type { UserStory } from "@/prd/types";

function story(id: string, over: Partial<UserStory> = {}): UserStory {
  return { ...makePRD().userStories[0], id, status: "pending", passes: false, attempts: 0, ...over };
}

const NO_ESCALATION = makeNaxConfig({ autoMode: { escalation: { enabled: false } } });

describe("workflowIterationsRemaining", () => {
  test("pending stories plus the completion pass", () => {
    const prd = makePRD({ userStories: [story("US-001"), story("US-002"), story("US-003")] });

    expect(workflowIterationsRemaining(prd, makeNaxConfig(), null)).toBe(4);
  });

  test("passed, failed, paused and skipped stories cost no iteration", () => {
    const prd = makePRD({
      userStories: [
        story("US-001", { status: "passed", passes: true }),
        story("US-002", { status: "failed", attempts: 99 }),
        story("US-003", { status: "paused" }),
        story("US-004", { status: "skipped" }),
        story("US-005"),
      ],
    });

    expect(workflowIterationsRemaining(prd, makeNaxConfig(), null)).toBe(2);
  });

  test("the story the selector would retry (just failed, attempts within the limit) costs one more", () => {
    const prd = makePRD({
      userStories: [story("US-001", { status: "failed", attempts: 1 }), story("US-002")],
    });

    expect(workflowIterationsRemaining(prd, NO_ESCALATION, "US-001")).toBe(3);
  });

  test("a failed story out of retry attempts costs nothing", () => {
    const max = makeNaxConfig().execution.rectification.maxAttemptsTotal;
    const prd = makePRD({ userStories: [story("US-001", { status: "failed", attempts: max + 1 })] });

    expect(workflowIterationsRemaining(prd, NO_ESCALATION, "US-001")).toBe(1);
  });

  test("a pending story with spent attempts gets one extra iteration for its tier-budget escalation", () => {
    const prd = makePRD({ userStories: [story("US-001", { attempts: 2 }), story("US-002")] });

    expect(workflowIterationsRemaining(prd, makeNaxConfig({ autoMode: { escalation: { enabled: true } } }), null)).toBe(
      4,
    );
  });

  test("with escalation off a spent attempt adds nothing", () => {
    const prd = makePRD({ userStories: [story("US-001", { attempts: 2 })] });

    expect(workflowIterationsRemaining(prd, NO_ESCALATION, null)).toBe(2);
  });
});

describe("loopIterationLimit", () => {
  const stories = Array.from({ length: 28 }, (_, i) => story(`US-${i + 1}`));

  test("workflow mode: iterations done plus the work left, ignoring a maxIterations of 1", () => {
    const config = makeNaxConfig({
      execution: { mode: "workflow", maxIterations: 1 },
      autoMode: NO_ESCALATION.autoMode,
    });

    expect(loopIterationLimit(makePRD({ userStories: stories }), config, 5, null)).toBe(5 + 29);
  });

  test("pipeline mode: execution.maxIterations, whatever the PRD holds", () => {
    const config = makeNaxConfig({ execution: { mode: "pipeline", maxIterations: 7 } });

    expect(loopIterationLimit(makePRD({ userStories: stories }), config, 5, null)).toBe(7);
  });
});

describe("progressSignature", () => {
  test("changes when a story's status or attempts change, and not otherwise", () => {
    const base = makePRD({ userStories: [story("US-001")] });
    const same = makePRD({ userStories: [story("US-001")] });
    const attempted = makePRD({ userStories: [story("US-001", { attempts: 1 })] });
    const failed = makePRD({ userStories: [story("US-001", { status: "failed" })] });

    expect(progressSignature(same)).toBe(progressSignature(base));
    expect(progressSignature(attempted)).not.toBe(progressSignature(base));
    expect(progressSignature(failed)).not.toBe(progressSignature(base));
  });
});
