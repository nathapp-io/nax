import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { cleanupTempDir, makeTempDir, withDepsRestore } from "@test/helpers";
import { _gitGuardDeps, type GitLayout, listGitGuardFiles, strayCommonDirTripwire } from "@/sandbox";
import { realOrRaw } from "@/utils/realpath";

let base: string;
let gitDir: string;
beforeEach(() => {
  base = realOrRaw(makeTempDir("sbx-git-guards-"));
  gitDir = join(base, ".git");
});
afterEach(() => cleanupTempDir(base));

function git(args: string[], cwd: string): void {
  const r = Bun.spawnSync(["git", "-c", "user.email=a@b", "-c", "user.name=a", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

/** A main checkout with two nax-style worktrees, US-001 and US-002. */
function repoWithWorktrees(): void {
  git(["init", "-q", "-b", "main"], base);
  writeFileSync(join(base, "a.txt"), "a");
  git(["add", "-A"], base);
  git(["commit", "-qm", "seed"], base);
  git(["worktree", "add", "-q", ".nax-wt/US-001", "-b", "wt-1"], base);
  git(["worktree", "add", "-q", ".nax-wt/US-002", "-b", "wt-2"], base);
}

const mainLayout = (): GitLayout => ({ kind: "main", gitDir });
const worktreeLayout = (): GitLayout => ({
  kind: "worktree",
  gitDir: join(gitDir, "worktrees", "US-001"),
  commonDir: gitDir,
});

function worktreeGuards(id: string): string[] {
  const admin = join(gitDir, "worktrees", id);
  return [
    join(admin, "gitdir"),
    join(admin, "commondir"),
    join(admin, "config.worktree"),
    join(base, ".nax-wt", id, ".git"),
  ];
}

describe("listGitGuardFiles", () => {
  test("no repo -> nothing", async () => {
    expect(await listGitGuardFiles({ kind: "none" })).toEqual([]);
  });

  test("main checkout: every registered worktree's pointers, config.worktree and .git file", async () => {
    repoWithWorktrees();
    const files = await listGitGuardFiles(mainLayout());
    for (const p of [...worktreeGuards("US-001"), ...worktreeGuards("US-002")]) expect(files).toContain(p);
  });

  test("worktree: sibling worktrees are guarded too, not only the current one", async () => {
    repoWithWorktrees();
    const files = await listGitGuardFiles(worktreeLayout());
    for (const p of worktreeGuards("US-002")) expect(files).toContain(p);
  });

  test("an absent commondir is not emitted (srt would stub it empty); a present one is", async () => {
    repoWithWorktrees();
    expect(await listGitGuardFiles(mainLayout())).not.toContain(join(gitDir, "commondir"));
    writeFileSync(join(gitDir, "commondir"), ".\n");
    expect(await listGitGuardFiles(mainLayout())).toContain(join(gitDir, "commondir"));
  });

  test("an absent gitdir/commondir in a stale admin dir is skipped; config.worktree is kept", async () => {
    git(["init", "-q", "-b", "main"], base);
    const stale = join(gitDir, "worktrees", "gone");
    mkdirSync(stale, { recursive: true });
    const files = await listGitGuardFiles(mainLayout());
    expect(files).toEqual([join(stale, "config.worktree")]);
  });

  test("F1: a glob-named admin dir is skipped rather than poisoning every policy build", async () => {
    git(["init", "-q", "-b", "main"], base);
    mkdirSync(join(gitDir, "worktrees", "evil*"), { recursive: true });
    expect(await listGitGuardFiles(mainLayout())).toEqual([]);
  });

  test("F1: a pointer symlinked to a glob-named path is skipped too", async () => {
    git(["init", "-q", "-b", "main"], base);
    const admin = join(gitDir, "worktrees", "wt");
    mkdirSync(join(base, "odd*"), { recursive: true });
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(base, "odd*", "target"), "x");
    symlinkSync(join(base, "odd*", "target"), join(admin, "commondir"));
    expect(await listGitGuardFiles(mainLayout())).toEqual([join(admin, "config.worktree")]);
  });

  test("a gitdir naming anything but an absolute .git path yields no pointer deny", async () => {
    git(["init", "-q", "-b", "main"], base);
    const admin = join(gitDir, "worktrees", "odd");
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(admin, "gitdir"), "/\n");
    const files = await listGitGuardFiles(mainLayout());
    expect(files).toEqual([join(admin, "gitdir"), join(admin, "config.worktree")]);
  });

  // git >= 2.48 `worktree.useRelativePaths`: the admin dir's gitdir holds the
  // worktree's .git relative to the admin dir. The local git may predate
  // --relative-paths, so the file is rewritten into that shape by hand.
  test("a relative gitdir resolves against the admin dir: the worktree's .git is still denied", async () => {
    repoWithWorktrees();
    const admin = join(gitDir, "worktrees", "US-002");
    writeFileSync(join(admin, "gitdir"), `${relative(admin, join(base, ".nax-wt", "US-002", ".git"))}\n`);
    const files = await listGitGuardFiles(worktreeLayout());
    for (const p of worktreeGuards("US-002")) expect(files).toContain(p);
  });

  test("a relative gitdir resolves against the admin dir's realpath when the common dir is a symlink", async () => {
    const realCommon = join(base, "store", "deep", "repo.git");
    const admin = join(realCommon, "worktrees", "wt");
    mkdirSync(admin, { recursive: true });
    const linkedCommon = join(base, "link.git");
    symlinkSync(realCommon, linkedCommon);
    const dotGit = join(base, "wt", ".git");
    mkdirSync(join(base, "wt"));
    writeFileSync(dotGit, `gitdir: ${admin}\n`);
    writeFileSync(join(admin, "gitdir"), `${relative(admin, dotGit)}\n`);
    const files = await listGitGuardFiles({ kind: "main", gitDir: linkedCommon });
    expect(files).toContain(dotGit);
  });

  test("a relative gitdir not naming a .git file yields no pointer deny", async () => {
    git(["init", "-q", "-b", "main"], base);
    const admin = join(gitDir, "worktrees", "odd");
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(admin, "gitdir"), "../../../elsewhere/config\n");
    const files = await listGitGuardFiles(mainLayout());
    expect(files).toEqual([join(admin, "gitdir"), join(admin, "config.worktree")]);
  });

  test("a relative gitdir resolving to a glob-named path is skipped", async () => {
    git(["init", "-q", "-b", "main"], base);
    const admin = join(gitDir, "worktrees", "wt");
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(admin, "gitdir"), "../../../odd*/.git\n");
    const files = await listGitGuardFiles(mainLayout());
    expect(files).toEqual([join(admin, "gitdir"), join(admin, "config.worktree")]);
  });
});

