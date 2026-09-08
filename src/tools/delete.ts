/**
 * Delete a tracked file whose path the policy already resolved and approved.
 *
 * Tracked-only, and that is a safety boundary rather than a convenience: a
 * tracked file's content is in git history, so removing it is an undo away,
 * while an untracked file exists only on disk. It also excludes everything
 * under `.git/` by construction -- nothing there is tracked -- which matters
 * because the policy confines paths to the permitted root and `.git` is inside
 * it (nax#1943).
 *
 * Not `git rm`: gitTool documents a deliberate read/write split, and `git rm`
 * both deletes and stages, folding two capabilities into one call. Plain
 * unlink plus the existing GitCommit keeps each seam doing one thing --
 * `git add -- <deleted path>` stages a deletion, so no change to GitCommit is
 * needed.
 */

import { stat, unlink } from "node:fs/promises";
import { gitWithTimeout } from "@/utils/git";
import type { CodingTool, ToolResult, ToolRunContext } from "./registry";

const GIT_TIMEOUT_MS = 30_000;

export const deleteTool: CodingTool = {
  name: "Delete",
  description:
    "Delete a file the repository already tracks. Only tracked files can be removed, so every deletion stays recoverable from git history; untracked files and directories are refused. The removal still has to be staged -- pass the same path to GitCommit afterwards.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the repository root" },
    },
    required: ["path"],
  },
  scope: { pathFields: ["path"] },

  async run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
    const [target] = ctx.resolvedPaths;
    if (target === undefined) return { content: "no path supplied", isError: true };
    const shown = String(input.path);

    // Existence and directory come first so each refusal says the true thing.
    // Tracked-first would report a mistyped path as "not tracked", which is
    // technically true and diagnostically useless.
    let isDirectory: boolean;
    try {
      isDirectory = (await stat(target)).isDirectory();
    } catch {
      return { content: `"${shown}" does not exist`, isError: true };
    }
    if (isDirectory) {
      // Reachable, not defensive: `ls-files --error-unmatch` exits 0 for a
      // directory holding tracked files, so "tracked" does not imply "file".
      return { content: `"${shown}" is a directory; Delete removes one file at a time`, isError: true };
    }

    const tracked = await gitWithTimeout(["ls-files", "--error-unmatch", "--", target], ctx.root, GIT_TIMEOUT_MS);
    if (tracked.exitCode !== 0) {
      // "untracked" and "git failed" get the same message on purpose: both
      // mean the tool cannot prove the deletion would be recoverable.
      return {
        content: `"${shown}" is not tracked by git, so deleting it would be unrecoverable. Delete removes tracked files only -- commit it first if you want it gone.`,
        isError: true,
      };
    }

    try {
      await unlink(target);
      return { content: `deleted ${shown} -- stage the removal by passing the same path to GitCommit` };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
