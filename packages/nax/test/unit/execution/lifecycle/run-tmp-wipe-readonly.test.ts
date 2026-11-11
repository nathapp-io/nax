import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTmpRoot } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir, withDepsRestore, withWarnSpy } from "@test/helpers";
import { _runTmpWipeDeps, removeRunTmpTree, wipeRunTmp } from "@/execution/lifecycle/run-tmp-wipe";

const denied = (code = "EACCES") => Object.assign(new Error(code), { code });

describe("removeRunTmpTree read-only recovery", () => {
  withDepsRestore(_runTmpWipeDeps);
  let dir: string;
  let root: string;
  let nested: string;
  const realRemove = _runTmpWipeDeps.remove;

  beforeEach(() => {
    dir = makeTempDir();
    root = join(dir, "root");
    nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "file"), "data");
    chmodSync(nested, 0o500);
  });
  afterEach(() => {
    if (existsSync(nested)) chmodSync(nested, 0o700);
    cleanupTempDir(dir);
  });

  function failFirst(): ReturnType<typeof mock<(path: string) => Promise<void>>> {
    let calls = 0;
    return mock(async (path: string) => {
      if (++calls === 1) throw denied();
      await realRemove(path);
    });
  }

  test("AC-1: removes a real tree with a read-only nested directory", async () => {
    await removeRunTmpTree(root);
    expect(existsSync(root)).toBe(false);
  });

  test("AC-2: wipe removes a real read-only tree without warnings", async () => {
    _runTmpWipeDeps.exists = () => true;
    _runTmpWipeDeps.remove = async () => realRemove(root);
    // The walk must inspect the same actual tree as the redirected removal.
    const realLstat = _runTmpWipeDeps.lstat;
    const realChmod = _runTmpWipeDeps.chmod;
    const realReaddir = _runTmpWipeDeps.readdir;
    const target = runTmpRoot("readonly-test");
    const translate = (path: string) => path.replace(target, root);
    _runTmpWipeDeps.lstat = (path) => realLstat(translate(path));
    _runTmpWipeDeps.chmod = (path, mode) => realChmod(translate(path), mode);
    _runTmpWipeDeps.readdir = (path) => realReaddir(translate(path));
    await withWarnSpy(async (warn) => {
      await wipeRunTmp("readonly-test");
      expect(warn).not.toHaveBeenCalled();
    });
    expect(existsSync(root)).toBe(false);
  });

  test("AC-3 and AC-4: leaves an external symlink target and its contents untouched", async () => {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "file"), "safe");
    chmodSync(outside, 0o500);
    symlinkSync(outside, join(root, "link"));
    _runTmpWipeDeps.remove = failFirst();
    try {
      await removeRunTmpTree(root);
      expect(existsSync(root)).toBe(false);
      expect(statSync(outside).mode & 0o777).toBe(0o500);
      expect(existsSync(join(outside, "file"))).toBe(true);
    } finally {
      chmodSync(outside, 0o700);
    }
  });

  test("AC-5: retries EACCES exactly once", async () => {
    const remove = failFirst();
    _runTmpWipeDeps.remove = remove;
    await removeRunTmpTree(root);
    expect(remove).toHaveBeenCalledTimes(2);
  });

  test("AC-6 and AC-7: EPERM grants owner access to directories but not symlinks", async () => {
    const link = join(root, "link");
    symlinkSync(dir, link);
    let calls = 0;
    _runTmpWipeDeps.remove = async () => {
      if (++calls === 1) throw denied("EPERM");
    };
    const chmod = mock(async (_path: string, _mode: number) => {});
    _runTmpWipeDeps.chmod = chmod;
    await removeRunTmpTree(root);
    expect(chmod.mock.calls.map(([path]) => path).sort()).toEqual([root, join(root, "a"), nested].sort());
    for (const [, mode] of chmod.mock.calls) expect(mode & 0o700).toBe(0o700);
    expect(chmod.mock.calls.map(([path]) => path)).not.toContain(link);
  });

  test("AC-8: propagates other errors without retry or walk", async () => {
    const error = denied("ENOTDIR");
    const remove = mock(async () => {
      throw error;
    });
    const chmod = mock(async (_path: string, _mode: number) => {});
    _runTmpWipeDeps.remove = remove;
    _runTmpWipeDeps.chmod = chmod;
    await expect(removeRunTmpTree(root)).rejects.toBe(error);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(chmod).not.toHaveBeenCalled();
  });

  test("AC-9: propagates the second removal error", async () => {
    const second = denied();
    let calls = 0;
    _runTmpWipeDeps.remove = async () => {
      throw ++calls === 1 ? denied() : second;
    };
    await expect(removeRunTmpTree(root)).rejects.toBe(second);
    expect(calls).toBe(2);
  });

  test("AC-10: chmod failure does not prevent retry or visiting siblings", async () => {
    const sibling = join(root, "sibling");
    mkdirSync(sibling);
    const remove = mock(async () => {
      if (remove.mock.calls.length === 1) throw denied();
    });
    const chmod = mock(async (path: string, _mode: number) => {
      if (path === nested) throw denied();
    });
    _runTmpWipeDeps.remove = remove;
    _runTmpWipeDeps.chmod = chmod;
    await removeRunTmpTree(root);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(chmod.mock.calls.map(([path]) => path)).toContain(sibling);
  });

  test("AC-11: wipe warns once and resolves after a failed retry", async () => {
    const remove = mock(async () => {
      throw denied();
    });
    _runTmpWipeDeps.remove = remove;
    _runTmpWipeDeps.exists = () => true;
    await withWarnSpy(async (warn) => {
      await expect(wipeRunTmp("readonly-test")).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[1]).toBe(`Failed to wipe run temp dir ${runTmpRoot("readonly-test")} — continuing`);
    });
    expect(remove).toHaveBeenCalledTimes(2);
  });

  test("AC-12: readdir failure skips that directory and still retries", async () => {
    const remove = mock(async () => {
      if (remove.mock.calls.length === 1) throw denied();
    });
    const readdir = _runTmpWipeDeps.readdir;
    _runTmpWipeDeps.remove = remove;
    _runTmpWipeDeps.readdir = (path) => (path === nested ? Promise.reject(denied()) : readdir(path));
    await removeRunTmpTree(root);
    expect(remove).toHaveBeenCalledTimes(2);
  });

  test("lstat failure skips one entry and continues to its sibling", async () => {
    const sibling = join(root, "sibling");
    mkdirSync(sibling);
    const remove = mock(async () => {
      if (remove.mock.calls.length === 1) throw denied();
    });
    const lstat = _runTmpWipeDeps.lstat;
    const chmod = mock(async (_path: string, _mode: number) => {});
    _runTmpWipeDeps.remove = remove;
    _runTmpWipeDeps.lstat = (path) => (path === join(root, "a") ? Promise.reject(denied()) : lstat(path));
    _runTmpWipeDeps.chmod = chmod;
    await removeRunTmpTree(root);
    expect(chmod.mock.calls.map(([path]) => path)).toContain(sibling);
    expect(remove).toHaveBeenCalledTimes(2);
  });
});
