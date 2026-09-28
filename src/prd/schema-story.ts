/**
 * Per-story PRD validation.
 *
 * Extracted from ./schema.ts, which was 629 lines against the 600-line gate
 * (scripts/check-file-sizes.ts). A pure move: no logic changed.
 *
 * Field-level validation lives in ./schema-story-fields.ts (complexity drain
 * P0, docs/plans/STATUS-complexity-drain.md) — this file sequences those
 * extractors and assembles the returned UserStory. A pure extraction: no
 * validation rule changed.
 */

import { NaxError } from "../errors";
import { normalizeOutOfScopeList } from "./out-of-scope";
import {
  extractAcceptanceCriteria,
  extractComplexity,
  extractContextFiles,
  extractDependencies,
  extractDescription,
  extractExpectedFiles,
  extractId,
  extractModifiedFiles,
  extractSuggestedCriteria,
  extractTags,
  extractTestStrategy,
  extractTitle,
  extractVerifiedBy,
  extractWorkdir,
  extractWorkdirSource,
  normalizeStoryId,
} from "./schema-story-fields";
import type { UserStory } from "./types";

export { normalizeStoryId };

/**
 * Validate a single story from raw LLM output.
 * Returns a normalized UserStory or throws with field-level error.
 */
export function validateStory(raw: unknown, index: number, allIds: Set<string>, seenIds: Set<string>): UserStory {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new NaxError(`[schema] story[${index}] must be an object`, "SCHEMA_VALIDATION_FAILED", {
      stage: "schema",
      index,
    });
  }

  const s = raw as Record<string, unknown>;
  const routing = typeof s.routing === "object" && s.routing !== null ? (s.routing as Record<string, unknown>) : {};

  const id = extractId(s, index, seenIds);
  const title = extractTitle(s, index);
  const description = extractDescription(s, index);
  const acceptanceCriteria = extractAcceptanceCriteria(s, index);
  const suggestedCriteria = extractSuggestedCriteria(s, index);
  const storyOutOfScope = normalizeOutOfScopeList(s.outOfScope);
  const complexity = extractComplexity(s, index, routing);
  const { testStrategy, noTestJustification } = extractTestStrategy(s, index, routing);
  const dependencies = extractDependencies(s, index, allIds);
  const tags = extractTags(s, index);
  const workdir = extractWorkdir(s, index);
  const workdirSource = extractWorkdirSource(s, index);
  const contextFiles = extractContextFiles(s, index);
  const expectedFiles = extractExpectedFiles(s, index);
  const modifiedFiles = extractModifiedFiles(s, index);
  const verifiedBy = extractVerifiedBy(s, index);
  const intent: boolean | undefined = typeof s.intent === "boolean" ? s.intent : undefined;

  return {
    id,
    title,
    description,
    acceptanceCriteria,
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
    ...(workdirSource !== undefined ? { workdirSource } : {}),
    ...(contextFiles.length > 0 ? { contextFiles } : {}),
    ...(expectedFiles.length > 0 ? { expectedFiles } : {}),
    ...(modifiedFiles.length > 0 ? { modifiedFiles } : {}),
    ...(suggestedCriteria !== undefined ? { suggestedCriteria } : {}),
    ...(storyOutOfScope !== undefined ? { outOfScope: storyOutOfScope } : {}),
    ...(verifiedBy !== undefined ? { verifiedBy } : {}),
    ...(intent !== undefined ? { intent } : {}),
  };
}
