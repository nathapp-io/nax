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
      return [...new Bun.Glob("*.md").scanSync({ cwd: dir })].sort().map((f) => join(dir, f));
    } catch {
      return [];
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Neutrality linter
// ─────────────────────────────────────────────────────────────────────────────

interface BannedPattern {
  regex: RegExp;
  description: string;
}

const BANNED_PATTERNS: BannedPattern[] = [
  { regex: /<system-reminder>/i, description: "agent XML tag <system-reminder>" },
  { regex: /CLAUDE\.md/, description: "agent-specific file reference CLAUDE.md" },
  { regex: /\.claude\//, description: "agent-specific directory .claude/" },
  { regex: /\bthe [A-Za-z]+ tool\b/i, description: "agent-specific tool-name phrasing" },
  { regex: /\bIMPORTANT:/, description: "shouting-style IMPORTANT:" },
  { regex: /\p{Extended_Pictographic}/u, description: "emoji character" },
];

export interface NeutralityViolation {
  file: string;
  lineNumber: number;
  line: string;
  pattern: string;
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
    for (const { regex, description } of BANNED_PATTERNS) {
      if (regex.test(line)) {
        violations.push({
          file: fileName,
          lineNumber: i + 1,
          line: line.trim(),
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

// ─────────────────────────────────────────────────────────────────────────────
// Loader
// ─────────────────────────────────────────────────────────────────────────────

export interface CanonicalRule {
  /** Filename (e.g. "coding-style.md") */
  fileName: string;
  /** Full content of the file */
  content: string;
}

/**
 * Load all `.md` files from `.nax/rules/` under the given workdir.
 * Files are sorted alphabetically to ensure deterministic ordering.
 *
 * Throws NeutralityLintError if any file contains banned markers.
 * Returns an empty array if the `.nax/rules/` directory does not exist.
 */
export async function loadCanonicalRules(workdir: string): Promise<CanonicalRule[]> {
  const logger = getLogger();
  const rulesDir = join(workdir, CANONICAL_RULES_DIR);

  const filePaths = _canonicalLoaderDeps.globInDir(rulesDir);
  if (filePaths.length === 0) {
    return [];
  }

  const rules: CanonicalRule[] = [];
  const allViolations: NeutralityViolation[] = [];

  for (const filePath of filePaths) {
    const fileName = basename(filePath);
    let content: string;
    try {
      content = await _canonicalLoaderDeps.readFile(filePath);
    } catch {
      logger.warn("canonical-loader", "Failed to read rules file — skipping", {
        storyId: "_rules",
        file: filePath,
      });
      continue;
    }

    if (!content.trim()) continue;

    const violations = lintForNeutrality(content, fileName);
    if (violations.length > 0) {
      allViolations.push(...violations);
      continue; // collect all violations before throwing
    }

    rules.push({ fileName, content: content.trim() });
  }

  if (allViolations.length > 0) {
    throw new NeutralityLintError(allViolations);
  }

  logger.debug("canonical-loader", "Loaded canonical rules", {
    storyId: "_rules",
    fileCount: rules.length,
    files: rules.map((r) => r.fileName),
  });

  return rules;
}
