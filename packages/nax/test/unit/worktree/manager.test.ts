import { afterEach, describe, expect, test } from "bun:test";
import { withWarnSpy } from "@test/helpers";
import { deriveStoryWorktreeId, storyBranchName } from "@/worktree";
import { _worktreeManagerDeps, WorktreeManager } from "@/worktree/manager";
import { naxOrphanRefName } from "@/worktree/nax-orphan-ref";

// US-002: the manager's create/remove take a `WorktreeId` (branded). The
// tests below derive the identity via `deriveStoryWorktreeId` so the
// composed form `story-f-US-001` flows through the API, matching the
// `nax/story-f-US-001` branch and `.nax-wt/story-f-US-001` directory the
// manager will now create.
const FEATURE = "f";
const RAW_STORY_ID = "US-001";
const worktreeId = deriveStoryWorktreeId(FEATURE, RAW_STORY_ID);
const composedBranch = storyBranchName(worktreeId);
const composedOrphanRef = naxOrphanRefName(worktreeId);
const composedRefsBranch = `refs/heads/${composedBranch}`;
const composedWorktreePath = `/fake/project/.nax-wt/${worktreeId}`;

const SAVED_GIT_WITH_TIMEOUT = _worktreeManagerDeps.gitWithTimeout;

afterEach(() => {
  _worktreeManagerDeps.gitWithTimeout = SAVED_GIT_WITH_TIMEOUT;
});

