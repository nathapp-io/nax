/**
 * Context Engine v2 — Canonical Rules Loader (Phase 5.1)
 *
 * Reads `.nax/rules/*.md` files from a project's canonical rules store,
 * validates each file against the neutrality linter, and returns the
 * combined content as an ordered list of rule entries.
 *
 * Neutrality linter — banned markers:
 *   - <system-reminder>    agent-specific XML tag
 *   - CLAUDE.md            agent-specific file reference
 *   - .claude/             agent-specific directory
 *   - "the <Word> tool"    agent-specific tool-name phrasing
 *   - IMPORTANT:           shouting style
 *   - emoji                Unicode Extended_Pictographic characters
 *
 * Linter violations throw NeutralityLintError (code NEUTRALITY_LINT_FAILED),
 * which blocks the rules from loading. The operator must fix the offending
 * file and re-run. No silent pass-through.
 *
 * See: docs/specs/SPEC-context-engine-v2.md §Canonical rules delivery
 */

import { basename, join } from "node:path";
import { NaxError } from "@/errors";
import { getLogger } from "@/logger";

export {
  KNOWN_FRONTMATTER_KEYS,
  FRONTMATTER_PRIORITY_DEFAULT,
  RulesFrontmatterError,
  parseFrontmatter,
} from "./rules-frontmatter";
export type { CanonicalRule, ParsedFrontmatter } from "./rules-frontmatter";

import {
  type CanonicalRule,
  FRONTMATTER_PRIORITY_DEFAULT,
  KNOWN_FRONTMATTER_KEYS,
  RulesFrontmatterError,
  parseFrontmatter,
} from "./rules-frontmatter";

// storyId omission note: canonical-rules loading is a project-level operation
// that runs outside any story context (project-conventions.md §Logging scopes
// "pipeline/stages/ and review/" — this module is neither). Logger calls here
// intentionally omit storyId.

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Relative path of the canonical rules store within the project workdir. */
export const CANONICAL_RULES_DIR = ".nax/rules";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

export const _canonicalLoaderDeps = {
  readFile: async (path: string): Promise<string> => Bun.file(path).text(),
  globInDir: (dir: string): string[] => {
    try {
      const logger = getLogger();
      const files = [...new Bun.Glob("**/*.md").scanSync({ cwd: dir, absolute: false })].sort();
      const kept: string[] = [];
      const ignored: string[] = [];
      for (const rel of files) {
        const depth = rel.split("/").length - 1;
        if (depth <= 1) {
          kept.push(join(dir, rel));
        } else {
          ignored.push(rel);
        }
      }
      if (ignored.length > 0) {
        logger.warn("canonical-loader", "Ignoring canonical rule files deeper than one level", {
          ignoredCount: ignored.length,
          ignored: ignored.slice(0, 20),
        });
      }
      return kept;
    } catch {
      return [];
    }
  },
  getLogger,
};

// ─────────────────────────────────────────────────────────────────────────────
// Neutrality linter
// ─────────────────────────────────────────────────────────────────────────────

interface NeutralizeStep {
  /** Global regex applied across the full file content (not just one line). */
  pattern: RegExp;
  replacement: string;
}

interface NeutralityRule {
  id: string;
  /** Per-line test regex used by the linter — no /g flag (see lintForNeutrality). */
  regex: RegExp;
  description: string;
  /**
   * How `nax rules migrate` / `neutralizeContent` auto-fixes a match. Absent
   * for patterns with no safe automatic fix.
   */
  neutralizeSteps?: NeutralizeStep[];
}

/**
 * Single source of truth for what the neutrality linter bans AND how
 * `nax rules migrate` auto-fixes it. Previously `lintForNeutrality` (here)
 * and `neutralizeContent` (src/cli/rules.ts) maintained two independent
 * pattern tables that had drifted — migrate didn't neutralize AGENTS.md /
 * GEMINI.md / .codex/ / .gemini/ / <ide_diagnostics> references, and its
 * tool-phrasing match was case-sensitive on the first letter while the
 * linter's was not — so migrated content could still fail lint.
 */
