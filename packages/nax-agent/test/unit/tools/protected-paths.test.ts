import { describe, expect, test } from "bun:test";
import { gitExcludePathspecsOf, gitIgnorePatternsOf } from "#src/tools/index";
import { testProtectedPaths } from "#test/helpers/index";

describe("protected-paths accessors", () => {
  test("a session with a policy hands back its lists", () => {
    const policy = testProtectedPaths();
    expect(gitExcludePathspecsOf({ protectedPaths: policy })).toBe(policy.gitExcludePathspecs);
    expect(gitIgnorePatternsOf({ protectedPaths: policy })).toBe(policy.gitIgnorePatterns);
  });

  test("a session with no policy gets empty lists, never undefined", () => {
    expect(gitExcludePathspecsOf({})).toEqual([]);
    expect(gitIgnorePatternsOf({})).toEqual([]);
  });
});
