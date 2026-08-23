import { describe, expect, test } from "bun:test";
import type { StoryDisplayState } from "@/tui";
import { StoriesPanel } from "@/tui/components/StoriesPanel";
import { render } from "ink-testing-library";
import React from "react";

function makeStory(overrides: Partial<StoryDisplayState> = {}): StoryDisplayState {
  return {
    story: { id: "US-001", title: "Story", passes: false, workdir: ".", acceptanceCriteria: [] } as never,
    status: "pending",
    ...overrides,
  };
}

describe("StoriesPanel", () => {
  test("renders a story id in non-compact mode", () => {
    const { lastFrame } = render(React.createElement(StoriesPanel, { stories: [makeStory()] }));
    expect(lastFrame()).toContain("US-001");
  });

  test("renders a story id in compact mode", () => {
    const { lastFrame } = render(React.createElement(StoriesPanel, { stories: [makeStory()], compact: true }));
    expect(lastFrame()).toContain("US-001");
  });

  test("renders a failure reason for a failed story", () => {
    const stories = [makeStory({ status: "failed", failureReason: "connection refused by remote host" })];
    const { lastFrame } = render(React.createElement(StoriesPanel, { stories }));
    expect(lastFrame()).toContain("connection refused");
  });

  // SEC-09: story.id (PRD-authored) and failureReason (agent/LLM-authored
  // escalation text) are not sanitized upstream — a crafted value
  // containing an ESC sequence must not reach the terminal raw.
  describe("SEC-09: ANSI/control-char stripping", () => {
    test("strips a CSI sequence embedded in the story id (non-compact mode)", () => {
      const stories = [
        makeStory({
          story: { id: "US-\x1b[2J001", title: "t", passes: false, workdir: ".", acceptanceCriteria: [] } as never,
        }),
      ];
      const { lastFrame } = render(React.createElement(StoriesPanel, { stories }));
      const frame = lastFrame() ?? "";
      expect(frame).not.toContain("\x1b[2J");
      expect(frame).toContain("US-001");
    });

    test("strips a CSI sequence embedded in the story id (compact mode)", () => {
      const stories = [
        makeStory({
          story: { id: "US-\x1b[2J001", title: "t", passes: false, workdir: ".", acceptanceCriteria: [] } as never,
        }),
      ];
      const { lastFrame } = render(React.createElement(StoriesPanel, { stories, compact: true }));
      const frame = lastFrame() ?? "";
      expect(frame).not.toContain("\x1b[2J");
      expect(frame).toContain("US-001");
    });

    test("strips a CSI sequence embedded in the failure reason", () => {
      const stories = [makeStory({ status: "failed", failureReason: "crashed\x1b[31m badly here" })];
      const { lastFrame } = render(React.createElement(StoriesPanel, { stories }));
      const frame = lastFrame() ?? "";
      expect(frame).not.toContain("\x1b[31m");
      expect(frame).toContain("crashed");
    });
  });
});
