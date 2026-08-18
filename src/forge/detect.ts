/**
 * Forge detection.
 *
 * Classification matches the parsed *host*, not a substring of the whole URL.
 * That distinction is the whole point: `"gitlab.mycorp.com".includes("gitlab.com")`
 * is false, so a whole-URL substring check rejects every self-hosted forge.
 */
import type { ForgeDeps, ForgeKind } from "./types";

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
 * Classify a remote by host name. GitHub is tested first purely for determinism
 * on an absurd host naming both.
 */
export function forgeFromRemoteUrl(remoteUrl: string): ForgeKind | null {
  const host = remoteHost(remoteUrl);
  if (host.includes("github")) return "github";
  if (host.includes("gitlab")) return "gitlab";
  return null;
}

/**
 * Last resort for an enterprise host that names neither forge (`git.corp.com`):
 * ask which CLI is installed. Only decisive when exactly one is — with both or
 * neither present a guess would send `gh` at a GitLab remote.
 */
async function forgeFromCli(deps: ForgeDeps, repoRoot: string): Promise<ForgeKind | null> {
  const [gh, glab] = await Promise.all([
    deps.run(["gh", "--version"], { cwd: repoRoot }),
    deps.run(["glab", "--version"], { cwd: repoRoot }),
  ]);
  const hasGh = gh.exitCode === 0;
  const hasGlab = glab.exitCode === 0;
  if (hasGh && !hasGlab) return "github";
  if (hasGlab && !hasGh) return "gitlab";
  return null;
}

/**
 * Resolve the forge for a repository: read `origin`, classify by host, and fall
 * back to a CLI probe. Returns null rather than throwing — callers differ on
 * whether an undetermined forge is fatal, so the decision is theirs.
 */
export async function detectForge(deps: ForgeDeps, repoRoot: string): Promise<ForgeKind | null> {
  const remote = await deps.run(["git", "remote", "get-url", "origin"], { cwd: repoRoot });
  if (remote.exitCode !== 0) return null;
  return forgeFromRemoteUrl(remote.stdout.trim()) ?? (await forgeFromCli(deps, repoRoot));
}
