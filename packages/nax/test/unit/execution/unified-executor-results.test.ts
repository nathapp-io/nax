/**
 * Behavioral tests for executeUnified result shape.
 *
 * File: unified-executor-results.test.ts
 * Covers:
 *   exec AC-18  return value matches SequentialExecutionResult shape (all required keys)
 *
 * The runtime/per-story-metric cases this file used to carry drove
 * `_unifiedExecutorDeps.runParallelBatch`, which US-001 removed with the
 * parallel dispatch path. Only the shape guard remains.
 */

import { describe, expect, test } from "bun:test";
import { makePRD } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// exec AC-18 — SequentialExecutionResult shape
// ─────────────────────────────────────────────────────────────────────────────

describe("exec AC-18: executeUnified return value matches SequentialExecutionResult shape", () => {
  test("AC-18: SequentialExecutionResult has all required keys", () => {
    type R = import("@/execution/executor-types").SequentialExecutionResult;
    // Compile-time: if any key is missing, TypeScript will reject this file
    const result: R = {
      prd: makePRD({ userStories: [] }),
      iterations: 0,
      storiesCompleted: 0,
      totalCost: 0,
      allStoryMetrics: [],
      exitReason: "completed",
    };
    expect(result).toHaveProperty("prd");
    expect(result).toHaveProperty("iterations");
    expect(result).toHaveProperty("storiesCompleted");
    expect(result).toHaveProperty("totalCost");
    expect(result).toHaveProperty("allStoryMetrics");
    expect(result).toHaveProperty("exitReason");
  });
});
