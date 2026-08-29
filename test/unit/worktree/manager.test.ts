import { afterEach, describe, expect, test } from "bun:test";
import { withWarnSpy } from "@test/helpers";
import { _worktreeManagerDeps, WorktreeManager } from "@/worktree/manager";

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
