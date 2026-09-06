import { describe, expect, test } from "bun:test";
import { isKnownManifestOrLockfileName, recordExecTouchedPaths } from "@/tools/exec-touched-paths";

describe("recordExecTouchedPaths", () => {
  test("appends the manifest and lockfile(s) for a known manager, resolved absolutely", () => {
    const target: string[] = [];
    recordExecTouchedPaths(target, "bun", "/repo");
    expect(target).toEqual(["/repo/package.json", "/repo/bun.lock", "/repo/bun.lockb"]);
  });

  test("uses the cwd actually given, not the process cwd", () => {
    const target: string[] = [];
    recordExecTouchedPaths(target, "npm", "/repo/packages/foo");
    expect(target).toEqual(["/repo/packages/foo/package.json", "/repo/packages/foo/package-lock.json"]);
  });

  test("is a no-op for a manager with no known lockfile shape", () => {
    const target: string[] = [];
    recordExecTouchedPaths(target, "pip", "/repo");
    expect(target).toEqual([]);
  });

  test("is a no-op for an unrecognized manager string", () => {
    const target: string[] = [];
    recordExecTouchedPaths(target, "curl", "/repo");
    expect(target).toEqual([]);
  });

  test("does not duplicate an already-recorded path", () => {
    const target: string[] = ["/repo/package.json"];
    recordExecTouchedPaths(target, "bun", "/repo");
    expect(target).toEqual(["/repo/package.json", "/repo/bun.lock", "/repo/bun.lockb"]);
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
