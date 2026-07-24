import { NaxError } from "@/errors";
import type { RunFn } from "../types";

/** Matches the first http(s) URL on a line — `gh`/`glab` print the URL on stdout. */
const URL_REGEX = /https?:\/\/\S+/;

async function defaultRun(cmd: string[], opts: { cwd: string }) {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

export const _prDeps: { run: RunFn } = { run: defaultRun };

async function detectForge(repoRoot: string, stage: string): Promise<"github" | "gitlab"> {
  const remote = await _prDeps.run(["git", "remote", "get-url", "origin"], { cwd: repoRoot });
  const remoteUrl = remote.stdout.trim();
  if (remoteUrl.includes("github.com")) return "github";
  if (remoteUrl.includes("gitlab.com")) return "gitlab";
  throw new NaxError(`Unable to determine forge from remote URL "${remoteUrl}"`, "FINISH_UNKNOWN_FORGE", {
    stage,
    remoteUrl,
  });
}

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
function parseView(stdout: string, forge: "github" | "gitlab"): { isDraft: boolean; url?: string } {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (forge === "github") {
      return { isDraft: parsed.isDraft === true, url: typeof parsed.url === "string" ? parsed.url : undefined };
    }
    const isDraft = parsed.isDraft === true || parsed.draft === true || parsed.work_in_progress === true;
    const url =
      typeof parsed.url === "string" ? parsed.url : typeof parsed.web_url === "string" ? parsed.web_url : undefined;
    return { isDraft, url: url ?? extractUrl(stdout) };
  } catch {
    return { isDraft: false, url: extractUrl(stdout) };
  }
}

function extractUrl(stdout: string): string | undefined {
  const match = stdout.match(URL_REGEX);
  return match ? match[0] : undefined;
}

export async function openOrPromotePr(
  repoRoot: string,
  branch: string,
  title: string,
  body: string,
): Promise<{ status: "opened" | "promoted" | "already-ready"; url?: string }> {
  const forge = await detectForge(repoRoot, "finish-pr");

  const viewCmd =
    forge === "github"
      ? ["gh", "pr", "view", branch, "--json", "isDraft,url"]
      : ["glab", "mr", "view", branch, "--output", "json"];
  const view = await _prDeps.run(viewCmd, { cwd: repoRoot });

  if (view.exitCode !== 0) {
    const createCmd =
      forge === "github"
        ? ["gh", "pr", "create", "--fill", "--head", branch]
        : ["glab", "mr", "create", "--title", title, "--description", body, "--source-branch", branch];
    const create = await _prDeps.run(createCmd, { cwd: repoRoot });
    if (create.exitCode !== 0) {
      throw new NaxError(
        `Failed to create PR/MR for "${branch}": ${create.stderr.trim() || `exit ${create.exitCode}`}`,
        "FINISH_PR_CREATE_FAILED",
        {
          stage: "finish-pr",
          branch,
        },
      );
    }
    return { status: "opened", url: extractUrl(create.stdout) };
  }

  const { isDraft, url } = parseView(view.stdout, forge);
  if (isDraft) {
    const readyCmd = forge === "github" ? ["gh", "pr", "ready", branch] : ["glab", "mr", "update", branch, "--ready"];
    const ready = await _prDeps.run(readyCmd, { cwd: repoRoot });
    if (ready.exitCode !== 0) {
      throw new NaxError(
        `Failed to promote PR/MR "${branch}" to ready: ${ready.stderr.trim() || `exit ${ready.exitCode}`}`,
        "FINISH_PR_PROMOTE_FAILED",
        {
          stage: "finish-pr",
          branch,
        },
      );
    }
    return { status: "promoted", url };
  }

  return { status: "already-ready", url };
}
