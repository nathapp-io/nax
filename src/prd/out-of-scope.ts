/**
 * Feature-level out-of-scope preservation — deterministic scope-fidelity repair.
 *
 * A spec's `## Out of Scope` / `## Non-Goals` section states what the feature
 * deliberately does NOT do. Story-level `Scope — In: … Out: …` bullets in a
 * description express something different: *inter-story* boundaries ("that file
 * belongs to US-003"). Neither the PRD schema nor the plan prompt used to carry
 * the feature-level statement, so it was dropped at the spec→PRD boundary and
 * the implementer — which only ever sees the story object — had nothing telling
 * it which deferred arcs to stay away from.
 *
 * This module is the single source of truth for "what did the spec defer, and
 * did the PRD keep it, at the right level?". It is pure and deterministic — no
 * LLM, no I/O — so it can back the prompt rule, the `verify` backfill, and the
 * `plan-refine` self-heal turn without divergence. The prompt asks the planner
 * to emit `outOfScope`; {@link applyOutOfScopeFallback} guarantees the field
 * regardless of whether the planner complied, and
 * {@link demoteStoryScopedOutOfScope} un-does the opposite failure — a
 * story-local block the planner promoted to feature level.
 *
 * Spec parsing itself lives in `./out-of-scope-extract`.
 */

import {
  INLINE_MARKER,
  canonical,
  dedupeAndCap,
  extractSpecOutOfScope,
  extractStoryScopedOutOfScope,
} from "./out-of-scope-extract";
import type { StoryScopedExclusion } from "./out-of-scope-extract";
import type { PRD, UserStory } from "./types";

/**
 * Coerce a raw `outOfScope` value from LLM output into a clean string list.
 *
 * Tolerant by design — this field is advisory guidance, never a gate, so a
 * malformed entry is dropped rather than failing the whole plan. Non-arrays and
 * empty results collapse to `undefined` so the key is omitted from the PRD.
 */
export function normalizeOutOfScopeList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const strings = raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  const items = dedupeAndCap(strings.map((item) => item.trim()));
  return items.length > 0 ? items : undefined;
}

/**
 * An entry already scoped to one story by the spec author, per the spec-writing
 * guide's `US-00N only:` convention. Already correct — never demoted again.
 */
const STORY_ONLY_PREFIX = /^\s*US-\d+\s+only\s*:/i;

/**
 * Shortest canonical form long enough to match on. A two-word story-local
 * fragment would substring-match unrelated feature-level entries and demote
 * them, so a candidate below this length is left alone.
 */
const MIN_DEMOTION_MATCH_LENGTH = 16;

/** The story-scoped declaration a feature-level entry came from, if any. */
function hoistSource(
  entry: string,
  storyScoped: readonly StoryScopedExclusion[],
  featureLevel: readonly string[],
): StoryScopedExclusion | null {
  if (STORY_ONLY_PREFIX.test(entry)) return null;
  const key = canonical(entry.replace(INLINE_MARKER, ""));
  if (key.length < MIN_DEMOTION_MATCH_LENGTH) return null;
  // A statement the spec ALSO makes at feature level is feature-level, however
  // many stories restate it under their own AC block.
  if (featureLevel.some((item) => key.includes(item))) return null;
  return (
    storyScoped.find((item) => {
      const declared = canonical(item.text);
      if (declared.length < MIN_DEMOTION_MATCH_LENGTH) return false;
      // Either direction: the planner may expand the spec's wording or trim it.
      return key.includes(declared) || declared.includes(key);
    }) ?? null
  );
}

/**
 * Undo the planner's hoist of a *story-local* deferral to feature level (#1446).
 *
 * The prompt asks the planner to enumerate every `**Out of scope …:**` lead-in
 * in the spec, and it obliges for the ones under a story's AC block too. Those
 * then reach {@link propagateOutOfScopeToStories}, which copies the feature list
 * onto EVERY story — so one story's deferral becomes a waiver the adversarial
 * reviewer can cite to close a finding in a story it never covered.
 *
 * Each such entry is moved onto its owning story's own `outOfScope` (dropped
 * when no story owns it, or the owner is absent from the PRD — the statement is
 * story-scoped either way, and keeping it at feature level is the defect).
 * Returns the input PRD unchanged when nothing was hoisted.
 *
 * Runs before the backfill: {@link extractSpecOutOfScope} never yields
 * story-scoped items, so the two can never fight over the same statement.
 */
