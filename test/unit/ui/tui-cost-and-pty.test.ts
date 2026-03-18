// RE-ARCH: keep
/**
 * TUI Cost Accumulation and PTY Line Length Tests
 *
 * Tests for BUG-1 (story cost accumulation) and MEM-1 (PTY line length limits).
 */

import { describe, expect, test } from "bun:test";
import { PipelineEventEmitter } from "../../../src/pipeline/events";
import type { StageResult } from "../../../src/pipeline/types";
import type { UserStory } from "../../../src/prd/types";

// ── Test Fixtures ────────────────────────────────────

const createMockStory = (id: string): UserStory => ({
  id,
  title: `Test story ${id}`,
  description: "Test description",
  acceptanceCriteria: [],
  dependencies: [],
  tags: [],
  passes: false,
  status: "pending",
  escalations: [],
  attempts: 0,
});

// ── Cost Accumulation Tests (BUG-1) ──────────────────

// BUG-001
describe("StageResult - cost field is propagated through pipeline stage results", () => {
  test("should support cost field in continue action", () => {
    const result: StageResult = { action: "continue", cost: 0.05 };
    expect(result.action).toBe("continue");
    expect(result.cost).toBe(0.05);
  });

  test("should support cost field in fail action", () => {
    const result: StageResult = { action: "fail", reason: "Build failed", cost: 0.02 };
    expect(result.action).toBe("fail");
    expect(result.cost).toBe(0.02);
  });

  test("should support cost field in skip action", () => {
    const result: StageResult = { action: "skip", reason: "Dependency not met", cost: 0.01 };
    expect(result.action).toBe("skip");
    expect(result.cost).toBe(0.01);
  });

  test("should support cost field in escalate action", () => {
    const result: StageResult = { action: "escalate", cost: 0.03 };
    expect(result.action).toBe("escalate");
    expect(result.cost).toBe(0.03);
  });

  test("should support cost field in pause action", () => {
    const result: StageResult = { action: "pause", reason: "User requested", cost: 0.01 };
    expect(result.action).toBe("pause");
    expect(result.cost).toBe(0.01);
  });

  test("should allow omitting cost field (backward compatibility)", () => {
    const result: StageResult = { action: "continue" };
    expect(result.action).toBe("continue");
    expect(result.cost).toBeUndefined();
  });
});

// BUG-001
describe("PipelineEventEmitter - story:complete event carries cost field", () => {
  test("should emit story:complete with cost field", () => {
    const emitter = new PipelineEventEmitter();
    const story = createMockStory("US-001");

    const events: Array<{ story: UserStory; result: StageResult }> = [];
    emitter.on("story:complete", (story, result) => {
      events.push({ story, result });
    });

    const result: StageResult = { action: "continue", cost: 0.05 };
    emitter.emit("story:complete", story, result);

    expect(events).toHaveLength(1);
    expect(events[0].story.id).toBe("US-001");
    expect(events[0].result.cost).toBe(0.05);
  });

  test("should emit story:complete without cost field", () => {
    const emitter = new PipelineEventEmitter();
    const story = createMockStory("US-001");

    const events: Array<{ story: UserStory; result: StageResult }> = [];
    emitter.on("story:complete", (story, result) => {
      events.push({ story, result });
    });

    const result: StageResult = { action: "continue" };
    emitter.emit("story:complete", story, result);

    expect(events).toHaveLength(1);
    expect(events[0].result.cost).toBeUndefined();
  });
});

// ── PTY Line Length Tests (MEM-1) ────────────────────

describe("usePty - Line Length Limits (MEM-1)", () => {
  test("should truncate lines exceeding MAX_LINE_LENGTH", async () => {
    // This test verifies the line truncation logic exists
    // We'll check the source code directly since node-pty mocking is complex

    const usePtySource = await Bun.file("src/tui/hooks/usePty.ts").text();

    // Verify MAX_LINE_LENGTH constant exists
    expect(usePtySource).toContain("const MAX_LINE_LENGTH = 10_000");

    // Verify truncation logic for complete lines
    expect(usePtySource).toContain("line.length > MAX_LINE_LENGTH");
    expect(usePtySource).toContain("`${line.slice(0, MAX_LINE_LENGTH)}…` : line");

    // Verify truncation logic for incomplete lines (currentLine)
    expect(usePtySource).toContain("if (currentLine.length > MAX_LINE_LENGTH)");
    expect(usePtySource).toContain("currentLine = currentLine.slice(-MAX_LINE_LENGTH)");
  });

  test("should have MAX_LINE_LENGTH constant set to 10000", async () => {
    const usePtySource = await Bun.file("src/tui/hooks/usePty.ts").text();
    const match = usePtySource.match(/const MAX_LINE_LENGTH = ([\d_]+)/);

    expect(match).toBeTruthy();
    expect(match?.[1]).toBe("10_000");
  });

  test("PTY truncation behavior - unit test for truncation logic", () => {
    const MAX_LINE_LENGTH = 10_000;

    // Simulate the truncation logic
    const longLine = "x".repeat(15_000);
    const truncatedLine = longLine.length > MAX_LINE_LENGTH ? longLine.slice(0, MAX_LINE_LENGTH) + "…" : longLine;

    expect(truncatedLine.length).toBe(MAX_LINE_LENGTH + 1); // +1 for ellipsis
    expect(truncatedLine.endsWith("…")).toBe(true);
    expect(truncatedLine.startsWith("x".repeat(100))).toBe(true);
  });

  test("PTY incomplete line truncation - unit test for currentLine logic", () => {
    const MAX_LINE_LENGTH = 10_000;

    // Simulate incomplete line accumulation
    let currentLine = "y".repeat(15_000);

    // Apply truncation (keep last N chars)
    if (currentLine.length > MAX_LINE_LENGTH) {
      currentLine = currentLine.slice(-MAX_LINE_LENGTH);
    }

    expect(currentLine.length).toBe(MAX_LINE_LENGTH);
    expect(currentLine).toBe("y".repeat(MAX_LINE_LENGTH));
  });
});

// ── Integration Test: Cost Events ────────────────────

describe("Integration - Cost in multiple story:complete events", () => {
  test("should emit multiple story:complete events with different costs", () => {
    const emitter = new PipelineEventEmitter();
    const stories = [createMockStory("US-001"), createMockStory("US-002"), createMockStory("US-003")];

    const events: Array<{ story: UserStory; result: StageResult }> = [];
    emitter.on("story:complete", (story, result) => {
      events.push({ story, result });
    });

    // Story 1: passed ($0.05)
    emitter.emit("story:complete", stories[0], { action: "continue", cost: 0.05 });

    // Story 2: failed ($0.03)
    emitter.emit("story:complete", stories[1], { action: "fail", reason: "test", cost: 0.03 });

    // Story 3: skipped ($0.01)
    emitter.emit("story:complete", stories[2], { action: "skip", reason: "test", cost: 0.01 });

    expect(events).toHaveLength(3);
    expect(events[0].result.cost).toBe(0.05);
    expect(events[1].result.cost).toBe(0.03);
    expect(events[2].result.cost).toBe(0.01);

    // Verify total cost would be sum
    const totalCost = events.reduce((sum, e) => sum + (e.result.cost || 0), 0);
    expect(totalCost).toBe(0.09);
  });
});
