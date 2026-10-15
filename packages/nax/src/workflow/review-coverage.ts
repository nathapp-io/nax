/**
 * The set of changed files the whole-branch reviewer *must* inspect
 * (SPEC-workflow-review-depth § Approach 3, nax#2622).
 *
 * The branch package no longer inlines a diff, so the reviewer is told exactly which files to pull
 * with `git diff <range> -- <path>`. This trims the list to files whose contents are worth reading:
 * test files (classified per owning package through the ADR-009 resolver SSOT) and documentation /
 * non-source files are dropped. Everything else stays — configuration, JSON, YAML and i18n message
 * files are cheap to diff and a wrong value in them is a real defect.
 *
 * Lives under `src/workflow` beside the branch op that uses it, and is consumed by
 * `runBranchReview` (US-002). The pure coverage comparison lives in `src/operations`
 * (`workflow-review-coverage.ts`) because `src/operations` never imports `src/workflow`.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getLogger } from "@/logger";
import type { FeatureContext } from "./feature-context";
import { _workflowDeps } from "./step-context";

/** A basename with one of these suffixes is documentation or a rendering, not source. */
const NON_SOURCE_SUFFIXES = [".md", ".mdx", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".pdf"] as const;

/** Lockfiles are generated, huge, and say nothing a reviewer can act on. Compared lowercased. */
const LOCKFILE_BASENAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "cargo.lock",
  "go.sum",
  "poetry.lock",
  "uv.lock",
]);

function basename(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/** Documentation, lockfiles and images/documents, matched on the basename at any depth. */
function isNonSource(path: string): boolean {
  const base = basename(path).toLowerCase();
  return LOCKFILE_BASENAMES.has(base) || NON_SOURCE_SUFFIXES.some((suffix) => base.endsWith(suffix));
}

/**
 * The owning package dir: the *longest* entry of `packageDirs` that prefixes `path` as a path
 * segment. `undefined` means no package owns it, and the root patterns apply.
 */
function owningPackage(path: string, packageDirs: readonly string[]): string | undefined {
  let owner: string | undefined;
  for (const dir of packageDirs) {
    if (dir === "" || (path !== dir && !path.startsWith(`${dir}/`))) continue;
    if (owner === undefined || dir.length > owner.length) owner = dir;
  }
  return owner;
}

/** A path's repo-rooted directory prefix, for the per-package resolution log line. */
function unresolvedPackage(packageDir: string | undefined): string {
  return packageDir ?? "(root)";
}

/**
 * The paths a reviewer must inspect, in the order given.
 *
 * Read-only: `fc` is the `FeatureContext` slice the classification needs, so the helper runs
 * against a real feature context and against a test double alike.
 */
export async function reviewRequiredFiles(
  paths: readonly string[],
  fc: Pick<FeatureContext, "config" | "projectDir" | "packageDirs">,
): Promise<string[]> {
  const byPackage = new Map<string | undefined, readonly RegExp[]>();

  // Resolve once per package dir, not once per file (ADR-009 §2.8). A resolution failure widens the
  // required set (nothing in that package is called a test file) — never narrows it. Two packages
  // can only diverge if the resolver itself fails differently, so the failure is logged per dir.
  const patternsFor = async (packageDir: string | undefined): Promise<readonly RegExp[]> => {
    const cached = byPackage.get(packageDir);
    if (cached !== undefined) return cached;
    let regex: readonly RegExp[] = [];
    try {
      const resolved = await _workflowDeps.resolveTestPatterns(fc.config, fc.projectDir, packageDir, {
        storyId: "_run",
      });
      regex = resolved.regex;
    } catch (err) {
      getLogger().warn("workflow", "Could not resolve test file patterns; treating every file as required", {
        storyId: "_run",
        packageDir: unresolvedPackage(packageDir),
        error: errorMessage(err),
      });
    }
    byPackage.set(packageDir, regex);
    return regex;
  };

  const required: string[] = [];
  for (const path of paths) {
    if (isNonSource(path)) continue;
    const patterns = await patternsFor(owningPackage(path, fc.packageDirs));
    if (patterns.some((regex) => regex.test(path))) continue;
    required.push(path);
  }
  return required;
}
