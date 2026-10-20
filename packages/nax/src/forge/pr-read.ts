import { NaxError } from "@/errors";
import { detectForge, remoteHost } from "./detect";
import type { PrRef } from "./pr-types";
import type { ForgeDeps } from "./types";

/** Repository path of an scp-like or scheme URL origin, without slashes or .git suffix. */
export function repoSlugFromRemoteUrl(remoteUrl: string): string | null {
  const scp = remoteUrl.match(/^[^/]*@[^:/]+:(.*)$/);
  const url = remoteUrl.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?[^:/]+(?::\d+)?\/(.*)$/i);
  const path = (scp?.[1] ?? url?.[1] ?? "").replace(/^\/+|\/+$/g, "");
  return path.replace(/\.git$/, "").replace(/\/+$/g, "") || null;
}

/** Encode a GitLab project path as one endpoint segment. */
export function encodeProjectPath(repo: string): string {
  return encodeURIComponent(repo);
}

/** Resolve a numbered PR against the checkout's origin, never implicit CLI repo context. */
export async function resolvePrRef(number: number, deps: ForgeDeps, cwd: string): Promise<PrRef> {
  if (!Number.isInteger(number) || number <= 0) {
    throw new NaxError(`[forge] Invalid PR number: ${number}`, "FORGE_PR_REF_UNRESOLVED", { stage: "forge", number });
  }
  const forge = await detectForge(deps, cwd);
  if (!forge) {
    throw new NaxError("[forge] Cannot determine forge from origin", "FORGE_PR_REF_UNRESOLVED", {
      stage: "forge",
      cwd,
    });
  }
  // nax-git-env-allow: ForgeDeps.run hardens every command in production
  const remote = await deps.run(["git", "remote", "get-url", "origin"], { cwd });
  if (remote.exitCode !== 0) {
    throw new NaxError(`[forge] Cannot read origin: ${remote.stderr.trim()}`, "FORGE_PR_REF_UNRESOLVED", {
      stage: "forge",
      cwd,
      exitCode: remote.exitCode,
    });
  }
  const url = remote.stdout.trim();
  const repo = repoSlugFromRemoteUrl(url);
  if (!repo) {
    throw new NaxError("[forge] Origin has no repository path", "FORGE_PR_REF_UNRESOLVED", { stage: "forge", cwd });
  }
  return { forge, host: remoteHost(url), repo, number };
}
