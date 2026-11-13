import { afterEach, describe, expect, mock, test } from "bun:test";
import { lstat, mkdir, symlink, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { runTmpRoot } from "@nathapp/nax-agent";
import { withTempDir, withWarnSpy } from "@test/helpers";
import { _runTmpSweepDeps, STALE_RUN_TMP_MAX_AGE_MS, sweepStaleRunTmpRoots } from "@/execution/lifecycle/run-tmp-sweep";
import { removeRunTmpTree } from "@/execution/lifecycle/run-tmp-wipe";

const saved = { ..._runTmpSweepDeps };
afterEach(() => Object.assign(_runTmpSweepDeps, saved));

describe("sweepStaleRunTmpRoots", () => {
  test("default age and remove implementation", () => {
    expect(STALE_RUN_TMP_MAX_AGE_MS).toBe(172800000);
    expect(_runTmpSweepDeps.remove).toBe(removeRunTmpTree);
  });
  test("lists trusted parent, skips current, fresh child, files and links and removes stale directories", async () => {
    await withTempDir(async (dir) => {
      const current = basename(runTmpRoot("a/b"));
      for (const name of [current, "old", "fresh"]) await mkdir(join(dir, name));
      await writeFile(join(dir, "fresh", "child"), "x");
      await writeFile(join(dir, "old", "child"), "x");
      await utimes(join(dir, "old", "child"), 1, 1);
      await writeFile(join(dir, "file"), "x");
      await symlink(join(dir, "old"), join(dir, "link"));
      for (const name of [current, "old", "fresh"]) await utimes(join(dir, name), 1, 1);
      const parent = dirname(runTmpRoot("a/b"));
      const listed: string[] = [];
      _runTmpSweepDeps.readdir = async (path) => {
        listed.push(path);
        return saved.readdir(path === parent ? dir : path.replace(parent, dir));
      };
      _runTmpSweepDeps.lstat = (path) => lstat(path.replace(parent, dir));
      const remove = mock(async (_path: string) => {});
      _runTmpSweepDeps.remove = remove;
      await sweepStaleRunTmpRoots({ currentRunId: "a/b", now: Date.now(), maxAgeMs: 10000 });
      expect(listed[0]).toBe(parent);
      expect(remove.mock.calls).toEqual([[join(parent, "old")]]);
    });
  });
  test("missing or inaccessible parent resolves", async () => {
    for (const code of ["ENOENT", "EACCES"]) {
      _runTmpSweepDeps.readdir = async () => {
        throw Object.assign(new Error(code), { code });
      };
      await withWarnSpy(async (warn) => {
        await expect(sweepStaleRunTmpRoots({ currentRunId: "cur", now: 10, maxAgeMs: 1 })).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(code === "ENOENT" ? 0 : 1);
      });
    }
  });
  test("continues after an entry fails", async () => {
    await withTempDir(async (dir) => {
      for (const name of ["a", "b"]) {
        await mkdir(join(dir, name));
        await utimes(join(dir, name), 1, 1);
      }
      const parent = dirname(runTmpRoot("cur"));
      // Enumeration order belongs to the filesystem, not to the sweep: CI's /tmp
      // listed "b" before "a" and this test read that as a failure (#2894). Hand
      // the sweep a deliberately unsorted listing so what it removes is pinned,
      // never the order it happens to walk in.
      _runTmpSweepDeps.readdir = async (path) =>
        (await saved.readdir(path === parent ? dir : path.replace(parent, dir))).toReversed();
      _runTmpSweepDeps.lstat = (path) => lstat(path.replace(parent, dir));
      const remove = mock(async (path: string) => {
        if (path.endsWith("/a")) throw new Error("failed");
      });
      _runTmpSweepDeps.remove = remove;
      await withWarnSpy(async (warn) => {
        await sweepStaleRunTmpRoots({ currentRunId: "cur", now: Date.now(), maxAgeMs: 10000 });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[1]).toStartWith("Failed to sweep stale run temp dir");
      });
      // Sorted: the sweep's contract is which stale roots it removes, not the
      // order the filesystem hands them to it.
      const removed = remove.mock.calls.map(([path]) => path).toSorted();
      expect(removed).toEqual([join(parent, "a"), join(parent, "b")]);
    });
  });
});
