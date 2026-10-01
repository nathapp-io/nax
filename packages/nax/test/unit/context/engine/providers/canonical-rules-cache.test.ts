/**
 * canonical-rules-cache.ts — unit tests
 *
 * The memo key is the workdir alone. This suite pins the memoization
 * semantics (one loader pass per distinct workdir, rejections uncached,
 * reset clearing the map) and, at the type level, that the wrapper exposes
 * no `options` parameter — a budget passed by one caller must not be
 * swallowed by whichever caller populated the entry first.
 *
 * Filesystem calls are intercepted through the loader's own
 * `_canonicalLoaderDeps` seam, so no `mock.module()`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _resetCanonicalRulesCache,
  memoizedLoadCanonicalRules,
} from "@/context/engine/providers/canonical-rules-cache";
import { _canonicalLoaderDeps } from "@/context/rules/canonical-loader";

let origGlobInDir: typeof _canonicalLoaderDeps.globInDir;
let origReadFile: typeof _canonicalLoaderDeps.readFile;

beforeEach(() => {
  origGlobInDir = _canonicalLoaderDeps.globInDir;
  origReadFile = _canonicalLoaderDeps.readFile;
  _resetCanonicalRulesCache();
});

afterEach(() => {
  _canonicalLoaderDeps.globInDir = origGlobInDir;
  _canonicalLoaderDeps.readFile = origReadFile;
  _resetCanonicalRulesCache();
});

// ─────────────────────────────────────────────────────────────────────────────
// Type-level: the memo exposes no options parameter
// ─────────────────────────────────────────────────────────────────────────────

/** Compile-time assertion: fails to typecheck (TS2344) unless `T` is `true`. */
type AssertTrue<T extends true> = T;

/**
 * `Parameters<...>["length"]` is `1` only when `workdir` is the sole
 * parameter. An optional second parameter widens it to `1 | 2`, and
 * `1 | 2 extends 1` is `false`, so re-adding `options` fails `bun run
 * typecheck` instead of silently swallowing the first caller's budget.
 */
type _RuleMemoTakesNoOptions = AssertTrue<
  Parameters<typeof memoizedLoadCanonicalRules>["length"] extends 1 ? true : false
>;

// ─────────────────────────────────────────────────────────────────────────────
// Memoization semantics
// ─────────────────────────────────────────────────────────────────────────────

describe("memoizedLoadCanonicalRules", () => {
  test("returns the same in-flight promise for the same workdir", async () => {
    _canonicalLoaderDeps.globInDir = () => [];
    const first = memoizedLoadCanonicalRules("/repo");
    const second = memoizedLoadCanonicalRules("/repo");
    expect(second).toBe(first);
    await first;
  });

  test("scans the rules store once per distinct workdir", async () => {
    const scannedDirs: string[] = [];
    _canonicalLoaderDeps.globInDir = (dir) => {
      scannedDirs.push(dir);
      return [];
    };

    await memoizedLoadCanonicalRules("/repo");
    await memoizedLoadCanonicalRules("/repo");
    expect(scannedDirs).toHaveLength(1);

    await memoizedLoadCanonicalRules("/other");
    expect(scannedDirs).toHaveLength(2);
  });

  test("does not cache a rejected load", async () => {
    let scans = 0;
    _canonicalLoaderDeps.globInDir = () => {
      scans++;
      return ["/repo/.nax/rules/bad.md"];
    };
    // Neutrality lint violation — loadCanonicalRules rejects rather than
    // returning a partial corpus.
    _canonicalLoaderDeps.readFile = async () => "See CLAUDE.md for details.";

    await expect(memoizedLoadCanonicalRules("/repo")).rejects.toBeDefined();
    await expect(memoizedLoadCanonicalRules("/repo")).rejects.toBeDefined();
    expect(scans).toBe(2);
  });

  test("_resetCanonicalRulesCache forces a fresh load", async () => {
    let scans = 0;
    _canonicalLoaderDeps.globInDir = () => {
      scans++;
      return [];
    };

    await memoizedLoadCanonicalRules("/repo");
    await memoizedLoadCanonicalRules("/repo");
    expect(scans).toBe(1);

    _resetCanonicalRulesCache();
    await memoizedLoadCanonicalRules("/repo");
    expect(scans).toBe(2);
  });
});
