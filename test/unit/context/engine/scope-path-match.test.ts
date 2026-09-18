/**
 * scope-path-match — glob compilation primitives.
 *
 * PERF-12: `globToRegex` used to be recompiled for every pattern × scope-file
 * pair — inside `files.some(...)` within `appliesTo.some(...)` in
 * `static-rules.ts`, and again per chunk in `effectiveness.ts`
 * `pathMatchesScope`. It now memoizes by the pattern string, so repeated
 * lookups of an already-seen pattern return the identical RegExp instance
 * instead of recompiling.
 *
 * Two properties matter and are both pinned below: the cache returns the SAME
 * instance for a repeated pattern, and reuse does not change match behavior
 * (the compiled regex carries no global/sticky flag, so `.test()` cannot carry
 * `lastIndex` state between calls). A third pins the PERF-12 review fix — the
 * key space includes runtime scope-file paths, not just authored config, so the
 * map is capped rather than unbounded.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { globToRegex } from "@/context/engine";
import {
  _globRegexCacheSize,
  _resetGlobRegexCache,
  MAX_GLOB_REGEX_CACHE_ENTRIES,
} from "@/context/engine/scope-path-match";

describe("scope-path-match", () => {
  // The memo is module-level and shared across this file's tests (and, in a
  // single-process run, across files). Reset around every test so an identity
  // assertion cannot be defeated by a cache already at the cap.
  beforeEach(() => _resetGlobRegexCache());
  afterEach(() => _resetGlobRegexCache());

  describe("globToRegex — memoization", () => {
    test("returns the same compiled RegExp instance for a repeated pattern", () => {
      const first = globToRegex("src/**/*.ts");
      const second = globToRegex("src/**/*.ts");
      expect(second).toBe(first);
    });

    test("returns distinct instances for distinct patterns", () => {
      expect(globToRegex("src/**/*.ts")).not.toBe(globToRegex("test/**/*.ts"));
    });

    test("a memoized regex keeps matching the same paths across calls", () => {
      const pattern = "packages/**/src/**/*.ts";
      const first = globToRegex(pattern);
      const second = globToRegex(pattern);

      expect(first.test("packages/api/src/foo.ts")).toBe(true);
      expect(second.test("packages/api/src/foo.ts")).toBe(true);
      expect(second.test("packages/api/lib/foo.ts")).toBe(false);
    });
  });

  describe("globToRegex — bounded memo (PERF-12 review)", () => {
    test("stops growing at the cap and still compiles/matches at the cap", () => {
      for (let i = 0; i <= MAX_GLOB_REGEX_CACHE_ENTRIES; i++) {
        globToRegex(`scope${i}/file?.ts`);
      }
      expect(_globRegexCacheSize()).toBe(MAX_GLOB_REGEX_CACHE_ENTRIES);

      // A later runtime path carrying a glob metacharacter (Next.js dynamic
      // route) is a cache miss at the cap: it must still compile and match,
      // and must not grow the map.
      const late = globToRegex("app/blog/[slug]/page.tsx");
      expect(late.test("app/blog/[slug]/page.tsx")).toBe(true);
      expect(late.test("app/blog/other/page.tsx")).toBe(false);
      expect(_globRegexCacheSize()).toBe(MAX_GLOB_REGEX_CACHE_ENTRIES);
    });

    test("already-cached patterns keep their identity after the cap is reached", () => {
      const early = globToRegex("early/**/*.ts");
      for (let i = 0; i <= MAX_GLOB_REGEX_CACHE_ENTRIES; i++) {
        globToRegex(`filler${i}/file?.ts`);
      }
      expect(globToRegex("early/**/*.ts")).toBe(early);
    });
  });
});
