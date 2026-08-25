import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import type { RunCompletedEvent } from "@/pipeline/event-bus";
import { LiveActivityPanel } from "@/tui/components/LiveActivityPanel";
import type { ActiveCallState } from "@/tui/hooks/useAgentStreamEvents";
import type { EscalationEntry } from "@/tui/hooks/usePipelineBusEvents";

function makeCall(overrides: Partial<ActiveCallState> = {}): ActiveCallState {
  return {
    callId: "call-1",
    agentName: "claude",
    storyId: "US-001",
    stage: "execution",
    startedAt: Date.now() - 45000,
    lastActivityAt: Date.now() - 2000,
    messageUpdates: 3,
    thinkingUpdates: 1,
    usageUpdates: 1,
    toolCallUpdates: 4,
    status: "active",
    model: "sonnet",
    lastToolName: "Write",
    ...overrides,
  };
}

describe("LiveActivityPanel", () => {
  test("shows spinner text when no active calls and no summary", () => {
    const { lastFrame } = render(React.createElement(LiveActivityPanel, {}));
    expect(lastFrame()).toContain("Waiting for agent");
  });

  test("renders entry for an active call showing storyId, stage, model, and lastToolName", () => {
    const calls = new Map([["call-1", makeCall()]]);
    const { lastFrame } = render(React.createElement(LiveActivityPanel, { activeCalls: calls }));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("US-001");
    expect(frame).toContain("execution");
    expect(frame).toContain("sonnet");
    expect(frame).toContain("Write");
  });

  test("shows run summary when runSummary is set", () => {
    const summary: RunCompletedEvent = {
      type: "run:completed",
      totalStories: 3,
      passedStories: 2,
      failedStories: 1,
      skippedStories: 0,
      pausedStories: 0,
      durationMs: 120000,
      totalCost: 0.0421,
    };
    const { lastFrame } = render(React.createElement(LiveActivityPanel, { runSummary: summary }));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("2");
    expect(frame).toContain("passed");
    expect(frame).toContain("$0.0421");
  });

  test("shows error banner when runErrored is set", () => {
    const { lastFrame } = render(React.createElement(LiveActivityPanel, { runErrored: "config load failed" }));
    expect(lastFrame()).toContain("config load failed");
  });

  test("shows escalation log entries when present", () => {
    const calls = new Map([["call-1", makeCall()]]);
    const escalationLog: EscalationEntry[] = [
      { storyId: "US-001", fromTier: "fast", toTier: "balanced", at: Date.now() },
    ];
    const { lastFrame } = render(React.createElement(LiveActivityPanel, { activeCalls: calls, escalationLog }));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("fast");
    expect(frame).toContain("balanced");
  });

  // SEC-09: storyId, lastToolName, runErrored, and escalation storyId are
  // agent/PRD-controlled — a crafted value containing an ESC sequence must
  // not reach the terminal raw.
  describe("SEC-09: ANSI/control-char stripping", () => {
    test("strips a CSI sequence embedded in an active call's storyId", () => {
      const calls = new Map([["call-1", makeCall({ storyId: "US-\x1b[2J001" })]]);
      const { lastFrame } = render(React.createElement(LiveActivityPanel, { activeCalls: calls }));
      const frame = lastFrame() ?? "";
      expect(frame).not.toContain("\x1b[2J");
      expect(frame).toContain("US-001");
    });

    test("strips a CSI sequence embedded in lastToolName", () => {
      const calls = new Map([["call-1", makeCall({ lastToolName: "Write\x1b[31mEvil" })]]);
      const { lastFrame } = render(React.createElement(LiveActivityPanel, { activeCalls: calls }));
      const frame = lastFrame() ?? "";
      expect(frame).not.toContain("\x1b[31m");
      expect(frame).toContain("WriteEvil");
    });

    test("strips an OSC sequence embedded in runErrored", () => {
      const { lastFrame } = render(
        React.createElement(LiveActivityPanel, { runErrored: "config\x1b]52;c;evil\x07 load failed" }),
      );
      const frame = lastFrame() ?? "";
      expect(frame).not.toContain("\x1b]52");
      expect(frame).toContain("config load failed");
    });

    test("strips a CSI sequence embedded in an escalation entry's storyId", () => {
      const escalationLog: EscalationEntry[] = [
        { storyId: "US-\x1b[2J001", fromTier: "fast", toTier: "balanced", at: Date.now() },
      ];
      const { lastFrame } = render(React.createElement(LiveActivityPanel, { escalationLog }));
      const frame = lastFrame() ?? "";
      expect(frame).not.toContain("\x1b[2J");
      expect(frame).toContain("US-001");
    });
  });
});
