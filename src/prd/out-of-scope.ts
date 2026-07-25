/**
 * Feature-level out-of-scope preservation — deterministic scope-fidelity check.
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
 * did the PRD keep it?". It is pure and deterministic — no LLM, no I/O — so it
 * can back the prompt rule, the `verify` backfill, and the `plan-refine`
 * self-heal turn without divergence. The prompt asks the planner to emit
 * `outOfScope`; {@link applyOutOfScopeFallback} guarantees the field regardless
 * of whether the planner complied.
 *
 * ## Matching semantics
 *
 * Out-of-scope items are prose, not executable assertions, so — unlike
 * `[verbatim]` ACs — a planner is allowed to expand an item ("no Ink TUI" →
 * "no Ink TUI; deferred to arc 3"). An item counts as preserved when its
 * canonical form (whitespace collapsed, backticks stripped, lowercased) is a
 * contiguous substring of a single PRD entry. Anything else is treated as
 * dropped and is backfilled verbatim from the spec.
 */

import type { PRD, UserStory } from "./types";

/**
 * Upper bound on extracted items. A spec listing more than this has an
 * out-of-scope section that is really a design document; truncating keeps the
 * planner prompt and every downstream story prompt bounded.
 */
export const MAX_OUT_OF_SCOPE_ITEMS = 25;

/** `## Out of Scope`, `### Non-Goals`, `## Not in scope`, `## Out-of-scope`, … */
const OUT_OF_SCOPE_HEADING = /^(#{1,6})\s*(?:out[\s-]?of[\s-]?scope|non[\s-]?goals?|not[\s-]in[\s-]scope)\b/i;

/** Any markdown ATX heading, captured so section nesting can be compared. */
const ANY_HEADING = /^(#{1,6})\s/;

/**
 * A bold lead-in declaring deferred work inline, e.g.
 * `**Out of scope (deferred):** mid-phase resume`. The marker must be the first
 * thing on the line (after an optional bullet) so prose that merely says
 * "… is out of scope for this story" is never mistaken for a declaration.
 */
const INLINE_MARKER = /^\s*(?:[-*]\s*)?\*\*\s*(?:out[\s-]?of[\s-]?scope|non[\s-]?goals?)[^*]*\*\*\s*:?\s*/i;

/** A list item — used both to split bullets and to bound folded prose. */
const LIST_ITEM_START = /^\s*(?:[-*]|\d+\.)\s+/;

/** Collapse whitespace, strip backticks, lowercase — the comparison form. */
function canonical(text: string): string {
  return text.replace(/`/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Strip a leading `-`/`*`/`1.` bullet marker. */
function stripBullet(line: string): string {
  return line.replace(LIST_ITEM_START, "").trim();
}

/**
 * Lines belonging to the out-of-scope section that starts at `startIndex`.
 * The section ends at the next heading whose level is the same as or shallower
 * than the section heading's — a deeper sub-heading (e.g. `### Deferred arcs`
 * under `## Out of Scope`) is still part of the section.
 */
function sectionLines(lines: string[], startIndex: number, level: number): string[] {
  const collected: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    const heading = lines[i].match(ANY_HEADING);
    if (heading && heading[1].length <= level) break;
    if (heading) continue; // sub-heading inside the section — a label, not an item
    collected.push(lines[i]);
  }
  return collected;
}

/**
 * Split a section body into items: one per bullet (continuation lines folded
 * in), or — when the section has no bullets at all — one per prose paragraph.
 */
function itemsFromSection(body: string[]): string[] {
  const items: string[] = [];
  let current: string[] = [];
  const flush = () => {
    // An inline `**Out of scope:**` lead-in can also appear *inside* the section;
    // strip the redundant marker so the item dedupes against the same statement
    // written as a plain bullet.
    const text = current.join(" ").replace(INLINE_MARKER, "").replace(/\s+/g, " ").trim();
    if (text) items.push(text);
    current = [];
  };

  const hasBullets = body.some((line) => LIST_ITEM_START.test(line));
  for (const line of body) {
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    if (hasBullets && LIST_ITEM_START.test(line)) {
      flush();
      current.push(stripBullet(line));
      continue;
    }
    current.push(line.trim());
  }
  flush();
  return items;
}

/** One item per inline `**Out of scope …:**` lead-in, folded across wrapped lines. */
function itemsFromInlineMarkers(lines: string[]): string[] {
  const items: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!INLINE_MARKER.test(lines[i])) continue;
    const parts = [lines[i].replace(INLINE_MARKER, "").trim()];
    let j = i + 1;
    while (
      j < lines.length &&
      lines[j].trim().length > 0 &&
      !ANY_HEADING.test(lines[j]) &&
      !LIST_ITEM_START.test(lines[j])
    ) {
      parts.push(lines[j].trim());
      j += 1;
    }
    const text = parts.join(" ").replace(/\s+/g, " ").trim();
    if (text) items.push(text);
    i = j - 1;
  }
  return items;
}

/** Deduplicate on canonical form, keeping first-seen (spec) wording, then cap. */
function dedupeAndCap(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = canonical(item);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= MAX_OUT_OF_SCOPE_ITEMS) break;
  }
  return out;
}

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
 * Every feature-level out-of-scope statement declared by the spec, in document
 * order: bullets (or paragraphs) under an `## Out of Scope` / `## Non-Goals`
 * heading, plus any inline `**Out of scope …:**` lead-in.
 *
 * Scope / assumptions (deliberate — the downstream gate warns, never fails):
 * - A sub-heading inside the section is treated as a label, not an item; its
 *   bullets are still collected.
 * - Fenced code blocks inside the section are folded as prose. Out-of-scope
 *   sections holding code are vanishingly rare; write them as bullets.
 */
export function extractSpecOutOfScope(specContent: string): string[] {
  if (!specContent.trim()) return [];
  const lines = specContent.split("\n");

  const items: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(OUT_OF_SCOPE_HEADING);
    if (!heading) continue;
    items.push(...itemsFromSection(sectionLines(lines, i, heading[1].length)));
  }
  items.push(...itemsFromInlineMarkers(lines));

  return dedupeAndCap(items);
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
  return { ...prd, outOfScope: dedupeAndCap([...(prd.outOfScope ?? []), ...missing]) };
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

  const userStories: UserStory[] = prd.userStories.map((story) => ({
    ...story,
    outOfScope: dedupeAndCap([...(story.outOfScope ?? []), ...featureLevel]),
  }));
  return { ...prd, userStories };
}

/**
 * Inverse of {@link propagateOutOfScopeToStories} — drop from each story the
 * entries that merely mirror the feature-level list, keeping story-specific
 * ones. Applied before writing `prd.json` so the root field stays the single
 * source of truth on disk and the file does not repeat the same list N times.
 * Propagate-then-strip round-trips to the original PRD.
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
