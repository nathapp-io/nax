/**
 * PRD JSON Validation and Schema Enforcement
 *
 * Validates and normalizes LLM-generated PRD JSON output before writing to disk.
 */

import type { Complexity, TestStrategy } from "../config";
import { resolveTestStrategy } from "../config/test-strategy";
import { extractJsonFromMarkdown, extractJsonObject, stripTrailingCommas } from "../utils/llm-json";
export { extractJsonFromMarkdown };
import type { PRD, UserStory } from "./types";
import { validateStoryId } from "./validate";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_COMPLEXITY: Complexity[] = ["simple", "medium", "complex", "expert"];

/** Pattern matching ST001 → ST-001 style IDs (prefix letters + digits, no separator) */
const STORY_ID_NO_SEPARATOR = /^([A-Za-z]+)(\d+)$/;

/**
 * Normalize a story ID: convert e.g. ST001 → ST-001.
 * Also strips markdown backtick wrapping (e.g. `US-001` → US-001) that LLMs
 * sometimes add for emphasis when writing directly to file in interactive plan mode.
 * Leaves IDs that already have separators unchanged.
 */
function normalizeStoryId(id: string): string {
  // Strip leading/trailing backticks (LLM markdown emphasis artifact)
  const stripped = id.replace(/^`+|`+$/g, "");
  const match = stripped.match(STORY_ID_NO_SEPARATOR);
  if (match) {
    return `${match[1]}-${match[2]}`;
  }
  return stripped;
}

/**
 * Normalize complexity string (case-insensitive) to a valid Complexity value.
 * Returns null if no match found.
 */
function normalizeComplexity(raw: string): Complexity | null {
  const lower = raw.toLowerCase() as Complexity;
  if ((VALID_COMPLEXITY as string[]).includes(lower)) {
    return lower;
  }
  return null;
}

/**
 * Validate a single story from raw LLM output.
 * Returns a normalized UserStory or throws with field-level error.
 */