describe("strayCommonDirTripwire", () => {
  withDepsRestore(_gitGuardDeps);

  test("no repo -> no tripwire", async () => {
    expect(await strayCommonDirTripwire({ kind: "none" })).toBeUndefined();
  });

  test("a commondir present at session start is left alone (the policy denies it instead)", async () => {
    git(["init", "-q", "-b", "main"], base);
    writeFileSync(join(gitDir, "commondir"), ".\n");
    expect(await strayCommonDirTripwire(mainLayout())).toBeUndefined();
    expect(existsSync(join(gitDir, "commondir"))).toBe(true);
  });

  test("main: a commondir created after session start is removed, and git works again", async () => {
    git(["init", "-q", "-b", "main"], base);
    const trip = await strayCommonDirTripwire(mainLayout());
    if (trip === undefined) throw new Error("expected a tripwire");
    mkdirSync(join(base, "evil"), { recursive: true });
    writeFileSync(join(gitDir, "commondir"), `${join(base, "evil")}\n`);
    await trip();
    expect(existsSync(join(gitDir, "commondir"))).toBe(false);
    git(["status", "--porcelain"], base);
  });

  test("worktree: guards the COMMON dir's commondir, which the main checkout's git reads", async () => {
    repoWithWorktrees();
    const trip = await strayCommonDirTripwire(worktreeLayout());
    if (trip === undefined) throw new Error("expected a tripwire");
    writeFileSync(join(gitDir, "commondir"), "/elsewhere\n");
    await trip();
    expect(existsSync(join(gitDir, "commondir"))).toBe(false);
    // the current worktree's own (legitimate) commondir is untouched
    expect(existsSync(join(gitDir, "worktrees", "US-001", "commondir"))).toBe(true);
  });

  test("nothing created -> nothing removed", async () => {
    git(["init", "-q", "-b", "main"], base);
    let removed = 0;
    _gitGuardDeps.remove = async () => {
      removed += 1;
    };
    const trip = await strayCommonDirTripwire(mainLayout());
    await trip?.();
    expect(removed).toBe(0);
  });

  test("a removal failure is swallowed (logged), never thrown over the command result", async () => {
    git(["init", "-q", "-b", "main"], base);
    _gitGuardDeps.remove = async () => {
      throw new Error("EPERM");
    };
    const trip = await strayCommonDirTripwire(mainLayout());
    writeFileSync(join(gitDir, "commondir"), "/elsewhere\n");
    await expect(trip?.() ?? Promise.resolve()).resolves.toBeUndefined();
  });
});
