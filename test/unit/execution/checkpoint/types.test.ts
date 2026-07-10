/**
 * Type-level checks for the checkpoint module's public surface.
 *
 * Verifies the types documented in the story are exported:
 *   - TreeState { headSha, dirtyDigest }
 *   - StoryCheckpoint { storyId, greenPhases, tree }
 *   - PhaseKind already exists in story-orchestrator/types.ts
 */

import { describe, expect, test } from "bun:test";
import type { StoryCheckpoint, TreeState } from "@/execution";
import type { PhaseKind } from "@/execution";

describe("checkpoint types", () => {
  test("TreeState has headSha and dirtyDigest string fields", () => {
    const t: TreeState = { headSha: "abc", dirtyDigest: "def" };
    expect(t.headSha).toBe("abc");
    expect(t.dirtyDigest).toBe("def");
  });

  test("StoryCheckpoint has storyId, greenPhases, and tree fields", () => {
    const sc: StoryCheckpoint = {
      storyId: "US-001",
      greenPhases: ["test-writer" satisfies PhaseKind],
      tree: { headSha: "h", dirtyDigest: "d" },
    };
    expect(sc.storyId).toBe("US-001");
    expect(sc.greenPhases).toHaveLength(1);
    expect(sc.tree.headSha).toBe("h");
  });
});