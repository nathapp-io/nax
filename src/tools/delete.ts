/**
 * Delete a file whose path the policy already resolved and approved.
 *
 * nax#1972: this used to be tracked-only, on the theory that a tracked
 * file's content is in git history (an undo away) while an untracked file
 * exists only on disk and is therefore unrecoverable. That rationale is
 * retired -- it made the guard unsatisfiable for a file the agent itself
 * wrote this session, which is untracked by construction. Paired with the
 * #1937 denial redirect (Exec `rm` bounces back to Delete), the agent had no
 * legal way to remove its own scratch output, and its fallback was to blank
 * files to 0 bytes with Write -- which the auto-commit sweep then carried
 * into history anyway. Refusing the deletion did not make anything more
 * recoverable; it just moved the damage to a different tool.
 *
 * The new rule follows the three states git actually puts a path in:
 *
 *   - tracked                        -> allow (unchanged)
 *   - untracked AND gitignored       -> refuse (unchanged verdict, new reason)
 *   - untracked and NOT gitignored   -> allow (the fix)
 *
 * Both untracked classes are equally unrecoverable -- neither is in git
 * history -- so recoverability alone no longer explains the split. What
 * distinguishes them is declared intent. A gitignored path has a rule
 * somebody wrote on purpose, saying "this lives only on this machine"
 * (`.env`, `.nax-pids`, `.claude/settings.local.json`, the fragments and
 * plan-log directories under `.nax` are real examples in this repo) --
 * deleting it is
 * unrecoverable AND was never meant to be sent anywhere else, so the refusal
 * stays, but the message now says why instead of telling the agent to commit
 * a file its own author chose to keep out of git. An untracked-and-not-
 * ignored path has no such rule attached to it at all: nobody has said
 * anything about it one way or the other. In practice that is agent scratch
 * or work in progress, so it is allowed.
 *
 * Accepted cost: a genuine new source file the agent wrote and has not yet
 * committed is untracked-and-not-ignored too, so this permission also makes
 * IT deletable -- there is no signal in git alone that separates "my own
 * throwaway probe" from "a real file I just haven't committed yet". That is
 * deliberate, not an oversight: it is the same permission that lets an agent
 * clean up after itself, and the completion-phase auto-commit sweep
 * (`autoCommitIfDirty`, `src/utils/git.ts`) is the backstop if something
 * real gets removed before it was staged.
 *
 * `.git/` never reaches this point at all -- `resolveWithin`
 * (`src/tools/policy.ts`) excludes it for every path-bearing tool, so
 * `ctx.resolvedPaths` cannot contain a `.git/` path in the first place
 * (nax#1943). Re-checking it here would be exactly the per-tool
 * re-remembering that issue exists to prevent.
 *
 * Not `git rm`: gitTool documents a deliberate read/write split, and `git rm`
 * both deletes and stages, folding two capabilities into one call. Plain
 * unlink plus the existing GitCommit keeps each seam doing one thing --
 * `git add -- <deleted path>` stages a deletion, so no change to GitCommit is
 * needed.
 */

import { lstat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { gitWithTimeout } from "@/utils/git";
import { matchesDenyPaths } from "./deny-paths";
import type { CodingTool, ToolResult, ToolRunContext } from "./registry";

const GIT_TIMEOUT_MS = 30_000;

export const deleteTool: CodingTool = {
  name: "Delete",
  description:
    "Delete a file. A tracked file is always removable. An untracked file is removable unless it is gitignored -- a gitignored path was deliberately kept out of git, so removing it is unrecoverable and is refused. Directories are refused. The removal still has to be staged -- pass the same path to GitCommit afterwards.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the repository root" },
    },
    required: ["path"],
  },
  scope: { pathFields: ["path"] },

  async run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
    if (ctx.resolvedPaths[0] === undefined) return { content: "no path supplied", isError: true };
    const shown = String(input.path);
    // The policy uses a realpath to prove containment, which dereferences a
    // symlink. Deletion must instead act on the requested directory entry: a
    // tracked symlink is itself recoverable, while its target may be a
    // different tracked file. The policy has already validated `shown`.
    const target = resolve(ctx.root, shown);

    // denyPaths (nax#1972) is a repo-authored narrowing of Delete, and is
    // checked before anything else this function decides -- including
    // existence -- because it is a blanket refusal on the path itself, not a
    // judgment about the path's current state on disk.
    if (matchesDenyPaths(shown, ctx.denyPaths)) {
      return {
        content: `"${shown}" matches this repository's denyPaths configuration, so Delete refuses it regardless of tracked status.`,
        isError: true,
      };
    }

    // Existence and directory come first so each refusal says the true thing.
    // Tracked-first would report a mistyped path as "not tracked", which is
    // technically true and diagnostically useless.
    let isDirectory: boolean;
    try {
      isDirectory = (await lstat(target)).isDirectory();
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
      // Untracked. Whether it stays refused now turns on the SECOND git
      // question -- gitignored or not -- rather than stopping here the way
      // the tracked-only rule used to. A `check-ignore` failure (exit 1) and
      // a git-level failure (exit >1, e.g. no repository) both fall through
      // to "not ignored" on purpose: this tool cannot tell the two apart
      // from the exit code alone, and "allow" is the correct default for
      // both -- there is no gitignore rule either way, so nothing declared
      // this path unrecoverable-on-purpose.
      const ignored = await gitWithTimeout(["check-ignore", "-q", "--", target], ctx.root, GIT_TIMEOUT_MS);
      if (ignored.exitCode === 0) {
        return {
          content: `"${shown}" is gitignored, so it exists only on this machine and is not recoverable once deleted. Delete refuses it for that reason.`,
          isError: true,
        };
      }
    }

    try {
      await unlink(target);
      return { content: `deleted ${shown} -- stage the removal by passing the same path to GitCommit` };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
