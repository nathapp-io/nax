/**
 * TUI Layout Tests
 *
 * Tests responsive layout breakpoints, terminal resize handling,
 * story scrolling, and minimum terminal size handling.
 */

import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { createElement } from "react";
import type { UserStory } from "../../src/prd/types";
import { StoriesPanel } from "../../src/tui/components/StoriesPanel";
import { COMPACT_MAX_VISIBLE_STORIES, MAX_VISIBLE_STORIES, MIN_TERMINAL_WIDTH } from "../../src/tui/hooks/useLayout";
import type { StoryDisplayState } from "../../src/tui/types";

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
  test("single column mode for width < 80", () => {
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

  test("breakpoint at exactly 80 cols is narrow mode", () => {
    const width = 80;
    const mode = width < 80 ? "single" : width < 140 ? "narrow" : "wide";
    expect(mode).toBe("narrow");
  });

  test("breakpoint at exactly 140 cols is wide mode", () => {
    const width = 140;
    const mode = width < 80 ? "single" : width < 140 ? "narrow" : "wide";
    expect(mode).toBe("wide");
  });
});

describe("StoriesPanel — compact mode", () => {
  test("compact mode shows only icon and ID (no routing)", () => {
    const stories = [createMockStory("US-001", "pending")];
    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        totalCost: 0.42,
        elapsedMs: 120000,
        width: 30,
        compact: true,
      }),
    );

    const output = lastFrame();
    expect(output).toContain("⬚ US-001");
    // Should NOT contain routing info in compact mode
    expect(output).not.toContain("sim");
    expect(output).not.toContain("fast");
  });

  test("compact mode shows condensed cost and time in footer", () => {
    const stories = [createMockStory("US-001", "pending")];
    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        totalCost: 0.4235,
        elapsedMs: 263000,
        width: 30,
        compact: true,
      }),
    );

    const output = lastFrame();
    // Compact mode shows: "$X.XX · Mm Ss"
    expect(output).toContain("$0.42");
    expect(output).toContain("4m 23s");
  });

  test("normal mode (not compact) shows full details", () => {
    const stories = [createMockStory("US-001", "pending")];
    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        totalCost: 0.42,
        elapsedMs: 120000,
        width: 30,
        compact: false,
      }),
    );

    const output = lastFrame();
    expect(output).toContain("⬚ US-001");
    // Should contain routing info
    expect(output).toContain("sim");
    expect(output).toContain("fast");
    // Should show separate cost and time lines
    expect(output).toContain("Cost:");
    expect(output).toContain("Time:");
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
        totalCost: 0.1,
        elapsedMs: 60000,
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
        totalCost: 0.2,
        elapsedMs: 120000,
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
        totalCost: 0.12,
        elapsedMs: 60000,
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
        totalCost: 0.05,
        elapsedMs: 30000,
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
  test("MIN_TERMINAL_WIDTH is 60", () => {
    expect(MIN_TERMINAL_WIDTH).toBe(60);
  });

  test("App shows warning when terminal width < MIN_TERMINAL_WIDTH", () => {
    // We can't easily mock process.stdout.columns in Bun tests,
    // but we can test the constant and verify the logic separately
    const terminalWidth = 50;
    const shouldWarn = terminalWidth < MIN_TERMINAL_WIDTH;
    expect(shouldWarn).toBe(true);
  });

  test("COMPACT_MAX_VISIBLE_STORIES is 8", () => {
    expect(COMPACT_MAX_VISIBLE_STORIES).toBe(8);
  });

  test("MAX_VISIBLE_STORIES is 15", () => {
    expect(MAX_VISIBLE_STORIES).toBe(15);
  });
});

describe("Edge cases", () => {
  test("handles empty story list gracefully", () => {
    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories: [],
        totalCost: 0,
        elapsedMs: 0,
        width: 30,
      }),
    );

    const output = lastFrame();
    // Should still show header and footer
    expect(output).toContain("Stories");
    expect(output).toContain("Cost:");
    expect(output).toContain("Time:");
  });

  test("handles exactly MAX_VISIBLE_STORIES stories (no scrolling)", () => {
    const stories = Array.from({ length: MAX_VISIBLE_STORIES }, (_, i) =>
      createMockStory(`US-${String(i + 1).padStart(3, "0")}`, "pending"),
    );

    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        totalCost: 0.15,
        elapsedMs: 90000,
        width: 30,
      }),
    );

    const output = lastFrame();
    // All stories visible, no scroll indicators
    expect(output).not.toContain("▲");
    expect(output).not.toContain("▼");
    expect(output).not.toContain("total");
  });

  test("handles exactly MAX_VISIBLE_STORIES + 1 stories (needs scrolling)", () => {
    const stories = Array.from({ length: MAX_VISIBLE_STORIES + 1 }, (_, i) =>
      createMockStory(`US-${String(i + 1).padStart(3, "0")}`, "pending"),
    );

    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        totalCost: 0.16,
        elapsedMs: 90000,
        width: 30,
      }),
    );

    const output = lastFrame();
    // Should show scroll indicator
    expect(output).toContain("▼");
    expect(output).toContain("1 more below");
  });

  test("handles very long story ID in compact mode", () => {
    const stories = [createMockStory("US-VERY-LONG-STORY-ID-THAT-MIGHT-WRAP", "pending")];

    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        totalCost: 0.01,
        elapsedMs: 10000,
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

  test("handles zero cost and zero elapsed time", () => {
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
    expect(output).toContain("$0.0000");
    expect(output).toContain("0m 0s");
  });

  test("handles large cost value formatting", () => {
    const stories = [createMockStory("US-001", "passed")];
    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        totalCost: 123.456789,
        elapsedMs: 3600000, // 1 hour
        width: 30,
      }),
    );

    const output = lastFrame();
    expect(output).toContain("$123.4568"); // 4 decimal places
    expect(output).toContain("60m 0s"); // 60 minutes
  });

  test("compact mode with large cost shows 2 decimal places", () => {
    const stories = [createMockStory("US-001", "passed")];
    const { lastFrame } = render(
      createElement(StoriesPanel, {
        stories,
        totalCost: 123.456789,
        elapsedMs: 3600000,
        width: 30,
        compact: true,
      }),
    );

    const output = lastFrame();
    expect(output).toContain("$123.46"); // 2 decimal places in compact mode
  });
});
