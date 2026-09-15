/**
 * `nax rules lint` CLI command (Phase 5.1)
 *
 * Validates canonical rules neutrality/frontmatter for the repository root
 * and any package-local `.nax/rules/` stores found under the workdir.
 *
 * See: docs/specs/SPEC-context-engine-v2.md §Canonical rules delivery
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { globToRegex, normalizePath } from "../context/engine";
import { CANONICAL_RULES_DIR, loadCanonicalRules } from "../context/rules/canonical-loader";
import { NaxError } from "../errors";
import { getLogger } from "../logger";
import { discoverWorkspacePackages } from "../test-runners";
import { isRelativeAndSafe } from "../utils/path-security";
import { byCodePoint } from "../utils/sort";

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

/**
 * Tri-state result of a dead-glob scan (#1471 follow-up).
 *
 * A capped scan that is truncated before completion cannot tell "no file
 * anywhere matches" from "no match found among the files examined so far" —
 * collapsing those two into a single `false` is exactly the false-positive
 * defect #1471 reopened against. `"unknown"` keeps them apart so the caller
 * never asserts a glob is dead on incomplete evidence.
 */
export type GlobMatchResult = "match" | "no-match" | "unknown";

/**
 * How a normalized `appliesTo` pattern was classified for #1471's scan
 * narrowing. A pattern with **no** wildcard segment anywhere is a literal
 * path, not a glob — it must be checked by direct existence, never walked.
 * Collapsing that case into "no literal prefix" (as an earlier version of
 * this fix did) sent it to the capped whole-tree fallback instead, which
 * both cannot ever assert a dead literal path (only "unknown") and costs a
 * full-repo walk for a live one — the exact fragility this fix removes for
 * every other case. `retry-strategy.md`'s `src/config/schemas-review.ts` and
 * `src/session/session-keeper.ts` are live examples of this shape.
 */
type PatternShape =
  | { kind: "literal-path"; path: string }
  | { kind: "prefixed"; prefix: string }
  | { kind: "no-prefix" };

/**
 * Classifies a normalized glob pattern by its leading literal path segments
 * (before the first segment containing a wildcard character) — e.g. `bin`
 * for `bin/*.ts`, `test` for `test/**\/*.test.ts`, and the whole pattern
 * as a literal path when it has no wildcard segment at all (e.g.
 * `src/config/schemas-review.ts`).
 *
 * Only `*` and `?` are wildcards under this repo's `globToRegex` — every
 * other character (including `[`, `]`, `{`, `}`) is matched literally, so
 * those don't end the prefix.
 */
function classifyPattern(normalizedPattern: string): PatternShape {
  const segments = normalizedPattern.split("/");
  const literal: string[] = [];
  for (const segment of segments) {
    if (/[*?]/.test(segment)) break;
    literal.push(segment);
  }
  if (literal.length === segments.length) return { kind: "literal-path", path: normalizedPattern };
  if (literal.length === 0) return { kind: "no-prefix" };
  return { kind: "prefixed", prefix: literal.join("/") };
}

/**
 * Resolves a fully-literal `appliesTo` pattern (no wildcard anywhere) by
 * direct existence check — no walk, no cap, so the result is always
 * definitive ("match"/"no-match"), never "unknown". `isRelativeAndSafe`
 * guards against a `..`-escaping or absolute pattern before it is joined
 * onto `cwd`; such a pattern can never legitimately match a repo-relative
 * scope file, so it is reported as "no-match" rather than resolved.
 *
 * Must accept only a regular file, not a directory: `scanTreeForMatch`'s
 * `Bun.Glob` walk defaults to `onlyFiles: true` and never yields a directory
 * entry, so a literal pattern naming a directory can never match a real
 * scope file at runtime either — reporting "match" on directory existence
 * would break the one-directional "lints as match ⇒ matches at runtime"
 * contract this module documents above `globHasMatch`.
 */
