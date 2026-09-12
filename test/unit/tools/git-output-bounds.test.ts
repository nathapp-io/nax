import { describe, expect, test } from "bun:test";
import { buildGitArgv, DEFAULT_LOG_MAX_COUNT, GIT_ESCAPE_FLAGS, gitTool } from "@/tools";

function argvOf(input: Record<string, unknown>): string[] {
  const built = buildGitArgv(input);
  if ("error" in built) throw new Error(`expected argv, got error: ${built.error}`);
  return built;
}

/**
 * `git log` was the one read verb with no bound on how much it returns: the
 * pathspec selects which commits to show, and every selected commit then prints
 * in full. In nax#2009 a single `log --name-only` on ONE test file returned
 * 79KB from 7 commits, because `--name-only` lists every file in each matching
 * commit rather than the path that selected it. It was the largest call in a
 * 267-call session.
 *
 * The bound is a commit count, not a byte cap -- `truncate()` already clips
 * bytes, but only after git has produced them and after the model has been
 * handed a result whose shape it cannot predict.
 */
describe("buildGitArgv — log output bounds", () => {
  test("emits --max-count=<n> for log", () => {
    expect(argvOf({ subcommand: "log", maxCount: 5 })).toContain("--max-count=5");
  });

  // An unscoped `log` walks the entire history of HEAD -- that is the shape
  // with no bound at all, and the one the default exists for.
  test("bounds a log that names no range", () => {
    expect(argvOf({ subcommand: "log" })).toContain(`--max-count=${DEFAULT_LOG_MAX_COUNT}`);
  });

  /**
   * A `refs` range is already a scope the caller chose, so a default on top of
   * it silently discards commits they asked for -- and unlike `truncate()`,
   * which appends "... [truncated at N bytes]", a commit cap appends nothing.
   * The model cannot tell 12 commits from 200-capped-to-20.
   *
   * This is not hypothetical: the reviewer prompt asks for a story's commit
   * history as `log <ref>..HEAD --oneline` (protocol-region.ts), and
   * `--max-count` keeps the NEWEST n -- so a long fix-cycle run would have lost
   * exactly the initial implementation commits, unmarked. Caught in review.
   */
  test("does not bound a log the caller has already scoped with refs", () => {
    const argv = argvOf({ subcommand: "log", refs: ["abc123..HEAD"] });
    expect(argv.some((arg) => arg.startsWith("--max-count="))).toBe(false);
  });

  test("the reviewer prompt's story-history call keeps its full range", () => {
    // The exact shape built by src/prompts/sections/protocol-region.ts.
    const argv = argvOf({ subcommand: "log", refs: ["abc123..HEAD"], oneline: true });
    expect(argv.some((arg) => arg.startsWith("--max-count="))).toBe(false);
    expect(argv).toContain("--oneline");
  });

  test("an explicit maxCount still applies when refs are given", () => {
    expect(argvOf({ subcommand: "log", refs: ["abc123..HEAD"], maxCount: 5 })).toContain("--max-count=5");
  });

  test("an explicit maxCount overrides the default", () => {
    const argv = argvOf({ subcommand: "log", maxCount: 3 });
    expect(argv).toContain("--max-count=3");
    expect(argv).not.toContain(`--max-count=${DEFAULT_LOG_MAX_COUNT}`);
  });

  // `show`, `diff`, `blame` and `status` each name what they operate on, so
  // none of them is unbounded in the way `log` is. Defaulting them would invent
  // a truncation the caller never asked for.
  test("bounds log only — no other verb gains a default", () => {
    for (const subcommand of ["diff", "show", "status", "blame"]) {
      expect(argvOf({ subcommand }).some((arg) => arg.startsWith("--max-count="))).toBe(false);
    }
  });

  test("rejects maxCount on a verb it does not apply to", () => {
    const built = buildGitArgv({ subcommand: "diff", maxCount: 5 });
    expect(built).toEqual({ error: '"maxCount" is not valid for "diff" (valid for: log)' });
  });

  // A non-integer reaches git as `--max-count=1.5` / `--max-count=NaN`, which
  // git rejects with its own error the model then has to interpret. Refusing
  // here is the clearer of the two, and matches how diffFilter is gated.
  // The exact message is asserted, not merely that SOMETHING was refused: a
  // bare `"error" in built` cannot tell "refused for the right reason" from
  // "refused by an unrelated guard", and would keep passing if the maxCount
  // check were deleted.
  test("rejects a maxCount that is not a positive integer", () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5", null, true, {}, []]) {
      expect(buildGitArgv({ subcommand: "log", maxCount: value })).toEqual({
        error: '"maxCount" must be a positive integer',
      });
    }
  });

  /**
   * `Number.isInteger(1e21)` is true and template interpolation renders it as
   * `1e+21`, so both of these reached git as `--max-count=1e+21` /
   * `--max-count=2147483648` and came back as `fatal: not an integer` -- the
   * exact "a git usage error the model has to interpret" class this field
   * exists to prevent. git's ceiling is INT_MAX. Caught in review.
   */
  test("rejects a maxCount above git's integer ceiling", () => {
    for (const value of [2_147_483_648, 1e21, Number.MAX_SAFE_INTEGER]) {
      expect(buildGitArgv({ subcommand: "log", maxCount: value })).toEqual({
        error: '"maxCount" must be a positive integer',
      });
    }
    expect(argvOf({ subcommand: "log", maxCount: 2_147_483_647 })).toContain("--max-count=2147483647");
  });

  test("does not fall back to the default when maxCount is invalid", () => {
    const built = buildGitArgv({ subcommand: "log", maxCount: 0 });
    expect("error" in built).toBe(true);
  });

  test("declares maxCount in the input schema so a model can reach it", () => {
    expect(gitTool.inputSchema).toMatchObject({
      properties: { maxCount: { type: "integer" } },
    });
  });

  test("a bounded log argv contains no repo-escape flag", () => {
    const argv = argvOf({ subcommand: "log", maxCount: 5, nameOnly: true, refs: ["HEAD"], paths: ["src"] });
    for (const flag of GIT_ESCAPE_FLAGS) {
      expect(argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`))).toBe(false);
    }
  });

  // Flags precede the refs for the same reason the existing flags do: a flag
  // after a revision list reads as a pathspec in the tool-audit ledger.
  test("places --max-count before the refs", () => {
    const argv = argvOf({ subcommand: "log", maxCount: 2, refs: ["HEAD"], paths: ["src/a.ts"] });
    // Asserted present first: indexOf returns -1 when absent, which would make
    // a bare "is before" comparison pass vacuously.
    expect(argv).toContain("--max-count=2");
    expect(argv.indexOf("--max-count=2")).toBeLessThan(argv.indexOf("HEAD"));
  });
});
