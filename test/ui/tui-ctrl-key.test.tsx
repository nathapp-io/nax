/**
 * BUG-22: a Ctrl+<letter> combo shares its `input` character with the plain
 * letter (Ctrl+C and "c" are both input === "c" in Ink), so useKeyboard's
 * character-shortcut switch previously matched Ctrl+C the same as a bare "c"
 * keypress — opening the cost overlay (SHOW_COST) instead of leaving Ctrl+C
 * for Ink's own exit handling.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React, { act } from "react";
import { PipelineEventEmitter, pipelineEventBus } from "@/pipeline";
import type { StoryDisplayState } from "@/tui";
import { App } from "@/tui/App";

function makeStory(id: string): StoryDisplayState {
  return {
    story: { id, title: `Story ${id}`, passes: false, workdir: ".", acceptanceCriteria: [] } as never,
    status: "pending",
  };
}

describe("TUI Ctrl+<letter> vs plain letter shortcuts", () => {
  beforeEach(() => {
    pipelineEventBus.clear();
  });

  afterEach(() => {
    pipelineEventBus.clear();
  });

  test("plain 'c' opens the cost overlay", () => {
    const { stdin, lastFrame, unmount } = render(
      <App feature="feat" stories={[makeStory("US-001")]} events={new PipelineEventEmitter()} />,
    );

    act(() => {
      stdin.write("c");
    });

    expect(lastFrame()).toContain("Cost Breakdown");
    unmount();
  });

  test("Ctrl+C does not open the cost overlay", () => {
    const { stdin, lastFrame, unmount } = render(
      <App feature="feat" stories={[makeStory("US-001")]} events={new PipelineEventEmitter()} />,
    );

    act(() => {
      // \x03 is ETX (Ctrl+C) — Ink reports this as input "c" with key.ctrl === true.
      stdin.write("\x03");
    });

    expect(lastFrame()).not.toContain("Cost Breakdown");
    unmount();
  });
});
