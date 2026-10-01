/**
 * Per-field extractors backing `validateStory` (./schema-story.ts).
 *
 * Split out during the complexity drain (docs/plans/STATUS-complexity-drain.md
 * P0): `validateStory` scored 170 on Biome's cognitive-complexity check as one
 * function walking every field in sequence. Each extractor here owns exactly
 * one field (or tightly-coupled pair, e.g. testStrategy + noTestJustification)
 * and either returns the normalized value or throws the same `NaxError` the
 * monolith used to. A pure move: no validation rule changed.
 */

import type { Complexity, TestStrategy } from "../config";
import { resolveTestStrategy } from "../config/test-strategy";
import { NaxError } from "../errors";
import type { ContextFileEntry, ModifiedFileEntry, UserStory, WorkdirSource } from "./types";
import { validateStoryId } from "./validate";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_COMPLEXITY: Complexity[] = ["simple", "medium", "complex", "expert"];

const WORKDIR_SOURCES: readonly WorkdirSource[] = ["stated", "derived", "defaulted"];

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

const VALID_VERIFIED_BY_KINDS = ["test", "symbol", "file"] as const;
type VerifiedByKind = (typeof VALID_VERIFIED_BY_KINDS)[number];

function schemaError(message: string, index: number, extra: Record<string, unknown> = {}): NaxError {
  return new NaxError(`[schema] ${message}`, "SCHEMA_VALIDATION_FAILED", { stage: "schema", index, ...extra });
}

/**
 * Normalize a story ID: convert e.g. ST001 → ST-001.
 * Also strips markdown backtick wrapping (e.g. `US-001` → US-001) that LLMs
 * sometimes add for emphasis when writing directly to file in interactive plan mode.
 * Leaves IDs that already have separators unchanged.
 */
export function normalizeStoryId(id: string): string {
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

/** id — normalized, validated for path-safety, and checked for uniqueness. */
export function extractId(s: Record<string, unknown>, index: number, seenIds: Set<string>): string {
  const rawId = s.id;
  if (rawId === undefined || rawId === null || rawId === "") {
    throw schemaError(`story[${index}].id is required and must be non-empty`, index);
  }
  if (typeof rawId !== "string") {
    throw schemaError(`story[${index}].id must be a string`, index);
  }
  const id = normalizeStoryId(rawId);
  validateStoryId(id);
  if (seenIds.has(id)) {
    throw schemaError(`story[${index}].id "${id}" is a duplicate of an earlier story`, index, { id });
  }
  seenIds.add(id);
  return id;
}

/** title — required, non-blank, returned trimmed. */
export function extractTitle(s: Record<string, unknown>, index: number): string {
  const title = s.title;
  if (!title || typeof title !== "string" || title.trim() === "") {
    throw schemaError(`story[${index}].title is required and must be non-empty`, index);
  }
  return title.trim();
}

/** description — required, non-blank, returned trimmed. */
export function extractDescription(s: Record<string, unknown>, index: number): string {
  const description = s.description;
  if (!description || typeof description !== "string" || description.trim() === "") {
    throw schemaError(`story[${index}].description is required and must be non-empty`, index);
  }
  return description.trim();
}

/** acceptanceCriteria — required non-empty string array. */
export function extractAcceptanceCriteria(s: Record<string, unknown>, index: number): string[] {
  const ac = s.acceptanceCriteria;
  if (!Array.isArray(ac) || ac.length === 0) {
    throw schemaError(`story[${index}].acceptanceCriteria is required and must be a non-empty array`, index);
  }
  for (let i = 0; i < ac.length; i++) {
    if (typeof ac[i] !== "string") {
      throw schemaError(`story[${index}].acceptanceCriteria[${i}] must be a string`, index, { acIndex: i });
    }
  }
  return ac as string[];
}

/**
 * suggestedCriteria — optional, if present must be non-empty string[].
 * Coerces {criterion, rationale} objects to plain strings (LLM sometimes emits this shape).
 */
export function extractSuggestedCriteria(s: Record<string, unknown>, index: number): string[] | undefined {
  if (s.suggestedCriteria === undefined || s.suggestedCriteria === null) {
    return undefined;
  }
  if (!Array.isArray(s.suggestedCriteria)) {
    throw schemaError(`story[${index}].suggestedCriteria must be an array when present`, index);
  }
  if (s.suggestedCriteria.length === 0) {
    return undefined; // empty array → stripped to undefined
  }
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
      throw schemaError(`story[${index}].suggestedCriteria[${i}] must be a string`, index, { scIndex: i });
    }
  }
  return coerced;
}

