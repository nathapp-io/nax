// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import { packageWorkdir } from "@/runtime/packages";

/**
 * packageDir is "" for the root package of every single-package repo
 * (toRelativeKey returns "" when packageDir === repoRoot). Passing that to a
 * spawn's cwd silently means process.cwd() — the directory nax was launched
 * from — so every caller that needs a real directory must resolve through here.
 */
describe("packageWorkdir", () => {
  test("an empty packageDir resolves to the repo root, never to ''", () => {
    expect(packageWorkdir({ packageDir: "", repoRoot: "/repo" })).toBe("/repo");
  });

  test("a relative packageDir is joined onto the repo root", () => {
    expect(packageWorkdir({ packageDir: "packages/a", repoRoot: "/repo" })).toBe("/repo/packages/a");
  });

  test("an absolute packageDir is used as-is", () => {
    expect(packageWorkdir({ packageDir: "/abs/pkg", repoRoot: "/repo" })).toBe("/abs/pkg");
  });

  test("an absolute packageDir wins even with no repo root", () => {
    expect(packageWorkdir({ packageDir: "/abs/pkg", repoRoot: "" })).toBe("/abs/pkg");
  });

  test("a relative packageDir with no repo root is returned unchanged", () => {
    expect(packageWorkdir({ packageDir: "packages/a", repoRoot: "" })).toBe("packages/a");
  });

  test("both empty yields empty — the caller must reject it, not spawn against it", () => {
    expect(packageWorkdir({ packageDir: "", repoRoot: "" })).toBe("");
  });
});
