/**
 * Stage-and-commit, the one mutating git operation the implementer role needs.
 *
 * Separate from gitTool because buildGitArgv cannot express it: that builder
 * terminates with `--` and pathspecs and refuses any element beginning with
 * "-", so `commit -m <message>` is not representable in it. Splitting the tool
 * also lets a stage be granted the read verbs without the write one.
 *
 * The message is an argv ELEMENT, never parsed. A message that looks like a
 * flag is inert because it sits after `-m` in an argv array that never reaches
 * a shell -- a test pins that position.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitWithTimeout } from "@/utils/git";
import { gitlinkSafeAdd, hasStagedChanges } from "@/utils/git-add";
import { NAX_GITIGNORE_ENTRIES } from "@/utils/gitignore";
import type { CodingTool, ToolResult, ToolRunContext } from "./registry";

export function buildCommitArgvs(
  input: Record<string, unknown>,
): { add: string[]; commit: string[] } | { error: string } {
  const message = input.message;
  if (typeof message !== "string" || message.trim() === "") {
    return { error: "message must be a non-empty string" };
  }
  const paths = Array.isArray(input.paths) ? input.paths : [];
  if (paths.length === 0) return { error: "paths must name at least one file" };

  const add: string[] = ["add", "--"];
  for (const path of paths) {
    if (typeof path !== "string") return { error: "paths must be strings" };
    if (path.startsWith("-")) return { error: `path "${path}" may not begin with "-"` };
    add.push(path);
  }
  return { add, commit: ["commit", "-m", message] };
}

/** One unresolved path, and why `partitionNaxOwnedPaths` could not classify it. */
export interface UnknownPathResult {
  path: string;
  reason: string;
}

/**
 * Split `paths` into ones GitCommit may stage and ones it must refuse, per
 * `NAX_GITIGNORE_ENTRIES` -- the same SSOT `nax init`, `WorktreeManager`, and
 * `scripts/check-nax-artifacts-untracked.ts` all enforce.
 *
 * A real run staged its own `.nax/scratchpad/*.md` files through this exact
 * tool (no filter existed at all): the ignore-file reconcile in
 * `src/execution/lifecycle/gitignore-reconcile.ts` closes this for `git add -A`
 * and human adds, but is per-clone -- a fresh clone or CI has no local
 * `.git/info/exclude` yet, so this tool needs its own, independent check.
 *
 * `NAX_GITIGNORE_ENTRIES` are gitignore PATTERNS (`**\/.nax/scratchpad/`), not
 * literal paths -- hand-rolled substring/glob matching has bitten this repo
 * before (see the comment in `src/worktree/manager.ts` on `/foo/runs/` wrongly
 * "containing" `runs/`). Delegate to `git check-ignore` itself, exactly as
 * `scripts/check-nax-artifacts-untracked.ts` delegates to `git ls-files` --
 * both feed `NAX_GITIGNORE_ENTRIES` to git via a temp exclude file rather than
 * re-implementing pattern matching. `--no-index` is required: a path GitCommit
 * is being asked to stage for the first time is not yet in the index, and
 * `check-ignore` without it can decline to answer for such a path.
 *
 * THREE-STATE, fail-closed (code review, post-Fix-3): `git check-ignore`
 * exits 0 (ignored), 1 (not ignored) or 128 (fatal -- e.g. path outside the
 * repo, or not a git repo at all). `gitWithTimeout` additionally collapses a
 * hung subprocess to `exitCode: 1` with `timedOut: true` -- so `exitCode ===
 * 1` ALONE is not "not ignored", it is ALSO what a timeout looks like. Reading
 * it as "not ignored" without checking `timedOut` first put a nax-owned path
 * straight into `kept` on any error or timeout: fail-OPEN, silently, exactly
 * the class of bug this tool exists to prevent -- and under exactly the
 * contention (parallel worktrees stressing git) most likely to produce one.
 * A path that cannot be classified goes to neither `kept` nor `skipped`; it
 * is reported by the caller, loudly, as its own category.
 *
 * One `check-ignore` subprocess per path (not batched into one call): batching
 * would collapse this exact three-state distinction, since git's exit code for
 * a multi-path invocation reflects "at least one path matched", not a per-path
 * verdict, and a single fatal path (exit 128) would poison every other path in
 * the batch as unknown even when they are perfectly answerable individually.
 * Fine for the batch sizes a single commit call names.
 */
