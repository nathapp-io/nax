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
import { NaxError } from "../../errors";
import { getLogger } from "../../logger";

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

interface BannedPattern {
  id: string;
  regex: RegExp;
  description: string;
}

const BANNED_PATTERNS: BannedPattern[] = [
  { id: "xml-tag", regex: /<system-reminder>|<ide_diagnostics>/i, description: "agent-specific XML tag" },
  { id: "claude-reference", regex: /CLAUDE\.md/, description: "agent-specific file reference CLAUDE.md" },
  { id: "codex-reference", regex: /AGENTS\.md/, description: "agent-specific file reference AGENTS.md" },
  { id: "gemini-reference", regex: /GEMINI\.md/, description: "agent-specific file reference GEMINI.md" },
  { id: "agent-directory", regex: /\.claude\/|\.codex\/|\.gemini\//, description: "agent-specific directory path" },
  {
    id: "tool-phrasing",
    regex: /\bthe [A-Za-z][A-Za-z0-9_-]* tool\b/i,
    description: "agent-specific tool-name phrasing",
  },
  { id: "important-shouting", regex: /\bIMPORTANT:/, description: "shouting-style IMPORTANT:" },
  { id: "emoji", regex: /\p{Extended_Pictographic}/u, description: "emoji character" },
];

const FRONTMATTER_PRIORITY_DEFAULT = 100;
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
    for (const { id, regex, description } of BANNED_PATTERNS) {
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

export class RulesFrontmatterError extends NaxError {
  constructor(message: string, filePath: string) {
    super(message, "RULES_FRONTMATTER_INVALID", {
      stage: "canonical-loader",
      filePath,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Loader
// ─────────────────────────────────────────────────────────────────────────────

export interface CanonicalRule {
  /** Rule identifier (relative path without extension, e.g. "frontend/style") */
  id?: string;
  /** Filename (e.g. "coding-style.md") */
  fileName: string;
  /** Relative path under .nax/rules (e.g. "frontend/style.md") */
  path?: string;
  /** Full content of the file */
  content: string;
  /** Approximate token count for this rule */
  tokens?: number;
  /** Priority for truncation/sorting (lower = more important) */
  priority?: number;
  /** Optional glob scopes that decide when this rule applies */
  appliesTo?: string[];
}

interface ParsedFrontmatter {
  content: string;
  priority: number;
  appliesTo?: string[];
}

function parseFrontmatter(raw: string, filePath: string): ParsedFrontmatter {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) {
    return { content: raw.trim(), priority: FRONTMATTER_PRIORITY_DEFAULT };
  }

  const close = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!close) {
    throw new RulesFrontmatterError("Canonical rule frontmatter is missing closing '---'", filePath);
  }

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(close[1] ?? "");
  } catch (err) {
    throw new RulesFrontmatterError(
      `Failed to parse YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
      filePath,
    );
  }

  if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
    throw new RulesFrontmatterError("Frontmatter must be a YAML object", filePath);
  }

  const doc = (parsed ?? {}) as Record<string, unknown>;
  const priorityRaw = doc.priority;
  let priority = FRONTMATTER_PRIORITY_DEFAULT;
  if (priorityRaw !== undefined) {
    if (typeof priorityRaw !== "number" || !Number.isFinite(priorityRaw)) {
      throw new RulesFrontmatterError("frontmatter.priority must be a number", filePath);
    }
    priority = Math.trunc(priorityRaw);
  }

  const appliesRaw = doc.appliesTo;
  let appliesTo: string[] | undefined;
  if (appliesRaw !== undefined) {
    if (typeof appliesRaw === "string") {
      const trimmed = appliesRaw.trim();
      if (!trimmed) throw new RulesFrontmatterError("frontmatter.appliesTo cannot be empty", filePath);
      appliesTo = [trimmed];
    } else if (Array.isArray(appliesRaw) && appliesRaw.every((v) => typeof v === "string" && v.trim())) {
      appliesTo = appliesRaw.map((v) => v.trim());
    } else {
      throw new RulesFrontmatterError("frontmatter.appliesTo must be a string or string[]", filePath);
    }
  }

  return {
    content: raw.slice(close[0].length).trim(),
    priority,
    ...(appliesTo && { appliesTo }),
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface CanonicalRulesBudgetResult {
  rules: CanonicalRule[];
  totalTokens: number;
  usedTokens: number;
  droppedCount: number;
}

/**
 * Apply tail-biased truncation using canonical ordering:
 * lower priority first, then rule id/path alphabetical.
 *
 * Rules that exceed budget are dropped from the tail so higher-priority rules
 * survive whenever possible.
 */
export function applyCanonicalRulesBudget(rules: CanonicalRule[], budgetTokens: number): CanonicalRulesBudgetResult {
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) {
    return {
      rules: [],
      totalTokens: rules.reduce((sum, r) => sum + (r.tokens ?? estimateTokens(r.content)), 0),
      usedTokens: 0,
      droppedCount: rules.length,
    };
  }

  const totalTokens = rules.reduce((sum, rule) => sum + (rule.tokens ?? estimateTokens(rule.content)), 0);
  let usedTokens = 0;
  const kept: CanonicalRule[] = [];

  for (const rule of rules) {
    const tokens = rule.tokens ?? estimateTokens(rule.content);
    if (usedTokens + tokens > budgetTokens) continue;
    kept.push(rule);
    usedTokens += tokens;
  }

  return {
    rules: kept,
    totalTokens,
    usedTokens,
    droppedCount: Math.max(0, rules.length - kept.length),
  };
}

export interface LoadCanonicalRulesOptions {
  /** Optional ceiling for loaded canonical rules. When omitted, no truncation is applied. */
  budgetTokens?: number;
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
      ...(parsed.appliesTo && { appliesTo: parsed.appliesTo }),
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

  logger.debug("canonical-loader", "Loaded canonical rules", {
    fileCount: rules.length,
    files: rules.map((r) => r.path),
  });

  if (options.budgetTokens === undefined) {
    return rules;
  }

  const budgetResult = applyCanonicalRulesBudget(rules, options.budgetTokens);
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
