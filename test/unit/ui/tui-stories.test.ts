// RE-ARCH: keep
/**
 * TUI Stories Panel Tests
 *
 * Tests the StoriesPanel component rendering with different story states,
 * routing info, tier indicators, and failure sub-lines.
 * Also tests StatusBar with keybinding hints and context display.
 */

import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { createElement } from "react";
import type { UserStory } from "../../../src/prd/types";
import { StatusBar } from "../../../src/tui/components/StatusBar";
import { StoriesPanel } from "../../../src/tui/components/StoriesPanel";
import type { StoryDisplayState } from "../../../src/tui/types";

// Helper to create mock stories
function createMockStory(id: string, status: StoryDisplayState["status"]): StoryDisplayState {
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
    cost: 0.01,
  };
}

describe("StoriesPanel", () => {
  test.each([
    ["pending" as const, "⬚"],
    ["running" as const, "🔄"],
    ["passed" as const, "✅"],
    ["failed" as const, "❌"],
    ["skipped" as const, "⏭️"],
    ["retrying" as const, "🔁"],
    ["paused" as const, "⏸️"],
  ])("renders %s story with %s icon", (status, icon) => {
    const stories = [createMockStory("US-001", status)];
    const { lastFrame } = render(
      createElement(StoriesPanel, { stories, width: 30 }),
    );
    expect(lastFrame()).toContain(`${icon} US-001`);
  });

  test("displays routing complexity in story row", () => {
    const stories = [createMockStory("US-001", "pending")];
    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        width: 30,
      }),
    );

    const output = lastFrame();
    expect(output).toContain("sim"); // "simple".slice(0, 3) = "sim"
  });

  test("displays tier suffix for running stories", () => {
    const stories = [{ ...createMockStory("US-001", "running"), modelTier: "fast" }];
    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        width: 30,
      }),
    );

    const output = lastFrame();
    expect(output).toContain("fas"); // "fast".slice(0, 3) = "fas"
  });

  test("renders multiple stories", () => {
    const stories = [
      createMockStory("US-001", "passed"),
      createMockStory("US-002", "running"),
      createMockStory("US-003", "pending"),
    ];

    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        width: 30,
      }),
    );

    const output = lastFrame();
    expect(output).toContain("✅ US-001");
    expect(output).toContain("🔄 US-002");
    expect(output).toContain("⬚ US-003");
  });

  test("displays failure sub-line for failed story", () => {
    const stories = [{
      ...createMockStory("US-001", "failed"),
      failureReason: "Tests failed to pass",
    }];

    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        width: 40,
      }),
    );

    const output = lastFrame();
    expect(output).toContain("❌ US-001");
    expect(output).toContain("Tests failed to pass");
  });
});

describe("StatusBar", () => {
  test("displays 'idle' when no current story", () => {
    const { lastFrame } = render(createElement(StatusBar, {}));
    expect(lastFrame()).toContain("idle");
  });

  test("displays current story ID", () => {
    const { lastFrame } = render(
      createElement(StatusBar, {
        currentStoryId: "US-042",
      }),
    );

    expect(lastFrame()).toContain("US-042");
  });

  test("displays current stage", () => {
    const { lastFrame } = render(
      createElement(StatusBar, {
        currentStoryId: "US-001",
        currentStage: "execution",
      }),
    );

    expect(lastFrame()).toContain("execution");
  });

  test("displays model tier", () => {
    const { lastFrame } = render(
      createElement(StatusBar, {
        currentStoryId: "US-001",
        modelTier: "balanced",
      }),
    );

    expect(lastFrame()).toContain("balanced");
  });

  test("displays keybinding hints when run is active", () => {
    const { lastFrame } = render(createElement(StatusBar, {}));
    const output = lastFrame();
    expect(output).toContain("pause");
    expect(output).toContain("abort");
  });

  test("displays done context when run is complete", () => {
    const { lastFrame } = render(
      createElement(StatusBar, { runComplete: true }),
    );
    expect(lastFrame()).toContain("done");
  });

  test("displays run paused context", () => {
    const { lastFrame } = render(
      createElement(StatusBar, { runPaused: true }),
    );
    expect(lastFrame()).toContain("run paused");
  });

  test("displays parallel mode with active count", () => {
    const { lastFrame } = render(
      createElement(StatusBar, { isParallel: true, activeCount: 3 }),
    );
    expect(lastFrame()).toContain("parallel");
    expect(lastFrame()).toContain("3");
  });
});

describe("Layout breakpoints", () => {
  test.each([
    ["single column mode (width < 80)", 70, "single"],
    ["narrow mode (width 80-140)", 100, "narrow"],
    ["wide mode (width > 140)", 150, "wide"],
  ])("%s", (_label, width, expected) => {
    const mode = width < 80 ? "single" : width < 140 ? "narrow" : "wide";
    expect(mode).toBe(expected);
  });
});
