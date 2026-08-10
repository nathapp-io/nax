// RE-ARCH: keep
/**
 * Tests for src/worktree/merge.ts
 *
 * Covers: MergeEngine topological sort and merge logic
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { _mergeDeps, MergeEngine } from "../../../src/worktree/merge";
import type { StoryDependencies } from "../../../src/worktree/merge";

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

// ─────────────────────────────────────────────────────────────────────────────
// Git-state classification — these drive the REAL merge() through the injected
// spawn seam. The suite above stubs engine.merge wholesale, which is why the
// throw-instead-of-return defect survived: the function under test was replaced.
// ─────────────────────────────────────────────────────────────────────────────

/** One faked git invocation. */
interface FakeProc {
  exit: number;
  stdout?: string;
  stderr?: string;
}

/** Build a `_mergeDeps.spawn` stand-in that answers per git command. */
function fakeSpawn(handler: (cmd: readonly string[]) => FakeProc): typeof _mergeDeps.spawn {
  return ((cmd: string[]) => {
    const res = handler(cmd);
    return {
      exited: Promise.resolve(res.exit),
      stdout: new Response(res.stdout ?? "").body,
      stderr: new Response(res.stderr ?? "").body,
    };
  }) as unknown as typeof _mergeDeps.spawn;
}

const isMergeCmd = (cmd: readonly string[]) => cmd[1] === "merge" && cmd[2] === "--no-ff";
const isAbortCmd = (cmd: readonly string[]) => cmd[1] === "merge" && cmd[2] === "--abort";
const isMergeHeadProbe = (cmd: readonly string[]) => cmd[1] === "rev-parse" && cmd.includes("MERGE_HEAD");
const isUnmergedProbe = (cmd: readonly string[]) => cmd[1] === "diff" && cmd.includes("--diff-filter=U");

/** Real `git merge` output for a dirty working tree — note: contains no "conflict". */
const DIRTY_TREE_STDERR =
  "error: Your local changes to the following files would be overwritten by merge:\n\tf.txt\nAborting\n";

