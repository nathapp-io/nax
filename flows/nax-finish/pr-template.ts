/**
 * Repository PR/MR template discovery, ported from
 * `src/plugins/builtin/auto-pr/template.ts`.
 *
 * Ported rather than imported: `flows/` is loaded by acpx in its own Node
 * process, where nax's `src/` and its `@/*` alias do not exist. This matches
 * the convention already in this directory — `errors.ts`, `exec.ts`, `types.ts`
 * and the PR body builder are all flow-local re-implementations.
 *
 * The duplication is stable: these candidate paths are an external convention
 * set by GitHub and GitLab, not internal logic that drifts with the codebase.
 *
 * Why preserve-not-fill: passing `--body` / `--description` to `gh` / `glab`
 * suppresses the repo's default template, so it must be read and re-embedded.
 */
import { join } from "node:path";
import type { Forge } from "./steps/forge";

/**
 * Candidate template paths for GitHub, in priority order.
 * Multi-template directories (`PULL_REQUEST_TEMPLATE/`) are intentionally
 * skipped because they are ambiguous unattended.
 */
const GITHUB_TEMPLATE_PATHS: readonly string[] = [
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
] as const;

/** Preferred single-template location for GitLab. */
const GITLAB_DEFAULT_TEMPLATE_PATH = ".gitlab/merge_request_templates/Default.md";

/** Only `readText` is consulted, so any caller with a file reader can supply it. */
export interface TemplateDeps {
  readText: (path: string) => Promise<string | null>;
}

async function firstExisting(workdir: string, deps: TemplateDeps, paths: readonly string[]): Promise<string | null> {
  for (const relPath of paths) {
    const content = await deps.readText(join(workdir, relPath));
    if (content !== null) return content;
  }
  return null;
}

/**
 * Locate the PR/MR template for the current repository.
 *
 * @returns Template text verbatim, or `null` when none resolves — which is the
 *          common case and never an error.
 */
export async function findPrTemplate(workdir: string, forge: Forge, deps: TemplateDeps): Promise<string | null> {
  if (forge === "github") return firstExisting(workdir, deps, GITHUB_TEMPLATE_PATHS);
  return firstExisting(workdir, deps, [GITLAB_DEFAULT_TEMPLATE_PATH]);
}
