import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { botGit } from "@/bot/git";
import { autoCommitIfDirty } from "@/utils/git";

let root: string;
let repo: string;
let worktree: string;
let marker: string;
let initial: string;
const statePath = ".nax/features/x/prd.json";

/**
 * These tests drive real git and real hook executables, so their wall clock is
 * dominated by process work rather than by the code under test. The suite-wide
 * 5s per-test ceiling is not enough for a spawn-heavy fixture on a loaded
 * runner, so each test carries an explicit budget.
 */
const TEST_TIMEOUT_MS = 30_000;

async function git(args: string[], cwd = worktree): Promise<string> {
  const result = await botGit(args, cwd);
  expect(result.exitCode).toBe(0);
  return result.stdout.trim();
}

// The repo and its worktree are built ONCE for the file and the worktree is
// reset between tests. macOS charges roughly 150ms for the FIRST exec of every
// freshly written executable, so a fixture that rewrote the four hook scripts
// per test spent most of its budget in the kernel; keeping the scripts (and
// therefore their inode) means only the first test pays that cost.
beforeAll(async () => {
  root = makeTempDir("bot-fix-commit-hooks-");
  repo = join(root, "repo");
  worktree = join(root, "worktree");
  marker = join(root, "marker");
  await git(["init", "-b", "main", repo], root);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "Test"], repo);
  await Bun.write(join(repo, "source.txt"), "base");
  await Bun.write(join(repo, statePath), '{"tracked":true}\n');
  for (const hook of ["pre-commit", "commit-msg", "post-commit", "post-checkout"]) {
    const path = join(repo, ".husky/_", hook);
    await Bun.write(path, `#!/bin/sh\nprintf '%s\\n' '${hook}' >> '${marker}'\n`);
    await chmod(path, 0o755);
  }
  await git(["add", "."], repo);
  await git(["commit", "-m", "fixture"], repo);
  await git(["config", "core.hooksPath", ".husky/_"], repo);
  await git(["worktree", "add", "--detach", worktree, "HEAD"], repo);
  initial = await git(["rev-parse", "HEAD"]);
});

beforeEach(async () => {
  // Back to the fixture commit, with nothing untracked left over: each test
  // starts from the same tree the auto-commit is meant to repair.
  await git(["reset", "--hard", initial], worktree);
  await git(["clean", "-fd"], worktree);
  if (await Bun.file(marker).exists()) await Bun.file(marker).delete();
  expect(await Bun.file(marker).exists()).toBe(false);
  await Bun.write(join(worktree, "source.txt"), "leftover fix");
});

afterAll(() => cleanupTempDir(root));

describe("autoCommitIfDirty bot hook boundary", () => {
  test(
    "bot runner commits leftover edits without relative commit hooks",
    async () => {
      await autoCommitIfDirty(worktree, "workflow", "wf-branch-fix", "_run", false, botGit);
      expect(await git(["rev-parse", "HEAD"])).not.toBe(initial);
      expect(await git(["show", "HEAD:source.txt"])).toBe("leftover fix");
      expect(await git(["status", "--porcelain"])).toBe("");
      expect(await Bun.file(marker).exists()).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
  test(
    "bot runner restores tracked nax state without post-checkout hooks",
    async () => {
      await Bun.file(join(worktree, statePath)).delete();
      await autoCommitIfDirty(worktree, "workflow", "wf-branch-fix", "_run", false, botGit);
      expect(await Bun.file(join(worktree, statePath)).text()).toBe('{"tracked":true}\n');
      expect(await git(["rev-parse", "HEAD"])).not.toBe(initial);
      expect(await Bun.file(marker).exists()).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
  test(
    "default runner restores tracked nax state and fires the relative post-checkout hook",
    async () => {
      await Bun.file(join(worktree, statePath)).delete();
      await autoCommitIfDirty(worktree, "workflow", "wf-branch-fix", "_run");
      expect(await Bun.file(join(worktree, statePath)).text()).toBe('{"tracked":true}\n');
      expect(await git(["rev-parse", "HEAD"])).not.toBe(initial);
      expect((await Bun.file(marker).text()).trim().split("\n")).toEqual([
        "post-checkout",
        "pre-commit",
        "commit-msg",
        "post-commit",
      ]);
    },
    TEST_TIMEOUT_MS,
  );
  test(
    "default runner preserves live relative commit hooks",
    async () => {
      await autoCommitIfDirty(worktree, "workflow", "wf-branch-fix", "_run");
      expect(await git(["rev-parse", "HEAD"])).not.toBe(initial);
      expect((await Bun.file(marker).text()).trim().split("\n")).toEqual(["pre-commit", "commit-msg", "post-commit"]);
    },
    TEST_TIMEOUT_MS,
  );
});
