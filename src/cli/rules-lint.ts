/**
 * `nax rules lint` CLI command (Phase 5.1)
 *
 * Validates canonical rules neutrality/frontmatter for the repository root
 * and any package-local `.nax/rules/` stores found under the workdir.
 *
 * See: docs/specs/SPEC-context-engine-v2.md §Canonical rules delivery
 */

import { join } from "node:path";
import { globToRegex, normalizePath } from "../context/engine";
import { CANONICAL_RULES_DIR, loadCanonicalRules } from "../context/rules/canonical-loader";
import { NaxError } from "../errors";
import { getLogger } from "../logger";
import { discoverWorkspacePackages } from "../test-runners";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

/** Cap on the dead-glob validation scan — mirrors MAX_CANONICAL_RULE_GLOB_FILES below. */
export const MAX_DEAD_GLOB_SCAN_FILES = 2000;

/**
 * Safety-valve cap on TOTAL walk entries examined (matched + excluded) before
 * giving up (#1471 follow-up). Excluded entries (node_modules/, .git/, etc.)
 * don't count toward MAX_DEAD_GLOB_SCAN_FILES so a real match past a large
 * excluded tree is still found, but an unbounded excluded tree (a monorepo
 * with a huge node_modules) would otherwise make every entry inside it get
 * walked on every lint run. This bounds worst-case wall time.
 */
export const MAX_DEAD_GLOB_SCAN_TOTAL_ENTRIES = MAX_DEAD_GLOB_SCAN_FILES * 25;

/** Cap on the package-overlay glob scan (monorepo-awareness.md §6). */
export const MAX_CANONICAL_RULE_GLOB_FILES = 500;

/** Directories that never legitimately contain a `.nax/rules` overlay root. */
export const CANONICAL_RULE_GLOB_EXCLUDE_SEGMENTS = ["/node_modules/", "/.git/"];

/**
 * Directories skipped BEFORE the dead-glob scan counts toward
 * MAX_DEAD_GLOB_SCAN_FILES (#1471) — machine-generated/vendor trees that
 * would otherwise burn the whole cap before real repo source is reached.
 */
export const DEAD_GLOB_SCAN_EXCLUDE_SEGMENTS = ["/node_modules/", "/.git/", "/dist/", "/build/", "/.nax/"];

export const _rulesLintDeps = {
  globCanonicalRuleFiles: (workdir: string): string[] => {
    try {
      const found: string[] = [];
      for (const file of new Bun.Glob("**/.nax/rules/**/*.md").scanSync({ cwd: workdir, absolute: false, dot: true })) {
        if (found.length >= MAX_CANONICAL_RULE_GLOB_FILES) break;
        const normalized = `/${file}/`;
        if (CANONICAL_RULE_GLOB_EXCLUDE_SEGMENTS.some((seg) => normalized.includes(seg))) continue;
        found.push(file);
      }
      return found.sort();
    } catch {
      return [];
    }
  },
  // Deliberately reuses globToRegex/normalizePath — the SAME matcher
  // ruleMatchesScopeFiles (src/context/engine/providers/static-rules.ts) uses
  // at runtime — so a pattern that lints as "has matches" is guaranteed to
  // actually match at runtime.
  globHasMatch: (pattern: string, cwd: string): boolean => {
    try {
      const regex = globToRegex(normalizePath(pattern));
      let scanned = 0;
      let examined = 0;
      for (const file of new Bun.Glob("**/*").scanSync({ cwd, absolute: false, dot: true })) {
        if (examined >= MAX_DEAD_GLOB_SCAN_TOTAL_ENTRIES) break;
        examined++;
        const normalized = `/${normalizePath(file)}/`;
        if (DEAD_GLOB_SCAN_EXCLUDE_SEGMENTS.some((seg) => normalized.includes(seg))) continue;
        if (scanned >= MAX_DEAD_GLOB_SCAN_FILES) break;
        scanned++;
        if (regex.test(normalizePath(file))) return true;
      }
      return false;
    } catch {
      return false;
    }
  },
  loadCanonicalRules,
  getLogger,
  // Repo-shape detector (US-002): a non-empty package list means `paths:` is
  // meaningful package scope; an empty list in a single-package repo means any
  // declared `paths:` is inert. Stubbed via deps so tests don't need fixture
  // monorepos. Per monorepo-awareness.md §5, this is the single resolver for
  // "what packages does this repo have?" — never a hand-rolled manifest check.
  discoverWorkspacePackages: (workdir: string): Promise<string[]> => discoverWorkspacePackages(workdir),
};

// ─────────────────────────────────────────────────────────────────────────────
// Root discovery
// ─────────────────────────────────────────────────────────────────────────────

