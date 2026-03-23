import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeManager } from "../../../src/worktree/manager";

describe("WorktreeManager", () => {
  let testDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    // Create a temporary directory for each test
    testDir = mkdtempSync(join(tmpdir(), "worktree-test-"));
    projectRoot = join(testDir, "test-project");
    mkdirSync(projectRoot, { recursive: true });

    // Initialize a git repository using Bun.spawn (test fixture setup)
    const initProc = Bun.spawn(["git", "init"], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" });
    await initProc.exited;
    const emailProc = Bun.spawn(["git", "config", "user.email", "test@example.com"], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" });
    await emailProc.exited;
    const nameProc = Bun.spawn(["git", "config", "user.name", "Test User"], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" });
    await nameProc.exited;

    // Create an initial commit (required for worktree creation)
    writeFileSync(join(projectRoot, "README.md"), "# Test Project");
    const addProc = Bun.spawn(["git", "add", "README.md"], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" });
    await addProc.exited;
    const commitProc = Bun.spawn(["git", "commit", "-m", "Initial commit"], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" });
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

    test("symlinks node_modules from project root into worktree", async () => {
      const manager = new WorktreeManager();
      const storyId = "story-456";

      // Create node_modules in project root
      const nodeModulesPath = join(projectRoot, "node_modules");
      mkdirSync(nodeModulesPath, { recursive: true });
      writeFileSync(join(nodeModulesPath, "test.txt"), "test content");

      await manager.create(projectRoot, storyId);

      const worktreePath = join(projectRoot, ".nax-wt", storyId);
      const symlinkPath = join(worktreePath, "node_modules");

      expect(existsSync(symlinkPath)).toBe(true);
      // Check if it's a symlink by reading the link
      const { lstatSync, readlinkSync } = await import("node:fs");
      expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(symlinkPath)).toBe(nodeModulesPath);
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

    test("throws descriptive error when worktree already exists", async () => {
      const manager = new WorktreeManager();
      const storyId = "story-duplicate";

      await manager.create(projectRoot, storyId);

      // Try to create the same worktree again
      await expect(manager.create(projectRoot, storyId)).rejects.toThrow(/already exists|worktree.*exists/i);
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