describe("US-001 WorktreeManager — surface swallowed git failures", () => {
  test("AC-1: remove() rejects with WORKTREE_NOT_FOUND when git reports 'not a working tree'", async () => {
    _worktreeManagerDeps.gitWithTimeout = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "fatal: 'x' is not a working tree",
    });

    const manager = new WorktreeManager();
    await expect(manager.remove("/fake/project", worktreeId)).rejects.toMatchObject({
      code: "WORKTREE_NOT_FOUND",
    });
  });

  test("AC-2: remove() rejects with WORKTREE_ERROR when git reports a genuine failure", async () => {
    _worktreeManagerDeps.gitWithTimeout = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "fatal: could not lock ref",
    });

    const manager = new WorktreeManager();
    let caught: unknown;
    try {
      await manager.remove("/fake/project", worktreeId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { code: string }).code).toBe("WORKTREE_ERROR");
    expect(String((caught as { message: string }).message)).toContain("could not lock ref");
  });

  test("AC-3: create() warns when remove() fails with a genuine git error during cleanup", async () => {
    _worktreeManagerDeps.gitWithTimeout = async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        return { exitCode: 1, stdout: "", stderr: "fatal: could not lock ref" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const manager = new WorktreeManager();
    await withWarnSpy(async (warnSpy) => {
      await manager.create("/fake/project", worktreeId);
      const call = warnSpy.mock.calls.find((c) => c[0] === "worktree");
      expect(call).toBeDefined();
      const data = JSON.stringify(call?.[2] ?? {});
      expect(data).toContain(worktreeId);
      expect(data).toContain("could not lock ref");
    });
  });

  test("AC-4: create() does not warn when remove() fails only because there is nothing to remove", async () => {
    _worktreeManagerDeps.gitWithTimeout = async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        return { exitCode: 1, stdout: "", stderr: "fatal: 'x' is not a working tree" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const manager = new WorktreeManager();
    await withWarnSpy(async (warnSpy) => {
      await manager.create("/fake/project", worktreeId);
      const call = warnSpy.mock.calls.find((c) => c[0] === "worktree");
      expect(call).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// US-002 — retryable failed worktrees retain ownership evidence
//
// `naxOrphanRefName` is the single SSOT for spelling `refs/nax/orphan/<worktreeId>`.
// AC-2 and AC-3 assert BUG-28's user-branch shape is preserved when no record
// of nax ownership exists. AC-5 and AC-9 assert that when the orphan ref IS
// present, create() consumes it as Step-3 evidence and clears it.
//
// Test approach: each test installs a recording mock into
// `_worktreeManagerDeps.gitWithTimeout` BEFORE calling `manager.create()`.
// The recorder captures every args-tuple so we can assert on git invocations.
// ---------------------------------------------------------------------------

describe("US-002 WorktreeManager — retryable failed worktrees retain ownership evidence", () => {
  test("AC-2: does not invoke git branch -D on a user branch when no worktree record and no orphan ref exist", async () => {
    // No worktree record (git worktree list --porcelain returns empty),
    // no orphan ref (cat-file -e reports exit 1). `git worktree remove`
    // returns "not a working tree" so remove() short-circuits via
    // WORKTREE_NOT_FOUND, never reaching its internal `branch -D`.
    const calls: string[][] = [];
    _worktreeManagerDeps.gitWithTimeout = (async (args: string[]) => {
      calls.push(args);
      if (args[0] === "worktree" && args[1] === "list") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "cat-file" && args[1] === "-e") {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `fatal: '${composedWorktreePath}' is not a working tree`,
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as typeof _worktreeManagerDeps.gitWithTimeout;

    const manager = new WorktreeManager();
    await manager.create("/fake/project", worktreeId);

    const branchDeleteCalls = calls.filter((c) => c[0] === "branch" && c[1] === "-D");
    expect(branchDeleteCalls.length).toBe(0);
  });

  test("AC-3: branch still resolves to its original commit when no worktree record and no orphan ref exist", async () => {
    // The branch must NOT have been deleted. `git branch -D` would have
    // removed it, so we assert by checking that no such call was made.
    // `remove()` short-circuits with WORKTREE_NOT_FOUND on a non-existent
    // worktree (its internal `branch -D` is never reached), and Step 3
    // doesn't fire because there's no evidence (no worktree record and
    // no orphan ref).
    const calls: string[][] = [];
    _worktreeManagerDeps.gitWithTimeout = (async (args: string[]) => {
      calls.push(args);
      if (args[0] === "worktree" && args[1] === "list") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "cat-file" && args[1] === "-e") {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `fatal: '${composedWorktreePath}' is not a working tree`,
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as typeof _worktreeManagerDeps.gitWithTimeout;

    const manager = new WorktreeManager();
    await manager.create("/fake/project", worktreeId);

    expect(calls.filter((c) => c[0] === "branch" && c[1] === "-D").length).toBe(0);
  });

  test("AC-5: clears refs/nax/orphan/<worktreeId> when the orphan ref is present", async () => {
    // The orphan ref exists (cat-file -e reports exit 0 on
    // refs/nax/orphan/<worktreeId>). After create() returns, the orphan
    // ref must have been deleted. `git worktree remove` returns "not a
    // working tree" so remove() short-circuits with WORKTREE_NOT_FOUND,
    // leaving removedLiveWorktree = false and letting Step 3 fire on
    // the orphan ref evidence.
    const calls: string[][] = [];
    _worktreeManagerDeps.gitWithTimeout = (async (args: string[]) => {
      calls.push(args);
      if (args[0] === "worktree" && args[1] === "list") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "cat-file" && args[1] === "-e") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `fatal: '${composedWorktreePath}' is not a working tree`,
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as typeof _worktreeManagerDeps.gitWithTimeout;

    const manager = new WorktreeManager();
    await manager.create("/fake/project", worktreeId);

    const updateRefDeleteCalls = calls.filter(
      (c) => c[0] === "update-ref" && c[1] === "-d" && c[2] === composedOrphanRef,
    );
    expect(updateRefDeleteCalls.length).toBe(1);
  });

  test("AC-9: clears the orphan ref even when the underlying branch does not exist", async () => {
    // The orphan ref exists (cat-file -e exit 0), but `branch -D` for the
    // user-branch name will fail because the branch was never created.
    // The ref MUST still be cleared so it doesn't survive into a third attempt.
    // `git worktree remove` returns "not a working tree" so remove() short-circuits
    // with WORKTREE_NOT_FOUND.
    const calls: string[][] = [];
    _worktreeManagerDeps.gitWithTimeout = (async (args: string[]) => {
      calls.push(args);
      if (args[0] === "worktree" && args[1] === "list") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "cat-file" && args[1] === "-e") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `fatal: '${composedWorktreePath}' is not a working tree`,
        };
      }
      // `branch -D <composedBranch>` returns non-zero because the branch doesn't exist
      if (args[0] === "branch" && args[1] === "-D") {
        return { exitCode: 1, stdout: "", stderr: `error: branch '${composedBranch}' not found` };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as typeof _worktreeManagerDeps.gitWithTimeout;

    const manager = new WorktreeManager();
    await manager.create("/fake/project", worktreeId);

    const updateRefDeleteCalls = calls.filter(
      (c) => c[0] === "update-ref" && c[1] === "-d" && c[2] === composedOrphanRef,
    );
    expect(updateRefDeleteCalls.length).toBe(1);
  });

  test("does not delete a reused user branch when its tip differs from the orphan record", async () => {
    const calls: string[][] = [];
    _worktreeManagerDeps.gitWithTimeout = (async (args: string[]) => {
      calls.push(args);
      if (args[0] === "worktree" && args[1] === "list") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "cat-file") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args[2] === composedOrphanRef)
        return { exitCode: 0, stdout: "nax-tip\n", stderr: "" };
      if (args[0] === "rev-parse") return { exitCode: 0, stdout: "user-tip\n", stderr: "" };
      if (args[0] === "worktree" && args[1] === "remove") {
        return { exitCode: 1, stdout: "", stderr: `fatal: '${composedWorktreePath}' is not a working tree` };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as typeof _worktreeManagerDeps.gitWithTimeout;

    await new WorktreeManager().create("/fake/project", worktreeId);

    expect(calls).not.toContainEqual(["branch", "-D", composedBranch]);
    expect(calls).not.toContainEqual(["update-ref", "-d", composedRefsBranch, "nax-tip"]);
    expect(calls).toContainEqual(["update-ref", "-d", composedOrphanRef]);
  });

  test("retains the orphan record when atomic branch cleanup fails and the branch remains", async () => {
    const calls: string[][] = [];
    _worktreeManagerDeps.gitWithTimeout = (async (args: string[]) => {
      calls.push(args);
      if (args[0] === "worktree" && args[1] === "list") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "cat-file") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { exitCode: 0, stdout: "nax-tip\n", stderr: "" };
      if (args[0] === "worktree" && args[1] === "remove") {
        return { exitCode: 1, stdout: "", stderr: `fatal: '${composedWorktreePath}' is not a working tree` };
      }
      if (args[0] === "update-ref" && args[2] === composedRefsBranch) {
        return { exitCode: 1, stdout: "", stderr: "fatal: cannot lock ref" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as typeof _worktreeManagerDeps.gitWithTimeout;

    await new WorktreeManager().create("/fake/project", worktreeId);

    expect(calls).toContainEqual(["update-ref", "-d", composedRefsBranch, "nax-tip"]);
    expect(calls).not.toContainEqual(["update-ref", "-d", composedOrphanRef]);
  });

  test("AC-5 (Step-2 path): clears refs/nax/orphan/<worktreeId> when Step 2 removes a live worktree", async () => {
    // The orphan ref exists AND the worktree directory still exists. Step 2's
    // `remove()` succeeds — it removes the worktree AND its branch, setting
    // removedLiveWorktree = true and skipping Step 3 entirely. The orphan
    // ref would otherwise survive, dangling at a now-unreachable commit.
    //
    // A subsequent retry could see a user branch named `<composedBranch>` and the
    // dangling orphan ref, which Step 3 would interpret as nax-created and
    // force-delete — exactly the BUG-28 hole this story closes.
    //
    // `git worktree remove` succeeds (Step 2 path), so the worktree and
    // branch are both deleted. `hasWorktreeRecord` returns false (admin refs
    // are gone after `worktree prune`).
    const calls: string[][] = [];
    _worktreeManagerDeps.gitWithTimeout = (async (args: string[]) => {
      calls.push(args);
      if (args[0] === "worktree" && args[1] === "list") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "cat-file" && args[1] === "-e") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        // Succeeds — Step 2 takes the "removed a live worktree" branch.
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as typeof _worktreeManagerDeps.gitWithTimeout;

    const manager = new WorktreeManager();
    await manager.create("/fake/project", worktreeId);

    const updateRefDeleteCalls = calls.filter(
      (c) => c[0] === "update-ref" && c[1] === "-d" && c[2] === composedOrphanRef,
    );
    expect(updateRefDeleteCalls.length).toBe(1);

    // Step 3's own `branch -D` must NOT have fired — Step 2 succeeded, so
    // Step 3 was skipped. (`remove()` itself issues a `branch -D` as part of
    // its cleanup, but that's Step 2's branch deletion, not Step 3's.)
    // We assert that the ONLY `branch -D` call is from `remove()` — i.e.,
    // exactly one. If Step 3 had also fired, we'd see two.
    const branchDeleteCalls = calls.filter((c) => c[0] === "branch" && c[1] === "-D");
    expect(branchDeleteCalls.length).toBe(1);
  });
});