export function collectCanonicalRuleRoots(
  workdir: string,
  globCanonicalRuleFiles: (workdir: string) => string[] = _rulesLintDeps.globCanonicalRuleFiles,
): string[] {
  const roots = new Set<string>([workdir]);
  const files = globCanonicalRuleFiles(workdir);
  for (const rel of files) {
    const normalized = rel.replaceAll("\\", "/");
    const marker = "/.nax/rules/";
    const idx = normalized.indexOf(marker);
    if (idx <= 0) continue;
    const packageRel = normalized.slice(0, idx);
    if (!packageRel) continue;
    roots.add(join(workdir, packageRel));
  }
  return [...roots].sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// Interface
// ─────────────────────────────────────────────────────────────────────────────

export interface RulesLintOptions {
  /** Project working directory (default: process.cwd()) */
  dir?: string;
}

export interface RulesLintDeps {
  globCanonicalRuleFiles: (workdir: string) => string[];
  loadCanonicalRules: typeof loadCanonicalRules;
  globHasMatch: (pattern: string, cwd: string) => boolean;
  getLogger: typeof getLogger;
  discoverWorkspacePackages: (workdir: string) => Promise<string[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Command
// ─────────────────────────────────────────────────────────────────────────────

export async function rulesLintCommand(options: RulesLintOptions, deps: RulesLintDeps = _rulesLintDeps): Promise<void> {
  const workdir = options.dir ?? process.cwd();
  const roots = collectCanonicalRuleRoots(workdir, deps.globCanonicalRuleFiles);
  const logger = deps.getLogger();

  // US-002: a rule's `paths:` is meaningful package scope only when the repo
  // is a workspace monorepo. In a single-package repo every migrated `paths:`
  // block is inert — silently passing lint while scoping never applies. Fail-
  // open: a rejecting workspace resolver skips this check entirely; a false
  // "your scoping is broken" warning is worse than a missing one.
  let isSinglePackageRepo = true;
  try {
    isSinglePackageRepo = (await deps.discoverWorkspacePackages(workdir)).length === 0;
  } catch {
    isSinglePackageRepo = false;
  }

  let totalRuleFiles = 0;
  let warningCount = 0;
  const failedRoots: Array<{ root: string; cause: unknown }> = [];
  for (const root of roots) {
    let rules: Awaited<ReturnType<typeof deps.loadCanonicalRules>>;
    try {
      rules = await deps.loadCanonicalRules(root);
    } catch (err) {
      // Per-root isolation: a loader failure on one root must not abort the
      // remaining roots. The aggregate rejection below names every failed root
      // so the operator sees the full set, not just the first one.
      failedRoots.push({ root, cause: err });
      continue;
    }
    totalRuleFiles += rules.length;
    for (const rule of rules) {
      // Re-emit parser/loader warnings (unrecognised stages, displaced frontmatter)
      // through the lint command's own logger so `nax rules lint` is observable
      // as a standalone CLI invocation, independent of the loader's runtime logger.
      for (const warning of rule.warnings ?? []) {
        warningCount++;
        logger.warn("rules-lint", `Rule frontmatter warning: ${warning}`, {
          file: rule.path ?? rule.fileName,
          root,
        });
      }
      for (const pattern of rule.appliesTo ?? []) {
        if (deps.globHasMatch(pattern, root)) continue;
        warningCount++;
        logger.warn("rules-lint", "Canonical rule appliesTo glob matches no files in the linted repository", {
          file: rule.path ?? rule.fileName,
          pattern,
          root,
        });
      }
      // US-002: warn when a rule declares `paths:` in a single-package repo.
      // nax's `paths:` is package scope (matched against the story's package
      // dir), so in a single-package repo it always short-circuits to true
      // and the scoping never narrows the rule's reach. The alternative for
      // FILE globs is `appliesTo:` — which is what the migration translation
      // produces from Claude's `paths:` frontmatter.
      if (isSinglePackageRepo && rule.paths && rule.paths.length > 0) {
        warningCount++;
        logger.warn(
          "rules-lint",
          "Canonical rule declares paths: but the repository has no workspace packages — paths: is inert in single-package repos. Use appliesTo: for file globs.",
          {
            file: join(root, CANONICAL_RULES_DIR, rule.path ?? rule.fileName),
            code: "INERT_PATHS",
            paths: rule.paths,
            root,
            warningCount,
          },
        );
      }
    }
  }

  // Empty canonical store: the operator gets a clean [OK] pass today, which
  // hides the fact that no source-of-truth rules are being linted at all.
  // Surface it as a logger warning so the trailing summary reports [WARN].
  if (totalRuleFiles === 0 && failedRoots.length === 0) {
    warningCount++;
    logger.warn(
      "rules-lint",
      "Canonical rules store is empty — no rule files found across any rule root. Run `nax rules migrate` to seed the store.",
      { code: "EMPTY_STORE", roots: roots.length },
    );
  }

  if (failedRoots.length > 0) {
    const failedRootPaths = failedRoots.map((f) => f.root);
    throw new NaxError(
      `Failed to load canonical rules from ${failedRootPaths.length} rule root(s): ${failedRootPaths.join(", ")}`,
      "RULES_LINT_ROOT_FAILED",
      {
        stage: "rules-lint",
        failedRoots: failedRootPaths,
        causes: failedRoots.map((f) => (f.cause instanceof Error ? f.cause.message : String(f.cause))),
      },
    );
  }

  const scopeLabel = roots.length === 1 ? "repo root" : `${roots.length} rule roots`;
  if (warningCount > 0) {
    console.log(
      `[WARN] Canonical rules lint completed with ${warningCount} warning(s) (${totalRuleFiles} file(s) across ${scopeLabel}).`,
    );
  } else {
    console.log(`[OK] Canonical rules lint passed (${totalRuleFiles} file(s) across ${scopeLabel}).`);
  }
}
