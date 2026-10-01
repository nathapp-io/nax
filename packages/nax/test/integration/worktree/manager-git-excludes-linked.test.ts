/**
 * #2216: ensureGitExcludes() against a LINKED worktree, where `.git` is a
 * pointer file rather than a directory. Git reads `info/exclude` only from the
 * common git dir, so that is where the entries must land for them to take
 * effect in the linked checkout.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { reconcileMainGitignore } from "@/execution/lifecycle/gitignore-reconcile";
import { NAX_GITIGNORE_ENTRIES } from "@/utils/gitignore";
import { WorktreeManager } from "@/worktree/manager";

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}

describe("WorktreeManager.ensureGitExcludes — linked worktree (#2216)", () => {
  let testDir: string;
  let mainRoot: string;
  let linkedRoot: string;

  beforeEach(() => {
    testDir = makeTempDir("worktree-excludes-linked-");
    mainRoot = join(testDir, "main");
    linkedRoot = join(testDir, "linked");
    git(testDir, "init", "-q", mainRoot);
    git(
      mainRoot,
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=T",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    );
    git(mainRoot, "worktree", "add", "-q", linkedRoot);
  });

  afterEach(() => cleanupTempDir(testDir));

  test("resolves in a linked worktree whose .git is a file", async () => {
    expect(lstatSync(join(linkedRoot, ".git")).isFile()).toBe(true);
    await new WorktreeManager().ensureGitExcludes(linkedRoot);
    expect(lstatSync(join(linkedRoot, ".git")).isFile()).toBe(true);
  });

  test("writes every nax entry to the common dir's info/exclude", async () => {
    await new WorktreeManager().ensureGitExcludes(linkedRoot);

    const content = readFileSync(join(mainRoot, ".git", "info", "exclude"), "utf8");
    for (const entry of NAX_GITIGNORE_ENTRIES) {
      expect(content.split("\n")).toContain(entry);
    }
  });

  test("git status in the linked worktree ignores a nax artifact afterwards", async () => {
    writeFileSync(join(linkedRoot, "nax.lock"), "{}");
    expect(git(linkedRoot, "status", "--porcelain")).toContain("nax.lock");

    await new WorktreeManager().ensureGitExcludes(linkedRoot);

    expect(git(linkedRoot, "status", "--porcelain")).not.toContain("nax.lock");
  });

  test("main and linked calls share one exclude file without duplicating entries", async () => {
    const manager = new WorktreeManager();
    await manager.ensureGitExcludes(mainRoot);
    await manager.ensureGitExcludes(linkedRoot);

    const content = readFileSync(join(mainRoot, ".git", "info", "exclude"), "utf8");
    const occurrences = content.split("\n").filter((line) => line === "nax.lock").length;
    expect(occurrences).toBe(1);
    expect(existsSync(join(mainRoot, ".git", "worktrees", "linked", "info", "exclude"))).toBe(false);
  });

  test("a .git pointer to a missing git dir resolves without throwing", async () => {
    writeFileSync(join(linkedRoot, ".git"), `gitdir: ${join(testDir, "does-not-exist")}\n`);
    await new WorktreeManager().ensureGitExcludes(linkedRoot);
    expect(readFileSync(join(linkedRoot, ".git"), "utf8")).toContain("does-not-exist");
  });

  test("run-setup's reconcileMainGitignore resolves in a linked worktree", async () => {
    await reconcileMainGitignore(linkedRoot);
    const content = readFileSync(join(mainRoot, ".git", "info", "exclude"), "utf8");
    expect(content.split("\n")).toContain("nax.lock");
  });
});
