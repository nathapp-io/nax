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
 * `lastIndex` state between calls).
 */

import { describe, expect, test } from "bun:test";
import { globToRegex } from "@/context/engine";

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
