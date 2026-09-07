import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import {
  isKnownManifestOrLockfileName,
  recordExecTouchedPaths,
  snapshotExecTouchedPaths,
} from "@/tools/exec-touched-paths";

describe("recordExecTouchedPaths", () => {
  test("records only files whose contents changed", async () => {
    await withTempDir(async (root) => {
      await Bun.write(join(root, "package.json"), "before");
      await Bun.write(join(root, "bun.lock"), "unchanged");
      const before = await snapshotExecTouchedPaths("bun", root);
      await Bun.write(join(root, "package.json"), "after");

      const target: string[] = [];
      await recordExecTouchedPaths(target, before);
      expect(target).toEqual([join(root, "package.json")]);
    });
  });

  test("records a newly created lockfile", async () => {
    await withTempDir(async (root) => {
      const before = await snapshotExecTouchedPaths("npm", root);
      await Bun.write(join(root, "package-lock.json"), "created");
      const target: string[] = [];
      await recordExecTouchedPaths(target, before);
      expect(target).toEqual([join(root, "package-lock.json")]);
    });
  });

  test("is a no-op for a manager with no known lockfile shape", async () => {
    const target: string[] = [];
    await recordExecTouchedPaths(target, await snapshotExecTouchedPaths("pip", "/repo"));
    expect(target).toEqual([]);
  });

  test("is a no-op for an unrecognized manager string", async () => {
    const target: string[] = [];
    await recordExecTouchedPaths(target, await snapshotExecTouchedPaths("curl", "/repo"));
    expect(target).toEqual([]);
  });

  test("does not grant unchanged or merely expected paths", async () => {
    await withTempDir(async (root) => {
      await Bun.write(join(root, "package.json"), "unchanged");
      const before = await snapshotExecTouchedPaths("bun", root);
      const target: string[] = [];
      await recordExecTouchedPaths(target, before);
      expect(target).toEqual([]);
    });
  });
});

describe("isKnownManifestOrLockfileName", () => {
  test.each([
    "package.json",
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "Cargo.toml",
    "Cargo.lock",
    "pyproject.toml",
    "uv.lock",
    "go.mod",
    "go.sum",
  ])("recognizes %s", (name) => {
    expect(isKnownManifestOrLockfileName(name)).toBe(true);
  });

  test("does not recognize an ordinary source file", () => {
    expect(isKnownManifestOrLockfileName("index.ts")).toBe(false);
  });

  test("does not recognize a manifest-adjacent name it does not track", () => {
    expect(isKnownManifestOrLockfileName("requirements.txt")).toBe(false);
  });
});