/** routing.complexity — accepted from routing.complexity (PRD format) or top-level complexity (legacy). */
export function extractComplexity(
  s: Record<string, unknown>,
  index: number,
  routing: Record<string, unknown>,
): Complexity {
  const rawComplexity = routing.complexity ?? s.complexity;
  if (rawComplexity === undefined || rawComplexity === null) {
    throw schemaError(
      `story[${index}] missing complexity. Set routing.complexity to one of: ${VALID_COMPLEXITY.join(", ")}`,
      index,
    );
  }
  if (typeof rawComplexity !== "string") {
    throw schemaError(`story[${index}].routing.complexity must be a string`, index);
  }
  const complexity = normalizeComplexity(rawComplexity);
  if (complexity === null) {
    throw schemaError(
      `story[${index}].routing.complexity "${rawComplexity}" is invalid. Valid values: ${VALID_COMPLEXITY.join(", ")}`,
      index,
      { rawComplexity },
    );
  }
  return complexity;
}

export interface TestStrategyResult {
  testStrategy: TestStrategy;
  noTestJustification: string | undefined;
}

/**
 * testStrategy + noTestJustification — accepted from routing.* or top-level.
 * noTestJustification is required when testStrategy is "no-test", and (BUG-26)
 * a justification whose text signals absent tests auto-downgrades testStrategy
 * to "no-test" even when the planner set something else.
 */
export function extractTestStrategy(
  s: Record<string, unknown>,
  index: number,
  routing: Record<string, unknown>,
): TestStrategyResult {
  const rawTestStrategy = routing.testStrategy ?? s.testStrategy;
  let testStrategy: TestStrategy = resolveTestStrategy(
    typeof rawTestStrategy === "string" ? rawTestStrategy : undefined,
  );

  const rawJustification = routing.noTestJustification ?? s.noTestJustification;
  if (testStrategy === "no-test") {
    if (!rawJustification || typeof rawJustification !== "string" || rawJustification.trim() === "") {
      throw schemaError(
        `story[${index}].routing.noTestJustification is required when testStrategy is "no-test"`,
        index,
      );
    }
  }

  // Auto-correct: noTestJustification present but testStrategy is not "no-test".
  // Any LLM-authored PRD can populate the justification field while leaving
  // testStrategy set to something else — not specific to any one plan path.
  // Resolve the contradiction by downgrading to "no-test" — the justification
  // is the stronger signal. Gated (BUG-26) on the text actually explaining
  // absent tests, not merely being non-empty.
  if (
    testStrategy !== "no-test" &&
    typeof rawJustification === "string" &&
    rawJustification.trim() !== "" &&
    NO_TEST_JUSTIFICATION_SIGNAL.test(rawJustification)
  ) {
    testStrategy = "no-test";
  }
  const noTestJustification =
    typeof rawJustification === "string" && rawJustification.trim() !== "" ? rawJustification.trim() : undefined;

  return { testStrategy, noTestJustification };
}

/** dependencies — normalized to match how IDs are stored/compared elsewhere, deduped, and validated against allIds. */
export function extractDependencies(s: Record<string, unknown>, index: number, allIds: Set<string>): string[] {
  const rawDeps = s.dependencies;
  if (!Array.isArray(rawDeps)) {
    return [];
  }
  // BUG-9: LLM-authored PRD payloads can include non-string entries (numbers,
  // objects). Validate element types up front rather than letting
  // normalizeStoryId's String.prototype.replace throw a raw TypeError.
  for (const [i, dep] of rawDeps.entries()) {
    if (typeof dep !== "string") {
      throw schemaError(`story[${index}].dependencies[${i}] must be a string (got ${typeof dep})`, index, {
        depIndex: i,
        depType: typeof dep,
      });
    }
  }
  const dependencies = Array.from(new Set((rawDeps as string[]).map((dep: string) => normalizeStoryId(dep))));
  for (const dep of dependencies) {
    if (!allIds.has(normalizeStoryId(dep))) {
      throw schemaError(`story[${index}].dependencies references unknown story ID "${dep}"`, index, { dep });
    }
  }
  return dependencies;
}

