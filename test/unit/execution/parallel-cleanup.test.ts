/**
 * RED tests for MFX-003: Parallel executor cleanup
 *
 * BUG-068: Remove duplicate "Parallel execution complete" log line.
 * BUG-069: Fix batch summary field semantics (successful → pipelinePassed, add merged).
 * BUG-071: Fix story.complete duration field naming (durationMs → runElapsedMs).
 *
 * These tests fail until the implementation is applied.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const SRC = join(import.meta.dir, "../../../src");

async function readSrc(relativePath: string): Promise<string> {
  return await Bun.file(join(SRC, relativePath)).text();
}

// ─────────────────────────────────────────────────────────────────────────────
// BUG-068: "Parallel execution complete" must be logged exactly once
// ─────────────────────────────────────────────────────────────────────────────

describe("BUG-068: no duplicate 'Parallel execution complete' log", () => {
  test("the log message appears exactly once across parallel.ts and parallel-executor.ts", async () => {
    const parallelSrc = await readSrc("execution/parallel.ts");
    const executorSrc = await readSrc("execution/parallel-executor.ts");

    const combined = parallelSrc + executorSrc;
    const occurrences = (combined.match(/Parallel execution complete/g) ?? []).length;

    // Currently 2 (one in each file) — must be exactly 1 after fix
    expect(occurrences).toBe(1);
  });

  test("parallel.ts alone does not duplicate the log in both the merge loop and function return", async () => {
    const src = await readSrc("execution/parallel.ts");
    const occurrences = (src.match(/Parallel execution complete/g) ?? []).length;

    // parallel.ts may keep at most one occurrence
    expect(occurrences).toBeLessThanOrEqual(1);
  });

  test("parallel-executor.ts alone does not duplicate the log in both the merge loop and function return", async () => {
    const src = await readSrc("execution/parallel-executor.ts");
    const occurrences = (src.match(/Parallel execution complete/g) ?? []).length;

    // parallel-executor.ts may keep at most one occurrence
    expect(occurrences).toBeLessThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG-069: batch summary field semantics
// ─────────────────────────────────────────────────────────────────────────────

describe("BUG-069: batch summary uses pipelinePassed, merged, mergeConflicts — not successful", () => {
  test("batch complete log uses 'pipelinePassed' field (not 'successful')", async () => {
    const src = await readSrc("execution/parallel.ts");

    // After fix: batch log must contain pipelinePassed
    expect(src).toMatch(/pipelinePassed\s*:/);
  });

  test("batch complete log uses 'merged' field for actually-merged stories", async () => {
    const src = await readSrc("execution/parallel.ts");

    // After fix: batch log must contain merged
    expect(src).toMatch(/\bmerged\s*:/);
  });

  test("batch complete log does NOT use raw 'successful' as a field key", async () => {
    const src = await readSrc("execution/parallel.ts");

    // The old field name must be gone from batch summary log
    // We match "successful:" as a standalone log field key
    const batchLogMatch = src.match(/Batch.*?complete[\s\S]*?\{([\s\S]*?)\}/);
    if (batchLogMatch) {
      // The captured block inside the batch log object should not have a "successful:" key
      expect(batchLogMatch[1]).not.toMatch(/\bsuccessful\s*:/);
    } else {
      // If we can't find the batch log block, check the whole file for the old field
      expect(src).not.toMatch(/\bsuccessful\s*:\s*batchResult\.successfulStories/);
    }
  });

  test("batch complete log uses 'mergeConflicts' field (not 'conflicts')", async () => {
    const src = await readSrc("execution/parallel.ts");

    // After fix: should use mergeConflicts not plain conflicts
    expect(src).toMatch(/mergeConflicts\s*:/);
  });

  test("ParallelBatchResult interface does not export 'successfulStories' at the top level", async () => {
    const src = await readSrc("execution/parallel.ts");

    // The old field name 'successfulStories' should be renamed or internal
    // After fix: 'successfulStories' field should not exist in ParallelBatchResult
    // We check the interface definition block
    const interfaceBlock = src.match(/interface ParallelBatchResult\s*\{([\s\S]*?)\}/);
    if (interfaceBlock) {
      // successfulStories should not be in the interface after rename
      expect(interfaceBlock[1]).not.toContain("successfulStories");
    } else {
      // Interface must still exist
      expect(src).toContain("ParallelBatchResult");
    }
  });

  test("ParallelBatchResult interface contains pipelinePassed field", async () => {
    const src = await readSrc("execution/parallel.ts");

    const interfaceBlock = src.match(/interface ParallelBatchResult\s*\{([\s\S]*?)\}/);
    expect(interfaceBlock).not.toBeNull();
    if (interfaceBlock) {
      expect(interfaceBlock[1]).toContain("pipelinePassed");
    }
  });

  test("ParallelBatchResult interface contains merged field", async () => {
    const src = await readSrc("execution/parallel.ts");

    const interfaceBlock = src.match(/interface ParallelBatchResult\s*\{([\s\S]*?)\}/);
    expect(interfaceBlock).not.toBeNull();
    if (interfaceBlock) {
      expect(interfaceBlock[1]).toMatch(/\bmerged\b/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG-071: story.complete duration field naming
// ─────────────────────────────────────────────────────────────────────────────

describe("BUG-071: story.complete durationMs renamed to runElapsedMs", () => {
  test("pipeline-result-handler.ts story.complete log uses runElapsedMs not durationMs", async () => {
    const src = await readSrc("execution/pipeline-result-handler.ts");

    // After fix: story.complete log must use runElapsedMs for run-elapsed field
    expect(src).toMatch(/runElapsedMs\s*:/);
  });

  test("pipeline-result-handler.ts story.complete log does NOT use durationMs for run elapsed", async () => {
    const src = await readSrc("execution/pipeline-result-handler.ts");

    // The old durationMs in the story.complete log context should be gone
    // story.complete block: logger?.info("story.complete", ..., { durationMs: ... })
    const storyCompleteBlock = src.match(/story\.complete[\s\S]{0,300}durationMs/);
    expect(storyCompleteBlock).toBeNull();
  });

  test("StoryCompletedEvent in event-bus.ts uses runElapsedMs field", async () => {
    const src = await readSrc("pipeline/event-bus.ts");

    // The event interface must use runElapsedMs
    expect(src).toMatch(/runElapsedMs\s*:\s*number/);
  });

  test("StoryCompletedEvent in event-bus.ts does NOT have durationMs field", async () => {
    const src = await readSrc("pipeline/event-bus.ts");

    // After fix: durationMs must not appear in StoryCompletedEvent
    const completedEventBlock = src.match(/interface StoryCompletedEvent\s*\{([\s\S]*?)\}/);
    expect(completedEventBlock).not.toBeNull();
    if (completedEventBlock) {
      expect(completedEventBlock[1]).not.toMatch(/\bdurationMs\b/);
    }
  });

  test("pipeline-result-handler.ts emits runElapsedMs in story:completed event", async () => {
    const src = await readSrc("execution/pipeline-result-handler.ts");

    // The pipelineEventBus.emit call for story:completed must use runElapsedMs
    expect(src).toMatch(/story:completed[\s\S]{0,200}runElapsedMs/);
  });

  test("reporters.ts consumes runElapsedMs not durationMs from story:completed event", async () => {
    const src = await readSrc("pipeline/subscribers/reporters.ts");

    // After fix: reporters subscriber must read ev.runElapsedMs
    expect(src).toMatch(/ev\.runElapsedMs/);
  });

  test("reporters.ts does NOT reference ev.durationMs from story:completed event", async () => {
    const src = await readSrc("pipeline/subscribers/reporters.ts");

    // The old field reference should be gone
    expect(src).not.toMatch(/ev\.durationMs/);
  });

  test("StoryCompleteEvent in plugins/types.ts uses runElapsedMs field", async () => {
    const src = await readSrc("plugins/types.ts");

    // Plugin reporter type must be updated
    expect(src).toMatch(/runElapsedMs\s*:/);
  });

  test("StoryCompleteEvent in plugins/types.ts does NOT have durationMs field in reporter event", async () => {
    const src = await readSrc("plugins/types.ts");

    // Find the StoryCompleteEvent interface block
    const eventBlock = src.match(/StoryCompleteEvent[\s\S]{0,400}/);
    if (eventBlock) {
      // After the rename, durationMs should not appear as a field
      expect(eventBlock[0]).not.toMatch(/^\s*durationMs\s*:/m);
    } else {
      // Must still have the type defined
      expect(src).toContain("StoryCompleteEvent");
    }
  });
});
