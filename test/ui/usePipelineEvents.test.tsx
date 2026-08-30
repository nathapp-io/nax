/**
 * usePipelineEvents — stage tracking for pre-run phases and the current stage.
 *
 * Drives a real PipelineEventEmitter through a rendered wrapper so the hook's
 * subscribe/handle/unsubscribe effect runs the way it does in App.tsx, rather
 * than calling the handlers directly.
 */

import { describe, expect, test } from "bun:test";
import { makeStory } from "@test/helpers";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { act } from "react";
import { PipelineEventEmitter } from "@/pipeline";
import type { StageResult } from "@/pipeline/types";
import { usePipelineEvents } from "@/tui/hooks/usePipelineEvents";

const PRE_RUN_STAGE = "acceptance-setup";

/** Renders the hook's state as one inspectable line. */
function HookOutput({ events }: { events: PipelineEventEmitter }) {
  const { currentStage, preRunPhases } = usePipelineEvents(events);
  const phases = Object.entries(preRunPhases)
    .map(([stage, state]) => `${stage}=${state.status}`)
    .join(",");
  return (
    <Text>
      stage:{currentStage ?? "none"}|phases:{phases || "none"}
    </Text>
  );
}

function enter(events: PipelineEventEmitter, stage: string) {
  act(() => {
    events.emit("stage:enter", stage, makeStory({ id: "US-001", title: "S", workdir: "." }));
  });
}

function exit(events: PipelineEventEmitter, stage: string, result: StageResult) {
  act(() => {
    events.emit("stage:exit", stage, result);
  });
}

describe("usePipelineEvents", () => {
  test("starts with no current stage and no phases", () => {
    const { lastFrame, unmount } = render(<HookOutput events={new PipelineEventEmitter()} />);

    expect(lastFrame()).toContain("stage:none");
    expect(lastFrame()).toContain("phases:none");
    unmount();
  });

  test("stage:enter sets the current stage", () => {
    const events = new PipelineEventEmitter();
    const { lastFrame, unmount } = render(<HookOutput events={events} />);

    enter(events, "implement");

    expect(lastFrame()).toContain("stage:implement");
    unmount();
  });

  test("a non-pre-run stage:enter records no phase row", () => {
    const events = new PipelineEventEmitter();
    const { lastFrame, unmount } = render(<HookOutput events={events} />);

    enter(events, "implement");

    expect(lastFrame()).toContain("phases:none");
    unmount();
  });

  test("a pre-run stage:enter records the phase as running", () => {
    const events = new PipelineEventEmitter();
    const { lastFrame, unmount } = render(<HookOutput events={events} />);

    enter(events, PRE_RUN_STAGE);

    expect(lastFrame()).toContain(`${PRE_RUN_STAGE}=running`);
    unmount();
  });

  test("a pre-run stage:exit with action continue marks the phase passed", () => {
    const events = new PipelineEventEmitter();
    const { lastFrame, unmount } = render(<HookOutput events={events} />);

    enter(events, PRE_RUN_STAGE);
    exit(events, PRE_RUN_STAGE, { action: "continue" });

    expect(lastFrame()).toContain(`${PRE_RUN_STAGE}=passed`);
    unmount();
  });

  test("a pre-run stage:exit with action fail marks the phase failed", () => {
    const events = new PipelineEventEmitter();
    const { lastFrame, unmount } = render(<HookOutput events={events} />);

    enter(events, PRE_RUN_STAGE);
    exit(events, PRE_RUN_STAGE, { action: "fail", reason: "setup broke" });

    expect(lastFrame()).toContain(`${PRE_RUN_STAGE}=failed`);
    unmount();
  });

  test("a non-pre-run stage:exit records no phase row", () => {
    const events = new PipelineEventEmitter();
    const { lastFrame, unmount } = render(<HookOutput events={events} />);

    exit(events, "implement", { action: "continue" });

    expect(lastFrame()).toContain("phases:none");
    unmount();
  });
});
