import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeManager } from "../../../src/worktree/manager";
import { MergeEngine } from "../../../src/worktree/merge";

describe("MergeEngine", () => {
  let testDir: string;
  let projectRoot: string;
  let manager: WorktreeManager;
  let engine: MergeEngine;

  beforeEach(async () => {
    // Create a temporary directory for each test
    testDir = mkdtempSync(join(tmpdir(), "merge-test-"));
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

    manager = new WorktreeManager();
    engine = new MergeEngine(manager);
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  async function gitAddAndCommit(cwd: string, file: string, message: string): Promise<void> {
    const addProc = Bun.spawn(["git", "add", file], { cwd, stdout: "pipe", stderr: "pipe" });
    await addProc.exited;
    const commitProc = Bun.spawn(["git", "commit", "-m", message], { cwd, stdout: "pipe", stderr: "pipe" });
    await commitProc.exited;
  }

  describe("merge", () => {
    test("performs git merge --no-ff of story branch", async () => {
      const storyId = "story-merge-1";

      // Create worktree and make a change
      await manager.create(projectRoot, storyId);
      const worktreePath = join(projectRoot, ".nax-wt", storyId);
      writeFileSync(join(worktreePath, "feature.txt"), "feature content");
      await gitAddAndCommit(worktreePath, "feature.txt", "Add feature");

      // Merge the branch
      const result = await engine.merge(projectRoot, storyId);

      expect(result.success).toBe(true);
      expect(result.conflictFiles).toBeUndefined();

      // Verify merge commit exists
      const logProc = Bun.spawn(["git", "log", "--oneline", "--graph"], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      const log = await new Response(logProc.stdout).text();
      expect(log).toContain(`Merge branch 'nax/${storyId}'`);

      // Verify feature file exists in main branch
      expect(existsSync(join(projectRoot, "feature.txt"))).toBe(true);
    });

    test("returns { success: true } on clean merge", async () => {
      const storyId = "story-clean";

      // Create worktree and make a non-conflicting change
      await manager.create(projectRoot, storyId);
      const worktreePath = join(projectRoot, ".nax-wt", storyId);
      writeFileSync(join(worktreePath, "new-file.txt"), "new content");
      await gitAddAndCommit(worktreePath, "new-file.txt", "Add new file");

      const result = await engine.merge(projectRoot, storyId);

      expect(result.success).toBe(true);
      expect(result.conflictFiles).toBeUndefined();
    });

    test("returns { success: false, conflictFiles: [...] } on conflict", async () => {
      const storyId = "story-conflict";

      // Create worktree
      await manager.create(projectRoot, storyId);
      const worktreePath = join(projectRoot, ".nax-wt", storyId);

      // Make conflicting changes in both branches
      // Change in main branch
      writeFileSync(join(projectRoot, "conflict.txt"), "main content");
      await gitAddAndCommit(projectRoot, "conflict.txt", "Add conflict file in main");

      // Change in story branch (same file, different content)
      writeFileSync(join(worktreePath, "conflict.txt"), "story content");
      await gitAddAndCommit(worktreePath, "conflict.txt", "Add conflict file in story");

      const result = await engine.merge(projectRoot, storyId);

      expect(result.success).toBe(false);
      expect(result.conflictFiles).toBeDefined();
      expect(result.conflictFiles?.length).toBeGreaterThan(0);
      expect(result.conflictFiles).toContain("conflict.txt");

      // Verify merge was aborted (working tree should be clean except for .nax-wt)
      const statusProc = Bun.spawn(["git", "status", "--short"], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      const status = await new Response(statusProc.stdout).text();
      const nonWorktreeStatus = status
        .split("\n")
        .filter((line) => !line.includes(".nax-wt"))
        .join("\n")
        .trim();
      expect(nonWorktreeStatus).toBe(""); // Clean working tree after abort
    });

    test("cleans up worktree after successful merge", async () => {
      const storyId = "story-cleanup";

      // Create worktree and make a change
      await manager.create(projectRoot, storyId);
      const worktreePath = join(projectRoot, ".nax-wt", storyId);
      writeFileSync(join(worktreePath, "cleanup.txt"), "cleanup test");
      await gitAddAndCommit(worktreePath, "cleanup.txt", "Add cleanup test");

      // Merge and verify cleanup
      await engine.merge(projectRoot, storyId);

      // Worktree should be removed
      expect(existsSync(worktreePath)).toBe(false);

      // Branch should be deleted
      const branchProc = Bun.spawn(["git", "branch", "--list"], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      const branchOutput = await new Response(branchProc.stdout).text();
      expect(branchOutput).not.toContain(`nax/${storyId}`);
    });
  });

  describe("mergeAll", () => {
    test("processes stories in topological order", async () => {
      // Create three stories with dependencies: story-1 <- story-2 <- story-3
      const storyIds = ["story-1", "story-2", "story-3"];
      const dependencies = {
        "story-1": [],
        "story-2": ["story-1"],
        "story-3": ["story-2"],
      };

      // Create worktrees and commits for each story
      for (const storyId of storyIds) {
        await manager.create(projectRoot, storyId);
        const worktreePath = join(projectRoot, ".nax-wt", storyId);
        writeFileSync(join(worktreePath, `${storyId}.txt`), `${storyId} content`);
        await gitAddAndCommit(worktreePath, `${storyId}.txt`, `Add ${storyId}`);
      }

      const results = await engine.mergeAll(projectRoot, storyIds, dependencies);

      // All should succeed
      expect(results.every((r) => r.success)).toBe(true);
      expect(results.length).toBe(3);

      // Verify all files exist
      for (const storyId of storyIds) {
        expect(existsSync(join(projectRoot, `${storyId}.txt`))).toBe(true);
      }
    });

    test("retries once on conflict after rebasing worktree", async () => {
      const storyIds = ["story-base", "story-conflict"];
      const dependencies = {
        "story-base": [],
        "story-conflict": [],
      };

      // Create base story
      await manager.create(projectRoot, "story-base");
      const basePath = join(projectRoot, ".nax-wt", "story-base");
      writeFileSync(join(basePath, "shared.txt"), "base content");
      await gitAddAndCommit(basePath, "shared.txt", "Add shared file");

      // Create conflicting story
      await manager.create(projectRoot, "story-conflict");
      const conflictPath = join(projectRoot, ".nax-wt", "story-conflict");
      writeFileSync(join(conflictPath, "shared.txt"), "conflict content");
      await gitAddAndCommit(conflictPath, "shared.txt", "Add conflicting shared file");

      // This should handle the conflict scenario
      const results = await engine.mergeAll(projectRoot, storyIds, dependencies);

      expect(results.length).toBe(2);
      // First story should succeed
      expect(results[0].success).toBe(true);
      expect(results[0].storyId).toBe("story-base");
    });

    test("marks story as failed on second conflict", async () => {
      const storyIds = ["story-1", "story-2"];
      const dependencies = {
        "story-1": [],
        "story-2": [],
      };

      // Create first story
      await manager.create(projectRoot, "story-1");
      const path1 = join(projectRoot, ".nax-wt", "story-1");
      writeFileSync(join(path1, "conflict.txt"), "content 1");
      await gitAddAndCommit(path1, "conflict.txt", "Story 1");

      // Create second story with conflict
      await manager.create(projectRoot, "story-2");
      const path2 = join(projectRoot, ".nax-wt", "story-2");
      writeFileSync(join(path2, "conflict.txt"), "content 2");
      await gitAddAndCommit(path2, "conflict.txt", "Story 2");

      const results = await engine.mergeAll(projectRoot, storyIds, dependencies);

      // First should succeed, second should fail
      expect(results.length).toBe(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
      expect(results[1].conflictFiles).toBeDefined();
    });

    test("continues with remaining stories after failure", async () => {
      const storyIds = ["story-base", "story-conflict", "story-3"];
      const dependencies = {
        "story-base": [],
        "story-conflict": [],
        "story-3": [],
      };

      // Create base story with a file
      await manager.create(projectRoot, "story-base");
      const pathBase = join(projectRoot, ".nax-wt", "story-base");
      writeFileSync(join(pathBase, "shared.txt"), "base content");
      await gitAddAndCommit(pathBase, "shared.txt", "Add shared file");

      // Create conflicting story (modifies same file)
      await manager.create(projectRoot, "story-conflict");
      const pathConflict = join(projectRoot, ".nax-wt", "story-conflict");
      writeFileSync(join(pathConflict, "shared.txt"), "conflict content");
      await gitAddAndCommit(pathConflict, "shared.txt", "Modify shared file in story-conflict");

      // Create third story (no conflict)
      await manager.create(projectRoot, "story-3");
      const path3 = join(projectRoot, ".nax-wt", "story-3");
      writeFileSync(join(path3, "file3.txt"), "content 3");
      await gitAddAndCommit(path3, "file3.txt", "Story 3");

      const results = await engine.mergeAll(projectRoot, storyIds, dependencies);

      // Base should succeed, conflict should fail, story-3 should succeed
      expect(results.length).toBe(3);
      expect(results[0].success).toBe(true);
      expect(results[0].storyId).toBe("story-base");
      expect(results[1].success).toBe(false);
      expect(results[1].storyId).toBe("story-conflict");
      expect(results[2].success).toBe(true);
      expect(results[2].storyId).toBe("story-3");
    });
  });
});