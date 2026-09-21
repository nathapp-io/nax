/**
 * Unit tests for US-002 — MergeEngine.merge/mergeAll take WorktreeId while
 * keeping MergeResult.storyId and StoryDependencies keyed by raw story IDs.
 *
 * AC-5: MergeEngine.merge given the identity `story-f-US-001` invokes git
 *       with the branch name `nax/story-f-US-001`.
 * AC-6: MergeEngine.mergeAll returns a MergeResult for storyId `US-001`
 *       carrying `storyId` equal to the RAW string `US-001` (not the
 *       composed `story-f-US-001`).
 * AC-7: MergeEngine.mergeAll orders two stories by a dependency map keyed
 *       by raw story IDs — merging the dependency before the dependent.
 * AC-8: MergeEngine.mergeAll on a story whose raw-ID dependency failed in
 *       the same call reports it with `success: false`, `failureKind:
 *       "error"`, no retry, and an unmerged message.
 *
 * Story: US-002 — The worktree API takes the identity.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { makeSpawn } from "@test/helpers";
import { _gitDeps } from "@/utils/git";
import type { StoryDependencies, WorktreeId } from "@/worktree";
import { deriveStoryWorktreeId, MergeEngine, WorktreeManager } from "@/worktree";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SAVED_GIT_DEPS_SPAWN = _gitDeps.spawn;

interface FakeProcSpec {
  exit: number;
  stdout?: string;
  stderr?: string;
}

interface SpawnCall {
  cmd: string[];
}

function makeRecordingSpawn(handler: (cmd: readonly string[]) => FakeProcSpec): {
  spawn: typeof _gitDeps.spawn;
  calls: SpawnCall[];
} {
  const spawnStub = makeSpawn(({ cmd }) => {
    const result = handler(cmd);
    return { exitCode: result.exit, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  });
  return {
    spawn: spawnStub.spawn,
    calls: spawnStub.calls.map((c) => ({ cmd: c.cmd as string[] })),
  };
}

afterEach(() => {
  _gitDeps.spawn = SAVED_GIT_DEPS_SPAWN;
});

// Shape produced by the US-002 mergeAll signature. The signature accepts
// `Array<{ storyId, worktreeId }>` directly; the cast marker used during
// pre-fix test-writing is no longer needed.
interface MergeInput {
  storyId: string;
  worktreeId: WorktreeId;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-5 — MergeEngine.merge(WorktreeId) invokes git with branch
//       `nax/<worktreeId>`.
//
// The fix routes through `storyBranchName(worktreeId)` so the branch emitted
// to git is the composed branch. Pre-fix emits `nax/<worktreeId>` (same
// value, different code path) so the assertion shape is the same — the test
// exercises the API surface and pins the composed branch name.
// ─────────────────────────────────────────────────────────────────────────────

describe("US-002 AC-5: MergeEngine.merge accepts a WorktreeId and emits git with the composed branch", () => {
  it("invokes git merge --no-ff with the composed branch nax/<worktreeId>", async () => {
    const calls: SpawnCall[] = [];
    const recorder = makeRecordingSpawn((cmd) => {
      calls.push({ cmd: [...cmd] });
      if (cmd[1] === "rev-parse" && cmd.includes("MERGE_HEAD")) return { exit: 1 };
      if (cmd[1] === "merge" && cmd[2] === "--no-ff") return { exit: 0 };
      return { exit: 0 };
    });
    _gitDeps.spawn = recorder.spawn;

    const manager = new WorktreeManager();
    const engine = new MergeEngine(manager);
    const worktreeId: WorktreeId = deriveStoryWorktreeId("f", "US-001");

    const result = await engine.merge("/fake/repo", worktreeId);

    expect(result.success).toBe(true);
    const mergeCalls = calls.filter((c) => c.cmd[1] === "merge" && c.cmd[2] === "--no-ff");
    expect(mergeCalls.length).toBeGreaterThan(0);
    // The composed branch name MUST be the third positional of `git merge`.
    // US-002's contract pins this as `nax/<worktreeId>` (= `nax/story-f-US-001`).
    for (const call of mergeCalls) {
      expect(call.cmd[3]).toBe("nax/story-f-US-001");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-6/AC-7/AC-8 — MergeEngine.mergeAll accepts
//   Array<{ storyId: string; worktreeId: WorktreeId }>
// and keeps MergeResult.storyId keyed by raw story IDs.
//
// Pre-fix the signature is `(projectRoot, storyIds: string[], deps)`. Post-fix
// the signature is `(projectRoot, stories: Array<{ storyId, worktreeId }>, deps)`.
// Passing the new shape against the pre-fix signature requires a single cast
// (centralized in `storiesAsLegacyStrings`); the pre-fix loop iterates objects
// as strings, producing `storyId = <object>` instead of the raw storyId. After
// the implementer narrows the signature the cast goes away.
// ─────────────────────────────────────────────────────────────────────────────

describe("US-002 AC-6/AC-7/AC-8: MergeEngine.mergeAll takes {storyId, worktreeId} pairs", () => {
  it("AC-6: returns a MergeResult for each story whose storyId is the RAW storyId (not the composed worktreeId)", async () => {
    _gitDeps.spawn = makeRecordingSpawn((cmd) => {
      if (cmd[1] === "rev-parse" && cmd.includes("MERGE_HEAD")) return { exit: 1 };
      if (cmd[1] === "merge" && cmd[2] === "--no-ff") return { exit: 0 };
      return { exit: 0 };
    }).spawn;

    const engine = new MergeEngine(new WorktreeManager());

    const stories: MergeInput[] = [
      { storyId: "US-001", worktreeId: deriveStoryWorktreeId("f", "US-001") },
      { storyId: "US-002", worktreeId: deriveStoryWorktreeId("f", "US-002") },
    ];
    const dependencies: StoryDependencies = {};

    const results = await engine.mergeAll("/fake/repo", stories, dependencies);

    expect(results.length).toBe(2);
    // Each MergeResult.storyId MUST be the raw storyId, not the worktreeId.
    expect(results[0]?.storyId).toBe("US-001");
    expect(results[1]?.storyId).toBe("US-002");
    // And not the composed `story-f-US-001` form.
    expect(results[0]?.storyId).not.toBe("story-f-US-001");
    expect(results[1]?.storyId).not.toBe("story-f-US-002");
    // And the results must be successful (clean merge response).
    expect(results[0]?.success).toBe(true);
    expect(results[1]?.success).toBe(true);
  });

  it("AC-7: orders two stories by a dependency map keyed by their RAW story IDs — dependency before dependent", async () => {
    const recordOrder: string[] = [];
    _gitDeps.spawn = makeRecordingSpawn((cmd) => {
      if (cmd[1] === "rev-parse" && cmd.includes("MERGE_HEAD")) return { exit: 1 };
      if (cmd[1] === "merge" && cmd[2] === "--no-ff") {
        // `git merge nax/<worktreeId>` — find the branch arg position 3.
        // We assert below that the order observed here matches the
        // topological order.
        const branch = cmd[3] ?? "";
        // Translate the composed branch back to a raw storyId for the
        // observed-order recording.
        if (branch === "nax/story-f-US-001") recordOrder.push("US-001");
        else if (branch === "nax/story-f-US-002") recordOrder.push("US-002");
        return { exit: 0 };
      }
      return { exit: 0 };
    }).spawn;

    const engine = new MergeEngine(new WorktreeManager());

    // Order the input so the dependent comes FIRST — topological sort
    // should reorder them so US-001 (dep) is merged before US-002.
    const stories: MergeInput[] = [
      { storyId: "US-002", worktreeId: deriveStoryWorktreeId("f", "US-002") },
      { storyId: "US-001", worktreeId: deriveStoryWorktreeId("f", "US-001") },
    ];
    const dependencies: StoryDependencies = {
      "US-002": ["US-001"], // US-002 depends on US-001
    };

    const results = await engine.mergeAll("/fake/repo", stories, dependencies);

    expect(results.length).toBe(2);
    expect(results.every((r) => r.success)).toBe(true);
    // US-001 merged first (the dependency).
    expect(recordOrder).toEqual(["US-001", "US-002"]);
    // MergeResult ordering matches the recorded git order — storyId keys.
    expect(results[0]?.storyId).toBe("US-001");
    expect(results[1]?.storyId).toBe("US-002");
  });

  it("AC-8: a story whose raw-ID dependency failed in the same call is reported success:false, failureKind:'error', not retried, unmerged", async () => {
    const recordOrder: string[] = [];
    _gitDeps.spawn = makeRecordingSpawn((cmd) => {
      if (cmd[1] === "rev-parse" && cmd.includes("MERGE_HEAD")) return { exit: 1 };
      if (cmd[1] === "merge" && cmd[2] === "--no-ff") {
        const branch = cmd[3] ?? "";
        if (branch === "nax/story-f-US-001") {
          // The dependency fails with a clean, non-conflict error.
          recordOrder.push("US-001-merge-attempt");
          return { exit: 128, stderr: "fatal: bad merge base\n" };
        }
        if (branch === "nax/story-f-US-002") {
          recordOrder.push("US-002-merge-attempt");
          return { exit: 0 };
        }
        return { exit: 0 };
      }
      return { exit: 0 };
    }).spawn;

    const engine = new MergeEngine(new WorktreeManager());

    const stories: MergeInput[] = [
      { storyId: "US-001", worktreeId: deriveStoryWorktreeId("f", "US-001") },
      { storyId: "US-002", worktreeId: deriveStoryWorktreeId("f", "US-002") },
    ];
    const dependencies: StoryDependencies = {
      "US-002": ["US-001"], // US-002 depends on US-001
    };

    const results = await engine.mergeAll("/fake/repo", stories, dependencies);

    expect(results.length).toBe(2);
    const depResult = results[0];
    const dependentResult = results[1];

    // The dependency (US-001) failed.
    expect(depResult?.storyId).toBe("US-001");
    expect(depResult?.success).toBe(false);
    expect(depResult?.failureKind).toBe("error");
    // The dependent (US-002) is reported skipped — success:false, error kind,
    // and NOT retried (only the US-001 attempt appears in recordOrder).
    expect(dependentResult?.storyId).toBe("US-002");
    expect(dependentResult?.success).toBe(false);
    expect(dependentResult?.failureKind).toBe("error");
    expect(dependentResult?.error).toBeDefined();
    // US-002 is "unmerged": it must mention the skipped-dependency state.
    expect(dependentResult?.error?.toLowerCase()).toContain("skipped");
    expect(recordOrder).toEqual(["US-001-merge-attempt"]);
  });
});
