/**
 * Shared forge (GitHub / GitLab) helpers for the nax-finish flow.
 *
 * `run` is passed in by the caller rather than held here so each step keeps a
 * single injectable `_deps` object for tests.
 */
import { FinishError } from "../errors";
import type { RunFn } from "../types";

/** Matches the first http(s) URL on a line — `gh`/`glab` print the URL on stdout. */
const URL_REGEX = /https?:\/\/\S+/;

export type Forge = "github" | "gitlab";

export async function detectForge(run: RunFn, repoRoot: string, stage: string): Promise<Forge> {
  const remote = await run(["git", "remote", "get-url", "origin"], { cwd: repoRoot });
  const remoteUrl = remote.stdout.trim();
  if (remoteUrl.includes("github.com")) return "github";
  if (remoteUrl.includes("gitlab.com")) return "gitlab";
  throw new FinishError(`Unable to determine forge from remote URL "${remoteUrl}"`, "FINISH_UNKNOWN_FORGE", {
    stage,
    remoteUrl,
  });
}

/** Best-effort URL extraction: try `{url}` JSON first, fall back to a raw URL regex. */
export function extractUrl(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as { url?: string; web_url?: string };
    if (parsed.url) return parsed.url;
    if (parsed.web_url) return parsed.web_url;
  } catch {
    // fall through to regex extraction
  }
  const match = stdout.match(URL_REGEX);
  return match ? match[0] : undefined;
}

/** Argv for reading the branch's existing PR/MR as JSON. */
export function viewArgv(forge: Forge, branch: string, githubFields: string): string[] {
  return forge === "github"
    ? ["gh", "pr", "view", branch, "--json", githubFields]
    : ["glab", "mr", "view", branch, "--output", "json"];
}
