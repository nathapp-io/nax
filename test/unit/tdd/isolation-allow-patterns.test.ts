// Split from isolation.test.ts by concern (see test-architecture.md): that file
// covers getChangedFiles, this one covers how allow patterns are matched.
//
// L9 (review 2026-08-14): allow patterns were interpolated straight into a
// RegExp, so regex metacharacters in ordinary directory names changed meaning.
// Three distinct failure modes, all reachable from real paths:
//   - `.` matched any character, so the pattern `src/a.ts` also allowed
//     `src/axts.ts` — WIDENING the allowlist, downgrading a hard violation to soft
//   - `[id]`, `a+b`, `app(1)` matched nothing, so a genuinely-allowed file was
//     reported as a hard violation
//   - an unbalanced `(` threw out of the isolation check entirely

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { verifyTestWriterIsolation } from "@/tdd";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

describe("verifyTestWriterIsolation — allow-pattern matching", () => {
  let dir: string;

  beforeEach(async () => {
    dir = makeTempDir("nax-isolation-allow-");
    await Bun.write(`${dir}/seed.txt`, "seed");
    await git(dir, ["init", "-q"]);
    await git(dir, ["config", "user.email", "t@t"]);
    await git(dir, ["config", "user.name", "t"]);
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-qm", "base"]);
  });

  afterEach(() => {
    cleanupTempDir(dir);
  });

  /**
   * Write a source file and return the isolation result for the given allow patterns.
   *
   * `git add -- <file>` matters twice over: when an entire directory is
   * untracked `git status --porcelain` collapses it to a single `?? src/`
   * entry so the file never reaches the matcher, and the `--` stops git
   * treating a name like `src/[id]/page.ts` as a pathspec glob.
   */
  async function checkWith(file: string, allowedPaths: string[]) {
    await Bun.write(`${dir}/${file}`, "export const x = 1;\n");
    await git(dir, ["add", "--", file]);
    return verifyTestWriterIsolation(dir, "HEAD", allowedPaths);
  }

  test("treats `.` in a pattern literally instead of as a wildcard", async () => {
    const result = await checkWith("src/axts.ts", ["src/a.ts"]);
    expect(result.softViolations).not.toContain("src/axts.ts");
    expect(result.violations).toContain("src/axts.ts");
  });

  test("matches a bracketed directory against its own literal pattern", async () => {
    const result = await checkWith("src/[id]/page.ts", ["src/[id]/**"]);
    expect(result.softViolations).toContain("src/[id]/page.ts");
    expect(result.violations).not.toContain("src/[id]/page.ts");
  });

  test("matches a `+` directory against its own literal pattern", async () => {
    const result = await checkWith("src/a+b/page.ts", ["src/a+b/**"]);
    expect(result.softViolations).toContain("src/a+b/page.ts");
    expect(result.violations).not.toContain("src/a+b/page.ts");
  });

  test("matches a parenthesised directory against its own literal pattern", async () => {
    const result = await checkWith("src/app(1)/page.ts", ["src/app(1)/**"]);
    expect(result.softViolations).toContain("src/app(1)/page.ts");
    expect(result.violations).not.toContain("src/app(1)/page.ts");
  });

  test("does not throw on a pattern containing an unbalanced parenthesis", async () => {
    const result = await checkWith("src/plain.ts", ["src/a(b/**"]);
    expect(result.violations).toContain("src/plain.ts");
  });

  test("still honours ** across directories", async () => {
    const result = await checkWith("src/a/b/index.ts", ["src/**/index.ts"]);
    expect(result.softViolations).toContain("src/a/b/index.ts");
  });

  test("still honours * within a single segment", async () => {
    const result = await checkWith("src/thing.ts", ["src/*.ts"]);
    expect(result.softViolations).toContain("src/thing.ts");
  });

  test("* does not cross a directory separator", async () => {
    const result = await checkWith("src/deep/thing.ts", ["src/*.ts"]);
    expect(result.softViolations).not.toContain("src/deep/thing.ts");
  });
});
