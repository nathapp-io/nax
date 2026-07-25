import { FinishError } from "../errors";
import { runArgv } from "../exec";
import type { RunFn } from "../types";
import { type Forge, detectForge, extractUrl, viewArgv } from "./forge";

export const _prDeps: { run: RunFn } = { run: runArgv };

/**
 * Parse `gh pr view --json isDraft,url` / `glab mr view --output json` stdout.
 *
 * GitHub's schema is well-defined: `{ isDraft, url }`. GitLab's `glab mr view --output json`
 * schema is not guaranteed to expose an equivalent boolean under a stable name across
 * versions, so this is best-effort: it checks a few plausible field names for draft status
 * and falls back to treating any successfully-parsed MR as ready (not draft) when none are
 * found — per the task brief, "treat any successful view as already-ready unless you find
 * clear evidence otherwise."
 */
function parseView(stdout: string, forge: Forge): { isDraft: boolean; url?: string } {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (forge === "github") {
      return { isDraft: parsed.isDraft === true, url: typeof parsed.url === "string" ? parsed.url : undefined };
    }
    const isDraft = parsed.isDraft === true || parsed.draft === true || parsed.work_in_progress === true;
    return { isDraft, url: extractUrl(stdout) };
  } catch {
    return { isDraft: false, url: extractUrl(stdout) };
  }
}

export async function openOrPromotePr(
  repoRoot: string,
  branch: string,
  title: string,
  body: string,
): Promise<{ status: "opened" | "promoted" | "already-ready"; url?: string }> {
  const forge = await detectForge(_prDeps.run, repoRoot, "finish-pr");
  const view = await _prDeps.run(viewArgv(forge, branch, "isDraft,url"), { cwd: repoRoot });

  if (view.exitCode !== 0) {
    const createCmd =
      forge === "github"
        ? ["gh", "pr", "create", "--title", title, "--body", body, "--head", branch]
        : ["glab", "mr", "create", "--title", title, "--description", body, "--source-branch", branch];
    const create = await _prDeps.run(createCmd, { cwd: repoRoot });
    if (create.exitCode !== 0) {
      throw new FinishError(
        `Failed to create PR/MR for "${branch}": ${create.stderr.trim() || `exit ${create.exitCode}`}`,
        "FINISH_PR_CREATE_FAILED",
        { stage: "finish-pr", branch },
      );
    }
    return { status: "opened", url: extractUrl(create.stdout) };
  }

  const { isDraft, url } = parseView(view.stdout, forge);
  if (isDraft) {
    const readyCmd = forge === "github" ? ["gh", "pr", "ready", branch] : ["glab", "mr", "update", branch, "--ready"];
    const ready = await _prDeps.run(readyCmd, { cwd: repoRoot });
    if (ready.exitCode !== 0) {
      throw new FinishError(
        `Failed to promote PR/MR "${branch}" to ready: ${ready.stderr.trim() || `exit ${ready.exitCode}`}`,
        "FINISH_PR_PROMOTE_FAILED",
        { stage: "finish-pr", branch },
      );
    }
    return { status: "promoted", url };
  }

  return { status: "already-ready", url };
}
