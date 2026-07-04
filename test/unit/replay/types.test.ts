/**
 * Replay core type exports (US-002)
 *
 * The replay subsystem exposes `RunTimeline`, `StoryTimeline`, `PhaseStep`
 * types via the @/replay barrel so command/UI layers can consume them
 * without reaching into private files.
 */

import { describe, expect, test } from "bun:test";
import type { PhaseStep, RunTimeline, StoryTimeline } from "@/replay";

describe("replay — type exports", () => {
  test("PhaseStep shape: name and status accept the documented literal values", () => {
    const step: PhaseStep = { name: "implementer", status: "pass" };
    expect(step.name).toBe("implementer");
    expect(step.status).toBe("pass");
  });

  test("PhaseStep status also accepts 'fail'", () => {
    const step: PhaseStep = { name: "full-suite-gate", status: "fail" };
    expect(step.status).toBe("fail");
  });

  test("StoryTimeline shape: phases array, status, and optional metadata fields", () => {
    const story: StoryTimeline = {
      storyId: "US-001",
      status: "passed",
      finalTier: "balanced",
      cost: 0.1,
      attempts: 1,
      phases: [{ name: "implementer", status: "pass" }],
      escalations: [],
    };
    expect(story.storyId).toBe("US-001");
    expect(story.status).toBe("passed");
    expect(story.phases.length).toBe(1);
  });

  test("StoryTimeline status also accepts 'failed' and 'crashed'", () => {
    const crashed: StoryTimeline = {
      storyId: "US-002",
      status: "crashed",
      phases: [],
      escalations: [],
    };
    expect(crashed.status).toBe("crashed");
  });

  test("RunTimeline shape: runId, feature, inferred flag, and stories", () => {
    const tl: RunTimeline = {
      runId: "run-001",
      feature: "feat-x",
      status: "completed",
      inferred: true,
      stories: [],
    };
    expect(tl.inferred).toBe(true);
    expect(tl.stories).toEqual([]);
  });

  test("RunTimeline status also accepts 'failed' and 'crashed'", () => {
    const crashed: RunTimeline = {
      runId: "run-crash",
      feature: "feat-x",
      status: "crashed",
      inferred: true,
      stories: [],
    };
    expect(crashed.status).toBe("crashed");
  });

  test("RunTimeline.naxVersion is optional", () => {
    const tl: RunTimeline = {
      runId: "run-001",
      feature: "feat-x",
      status: "completed",
      inferred: true,
      stories: [],
    };
    expect(tl.naxVersion).toBeUndefined();
  });
});
