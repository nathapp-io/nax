/**
 * Symlink-tolerant path normalisation tests.
 *
 * These exist because the mutation spot-check compares paths from two sources
 * that spell the same location differently — git's realpath output against the
 * caller's supplied path — and an unresolved comparison fails closed, silently
 * producing zero mutation candidates.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { isInside, realOrRaw } from "#src/internal/realpath";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

const created: string[] = [];

function makeDir(): string {
  const dir = makeTempDir("nax-realpath-test-");
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) cleanupTempDir(dir);
});

describe("realOrRaw", () => {
  test("resolves a symlinked ancestor for a path that exists", () => {
    const dir = makeDir();
    const target = join(dir, "real");
    mkdirSync(target);
    const link = join(dir, "link");
    symlinkSync(target, link);

    expect(realOrRaw(link)).toBe(realOrRaw(target));
  });

  test("resolves a symlinked ancestor even when several trailing segments are missing", () => {
    // The regression: resolving only the immediate parent left this path
    // half-resolved, so it compared unequal to a fully-resolved root and every
    // containment check on it failed closed.
    const dir = makeDir();
    const target = join(dir, "real");
    mkdirSync(target);
    const link = join(dir, "link");
    symlinkSync(target, link);

    const missing = join(link, "src", "nested", "deep", "foo.ts");
    expect(realOrRaw(missing)).toBe(join(realOrRaw(target), "src", "nested", "deep", "foo.ts"));
  });

  test("falls back to the lexical absolute form when nothing resolves", () => {
    const nowhere = "/nax-does-not-exist-9f3a/src/foo.ts";
    expect(realOrRaw(nowhere)).toBe(resolve(nowhere));
  });

  test("is idempotent", () => {
    const dir = makeDir();
    const once = realOrRaw(dir);
    expect(realOrRaw(once)).toBe(once);
  });
});

describe("realOrRaw — dangling symlinks", () => {
  function makeRoot(): { tmp: string; root: string } {
    const tmp = realpathSync(makeDir());
    const root = join(tmp, "root");
    mkdirSync(root);
    return { tmp, root };
  }

  test("follows a relative dangling link to where a write would land", () => {
    const { tmp, root } = makeRoot();
    symlinkSync("../outside/new.txt", join(root, "out"));
    expect(realOrRaw(join(root, "out"))).toBe(join(tmp, "outside", "new.txt"));
  });

  test("follows a dangling directory link and re-attaches the trailing segment", () => {
    const { tmp, root } = makeRoot();
    symlinkSync("../outside/missing-dir", join(root, "dir-link"));
    expect(realOrRaw(join(root, "dir-link", "new.txt"))).toBe(join(tmp, "outside", "missing-dir", "new.txt"));
  });

  test("follows an absolute dangling link", () => {
    const { tmp, root } = makeRoot();
    symlinkSync(join(tmp, "elsewhere", "missing.txt"), join(root, "abs-link"));
    expect(realOrRaw(join(root, "abs-link"))).toBe(join(tmp, "elsewhere", "missing.txt"));
  });

  test("applies `..` in a link target after following an existing symlinked directory", () => {
    const { tmp, root } = makeRoot();
    mkdirSync(join(tmp, "outside", "deep"), { recursive: true });
    symlinkSync("../outside/deep", join(root, "evil"));
    symlinkSync("evil/../x", join(root, "lnk"));
    // The kernel resolves evil first, so `..` lands in outside/, not in root/.
    expect(realOrRaw(join(root, "lnk"))).toBe(join(tmp, "outside", "x"));
  });

  test("returns the lexical form without throwing on a symlink cycle", () => {
    const { root } = makeRoot();
    symlinkSync("b", join(root, "a"));
    symlinkSync("a", join(root, "b"));
    expect(realOrRaw(join(root, "a"))).toBe(join(root, "a"));
  });
});

describe("isInside", () => {
  test("matches when root and file spell the same location differently", () => {
    const dir = makeDir();
    const target = join(dir, "real");
    mkdirSync(target);
    const link = join(dir, "link");
    symlinkSync(target, link);

    // Root given in resolved form, file in symlinked form — the exact shape
    // `getGitRoot` (realpath) vs a caller-supplied `repoRoot` produces.
    expect(isInside(realOrRaw(target), join(link, "src", "foo.ts"))).toBe(true);
    expect(isInside(target, join(link, "src", "foo.ts"))).toBe(true);
  });

  test("treats the root itself as inside", () => {
    const dir = makeDir();
    expect(isInside(dir, dir)).toBe(true);
  });

  test("rejects a sibling whose path merely shares a prefix", () => {
    const dir = makeDir();
    const root = join(dir, "pkg");
    mkdirSync(root);
    mkdirSync(join(dir, "pkg-other"));

    expect(isInside(root, join(dir, "pkg-other", "foo.ts"))).toBe(false);
  });

  test("rejects a path outside the root", () => {
    const dir = makeDir();
    const root = join(dir, "pkg");
    mkdirSync(root);

    expect(isInside(root, join(dir, "elsewhere.ts"))).toBe(false);
  });
});
