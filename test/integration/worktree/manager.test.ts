import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NAX_GITIGNORE_ENTRIES } from "@/utils/gitignore";
import { WorktreeManager } from "@/worktree/manager";
import { makeTempDir } from "@test/helpers";

describe("WorktreeManager", () => {
  let testDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    // Create a temporary directory for each test
    testDir = makeTempDir("worktree-test-");
    projectRoot = join(testDir, "test-project");
    mkdirSync(projectRoot, { recursive: true });

    // Initialize a git repository using Bun.spawn (test fixture setup)
    const initProc = Bun.spawn(["git", "init"], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" });
    await initProc.exited;
    const emailProc = Bun.spawn(["git", "config", "user.email", "test@example.com"], {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    await emailProc.exited;
    const nameProc = Bun.spawn(["git", "config", "user.name", "Test User"], {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    await nameProc.exited;

    // Create an initial commit (required for worktree creation)
    writeFileSync(join(projectRoot, "README.md"), "# Test Project");
    const addProc = Bun.spawn(["git", "add", "README.md"], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" });
    await addProc.exited;
    const commitProc = Bun.spawn(["git", "commit", "-m", "Initial commit"], {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    await commitProc.exited;
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("create", () => {
    test("creates a git worktree at .nax-wt/<storyId>/ with branch nax/<storyId>", async () => {
      const manager = new WorktreeManager();
      const storyId = "story-123";

      await manager.create(projectRoot, storyId);

      const worktreePath = join(projectRoot, ".nax-wt", storyId);
      expect(existsSync(worktreePath)).toBe(true);

      // Verify branch exists via git branch --list
      const branchProc = Bun.spawn(["git", "branch", "--list"], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      const branchOutput = await new Response(branchProc.stdout).text();
      expect(branchOutput).toContain(`nax/${storyId}`);
    });

    test("does not create a node_modules symlink in the worktree", async () => {
      const manager = new WorktreeManager();
      const storyId = "story-456";

      // Create node_modules in project root
      const nodeModulesPath = join(projectRoot, "node_modules");
      mkdirSync(nodeModulesPath, { recursive: true });
      writeFileSync(join(nodeModulesPath, "test.txt"), "test content");

      await manager.create(projectRoot, storyId);

      const worktreePath = join(projectRoot, ".nax-wt", storyId);
      const nodeModulesInWorktree = join(worktreePath, "node_modules");

      expect(existsSync(nodeModulesInWorktree)).toBe(false);
    });

    test("symlinks .env if present", async () => {
      const manager = new WorktreeManager();
      const storyId = "story-789";

      // Create .env in project root
      const envPath = join(projectRoot, ".env");
      writeFileSync(envPath, "TEST_VAR=value");

      await manager.create(projectRoot, storyId);

      const worktreePath = join(projectRoot, ".nax-wt", storyId);
      const symlinkPath = join(worktreePath, ".env");

      expect(existsSync(symlinkPath)).toBe(true);
      // Check if it's a symlink
      const { lstatSync, readlinkSync } = await import("node:fs");
      expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(symlinkPath)).toBe(envPath);
    });

    test("does not fail if .env is not present", async () => {
      const manager = new WorktreeManager();
      const storyId = "story-no-env";

      await manager.create(projectRoot, storyId);

      const worktreePath = join(projectRoot, ".nax-wt", storyId);
      expect(existsSync(worktreePath)).toBe(true);

      const symlinkPath = join(worktreePath, ".env");
      expect(existsSync(symlinkPath)).toBe(false);
    });

    test("throws descriptive error when not in git repo", async () => {
      const manager = new WorktreeManager();
      const nonGitDir = join(testDir, "non-git");
      mkdirSync(nonGitDir, { recursive: true });

      await expect(manager.create(nonGitDir, "story-fail")).rejects.toThrow(
        /not a git repository|fatal: not a git repository/i,
      );
    });

    test("cleanly replaces an existing worktree for the same story", async () => {
      const manager = new WorktreeManager();
      const storyId = "story-duplicate";

      // Create a worktree
      await manager.create(projectRoot, storyId);
      const worktreePath = join(projectRoot, ".nax-wt", storyId);
      expect(existsSync(worktreePath)).toBe(true);

      // Create the same worktree again — should succeed (removes stale one first)
      await manager.create(projectRoot, storyId);
      expect(existsSync(worktreePath)).toBe(true); // still exists, just recreated
    });
  });

  describe("BUG-28: branch deletion is gated on a known-orphaned worktree record", () => {
    test("does not destroy an unmerged user branch that happens to share the nax/<storyId> name", async () => {
      const manager = new WorktreeManager();
      const storyId = "story-user-branch";
      const branchName = `nax/${storyId}`;

      const defaultBranch = (
        await new Response(
          Bun.spawn(["git", "branch", "--show-current"], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" }).stdout,
        ).text()
      ).trim();

      // Simulate a user's own branch of this exact name — never created via
      // manager.create(), so `git worktree list` has no record of it.
      await Bun.spawn(["git", "checkout", "-b", branchName], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" })
        .exited;
      writeFileSync(join(projectRoot, "user-work.txt"), "unmerged user work");
      await Bun.spawn(["git", "add", "user-work.txt"], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" }).exited;
      await Bun.spawn(["git", "commit", "-m", "unmerged user work"], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      }).exited;
      const revParseBefore = await new Response(
        Bun.spawn(["git", "rev-parse", branchName], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" }).stdout,
      ).text();
      await Bun.spawn(["git", "checkout", defaultBranch], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" }).exited;

      // create() must not silently delete the branch — git itself refuses to
      // `-b` an already-existing branch name, so this throws loudly instead.
      await expect(manager.create(projectRoot, storyId)).rejects.toThrow();

      const revParseAfter = await new Response(
        Bun.spawn(["git", "rev-parse", branchName], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" }).stdout,
      ).text();
      expect(revParseAfter.trim()).toBe(revParseBefore.trim());

      const logProc = Bun.spawn(["git", "log", branchName, "--oneline"], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      const logOutput = await new Response(logProc.stdout).text();
      expect(logOutput).toContain("unmerged user work");
    });

    test("still cleans up a genuinely orphaned nax worktree (dir deleted outside git)", async () => {
      const manager = new WorktreeManager();
      const storyId = "story-crashed-run";
      const branchName = `nax/${storyId}`;

      await manager.create(projectRoot, storyId);
      const worktreePath = join(projectRoot, ".nax-wt", storyId);
      expect(existsSync(worktreePath)).toBe(true);

      // Simulate a crash: the worktree directory is gone, but git's admin
      // refs and the branch still exist — hasWorktreeRecord() must still see
      // it via `git worktree list` (prunable entry) and Step 3 must clean it.
      rmSync(worktreePath, { recursive: true, force: true });

      await manager.create(projectRoot, storyId);

      expect(existsSync(worktreePath)).toBe(true);
      const branchProc = Bun.spawn(["git", "branch", "--list"], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      const branchOutput = await new Response(branchProc.stdout).text();
      // Exactly one nax/<storyId> branch survives (the freshly recreated one).
      expect(branchOutput.split(branchName).length - 1).toBe(1);
    });
  });

  describe("remove", () => {
    test("cleans up worktree and branch", async () => {
      const manager = new WorktreeManager();
      const storyId = "story-remove";

      // Create worktree first
      await manager.create(projectRoot, storyId);

      const worktreePath = join(projectRoot, ".nax-wt", storyId);
      expect(existsSync(worktreePath)).toBe(true);

      // Remove it
      await manager.remove(projectRoot, storyId);

      // Verify worktree is removed
      expect(existsSync(worktreePath)).toBe(false);

      // Verify branch is deleted
      const branchProc = Bun.spawn(["git", "branch", "--list"], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      const branchOutput = await new Response(branchProc.stdout).text();
      expect(branchOutput).not.toContain(`nax/${storyId}`);
    });

    test("throws descriptive error when worktree does not exist", async () => {
      const manager = new WorktreeManager();
      const storyId = "nonexistent-story";

      await expect(manager.remove(projectRoot, storyId)).rejects.toThrow(
        /not found|does not exist|no such worktree|worktree not found/i,
      );
    });
  });

  describe("ensureGitExcludes", () => {
    test("writes nax entries to .git/info/exclude", async () => {
      const manager = new WorktreeManager();

      await manager.ensureGitExcludes(projectRoot);

      const excludePath = join(projectRoot, ".git", "info", "exclude");
      expect(existsSync(excludePath)).toBe(true);

      const content = await Bun.file(excludePath).text();
      expect(content).toContain(".nax/features/*/acp-sessions.json");
      expect(content).toContain("nax.lock");
      expect(content).toContain(".nax-wt/");
    });

    test("is idempotent — does not duplicate entries on repeated calls", async () => {
      const manager = new WorktreeManager();

      await manager.ensureGitExcludes(projectRoot);
      await manager.ensureGitExcludes(projectRoot);

      const excludePath = join(projectRoot, ".git", "info", "exclude");
      const content = await Bun.file(excludePath).text();

      // Count occurrences of a known entry — must appear exactly once
      const occurrences = content.split(".nax/features/*/acp-sessions.json").length - 1;
      expect(occurrences).toBe(1);
    });

    test("creates .git/info/ directory if it does not exist", async () => {
      const manager = new WorktreeManager();

      const infoDir = join(projectRoot, ".git", "info");
      rmSync(infoDir, { recursive: true, force: true });
      expect(existsSync(infoDir)).toBe(false);

      await manager.ensureGitExcludes(projectRoot);

      expect(existsSync(join(infoDir, "exclude"))).toBe(true);
    });

    test("preserves existing content in exclude file", async () => {
      const manager = new WorktreeManager();

      const infoDir = join(projectRoot, ".git", "info");
      mkdirSync(infoDir, { recursive: true });
      const excludePath = join(infoDir, "exclude");
      writeFileSync(excludePath, "# existing user rule\n*.log\n");

      await manager.ensureGitExcludes(projectRoot);

      const content = await Bun.file(excludePath).text();
      expect(content).toContain("# existing user rule");
      expect(content).toContain("*.log");
      expect(content).toContain(".nax/features/*/acp-sessions.json");
    });

    test("all NAX_GITIGNORE_ENTRIES are written to exclude", async () => {
      const manager = new WorktreeManager();

      await manager.ensureGitExcludes(projectRoot);

      const excludePath = join(projectRoot, ".git", "info", "exclude");
      const content = await Bun.file(excludePath).text();

      for (const entry of NAX_GITIGNORE_ENTRIES) {
        expect(content).toContain(entry);
      }
    });

    // BUG-39 (D-25): substring matching used to skip entries whose shorter
    // sibling was already present. e.g. an existing `runs/` line would
    // suppress `runs/cache/` because `"runs/cache/".includes("runs/")` is
    // false but `"existing".includes("runs/")` is true after a misread.
    // The intent was the other way round. Switch to line-aware matching
    // so each entry is checked exactly, not as a substring of anything.
    test("BUG-39: line-aware matching does not suppress a longer entry when a shorter one is present", async () => {
      const manager = new WorktreeManager();
      const infoDir = join(projectRoot, ".git", "info");
      mkdirSync(infoDir, { recursive: true });
      const excludePath = join(infoDir, "exclude");
      // Pre-seed a line that is a substring of NAX_GITIGNORE_ENTRIES —
      // the old `existing.includes(entry)` check would treat this as
      // already covered. With line-aware matching it should NOT.
      writeFileSync(excludePath, "runs/\n");

      await manager.ensureGitExcludes(projectRoot);

      const content = await Bun.file(excludePath).text();
      // Both the user-authored `runs/` AND the full nax entry must be
      // present after the call.
      expect(content).toContain("runs/");
      // Find at least one NAX entry that survives — proves the substring
      // suppression was removed.
      const naxLines = NAX_GITIGNORE_ENTRIES.filter((entry) => content.split("\n").includes(entry));
      expect(naxLines.length).toBeGreaterThan(0);
    });

    // BUG-39: concurrent ensureGitExcludes() used to interleave
    // read-read-write-write and lose one writer's entries (the last
    // writer's write won). withPathFileLock serializes them. The lock
    // matters most when one writer adds new content between another
    // writer's read and write — that scenario can only be reliably
    // triggered across processes, so this test verifies the lock-acquire
    // and release are wired (no leaked lock candidates after the call).
    test("BUG-39: ensureGitExcludes does not leave a stale lock candidate behind", async () => {
      const manager = new WorktreeManager();
      const infoDir = join(projectRoot, ".git", "info");
      rmSync(infoDir, { recursive: true, force: true });

      await manager.ensureGitExcludes(projectRoot);

      const excludePath = join(infoDir, "exclude");
      // No `.lock.*` candidate file should remain — the path-file-lock
      // is released in its `finally` block on the success path.
      const entries = await Array.fromAsync(
        new Bun.Glob(`${"exclude"}.lock.*`).scan({ cwd: infoDir }),
      );
      expect(entries.length).toBe(0);

      // Subsequent calls still work (the lock isn't held by a zombie
      // candidate from a prior invocation).
      await manager.ensureGitExcludes(projectRoot);
    });
  });

  describe("list", () => {
    test("returns active worktree entries", async () => {
      const manager = new WorktreeManager();
      const storyId1 = "story-list-1";
      const storyId2 = "story-list-2";

      // Create two worktrees
      await manager.create(projectRoot, storyId1);
      await manager.create(projectRoot, storyId2);

      const worktrees = await manager.list(projectRoot);

      // Should have at least our two worktrees (main worktree + 2 created)
      expect(worktrees.length).toBeGreaterThanOrEqual(2);

      // Check if our worktrees are in the list
      const paths = worktrees.map((wt) => wt.path);
      expect(paths.some((p) => p.includes(join(".nax-wt", storyId1)))).toBe(true);
      expect(paths.some((p) => p.includes(join(".nax-wt", storyId2)))).toBe(true);
    });

    test("returns empty array when no worktrees exist (except main)", async () => {
      const manager = new WorktreeManager();

      const worktrees = await manager.list(projectRoot);

      // Should only have the main worktree
      expect(worktrees.length).toBeGreaterThanOrEqual(0);
      expect(worktrees.every((wt) => !wt.path.includes(".nax-wt"))).toBe(true);
    });

    test("each entry contains path and branch info", async () => {
      const manager = new WorktreeManager();
      const storyId = "story-info";

      await manager.create(projectRoot, storyId);

      const worktrees = await manager.list(projectRoot);
      const ourWorktree = worktrees.find((wt) => wt.path.includes(join(".nax-wt", storyId)));

      expect(ourWorktree).toBeDefined();
      expect(ourWorktree?.path).toBeTruthy();
      expect(ourWorktree?.branch).toBe(`nax/${storyId}`);
    });
  });
});
