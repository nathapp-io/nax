/**
 * `commitPrdProgress` against a real git repository (#2533).
 *
 * The unit tests pin the argv; this file pins what the argv does to a
 * repository. The whole point of committing the PRD is that the status write
 * stops being an uncommitted modification in the working tree, so it has to
 * hold against real git semantics: a pathspec commit, an unrelated edit left
 * exactly as it was found, and an ignored PRD left alone.
 *
 * Every expectation reads the repository back (`git log`, `git show`,
 * `git status --porcelain`) rather than the arguments nax passed, because the
 * failure being fixed is invisible in the argv — `git commit -- <path>` looks
 * identical whether or not it swept a neighbour in.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makePRD, makeStory, makeTempDir, withWarnSpy } from "@test/helpers";
import { commitPrdProgress, markStoryPassed, savePRD } from "@/prd";

let repo: string;
let prdPath: string;

const PRD_REL = ".nax/features/f/prd.json";
const PROGRESS = { feature: "f", storyId: "US-001", label: "passed" };

/** Run git in the fixture repo and return its trimmed stdout plus exit code. */
async function git(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), exitCode };
}

function write(relPath: string, contents: string): Promise<number> {
  return Bun.write(join(repo, relPath), contents);
}

/** The subject line of HEAD. */
async function headSubject(): Promise<string> {
  return (await git(["log", "-1", "--pretty=%s"])).stdout;
}

/** Repo-rooted paths the HEAD commit touched. */
async function headFiles(): Promise<string[]> {
  return (await git(["show", "--name-only", "--pretty=format:", "HEAD"])).stdout.split("\n").filter(Boolean);
}

/**
 * The `XY` columns `git status --porcelain` prints for one path, untrimmed —
 * the leading column is the index status and the second the worktree's, so
 * trimming would make "staged" and "modified" indistinguishable.
 */
async function statusColumns(relPath: string): Promise<string> {
  const proc = Bun.spawn(["git", "status", "--porcelain", "--", relPath], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout.replace(/\n+$/, "");
}

/** The seeded PRD with US-001 marked passed and written back, as a stage does. */
async function passStoryOnDisk(): Promise<void> {
  const prd = await Bun.file(prdPath).json();
  markStoryPassed(prd, "US-001");
  await savePRD(prd, prdPath);
}

beforeEach(async () => {
  repo = makeTempDir("nax-prd-progress-git-");
  prdPath = join(repo, PRD_REL);

  await git(["init"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test User"]);

  const prd = makePRD({
    feature: "f",
    userStories: [makeStory({ id: "US-001", status: "pending", passes: false })],
  });
  await Bun.write(prdPath, `${JSON.stringify(prd, null, 2)}\n`);
  await write("README.md", "# fixture\n");
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "chore: seed"]);
});

afterEach(() => {
  cleanupTempDir(repo);
});

describe("commitPrdProgress — against a real repository", () => {
  test("AC-1: commits the status change as `chore(f): progress US-001 passed`", async () => {
    const before = (await git(["rev-parse", "HEAD"])).stdout;
    await passStoryOnDisk();

    await commitPrdProgress({ prdPath, ...PROGRESS });

    expect(await headSubject()).toBe("chore(f): progress US-001 passed");
    expect((await git(["rev-parse", "HEAD"])).stdout).not.toBe(before);
    // The status change is what the commit carries.
    const committedPrd = await git(["show", `HEAD:${PRD_REL}`]);
    expect(committedPrd.exitCode).toBe(0);
    expect(committedPrd.stdout).toContain('"status": "passed"');
  });

  test("AC-2: the commit contains only the PRD", async () => {
    await passStoryOnDisk();

    await commitPrdProgress({ prdPath, ...PROGRESS });

    expect(await headFiles()).toEqual([PRD_REL]);
  });

  test("AC-3: returns true when it created the commit", async () => {
    await passStoryOnDisk();

    const committed = await commitPrdProgress({ prdPath, ...PROGRESS });

    expect(committed).toBe(true);
  });

  test("AC-4: an unrelated staged edit stays staged and out of the commit", async () => {
    await write("staged.txt", "already staged\n");
    await git(["add", "staged.txt"]);
    await passStoryOnDisk();

    await commitPrdProgress({ prdPath, ...PROGRESS });

    expect(await headFiles()).toEqual([PRD_REL]);
    // Still in the index (first column `A`), still uncommitted.
    expect(await statusColumns("staged.txt")).toBe("A  staged.txt");
  });

  test("AC-5: an unrelated unstaged edit stays unstaged and out of the commit", async () => {
    await write("README.md", "# fixture\nedited\n");
    await passStoryOnDisk();

    await commitPrdProgress({ prdPath, ...PROGRESS });

    expect(await headFiles()).toEqual([PRD_REL]);
    expect(await statusColumns("README.md")).toBe(" M README.md");
  });

  test("AC-6: an unchanged PRD creates no commit and returns false", async () => {
    const before = (await git(["rev-parse", "HEAD"])).stdout;

    const committed = await commitPrdProgress({ prdPath, ...PROGRESS });

    expect(committed).toBe(false);
    expect((await git(["rev-parse", "HEAD"])).stdout).toBe(before);
    // `git add` on an unchanged path must not leave the tree looking modified.
    expect(await statusColumns(PRD_REL)).toBe("");
  });

  test("AC-7: a PRD ignored by .gitignore is left alone, with no warn", async () => {
    // The realistic shape: the repository ignores `.nax/features/**`, so the PRD
    // was never committed and `git add` refuses it. Untracking it here is what
    // makes the ignore rule apply — git does not report a tracked path as ignored.
    await write(".gitignore", `${PRD_REL}\n`);
    await git(["rm", "-q", "--cached", PRD_REL]);
    await git(["add", ".gitignore"]);
    await git(["commit", "-q", "-m", "chore: stop tracking the PRD"]);
    // Precondition: the rule really applies, so a "false + no warn" below can
    // only come from the ignore check and not from some other early exit.
    expect((await git(["check-ignore", "-q", PRD_REL])).exitCode).toBe(0);
    const before = (await git(["rev-parse", "HEAD"])).stdout;
    await passStoryOnDisk();

    await withWarnSpy(async (warnSpy) => {
      const committed = await commitPrdProgress({ prdPath, ...PROGRESS });

      expect(committed).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    });
    expect((await git(["rev-parse", "HEAD"])).stdout).toBe(before);
    expect(await statusColumns(PRD_REL)).toBe("");
  });
});
