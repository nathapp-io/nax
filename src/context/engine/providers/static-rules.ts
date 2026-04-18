/**
 * Context Engine v2 — StaticRulesProvider
 *
 * Reads project-wide static rules and returns them as "static" kind chunks
 * with budget-floor guarantee.
 *
 * Phase 0: reads only CLAUDE.md (or equivalent agent config file).
 * Phase 5.1: reads from .nax/rules/ canonical store first. Falls back to
 *   CLAUDE.md / .cursorrules / AGENTS.md when allowLegacyClaudeMd is true
 *   and no canonical rules exist, emitting a deprecation warning.
 *
 * Chunks from this provider are always included in the push markdown
 * regardless of budget (floor behavior — see packing.ts).
 */

import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { getLogger } from "../../../logger";
import { errorMessage } from "../../../utils/errors";
import {
  DEFAULT_CANONICAL_RULES_BUDGET_TOKENS,
  applyCanonicalRulesBudget,
  loadCanonicalRules,
} from "../../rules/canonical-loader";
import type { CanonicalRule } from "../../rules/canonical-loader";
import type { ContextProviderResult, ContextRequest, IContextProvider, RawChunk } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

export const _staticRulesDeps = {
  readFile: async (path: string): Promise<string> => Bun.file(path).text(),
  fileExists: async (path: string): Promise<boolean> => Bun.file(path).exists(),
  globInDir: (dir: string): string[] => {
    try {
      return [...new Bun.Glob("**/*.md").scanSync({ cwd: dir, absolute: false })].sort().map((f) => join(dir, f));
    } catch {
      return [];
    }
  },
  loadCanonicalRules,
};

// ─────────────────────────────────────────────────────────────────────────────
// Legacy candidate files (Phase 0 / allowLegacyClaudeMd fallback)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Legacy static rules candidate file names, checked in order.
 * Only used when .nax/rules/ is absent and allowLegacyClaudeMd is true.
 */
const LEGACY_CANDIDATE_FILES = ["CLAUDE.md", ".cursorrules", "AGENTS.md"];
const LEGACY_RULES_DIR = ".claude/rules";

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

export interface StaticRulesProviderOptions {
  /**
   * Fall back to reading CLAUDE.md / .cursorrules / AGENTS.md when
   * .nax/rules/ is absent. Default: false — opt-in only.
   * Set true only during migration to the canonical .nax/rules/ store.
   */
  allowLegacyClaudeMd?: boolean;
  /** Token budget for static rules chunk emission. Default: 8192 */
  budgetTokens?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function contentHash8(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function canonicalRuleId(rule: CanonicalRule): string {
  return rule.id ?? rule.fileName.replace(/\.md$/i, "");
}

function canonicalRulePath(rule: CanonicalRule): string {
  return rule.path ?? rule.fileName;
}

function canonicalRulePriority(rule: CanonicalRule): number {
  return rule.priority ?? 100;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function globToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        const beforeSlash = i > 0 && pattern[i - 1] === "/";
        const afterSlash = pattern[i + 2] === "/";
        if (beforeSlash && afterSlash) {
          regex = `${regex.slice(0, -1)}(?:.*\\/)?`;
          i += 3;
        } else if (afterSlash) {
          regex += "(?:.*\\/)?";
          i += 3;
        } else {
          regex += ".*";
          i += 2;
        }
        continue;
      }
      regex += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      regex += "[^/]";
      i++;
      continue;
    }
    if (".+^${}()|[]\\".includes(c)) {
      regex += `\\${c}`;
    } else {
      regex += c;
    }
    i++;
  }
  return new RegExp(`(?:^|/)${regex}$`);
}

function ruleMatchesTouchedFiles(appliesTo: string[] | undefined, touchedFiles: string[] | undefined): boolean {
  if (!appliesTo || appliesTo.length === 0) return true;
  if (!touchedFiles || touchedFiles.length === 0) return true;

  const files = touchedFiles.map((f) => normalizePath(f));
  const patterns = appliesTo.map((p) => globToRegex(normalizePath(p)));
  return files.some((file) => patterns.some((pattern) => pattern.test(file)));
}

/**
 * Returns true when the rule's `paths:` frontmatter (package-scope filter) matches
 * the current package directory relative to the repo root.
 * Rules with no `paths:` field are global and always match.
 * Single-package repos (packageDir === repoRoot) always match regardless of paths.
 */