export const NEUTRALITY_RULES: NeutralityRule[] = [
  {
    id: "xml-tag",
    regex: /<system-reminder>|<ide_diagnostics>/i,
    description: "agent-specific XML tag",
    neutralizeSteps: [
      { pattern: /<system-reminder>[\s\S]*?<\/system-reminder>/gi, replacement: "" },
      { pattern: /<system-reminder>/gi, replacement: "" },
      { pattern: /<ide_diagnostics>[\s\S]*?<\/ide_diagnostics>/gi, replacement: "" },
      { pattern: /<ide_diagnostics>/gi, replacement: "" },
    ],
  },
  {
    id: "claude-reference",
    regex: /CLAUDE\.md/,
    description: "agent-specific file reference CLAUDE.md",
    neutralizeSteps: [{ pattern: /CLAUDE\.md/g, replacement: "project conventions file" }],
  },
  {
    id: "codex-reference",
    regex: /AGENTS\.md/,
    description: "agent-specific file reference AGENTS.md",
    neutralizeSteps: [{ pattern: /AGENTS\.md/g, replacement: "project conventions file" }],
  },
  {
    id: "gemini-reference",
    regex: /GEMINI\.md/,
    description: "agent-specific file reference GEMINI.md",
    neutralizeSteps: [{ pattern: /GEMINI\.md/g, replacement: "project conventions file" }],
  },
  {
    id: "agent-directory",
    regex: /\.claude\/|\.codex\/|\.gemini\//,
    description: "agent-specific directory path",
    neutralizeSteps: [{ pattern: /\.claude\/|\.codex\/|\.gemini\//g, replacement: ".nax/rules/" }],
  },
  {
    id: "tool-phrasing",
    regex: /\bthe [A-Za-z][A-Za-z0-9_-]* tool\b/i,
    description: "agent-specific tool-name phrasing",
    neutralizeSteps: [{ pattern: /\bthe ([A-Za-z][A-Za-z0-9_-]*) tool\b/gi, replacement: "the $1 capability" }],
  },
  {
    id: "important-shouting",
    regex: /\bIMPORTANT:/,
    description: "shouting-style IMPORTANT:",
    neutralizeSteps: [{ pattern: /\bIMPORTANT:/g, replacement: "Note:" }],
  },
  {
    id: "emoji",
    regex: /\p{Extended_Pictographic}/u,
    description: "emoji character",
    neutralizeSteps: [{ pattern: /\p{Extended_Pictographic}/gu, replacement: "" }],
  },
];

export const DEFAULT_CANONICAL_RULES_BUDGET_TOKENS = 8_192;
const RULES_BUDGET_WARNING_RATIO = 0.75;
const RULE_ALLOW_MARKER = /<!--\s*nax-rules-allow:\s*([a-z0-9,\s-]+)\s*-->/gi;

export interface NeutralityViolation {
  file: string;
  lineNumber: number;
  line: string;
  ruleId: string;
  pattern: string;
}

function parseRuleAllowMarker(line: string): Set<string> {
  const allowed = new Set<string>();
  RULE_ALLOW_MARKER.lastIndex = 0;
  while (true) {
    const match = RULE_ALLOW_MARKER.exec(line);
    if (!match) break;
    const body = match[1] ?? "";
    for (const token of body.split(",")) {
      const id = token.trim().toLowerCase();
      if (id) allowed.add(id);
    }
  }
  return allowed;
}

/**
 * Lint a single file's content for neutrality violations.
 * Returns an array of violations (empty = clean).
 */
export function lintForNeutrality(content: string, fileName: string): NeutralityViolation[] {
  const violations: NeutralityViolation[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const allowList = parseRuleAllowMarker(line);
    for (const { id, regex, description } of NEUTRALITY_RULES) {
      if (allowList.has(id)) continue;
      if (regex.test(line)) {
        violations.push({
          file: fileName,
          lineNumber: i + 1,
          line: line.trim(),
          ruleId: id,
          pattern: description,
        });
        break; // one violation per line is enough to flag it
      }
    }
  }

  return violations;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown when one or more canonical rules files fail the neutrality linter.
 * The operator must fix the offending files before rules will load.
 */
export class NeutralityLintError extends NaxError {
  readonly violations: NeutralityViolation[];

  constructor(violations: NeutralityViolation[]) {
    const summary = violations
      .map((v) => `  ${v.file}:${v.lineNumber} — ${v.pattern}: "${v.line.slice(0, 80)}"`)
      .join("\n");
    super(`Canonical rules neutrality linter failed:\n${summary}`, "NEUTRALITY_LINT_FAILED", {
      stage: "canonical-loader",
      violationCount: violations.length,
    });
    this.violations = violations;
  }
}

// RulesFrontmatterError, CanonicalRule, ParsedFrontmatter, and parseFrontmatter
// are re-exported from ./rules-frontmatter.ts

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface CanonicalRulesBudgetResult {
  rules: CanonicalRule[];
  totalTokens: number;
  usedTokens: number;
  droppedCount: number;
  /**
   * `max(0, totalTokens - budgetTokens)` for valid thresholds. When the budget
   * is invalid (zero, negative, non-finite), `overageTokens` mirrors
   * `totalTokens` so callers can still report pressure without treating the
   * budget as a usable cap.
   */
  overageTokens: number;
}

export interface ApplyCanonicalRulesBudgetOptions {
  /**
   * When true, restore the legacy contiguous-tail truncation:
   * keep the longest leading priority-ordered run whose cumulative tokens
   * fit inside `budgetTokens`. When false (default), keep every supplied rule
   * and report pressure via `overageTokens` instead of dropping anything.
   */
  enforce?: boolean;
}

/**
 * Apply the canonical-rules budget to a priority-ordered rules array.
 *
 * In **soft mode** (`enforce` false / unset) the threshold is treated as a
 * reporting bound: every supplied rule is preserved, `usedTokens` equals
 * `totalTokens`, `droppedCount` is 0, and `overageTokens` is
 * `max(0, totalTokens - budgetTokens)`. Soft-by-default removes the legacy
 * silent truncation cliff for floor-kind rules — nothing downstream currently
 * enforces a ceiling on these chunks either, so the overage is reported, not
 * capped; `overageTokens` is the only signal a caller has that the corpus is
 * over budget.
 *
 * In **enforced mode** (`enforce` true) the legacy contiguous-tail
 * truncation is preserved: rules are processed in priority order, the first
 * rule that does not fit starts a dropped tail, and every following rule is
 * dropped as well so the result is the longest leading run that fits inside
 * `budgetTokens`.
 *
 * Invalid budgets (zero, negative, or non-finite `budgetTokens`) always
 * return an empty rules array regardless of `enforce`, matching the prior
 * contract for callers that probe the function without a usable threshold.
 */
export function applyCanonicalRulesBudget(
  rules: CanonicalRule[],
  budgetTokens: number,
  options: ApplyCanonicalRulesBudgetOptions = {},
): CanonicalRulesBudgetResult {
  const enforce = options.enforce === true;
  const totalTokens = rules.reduce((sum, r) => sum + (r.tokens ?? estimateTokens(r.content)), 0);

  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) {
    return {
      rules: [],
      totalTokens,
      usedTokens: 0,
      droppedCount: rules.length,
      overageTokens: totalTokens,
    };
  }

  if (!enforce) {
    return {
      rules: [...rules],
      totalTokens,
      usedTokens: totalTokens,
      droppedCount: 0,
      overageTokens: Math.max(0, totalTokens - budgetTokens),
    };
  }

  let usedTokens = 0;
  const kept: CanonicalRule[] = [];

  for (const rule of rules) {
    const tokens = rule.tokens ?? estimateTokens(rule.content);
    if (usedTokens + tokens > budgetTokens) break;
    kept.push(rule);
    usedTokens += tokens;
  }

  return {
    rules: kept,
    totalTokens,
    usedTokens,
    droppedCount: Math.max(0, rules.length - kept.length),
    overageTokens: Math.max(0, totalTokens - budgetTokens),
  };
}

export interface LoadCanonicalRulesOptions {
  /** Optional ceiling for loaded canonical rules. When omitted, no budget is applied. */
  budgetTokens?: number;
  /** Enforce `budgetTokens` via contiguous-tail truncation. Default false (soft/reporting-only). */
  enforce?: boolean;
}

/**
 * Load all `.md` files from `.nax/rules/` under the given workdir.
 * Files are sorted alphabetically to ensure deterministic ordering.
 *
 * Throws NeutralityLintError if any file contains banned markers.
 * Returns an empty array if the `.nax/rules/` directory does not exist.
 */
export async function loadCanonicalRules(
  workdir: string,
  options: LoadCanonicalRulesOptions = {},
): Promise<CanonicalRule[]> {
  const logger = _canonicalLoaderDeps.getLogger();
  const rulesDir = join(workdir, CANONICAL_RULES_DIR);

  const allFilePaths = _canonicalLoaderDeps.globInDir(rulesDir);
  const filePaths = allFilePaths.filter((filePath) => {
    const normalized = filePath.replaceAll("\\", "/");
    const normalizedRulesDir = rulesDir.replaceAll("\\", "/");
    const relativePath = normalized.startsWith(`${normalizedRulesDir}/`)
      ? normalized.slice(normalizedRulesDir.length + 1)
      : basename(normalized);
    return relativePath.split("/").length <= 2;
  });
  if (allFilePaths.length > filePaths.length) {
    logger.warn("canonical-loader", "Ignoring canonical rule files deeper than one level", {
      ignoredCount: allFilePaths.length - filePaths.length,
    });
  }
  if (filePaths.length === 0) {
    return [];
  }

  const rules: CanonicalRule[] = [];
  const allViolations: NeutralityViolation[] = [];

  for (const filePath of filePaths) {
    const normalizedPath = filePath.replaceAll("\\", "/");
    const normalizedRulesDir = rulesDir.replaceAll("\\", "/");
    const relativePath = normalizedPath.startsWith(`${normalizedRulesDir}/`)
      ? normalizedPath.slice(normalizedRulesDir.length + 1)
      : basename(normalizedPath);
    const fileName = basename(filePath);
    let content: string;
    try {
      content = await _canonicalLoaderDeps.readFile(filePath);
    } catch {
      logger.warn("canonical-loader", "Failed to read rules file — skipping", {
        file: filePath,
      });
      continue;
    }

    if (!content.trim()) continue;

    const parsed = parseFrontmatter(content, filePath);
    if (!parsed.content) continue;

    // AC14: emit each parser warning through the injectable logger for runtime visibility
    for (const warning of parsed.warnings) {
      logger.warn("canonical-loader", `Rule frontmatter warning: ${warning}`, { file: filePath });
    }

    const violations = lintForNeutrality(parsed.content, fileName);
    if (violations.length > 0) {
      allViolations.push(...violations);
      continue; // collect all violations before throwing
    }

    rules.push({
      id: relativePath.replace(/\.md$/i, ""),
      fileName,
      path: relativePath,
      content: parsed.content,
      tokens: estimateTokens(parsed.content),
      priority: parsed.priority,
      ...(parsed.paths && { paths: parsed.paths }),
      ...(parsed.appliesTo && { appliesTo: parsed.appliesTo }),
      ...(parsed.stages && { stages: parsed.stages }),
      ...(parsed.warnings.length > 0 && { warnings: parsed.warnings }),
    });
  }

  if (allViolations.length > 0) {
    throw new NeutralityLintError(allViolations);
  }

  rules.sort(
    (a, b) =>
      (a.priority ?? FRONTMATTER_PRIORITY_DEFAULT) - (b.priority ?? FRONTMATTER_PRIORITY_DEFAULT) ||
      (a.id ?? a.fileName).localeCompare(b.id ?? b.fileName),
  );

  logger.debug("canonical-loader", "Scanned canonical rules store", {
    fileCount: rules.length,
    files: rules.map((r) => r.path),
  });

  if (options.budgetTokens === undefined) {
    return rules;
  }

  const budgetResult = applyCanonicalRulesBudget(rules, options.budgetTokens, {
    enforce: options.enforce,
  });
  const warningThreshold = Math.floor(options.budgetTokens * RULES_BUDGET_WARNING_RATIO);
  if (budgetResult.totalTokens >= warningThreshold) {
    logger.warn("canonical-loader", "Canonical rules are approaching/exceeding budget", {
      fileCount: rules.length,
      totalTokens: budgetResult.totalTokens,
      budgetTokens: options.budgetTokens,
      warningThreshold,
      droppedCount: budgetResult.droppedCount,
    });
  }
  if (budgetResult.droppedCount > 0) {
    logger.warn("canonical-loader", "Canonical rules truncated by budget (tail-biased by priority)", {
      droppedCount: budgetResult.droppedCount,
      keptCount: budgetResult.rules.length,
      totalTokens: budgetResult.totalTokens,
      usedTokens: budgetResult.usedTokens,
      budgetTokens: options.budgetTokens,
    });
  }

  return budgetResult.rules;
}
