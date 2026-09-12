import { describe, expect, test } from "bun:test";
import { buildGitArgv, GIT_ESCAPE_FLAGS, gitTool } from "@/tools";
import { DEFAULT_LOG_MAX_COUNT } from "@/tools/git";

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

  // The defect was the ABSENCE of a bound, so the default is the load-bearing
  // half: a caller that does not know to ask is exactly the caller that got
  // 79KB back.
  test("bounds a log that does not ask for a bound", () => {
    expect(argvOf({ subcommand: "log" })).toContain(`--max-count=${DEFAULT_LOG_MAX_COUNT}`);
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
  test("rejects a maxCount that is not a positive integer", () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5", null, true]) {
      const built = buildGitArgv({ subcommand: "log", maxCount: value });
      expect("error" in built).toBe(true);
    }
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
