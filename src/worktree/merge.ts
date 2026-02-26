import { getSafeLogger } from "../logger";
import type { WorktreeManager } from "./manager";

export interface MergeResult {
	success: boolean;
	storyId: string;
	conflictFiles?: string[];
	retryCount?: number;
}

export interface StoryDependencies {
	[storyId: string]: string[];
}

export class MergeEngine {
	constructor(private worktreeManager: WorktreeManager) {}

	/**
	 * Merges branch nax/<storyId> into current branch with --no-ff
	 * Returns { success: true } on clean merge
	 * Returns { success: false, conflictFiles: [...] } on conflict
	 * Cleans up worktree after successful merge
	 */
	async merge(
		projectRoot: string,
		storyId: string,
	): Promise<Omit<MergeResult, "storyId">> {
		const branchName = `nax/${storyId}`;

		try {
			// Perform merge with --no-ff
			const mergeProc = Bun.spawn(
				["git", "merge", "--no-ff", branchName, "-m", `Merge branch '${branchName}'`],
				{
					cwd: projectRoot,
					stdout: "pipe",
					stderr: "pipe",
				},
			);

			const exitCode = await mergeProc.exited;
			const stderr = await new Response(mergeProc.stderr).text();
			const stdout = await new Response(mergeProc.stdout).text();

			if (exitCode === 0) {
				// Clean merge - cleanup worktree
				try {
					await this.worktreeManager.remove(projectRoot, storyId);
				} catch (error) {
					// Log warning but don't fail the merge
					const logger = getSafeLogger();
					logger?.warn("worktree", `Failed to cleanup worktree for ${storyId}`, {
						error: error instanceof Error ? error.message : String(error),
					});
				}

				return { success: true };
			}

			// Merge failed - check for conflicts
			const output = `${stdout}\n${stderr}`;
			if (
				output.includes("CONFLICT") ||
				output.includes("conflict") ||
				output.includes("Automatic merge failed")
			) {
				// Extract conflict files
				const conflictFiles = await this.getConflictFiles(projectRoot);

				// Abort the merge
				await this.abortMerge(projectRoot);

				return {
					success: false,
					conflictFiles,
				};
			}

			// Other error
			throw new Error(`Merge failed: ${stderr || stdout || "unknown error"}`);
		} catch (error) {
			if (error instanceof Error) {
				throw error;
			}
			throw new Error(`Failed to merge branch ${branchName}: ${String(error)}`);
		}
	}

	/**
	 * Merges stories in topological order based on dependencies
	 * On conflict: retries once after rebasing worktree on updated base
	 * On 2nd conflict: marks story as failed, continues with remaining stories
	 */
	async mergeAll(
		projectRoot: string,
		storyIds: string[],
		dependencies: StoryDependencies,
	): Promise<MergeResult[]> {
		// Sort stories in topological order
		const orderedStories = this.topologicalSort(storyIds, dependencies);
		const results: MergeResult[] = [];
		const failedStories = new Set<string>();

		for (const storyId of orderedStories) {
			// Check if any dependencies failed
			const deps = dependencies[storyId] || [];
			const hasFailedDeps = deps.some((dep) => failedStories.has(dep));

			if (hasFailedDeps) {
				results.push({
					success: false,
					storyId,
					conflictFiles: [],
				});
				failedStories.add(storyId);
				continue;
			}

			// Try to merge
			let result = await this.merge(projectRoot, storyId);

			// If conflict, retry once after rebasing
			if (!result.success && result.conflictFiles) {
				try {
					// Rebase worktree on updated base
					await this.rebaseWorktree(projectRoot, storyId);

					// Retry merge
					result = await this.merge(projectRoot, storyId);

					// If still fails, mark as failed
					if (!result.success) {
						results.push({
							success: false,
							storyId,
							conflictFiles: result.conflictFiles,
							retryCount: 1,
						});
						failedStories.add(storyId);
						continue;
					}

					// Success after retry
					results.push({
						success: true,
						storyId,
						retryCount: 1,
					});
				} catch (error) {
					// Rebase failed, mark as failed
					results.push({
						success: false,
						storyId,
						conflictFiles: result.conflictFiles,
						retryCount: 1,
					});
					failedStories.add(storyId);
				}
			} else if (result.success) {
				// First attempt succeeded
				results.push({
					success: true,
					storyId,
					retryCount: 0,
				});
			} else {
				// Failed without conflicts (shouldn't happen normally)
				results.push({
					success: false,
					storyId,
					retryCount: 0,
				});
				failedStories.add(storyId);
			}
		}

		return results;
	}