function validateStory(raw: unknown, index: number, allIds: Set<string>): UserStory {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`[schema] story[${index}] must be an object`);
  }

  const s = raw as Record<string, unknown>;

  // id
  const rawId = s.id;
  if (rawId === undefined || rawId === null || rawId === "") {
    throw new Error(`[schema] story[${index}].id is required and must be non-empty`);
  }
  if (typeof rawId !== "string") {
    throw new Error(`[schema] story[${index}].id must be a string`);
  }
  const id = normalizeStoryId(rawId);
  validateStoryId(id);

  // title
  const title = s.title;
  if (!title || typeof title !== "string" || title.trim() === "") {
    throw new Error(`[schema] story[${index}].title is required and must be non-empty`);
  }

  // description
  const description = s.description;
  if (!description || typeof description !== "string" || description.trim() === "") {
    throw new Error(`[schema] story[${index}].description is required and must be non-empty`);
  }

  // acceptanceCriteria
  const ac = s.acceptanceCriteria;
  if (!Array.isArray(ac) || ac.length === 0) {
    throw new Error(`[schema] story[${index}].acceptanceCriteria is required and must be a non-empty array`);
  }
  for (let i = 0; i < ac.length; i++) {
    if (typeof ac[i] !== "string") {
      throw new Error(`[schema] story[${index}].acceptanceCriteria[${i}] must be a string`);
    }
  }

  // suggestedCriteria — optional, if present must be non-empty string[]
  let suggestedCriteria: string[] | undefined;
  if (s.suggestedCriteria !== undefined && s.suggestedCriteria !== null) {
    if (!Array.isArray(s.suggestedCriteria)) {
      throw new Error(`[schema] story[${index}].suggestedCriteria must be an array when present`);
    }
    if (s.suggestedCriteria.length > 0) {
      for (let i = 0; i < s.suggestedCriteria.length; i++) {
        if (typeof s.suggestedCriteria[i] !== "string") {
          throw new Error(`[schema] story[${index}].suggestedCriteria[${i}] must be a string`);
        }
      }
      suggestedCriteria = s.suggestedCriteria as string[];
    }
    // empty array → stripped to undefined
  }

  // complexity — accept from routing.complexity (PRD format) or top-level complexity (legacy)
  const routing = typeof s.routing === "object" && s.routing !== null ? (s.routing as Record<string, unknown>) : {};
  const rawComplexity = routing.complexity ?? s.complexity;
  if (rawComplexity === undefined || rawComplexity === null) {
    throw new Error(
      `[schema] story[${index}] missing complexity. Set routing.complexity to one of: ${VALID_COMPLEXITY.join(", ")}`,
    );
  }
  if (typeof rawComplexity !== "string") {
    throw new Error(`[schema] story[${index}].routing.complexity must be a string`);
  }
  const complexity = normalizeComplexity(rawComplexity);
  if (complexity === null) {
    throw new Error(
      `[schema] story[${index}].routing.complexity "${rawComplexity}" is invalid. Valid values: ${VALID_COMPLEXITY.join(", ")}`,
    );
  }

  // testStrategy — accept from routing.testStrategy or top-level testStrategy
  const rawTestStrategy = routing.testStrategy ?? s.testStrategy;
  let testStrategy: TestStrategy = resolveTestStrategy(
    typeof rawTestStrategy === "string" ? rawTestStrategy : undefined,
  );

  // noTestJustification — required when testStrategy is "no-test"
  const rawJustification = routing.noTestJustification ?? s.noTestJustification;
  if (testStrategy === "no-test") {
    if (!rawJustification || typeof rawJustification !== "string" || (rawJustification as string).trim() === "") {
      throw new Error(
        `[schema] story[${index}].routing.noTestJustification is required when testStrategy is "no-test"`,
      );
    }
  }

  // Auto-correct: noTestJustification present but testStrategy is not "no-test".
  // This happens when debate synthesis keeps the majority testStrategy but adopts
  // a minority debater's no-test justification. Resolve the contradiction by
  // downgrading to "no-test" — the justification is the stronger signal.
  if (testStrategy !== "no-test" && typeof rawJustification === "string" && rawJustification.trim() !== "") {
    testStrategy = "no-test";
  }
  const noTestJustification: string | undefined =
    typeof rawJustification === "string" && rawJustification.trim() !== "" ? rawJustification.trim() : undefined;

  // dependencies
  const rawDeps = s.dependencies;
  const dependencies: string[] = Array.isArray(rawDeps) ? (rawDeps as string[]) : [];

  // Validate dependency references (against already-known IDs)
  for (const dep of dependencies) {
    if (!allIds.has(dep)) {
      throw new Error(`[schema] story[${index}].dependencies references unknown story ID "${dep}"`);
    }
  }

  // tags
  const rawTags = s.tags;
  const tags: string[] = Array.isArray(rawTags) ? (rawTags as string[]) : [];

  // workdir — optional, relative path only, no traversal
  const rawWorkdir = s.workdir;
  let workdir: string | undefined;
  if (rawWorkdir !== undefined && rawWorkdir !== null) {
    if (typeof rawWorkdir !== "string") {
      throw new Error(`[schema] story[${index}].workdir must be a string`);
    }
    if (rawWorkdir.startsWith("/")) {
      throw new Error(`[schema] story[${index}].workdir must be relative (no leading /): "${rawWorkdir}"`);
    }
    if (rawWorkdir.includes("..")) {
      throw new Error(`[schema] story[${index}].workdir must not contain '..': "${rawWorkdir}"`);
    }
    workdir = rawWorkdir;
  }

  // contextFiles — optional array of relative file paths from LLM analysis
  const rawContextFiles = s.contextFiles;
  const contextFiles: string[] = Array.isArray(rawContextFiles)
    ? (rawContextFiles as unknown[]).filter((f): f is string => typeof f === "string" && f.trim() !== "")
    : [];

  return {
    id,
    title: title.trim(),
    description: description.trim(),
    acceptanceCriteria: ac as string[],
    tags,
    dependencies,
    // Force runtime state — never trust LLM output
    status: "pending",
    passes: false,
    attempts: 0,
    escalations: [],
    routing: {
      complexity,
      testStrategy,
      reasoning: "validated from LLM output",
      ...(noTestJustification !== undefined ? { noTestJustification } : {}),
    },
    ...(workdir !== undefined ? { workdir } : {}),
    ...(contextFiles.length > 0 ? { contextFiles } : {}),
    ...(suggestedCriteria !== undefined ? { suggestedCriteria } : {}),
  };
}