export function demoteStoryScopedOutOfScope(prd: PRD, specContent: string): PRD {
  const entries = prd.outOfScope ?? [];
  if (entries.length === 0) return prd;
  const storyScoped = extractStoryScopedOutOfScope(specContent);
  if (storyScoped.length === 0) return prd;

  const featureLevel = extractSpecOutOfScope(specContent).map(canonical);
  const demoted = new Map<string, string[]>();
  const kept: string[] = [];
  for (const entry of entries) {
    const source = hoistSource(entry, storyScoped, featureLevel);
    if (!source) {
      kept.push(entry);
      continue;
    }
    // The literal lead-in survives the hoist often enough to be a signal in its
    // own right; strip it so the demoted entry reads as a plain exclusion.
    const text = entry.replace(INLINE_MARKER, "").trim();
    if (!source.storyId || !text) continue;
    demoted.set(source.storyId, [...(demoted.get(source.storyId) ?? []), text]);
  }
  if (kept.length === entries.length) return prd;

  const userStories: UserStory[] = prd.userStories.map((story) => {
    const extra = demoted.get(story.id);
    return extra ? { ...story, outOfScope: dedupeAndCap([...(story.outOfScope ?? []), ...extra]) } : story;
  });
  return { ...prd, outOfScope: kept.length > 0 ? kept : undefined, userStories };
}

/**
 * Return the spec's out-of-scope statements the PRD dropped — those whose
 * canonical form is not a contiguous substring of any single `prd.outOfScope`
 * entry. An empty result means full preservation.
 *
 * `prd` is accepted as a partial so callers can pass a freshly parsed draft.
 */
export function findMissingOutOfScope(specContent: string, prd: Pick<PRD, "outOfScope">): string[] {
  const declared = extractSpecOutOfScope(specContent);
  if (declared.length === 0) return [];
  const present = (prd.outOfScope ?? []).map(canonical);
  return declared.filter((item) => !present.some((entry) => entry.includes(canonical(item))));
}

/**
 * Guarantee `prd.outOfScope` carries every statement the spec deferred.
 * The planner's own wording is kept and ordered first; only dropped items are
 * appended verbatim from the spec. Returns the input PRD unchanged (same
 * reference) when nothing is missing, so callers can cheaply detect a no-op.
 */
export function applyOutOfScopeFallback(prd: PRD, specContent: string): PRD {
  const missing = findMissingOutOfScope(specContent, prd);
  if (missing.length === 0) return prd;
  // Restored spec items lead: `dedupeAndCap` truncates the tail, and with the
  // planner's list first a planner that emitted MAX entries would push every
  // restored item off the end — the backfill would silently no-op while
  // reporting success.
  return { ...prd, outOfScope: dedupeAndCap([...missing, ...(prd.outOfScope ?? [])]) };
}

/**
 * Denormalize the feature-level list onto every story.
 *
 * The implementer, rectifier, and reviewers only ever receive a `UserStory` —
 * never the PRD envelope — so a root-only field would be invisible to them.
 * Story-level entries (a planner may add story-specific exclusions) keep their
 * position; feature-level items are merged in after, deduplicated on canonical
 * form. Returns the input PRD unchanged when there is nothing to propagate.
 */
export function propagateOutOfScopeToStories(prd: PRD): PRD {
  const featureLevel = prd.outOfScope ?? [];
  if (featureLevel.length === 0) return prd;

  // Feature-level entries come FIRST. `dedupeAndCap` truncates the tail, so
  // ordering decides who survives a story that already carries many exclusions:
  // the spec author's declared boundary must outrank planner-invented
  // story-specific ones. With story entries first, a story holding
  // MAX_OUT_OF_SCOPE_ITEMS of its own silently dropped every feature-level item —
  // exactly the statement this whole path exists to deliver.
  const userStories: UserStory[] = prd.userStories.map((story) => ({
    ...story,
    outOfScope: dedupeAndCap([...featureLevel, ...(story.outOfScope ?? [])]),
  }));
  return { ...prd, userStories };
}

/**
 * Inverse of {@link propagateOutOfScopeToStories} — drop from each story the
 * entries that merely mirror the feature-level list, keeping story-specific
 * ones. Applied before writing `prd.json` so the root field stays the single
 * source of truth on disk and the file does not repeat the same list N times.
 *
 * Propagate-then-strip is idempotent and preserves each story's *effective* set,
 * but is not byte-identical in one case: a story entry that duplicates a
 * feature-level one is absorbed into the root and not written back to the story.
 * That is intentional — the next `loadPRD` re-propagates it, so the story's
 * effective exclusions are unchanged and the file avoids a redundant copy.
 */
export function stripPropagatedOutOfScope(prd: PRD): PRD {
  const featureLevel = new Set((prd.outOfScope ?? []).map(canonical));
  if (featureLevel.size === 0) return prd;
  if (!prd.userStories.some((story) => (story.outOfScope ?? []).length > 0)) return prd;

  const userStories: UserStory[] = prd.userStories.map((story) => {
    const specific = (story.outOfScope ?? []).filter((item) => !featureLevel.has(canonical(item)));
    const { outOfScope: _dropped, ...rest } = story;
    return specific.length > 0 ? { ...rest, outOfScope: specific } : (rest as UserStory);
  });
  return { ...prd, userStories };
}
