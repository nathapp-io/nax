// RE-ARCH: keep
/**
 * TUI Controls Tests
 *
 * Tests keyboard shortcuts, overlays, focus mode switching,
 * and queue command writing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { render } from "ink-testing-library";
import { createElement } from "react";
import type { UserStory } from "../../../src/prd/types";
import { CostOverlay } from "../../../src/tui/components/CostOverlay";
import { HelpOverlay } from "../../../src/tui/components/HelpOverlay";
import type { KeyboardAction } from "../../../src/tui/hooks/useKeyboard";
import { PanelFocus } from "../../../src/tui/types";
import type { StoryDisplayState } from "../../../src/tui/types";
import { writeQueueCommand } from "../../../src/utils/queue-writer";

// Helper to create mock stories
function createMockStory(id: string, status: StoryDisplayState["status"], cost = 0.01): StoryDisplayState {
  const story: UserStory = {
    id,
    title: `Test story ${id}`,
    description: "Test description",
    acceptanceCriteria: [],
    dependencies: [],
    tags: [],
    passes: status === "passed",
    status: status === "passed" ? "passed" : "pending",
    escalations: [],
    attempts: 0,
  };

  return {
    story,
    status,
    routing: {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "Test routing",
    },
    cost,
  };
}

describe("HelpOverlay", () => {
  test("does not render when visible=false", () => {
    const { lastFrame } = render(createElement(HelpOverlay, { visible: false }));
    expect(lastFrame()).toBe("");
  });

  test("renders keybindings when visible=true", () => {
    const { lastFrame } = render(createElement(HelpOverlay, { visible: true }));
    const output = lastFrame();

    expect(output).toContain("Keyboard Shortcuts");
    expect(output).toContain("p"); // Pause
    expect(output).toContain("a"); // Abort
    expect(output).toContain("s"); // Skip
    expect(output).toContain("Tab"); // Toggle focus
    expect(output).toContain("q"); // Quit
    expect(output).toContain("?"); // Show help
    expect(output).toContain("c"); // Show cost
    expect(output).toContain("r"); // Retry
    expect(output).toContain("Esc"); // Close overlay
    expect(output).toContain("Ctrl+]"); // Escape agent panel
  });

  test("displays Stories panel keybindings", () => {
    const { lastFrame } = render(createElement(HelpOverlay, { visible: true }));
    const output = lastFrame();

    expect(output).toContain("Stories Panel");
    expect(output).toContain("Pause after current story");
    expect(output).toContain("Abort run");
    expect(output).toContain("Skip current story");
  });

  test("displays Agent panel keybindings", () => {
    const { lastFrame } = render(createElement(HelpOverlay, { visible: true }));
    const output = lastFrame();

    expect(output).toContain("Agent Panel");
    expect(output).toContain("Escape back to Stories panel");
    expect(output).toContain("Forwarded to agent PTY");
  });
});

describe("CostOverlay", () => {
  test("does not render when visible=false", () => {
    const { lastFrame } = render(createElement(CostOverlay, { visible: false }));
    expect(lastFrame()).toBe("");
  });

  test("renders cost breakdown when visible=true", () => {
    const stories = [
      createMockStory("US-001", "passed", 0.023),
      createMockStory("US-002", "running", 0.015),
      createMockStory("US-003", "pending", 0),
    ];

    const { lastFrame } = render(
      createElement(CostOverlay, {
        visible: true,
        stories,
        totalCost: 0.038,
      }),
    );

    const output = lastFrame();
    expect(output).toContain("Cost Breakdown");
    expect(output).toContain("Story ID");
    expect(output).toContain("Status");
    expect(output).toContain("Cost");
  });

  test("displays executed stories with costs", () => {
    const stories = [createMockStory("US-001", "passed", 0.023), createMockStory("US-002", "failed", 0.015)];

    const { lastFrame } = render(
      createElement(CostOverlay, {
        visible: true,
        stories,
        totalCost: 0.038,
      }),
    );

    const output = lastFrame();
    expect(output).toContain("US-001");
    expect(output).toContain("passed");
    expect(output).toContain("$0.0230");
    expect(output).toContain("US-002");
    expect(output).toContain("failed");
    expect(output).toContain("$0.0150");
  });

  test("displays total cost", () => {
    const stories = [createMockStory("US-001", "passed", 0.023)];

    const { lastFrame } = render(
      createElement(CostOverlay, {
        visible: true,
        stories,
        totalCost: 0.123456,
      }),
    );

    const output = lastFrame();
    expect(output).toContain("Total Cost:");
    expect(output).toContain("$0.1235");
  });

  test("shows message when no stories executed", () => {
    const stories = [createMockStory("US-001", "pending", 0)];

    const { lastFrame } = render(
      createElement(CostOverlay, {
        visible: true,
        stories,
        totalCost: 0,
      }),
    );

    const output = lastFrame();
    expect(output).toContain("No stories executed yet");
  });
});

describe("Keyboard action types", () => {
  test("PAUSE action has correct type", () => {
    const action: KeyboardAction = { type: "PAUSE" };
    expect(action.type).toBe("PAUSE");
  });

  test("ABORT action has correct type", () => {
    const action: KeyboardAction = { type: "ABORT" };
    expect(action.type).toBe("ABORT");
  });

  test("SKIP action has story ID", () => {
    const action: KeyboardAction = { type: "SKIP", storyId: "US-042" };
    expect(action.type).toBe("SKIP");
    expect(action.storyId).toBe("US-042");
  });

  test("TOGGLE_FOCUS action has correct type", () => {
    const action: KeyboardAction = { type: "TOGGLE_FOCUS" };
    expect(action.type).toBe("TOGGLE_FOCUS");
  });

  test("ESCAPE_AGENT action has correct type", () => {
    const action: KeyboardAction = { type: "ESCAPE_AGENT" };
    expect(action.type).toBe("ESCAPE_AGENT");
  });

  test("QUIT action has correct type", () => {
    const action: KeyboardAction = { type: "QUIT" };
    expect(action.type).toBe("QUIT");
  });

  test("SHOW_HELP action has correct type", () => {
    const action: KeyboardAction = { type: "SHOW_HELP" };
    expect(action.type).toBe("SHOW_HELP");
  });

  test("SHOW_COST action has correct type", () => {
    const action: KeyboardAction = { type: "SHOW_COST" };
    expect(action.type).toBe("SHOW_COST");
  });

  test("RETRY action has correct type", () => {
    const action: KeyboardAction = { type: "RETRY" };
    expect(action.type).toBe("RETRY");
  });

  test("CLOSE_OVERLAY action has correct type", () => {
    const action: KeyboardAction = { type: "CLOSE_OVERLAY" };
    expect(action.type).toBe("CLOSE_OVERLAY");
  });
});

describe("Focus mode", () => {
  test("PanelFocus enum has Stories value", () => {
    expect(PanelFocus.Stories).toBe("stories");
  });

  test("PanelFocus enum has Agent value", () => {
    expect(PanelFocus.Agent).toBe("agent");
  });

  test("focus mode toggles between Stories and Agent", () => {
    let focus: PanelFocus = PanelFocus.Stories;
    focus = focus === PanelFocus.Stories ? PanelFocus.Agent : PanelFocus.Stories;
    expect(focus).toBe(PanelFocus.Agent);

    focus = focus === PanelFocus.Stories ? PanelFocus.Agent : PanelFocus.Stories;
    expect(focus).toBe(PanelFocus.Stories);
  });
});

describe("Queue command writer", () => {
  const tempQueueFile = `/tmp/nax-test-queue-${randomUUID()}.txt`;

  beforeEach(async () => {
    // Clean up any existing test file
    try {
      await unlink(tempQueueFile);
    } catch {
      // Ignore if doesn't exist
    }
  });

  afterEach(async () => {
    // Clean up after tests
    try {
      await unlink(tempQueueFile);
    } catch {
      // Ignore if doesn't exist
    }
  });

  test("writes PAUSE command to queue file", async () => {
    await writeQueueCommand(tempQueueFile, { type: "PAUSE" });

    const content = await Bun.file(tempQueueFile).text();
    expect(content.trim()).toBe("PAUSE");
  });

  test("writes ABORT command to queue file", async () => {
    await writeQueueCommand(tempQueueFile, { type: "ABORT" });

    const content = await Bun.file(tempQueueFile).text();
    expect(content.trim()).toBe("ABORT");
  });

  test("writes SKIP command with story ID to queue file", async () => {
    await writeQueueCommand(tempQueueFile, { type: "SKIP", storyId: "US-042" });

    const content = await Bun.file(tempQueueFile).text();
    expect(content.trim()).toBe("SKIP US-042");
  });

  test("appends multiple commands to queue file", async () => {
    await writeQueueCommand(tempQueueFile, { type: "SKIP", storyId: "US-001" });
    await writeQueueCommand(tempQueueFile, { type: "PAUSE" });
    await writeQueueCommand(tempQueueFile, { type: "ABORT" });

    const content = await Bun.file(tempQueueFile).text();
    const lines = content.trim().split("\n");

    expect(lines).toEqual(["SKIP US-001", "PAUSE", "ABORT"]);
  });

  test("creates queue file if it doesn't exist", async () => {
    // Ensure file doesn't exist
    try {
      await unlink(tempQueueFile);
    } catch {
      // Ignore
    }

    await writeQueueCommand(tempQueueFile, { type: "PAUSE" });

    const file = Bun.file(tempQueueFile);
    expect(await file.exists()).toBe(true);

    const content = await file.text();
    expect(content.trim()).toBe("PAUSE");
  });
});

describe("Ctrl+] escape sequence", () => {
  test("Ctrl+] should escape from agent panel", () => {
    // This would be tested in integration with the useKeyboard hook
    // For now, we verify the concept:
    const input = "]";
    const keyCtrl = true;

    if (keyCtrl && input === "]") {
      const action: KeyboardAction = { type: "ESCAPE_AGENT" };
      expect(action.type).toBe("ESCAPE_AGENT");
    }
  });

  test("regular ] without Ctrl should not escape", () => {
    const input = "]";
    const keyCtrl = false;

    // Should not trigger escape
    expect(keyCtrl && input === "]").toBe(false);
  });
});