function ruleMatchesPackage(paths: string[] | undefined, repoRoot: string, packageDir: string): boolean {
  if (!paths || paths.length === 0) return true;
  if (packageDir === repoRoot) return true;

  const rel = normalizePath(relative(repoRoot, packageDir));
  const patterns = paths.map((p) => globToRegex(normalizePath(p)));
  // Also test rel + "/" so that "packages/api/**" matches the base dir "packages/api"
  return patterns.some((pattern) => pattern.test(rel) || pattern.test(`${rel}/`));
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

export class StaticRulesProvider implements IContextProvider {
  readonly id = "static-rules";
  readonly kind = "static" as const;

  private readonly allowLegacyClaudeMd: boolean;
  private readonly budgetTokens: number;

  constructor(options: StaticRulesProviderOptions = {}) {
    this.allowLegacyClaudeMd = options.allowLegacyClaudeMd ?? false;
    this.budgetTokens = options.budgetTokens ?? DEFAULT_CANONICAL_RULES_BUDGET_TOKENS;
  }

  async fetch(request: ContextRequest): Promise<ContextProviderResult> {
    const logger = getLogger();

    // Phase 5.1 + AC-57: try canonical store first, then overlay package rules if monorepo
    try {
      const repoRulesAll = await _staticRulesDeps.loadCanonicalRules(request.repoRoot);

      // Apply paths: frontmatter filter — repo-level rules with a paths: key only load for matching packages
      const repoRules = repoRulesAll.filter((rule) =>
        ruleMatchesPackage(rule.paths, request.repoRoot, request.packageDir),
      );

      if (repoRulesAll.length > 0 && repoRules.length < repoRulesAll.length) {
        logger.debug("static-rules", "Package-scope filter applied to repo-level rules", {
          storyId: request.storyId,
          total: repoRulesAll.length,
          matched: repoRules.length,
          packageDir: request.packageDir,
        });
      }

      // AC-57: in monorepos, load package-level rules and overlay (package wins on same fileName)
      let mergedRules: CanonicalRule[] = repoRules;
      let packageRulesCount = 0;
      if (request.packageDir !== request.repoRoot) {
        const packageRules = await _staticRulesDeps.loadCanonicalRules(request.packageDir);
        packageRulesCount = packageRules.length;
        if (packageRules.length > 0) {
          const merged = new Map<string, CanonicalRule>();
          for (const rule of repoRules) merged.set(canonicalRuleId(rule), rule);
          for (const rule of packageRules) merged.set(canonicalRuleId(rule), rule);
          mergedRules = [...merged.values()];
        }
      }

      mergedRules.sort(
        (a, b) =>
          canonicalRulePriority(a) - canonicalRulePriority(b) || canonicalRuleId(a).localeCompare(canonicalRuleId(b)),
      );

      // #558: rules exist but none apply to this package context — skip legacy fallback
      if (mergedRules.length === 0 && (repoRulesAll.length > 0 || packageRulesCount > 0)) {
        logger.warn("static-rules", "Canonical rules found but none apply to this package context", {
          storyId: request.storyId,
          repoRulesTotal: repoRulesAll.length,
          repoRulesMatchedPaths: repoRules.length,
          packageRulesCount,
          repoRoot: request.repoRoot,
          packageDir: request.packageDir,
        });
        return { chunks: [], pullTools: [] };
      }

      if (mergedRules.length > 0) {
        const scopedRules = mergedRules.filter((rule) => ruleMatchesTouchedFiles(rule.appliesTo, request.touchedFiles));
        const budgetResult = applyCanonicalRulesBudget(scopedRules, this.budgetTokens);
        if (budgetResult.totalTokens >= Math.floor(this.budgetTokens * 0.75)) {
          logger.warn("static-rules", "Canonical rules are approaching/exceeding static rules budget", {
            storyId: request.storyId,
            totalTokens: budgetResult.totalTokens,
            budgetTokens: this.budgetTokens,
            droppedCount: budgetResult.droppedCount,
          });
        }
        if (budgetResult.droppedCount > 0) {
          logger.warn("static-rules", "Canonical rules truncated by static rules budget", {
            storyId: request.storyId,
            totalTokens: budgetResult.totalTokens,
            usedTokens: budgetResult.usedTokens,
            budgetTokens: this.budgetTokens,
            droppedCount: budgetResult.droppedCount,
          });
        }

        const effectiveRules = budgetResult.rules;
        if (effectiveRules.length === 0) {
          logger.warn("static-rules", "No canonical rules fit in static rules budget", {
            storyId: request.storyId,
            budgetTokens: this.budgetTokens,
            totalScopedRules: scopedRules.length,
          });
          return { chunks: [], pullTools: [] };
        }
        const chunks = effectiveRules.map((rule) => {
          const hash = contentHash8(rule.content);
          const tokens = estimateTokens(rule.content);
          const ruleId = canonicalRuleId(rule);
          const rulePath = canonicalRulePath(rule);
          return {
            // Include fileName so two rules with identical content but different names
            // are not deduplicated by the packing stage (content-hash collision).
            id: `static-rules:${ruleId}:${hash}`,
            kind: "static" as const,
            scope: "project" as const,
            role: ["all"] as ["all"],
            content: `### ${rulePath}\n\n${rule.content}`,
            tokens,
            rawScore: 1.0,
          } satisfies RawChunk;
        });

        logger.debug("static-rules", "Loaded canonical rules", {
          storyId: request.storyId,
          fileCount: effectiveRules.length,
          totalCanonicalRules: mergedRules.length,
          files: effectiveRules.map((r) => canonicalRulePath(r)),
        });

        return { chunks, pullTools: [] };
      }
    } catch (err) {
      // NeutralityLintError or other loader error — propagate so the operator sees it
      logger.warn("static-rules", "Canonical rules loader failed", {
        storyId: request.storyId,
        error: errorMessage(err),
      });
      // Re-throw: linter violations must not silently fall back to legacy rules.
      throw err;
    }

    // No canonical rules found at repo or package level. Apply legacy fallback policy.
    if (!this.allowLegacyClaudeMd) {
      logger.warn("static-rules", "No canonical rules found at repo or package level — loading zero rules", {
        storyId: request.storyId,
        repoRoot: request.repoRoot,
        packageDir: request.packageDir,
      });
      return { chunks: [], pullTools: [] };
    }

    // allowLegacyClaudeMd: true — emit deprecation warning and fall back to legacy files
    logger.warn(
      "static-rules",
      "No canonical rules found at repo or package level — falling back to legacy rule files (deprecation warning). " +
        "Run `nax rules migrate` to create the canonical store.",
      {
        storyId: request.storyId,
        repoRoot: request.repoRoot,
        packageDir: request.packageDir,
      },
    );

    return this.fetchLegacy(request);
  }

  /**
   * Legacy Phase 0 path: reads the first of CLAUDE.md / .cursorrules / AGENTS.md.
   * Only called when .nax/rules/ is absent and allowLegacyClaudeMd is true.
   */
  private async fetchLegacy(request: ContextRequest): Promise<ContextProviderResult> {
    const logger = getLogger();
    const chunks: RawChunk[] = [];
    const rootDir = request.repoRoot;

    // Detect multiple candidates so operators know which one was chosen when more than one exists.
    const existingCandidates: string[] = [];
    for (const fileName of LEGACY_CANDIDATE_FILES) {
      try {
        if (await _staticRulesDeps.fileExists(join(rootDir, fileName))) {
          existingCandidates.push(fileName);
        }
      } catch {
        // ignore probe failures; the main loop will surface real errors.
      }
    }
    if (existingCandidates.length > 1) {
      logger.warn("static-rules", "Multiple legacy candidate files found — preferring the first in precedence order", {
        storyId: request.storyId,
        candidates: existingCandidates,
        chosen: existingCandidates[0],
      });
    }

    const legacySources: Array<{ sourceId: string; filePath: string; heading: string }> = [];

    for (const fileName of LEGACY_CANDIDATE_FILES) {
      legacySources.push({
        sourceId: fileName,
        filePath: join(rootDir, fileName),
        heading: fileName,
      });
    }

    const rulesDir = join(rootDir, LEGACY_RULES_DIR);
    const nestedRulePaths = _staticRulesDeps.globInDir(rulesDir);
    for (const filePath of nestedRulePaths) {
      const normalized = normalizePath(filePath);
      const rulesRoot = normalizePath(`${rulesDir}/`);
      const rel = normalized.startsWith(rulesRoot) ? normalized.slice(rulesRoot.length) : normalized;
      legacySources.push({
        sourceId: `${LEGACY_RULES_DIR}/${rel}`,
        filePath,
        heading: `${LEGACY_RULES_DIR}/${rel}`,
      });
    }

    for (const { sourceId, filePath, heading } of legacySources) {
      const fileName = heading;

      try {
        const exists = await _staticRulesDeps.fileExists(filePath);
        if (!exists) continue;

        const content = await _staticRulesDeps.readFile(filePath);
        if (!content.trim()) continue;

        const hash = contentHash8(content);
        const tokens = estimateTokens(content);

        chunks.push({
          id: `static-rules:legacy:${sourceId}:${hash}`,
          kind: "static",
          scope: "project",
          role: ["all"],
          content: `### ${heading}\n\n${content.trim()}`,
          tokens,
          rawScore: 1.0,
        });

        logger.debug("static-rules", "Loaded legacy static rules", {
          storyId: request.storyId,
          file: fileName,
          tokens,
        });
      } catch (err) {
        logger.warn("static-rules", `Failed to read ${fileName} — skipping`, {
          storyId: request.storyId,
          file: fileName,
          error: errorMessage(err),
        });
      }
    }

    return { chunks, pullTools: [] };
  }
}
