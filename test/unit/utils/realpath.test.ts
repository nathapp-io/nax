/**
 * Symlink-tolerant path normalisation tests.
 *
 * These exist because the mutation spot-check compares paths from two sources
 * that spell the same location differently — git's realpath output against the
 * caller's supplied path — and an unresolved comparison fails closed, silently
 * producing zero mutation candidates.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { isInside, realOrRaw } from "@/utils/realpath";

const created: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nax-realpath-test-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
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
