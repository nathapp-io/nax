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

/** The section title itself, without heading syntax — `Out of Scope`, `Non-Goals`, … */
const OUT_OF_SCOPE_TITLE = /^(?:out[\s-]?of[\s-]?scope|non[\s-]?goals?|not[\s-]in[\s-]scope)\b/i;

/** `## Out of Scope`, `### Non-Goals`, `## Not in scope`, `## Out-of-scope`, … */
const OUT_OF_SCOPE_HEADING = /^(#{1,6})\s*(?:out[\s-]?of[\s-]?scope|non[\s-]?goals?|not[\s-]in[\s-]scope)\b/i;

/** Any markdown ATX heading, captured so section nesting can be compared. */
const ANY_HEADING = /^(#{1,6})\s/;

/** A fenced code block delimiter (``` or ~~~), with optional info string. */
const FENCE = /^\s*(?:```|~~~)/;

/** A markdown table separator row: `|---|:--:|`. Carries no content. */
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

/** A markdown table row. */
const TABLE_ROW = /^\s*\|.*\|\s*$/;

/** A setext underline — `===` (H1) or `---` (H2) beneath a title line. */
const SETEXT_UNDERLINE = /^\s*(?:=+|-+)\s*$/;

/**
 * Strip inline emphasis/backticks so heading matching is not defeated by
 * formatting. `## **Out of Scope**` and `## \`Out of Scope\`` are the same
 * heading as `## Out of Scope` — treating them differently silently drops the
 * entire section, which is the exact failure this module exists to prevent.
 */
function stripEmphasis(text: string): string {
  return text.replace(/\*\*/g, "").replace(/[*`_]/g, "");
}

/**
 * Heading level when `line` opens an out-of-scope section, else null.
 *
 * Accepts ATX (`## Out of Scope`, with optional emphasis and a trailing colon)
 * and setext (a bare title line underlined with `===`/`---`, which `nextLine`
 * supplies). Setext `=` is level 1, `-` is level 2 — matching CommonMark, so
 * section-end comparison against ATX levels stays correct.
 */
function outOfScopeHeadingLevel(line: string, nextLine: string | undefined): number | null {
  const atx = stripEmphasis(line).match(OUT_OF_SCOPE_HEADING);
  if (atx) return atx[1].length;

  if (nextLine !== undefined && SETEXT_UNDERLINE.test(nextLine)) {
    const title = stripEmphasis(line).trim().replace(/:$/, "");
    if (OUT_OF_SCOPE_TITLE.test(title)) return nextLine.trim().startsWith("=") ? 1 : 2;
  }
  return null;
}

/** True when `line` is a setext underline for the (non-blank) line before it. */
function isSetextUnderline(lines: string[], index: number): boolean {
  if (!SETEXT_UNDERLINE.test(lines[index])) return false;
  const prev = lines[index - 1];
  return prev !== undefined && prev.trim().length > 0 && !ANY_HEADING.test(prev);
}

/**
 * A bold lead-in declaring deferred work inline, e.g.
 * `**Out of scope (deferred):** mid-phase resume`. The marker must be the first
 * thing on the line (after an optional bullet) so prose that merely says
 * "… is out of scope for this story" is never mistaken for a declaration.
 */
const INLINE_MARKER = /^\s*(?:[-*]\s*)?\*\*\s*(?:out[\s-]?of[\s-]?scope|non[\s-]?goals?)[^*]*\*\*\s*:?\s*/i;

/** A list item — used both to split bullets and to bound folded prose. */
const LIST_ITEM_START = /^\s*(?:[-*+\u2022\u2023\u25E6\u2043\u2219]|\d+\.)\s+/;

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
  let inFence = false;

  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code inside an out-of-scope section is illustrative, never an
    // exclusion. Folding it as prose would inject a garbage entry that is then
    // propagated onto every story prompt.
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // A deeper heading (`### Deferred arcs` under `## Out of Scope`) is a label
    // inside the section, so its bullets still count. The `level === 1` guard is
    // a safety rail: when the section heading is H1, *every* other section in the
    // document nests under it, and folding the whole file into the exclusion list
    // would push it into every story prompt. Over-capture is the dangerous
    // direction here, so an H1 section ends at the first heading of any depth.
    const heading = line.match(ANY_HEADING);
    if (heading && (heading[1].length <= level || level === 1)) break;
    // A deeper sub-heading is a label, but it still separates the items around
    // it — without this blank line two prose exclusions under adjacent
    // sub-headings would fold into one entry (and one `scopeIndex`).
    if (heading) {
      collected.push("");
      continue;
    }

    // A setext underline ends the section when it belongs to a following title
    // (that title is the next section's heading, and the title line itself was
    // already collected — drop it).
    if (isSetextUnderline(lines, i)) {
      const setextLevel = line.trim().startsWith("=") ? 1 : 2;
      if (setextLevel <= level) {
        collected.pop();
        break;
      }
      collected.pop();
      continue; // deeper sub-heading — a label, same as the ATX case
    }

    collected.push(line);
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
  for (const [index, line] of body.entries()) {
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    // A row immediately followed by a separator is the table header — column
    // labels, not an exclusion.
    if (TABLE_ROW.test(line) && TABLE_SEPARATOR.test(body[index + 1] ?? "")) continue;
    // Tables are a common way to write "deferred item | reason". Each data row is
    // one exclusion; keeping the pipes would turn the whole table into a single
    // unreadable entry, and skipping tables outright would drop the section when
    // the table IS the content.
    if (TABLE_SEPARATOR.test(line)) continue;
    if (TABLE_ROW.test(line)) {
      flush();
      const cells = line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      if (cells.length > 0) current.push(cells.join(" — "));
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

/**
 * Indices of every line inside a fenced code block.
 *
 * Fenced content is illustrative — a spec documenting markdown (which spec-kit
 * specs routinely do) contains a literal `## Out of Scope` example. Treating it
 * as a real declaration fabricates an exclusion that is then backfilled into the
 * PRD, pushed onto every story, and rendered to the implementer as a hard
 * boundary. Every scan over raw lines must consult this.
 */
function fencedLineIndices(lines: string[]): Set<number> {
  const fenced = new Set<number>();
  let inFence = false;
  for (const [i, line] of lines.entries()) {
    if (FENCE.test(line)) {
      fenced.add(i);
      inFence = !inFence;
      continue;
    }
    if (inFence) fenced.add(i);
  }
  return fenced;
}

/**
 * One item per inline `**Out of scope …:**` lead-in.
 *
 * Two shapes, both common:
 * - Text on the same line, folded across wrapped prose lines.
 * - A bare marker followed by a bullet list — the single most common idiom.
 *   Handled explicitly because the prose fold stops at the first list item,
 *   which previously left the marker empty and the bullets claimed by nobody.
 */
function itemsFromInlineMarkers(lines: string[], fenced: Set<number>): string[] {
  const items: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (fenced.has(i) || !INLINE_MARKER.test(lines[i])) continue;

    const remainder = lines[i].replace(INLINE_MARKER, "").trim();
    let j = i + 1;

    if (remainder.length === 0) {
      // Bare marker — consume the bullet list (or prose block) beneath it.
      const body: string[] = [];
      while (j < lines.length && !fenced.has(j) && lines[j].trim().length > 0 && !ANY_HEADING.test(lines[j])) {
        body.push(lines[j]);
        j += 1;
      }
      items.push(...itemsFromSection(body));
      i = j - 1;
      continue;
    }

    const parts = [remainder];
    while (
      j < lines.length &&
      !fenced.has(j) &&
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

  const fenced = fencedLineIndices(lines);
  const items: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (fenced.has(i)) continue;
    const level = outOfScopeHeadingLevel(lines[i], lines[i + 1]);
    if (level === null) continue;
    // Setext consumes its underline; ATX does not.
    const bodyStart = SETEXT_UNDERLINE.test(lines[i + 1] ?? "") ? i + 1 : i;
    items.push(...itemsFromSection(sectionLines(lines, bodyStart, level)));
  }
  items.push(...itemsFromInlineMarkers(lines, fenced));

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
