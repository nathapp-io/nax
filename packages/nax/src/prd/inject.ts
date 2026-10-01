/**
 * Mid-Run Story Injection (INJECT queue command)
 *
 * Validates and normalizes an ad hoc UserStory input for injection into an
 * in-progress PRD. Deliberately stricter/simpler than validatePlanOutput's
 * per-story validation: an injected story has no routing metadata yet — the
 * routing pipeline stage classifies it (complexity/testStrategy) the first
 * time it's picked up into a batch, same as any other pending story.
 */

import { NaxError } from "../errors";
import type { UserStory } from "./types";
import { validateStoryId } from "./validate";

const STORY_ID_PREFIX = "US";

/**
 * Derive the next unused sequential story ID (e.g. "US-004") given the set of
 * IDs already present in the PRD. Falls back to scanning upward from 1 so it
 * never collides even if existing IDs have gaps.
 */
export function deriveNextStoryId(existingIds: ReadonlySet<string>): string {
  let n = 1;
  let candidate = `${STORY_ID_PREFIX}-${String(n).padStart(3, "0")}`;
  while (existingIds.has(candidate)) {
    n += 1;
    candidate = `${STORY_ID_PREFIX}-${String(n).padStart(3, "0")}`;
  }
  return candidate;
}

/**
 * Validate and normalize raw JSON input for the INJECT queue command into a
 * fresh, pending UserStory.
 *
 * Required: title, description, acceptanceCriteria (non-empty string array).
 * Optional: id (derived if absent), tags, dependencies (must reference
 * existing story IDs — a brand-new story cannot introduce a dependency
 * cycle since it can only depend on stories that already exist).
 *
 * @param raw - Parsed JSON object read from the INJECT target file
 * @param existingIds - IDs of every story currently in the PRD (for
 *   duplicate-ID rejection and dependency reference validation)
 */
export function validateInjectedStory(raw: unknown, existingIds: ReadonlySet<string>): UserStory {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new NaxError("[queue] INJECT story file must contain a JSON object", "SCHEMA_VALIDATION_FAILED", {
      stage: "queue",
    });
  }
  const s = raw as Record<string, unknown>;

  const title = s.title;
  if (!title || typeof title !== "string" || title.trim() === "") {
    throw new NaxError("[queue] INJECT story.title is required and must be non-empty", "SCHEMA_VALIDATION_FAILED", {
      stage: "queue",
    });
  }

  const description = s.description;
  if (!description || typeof description !== "string" || description.trim() === "") {
    throw new NaxError(
      "[queue] INJECT story.description is required and must be non-empty",
      "SCHEMA_VALIDATION_FAILED",
      { stage: "queue" },
    );
  }

  const ac = s.acceptanceCriteria;
  if (!Array.isArray(ac) || ac.length === 0) {
    throw new NaxError(
      "[queue] INJECT story.acceptanceCriteria is required and must be a non-empty array",
      "SCHEMA_VALIDATION_FAILED",
      { stage: "queue" },
    );
  }
  for (let i = 0; i < ac.length; i++) {
    if (typeof ac[i] !== "string") {
      throw new NaxError(`[queue] INJECT story.acceptanceCriteria[${i}] must be a string`, "SCHEMA_VALIDATION_FAILED", {
        stage: "queue",
        acIndex: i,
      });
    }
  }

  let id: string;
  if (s.id !== undefined && s.id !== null) {
    if (typeof s.id !== "string" || s.id.trim() === "") {
      throw new NaxError(
        "[queue] INJECT story.id must be a non-empty string when present",
        "SCHEMA_VALIDATION_FAILED",
        {
          stage: "queue",
        },
      );
    }
    id = s.id.trim();
    validateStoryId(id);
    if (existingIds.has(id)) {
      throw new NaxError(`[queue] INJECT story.id "${id}" already exists in the PRD`, "SCHEMA_VALIDATION_FAILED", {
        stage: "queue",
        storyId: id,
      });
    }
  } else {
    id = deriveNextStoryId(existingIds);
  }

  // BUG-9: validate element types BEFORE filtering. The previous implementation
  // silently `.filter(typeof t === "string")` which masked LLM payloads that
  // had numbers/objects in tags/dependencies — those entries just vanished and
  // the caller got a story with fewer tags than they sent. Throw a NaxError
  // matching the schema contract so authors know the payload is malformed.
  if (Array.isArray(s.tags)) {
    for (let i = 0; i < s.tags.length; i++) {
      if (typeof s.tags[i] !== "string") {
        throw new NaxError(
          `[queue] INJECT story.tags[${i}] must be a string (got ${typeof s.tags[i]})`,
          "SCHEMA_VALIDATION_FAILED",
          { stage: "queue", tagIndex: i, tagType: typeof s.tags[i] },
        );
      }
    }
  }
  if (Array.isArray(s.dependencies)) {
    for (let i = 0; i < s.dependencies.length; i++) {
      if (typeof s.dependencies[i] !== "string") {
        throw new NaxError(
          `[queue] INJECT story.dependencies[${i}] must be a string (got ${typeof s.dependencies[i]})`,
          "SCHEMA_VALIDATION_FAILED",
          { stage: "queue", depIndex: i, depType: typeof s.dependencies[i] },
        );
      }
    }
  }

  const tags: string[] = Array.isArray(s.tags) ? (s.tags as string[]) : [];

  const dependencies: string[] = Array.isArray(s.dependencies) ? (s.dependencies as string[]) : [];
  for (const dep of dependencies) {
    if (!existingIds.has(dep)) {
      throw new NaxError(
        `[queue] INJECT story.dependencies references unknown story ID "${dep}"`,
        "SCHEMA_VALIDATION_FAILED",
        { stage: "queue", dep },
      );
    }
  }

  return {
    id,
    title: title.trim(),
    description: description.trim(),
    acceptanceCriteria: ac as string[],
    tags,
    dependencies,
    status: "pending",
    passes: false,
    attempts: 0,
    escalations: [],
  };
}
