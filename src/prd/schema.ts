/**
 * PRD JSON Validation and Schema Enforcement
 *
 * Validates and normalizes LLM-generated PRD JSON output before writing to disk.
 */

import type { Complexity, TestStrategy } from "../config";
import { resolveTestStrategy } from "../config/test-strategy";
import { NaxError } from "../errors";
import { extractJsonFromMarkdown, extractJsonObject, stripTrailingCommas } from "../utils/llm-json";
export { extractJsonFromMarkdown };
import { normalizeOutOfScopeList } from "./out-of-scope";
import type { ContextFileEntry, ModifiedFileEntry, PRD, UserStory } from "./types";
import { validateStoryId } from "./validate";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_COMPLEXITY: Complexity[] = ["simple", "medium", "complex", "expert"];

/** Pattern matching ST001 → ST-001 style IDs (prefix letters + digits, no separator) */
const STORY_ID_NO_SEPARATOR = /^([A-Za-z]+)(\d+)$/;

/**
 * BUG-26 — gates the testStrategy auto-downgrade below (§ noTestJustification
 * present but testStrategy is not "no-test") on the justification text
 * actually explaining absent tests, not merely being non-empty. Without this,
 * a planner emitting testStrategy: "test-after" plus an unrelated stray note
 * in noTestJustification silently lost all test generation for the story.
 */
