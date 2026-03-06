// RE-ARCH: keep
/**
 * Tests for src/worktree/merge.ts
 *
 * Covers: MergeEngine topological sort and merge logic
 */

import { describe, expect, it } from "bun:test";
import { MergeEngine } from "../../src/worktree/merge";
import type { StoryDependencies } from "../../src/worktree/merge";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const mockWorktreeManager = {
  create: async () => {},
  remove: async () => {},
  list: async () => [],
} as any;

// ─────────────────────────────────────────────────────────────────────────────
// MergeEngine.topologicalSort
// ─────────────────────────────────────────────────────────────────────────────

describe("MergeEngine.topologicalSort", () => {
  it("sorts stories with no dependencies", () => {
    const engine = new MergeEngine(mockWorktreeManager);
    const storyIds = ["US-001", "US-002", "US-003"];
    const dependencies: StoryDependencies = {};

    // @ts-expect-error - accessing private method for testing
    const sorted = engine.topologicalSort(storyIds, dependencies);

    expect(sorted.length).toBe(3);
    expect(sorted).toContain("US-001");
    expect(sorted).toContain("US-002");
    expect(sorted).toContain("US-003");
  });

  it("sorts stories with simple linear dependencies", () => {
    const engine = new MergeEngine(mockWorktreeManager);
    const storyIds = ["US-001", "US-002", "US-003"];
    const dependencies: StoryDependencies = {
      "US-002": ["US-001"],
      "US-003": ["US-002"],
    };

    // @ts-expect-error - accessing private method for testing
    const sorted = engine.topologicalSort(storyIds, dependencies);

    expect(sorted).toEqual(["US-001", "US-002", "US-003"]);
  });

  it("sorts stories with multiple dependencies", () => {
    const engine = new MergeEngine(mockWorktreeManager);
    const storyIds = ["US-001", "US-002", "US-003", "US-004"];
    const dependencies: StoryDependencies = {
      "US-003": ["US-001", "US-002"],
      "US-004": ["US-002"],
    };

    // @ts-expect-error - accessing private method for testing
    const sorted = engine.topologicalSort(storyIds, dependencies);

    expect(sorted.length).toBe(4);

    // US-001 and US-002 must come before US-003
    const idx001 = sorted.indexOf("US-001");
    const idx002 = sorted.indexOf("US-002");
    const idx003 = sorted.indexOf("US-003");
    expect(idx001).toBeLessThan(idx003);
    expect(idx002).toBeLessThan(idx003);

    // US-002 must come before US-004
    const idx004 = sorted.indexOf("US-004");
    expect(idx002).toBeLessThan(idx004);
  });

  it("handles diamond dependency pattern", () => {
    const engine = new MergeEngine(mockWorktreeManager);
    const storyIds = ["US-001", "US-002", "US-003", "US-004"];
    const dependencies: StoryDependencies = {
      "US-002": ["US-001"],
      "US-003": ["US-001"],
      "US-004": ["US-002", "US-003"],
    };

    // @ts-expect-error - accessing private method for testing
    const sorted = engine.topologicalSort(storyIds, dependencies);

    expect(sorted.length).toBe(4);

    // US-001 must come first
    expect(sorted[0]).toBe("US-001");

    // US-002 and US-003 must come before US-004
    const idx002 = sorted.indexOf("US-002");
    const idx003 = sorted.indexOf("US-003");
    const idx004 = sorted.indexOf("US-004");
    expect(idx002).toBeLessThan(idx004);
    expect(idx003).toBeLessThan(idx004);
  });

  it("throws on circular dependency", () => {
    const engine = new MergeEngine(mockWorktreeManager);
    const storyIds = ["US-001", "US-002", "US-003"];
    const dependencies: StoryDependencies = {
      "US-001": ["US-003"],
      "US-002": ["US-001"],
      "US-003": ["US-002"],
    };

    expect(() => {
      // @ts-expect-error - accessing private method for testing
      engine.topologicalSort(storyIds, dependencies);
    }).toThrow("Circular dependency detected");
  });

  it("handles self-circular dependency", () => {
    const engine = new MergeEngine(mockWorktreeManager);
    const storyIds = ["US-001"];
    const dependencies: StoryDependencies = {
      "US-001": ["US-001"],
    };

    expect(() => {
      // @ts-expect-error - accessing private method for testing
      engine.topologicalSort(storyIds, dependencies);
    }).toThrow("Circular dependency detected");
  });

  it("ignores dependencies not in storyIds list", () => {
    const engine = new MergeEngine(mockWorktreeManager);
    const storyIds = ["US-002", "US-003"];
    const dependencies: StoryDependencies = {
      "US-002": ["US-001"], // US-001 not in storyIds
      "US-003": ["US-002"],
    };

    // @ts-expect-error - accessing private method for testing
    const sorted = engine.topologicalSort(storyIds, dependencies);

    // Should sort US-002 before US-003, ignoring missing US-001
    expect(sorted).toEqual(["US-002", "US-003"]);
  });

  it("handles complex dependency graph", () => {
    const engine = new MergeEngine(mockWorktreeManager);
    const storyIds = ["US-001", "US-002", "US-003", "US-004", "US-005"];
    const dependencies: StoryDependencies = {
      "US-002": ["US-001"],
      "US-003": ["US-001"],
      "US-004": ["US-002", "US-003"],
      "US-005": ["US-003"],
    };

    // @ts-expect-error - accessing private method for testing
    const sorted = engine.topologicalSort(storyIds, dependencies);

    expect(sorted.length).toBe(5);
    expect(sorted[0]).toBe("US-001");

    const idx002 = sorted.indexOf("US-002");
    const idx003 = sorted.indexOf("US-003");
    const idx004 = sorted.indexOf("US-004");
    const idx005 = sorted.indexOf("US-005");

    expect(idx002).toBeGreaterThan(0);
    expect(idx003).toBeGreaterThan(0);
    expect(idx002).toBeLessThan(idx004);
    expect(idx003).toBeLessThan(idx004);
    expect(idx003).toBeLessThan(idx005);
  });

  it("handles empty story list", () => {
    const engine = new MergeEngine(mockWorktreeManager);
    const storyIds: string[] = [];
    const dependencies: StoryDependencies = {};

    // @ts-expect-error - accessing private method for testing
    const sorted = engine.topologicalSort(storyIds, dependencies);

    expect(sorted.length).toBe(0);
  });

  it("handles single story", () => {
    const engine = new MergeEngine(mockWorktreeManager);
    const storyIds = ["US-001"];
    const dependencies: StoryDependencies = {};

    // @ts-expect-error - accessing private method for testing
    const sorted = engine.topologicalSort(storyIds, dependencies);

    expect(sorted).toEqual(["US-001"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MergeEngine.mergeAll
// ─────────────────────────────────────────────────────────────────────────────

describe("MergeEngine.mergeAll", () => {
  it("skips stories with failed dependencies", async () => {
    const mockManager = {
      ...mockWorktreeManager,
      remove: async () => {},
    };

    const engine = new MergeEngine(mockManager);

    // Mock merge to fail for US-001
    const originalMerge = engine.merge;
    let callCount = 0;
    engine.merge = async (_projectRoot: string, storyId: string) => {
      callCount++;
      if (storyId === "US-001") {
        return { success: false, conflictFiles: ["file.ts"], retryCount: 0 };
      }
      return { success: true, retryCount: 0 };
    };

    const storyIds = ["US-001", "US-002"];
    const dependencies: StoryDependencies = {
      "US-002": ["US-001"],
    };

    const results = await engine.mergeAll("/tmp/project", storyIds, dependencies);

    expect(results.length).toBe(2);
    expect(results[0].success).toBe(false);
    expect(results[1].success).toBe(false); // Skipped due to failed dependency
    expect(callCount).toBe(1); // Only US-001 was attempted

    // Restore original method
    engine.merge = originalMerge;
  });

  it("continues with remaining stories after one fails", async () => {
    const mockManager = {
      ...mockWorktreeManager,
      remove: async () => {},
    };

    const engine = new MergeEngine(mockManager);

    // Mock merge to fail for US-002 only
    const originalMerge = engine.merge;
    engine.merge = async (_projectRoot: string, storyId: string) => {
      if (storyId === "US-002") {
        return { success: false, conflictFiles: ["file.ts"], retryCount: 0 };
      }
      return { success: true, retryCount: 0 };
    };

    const storyIds = ["US-001", "US-002", "US-003"];
    const dependencies: StoryDependencies = {};

    const results = await engine.mergeAll("/tmp/project", storyIds, dependencies);

    expect(results.length).toBe(3);
    expect(results[0].success).toBe(true); // US-001 succeeds
    expect(results[1].success).toBe(false); // US-002 fails
    expect(results[2].success).toBe(true); // US-003 succeeds

    // Restore original method
    engine.merge = originalMerge;
  });
});