async function partitionNaxOwnedPaths(
  root: string,
  paths: string[],
): Promise<{ kept: string[]; skipped: string[]; unknown: UnknownPathResult[] }> {
  if (paths.length === 0) return { kept: [], skipped: [], unknown: [] };

  const excludeDir = mkdtempSync(join(tmpdir(), "nax-commit-filter-"));
  const excludeFile = join(excludeDir, "exclude");
  try {
    writeFileSync(excludeFile, `${NAX_GITIGNORE_ENTRIES.join("\n")}\n`, "utf8");
    const results = await Promise.all(
      paths.map(async (path) => {
        // `check-ignore` has no `--exclude-from` of its own (unlike `ls-files`,
        // which `scripts/check-nax-artifacts-untracked.ts` uses) -- pointing
        // `core.excludesFile` at the temp file via `-c` is the documented way
        // to feed it an arbitrary pattern list.
        const { exitCode, timedOut, stderr } = await gitWithTimeout(
          ["-c", `core.excludesFile=${excludeFile}`, "check-ignore", "--no-index", "-q", "--", path],
          root,
        );
        if (timedOut) return { path, status: "unknown" as const, reason: "git check-ignore timed out" };
        if (exitCode === 0) return { path, status: "ignored" as const };
        if (exitCode === 1) return { path, status: "not-ignored" as const };
        const detail = stderr.trim();
        return {
          path,
          status: "unknown" as const,
          reason: `git check-ignore exited ${exitCode}${detail ? `: ${detail}` : ""}`,
        };
      }),
    );
    const kept: string[] = [];
    const skipped: string[] = [];
    const unknown: UnknownPathResult[] = [];
    for (const result of results) {
      if (result.status === "ignored") skipped.push(result.path);
      else if (result.status === "not-ignored") kept.push(result.path);
      else unknown.push({ path: result.path, reason: result.reason });
    }
    return { kept, skipped, unknown };
  } finally {
    rmSync(excludeDir, { recursive: true, force: true });
  }
}

export const gitCommitTool: CodingTool = {
  name: "GitCommit",
  description:
    "Stage the named files and commit them. Supply the message as text and the files as an array; this is not a command line.",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Commit message. May contain a blank line and a body." },
      paths: {
        type: "array",
        items: { type: "string" },
        description: "Files to stage, relative to the repository root",
      },
    },
    required: ["message", "paths"],
  },
  scope: { pathFields: [], arrayPathFields: ["paths"] },

  async run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
    // Fix 3: filter nax-owned artifacts out of the caller's paths BEFORE
    // building argv, so they can never reach `git add`. Only attempted when
    // every supplied path is a plain string -- otherwise buildCommitArgvs's
    // own type validation below must see the original, unfiltered input so
    // its error message stays accurate.
    const rawPaths = Array.isArray(input.paths) ? input.paths : [];
    let effectiveInput = input;
    let skipped: string[] = [];
    let unknown: UnknownPathResult[] = [];
    if (rawPaths.length > 0 && rawPaths.every((path) => typeof path === "string")) {
      const partition = await partitionNaxOwnedPaths(ctx.root, rawPaths as string[]);
      skipped = partition.skipped;
      unknown = partition.unknown;
      // Fail CLOSED: an unresolved path is refused, exactly like a nax-owned
      // one -- it never reaches `kept`, so it can never reach `git add`.
      if (partition.kept.length === 0) {
        const refusals: string[] = [];
        if (skipped.length > 0) {
          refusals.push(`${skipped.length} nax-owned run artifact(s), not staged: ${skipped.join(", ")}`);
        }
        if (unknown.length > 0) {
          refusals.push(
            `${unknown.length} path(s) whose ignore status could not be determined, refused to stage them: ${unknown
              .map((u) => `${u.path} (${u.reason})`)
              .join("; ")}`,
          );
        }
        return {
          content: `Nothing was staged -- every supplied path was refused: ${refusals.join("; ")}`,
          isError: true,
        };
      }
      effectiveInput = { ...input, paths: partition.kept };
    }

    const built = buildCommitArgvs(effectiveInput);
    if ("error" in built) return { content: built.error, isError: true };

    // Through gitlinkSafeAdd: a bare `git add` would run git inside any gitlink
    // the paths cover, under that nested repo's own config (#2210).
    const pathspecs = built.add.slice(built.add.indexOf("--") + 1);
    const staged = await gitlinkSafeAdd(gitWithTimeout, ctx.root, { pathspecs, timeoutMs: 30_000 });
    if (staged.exitCode !== 0) {
      return { content: `git add failed: ${staged.stderr.trim() || `exit ${staged.exitCode}`}`, isError: true };
    }
    // The agent chooses the paths, so it can make the add a no-op; a commit with
    // nothing staged would print status, which can recurse into a gitlink (#2210).
    const hasStaged = await hasStagedChanges(gitWithTimeout, ctx.root, 30_000);
    if (hasStaged !== true) {
      const why = hasStaged === false ? "nothing is staged" : "could not tell whether anything is staged";
      return { content: `git commit not run: ${why}`, isError: true };
    }
    const committed = await gitWithTimeout(built.commit, ctx.root, 30_000);
    if (committed.exitCode !== 0) {
      return {
        content: `git commit failed: ${committed.stderr.trim() || `exit ${committed.exitCode}`}`,
        isError: true,
      };
    }
    const notes: string[] = [];
    if (skipped.length > 0) {
      notes.push(`[nax] Skipped ${skipped.length} nax-owned run artifact(s) -- not staged: ${skipped.join(", ")}`);
    }
    if (unknown.length > 0) {
      notes.push(
        `[nax] REFUSED to stage ${unknown.length} path(s) with an unresolved ignore status (fail-closed): ${unknown
          .map((u) => `${u.path} (${u.reason})`)
          .join("; ")}`,
      );
    }
    const skipNote = notes.length > 0 ? `\n\n${notes.join("\n")}` : "";
    return { content: committed.stdout.trim().slice(0, ctx.maxBytes) + skipNote };
  },
};
