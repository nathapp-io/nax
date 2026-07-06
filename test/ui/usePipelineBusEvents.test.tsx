import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React, { act } from "react";
import { Text } from "ink";
import { pipelineEventBus } from "../../src/pipeline/event-bus";
import { usePipelineBusEvents } from "../../src/tui/hooks/usePipelineBusEvents";
import type { StoryDisplayState } from "../../src/tui/types";

function makeInitialStory(id: string): StoryDisplayState {
  return {
    story: { id, title: `Story ${id}`, passes: false, workdir: ".", acceptanceCriteria: [] } as any,
    status: "pending",
  };
}

// Wrapper that renders hook state as inspectable text
function HookOutput({ stories }: { stories: StoryDisplayState[] }) {
  const state = usePipelineBusEvents(stories);
  const first = state.stories[0];
  return (
    <Text>
      status:{first?.status ?? "none"}
      |tier:{first?.modelTier ?? "none"}
      |reason:{first?.failureReason ?? "none"}
      |escalations:{state.escalationLog.length}
      |cost:{state.totalCost.toFixed(4)}
      |summary:{state.runSummary ? state.runSummary.passedStories : "none"}
    </Text>
  );
}

// Isolated wrapper for lastFailedStoryId assertions — kept on its own line so
// it never widens (and thus wraps) the multi-field HookOutput row.
function LastFailedOutput({ stories }: { stories: StoryDisplayState[] }) {
  const state = usePipelineBusEvents(stories);
  return <Text>lastFailed:{state.lastFailedStoryId ?? "none"}</Text>;
}

beforeEach(() => pipelineEventBus.clear());
afterEach(() => pipelineEventBus.clear());

