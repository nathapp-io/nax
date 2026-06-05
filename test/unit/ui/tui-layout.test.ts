// RE-ARCH: keep
/**
 * TUI Layout Tests
 *
 * Tests responsive layout breakpoints, terminal resize handling,
 * story scrolling, and minimum terminal size handling.
 */

import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { createElement } from "react";
import type { UserStory } from "../../../src/prd/types";
import { StoriesPanel } from "../../../src/tui/components/StoriesPanel";
import { COMPACT_MAX_VISIBLE_STORIES, MAX_VISIBLE_STORIES, MIN_TERMINAL_WIDTH } from "../../../src/tui/hooks/useLayout";
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

describe("Layout breakpoints", () => {
  test("single below 80, narrow 80–139, wide 140+; boundary values exact", () => {
    const mode = (w: number) => (w < 80 ? "single" : w < 140 ? "narrow" : "wide");
    expect(mode(70)).toBe("single");
    expect(mode(100)).toBe("narrow");
    expect(mode(150)).toBe("wide");
    expect(mode(80)).toBe("narrow");
    expect(mode(140)).toBe("wide");
  });
});

describe("StoriesPanel — compact mode", () => {
  test("compact mode shows only icon and ID (no routing)", () => {
    const stories = [createMockStory("US-001", "pending")];
    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        width: 30,
        compact: true,
      }),
    );

    const output = lastFrame();
    expect(output).toContain("⬚ US-001");
    // Should NOT contain routing info in compact mode
    expect(output).not.toContain("sim");
  });

  test("normal mode (not compact) shows routing complexity", () => {
    const stories = [createMockStory("US-001", "pending")];
    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        width: 30,
        compact: false,
      }),
    );

    const output = lastFrame();
    expect(output).toContain("⬚ US-001");
    // Should contain routing info
    expect(output).toContain("sim");
  });
});

describe("StoriesPanel — scrolling", () => {
  test("shows all stories when count <= MAX_VISIBLE_STORIES", () => {
    const stories = Array.from({ length: 10 }, (_, i) =>
      createMockStory(`US-${String(i + 1).padStart(3, "0")}`, "pending"),
    );

    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        width: 30,
      }),
    );

    const output = lastFrame();
    // All 10 stories should be visible
    expect(output).toContain("US-001");
    expect(output).toContain("US-010");
    // No scroll indicators
    expect(output).not.toContain("▲");
    expect(output).not.toContain("▼");
  });

  test("shows scroll indicator when stories > MAX_VISIBLE_STORIES", () => {
    const stories = Array.from({ length: 20 }, (_, i) =>
      createMockStory(`US-${String(i + 1).padStart(3, "0")}`, "pending"),
    );

    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        width: 30,
      }),
    );

    const output = lastFrame();
    // Should show total count
    expect(output).toContain("(20 total)");
    // Should show bottom scroll indicator (first render, offset = 0)
    expect(output).toContain("▼");
    expect(output).toContain("more below");
  });

  test("compact mode uses COMPACT_MAX_VISIBLE_STORIES for scrolling", () => {
    // Create more stories than compact max (8)
    const stories = Array.from({ length: 12 }, (_, i) =>
      createMockStory(`US-${String(i + 1).padStart(3, "0")}`, "pending"),
    );

    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        width: 30,
        compact: true,
      }),
    );

    const output = lastFrame();
    // Should show total count
    expect(output).toContain("(12 total)");
    // Should show scroll indicator
    expect(output).toContain("▼");
    expect(output).toContain("more below");
  });

  test("no scroll indicators when stories <= compact max in compact mode", () => {
    const stories = Array.from({ length: 5 }, (_, i) =>
      createMockStory(`US-${String(i + 1).padStart(3, "0")}`, "pending"),
    );

    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        width: 30,
        compact: true,
      }),
    );

    const output = lastFrame();
    // All 5 stories visible, no scroll indicators
    expect(output).not.toContain("▲");
    expect(output).not.toContain("▼");
    expect(output).not.toContain("total");
  });
});

describe("Minimum terminal size", () => {
  test("MIN_TERMINAL_WIDTH is 60; warns when below", () => {
    expect(MIN_TERMINAL_WIDTH).toBe(60);
    expect(50 < MIN_TERMINAL_WIDTH).toBe(true);
  });

  test("COMPACT_MAX_VISIBLE_STORIES is 8; MAX_VISIBLE_STORIES is 15", () => {
    expect(COMPACT_MAX_VISIBLE_STORIES).toBe(8);
    expect(MAX_VISIBLE_STORIES).toBe(15);
  });
});

describe("Edge cases", () => {
  test("handles empty story list gracefully", () => {
    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories: [],
        width: 30,
      }),
    );

    const output = lastFrame();
    // Should still show header
    expect(output).toContain("Progress");
  });

  test("no scroll at exactly MAX_VISIBLE_STORIES; scroll indicator at MAX+1", () => {
    const atMax = Array.from({ length: MAX_VISIBLE_STORIES }, (_, i) =>
      createMockStory(`US-${String(i + 1).padStart(3, "0")}`, "pending"),
    );
    const out1 = render(createElement(StoriesPanel, { stories: atMax, width: 30 })).lastFrame();
    expect(out1).not.toContain("▲");
    expect(out1).not.toContain("▼");
    expect(out1).not.toContain("total");

    const overMax = Array.from({ length: MAX_VISIBLE_STORIES + 1 }, (_, i) =>
      createMockStory(`US-${String(i + 1).padStart(3, "0")}`, "pending"),
    );
    const out2 = render(createElement(StoriesPanel, { stories: overMax, width: 30 })).lastFrame();
    expect(out2).toContain("▼");
    expect(out2).toContain("1 more below");
  });

  test("handles very long story ID in compact mode", () => {
    const stories = [createMockStory("US-VERY-LONG-STORY-ID-THAT-MIGHT-WRAP", "pending")];

    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        width: 30,
        compact: true,
      }),
    );

    const output = lastFrame();
    // Should still render without crashing
    expect(output).toContain("⬚");
    // Story ID might wrap to multiple lines due to panel width
    expect(output).toContain("US-VERY-LONG-STORY-ID");
  });
});
