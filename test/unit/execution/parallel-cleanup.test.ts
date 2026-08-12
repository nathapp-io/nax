/**
 * Tests for MFX-003: Parallel executor cleanup
 *
 * BUG-068: Remove duplicate "Parallel execution complete" log line.
 * BUG-069: Fix batch summary field semantics (successful -> pipelinePassed, add merged).
 * BUG-071: Fix story.complete duration field naming (durationMs -> runElapsedMs).
 *
 * NOTE: The active parallel implementation lives in parallel-batch.ts and
 * parallel-worker.ts. The retired parallel coordinator was removed by BUG-40.
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

describe("batch summary uses pipelinePassed and merged fields instead of successful", () => {
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
