/**
 * PRD JSON Validation and Schema Enforcement
 *
 * Validates and normalizes LLM-generated PRD JSON output before writing to disk.
 */

import type { Complexity, TestStrategy } from "../config";
import { resolveTestStrategy } from "../config/test-strategy";
import type { PRD, UserStory } from "./types";
import { validateStoryId } from "./validate";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_COMPLEXITY: Complexity[] = ["simple", "medium", "complex", "expert"];

/** Pattern matching ST001 → ST-001 style IDs (prefix letters + digits, no separator) */
const STORY_ID_NO_SEPARATOR = /^([A-Za-z]+)(\d+)$/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract JSON from a markdown code block.
 *
 * Handles:
 *   ```json ... ```
 *   ``` ... ```
 *
 * Returns the input unchanged if no code block is detected.
 */
export function extractJsonFromMarkdown(text: string): string {
  const match = text.match(/```(?:json)?\s*\n([\s\S]*?)\n?\s*```/);
  if (match) {
    return match[1] ?? text;
  }
  return text;
}

/**
 * Strip trailing commas before closing braces/brackets to handle a common LLM quirk.
 * e.g. `{"a":1,}` → `{"a":1}`
 */
function stripTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, "$1");
}

/**
 * Normalize a story ID: convert e.g. ST001 → ST-001.
 * Leaves IDs that already have separators unchanged.
 */
function normalizeStoryId(id: string): string {
  const match = id.match(STORY_ID_NO_SEPARATOR);
  if (match) {
    return `${match[1]}-${match[2]}`;
  }
  return id;
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
  const testStrategy: TestStrategy = resolveTestStrategy(
    typeof rawTestStrategy === "string" ? rawTestStrategy : undefined,
  );

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
    },
    ...(workdir !== undefined ? { workdir } : {}),
    ...(contextFiles.length > 0 ? { contextFiles } : {}),
  };
}

/**
 * Parse raw string input, handling markdown wrapping and trailing commas.
 * Throws with parse error context on failure.
 */
function parseRawString(text: string): unknown {
  const extracted = extractJsonFromMarkdown(text);
  const cleaned = stripTrailingCommas(extracted);

  try {
    return JSON.parse(cleaned);
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