/** tags — same BUG-9 element-type guard as dependencies. */
export function extractTags(s: Record<string, unknown>, index: number): string[] {
  const rawTags = s.tags;
  if (!Array.isArray(rawTags)) {
    return [];
  }
  for (const [i, tag] of rawTags.entries()) {
    if (typeof tag !== "string") {
      throw schemaError(`story[${index}].tags[${i}] must be a string (got ${typeof tag})`, index, {
        tagIndex: i,
        tagType: typeof tag,
      });
    }
  }
  return rawTags as string[];
}

/**
 * workdir — optional, relative path only, no traversal.
 * Sibling contextFiles/expectedFiles/modifiedFiles entries on this story are
 * REPO-ROOTED, not relative to this workdir (single-frame redesign, nax#2125).
 * This is a plan-WRITE-time contract enforced by findNonCanonicalDeclaredPaths
 * at the write seam (src/plan/strategies/persist-prd.ts), not here: PRD.parse()
 * must keep accepting a legacy or hand-edited PRD whose paths predate this
 * convention.
 */
export function extractWorkdir(s: Record<string, unknown>, index: number): string | undefined {
  const rawWorkdir = s.workdir;
  if (rawWorkdir === undefined || rawWorkdir === null) {
    return undefined;
  }
  if (typeof rawWorkdir !== "string") {
    throw schemaError(`story[${index}].workdir must be a string`, index);
  }
  if (rawWorkdir.startsWith("/")) {
    throw schemaError(`story[${index}].workdir must be relative (no leading /): "${rawWorkdir}"`, index, {
      rawWorkdir,
    });
  }
  if (rawWorkdir.includes("..")) {
    throw schemaError(`story[${index}].workdir must not contain '..': "${rawWorkdir}"`, index, { rawWorkdir });
  }
  return rawWorkdir;
}

/** workdirSource — optional provenance for `workdir` above (nax#2067). */
export function extractWorkdirSource(s: Record<string, unknown>, index: number): WorkdirSource | undefined {
  const rawWorkdirSource = s.workdirSource;
  if (rawWorkdirSource === undefined || rawWorkdirSource === null) {
    return undefined;
  }
  if (typeof rawWorkdirSource !== "string" || !WORKDIR_SOURCES.includes(rawWorkdirSource as WorkdirSource)) {
    throw schemaError(
      `story[${index}].workdirSource must be one of ${WORKDIR_SOURCES.join(" | ")}: ${JSON.stringify(rawWorkdirSource)}`,
      index,
    );
  }
  return rawWorkdirSource as WorkdirSource;
}

function checkRelativeNoTraversal(path: string, index: number, field: string): void {
  if (path.startsWith("/")) {
    throw schemaError(`story[${index}].${field} entry must be relative (no absolute paths): "${path}"`, index, {
      filePath: path,
    });
  }
  if (path.includes("..")) {
    throw schemaError(`story[${index}].${field} entry must not contain '..': "${path}"`, index, { filePath: path });
  }
}

/**
 * contextFiles — optional array of relative file paths (string or {path, factId?} objects).
 * Non-string, non-object entries are silently filtered (42, null, etc.).
 * Repo-rooted for any story canonicalized by nax plan (nax#2125); accepted here
 * regardless of frame — this validator only rejects malformed paths (absolute,
 * '..'), never an un-canonicalized one.
 */
