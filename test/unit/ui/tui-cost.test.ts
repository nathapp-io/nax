// RE-ARCH: keep
/**
 * TUI Cost Accumulation Tests
 *
 * Tests for BUG-1 (story cost accumulation).
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
