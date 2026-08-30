import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { withWarnSpy } from "@test/helpers";
import {
  _gitUtilDeps,
  clearGitRootCache,
  getChangedNonTestFiles,
  getChangedTestFiles,
} from "@/verification/smart-runner";

describe("US-001 smart-runner — surface swallowed git failures", () => {
  const savedGetGitRoot = _gitUtilDeps.getGitRoot;
  const savedGitWithTimeout = _gitUtilDeps.gitWithTimeout;

  beforeEach(() => {
    clearGitRootCache();
    _gitUtilDeps.getGitRoot = async () => null;
  });

  afterEach(() => {
    _gitUtilDeps.getGitRoot = savedGetGitRoot;
    _gitUtilDeps.gitWithTimeout = savedGitWithTimeout;
    clearGitRootCache();
  });

  test("AC-5: getChangedNonTestFiles warns and fails open on a non-zero git exit", async () => {
    _gitUtilDeps.gitWithTimeout = async () => ({
      exitCode: 128,
      stdout: "",
      stderr: "fatal: bad revision 'HEAD~1'",
    });

    await withWarnSpy(async (warnSpy) => {
      const result = await getChangedNonTestFiles("/fake/repo", "HEAD~1");
      expect(result).toEqual([]);
      const call = warnSpy.mock.calls.find((c) => c[0] === "verification");
      expect(call).toBeDefined();
      expect(JSON.stringify(call?.[2] ?? {})).toContain("bad revision");
    });
  });

  test("AC-6: getChangedTestFiles warns and fails open on a non-zero git exit", async () => {
    _gitUtilDeps.gitWithTimeout = async () => ({
      exitCode: 128,
      stdout: "",
      stderr: "fatal: bad revision 'HEAD~1'",
    });

    await withWarnSpy(async (warnSpy) => {
      const result = await getChangedTestFiles("/fake/repo", "/fake/repo", "HEAD~1", undefined, [/\.test\.ts$/]);
      expect(result).toEqual([]);
      const call = warnSpy.mock.calls.find((c) => c[0] === "verification");
      expect(call).toBeDefined();
    });
  });

  test("AC-7: getChangedNonTestFiles warns and fails open when the spawn throws", async () => {
    _gitUtilDeps.gitWithTimeout = async () => {
      throw new Error("spawn EACCES");
    };

    await withWarnSpy(async (warnSpy) => {
      const result = await getChangedNonTestFiles("/fake/repo");
      expect(result).toEqual([]);
      const call = warnSpy.mock.calls.find((c) => c[0] === "verification");
      expect(call).toBeDefined();
      expect(JSON.stringify(call?.[2] ?? {})).toContain("spawn EACCES");
    });
  });

  test("AC-8: getChangedNonTestFiles returns real files and stays quiet on success", async () => {
    _gitUtilDeps.gitWithTimeout = async () => ({
      exitCode: 0,
      stdout: "src/a.ts\nsrc/b.ts\n",
      stderr: "",
    });

    await withWarnSpy(async (warnSpy) => {
      const result = await getChangedNonTestFiles("/fake/repo");
      expect(result).toContain("src/a.ts");
      expect(result).toContain("src/b.ts");
      const call = warnSpy.mock.calls.find((c) => c[0] === "verification");
      expect(call).toBeUndefined();
    });
  });
});
