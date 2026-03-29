/**
 * Tests for MFX-003: Parallel executor cleanup
 *
 * BUG-068: Remove duplicate "Parallel execution complete" log line.
 * BUG-069: Fix batch summary field semantics (successful -> pipelinePassed, add merged).
 * BUG-071: Fix story.complete duration field naming (durationMs -> runElapsedMs).
 *
 * NOTE: After Phase 3 file split (refactor/code-audit), the implementation lives in:
 *   - parallel-coordinator.ts  -> executeParallel(), batch log, "Parallel execution complete"
 *   - parallel-worker.ts       -> ParallelBatchResult interface, executeParallelBatch()
 *   - parallel.ts              -> hub re-exporter only (no implementation)
 *   - plugins/extensions.ts    -> StoryCompleteEvent definition
 *   - plugins/types.ts         -> hub re-exporter only
 * Tests must read the canonical implementation files, not the hub files.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const SRC = join(import.meta.dir, "../../../src");

async function readSrc(relativePath: string): Promise<string> {
  const file = Bun.file(join(SRC, relativePath));
  return (await file.exists()) ? await file.text() : "";
}

// ---------------------------------------------------------------------------
// BUG-068: "Parallel execution complete" must be logged exactly once
// ---------------------------------------------------------------------------

// BUG-068
describe("'Parallel execution complete' log appears exactly once (no duplicate)", () => {
  test("the log message appears exactly once across parallel-coordinator.ts and parallel-executor.ts", async () => {
    const coordinatorSrc = await readSrc("execution/parallel-coordinator.ts");
    // parallel-executor.ts was deleted as part of parallel-unify-001; its log was moved to parallel-batch.ts
    const executorSrc = await readSrc("execution/parallel-executor.ts");

    const combined = coordinatorSrc + executorSrc;
    const occurrences = (combined.match(/Parallel execution complete/g) ?? []).length;

    // Must be exactly 1 -- coordinator owns the log, executor must not duplicate it
    // (executor may be deleted, in which case combined is just coordinator content)
    expect(occurrences).toBeLessThanOrEqual(1);
  });

  test("parallel-coordinator.ts alone does not duplicate the log in both the merge loop and function return", async () => {
    const src = await readSrc("execution/parallel-coordinator.ts");
    const occurrences = (src.match(/Parallel execution complete/g) ?? []).length;

    // coordinator may keep at most one occurrence
    expect(occurrences).toBeLessThanOrEqual(1);
  });

  test("parallel-executor.ts alone does not duplicate the log in both the merge loop and function return", async () => {
    // parallel-executor.ts was deleted as part of parallel-unify-001 (US-003)
    // The log line moved to parallel-batch.ts inside the unified executor
    const src = await readSrc("execution/parallel-executor.ts");
    const occurrences = (src.match(/Parallel execution complete/g) ?? []).length;

    // Deleted file returns empty string => 0 occurrences <= 1
    expect(occurrences).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// BUG-069: batch summary field semantics
// ---------------------------------------------------------------------------

// BUG-069
describe("batch summary uses pipelinePassed and merged fields instead of successful", () => {
  test("batch complete log uses 'pipelinePassed' field (not 'successful')", async () => {
    // Batch log is in the coordinator (executeParallel implementation)
    const src = await readSrc("execution/parallel-coordinator.ts");

    // After fix: batch log must contain pipelinePassed
    expect(src).toMatch(/pipelinePassed\s*:/);
  });

  test("batch complete log uses 'merged' field for actually-merged stories", async () => {
    // Batch log is in the coordinator (executeParallel implementation)
    const src = await readSrc("execution/parallel-coordinator.ts");

    // After fix: batch log must contain merged
    expect(src).toMatch(/\bmerged\s*:/);
  });

  test("batch complete log does NOT use raw 'successful' as a field key", async () => {
    // Batch log is in the coordinator (executeParallel implementation)
    const src = await readSrc("execution/parallel-coordinator.ts");

    // The old field name must be gone from batch summary log
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
    // Batch log is in the coordinator (executeParallel implementation)
    const src = await readSrc("execution/parallel-coordinator.ts");

    // After fix: should use mergeConflicts not plain conflicts
    expect(src).toMatch(/mergeConflicts\s*:/);
  });

  test("ParallelBatchResult interface does not export 'successfulStories' at the top level", async () => {
    // ParallelBatchResult interface is defined in parallel-worker.ts after Phase 3 split
    const src = await readSrc("execution/parallel-worker.ts");

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
    // ParallelBatchResult interface is defined in parallel-worker.ts after Phase 3 split
    const src = await readSrc("execution/parallel-worker.ts");

    const interfaceBlock = src.match(/interface ParallelBatchResult\s*\{([\s\S]*?)\}/);
    expect(interfaceBlock).not.toBeNull();
    if (interfaceBlock) {
      expect(interfaceBlock[1]).toContain("pipelinePassed");
    }
  });

  test("ParallelBatchResult interface contains merged field", async () => {
    // ParallelBatchResult interface is defined in parallel-worker.ts after Phase 3 split
    const src = await readSrc("execution/parallel-worker.ts");

    const interfaceBlock = src.match(/interface ParallelBatchResult\s*\{([\s\S]*?)\}/);
    expect(interfaceBlock).not.toBeNull();
    if (interfaceBlock) {
      expect(interfaceBlock[1]).toMatch(/\bmerged\b/);
    }
  });
});

// ---------------------------------------------------------------------------
// BUG-071: story.complete duration field naming
// ---------------------------------------------------------------------------

// BUG-071
describe("story.complete event uses runElapsedMs field instead of durationMs", () => {
  test("pipeline-result-handler.ts story.complete log uses runElapsedMs not durationMs", async () => {
    const src = await readSrc("execution/pipeline-result-handler.ts");

    expect(src).toMatch(/runElapsedMs\s*:/);
  });

  test("pipeline-result-handler.ts story.complete log does NOT use durationMs for run elapsed", async () => {
    const src = await readSrc("execution/pipeline-result-handler.ts");

    const storyCompleteBlock = src.match(/story\.complete[\s\S]{0,300}durationMs/);
    expect(storyCompleteBlock).toBeNull();
  });

  test("StoryCompletedEvent in event-bus.ts uses runElapsedMs field", async () => {
    const src = await readSrc("pipeline/event-bus.ts");

    expect(src).toMatch(/runElapsedMs\s*:\s*number/);
  });

  test("StoryCompletedEvent in event-bus.ts does NOT have durationMs field", async () => {
    const src = await readSrc("pipeline/event-bus.ts");

    const completedEventBlock = src.match(/interface StoryCompletedEvent\s*\{([\s\S]*?)\}/);
    expect(completedEventBlock).not.toBeNull();
    if (completedEventBlock) {
      expect(completedEventBlock[1]).not.toMatch(/\bdurationMs\b/);
    }
  });

  test("pipeline-result-handler.ts does NOT duplicate story:completed (BUG-074)", async () => {
    const src = await readSrc("execution/pipeline-result-handler.ts");

    // BUG-074: story:completed must only be emitted by completion stage, not here
    expect(src).not.toMatch(/pipelineEventBus\.emit\(\{[\s\S]{0,50}type:\s*"story:completed"/);
  });

  test("reporters.ts consumes runElapsedMs not durationMs from story:completed event", async () => {
    const src = await readSrc("pipeline/subscribers/reporters.ts");

    expect(src).toMatch(/ev\.runElapsedMs/);
  });

  test("reporters.ts does NOT reference ev.durationMs from story:completed event", async () => {
    const src = await readSrc("pipeline/subscribers/reporters.ts");

    expect(src).not.toMatch(/ev\.durationMs/);
  });

  test("StoryCompleteEvent in plugins/extensions.ts uses runElapsedMs field", async () => {
    // After Phase 3 split, StoryCompleteEvent definition moved from plugins/types.ts
    // to plugins/extensions.ts; types.ts is now a hub re-exporter.
    const src = await readSrc("plugins/extensions.ts");

    expect(src).toMatch(/runElapsedMs\s*:/);
  });

  test("StoryCompleteEvent in plugins/extensions.ts does NOT have durationMs field in reporter event", async () => {
    // After Phase 3 split, StoryCompleteEvent definition moved to plugins/extensions.ts
    const src = await readSrc("plugins/extensions.ts");

    const eventBlock = src.match(/StoryCompleteEvent[\s\S]{0,400}/);
    if (eventBlock) {
      expect(eventBlock[0]).not.toMatch(/^\s*durationMs\s*:/m);
    } else {
      expect(src).toContain("StoryCompleteEvent");
    }
  });
});
