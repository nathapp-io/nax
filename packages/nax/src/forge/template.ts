/**
 * Repository PR/MR template discovery.
 *
 * Why preserve-not-fill: passing `--body` / `--description` to `gh` / `glab`
 * suppresses the repo's default template, so callers must read and re-embed it.
 */
import * as path from "node:path";
import type { ForgeDeps, ForgeKind } from "./types";

/**
 * Candidate template paths for GitHub, in priority order. Multi-template
 * directories (`PULL_REQUEST_TEMPLATE/`) are intentionally skipped because they
 * are ambiguous unattended.
 */
const GITHUB_TEMPLATE_PATHS: readonly string[] = [
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
] as const;

/** Preferred single-template location for GitLab. */
const GITLAB_DEFAULT_TEMPLATE_PATH = ".gitlab/merge_request_templates/Default.md";

async function firstExisting(workdir: string, deps: ForgeDeps, paths: readonly string[]): Promise<string | null> {
  for (const relPath of paths) {
    const content = await deps.readText(path.join(workdir, relPath));
    if (content !== null) return content;
  }
  return null;
}

/** Locate the PR/MR template for the repository, or null when none resolves. */
export async function findPrTemplate(workdir: string, forge: ForgeKind, deps: ForgeDeps): Promise<string | null> {
  if (forge === "github") return firstExisting(workdir, deps, GITHUB_TEMPLATE_PATHS);
  if (forge === "gitlab") return firstExisting(workdir, deps, [GITLAB_DEFAULT_TEMPLATE_PATH]);
  return null;
}
