import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MergeEngine } from "../../../src/worktree/merge";
import { WorktreeManager } from "../../../src/worktree/manager";
import { join } from "node:path";
import {
	mkdtempSync,
	rmSync,
	existsSync,
	mkdirSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

describe("MergeEngine", () => {
	let testDir: string;
	let projectRoot: string;
	let manager: WorktreeManager;
	let engine: MergeEngine;

	beforeEach(() => {
		// Create a temporary directory for each test
		testDir = mkdtempSync(join(tmpdir(), "merge-test-"));
		projectRoot = join(testDir, "test-project");
		mkdirSync(projectRoot, { recursive: true });

		// Initialize a git repository
		execSync("git init", { cwd: projectRoot, stdio: "pipe" });
		execSync('git config user.email "test@example.com"', {
			cwd: projectRoot,
			stdio: "pipe",
		});
		execSync('git config user.name "Test User"', {
			cwd: projectRoot,
			stdio: "pipe",
		});

		// Create an initial commit (required for worktree creation)
		writeFileSync(join(projectRoot, "README.md"), "# Test Project");
		execSync("git add README.md", { cwd: projectRoot, stdio: "pipe" });
		execSync('git commit -m "Initial commit"', {
			cwd: projectRoot,
			stdio: "pipe",
		});

		manager = new WorktreeManager();
		engine = new MergeEngine(manager);
	});

	afterEach(() => {
		// Clean up test directory
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("merge", () => {
		test("performs git merge --no-ff of story branch", async () => {
			const storyId = "story-merge-1";

			// Create worktree and make a change
			await manager.create(projectRoot, storyId);
			const worktreePath = join(projectRoot, ".nax-wt", storyId);
			writeFileSync(join(worktreePath, "feature.txt"), "feature content");
			execSync("git add feature.txt", {
				cwd: worktreePath,
				stdio: "pipe",
			});
			execSync('git commit -m "Add feature"', {
				cwd: worktreePath,
				stdio: "pipe",
			});

			// Merge the branch
			const result = await engine.merge(projectRoot, storyId);

			expect(result.success).toBe(true);
			expect(result.conflictFiles).toBeUndefined();

			// Verify merge commit exists
			const log = execSync("git log --oneline --graph", {
				cwd: projectRoot,
				encoding: "utf-8",
			});
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
			execSync("git add new-file.txt", {
				cwd: worktreePath,
				stdio: "pipe",
			});
			execSync('git commit -m "Add new file"', {
				cwd: worktreePath,
				stdio: "pipe",
			});

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
			execSync("git add conflict.txt", {
				cwd: projectRoot,
				stdio: "pipe",
			});
			execSync('git commit -m "Add conflict file in main"', {
				cwd: projectRoot,
				stdio: "pipe",
			});

			// Change in story branch (same file, different content)
			writeFileSync(join(worktreePath, "conflict.txt"), "story content");
			execSync("git add conflict.txt", {
				cwd: worktreePath,
				stdio: "pipe",
			});
			execSync('git commit -m "Add conflict file in story"', {
				cwd: worktreePath,
				stdio: "pipe",
			});

			const result = await engine.merge(projectRoot, storyId);

			expect(result.success).toBe(false);
			expect(result.conflictFiles).toBeDefined();
			expect(result.conflictFiles?.length).toBeGreaterThan(0);
			expect(result.conflictFiles).toContain("conflict.txt");

			// Verify merge was aborted (working tree should be clean except for .nax-wt)
			const status = execSync("git status --short", {
				cwd: projectRoot,
				encoding: "utf-8",
			});
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
			execSync("git add cleanup.txt", {
				cwd: worktreePath,
				stdio: "pipe",
			});
			execSync('git commit -m "Add cleanup test"', {
				cwd: worktreePath,
				stdio: "pipe",
			});

			// Merge and verify cleanup
			await engine.merge(projectRoot, storyId);

			// Worktree should be removed
			expect(existsSync(worktreePath)).toBe(false);

			// Branch should be deleted
			const branches = execSync("git branch --list", {
				cwd: projectRoot,
				encoding: "utf-8",
			});
			expect(branches).not.toContain(`nax/${storyId}`);
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
				writeFileSync(
					join(worktreePath, `${storyId}.txt`),
					`${storyId} content`,
				);
				execSync(`git add ${storyId}.txt`, {
					cwd: worktreePath,
					stdio: "pipe",
				});
				execSync(`git commit -m "Add ${storyId}"`, {
					cwd: worktreePath,
					stdio: "pipe",
				});
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
			execSync("git add shared.txt", { cwd: basePath, stdio: "pipe" });
			execSync('git commit -m "Add shared file"', {
				cwd: basePath,
				stdio: "pipe",
			});

			// Create conflicting story
			await manager.create(projectRoot, "story-conflict");
			const conflictPath = join(projectRoot, ".nax-wt", "story-conflict");
			writeFileSync(join(conflictPath, "shared.txt"), "conflict content");
			execSync("git add shared.txt", { cwd: conflictPath, stdio: "pipe" });
			execSync('git commit -m "Add conflicting shared file"', {
				cwd: conflictPath,
				stdio: "pipe",
			});

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
			execSync("git add conflict.txt", { cwd: path1, stdio: "pipe" });
			execSync('git commit -m "Story 1"', { cwd: path1, stdio: "pipe" });

			// Create second story with conflict
			await manager.create(projectRoot, "story-2");
			const path2 = join(projectRoot, ".nax-wt", "story-2");
			writeFileSync(join(path2, "conflict.txt"), "content 2");
			execSync("git add conflict.txt", { cwd: path2, stdio: "pipe" });
			execSync('git commit -m "Story 2"', { cwd: path2, stdio: "pipe" });

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
			execSync("git add shared.txt", { cwd: pathBase, stdio: "pipe" });
			execSync('git commit -m "Add shared file"', {
				cwd: pathBase,
				stdio: "pipe",
			});

			// Create conflicting story (modifies same file)
			await manager.create(projectRoot, "story-conflict");
			const pathConflict = join(projectRoot, ".nax-wt", "story-conflict");
			writeFileSync(join(pathConflict, "shared.txt"), "conflict content");
			execSync("git add shared.txt", {
				cwd: pathConflict,
				stdio: "pipe",
			});
			execSync('git commit -m "Modify shared file in story-conflict"', {
				cwd: pathConflict,
				stdio: "pipe",
			});

			// Create third story (no conflict)
			await manager.create(projectRoot, "story-3");
			const path3 = join(projectRoot, ".nax-wt", "story-3");
			writeFileSync(join(path3, "file3.txt"), "content 3");
			execSync("git add file3.txt", { cwd: path3, stdio: "pipe" });
			execSync('git commit -m "Story 3"', { cwd: path3, stdio: "pipe" });

			const results = await engine.mergeAll(
				projectRoot,
				storyIds,
				dependencies,
			);

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