function matchLiteralPath(literalPath: string, cwd: string): GlobMatchResult {
  if (!isRelativeAndSafe(literalPath)) return "no-match";
  try {
    return statSync(join(cwd, literalPath)).isFile() ? "match" : "no-match";
  } catch {
    return "no-match";
  }
}

/**
 * Walks `scanRoot` (a subtree of `cwd`, or `cwd` itself when there is no
 * literal prefix) testing `regex` against each entry's path relative to
 * `cwd` (i.e. `prefix` re-joined onto the walked entry). Distinguishes a
 * scan that completed and found nothing ("no-match") from one truncated by
 * either cap before it could ("unknown") — see `GlobMatchResult`.
 */
function scanTreeForMatch(scanRoot: string, prefix: string, regex: RegExp): GlobMatchResult {
  let scanned = 0;
  let examined = 0;
  try {
    for (const file of new Bun.Glob("**/*").scanSync({ cwd: scanRoot, absolute: false, dot: true })) {
      if (examined >= MAX_DEAD_GLOB_SCAN_TOTAL_ENTRIES) return "unknown";
      examined++;
      const relPath = prefix ? `${prefix}/${file}` : file;
      const normalized = `/${normalizePath(relPath)}/`;
      if (DEAD_GLOB_SCAN_EXCLUDE_SEGMENTS.some((seg) => normalized.includes(seg))) continue;
      if (scanned >= MAX_DEAD_GLOB_SCAN_FILES) return "unknown";
      scanned++;
      if (regex.test(normalizePath(relPath))) return "match";
    }
    return "no-match";
  } catch {
    // The scan root doesn't exist (or can't be opened) — a literal-prefix
    // directory that isn't there genuinely has no matches under it.
    return "no-match";
  }
}

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
      return found.sort(byCodePoint);
    } catch {
      return [];
    }
  },
  // Deliberately reuses globToRegex/normalizePath — the SAME matcher
  // ruleMatchesScopeFiles (src/context/engine/providers/static-rules.ts) uses
  // at runtime — so a pattern that lints as "has matches" is guaranteed to
  // actually match at runtime.
  //
  // #1471: a fully-literal pattern (no wildcard anywhere) is checked by
  // direct existence — no walk, no cap, always definitive. A pattern with a
  // literal prefix directory (e.g. "bin/" for "bin/*.ts") scans only that
  // subtree, bounded and exact, with the cap never binding in the common
  // case. Only a pattern with no literal prefix at all (e.g. "*.md") falls
  // back to the capped whole-tree walk (backstop, not the primary mechanism).
  globHasMatch: (pattern: string, cwd: string): GlobMatchResult => {
    try {
      const normalizedPattern = normalizePath(pattern);
      const shape = classifyPattern(normalizedPattern);
      if (shape.kind === "literal-path") return matchLiteralPath(shape.path, cwd);
      const regex = globToRegex(normalizedPattern);
      if (shape.kind === "prefixed") return scanTreeForMatch(join(cwd, shape.prefix), shape.prefix, regex);
      return scanTreeForMatch(cwd, "", regex);
    } catch {
      return "no-match";
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
  globHasMatch: (pattern: string, cwd: string) => GlobMatchResult;
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
        const globResult = deps.globHasMatch(pattern, root);
        if (globResult === "match") continue;
        warningCount++;
        if (globResult === "unknown") {
          // #1471: cap-exhaustion is NOT evidence of a dead glob — it means
          // the scan gave up before finishing. Never fold this into the
          // dead-glob assertion below; that collapse is the bug this
          // tri-state exists to prevent.
          logger.warn(
            "rules-lint",
            "Canonical rule appliesTo glob could not be verified within the dead-glob scan cap",
            { file: rule.path ?? rule.fileName, pattern, root, code: "GLOB_SCAN_UNKNOWN" },
          );
          continue;
        }
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
        // Preserve the original errors (not just their messages) so the
        // stack traces and error identity survive — see error-handling.md
        // "Always chain errors with `cause: err` to preserve the original
        // error chain". Iterating callers can drill in with each `causes[i]`.
        causes: failedRoots.map((f) => f.cause),
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
