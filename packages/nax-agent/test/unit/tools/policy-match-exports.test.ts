import { describe, expect, test } from "bun:test";
import type { CompiledPattern } from "@nathapp/nax-agent";
import { compileArgvPattern, matchesArgvPattern } from "@nathapp/nax-agent";
import {
  compileArgvPattern as compileArgvPatternSource,
  matchesArgvPattern as matchesArgvPatternSource,
} from "#src/tools/policy-match";

describe("public argv matcher exports", () => {
  test("re-exports the native compileArgvPattern function object", () => {
    expect(compileArgvPattern).toBe(compileArgvPatternSource);
  });

  test("re-exports the native matchesArgvPattern function object", () => {
    expect(matchesArgvPattern).toBe(matchesArgvPatternSource);
  });

  test("matches a token-prefix pattern and rejects a shorter argv", () => {
    const pattern = compileArgvPattern("git status");
    expect(matchesArgvPattern(pattern, ["git", "status", "--short"])).toBe(true);
    expect(matchesArgvPattern(pattern, ["git"])).toBe(false);
  });

  test("matches per-token globs and rejects a different first token", () => {
    const pattern = compileArgvPattern("bun add*");
    expect(matchesArgvPattern(pattern, ["bun", "add-x", "pkg"])).toBe(true);
    expect(matchesArgvPattern(pattern, ["bunx", "add"])).toBe(false);
  });

  test("splits repeated whitespace into compiled source tokens", () => {
    const pattern: readonly CompiledPattern[] = compileArgvPattern("git  status");
    expect(pattern.map(({ source }) => source)).toEqual(["git", "status"]);
  });
});
