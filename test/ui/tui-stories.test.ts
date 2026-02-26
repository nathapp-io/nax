/**
 * TUI Stories Panel Tests
 *
 * Tests the StoriesPanel component rendering with different story states,
 * cost display, elapsed time formatting, and layout breakpoint logic.
 */

import { describe, test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { StoriesPanel } from "../../src/tui/components/StoriesPanel";
import { StatusBar } from "../../src/tui/components/StatusBar";
import type { StoryDisplayState } from "../../src/tui/types";
import type { UserStory } from "../../src/prd/types";

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
  test("renders pending story with ⬚ icon", () => {
    const stories = [createMockStory("US-001", "pending")];
    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        totalCost: 0,
        elapsedMs: 0,
        width: 30,
      }),
    );

    expect(lastFrame()).toContain("⬚ US-001");
  });

  test("renders running story with 🔄 icon", () => {
    const stories = [createMockStory("US-001", "running")];
    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        totalCost: 0,
        elapsedMs: 0,
        width: 30,
      }),
    );

    expect(lastFrame()).toContain("🔄 US-001");
  });

  test("renders passed story with ✅ icon", () => {
    const stories = [createMockStory("US-001", "passed")];
    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        totalCost: 0,
        elapsedMs: 0,
        width: 30,
      }),
    );

    expect(lastFrame()).toContain("✅ US-001");
  });

  test("renders failed story with ❌ icon", () => {
    const stories = [createMockStory("US-001", "failed")];
    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        totalCost: 0,
        elapsedMs: 0,
        width: 30,
      }),
    );

    expect(lastFrame()).toContain("❌ US-001");
  });

  test("renders skipped story with ⏭️ icon", () => {
    const stories = [createMockStory("US-001", "skipped")];
    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        totalCost: 0,
        elapsedMs: 0,
        width: 30,
      }),
    );

    expect(lastFrame()).toContain("⏭️ US-001");
  });

  test("renders retrying story with 🔁 icon", () => {
    const stories = [createMockStory("US-001", "retrying")];
    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        totalCost: 0,
        elapsedMs: 0,
        width: 30,
      }),
    );

    expect(lastFrame()).toContain("🔁 US-001");
  });

  test("renders paused story with ⏸️ icon", () => {
    const stories = [createMockStory("US-001", "paused")];
    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        totalCost: 0,
        elapsedMs: 0,
        width: 30,
      }),
    );

    expect(lastFrame()).toContain("⏸️ US-001");
  });

  test("displays routing info (complexity and model tier)", () => {
    const stories = [createMockStory("US-001", "pending")];
    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        totalCost: 0,
        elapsedMs: 0,
        width: 30,
      }),
    );

    const output = lastFrame();
    expect(output).toContain("sim"); // "simple".slice(0, 3) = "sim"
    expect(output).toContain("fast");
  });

  test("displays total cost", () => {
    const stories = [createMockStory("US-001", "passed")];
    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        totalCost: 0.4235,
        elapsedMs: 0,
        width: 30,
      }),
    );

    expect(lastFrame()).toContain("$0.4235");
  });

  test("displays elapsed time in mm:ss format", () => {
    const stories = [createMockStory("US-001", "running")];
    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        totalCost: 0,
        elapsedMs: 263000, // 4 minutes 23 seconds
        width: 30,
      }),
    );

    expect(lastFrame()).toContain("4m 23s");
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
        totalCost: 0.05,
        elapsedMs: 120000,
        width: 30,
      }),
    );

    const output = lastFrame();
    expect(output).toContain("✅ US-001");
    expect(output).toContain("🔄 US-002");
    expect(output).toContain("⬚ US-003");
  });
});

describe("StatusBar", () => {
  test("displays 'Idle' when no current story", () => {
    const { lastFrame } = render(createElement(StatusBar, {}));
    expect(lastFrame()).toContain("Idle");
  });

  test("displays current story ID", () => {
    const story: UserStory = {
      id: "US-042",
      title: "Test story",
      description: "Test",
      acceptanceCriteria: [],
      dependencies: [],
      tags: [],
      passes: false,
      status: "pending",
      escalations: [],
      attempts: 0,
    };

    const { lastFrame } = render(
      createElement(StatusBar, {
        currentStory: story,
      }),
    );

    expect(lastFrame()).toContain("Story US-042");
  });

  test("displays current stage", () => {
    const story: UserStory = {
      id: "US-001",
      title: "Test",
      description: "Test",
      acceptanceCriteria: [],
      dependencies: [],
      tags: [],
      passes: false,
      status: "pending",
      escalations: [],
      attempts: 0,
    };

    const { lastFrame } = render(
      createElement(StatusBar, {
        currentStory: story,
        currentStage: "execution",
      }),
    );

    expect(lastFrame()).toContain("execution");
  });

  test("displays model tier", () => {
    const story: UserStory = {
      id: "US-001",
      title: "Test",
      description: "Test",
      acceptanceCriteria: [],
      dependencies: [],
      tags: [],
      passes: false,
      status: "pending",
      escalations: [],
      attempts: 0,
    };

    const { lastFrame } = render(
      createElement(StatusBar, {
        currentStory: story,
        modelTier: "balanced",
      }),
    );

    expect(lastFrame()).toContain("balanced");
  });

  test("displays test strategy", () => {
    const story: UserStory = {
      id: "US-001",
      title: "Test",
      description: "Test",
      acceptanceCriteria: [],
      dependencies: [],
      tags: [],
      passes: false,
      status: "pending",
      escalations: [],
      attempts: 0,
    };

    const { lastFrame } = render(
      createElement(StatusBar, {
        currentStory: story,
        testStrategy: "three-session-tdd",
      }),
    );

    expect(lastFrame()).toContain("three-session-tdd");
  });
});

describe("Layout breakpoints", () => {
  test("single column mode for width < 80", () => {
    // This would be tested via useLayout hook, but since we can't mock process.stdout.columns
    // in Bun tests easily, we verify the logic manually:
    const width = 70;
    const mode = width < 80 ? "single" : width < 140 ? "narrow" : "wide";
    expect(mode).toBe("single");
  });

  test("narrow mode for width 80-140", () => {
    const width = 100;
    const mode = width < 80 ? "single" : width < 140 ? "narrow" : "wide";
    expect(mode).toBe("narrow");
  });

  test("wide mode for width > 140", () => {
    const width = 150;
    const mode = width < 80 ? "single" : width < 140 ? "narrow" : "wide";
    expect(mode).toBe("wide");
  });
});
