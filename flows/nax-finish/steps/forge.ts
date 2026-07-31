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

/**
 * Host of a git remote, for both URL forms git accepts:
 * `git@host:path` (scp-like) and `scheme://[user@]host[:port]/path`.
 */
export function remoteHost(remoteUrl: string): string {
  const scp = remoteUrl.match(/^[^/]*@([^:/]+):/);
  if (scp?.[1]) return scp[1].toLowerCase();
  const url = remoteUrl.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^:/]+)/i);
  return url?.[1]?.toLowerCase() ?? "";
}

/**
 * Classify by host name.
 *
 * Matching the host (not a substring of the whole URL) is what makes
 * self-hosted instances work: `"gitlab.mycorp.com".includes("gitlab.com")` is
 * false, so the previous check rejected every self-hosted forge. GitHub is
 * tested first purely for determinism on an absurd host naming both.
 */
function forgeFromHost(host: string): Forge | null {
  if (host.includes("github")) return "github";
  if (host.includes("gitlab")) return "gitlab";
  return null;
}

/**
 * Last resort for an enterprise host that names neither forge (`git.corp.com`):
 * ask which CLI is installed. Only decisive when exactly one is — with both or
 * neither present a guess would send `gh` at a GitLab remote.
 */
async function forgeFromCli(run: RunFn, repoRoot: string): Promise<Forge | null> {
  const [gh, glab] = await Promise.all([
    run(["gh", "--version"], { cwd: repoRoot }),
    run(["glab", "--version"], { cwd: repoRoot }),
  ]);
  const hasGh = gh.exitCode === 0;
  const hasGlab = glab.exitCode === 0;
  if (hasGh && !hasGlab) return "github";
  if (hasGlab && !hasGh) return "gitlab";
  return null;
}

export async function detectForge(run: RunFn, repoRoot: string, stage: string): Promise<Forge> {
  const remote = await run(["git", "remote", "get-url", "origin"], { cwd: repoRoot });
  const remoteUrl = remote.stdout.trim();
  const host = remoteHost(remoteUrl);

  const byHost = forgeFromHost(host);
  if (byHost) return byHost;

  const byCli = await forgeFromCli(run, repoRoot);
  if (byCli) return byCli;

  throw new FinishError(
    `Unable to determine forge for remote host "${host || remoteUrl}" — its name matches neither github nor gitlab, and the gh/glab probe was inconclusive`,
    "FINISH_UNKNOWN_FORGE",
    { stage, remoteUrl, host },
  );
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
