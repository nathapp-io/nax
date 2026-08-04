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
import { loadCanonicalRules } from "../context/rules/canonical-loader";
import { getLogger } from "../logger";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

/** Cap on the dead-glob validation scan — mirrors MAX_CANONICAL_RULE_GLOB_FILES below. */
export const MAX_DEAD_GLOB_SCAN_FILES = 2000;

/** Cap on the package-overlay glob scan (monorepo-awareness.md §6). */
export const MAX_CANONICAL_RULE_GLOB_FILES = 500;

/** Directories that never legitimately contain a `.nax/rules` overlay root. */
export const CANONICAL_RULE_GLOB_EXCLUDE_SEGMENTS = ["/node_modules/", "/.git/"];

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
  globHasMatch: (pattern: string, cwd: string): boolean => {
    try {
      const regex = globToRegex(normalizePath(pattern));
      let scanned = 0;
      for (const file of new Bun.Glob("**/*").scanSync({ cwd, absolute: false, dot: true })) {
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Command
// ─────────────────────────────────────────────────────────────────────────────

export async function rulesLintCommand(options: RulesLintOptions, deps: RulesLintDeps = _rulesLintDeps): Promise<void> {
  const workdir = options.dir ?? process.cwd();
  const roots = collectCanonicalRuleRoots(workdir, deps.globCanonicalRuleFiles);
  const logger = deps.getLogger();

  let totalRuleFiles = 0;
  for (const root of roots) {
    const rules = await deps.loadCanonicalRules(root);
    totalRuleFiles += rules.length;
    for (const rule of rules) {
      for (const pattern of rule.appliesTo ?? []) {
        if (deps.globHasMatch(pattern, root)) continue;
        logger.warn("rules-lint", "Canonical rule appliesTo glob matches no files in the linted repository", {
          file: rule.path ?? rule.fileName,
          pattern,
          root,
        });
      }
    }
  }

  const scopeLabel = roots.length === 1 ? "repo root" : `${roots.length} rule roots`;
  console.log(`[OK] Canonical rules lint passed (${totalRuleFiles} file(s) across ${scopeLabel}).`);
}