export function extractContextFiles(s: Record<string, unknown>, index: number): Array<string | ContextFileEntry> {
  const rawContextFiles = s.contextFiles;
  const contextFiles: Array<string | ContextFileEntry> = [];
  if (!Array.isArray(rawContextFiles)) {
    return contextFiles;
  }
  for (const f of rawContextFiles as unknown[]) {
    if (typeof f === "string") {
      if (f.trim() === "") continue;
      checkRelativeNoTraversal(f, index, "contextFiles");
      contextFiles.push(f);
    } else if (typeof f === "object" && f !== null && typeof (f as Record<string, unknown>).path === "string") {
      const obj = f as Record<string, unknown>;
      const path = (obj.path as string).trim();
      if (path === "") continue;
      checkRelativeNoTraversal(path, index, "contextFiles");
      const entry: ContextFileEntry = { path };
      if (typeof obj.factId === "string" && obj.factId.length > 0) {
        entry.factId = obj.factId;
      }
      contextFiles.push(entry);
    }
  }
  return contextFiles;
}

/**
 * expectedFiles — optional array of relative paths the story CREATES. Same
 * path rules as contextFiles, but plain strings only (no factId citations —
 * a file that does not exist yet cannot be grounded in the facts manifest).
 * Repo-rooted for any story canonicalized by nax plan (nax#2125); accepted here
 * regardless of frame — this validator only rejects malformed paths (absolute,
 * '..'), never an un-canonicalized one.
 */
export function extractExpectedFiles(s: Record<string, unknown>, index: number): string[] {
  const rawExpectedFiles = s.expectedFiles;
  const expectedFiles: string[] = [];
  if (!Array.isArray(rawExpectedFiles)) {
    return expectedFiles;
  }
  for (const f of rawExpectedFiles as unknown[]) {
    if (typeof f !== "string") continue; // non-string entries silently filtered
    const trimmed = f.trim();
    if (trimmed === "") continue;
    checkRelativeNoTraversal(trimmed, index, "expectedFiles");
    expectedFiles.push(trimmed);
  }
  return expectedFiles;
}

/**
 * modifiedFiles — optional list of EXISTING files this story is authorised to
 * change, each with the spec's reason. Same path rules as contextFiles.
 * Populated deterministically from the spec's `### Modifies` section rather
 * than by the planner (see ./modifies-extract), but validated here all the
 * same: a prd.json edited by hand reaches this path too.
 */
export function extractModifiedFiles(s: Record<string, unknown>, index: number): ModifiedFileEntry[] {
  const rawModifiedFiles = s.modifiedFiles;
  const modifiedFiles: ModifiedFileEntry[] = [];
  if (!Array.isArray(rawModifiedFiles)) {
    return modifiedFiles;
  }
  for (const f of rawModifiedFiles as unknown[]) {
    if (typeof f !== "object" || f === null) continue; // non-object entries silently filtered
    const obj = f as Record<string, unknown>;
    if (typeof obj.path !== "string") continue;
    const path = obj.path.trim();
    if (path === "") continue;
    checkRelativeNoTraversal(path, index, "modifiedFiles");
    // An empty reason is legitimate — the spec author listed a bare path, and
    // an authorisation without a rationale still clears the deadlock.
    modifiedFiles.push({ path, reason: typeof obj.reason === "string" ? obj.reason.trim() : "" });
  }
  return modifiedFiles;
}

/** verifiedBy — optional citation anchor (Phase 2). */
export function extractVerifiedBy(s: Record<string, unknown>, index: number): UserStory["verifiedBy"] {
  if (s.verifiedBy === undefined || s.verifiedBy === null) {
    return undefined;
  }
  const vb = s.verifiedBy as Record<string, unknown>;
  if (typeof vb.kind !== "string" || !(VALID_VERIFIED_BY_KINDS as readonly string[]).includes(vb.kind)) {
    throw schemaError(
      `story[${index}].verifiedBy.kind "${vb.kind}" is invalid. Valid values: ${VALID_VERIFIED_BY_KINDS.join(", ")}`,
      index,
      { kind: vb.kind },
    );
  }
  return {
    kind: vb.kind as VerifiedByKind,
    anchor: typeof vb.anchor === "string" ? vb.anchor : "",
    factIds: Array.isArray(vb.factIds) ? (vb.factIds as string[]).filter((id) => typeof id === "string") : [],
  };
}