describe("MergeEngine — non-conflict git failures", () => {
  let origSpawn: typeof _mergeDeps.spawn;

  beforeEach(() => {
    origSpawn = _mergeDeps.spawn;
  });

  afterEach(() => {
    _mergeDeps.spawn = origSpawn;
  });

  it("mergeAll stays total when a story fails for a non-conflict reason", async () => {
    // US-002 fails with the real dirty-tree message: exit 2, no "conflict" text,
    // repo left clean (no MERGE_HEAD, no unmerged files). Previously this threw
    // out of mergeAll, discarding US-001's recorded success and never trying US-003.
    _mergeDeps.spawn = fakeSpawn((cmd) => {
      if (isMergeCmd(cmd) && cmd[3] === "nax/US-002") return { exit: 2, stderr: DIRTY_TREE_STDERR };
      if (isMergeCmd(cmd)) return { exit: 0 };
      if (isMergeHeadProbe(cmd)) return { exit: 1 }; // never mid-merge
      if (isUnmergedProbe(cmd)) return { exit: 0, stdout: "" }; // no unmerged files
      return { exit: 0 };
    });

    const engine = new MergeEngine(mockWorktreeManager);
    const results = await engine.mergeAll("/repo", ["US-001", "US-002", "US-003"], {});

    expect(results.length).toBe(3);
    expect(results[0]).toMatchObject({ storyId: "US-001", success: true });
    expect(results[1]).toMatchObject({ storyId: "US-002", success: false, failureKind: "error" });
    expect(results[2]).toMatchObject({ storyId: "US-003", success: true });
    // An "error" is not a conflict — routing it to conflict rectification would
    // spend an agent session resolving a conflict that does not exist.
    expect(results[1].conflictFiles ?? []).toEqual([]);
  });

  it("classifies by repo state, not by the word 'conflict' in stderr", async () => {
    // Real output when the repo is left mid-merge by an earlier story:
    //   "fatal: Exiting because of an unresolved conflict."
    // It contains "conflict", but THIS story caused nothing — the repo is clean
    // by the time we probe it, so it must be an error, not this story's conflict.
    _mergeDeps.spawn = fakeSpawn((cmd) => {
      if (isMergeCmd(cmd)) {
        return { exit: 128, stderr: "error: Merging is not possible.\nfatal: Exiting because of an unresolved conflict.\n" };
      }
      if (isMergeHeadProbe(cmd)) return { exit: 1 };
      if (isUnmergedProbe(cmd)) return { exit: 0, stdout: "" };
      return { exit: 0 };
    });

    const engine = new MergeEngine(mockWorktreeManager);
    const result = await engine.merge("/repo", "US-001");

    expect(result.success).toBe(false);
    expect(result.failureKind).toBe("error");
  });

  it("refuses to merge into a repository that is already mid-merge", async () => {
    let mergeAttempted = false;
    _mergeDeps.spawn = fakeSpawn((cmd) => {
      if (isMergeCmd(cmd)) {
        mergeAttempted = true;
        return { exit: 0 };
      }
      if (isMergeHeadProbe(cmd)) return { exit: 0 }; // MERGE_HEAD resolves => mid-merge
      return { exit: 0 };
    });

    const engine = new MergeEngine(mockWorktreeManager);
    const result = await engine.merge("/repo", "US-001");

    expect(result.success).toBe(false);
    expect(result.failureKind).toBe("error");
    // The guard must fire BEFORE git merge runs — merging into a dirty index is
    // what produced the misattributed conflict in the first place.
    expect(mergeAttempted).toBe(false);
  });

  /**
   * A conflicting repository, faked with real state transitions: the failing merge
   * SETS MERGE_HEAD and a successful abort clears it. A fake that answers the
   * MERGE_HEAD probe with a constant would be answering the pre-merge guard too, so
   * the guard would short-circuit and the test would pass without the conflict path
   * ever running.
   */
  function conflictingRepo(opts: { abortExit: number; unmerged: string }) {
    let midMerge = false;
    return fakeSpawn((cmd) => {
      if (isMergeCmd(cmd)) {
        midMerge = true;
        return { exit: 1, stderr: "CONFLICT (content): Merge conflict in f.txt\n" };
      }
      if (isAbortCmd(cmd)) {
        if (opts.abortExit === 0) midMerge = false;
        return { exit: opts.abortExit, stderr: opts.abortExit === 0 ? "" : "fatal: could not abort\n" };
      }
      if (isMergeHeadProbe(cmd)) return { exit: midMerge ? 0 : 1 };
      if (isUnmergedProbe(cmd)) return { exit: 0, stdout: opts.unmerged };
      return { exit: 0 };
    });
  }

  it("does not report a clean conflict when git merge --abort fails", async () => {
    // A genuine conflict, but the abort fails, so the repo stays mid-merge and
    // every later merge in the batch is invalid. Reporting a plain conflict here
    // would hand the story to rectification against an unusable repo.
    _mergeDeps.spawn = conflictingRepo({ abortExit: 128, unmerged: "f.txt\n" });

    const engine = new MergeEngine(mockWorktreeManager);
    const result = await engine.merge("/repo", "US-001");

    expect(result.success).toBe(false);
    expect(result.failureKind).toBe("error");
  });

  it("still reports a real conflict as a conflict, with its files", async () => {
    _mergeDeps.spawn = conflictingRepo({ abortExit: 0, unmerged: "f.txt\nsrc/g.ts\n" });

    const engine = new MergeEngine(mockWorktreeManager);
    const result = await engine.merge("/repo", "US-001");

    expect(result.success).toBe(false);
    expect(result.failureKind).toBe("conflict");
    expect(result.conflictFiles).toEqual(["f.txt", "src/g.ts"]);
  });

  it("mergeAll reports every story when the repo is stuck mid-merge", async () => {
    // The mid-merge guard makes each subsequent story fail fast rather than
    // being misreported as its own conflict.
    _mergeDeps.spawn = fakeSpawn((cmd) => {
      if (isMergeHeadProbe(cmd)) return { exit: 0 };
      return { exit: 0 };
    });

    const engine = new MergeEngine(mockWorktreeManager);
    const results = await engine.mergeAll("/repo", ["US-001", "US-002"], {});

    expect(results.length).toBe(2);
    expect(results.every((r) => !r.success && r.failureKind === "error")).toBe(true);
  });
});

describe("worktree barrel", () => {
  it("exports the merge surface so consumers need not reach into the leaf module", async () => {
    const barrel = await import("@/worktree");
    expect(barrel.MergeEngine).toBeDefined();
    expect(barrel._mergeDeps).toBeDefined();
  });
});