	/**
	 * Topological sort of stories based on dependencies
	 * Returns stories in order where dependencies come before dependents
	 */
	private topologicalSort(
		storyIds: string[],
		dependencies: StoryDependencies,
	): string[] {
		const visited = new Set<string>();
		const sorted: string[] = [];
		const visiting = new Set<string>();

		const visit = (storyId: string) => {
			if (visited.has(storyId)) {
				return;
			}

			if (visiting.has(storyId)) {
				throw new Error(`Circular dependency detected involving ${storyId}`);
			}

			visiting.add(storyId);

			// Visit dependencies first
			const deps = dependencies[storyId] || [];
			for (const dep of deps) {
				if (storyIds.includes(dep)) {
					visit(dep);
				}
			}

			visiting.delete(storyId);
			visited.add(storyId);
			sorted.push(storyId);
		};

		for (const storyId of storyIds) {
			visit(storyId);
		}

		return sorted;
	}

	/**
	 * Rebases worktree on current base branch
	 */
	private async rebaseWorktree(
		projectRoot: string,
		storyId: string,
	): Promise<void> {
		const worktreePath = `${projectRoot}/.nax-wt/${storyId}`;

		try {
			// Get current branch name from main repo
			const currentBranchProc = Bun.spawn(
				["git", "rev-parse", "--abbrev-ref", "HEAD"],
				{
					cwd: projectRoot,
					stdout: "pipe",
					stderr: "pipe",
				},
			);

			const exitCode = await currentBranchProc.exited;
			if (exitCode !== 0) {
				throw new Error("Failed to get current branch");
			}

			const currentBranch = (
				await new Response(currentBranchProc.stdout).text()
			).trim();

			// Rebase worktree branch onto current branch
			const rebaseProc = Bun.spawn(
				["git", "rebase", currentBranch],
				{
					cwd: worktreePath,
					stdout: "pipe",
					stderr: "pipe",
				},
			);

			const rebaseExitCode = await rebaseProc.exited;
			if (rebaseExitCode !== 0) {
				const stderr = await new Response(rebaseProc.stderr).text();

				// Abort rebase on failure
				await Bun.spawn(["git", "rebase", "--abort"], {
					cwd: worktreePath,
					stdout: "pipe",
					stderr: "pipe",
				}).exited;

				throw new Error(`Rebase failed: ${stderr || "unknown error"}`);
			}
		} catch (error) {
			if (error instanceof Error) {
				throw error;
			}
			throw new Error(`Failed to rebase worktree ${storyId}: ${String(error)}`);
		}
	}

	/**
	 * Gets list of conflicted files
	 */
	private async getConflictFiles(projectRoot: string): Promise<string[]> {
		try {
			const proc = Bun.spawn(
				["git", "diff", "--name-only", "--diff-filter=U"],
				{
					cwd: projectRoot,
					stdout: "pipe",
					stderr: "pipe",
				},
			);

			const exitCode = await proc.exited;
			if (exitCode !== 0) {
				return [];
			}

			const stdout = await new Response(proc.stdout).text();
			return stdout
				.trim()
				.split("\n")
				.filter((line) => line.length > 0);
		} catch {
			return [];
		}
	}

	/**
	 * Aborts an in-progress merge
	 */
	private async abortMerge(projectRoot: string): Promise<void> {
		try {
			const proc = Bun.spawn(["git", "merge", "--abort"], {
				cwd: projectRoot,
				stdout: "pipe",
				stderr: "pipe",
			});

			await proc.exited;
		} catch (error) {
			// Log warning but don't throw - merge might already be aborted
			const logger = getSafeLogger();
			logger?.warn("worktree", "Failed to abort merge", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
