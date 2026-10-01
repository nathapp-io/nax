/**
 * Reading and creating PRs/MRs through the `gh` and `glab` CLIs.
 */
import { NaxError } from "@/errors";
import type { ForgeDeps, ForgeKind } from "./types";

/** Matches the first http(s) URL — `gh`/`glab` print the URL on stdout. */
const URL_REGEX = /https?:\/\/\S+/;

/** Best-effort URL extraction: try `{url}`/`{web_url}` JSON first, then a raw regex. */
export function extractUrl(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as { url?: string; web_url?: string };
    if (parsed.url) return parsed.url;
    if (parsed.web_url) return parsed.web_url;
  } catch {
    // fall through to regex extraction
  }
  return stdout.match(URL_REGEX)?.[0];
}

/** Argv for reading the branch's existing PR/MR as JSON. */
export function viewArgv(forge: ForgeKind, branch: string, githubFields: string): string[] {
  return forge === "github"
    ? ["gh", "pr", "view", branch, "--json", githubFields]
    : ["glab", "mr", "view", branch, "--output", "json"];
}

/**
 * Whether an open PR/MR exists for the branch.
 *
 * BUG-8: a non-zero exit must NOT read as "no open PR". A `gh` auth failure or a
 * transient API error both exit non-zero, and treating that as a green light let
 * two concurrent runs each open a PR. Throwing makes the caller decide, and the
 * safe decision is to skip.
 */
export async function hasOpenPr(forge: ForgeKind, branch: string, deps: ForgeDeps, cwd: string): Promise<boolean> {
  const cmd =
    forge === "github"
      ? ["gh", "pr", "list", "--head", branch, "--state", "open", "--json", "number"]
      : ["glab", "mr", "list", "--source-branch", branch, "--state", "opened", "--output", "json"];
  const result = await deps.run(cmd, { cwd });
  if (result.exitCode !== 0) {
    throw new NaxError(
      `hasOpenPr: forge CLI exited with code ${result.exitCode}: ${result.stderr.trim()}`,
      "FORGE_PR_LIST_FAILED",
      { forge, branch, exitCode: result.exitCode },
    );
  }
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

/** Inputs required to open a PR/MR. */
export interface OpenPrInput {
  title: string;
  body: string;
  branch: string;
  draft: boolean;
}

/**
 * Structurally assignable to `PostRunActionResult` so the auto-PR plugin can
 * return it unchanged, without this module depending on the plugin types.
 */
export interface OpenPrResult {
  success: boolean;
  message: string;
  url?: string;
}

/** Open a PR/MR, as a draft or ready for review. */
export async function openPr(
  forge: ForgeKind,
  input: OpenPrInput,
  deps: ForgeDeps,
  cwd: string,
): Promise<OpenPrResult> {
  const baseCmd =
    forge === "github"
      ? ["gh", "pr", "create", "--title", input.title, "--body", input.body]
      : ["glab", "mr", "create", "--title", input.title, "--description", input.body];
  const branchArg = forge === "github" ? ["--head", input.branch] : ["--source-branch", input.branch];
  const draftArg = input.draft ? ["--draft"] : [];

  const result = await deps.run([...baseCmd, ...branchArg, ...draftArg], { cwd });
  if (result.exitCode !== 0) {
    return {
      success: false,
      message: result.stderr.trim() || `forge CLI exited with code ${result.exitCode}`,
    };
  }
  const url = extractUrl(result.stdout);
  return {
    success: true,
    message: `Opened ${forge === "github" ? "PR" : "MR"} for ${input.branch}`,
    ...(url ? { url } : {}),
  };
}
