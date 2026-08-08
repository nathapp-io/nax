/**
 * Canonical rules frontmatter parser (Phase 5.1)
 *
 * Parses --- delimited YAML frontmatter blocks from canonical rule files.
 * Validates frontmatter keys, types, and values.
 *
 * See: docs/specs/SPEC-context-engine-v2.md §Canonical rules delivery
 */

import { NaxError } from "@/errors";
import { STAGE_CONTEXT_MAP } from "../engine/stage-config";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const KNOWN_FRONTMATTER_KEYS = new Set(["priority", "paths", "appliesTo", "stages", "description"]);
export const FRONTMATTER_PRIORITY_DEFAULT = 100;

/**
 * Pipeline stage / operation names that are valid `stages:` entries but have
 * no entry in STAGE_CONTEXT_MAP (no custom per-stage context config).
 */
const EXTRA_KNOWN_STAGES = [
  "queue-check",
  "routing",
  "constitution",
  "prompt",
  "optimizer",
  "completion",
  "acceptance-setup",
  "regression",
  // Operation names (src/operations/*) recognised as stage identifiers
  "decompose",
];

/**
 * Known stage names for frontmatter `stages:` validation.
 *
 * Advisory-only — an unknown stage name emits a warning but does not reject the
 * rule. Derived from STAGE_CONTEXT_MAP keys (per-stage context config) plus
 * EXTRA_KNOWN_STAGES (pipeline stage names that lack custom context config),
 * so this set never drifts from the real stage registry.
 */
const KNOWN_VALID_STAGES = new Set([...Object.keys(STAGE_CONTEXT_MAP), ...EXTRA_KNOWN_STAGES]);

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
  description?: string;
  warnings?: string[];
}

export interface ParsedFrontmatter {
  content: string;
  priority: number;
  paths?: string[];
  appliesTo?: string[];
  stages?: string[];
  description?: string;
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser
// ─────────────────────────────────────────────────────────────────────────────

/** Strip one or more leading blank lines (CRLF or LF) from `content`. */
function stripLeadingBlankLines(content: string): string {
  let out = content;
  while (out.startsWith("\r\n") || out.startsWith("\n")) {
    out = out.startsWith("\r\n") ? out.slice(2) : out.slice(1);
  }
  return out;
}

export function parseFrontmatter(raw: string, filePath: string): ParsedFrontmatter {
  const warnings: string[] = [];
  let effectiveContent = raw;
  let displacedReason: string | undefined;

  // AC10: detect UTF-8 BOM before frontmatter opening delimiter
  if (raw.startsWith("\uFEFF")) {
    displacedReason = `Frontmatter is displaced — file begins with a UTF-8 BOM before '---' (${filePath})`;
    effectiveContent = raw.slice(1);
  }

  // AC11: detect leading blank line(s) before frontmatter opening delimiter
  const blankStripped = stripLeadingBlankLines(effectiveContent);
  if (blankStripped !== effectiveContent) {
    displacedReason ??= `Frontmatter is displaced — file begins with a blank line before '---' (${filePath})`;
    effectiveContent = blankStripped;
  }

  // AC15: strip one or more leading HTML comments (and the whitespace between
  // them) from the front, mirroring the BOM/blank-line precedent. We only
  // inspect what is *immediately* before the candidate '---' opening delimiter
  // — never scan further into the file, because Markdown horizontal rules
  // ('---') inside rule bodies would otherwise produce false positives.
  let strippedAnyComment = false;
  const strippedComments: string[] = [];
  while (effectiveContent.startsWith("<!--")) {
    const closeIdx = effectiveContent.indexOf("-->");
    if (closeIdx < 0) break;
    strippedComments.push(effectiveContent.slice(0, closeIdx + 3));
    effectiveContent = stripLeadingBlankLines(effectiveContent.slice(closeIdx + 3));
    strippedAnyComment = true;
  }
  let commentDisplacedReason: string | undefined;
  if (strippedAnyComment) {
    // Include the stripped HTML comment text in the warning so downstream
    // consumers (e.g. `nax rules lint`) can surface the actual offending
    // content alongside the file path. Concatenated with a single space so
    // multi-line comments stay on one log line.
    const commentsText = strippedComments.join(" ");
    commentDisplacedReason = `Frontmatter is displaced — file begins with an HTML comment before '---' (${filePath}): ${commentsText}`;
    displacedReason ??= commentDisplacedReason;
  }

  if (displacedReason && effectiveContent.startsWith("---")) {
    warnings.push(displacedReason);
  }

  // Per the story: HTML-comment-displaced frontmatter is detected and warned
  // about, but its declared priority / paths / appliesTo / stages are NOT
  // honored. The file resolves to FRONTMATTER_PRIORITY_DEFAULT and the body
  // content is preserved as-is. This matches the "parse result unchanged"
  // boundary called out in the story's Out-of-Scope section.
  if (commentDisplacedReason) {
    return { content: raw.trim(), priority: FRONTMATTER_PRIORITY_DEFAULT, warnings };
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
      `Canonical rule frontmatter declares unknown key(s): ${unknownKeys.join(", ")}. Only priority, paths, appliesTo, stages, and description are recognised.`,
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
    // AC3: empty list → undefined (falls through to the no-op below)
    if (stagesRaw.length > 0) {
      for (const v of stagesRaw) {
        if (typeof v !== "string" || !v.trim()) {
          throw new RulesFrontmatterError("frontmatter.stages must be a list containing only strings", filePath);
        }
      }
      stages = stagesRaw.map((v) => v.trim());
      // AC8/AC9: advisory warning for unknown stage names
      for (const s of stages) {
        if (!KNOWN_VALID_STAGES.has(s)) {
          warnings.push(`Unknown stage name "${s}" — rule will still load but may never be applied`);
        }
      }
    }
  }

  const descriptionRaw = doc.description;
  let description: string | undefined;
  if (descriptionRaw !== undefined) {
    if (typeof descriptionRaw !== "string") {
      throw new RulesFrontmatterError("frontmatter.description must be a string", filePath);
    }
    if (descriptionRaw.includes("\n") || descriptionRaw.includes("\r")) {
      throw new RulesFrontmatterError("frontmatter.description must be a single line", filePath);
    }
    const trimmed = descriptionRaw.trim();
    if (!trimmed) {
      throw new RulesFrontmatterError("frontmatter.description cannot be empty", filePath);
    }
    description = trimmed;
  }

  return {
    content: effectiveContent.slice(close[0].length).trim(),
    priority,
    ...(paths && { paths }),
    ...(appliesTo && { appliesTo }),
    ...(stages && { stages }),
    ...(description && { description }),
    warnings,
  };
}
