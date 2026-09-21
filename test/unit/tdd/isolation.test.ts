import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeSpawn, makeTempDir } from "@test/helpers";
import { NaxError } from "@/errors";
import { _isolationDeps, getChangedFiles, verifyTestWriterIsolation } from "@/tdd";
import { getAddedLinesPerFile, verifyImplementerIsolation } from "@/tdd/isolation";

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

describe("getChangedFiles", () => {
  let dir: string;

  beforeEach(async () => {
    dir = makeTempDir("nax-isolation-getchanged-");
    await Bun.write(`${dir}/tracked.txt`, "v1");
    await git(dir, ["init", "-q"]);
    await git(dir, ["config", "user.email", "t@t"]);
    await git(dir, ["config", "user.name", "t"]);
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-qm", "base"]);
  });

  afterEach(() => {
    cleanupTempDir(dir);
  });

  // BUG-34: `git diff --name-only` alone is blind to untracked files — a
  // TDD session's brand-new stub/test file must still show up so isolation
  // checks can catch it.
  test("includes untracked (new) files alongside tracked modifications", async () => {
    await Bun.write(`${dir}/tracked.txt`, "v2"); // modified — visible via git diff
    await Bun.write(`${dir}/brand-new.ts`, "export const x = 1;"); // untracked — the regression

    const changed = await getChangedFiles(dir, "HEAD");

    expect(new Set(changed)).toEqual(new Set(["tracked.txt", "brand-new.ts"]));
  });

  test("dedupes when a file appears in both diff and status output", async () => {
    await Bun.write(`${dir}/tracked.txt`, "v2");

    const changed = await getChangedFiles(dir, "HEAD");

    expect(changed.filter((f) => f === "tracked.txt")).toHaveLength(1);
  });

  test("returns only tracked changes when there are no untracked files", async () => {
    await Bun.write(`${dir}/tracked.txt`, "v2");

    const changed = await getChangedFiles(dir, "HEAD");

    expect(changed).toEqual(["tracked.txt"]);
  });
});

// BUG-31: a wedged git (NFS / lock contention) must not stall the TDD
// isolation stage indefinitely. `_isolationDeps.timeoutMs` is injected short
// here (mirrors `_gitDeps.timeoutRetryGitTimeoutMs` in `src/utils/git.ts`) so
// this test asserts the SIGKILL contract without burning the full 10s
// production timeout in wall-clock.
describe("runGitBounded (via getChangedFiles / getAddedLinesPerFile)", () => {
  let origSpawn: typeof _isolationDeps.spawn;
  let origTimeoutMs: typeof _isolationDeps.timeoutMs;
  let killed: boolean;

  beforeEach(() => {
    origSpawn = _isolationDeps.spawn;
    origTimeoutMs = _isolationDeps.timeoutMs;
    _isolationDeps.timeoutMs = 50;
    killed = false;
    // Simulates real Bun.spawn behaviour via the shared stub: proc.kill()
    // resolves the exited promise (128 + SIGKILL(9) = 137), so the
    // `await proc.exited` in runGitBounded unblocks instead of hanging
    // forever on a mock.
    _isolationDeps.spawn = makeSpawn(() => ({
      hang: true,
      killResolvesExited: true,
      onKill: () => {
        killed = true;
      },
    })).spawn;
  });

  afterEach(() => {
    _isolationDeps.spawn = origSpawn;
    _isolationDeps.timeoutMs = origTimeoutMs;
  });

  test("getChangedFiles rejects and SIGKILLs the process when git hangs", async () => {
    await expect(getChangedFiles("/tmp/does-not-matter", "HEAD")).rejects.toThrow(/timed out/);
    expect(killed).toBe(true);
  });

  test("getAddedLinesPerFile rejects when git hangs", async () => {
    await expect(getAddedLinesPerFile("/tmp/does-not-matter", "HEAD")).rejects.toThrow(/timed out/);
    expect(killed).toBe(true);
  });
});

