/**
 * toReplayJson — JSON serialization for replay timelines (US-004)
 *
 * AC-1: @/replay exposes `toReplayJson`.
 * AC-2: Serialized object runId/feature/status equal the timeline's and
 *       `stories.length` equals `timeline.stories.length`.
 */

import { describe, expect, test } from "bun:test";
import type { RunTimeline, StoryTimeline } from "@/replay";
import { toReplayJson } from "@/replay";

function buildStory(overrides: Partial<StoryTimeline> & { storyId: string }): StoryTimeline {
  const { storyId, ...rest } = overrides;
  return {
    storyId,
    status: "passed",
    phases: [],
    escalations: [],
    ...rest,
  };
}

function buildTimeline(overrides: Partial<RunTimeline> = {}): RunTimeline {
  return {
    runId: "run-001",
    feature: "feat-auth",
    status: "completed",
    inferred: true,
    stories: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC-1: toReplayJson is exported from @/replay
// ---------------------------------------------------------------------------

describe("toReplayJson — module export", () => {
  test("AC1: toReplayJson is an exported function from @/replay", () => {
    expect(typeof toReplayJson).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// AC-2: returned object fields reflect timeline
// ---------------------------------------------------------------------------

describe("toReplayJson — AC2: serialized shape mirrors timeline", () => {
  test("AC2: returned object's runId equals the timeline's runId", () => {
    const tl = buildTimeline({
      runId: "run-zzz",
      feature: "feat-billing",
      status: "failed",
      stories: [buildStory({ storyId: "US-001" })],
    });

    const json = toReplayJson(tl);

    expect(json.runId).toBe("run-zzz");
  });

  test("AC2: returned object's feature equals the timeline's feature", () => {
    const tl = buildTimeline({
      runId: "run-001",
      feature: "feat-payments",
      status: "completed",
      stories: [],
    });

    const json = toReplayJson(tl);

    expect(json.feature).toBe("feat-payments");
  });

  test("AC2: returned object's status equals the timeline's status", () => {
    const tl = buildTimeline({
      runId: "run-001",
      feature: "feat-x",
      status: "crashed",
      stories: [],
    });

    const json = toReplayJson(tl);

    expect(json.status).toBe("crashed");
  });

  test("AC2: returned object's stories array length equals timeline.stories.length", () => {
    const tl = buildTimeline({
      stories: [
        buildStory({ storyId: "US-001" }),
        buildStory({ storyId: "US-002", status: "failed" }),
        buildStory({ storyId: "US-003" }),
      ],
    });

    const json = toReplayJson(tl);

    expect(json.stories.length).toBe(tl.stories.length);
    expect(json.stories.length).toBe(3);
  });
});
