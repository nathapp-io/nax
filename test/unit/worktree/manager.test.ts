import { afterEach, describe, expect, test } from "bun:test";
import { withWarnSpy } from "@test/helpers";
import { _worktreeManagerDeps, WorktreeManager } from "@/worktree/manager";
import { naxOrphanRefName } from "@/worktree/nax-orphan-ref";

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
    await expect(manager.remove("/fake/project", "US-001")).rejects.toMatchObject({
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
      await manager.remove("/fake/project", "US-001");
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
      await manager.create("/fake/project", "US-001");
      const call = warnSpy.mock.calls.find((c) => c[0] === "worktree");
      expect(call).toBeDefined();
      const data = JSON.stringify(call?.[2] ?? {});
      expect(data).toContain("US-001");
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
      await manager.create("/fake/project", "US-001");
      const call = warnSpy.mock.calls.find((c) => c[0] === "worktree");
      expect(call).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// US-002 — retryable failed worktrees retain ownership evidence
//
// `naxOrphanRefName` is the single SSOT for spelling `refs/nax/orphan/<storyId>`.
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
          stderr: "fatal: '/fake/project/.nax-wt/US-001' is not a working tree",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as typeof _worktreeManagerDeps.gitWithTimeout;

    const manager = new WorktreeManager();
    await manager.create("/fake/project", "US-001");

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
          stderr: "fatal: '/fake/project/.nax-wt/US-001' is not a working tree",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as typeof _worktreeManagerDeps.gitWithTimeout;

    const manager = new WorktreeManager();
    await manager.create("/fake/project", "US-001");

    expect(calls.filter((c) => c[0] === "branch" && c[1] === "-D").length).toBe(0);
  });

  test("AC-5: clears refs/nax/orphan/US-001 when the orphan ref is present", async () => {
    // The orphan ref exists (cat-file -e reports exit 0 on refs/nax/orphan/US-001).
    // After create() returns, the orphan ref must have been deleted.
    // `git worktree remove` returns "not a working tree" so remove() short-circuits
    // with WORKTREE_NOT_FOUND, leaving removedLiveWorktree = false and letting
    // Step 3 fire on the orphan ref evidence.
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
          stderr: "fatal: '/fake/project/.nax-wt/US-001' is not a working tree",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as typeof _worktreeManagerDeps.gitWithTimeout;

    const manager = new WorktreeManager();
    await manager.create("/fake/project", "US-001");

    const orphanRef = naxOrphanRefName("US-001");
    const updateRefDeleteCalls = calls.filter((c) => c[0] === "update-ref" && c[1] === "-d" && c[2] === orphanRef);
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
          stderr: "fatal: '/fake/project/.nax-wt/US-001' is not a working tree",
        };
      }
      // `branch -D nax/US-001` returns non-zero because the branch doesn't exist
      if (args[0] === "branch" && args[1] === "-D") {
        return { exitCode: 1, stdout: "", stderr: "error: branch 'nax/US-001' not found" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as typeof _worktreeManagerDeps.gitWithTimeout;

    const manager = new WorktreeManager();
    await manager.create("/fake/project", "US-001");

    const orphanRef = naxOrphanRefName("US-001");
    const updateRefDeleteCalls = calls.filter((c) => c[0] === "update-ref" && c[1] === "-d" && c[2] === orphanRef);
    expect(updateRefDeleteCalls.length).toBe(1);
  });
});