describe("usePipelineBusEvents", () => {
  test("story:started marks story running with modelTier", () => {
    const { lastFrame } = render(
      <HookOutput stories={[makeInitialStory("US-001")]} />
    );

    act(() => {
      pipelineEventBus.emit({
        type: "story:started",
        storyId: "US-001",
        story: { id: "US-001", title: "S", status: "pending", attempts: 0 },
        workdir: ".",
        modelTier: "balanced",
        iteration: 1,
      });
    });

    expect(lastFrame()).toContain("status:running");
    expect(lastFrame()).toContain("tier:balanced");
  });

  test("story:completed marks story passed and accumulates cost", () => {
    const { lastFrame } = render(
      <HookOutput stories={[makeInitialStory("US-001")]} />
    );

    act(() => {
      pipelineEventBus.emit({
        type: "story:completed",
        storyId: "US-001",
        story: { id: "US-001", title: "S", status: "passed", attempts: 1 },
        passed: true,
        runElapsedMs: 5000,
        cost: 0.0042,
      });
    });

    expect(lastFrame()).toContain("status:passed");
    expect(lastFrame()).toContain("cost:0.0042");
  });

  test("story:failed marks story failed with reason", () => {
    const { lastFrame } = render(
      <HookOutput stories={[makeInitialStory("US-001")]} />
    );

    act(() => {
      pipelineEventBus.emit({
        type: "story:failed",
        storyId: "US-001",
        story: { id: "US-001", title: "S", status: "failed", attempts: 3 },
        reason: "3 tests failed",
        countsTowardEscalation: true,
      });
    });

    expect(lastFrame()).toContain("status:failed");
    expect(lastFrame()).toContain("reason:3 tests failed");
  });

  test("story:skipped marks story skipped", () => {
    const { lastFrame } = render(
      <HookOutput stories={[makeInitialStory("US-001")]} />
    );

    act(() => {
      pipelineEventBus.emit({ type: "story:skipped", storyId: "US-001", reason: "user skip" });
    });

    expect(lastFrame()).toContain("status:skipped");
  });

  test("story:escalated marks story retrying and appends escalation log", () => {
    const { lastFrame } = render(
      <HookOutput stories={[makeInitialStory("US-001")]} />
    );

    act(() => {
      pipelineEventBus.emit({
        type: "story:escalated",
        storyId: "US-001",
        fromTier: "fast",
        toTier: "balanced",
      });
    });

    expect(lastFrame()).toContain("status:retrying");
    expect(lastFrame()).toContain("escalations:1");
  });

  test("run:completed sets runSummary passedStories", () => {
    const { lastFrame } = render(
      <HookOutput stories={[makeInitialStory("US-001")]} />
    );

    act(() => {
      pipelineEventBus.emit({
        type: "run:completed",
        totalStories: 1,
        passedStories: 1,
        failedStories: 0,
        skippedStories: 0,
        pausedStories: 0,
        durationMs: 8000,
        totalCost: 0.0063,
      });
    });

    expect(lastFrame()).toContain("summary:1");
  });

  test("lastFailedStoryId is none before any failure", () => {
    const { lastFrame } = render(<LastFailedOutput stories={[makeInitialStory("US-001")]} />);
    expect(lastFrame()).toContain("lastFailed:none");
  });

  test("story:failed records lastFailedStoryId", () => {
    const { lastFrame } = render(<LastFailedOutput stories={[makeInitialStory("US-001")]} />);

    act(() => {
      pipelineEventBus.emit({
        type: "story:failed",
        storyId: "US-001",
        story: { id: "US-001", title: "S", status: "failed", attempts: 3 },
        reason: "boom",
        countsTowardEscalation: true,
      });
    });

    expect(lastFrame()).toContain("lastFailed:US-001");
  });

  test("story:completed with passed:false records lastFailedStoryId", () => {
    const { lastFrame } = render(<LastFailedOutput stories={[makeInitialStory("US-001")]} />);

    act(() => {
      pipelineEventBus.emit({
        type: "story:completed",
        storyId: "US-001",
        story: { id: "US-001", title: "S", status: "failed", attempts: 1 },
        passed: false,
        runElapsedMs: 5000,
      });
    });

    expect(lastFrame()).toContain("lastFailed:US-001");
  });

  test("story:completed with passed:true does not record lastFailedStoryId", () => {
    const { lastFrame } = render(<LastFailedOutput stories={[makeInitialStory("US-001")]} />);

    act(() => {
      pipelineEventBus.emit({
        type: "story:completed",
        storyId: "US-001",
        story: { id: "US-001", title: "S", status: "passed", attempts: 1 },
        passed: true,
        runElapsedMs: 5000,
        cost: 0.001,
      });
    });

    expect(lastFrame()).toContain("lastFailed:none");
  });

  test("most-recent failure wins when multiple stories fail", () => {
    const { lastFrame } = render(
      <LastFailedOutput stories={[makeInitialStory("US-001"), makeInitialStory("US-002")]} />
    );

    act(() => {
      pipelineEventBus.emit({
        type: "story:failed",
        storyId: "US-001",
        story: { id: "US-001", title: "S1", status: "failed", attempts: 3 },
        reason: "first",
        countsTowardEscalation: true,
      });
    });
    act(() => {
      pipelineEventBus.emit({
        type: "story:failed",
        storyId: "US-002",
        story: { id: "US-002", title: "S2", status: "failed", attempts: 3 },
        reason: "second",
        countsTowardEscalation: true,
      });
    });

    expect(lastFrame()).toContain("lastFailed:US-002");
  });

  test("story:started clears lastFailedStoryId when the restarted story was the last failure", () => {
    const { lastFrame } = render(<LastFailedOutput stories={[makeInitialStory("US-001")]} />);

    act(() => {
      pipelineEventBus.emit({
        type: "story:failed",
        storyId: "US-001",
        story: { id: "US-001", title: "S", status: "failed", attempts: 3 },
        reason: "boom",
        countsTowardEscalation: true,
      });
    });
    expect(lastFrame()).toContain("lastFailed:US-001");

    act(() => {
      pipelineEventBus.emit({
        type: "story:started",
        storyId: "US-001",
        story: { id: "US-001", title: "S", status: "pending", attempts: 0 },
        workdir: ".",
        modelTier: "balanced",
        iteration: 2,
      });
    });

    expect(lastFrame()).toContain("lastFailed:none");
  });

  test("run:completed clears lastFailedStoryId so retry is disarmed after the run", () => {
    const { lastFrame } = render(<LastFailedOutput stories={[makeInitialStory("US-001")]} />);

    act(() => {
      pipelineEventBus.emit({
        type: "story:failed",
        storyId: "US-001",
        story: { id: "US-001", title: "S", status: "failed", attempts: 3 },
        reason: "boom",
        countsTowardEscalation: true,
      });
    });
    expect(lastFrame()).toContain("lastFailed:US-001");

    act(() => {
      pipelineEventBus.emit({
        type: "run:completed",
        totalStories: 1,
        passedStories: 0,
        failedStories: 1,
        skippedStories: 0,
        pausedStories: 0,
        durationMs: 8000,
        totalCost: 0.01,
      });
    });

    expect(lastFrame()).toContain("lastFailed:none");
  });

  test("story:started for a different story does not clear lastFailedStoryId", () => {
    const { lastFrame } = render(
      <LastFailedOutput stories={[makeInitialStory("US-001"), makeInitialStory("US-002")]} />
    );

    act(() => {
      pipelineEventBus.emit({
        type: "story:failed",
        storyId: "US-001",
        story: { id: "US-001", title: "S1", status: "failed", attempts: 3 },
        reason: "boom",
        countsTowardEscalation: true,
      });
    });
    act(() => {
      pipelineEventBus.emit({
        type: "story:started",
        storyId: "US-002",
        story: { id: "US-002", title: "S2", status: "pending", attempts: 0 },
        workdir: ".",
        modelTier: "balanced",
        iteration: 1,
      });
    });

    expect(lastFrame()).toContain("lastFailed:US-001");
  });
});
