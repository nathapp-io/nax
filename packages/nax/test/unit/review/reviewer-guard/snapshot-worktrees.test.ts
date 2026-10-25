import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreRepoSnapshot, takeRepoSnapshot } from "@/review/reviewer-guard";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
}

/** Repo A on main, a second worktree B on branch b-branch, plus a branch `trunk`. */
async function twoWorktrees(): Promise<{ a: string; b: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nax-rguard-wt-")));
  dirs.push(root);
  const a = join(root, "a");
  const b = join(root, "b");
  await Bun.spawn(["mkdir", a]).exited;
  await git(a, "init", "-q", "-b", "main");
  await writeFile(join(a, "f.txt"), "f\n");
  await git(a, "add", "-A");
  await git(a, "commit", "-q", "-m", "seed");
  await git(a, "branch", "trunk");
  await git(a, "worktree", "add", "-q", "-b", "b-branch", b);
  return { a, b };
}

describe("reviewer guard restore with sibling worktrees (nax#2500 R15)", () => {
  test("other worktrees' branches, new branches and trunk are untouched; own branch is restored", async () => {
    const { a, b } = await twoWorktrees();
    const mainBefore = await git(a, "rev-parse", "main");
    const snap = await takeRepoSnapshot(a);
    await writeFile(join(b, "g.txt"), "g\n");
    await git(b, "add", "-A");
    await git(b, "commit", "-q", "-m", "b work");
    const bTip = await git(b, "rev-parse", "HEAD");
    await git(b, "branch", "fresh");
    await git(b, "branch", "-f", "trunk", bTip);
    await writeFile(join(a, "f.txt"), "reviewer\n");
    await git(a, "commit", "-qam", "reviewer commit");
    const report = await restoreRepoSnapshot(snap);
    expect(report.headRestored).toBe(true);
    expect(await git(a, "rev-parse", "main")).toBe(mainBefore);
    expect(await git(a, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(await git(a, "rev-parse", "b-branch")).toBe(bTip);
    expect(await git(a, "rev-parse", "fresh")).toBe(bTip);
    expect(await git(a, "rev-parse", "trunk")).toBe(bTip);
    expect(await git(b, "symbolic-ref", "--short", "HEAD")).toBe("b-branch");
    expect([...report.refsLeft].sort()).toEqual(
      ["added refs/heads/fresh", "moved refs/heads/b-branch", "moved refs/heads/trunk"].sort(),
    );
  });

  test("a stash pushed by another worktree during the turn is kept and reported", async () => {
    const { a, b } = await twoWorktrees();
    const snap = await takeRepoSnapshot(a);
    await writeFile(join(b, "f.txt"), "b wip\n");
    await git(b, "stash", "push", "-q");
    const sha = await git(b, "rev-parse", "stash@{0}");
    const report = await restoreRepoSnapshot(snap);
    expect(await git(a, "stash", "list", "--format=%H")).toBe(sha);
    expect(report.stashLeft).toEqual([`added ${sha}`]);
  });

  test("a stash popped during the turn is not stored back, only reported", async () => {
    const { a } = await twoWorktrees();
    await writeFile(join(a, "f.txt"), "wip\n");
    await git(a, "stash", "push", "-q");
    const sha = await git(a, "rev-parse", "stash@{0}");
    const snap = await takeRepoSnapshot(a);
    await git(a, "stash", "pop", "-q");
    const report = await restoreRepoSnapshot(snap);
    expect(await git(a, "stash", "list")).toBe("");
    expect(report.stashLeft).toEqual([`missing ${sha}`]);
  });

  // nax#2681: another process (nax bot fix) adds a worktree inside the checkout mid-turn.
  test("a worktree created under an ignored directory during the turn survives the restore", async () => {
    const { a } = await twoWorktrees();
    await writeFile(join(a, ".gitignore"), ".nax-wt/\n");
    await git(a, "add", "-A");
    await git(a, "commit", "-q", "-m", "ignore .nax-wt");
    const snap = await takeRepoSnapshot(a);
    await git(a, "worktree", "add", "-q", "--detach", join(a, ".nax-wt", "bot-x"), "HEAD");
    await writeFile(join(a, ".nax-wt", "bot-x", "wip.txt"), "uncommitted\n");
    const report = await restoreRepoSnapshot(snap);
    expect(existsSync(join(a, ".nax-wt", "bot-x", "wip.txt"))).toBe(true);
    expect(report.paths).toEqual([]);
    expect(report.failures).toEqual([]);
  });

  // A registration is not proof of ownership: in a main checkout the reviewer can write
  // .git/worktrees/ itself. The guard must not trust one to keep a file it did not know.
  test("a forged worktree registration does not keep a reviewer-planted file", async () => {
    const { a } = await twoWorktrees();
    const snap = await takeRepoSnapshot(a);
    await writeFile(join(a, "payload.ts"), "planted\n");
    await mkdir(join(a, ".git", "worktrees", "forged"), { recursive: true });
    await writeFile(join(a, ".git", "worktrees", "forged", "gitdir"), `${join(a, "payload.ts", "x", ".git")}\n`);
    const report = await restoreRepoSnapshot(snap);
    expect(existsSync(join(a, "payload.ts"))).toBe(false);
    expect(report.paths).toContain("payload.ts");
  });

  test("refs/replace entries added during the turn are removed", async () => {
    const { a } = await twoWorktrees();
    const head = await git(a, "rev-parse", "HEAD");
    const snap = await takeRepoSnapshot(a);
    await git(a, "update-ref", "refs/replace/0123456789012345678901234567890123456789", head);
    await restoreRepoSnapshot(snap);
    expect(await git(a, "for-each-ref", "refs/replace")).toBe("");
  });
});