/**
 * Remove invalid escape sequences that LLMs commonly generate.
 *
 * JSON.parse only accepts:
 *   \"  \\  \/  \b  \f  \n  \r  \t  \uXXXX
 *
 * LLMs often produce:
 *   \xNN  → should be \u00NN
 *   \xN   → should be \u000N
 *   \x    → invalid, strip the backslash
 *   \uXXX → missing one digit, pad to \u0XXX
 *   \uXX  → missing two digits, pad to \u00XX
 *   \uX   → missing three digits, pad to \u000X
 *   \u    → no digits, strip the backslash
 *   \N    → any other backslash + non-special char, strip backslash
 */
function sanitizeInvalidEscapes(text: string): string {
  // \xNN or \xN: convert to \u00NN / \u000N
  // The first replace catches \x followed by 1–2 hex digits (possibly with non-hex following).
  // e.g. "\xAg" (invalid hex "g") → "\u00Ag" (still invalid but closer; JSON.parse throws)
  // e.g. "\xAxyz" → "\u000Axyz"
  let result = text.replace(/\\x([0-9a-fA-F]{1,2})/g, (_, hex) => `\\u00${hex.padStart(2, "0")}`);

  // \uXXXX (4 hex digits): valid, keep as-is
  // \uXXX / \uXX / \uX: pad with leading zeros when followed by non-hex or end-of-string
  result = result.replace(/\\u([0-9a-fA-F]{1,3})(?![0-9a-fA-F])/g, (_, digits) => `\\u${digits.padStart(4, "0")}`);
  result = result.replace(/\\u(?![0-9a-fA-F])/g, "\\");

  // Remove backslash before any character that is NOT a valid JSON escape char
  // Valid: " \ / b f n r t u
  result = result.replace(/\\([^"\\\/bfnrtu])/g, "$1");

  return result;
}

/**
 * Parse raw string input, handling markdown wrapping, trailing commas,
 * and common LLM-generated invalid escape sequences.
 * Throws with parse error context on failure.
 */
function parseRawString(text: string): unknown {
  // Pass 1: strip markdown code fence if present
  let extracted = extractJsonFromMarkdown(text);

  // Pass 2: if no fence was found (returned unchanged), try extracting the bare JSON
  // object/array by scanning for the first { or [ and last matching } or ].
  // This handles LLM output that wraps JSON in single backticks, adds preamble/postamble
  // text, or omits code fences entirely.
  if (extracted === text) {
    const bare = extractJsonObject(text);
    if (bare) extracted = bare;
  }

  const cleaned = stripTrailingCommas(extracted);
  const sanitized = sanitizeInvalidEscapes(cleaned);

  try {
    return JSON.parse(sanitized);
  } catch (err) {
    const parseErr = err as SyntaxError;
    throw new Error(`[schema] Failed to parse JSON: ${parseErr.message}`, { cause: parseErr });
  }
}

/**
 * Validate and normalize the JSON output from the planning LLM.
 *
 * @param raw - Raw LLM output (string or already-parsed object)
 * @param feature - Feature name for auto-fill
 * @param branch - Branch name for auto-fill
 * @returns Validated PRD object
 */
export function validatePlanOutput(raw: unknown, feature: string, branch: string): PRD {
  // Parse string input
  const parsed: unknown = typeof raw === "string" ? parseRawString(raw) : raw;

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("[schema] PRD output must be a JSON object");
  }

  const obj = parsed as Record<string, unknown>;

  // Validate top-level userStories
  const rawStories = obj.userStories;
  if (!Array.isArray(rawStories) || rawStories.length === 0) {
    throw new Error("[schema] userStories is required and must be a non-empty array");
  }

  // First pass: collect all story IDs (after normalization) for dependency validation
  const allIds = new Set<string>();
  for (const story of rawStories) {
    if (typeof story === "object" && story !== null && !Array.isArray(story)) {
      const s = story as Record<string, unknown>;
      const rawId = s.id;
      if (typeof rawId === "string" && rawId !== "") {
        allIds.add(normalizeStoryId(rawId));
      }
    }
  }

  // Second pass: full validation
  const userStories: UserStory[] = rawStories.map((story, index) => validateStory(story, index, allIds));

  const now = new Date().toISOString();

  return {
    project: typeof obj.project === "string" && obj.project !== "" ? obj.project : feature,
    feature,
    branchName: branch,
    createdAt: typeof obj.createdAt === "string" ? obj.createdAt : now,
    updatedAt: now,
    userStories,
    ...(typeof obj.analysis === "string" && obj.analysis.trim() !== "" ? { analysis: obj.analysis.trim() } : {}),
  };
}
