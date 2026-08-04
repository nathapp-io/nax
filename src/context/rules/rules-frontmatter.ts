/**
 * Canonical rules frontmatter parser (Phase 5.1)
 *
 * Parses --- delimited YAML frontmatter blocks from canonical rule files.
 * Validates frontmatter keys, types, and values.
 *
 * See: docs/specs/SPEC-context-engine-v2.md §Canonical rules delivery
 */

import { NaxError } from "@/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const KNOWN_FRONTMATTER_KEYS = new Set(["priority", "paths", "appliesTo", "stages"]);
export const FRONTMATTER_PRIORITY_DEFAULT = 100;

/**
 * Known stage names for frontmatter `stages:` validation.
 *
 * Advisory-only — an unknown stage name emits a warning but does not reject the
 * rule. This set combines STAGE_CONTEXT_MAP keys (per-stage context config) and
 * pipeline stage names that lack custom context config, so every real pipeline
 * stage is recognised.
 */
const KNOWN_VALID_STAGES = new Set([
  // STAGE_CONTEXT_MAP keys
  "context",
  "execution",
  "tdd-test-writer",
  "tdd-implementer",
  "tdd-verifier",
  "verify",
  "rectify",
  "review",
  "review-semantic",
  "review-adversarial",
  "autofix",
  "acceptance",
  "plan",
  "single-session",
  "tdd-simple",
  "no-test",
  "batch",
  "route",
  "review-dialogue",
  "debate",
  // Pipeline stage names NOT in STAGE_CONTEXT_MAP
  "queue-check",
  "routing",
  "constitution",
  "prompt",
  "optimizer",
  "completion",
  "acceptance-setup",
  "regression",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Error type
// ─────────────────────────────────────────────────────────────────────────────

export class RulesFrontmatterError extends NaxError {
  constructor(message: string, filePath: string) {
    super(message, "RULES_FRONTMATTER_INVALID", {
      stage: "canonical-loader",
      filePath,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface CanonicalRule {
  id?: string;
  fileName: string;
  path?: string;
  content: string;
  tokens?: number;
  priority?: number;
  paths?: string[];
  appliesTo?: string[];
  stages?: string[];
  warnings?: string[];
}

export interface ParsedFrontmatter {
  content: string;
  priority: number;
  paths?: string[];
  appliesTo?: string[];
  stages?: string[];
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser
// ─────────────────────────────────────────────────────────────────────────────

export function parseFrontmatter(raw: string, filePath: string): ParsedFrontmatter {
  const warnings: string[] = [];
  let effectiveContent = raw;

  // AC10: detect UTF-8 BOM before frontmatter opening delimiter
  if (raw.startsWith("\uFEFF")) {
    warnings.push(`Frontmatter is displaced — file begins with a UTF-8 BOM before '---' (${filePath})`);
    effectiveContent = raw.slice(1);
  }
  // AC11: detect leading blank line before frontmatter opening delimiter
  else if (raw.startsWith("\r\n")) {
    warnings.push(`Frontmatter is displaced — file begins with a blank line before '---' (${filePath})`);
    effectiveContent = raw.slice(2);
  } else if (raw.startsWith("\n")) {
    warnings.push(`Frontmatter is displaced — file begins with a blank line before '---' (${filePath})`);
    effectiveContent = raw.slice(1);
  }

  if (!effectiveContent.startsWith("---\n") && !effectiveContent.startsWith("---\r\n")) {
    return { content: raw.trim(), priority: FRONTMATTER_PRIORITY_DEFAULT, warnings };
  }

  const close = effectiveContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!close) {
    if (warnings.length > 0) {
      return { content: effectiveContent.trim(), priority: FRONTMATTER_PRIORITY_DEFAULT, warnings };
    }
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
  const unknownKeys = Object.keys(doc).filter((key) => !KNOWN_FRONTMATTER_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new RulesFrontmatterError(
      `Canonical rule frontmatter declares unknown key(s): ${unknownKeys.join(", ")}. Only priority, paths, appliesTo, and stages are recognised.`,
      filePath,
    );
  }

  const priorityRaw = doc.priority;
  let priority = FRONTMATTER_PRIORITY_DEFAULT;
  if (priorityRaw !== undefined) {
    if (typeof priorityRaw !== "number" || !Number.isFinite(priorityRaw)) {
      throw new RulesFrontmatterError("frontmatter.priority must be a number", filePath);
    }
    priority = Math.trunc(priorityRaw);
  }

  const pathsRaw = doc.paths;
  let paths: string[] | undefined;
  if (pathsRaw !== undefined) {
    if (typeof pathsRaw === "string") {
      const trimmed = pathsRaw.trim();
      if (!trimmed) throw new RulesFrontmatterError("frontmatter.paths cannot be empty", filePath);
      paths = [trimmed];
    } else if (Array.isArray(pathsRaw) && pathsRaw.every((v) => typeof v === "string" && v.trim())) {
      paths = pathsRaw.map((v) => v.trim());
    } else {
      throw new RulesFrontmatterError("frontmatter.paths must be a string or string[]", filePath);
    }
  }

  const appliesRaw = doc.appliesTo;
  let appliesTo: string[] | undefined;
  if (appliesRaw !== undefined) {
    if (Array.isArray(appliesRaw) && appliesRaw.every((v) => typeof v === "string" && v.trim())) {
      appliesTo = appliesRaw.map((v) => v.trim());
    } else {
      throw new RulesFrontmatterError("frontmatter.appliesTo must be a list of strings", filePath);
    }
  }

  // AC1-AC9: stages parsing with type validation and advisory warnings
  const stagesRaw = doc.stages;
  let stages: string[] | undefined;
  if (stagesRaw !== undefined) {
    // AC4: throws when stages is not an array of strings
    if (!Array.isArray(stagesRaw)) {
      throw new RulesFrontmatterError("frontmatter.stages must be a list of strings", filePath);
    }
    // AC3: empty list → undefined
    if (stagesRaw.length === 0) {
      stages = undefined;
    } else {
      for (const v of stagesRaw) {
        if (typeof v !== "string") {
          throw new RulesFrontmatterError("frontmatter.stages must be a list containing only strings", filePath);
        }
      }
      stages = stagesRaw as string[];
      // AC8/AC9: advisory warning for unknown stage names
      for (const s of stages) {
        if (!KNOWN_VALID_STAGES.has(s)) {
          warnings.push(`Unknown stage name "${s}" — rule will still load but may never be applied`);
        }
      }
    }
  }

  return {
    content: effectiveContent.slice(close[0].length).trim(),
    priority,
    ...(paths && { paths }),
    ...(appliesTo && { appliesTo }),
    ...(stages && { stages }),
    warnings,
  };
}
