/**
 * Auto-PR Plugin — Forge Adapter
 *
 * Detects GitHub vs GitLab from a git remote URL, checks for an existing open
 * PR/MR on a branch, and opens draft PRs/MRs through the injected `deps.run`
 * runner. All subprocess access flows through `AutoPrDeps` so tests can swap
 * in fakes — no `Bun.spawn` calls live in this file.
 */

import type { PostRunActionResult } from "../../extensions";
import type { AutoPrDeps, ForgeKind } from "./types";

/** Inputs required to open a draft PR/MR. */
export interface OpenDraftInput {
  title: string;
  body: string;
  branch: string;
  draft: boolean;
}

/** Matches the first http(s) URL on a line — `gh`/`glab` print the URL on stdout. */
const URL_REGEX = /https?:\/\/\S+/;

export function detectForge(remoteUrl: string): ForgeKind | null {
  if (remoteUrl.includes("github.com")) return "github";
  if (remoteUrl.includes("gitlab.com")) return "gitlab";
  return null;
}

export async function hasOpenPr(forge: ForgeKind, branch: string, deps: AutoPrDeps, cwd: string): Promise<boolean> {
  const cmd =
    forge === "github"
      ? ["gh", "pr", "list", "--head", branch, "--state", "open", "--json", "number"]
      : ["glab", "mr", "list", "--source-branch", branch, "--state", "opened", "--output", "json"];
  const result = await deps.run(cmd, { cwd });
  if (result.exitCode !== 0) return false;
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

export async function openDraft(
  forge: ForgeKind,
  input: OpenDraftInput,
  deps: AutoPrDeps,
  cwd: string,
): Promise<PostRunActionResult> {
  const baseCmd: string[] =
    forge === "github"
      ? ["gh", "pr", "create", "--title", input.title, "--body", input.body]
      : ["glab", "mr", "create", "--title", input.title, "--description", input.body];
  const branchArg: string[] = forge === "github" ? ["--head", input.branch] : ["--source-branch", input.branch];
  const draftArg: string[] = input.draft ? ["--draft"] : [];
  const cmd = [...baseCmd, ...branchArg, ...draftArg];

  const result = await deps.run(cmd, { cwd });
  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || `forge CLI exited with code ${result.exitCode}`;
    return { success: false, message };
  }

  const urlMatch = result.stdout.match(URL_REGEX);
  const url = urlMatch ? urlMatch[0] : undefined;
  return {
    success: true,
    message: `Opened ${forge === "github" ? "PR" : "MR"} for ${input.branch}`,
    ...(url ? { url } : {}),
  };
}
