// test/unit/scripts/repo-root.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "@scripts/lib/repo-root";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

let dir: string | undefined;
afterEach(() => {
  if (dir) cleanupTempDir(dir);
  dir = undefined;
});

describe("findRepoRoot", () => {
  test("returns the nearest ancestor holding a .git directory", () => {
    dir = makeTempDir("nax-repo-root-");
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "packages", "nax", "scripts"), { recursive: true });
    expect(findRepoRoot(join(dir, "packages", "nax", "scripts"))).toBe(dir);
  });

  test("accepts a .git FILE (git worktree checkout)", () => {
    dir = makeTempDir("nax-repo-root-");
    writeFileSync(join(dir, ".git"), "gitdir: /elsewhere\n");
    mkdirSync(join(dir, "a"), { recursive: true });
    expect(findRepoRoot(join(dir, "a"))).toBe(dir);
  });

  test("returns start itself when start is the root", () => {
    dir = makeTempDir("nax-repo-root-");
    mkdirSync(join(dir, ".git"));
    expect(findRepoRoot(dir)).toBe(dir);
  });

  test("throws naming the start dir when no ancestor has .git", () => {
    expect(() => findRepoRoot("/")).toThrow(/no \.git found above \//);
  });

  test("finds this repository from this test file", () => {
    const root = findRepoRoot(import.meta.dir);
    expect(Bun.file(join(root, ".nax", "config.json")).size).toBeGreaterThan(0);
  });
});
