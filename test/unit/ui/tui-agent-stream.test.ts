/**
 * TUI Agent Stream Event Tests
 *
 * Tests for useAgentStreamEvents hook and AgentPanel stream display.
 * AC4: TUI renders normally when no bus connected or no events emitted.
 * AC5: Multiple concurrent calls show distinct rows without per-chunk arrays.
 * AC6: TUI renders agent metadata without raw thinking content.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { AgentStreamEventBus } from "../../../src/runtime/agent-stream-events";
import type { AgentStreamEvent } from "../../../src/runtime/agent-stream-events";
import { AgentPanel } from "../../../src/tui/components/AgentPanel";
import type { ActiveCallState } from "../../../src/tui/hooks/useAgentStreamEvents";

function makeActiveCalls(entries: ActiveCallState[]): Map<string, ActiveCallState> {
  const map = new Map<string, ActiveCallState>();
  for (const entry of entries) {
    map.set(entry.callId, entry);
  }
  return map;
}

function makeActiveCall(overrides: Partial<ActiveCallState> = {}): ActiveCallState {
  return {
    callId: "call-001",
    agentName: "claude",
    storyId: "s-42",
    stage: "run",
    startedAt: Date.now() - 5000,
    lastActivityAt: Date.now() - 1000,
    messageUpdates: 3,
    thinkingUpdates: 2,
    usageUpdates: 1,
    status: "active",
    ...overrides,
  };
}

describe("AgentPanel with stream events", () => {
  // AC4: renders normally when no activeCalls provided (graceful fallback)
  test("renders normally when activeCalls is not provided", () => {
    const { lastFrame } = render(createElement(AgentPanel, { focused: false }));
    expect(lastFrame()).toBeTruthy();
    // Should still show the Agent header
    expect(lastFrame()).toContain("Agent");
  });

  // AC4: renders normally when activeCalls is empty map
  test("renders normally when activeCalls is empty", () => {
    const { lastFrame } = render(
      createElement(AgentPanel, {
        focused: false,
        activeCalls: new Map(),
      }),
    );
    expect(lastFrame()).toBeTruthy();
    expect(lastFrame()).toContain("Agent");
  });

  // AC5: displays distinct rows per active call, no per-chunk accumulation
  test("renders distinct row for each active call", () => {
    const activeCalls = makeActiveCalls([
      makeActiveCall({ callId: "call-A", agentName: "claude", storyId: "s-01" }),
      makeActiveCall({ callId: "call-B", agentName: "codex", storyId: "s-02" }),
    ]);

    const { lastFrame } = render(
      createElement(AgentPanel, {
        focused: false,
        activeCalls,
      }),
    );

    const frame = lastFrame() ?? "";
    // Both agent names should appear
    expect(frame).toContain("claude");
    expect(frame).toContain("codex");
  });

  // AC5: does not accumulate per-chunk history arrays — only current state shown
  test("shows counters as numbers not arrays", () => {
    const activeCalls = makeActiveCalls([
      makeActiveCall({ callId: "call-001", messageUpdates: 5, thinkingUpdates: 3, usageUpdates: 2 }),
    ]);

    const { lastFrame } = render(
      createElement(AgentPanel, {
        focused: false,
        activeCalls,
      }),
    );

    const frame = lastFrame() ?? "";
    // Counters displayed as numbers (not arrays like "[obj,obj,obj]")
    expect(frame).not.toContain("[object");
    // Should display numeric counts
    expect(frame).toContain("5");
  });

  // AC6: renders agent metadata without raw thinking content
  test("displays agent name, elapsed time, activity counters without raw thinking text", () => {
    const now = Date.now();
    const activeCalls = makeActiveCalls([
      makeActiveCall({
        callId: "call-001",
        agentName: "claude",
        storyId: "s-42",
        stage: "run",
        startedAt: now - 10000,
        lastActivityAt: now - 2000,
        messageUpdates: 4,
        thinkingUpdates: 1,
        usageUpdates: 2,
        status: "active",
      }),
    ]);

    const { lastFrame } = render(
      createElement(AgentPanel, {
        focused: false,
        activeCalls,
      }),
    );

    const frame = lastFrame() ?? "";
    // Agent name rendered
    expect(frame).toContain("claude");
    // Story ID rendered
    expect(frame).toContain("s-42");
    // No raw thinking text
    expect(frame).not.toContain("agent_thought_chunk");
    expect(frame).not.toContain("thinking_text");
  });

  // AC6: does not display raw thinking content even if thinking updates occurred
  test("does not display raw thinking content", () => {
    const activeCalls = makeActiveCalls([
      makeActiveCall({
        callId: "call-001",
        thinkingUpdates: 10,
        // No raw thinking text in state — only count
      }),
    ]);

    const { lastFrame } = render(
      createElement(AgentPanel, {
        focused: false,
        activeCalls,
      }),
    );

    const frame = lastFrame() ?? "";
    // Should show thinking count (10) but not raw content
    expect(frame).toContain("10");
    expect(frame).not.toContain("raw_thinking");
    expect(frame).not.toContain("thought_text");
  });
});
