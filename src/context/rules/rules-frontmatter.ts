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

export const KNOWN_FRONTMATTER_KEYS = new Set(["priority", "paths", "appliesTo"]);
export const FRONTMATTER_PRIORITY_DEFAULT = 100;

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
}

export interface ParsedFrontmatter {
  content: string;
  priority: number;
  paths?: string[];
  appliesTo?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser
// ─────────────────────────────────────────────────────────────────────────────

export function parseFrontmatter(raw: string, filePath: string): ParsedFrontmatter {
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
  const unknownKeys = Object.keys(doc).filter((key) => !KNOWN_FRONTMATTER_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new RulesFrontmatterError(
      `Canonical rule frontmatter declares unknown key(s): ${unknownKeys.join(", ")}. Only priority, paths, and appliesTo are recognised.`,
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

  return {
    content: raw.slice(close[0].length).trim(),
    priority,
    ...(paths && { paths }),
    ...(appliesTo && { appliesTo }),
  };
}
