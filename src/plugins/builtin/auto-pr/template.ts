/**
 * Auto-PR Plugin — Template Discovery
 *
 * Locates and returns the repository's PR/MR template verbatim.
 *
 * Why preserve-not-fill: passing `--body` / `--description` to `gh` / `glab`
 * suppresses the repo's default template, so the plugin must read and re-embed it.
 *
 * All filesystem access goes through the injected `deps.readText` so callers can
 * swap in test fakes without touching real disk.
 */

import type { AutoPrDeps, ForgeKind } from "./types";

/**
 * Candidate template paths for GitHub, in priority order.
 * Multi-template directories (`PULL_REQUEST_TEMPLATE/`) are intentionally skipped
 * because they are ambiguous unattended.
 */
const GITHUB_TEMPLATE_PATHS: readonly string[] = [
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
] as const;

/** Preferred single-template location for GitLab. */
const GITLAB_DEFAULT_TEMPLATE_PATH = ".gitlab/merge_request_templates/Default.md";

async function firstExisting(deps: AutoPrDeps, paths: readonly string[]): Promise<string | null> {
  for (const relPath of paths) {
    const content = await deps.readText(relPath);
    if (content !== null) {
      return content;
    }
  }
  return null;
}

/**
 * Locate the PR/MR template for the current repository.
 *
 * @param workdir - Absolute path to the repository root (unused here; preserved for
 *                  the contract that callers may resolve relative-to-workdir paths
 *                  inside their `deps.readText` implementation).
 * @param forge   - Host type. Currently only `"github"` and `"gitlab"` are supported.
 * @param deps    - Injected deps. Only `deps.readText` is consulted.
 * @returns Template text verbatim, or `null` when no template resolves.
 */
export async function findPrTemplate(_workdir: string, forge: ForgeKind, deps: AutoPrDeps): Promise<string | null> {
  if (forge === "github") {
    return firstExisting(deps, GITHUB_TEMPLATE_PATHS);
  }
  if (forge === "gitlab") {
    return firstExisting(deps, [GITLAB_DEFAULT_TEMPLATE_PATH]);
  }
  return null;
}
