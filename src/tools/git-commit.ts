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
 */
async function partitionNaxOwnedPaths(root: string, paths: string[]): Promise<{ kept: string[]; skipped: string[] }> {
  if (paths.length === 0) return { kept: [], skipped: [] };

  // Dynamic import, not a top-level one: `@/utils/gitignore` imports
  // `PROJECT_FEATURES_DIR` from `@/config`, and `@/config` (config-guards.ts,
  // permissions.ts) imports from `@/tools` -- a top-level import here would
  // close that cycle back onto this same module and throw
  // "Cannot access 'PROJECT_FEATURES_DIR' before initialization" at load time.
  const { NAX_GITIGNORE_ENTRIES } = await import("@/utils/gitignore");

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
        const { exitCode } = await gitWithTimeout(
          ["-c", `core.excludesFile=${excludeFile}`, "check-ignore", "--no-index", "-q", "--", path],
          root,
        );
        return { path, ignored: exitCode === 0 };
      }),
    );
    const kept: string[] = [];
    const skipped: string[] = [];
    for (const { path, ignored } of results) (ignored ? skipped : kept).push(path);
    return { kept, skipped };
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
    if (rawPaths.length > 0 && rawPaths.every((path) => typeof path === "string")) {
      const partition = await partitionNaxOwnedPaths(ctx.root, rawPaths as string[]);
      skipped = partition.skipped;
      if (skipped.length > 0) {
        if (partition.kept.length === 0) {
          return {
            content: `Every supplied path is a nax-owned run artifact and was not staged: ${skipped.join(", ")}`,
            isError: true,
          };
        }
        effectiveInput = { ...input, paths: partition.kept };
      }
    }

    const built = buildCommitArgvs(effectiveInput);
    if ("error" in built) return { content: built.error, isError: true };

    const staged = await gitWithTimeout(built.add, ctx.root, 30_000);
    if (staged.exitCode !== 0) {
      return { content: `git add failed: ${staged.stderr.trim() || `exit ${staged.exitCode}`}`, isError: true };
    }
    const committed = await gitWithTimeout(built.commit, ctx.root, 30_000);
    if (committed.exitCode !== 0) {
      return {
        content: `git commit failed: ${committed.stderr.trim() || `exit ${committed.exitCode}`}`,
        isError: true,
      };
    }
    const skipNote =
      skipped.length > 0
        ? `\n\n[nax] Skipped ${skipped.length} nax-owned run artifact(s) -- not staged: ${skipped.join(", ")}`
        : "";
    return { content: committed.stdout.trim().slice(0, ctx.maxBytes) + skipNote };
  },
};