const NO_TEST_JUSTIFICATION_SIGNAL =
  /\b(no\s+(automated\s+)?test|not\s+testable|untestable|cannot\s+be\s+tested|can'?t\s+be\s+tested|skip(ping)?\s+test|no\s+test\s+coverage|manual(ly)?\s+(only|verif)|out\s+of\s+scope\s+for\s+test)/i;

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
function validateStory(raw: unknown, index: number, allIds: Set<string>, seenIds: Set<string>): UserStory {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new NaxError(`[schema] story[${index}] must be an object`, "SCHEMA_VALIDATION_FAILED", {
      stage: "schema",
      index,
    });
  }

  const s = raw as Record<string, unknown>;

  // id
  const rawId = s.id;
  if (rawId === undefined || rawId === null || rawId === "") {
    throw new NaxError(`[schema] story[${index}].id is required and must be non-empty`, "SCHEMA_VALIDATION_FAILED", {
      stage: "schema",
      index,
    });
  }
  if (typeof rawId !== "string") {
    throw new NaxError(`[schema] story[${index}].id must be a string`, "SCHEMA_VALIDATION_FAILED", {
      stage: "schema",
      index,
    });
  }
  const id = normalizeStoryId(rawId);
  validateStoryId(id);
  if (seenIds.has(id)) {
    throw new NaxError(
      `[schema] story[${index}].id "${id}" is a duplicate of an earlier story`,
      "SCHEMA_VALIDATION_FAILED",
      {
        stage: "schema",
        index,
        id,
      },
    );
  }
  seenIds.add(id);

  // title
  const title = s.title;
  if (!title || typeof title !== "string" || title.trim() === "") {
    throw new NaxError(`[schema] story[${index}].title is required and must be non-empty`, "SCHEMA_VALIDATION_FAILED", {
      stage: "schema",
      index,
    });
  }

  // description
  const description = s.description;
  if (!description || typeof description !== "string" || description.trim() === "") {
    throw new NaxError(
      `[schema] story[${index}].description is required and must be non-empty`,
      "SCHEMA_VALIDATION_FAILED",
      { stage: "schema", index },
    );
  }

  // acceptanceCriteria
  const ac = s.acceptanceCriteria;
  if (!Array.isArray(ac) || ac.length === 0) {
    throw new NaxError(
      `[schema] story[${index}].acceptanceCriteria is required and must be a non-empty array`,
      "SCHEMA_VALIDATION_FAILED",
      { stage: "schema", index },
    );
  }
  for (let i = 0; i < ac.length; i++) {
    if (typeof ac[i] !== "string") {
      throw new NaxError(
        `[schema] story[${index}].acceptanceCriteria[${i}] must be a string`,
        "SCHEMA_VALIDATION_FAILED",
        { stage: "schema", index, acIndex: i },
      );
    }
  }

  // suggestedCriteria — optional, if present must be non-empty string[]
  // Coerce {criterion, rationale} objects to plain strings (LLM sometimes emits this shape).
  let suggestedCriteria: string[] | undefined;
  if (s.suggestedCriteria !== undefined && s.suggestedCriteria !== null) {
    if (!Array.isArray(s.suggestedCriteria)) {
      throw new NaxError(
        `[schema] story[${index}].suggestedCriteria must be an array when present`,
        "SCHEMA_VALIDATION_FAILED",
        { stage: "schema", index },
      );
    }
    if (s.suggestedCriteria.length > 0) {
      const coerced: string[] = [];
      for (let i = 0; i < s.suggestedCriteria.length; i++) {
        const item = s.suggestedCriteria[i];
        if (typeof item === "string") {
          coerced.push(item);
        } else if (
          item !== null &&
          typeof item === "object" &&
          typeof (item as Record<string, unknown>).criterion === "string"
        ) {
          // LLM emitted {criterion, rationale} — extract the string criterion only
          coerced.push((item as Record<string, unknown>).criterion as string);
        } else {
          throw new NaxError(
            `[schema] story[${index}].suggestedCriteria[${i}] must be a string`,
            "SCHEMA_VALIDATION_FAILED",
            { stage: "schema", index, scIndex: i },
          );
        }
      }
      suggestedCriteria = coerced;
    }
    // empty array → stripped to undefined
  }

  // outOfScope — optional advisory exclusions; malformed entries are dropped, never fatal
  const storyOutOfScope = normalizeOutOfScopeList(s.outOfScope);

  // complexity — accept from routing.complexity (PRD format) or top-level complexity (legacy)
  const routing = typeof s.routing === "object" && s.routing !== null ? (s.routing as Record<string, unknown>) : {};
  const rawComplexity = routing.complexity ?? s.complexity;
  if (rawComplexity === undefined || rawComplexity === null) {
    throw new NaxError(
      `[schema] story[${index}] missing complexity. Set routing.complexity to one of: ${VALID_COMPLEXITY.join(", ")}`,
      "SCHEMA_VALIDATION_FAILED",
      { stage: "schema", index },
    );
  }
  if (typeof rawComplexity !== "string") {
    throw new NaxError(`[schema] story[${index}].routing.complexity must be a string`, "SCHEMA_VALIDATION_FAILED", {
      stage: "schema",
      index,
    });
  }
  const complexity = normalizeComplexity(rawComplexity);
  if (complexity === null) {
    throw new NaxError(
      `[schema] story[${index}].routing.complexity "${rawComplexity}" is invalid. Valid values: ${VALID_COMPLEXITY.join(", ")}`,
      "SCHEMA_VALIDATION_FAILED",
      { stage: "schema", index, rawComplexity },
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
      throw new NaxError(
        `[schema] story[${index}].routing.noTestJustification is required when testStrategy is "no-test"`,
        "SCHEMA_VALIDATION_FAILED",
        { stage: "schema", index },
      );
    }
  }

  // Auto-correct: noTestJustification present but testStrategy is not "no-test".
  // This happens when debate synthesis keeps the majority testStrategy but adopts
  // a minority debater's no-test justification. Resolve the contradiction by
  // downgrading to "no-test" — the justification is the stronger signal.
  //
  // BUG-26: gated on the justification text actually explaining absent tests
  // (NO_TEST_JUSTIFICATION_SIGNAL), not merely being non-empty — the
  // unconditional version downgraded on ANY stray note in this field,
  // silently discarding test generation for stories the planner correctly
  // marked as needing tests.
  if (
    testStrategy !== "no-test" &&
    typeof rawJustification === "string" &&
    rawJustification.trim() !== "" &&
    NO_TEST_JUSTIFICATION_SIGNAL.test(rawJustification)
  ) {
    testStrategy = "no-test";
  }
  const noTestJustification: string | undefined =
    typeof rawJustification === "string" && rawJustification.trim() !== "" ? rawJustification.trim() : undefined;

  // dependencies — normalize to match how IDs are stored/compared elsewhere, and dedup
  const rawDeps = s.dependencies;
  const dependencies: string[] = Array.isArray(rawDeps)
    ? Array.from(new Set((rawDeps as string[]).map((dep) => normalizeStoryId(dep))))
    : [];

  // Validate dependency references (against already-known IDs)
  for (const dep of dependencies) {
    if (!allIds.has(normalizeStoryId(dep))) {
      throw new NaxError(
        `[schema] story[${index}].dependencies references unknown story ID "${dep}"`,
        "SCHEMA_VALIDATION_FAILED",
        { stage: "schema", index, dep },
      );
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
      throw new NaxError(`[schema] story[${index}].workdir must be a string`, "SCHEMA_VALIDATION_FAILED", {
        stage: "schema",
        index,
      });
    }
    if (rawWorkdir.startsWith("/")) {
      throw new NaxError(
        `[schema] story[${index}].workdir must be relative (no leading /): "${rawWorkdir}"`,
        "SCHEMA_VALIDATION_FAILED",
        { stage: "schema", index, rawWorkdir },
      );
    }
    if (rawWorkdir.includes("..")) {
      throw new NaxError(
        `[schema] story[${index}].workdir must not contain '..': "${rawWorkdir}"`,
        "SCHEMA_VALIDATION_FAILED",
        { stage: "schema", index, rawWorkdir },
      );
    }
    workdir = rawWorkdir;
  }

  // contextFiles — optional array of relative file paths (string or {path, factId?} objects)
  const rawContextFiles = s.contextFiles;
  const contextFiles: Array<string | ContextFileEntry> = [];
  if (Array.isArray(rawContextFiles)) {
    for (const f of rawContextFiles as unknown[]) {
      if (typeof f === "string") {
        if (f.trim() === "") continue;
        if (f.startsWith("/")) {
          throw new NaxError(
            `[schema] story[${index}].contextFiles entry must be relative (no absolute paths): "${f}"`,
            "SCHEMA_VALIDATION_FAILED",
            { stage: "schema", index, filePath: f },
          );
        }
        if (f.includes("..")) {
          throw new NaxError(
            `[schema] story[${index}].contextFiles entry must not contain '..': "${f}"`,
            "SCHEMA_VALIDATION_FAILED",
            { stage: "schema", index, filePath: f },
          );
        }
        contextFiles.push(f);
      } else if (typeof f === "object" && f !== null && typeof (f as Record<string, unknown>).path === "string") {
        const obj = f as Record<string, unknown>;
        const path = (obj.path as string).trim();
        if (path === "") continue;
        if (path.startsWith("/")) {
          throw new NaxError(
            `[schema] story[${index}].contextFiles entry must be relative (no absolute paths): "${path}"`,
            "SCHEMA_VALIDATION_FAILED",
            { stage: "schema", index, filePath: path },
          );
        }
        if (path.includes("..")) {
          throw new NaxError(
            `[schema] story[${index}].contextFiles entry must not contain '..': "${path}"`,
            "SCHEMA_VALIDATION_FAILED",
            { stage: "schema", index, filePath: path },
          );
        }
        const entry: ContextFileEntry = { path };
        if (typeof obj.factId === "string" && obj.factId.length > 0) {
          entry.factId = obj.factId;
        }
        contextFiles.push(entry);
      }
      // Non-string, non-object entries are silently filtered (42, null, etc.)
    }
  }

  // expectedFiles — optional array of relative paths the story CREATES. Same
  // path rules as contextFiles, but plain strings only (no factId citations —
  // a file that does not exist yet cannot be grounded in the facts manifest).
  const rawExpectedFiles = s.expectedFiles;
  const expectedFiles: string[] = [];
  if (Array.isArray(rawExpectedFiles)) {
    for (const f of rawExpectedFiles as unknown[]) {
      if (typeof f !== "string") continue; // non-string entries silently filtered
      const trimmed = f.trim();
      if (trimmed === "") continue;
      if (trimmed.startsWith("/")) {
        throw new NaxError(
          `[schema] story[${index}].expectedFiles entry must be relative (no absolute paths): "${trimmed}"`,
          "SCHEMA_VALIDATION_FAILED",
          { stage: "schema", index, filePath: trimmed },
        );
      }
      if (trimmed.includes("..")) {
        throw new NaxError(
          `[schema] story[${index}].expectedFiles entry must not contain '..': "${trimmed}"`,
          "SCHEMA_VALIDATION_FAILED",
          { stage: "schema", index, filePath: trimmed },
        );
      }
      expectedFiles.push(trimmed);
    }
  }

  // modifiedFiles — optional list of EXISTING files this story is authorised to
  // change, each with the spec's reason. Same path rules as contextFiles.
  // Populated deterministically from the spec's `### Modifies` section rather
  // than by the planner (see ./modifies-extract), but validated here all the
  // same: a prd.json edited by hand reaches this path too.
  const rawModifiedFiles = s.modifiedFiles;
  const modifiedFiles: ModifiedFileEntry[] = [];
  if (Array.isArray(rawModifiedFiles)) {
    for (const f of rawModifiedFiles as unknown[]) {
      if (typeof f !== "object" || f === null) continue; // non-object entries silently filtered
      const obj = f as Record<string, unknown>;
      if (typeof obj.path !== "string") continue;
      const path = obj.path.trim();
      if (path === "") continue;
      if (path.startsWith("/")) {
        throw new NaxError(
          `[schema] story[${index}].modifiedFiles entry must be relative (no absolute paths): "${path}"`,
          "SCHEMA_VALIDATION_FAILED",
          { stage: "schema", index, filePath: path },
        );
      }
      if (path.includes("..")) {
        throw new NaxError(
          `[schema] story[${index}].modifiedFiles entry must not contain '..': "${path}"`,
          "SCHEMA_VALIDATION_FAILED",
          { stage: "schema", index, filePath: path },
        );
      }
      // An empty reason is legitimate — the spec author listed a bare path, and
      // an authorisation without a rationale still clears the deadlock.
      modifiedFiles.push({ path, reason: typeof obj.reason === "string" ? obj.reason.trim() : "" });
    }
  }

  // verifiedBy — optional citation anchor (Phase 2)
  const VALID_VERIFIED_BY_KINDS = ["test", "symbol", "file"] as const;
  type VerifiedByKind = (typeof VALID_VERIFIED_BY_KINDS)[number];
  let verifiedBy: UserStory["verifiedBy"];
  if (s.verifiedBy !== undefined && s.verifiedBy !== null) {
    const vb = s.verifiedBy as Record<string, unknown>;
    if (typeof vb.kind !== "string" || !(VALID_VERIFIED_BY_KINDS as readonly string[]).includes(vb.kind)) {
      throw new NaxError(
        `[schema] story[${index}].verifiedBy.kind "${vb.kind}" is invalid. Valid values: ${VALID_VERIFIED_BY_KINDS.join(", ")}`,
        "SCHEMA_VALIDATION_FAILED",
        { stage: "schema", index, kind: vb.kind },
      );
    }
    verifiedBy = {
      kind: vb.kind as VerifiedByKind,
      anchor: typeof vb.anchor === "string" ? vb.anchor : "",
      factIds: Array.isArray(vb.factIds) ? (vb.factIds as string[]).filter((id) => typeof id === "string") : [],
    };
  }

  // intent — optional boolean (Phase 2)
  const intent: boolean | undefined = typeof s.intent === "boolean" ? s.intent : undefined;

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
      reasoning:
        typeof routing.reasoning === "string" && routing.reasoning.trim().length > 0
          ? routing.reasoning.trim()
          : "validated from LLM output",
      ...(noTestJustification !== undefined ? { noTestJustification } : {}),
      ...(typeof routing.agentProfileId === "string" && routing.agentProfileId.trim().length > 0
        ? { agentProfileId: routing.agentProfileId.trim() }
        : {}),
    },
    ...(workdir !== undefined ? { workdir } : {}),
    ...(contextFiles.length > 0 ? { contextFiles } : {}),
    ...(expectedFiles.length > 0 ? { expectedFiles } : {}),
    ...(modifiedFiles.length > 0 ? { modifiedFiles } : {}),
    ...(suggestedCriteria !== undefined ? { suggestedCriteria } : {}),
    ...(storyOutOfScope !== undefined ? { outOfScope: storyOutOfScope } : {}),
    ...(verifiedBy !== undefined ? { verifiedBy } : {}),
    ...(intent !== undefined ? { intent } : {}),
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

  // Remove backslash before any character that is NOT a valid JSON escape char.
  // Valid: " \ / b f n r t u
  // Match valid \\ pairs first (to preserve them), then strip lone \ before invalid char.
  // Without the pair-first branch, \\( would corrupt to \( (invalid), because the regex
  // would match the second \ + ( after skipping the first \ + \ (which IS in the exclusion).
  result = result.replace(/(\\\\)|\\([^"\\\/bfnrtu])/g, (_, pair, bad) => pair ?? bad);

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
    throw new NaxError(`[schema] Failed to parse JSON: ${parseErr.message}`, "SCHEMA_VALIDATION_FAILED", {
      stage: "schema",
      cause: parseErr,
    });
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
    throw new NaxError("[schema] PRD output must be a JSON object", "SCHEMA_VALIDATION_FAILED", { stage: "schema" });
  }

  const obj = parsed as Record<string, unknown>;

  // Validate top-level userStories
  const rawStories = obj.userStories;
  if (!Array.isArray(rawStories) || rawStories.length === 0) {
    throw new NaxError("[schema] userStories is required and must be a non-empty array", "SCHEMA_VALIDATION_FAILED", {
      stage: "schema",
    });
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

  // Second pass: full validation. seenIds accumulates across the pass to reject
  // a story whose own id duplicates an earlier story's id (allIds already
  // contains every id up front, so it cannot be used to detect duplicates).
  const seenIds = new Set<string>();
  const userStories: UserStory[] = rawStories.map((story, index) => validateStory(story, index, allIds, seenIds));

  const now = new Date().toISOString();
  const featureOutOfScope = normalizeOutOfScopeList(obj.outOfScope);

  return {
    project: typeof obj.project === "string" && obj.project !== "" ? obj.project : feature,
    feature,
    branchName: branch,
    createdAt: typeof obj.createdAt === "string" ? obj.createdAt : now,
    updatedAt: now,
    userStories,
    ...(typeof obj.analysis === "string" && obj.analysis.trim() !== "" ? { analysis: obj.analysis.trim() } : {}),
    ...(featureOutOfScope !== undefined ? { outOfScope: featureOutOfScope } : {}),
  };
}
