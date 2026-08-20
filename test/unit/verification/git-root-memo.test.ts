import { describe, expect, mock, test } from "bun:test";
import { _gitDeps } from "@/utils/git";
import {
  getChangedTestFiles,
  _gitUtilDeps,
  clearGitRootCache,
} from "@/verification/smart-runner";

function makeProc(stdout: string, exitCode: number) {
  return {
    exited: Promise.resolve(exitCode),
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stdout));
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
  };
}

describe("git-root memoization", () => {
  test("getGitRoot is computed once per workdir across multiple classifier calls", async () => {
    clearGitRootCache();
    let gitRootCalls = 0;
    const origGetGitRoot = _gitUtilDeps.getGitRoot;
    const origSpawn = _gitDeps.spawn;
    _gitUtilDeps.getGitRoot = async (_workdir: string) => {
      gitRootCalls++;
      return "/repo";
    };
    // Make git diff succeed with empty output so we reach the getGitRoot call
    _gitDeps.spawn = mock(() => makeProc("", 0)) as unknown as typeof _gitDeps.spawn;

    try {
      // Both calls use the same workdir — should only compute git root once
      await getChangedTestFiles("/repo", "/repo", undefined, "packages/api", [/\.test\.ts$/]);
      await getChangedTestFiles("/repo", "/repo", undefined, "packages/api", [/\.test\.ts$/]);
      expect(gitRootCalls).toBeLessThanOrEqual(1);
    } finally {
      _gitUtilDeps.getGitRoot = origGetGitRoot;
      _gitDeps.spawn = origSpawn;
      clearGitRootCache();
    }
  });

  test("clearGitRootCache resets the memo", async () => {
    clearGitRootCache();
    let callCount = 0;
    const origGetGitRoot = _gitUtilDeps.getGitRoot;
    const origSpawn = _gitDeps.spawn;
    _gitUtilDeps.getGitRoot = async (_workdir: string) => {
      callCount++;
      return "/repo";
    };
    _gitDeps.spawn = mock(() => makeProc("", 0)) as unknown as typeof _gitDeps.spawn;

    try {
      // First call populates cache
      await getChangedTestFiles("/repo", "/repo", undefined, "packages/api", [/\.test\.ts$/]);
      expect(callCount).toBe(1);

      // Clear the cache
      clearGitRootCache();

      // Next call should recompute
      await getChangedTestFiles("/repo", "/repo", undefined, "packages/api", [/\.test\.ts$/]);
      expect(callCount).toBe(2);
    } finally {
      _gitUtilDeps.getGitRoot = origGetGitRoot;
      _gitDeps.spawn = origSpawn;
      clearGitRootCache();
    }
  });
});