// US-002: a failed `git diff --numstat` must surface through a NaxError with
// code "GIT_ERROR" carrying git stderr — not be silently turned into an empty
// Map. The empty Map was previously read as "no additions, no stub violations"
// and a git hiccup was reported as a test-writer offence.
describe("getAddedLinesPerFile (US-002: loud git failures)", () => {
  let origSpawn: typeof _isolationDeps.spawn;

  beforeEach(() => {
    origSpawn = _isolationDeps.spawn;
  });

  afterEach(() => {
    _isolationDeps.spawn = origSpawn;
  });

  // AC1 — numstat exit 1 with stderr "fatal: bad revision 'HEAD'" must
  // reject with NaxError code "GIT_ERROR" whose message contains the stderr.
  test("rejects with NaxError code GIT_ERROR when numstat exits non-zero", async () => {
    _isolationDeps.spawn = makeSpawn(() => ({
      stdout: "",
      stderr: "fatal: bad revision 'HEAD'\n",
      exitCode: 1,
    })).spawn;

    let caught: unknown;
    try {
      await getAddedLinesPerFile("/tmp/does-not-matter", "HEAD");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NaxError);
    if (!(caught instanceof NaxError)) throw new Error("expected NaxError");
    expect(caught.code).toBe("GIT_ERROR");
    expect(caught.message).toContain("bad revision");
  });

  // AC2 — numstat exit 0 with stdout "3\t0\tsrc/a.ts" must resolve to a map
  // mapping "src/a.ts" to 3. Sanity-check the success path stays untouched.
  test("returns a Map mapping path to added lines on numstat success", async () => {
    _isolationDeps.spawn = makeSpawn(() => ({
      stdout: "3\t0\tsrc/a.ts\n",
      exitCode: 0,
    })).spawn;

    const result = await getAddedLinesPerFile("/tmp/does-not-matter", "HEAD");

    expect(result.get("src/a.ts")).toBe(3);
  });
});

// L9 (review 2026-08-14): allow patterns were interpolated straight into a
// RegExp, so regex metacharacters in ordinary directory names changed meaning.
// Three distinct failure modes, all reachable from real paths:
//   - `.` matched any character, so the pattern `src/a.ts` also allowed
//     `src/axts.ts` — WIDENING the allowlist, downgrading a hard violation to soft
//   - `[id]`, `a+b`, `app(1)` matched nothing, so a genuinely-allowed file was
//     reported as a hard violation
//   - an unbalanced `(` threw out of the isolation check entirely
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

/**
 * An empty workdir must not silently become process.cwd().
 *
 * packageView.packageDir is "" for the root package of every single-package
 * repo (see toRelativeKey in runtime/packages.ts), and Bun.spawn treats cwd:""
 * as unset. Running nax from one repository against another with `-d` therefore
 * ran the isolation diff in the *launching* repo, where the target repo's SHA is
 * a bad object — every story failed with "fatal: bad object <sha>". See
 * docs/superpowers/specs/2026-09-02-plan-4-results.md.
 */
describe("isolation git calls reject an empty workdir", () => {
  // Scoped to this describe so the restore does not leak into the receiver's
  // tests (the satellite stubbed `_isolationDeps.spawn` from a top-level hook).
  const realSpawn = _isolationDeps.spawn;
  afterEach(() => {
    _isolationDeps.spawn = realSpawn;
  });

  test("verifyImplementerIsolation rejects rather than falling back to process.cwd()", async () => {
    const stub = makeSpawn(() => "src/foo.ts\n");
    _isolationDeps.spawn = stub.spawn;

    await expect(verifyImplementerIsolation("", "abc123")).rejects.toThrow(/workdir/i);
    expect(stub.calls).toHaveLength(0);
  });

  test("verifyTestWriterIsolation rejects rather than falling back to process.cwd()", async () => {
    const stub = makeSpawn(() => "src/foo.ts\n");
    _isolationDeps.spawn = stub.spawn;

    await expect(verifyTestWriterIsolation("", "abc123")).rejects.toThrow(/workdir/i);
    expect(stub.calls).toHaveLength(0);
  });

  test("a real workdir is passed through to git as cwd", async () => {
    const stub = makeSpawn(() => "");
    _isolationDeps.spawn = stub.spawn;

    await verifyImplementerIsolation("/tmp/some-repo", "abc123");

    expect(stub.calls.length).toBeGreaterThan(0);
    for (const call of stub.calls) {
      expect(call.opts.cwd).toBe("/tmp/some-repo");
    }
  });
});
