/**
 * Out-of-scope *extraction* — the markdown side of scope fidelity.
 *
 * Pure, deterministic parsing of a spec's deferrals: what did the author say
 * this feature (or one story) will NOT do? Reconciling that against a PRD lives
 * in `./out-of-scope`; this file never sees a `PRD`.
 *
 * ## Two territories, deliberately separated
 *
 * A spec declares deferrals at two levels, and conflating them is a real defect
 * (#1446): the feature-level list is copied onto EVERY story, so a story-local
 * block promoted to it waives one story's deferral across all the others.
 * {@link storyScopeBoundary} is the dividing line — {@link extractSpecOutOfScope}
 * takes only what is above it, {@link extractStoryScopedOutOfScope} only what is
 * below.
 *
 * ## Matching semantics
 *
 * Out-of-scope items are prose, not executable assertions, so a planner is
 * allowed to expand an item ("no Ink TUI" -> "no Ink TUI; deferred to arc 3").
 * Comparison is therefore on {@link canonical} form (whitespace collapsed,
 * backticks stripped, lowercased) and by substring, never by equality.
 */

/** An extracted item plus the line its declaration started on. */
interface PlacedItem {
  readonly lineIndex: number;
  readonly text: string;
}

/** A deferral the spec declared inside one story's territory. */
export interface StoryScopedExclusion {
  /** Owning story, from the nearest `US-00N` heading above — null when none. */
  readonly storyId: string | null;
  readonly text: string;
}

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

/**
 * The heading that begins per-story decomposition. Everything after it is
 * story-scoped territory (see {@link storyScopeBoundary}).
 */
const STORY_SECTION_HEADING = /^#{1,3}\s*(?:stories|acceptance\s+criteria|user\s+stories)\b/i;

/**
 * A heading naming the story it opens — `### US-001 — Next-fire verdict`.
 * Ownership of a story-scoped declaration is the nearest such heading above it,
 * which is how spec-kit specs decompose their `## Acceptance Criteria` section.
 */
const STORY_ID_HEADING = /^#{1,6}\s.*\b(US-\d+)\b/i;

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
export const INLINE_MARKER = /^\s*(?:[-*]\s*)?\*\*\s*(?:out[\s-]?of[\s-]?scope|non[\s-]?goals?)[^*]*\*\*\s*:?\s*/i;

/** A list item — used both to split bullets and to bound folded prose. */
const LIST_ITEM_START = /^\s*(?:[-*+\u2022\u2023\u25E6\u2043\u2219]|\d+\.)\s+/;

/** Collapse whitespace, strip backticks, lowercase — the comparison form. */
export function canonical(text: string): string {
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
 * One item per inline `**Out of scope …:**` lead-in, each tagged with the line
 * its marker sat on so a caller can attribute it to the owning story.
 *
 * Two shapes, both common:
 * - Text on the same line, folded across wrapped prose lines.
 * - A bare marker followed by a bullet list — the single most common idiom.
 *   Handled explicitly because the prose fold stops at the first list item,
 *   which previously left the marker empty and the bullets claimed by nobody.
 */
function itemsFromInlineMarkers(lines: string[], fenced: Set<number>, start: number, end: number): PlacedItem[] {
  const items: PlacedItem[] = [];
  for (let i = start; i < end; i++) {
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
      items.push(...itemsFromSection(body).map((text) => ({ lineIndex: i, text })));
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
    if (text) items.push({ lineIndex: i, text });
    i = j - 1;
  }
  return items;
}

/** Sentinels meaning "nothing deferred" — never a real exclusion. */
const EMPTY_SENTINELS = new Set(["none", "none.", "n/a", "na", "nothing", "nothing.", "tbd", "-"]);

/** A label introducing a list ("The following are deferred:"), not an exclusion itself. */
function isListLeadIn(item: string): boolean {
  return item.trimEnd().endsWith(":");
}

/** Deduplicate on canonical form, keeping first-seen (spec) wording, then cap. */
export function dedupeAndCap(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = canonical(item);
    // A sentinel or a trailing-colon lead-in would otherwise be rendered to every
    // implementer as a hard boundary ("do NOT implement these: None.") and become
    // a citable `scopeIndex` target.
    if (EMPTY_SENTINELS.has(key) || isListLeadIn(item)) continue;
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= MAX_OUT_OF_SCOPE_ITEMS) break;
  }
  return out;
}

/**
 * Index of the first `## Stories` / `## Acceptance Criteria` heading, or
 * `lines.length` when the spec has none.
 *
 * Declarations after this point belong to a *story*, not the feature.
 * spec-writing tells authors to give risk-sensitive stories their own
 * `**Out of scope:**` list under the story's AC block; hoisting those to feature
 * level propagated one story's deferral onto every other story — US-001's
 * implementer would be told US-002's deferred work is a hard boundary.
 *
 * A top-level (`#`/`##`) heading is exempt: a document section named
 * `## Out of Scope` is feature-level wherever the author placed it, including
 * after the story sections.
 */
export function storyScopeBoundary(lines: string[]): number {
  const index = lines.findIndex((line) => STORY_SECTION_HEADING.test(stripEmphasis(line)));
  return index === -1 ? lines.length : index;
}

/**
 * Every feature-level out-of-scope statement declared by the spec, in document
 * order: bullets (or paragraphs) under an `## Out of Scope` / `## Non-Goals`
 * heading, plus any inline `**Out of scope …:**` lead-in.
 *
 * Story-scoped declarations are excluded. spec-writing tells authors to give
 * risk-sensitive stories their own `**Out of scope:**` list under the story's AC
 * block; only declarations before the first `## Stories` / `## Acceptance
 * Criteria` heading — or in a top-level `##` section anywhere — are feature-level
 * (see {@link storyScopeBoundary}).
 *
 * Scope / assumptions (deliberate — the downstream gate warns, never fails):
 * - A sub-heading inside the section is treated as a label, not an item; its
 *   bullets are still collected.
 * - Fenced code blocks are skipped entirely, not folded — so a spec that
 *   documents markdown by example cannot inject a fabricated exclusion. The
 *   corollary: text written *inside* a fence is silently dropped, so exclusions
 *   must be bullets, table rows, or prose, never fenced.
 */
export function extractSpecOutOfScope(specContent: string): string[] {
  if (!specContent.trim()) return [];
  const lines = specContent.split("\n");

  const fenced = fencedLineIndices(lines);
  const boundary = storyScopeBoundary(lines);
  const items: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (fenced.has(i)) continue;
    const level = outOfScopeHeadingLevel(lines[i], lines[i + 1]);
    if (level === null) continue;
    // A sub-heading after story decomposition begins is that story's own
    // deferral, not the feature's. Top-level sections stay feature-level.
    if (level > 2 && i > boundary) continue;
    // Setext consumes its underline; ATX does not.
    const bodyStart = SETEXT_UNDERLINE.test(lines[i + 1] ?? "") ? i + 1 : i;
    items.push(...itemsFromSection(sectionLines(lines, bodyStart, level)));
  }
  items.push(...itemsFromInlineMarkers(lines, fenced, 0, boundary).map((item) => item.text));

  return dedupeAndCap(items);
}

/** Nearest `US-00N` heading at or above `index`, else null. */
function owningStoryId(lines: string[], index: number): string | null {
  for (let i = index; i >= 0; i--) {
    const match = stripEmphasis(lines[i]).match(STORY_ID_HEADING);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

/**
 * Every deferral the spec declared inside *story* territory — the mirror image
 * of {@link extractSpecOutOfScope}, which deliberately excludes exactly these.
 *
 * A `**Out of scope:**` block (or a sub-heading deeper than `##`) after
 * {@link storyScopeBoundary} belongs to one story. A top-level `## Out of Scope`
 * section is feature-level wherever it sits, so it is skipped here — the feature
 * extractor already owns it, and claiming it in both places would let a genuine
 * feature-level statement be demoted off the list.
 */
export function extractStoryScopedOutOfScope(specContent: string): StoryScopedExclusion[] {
  if (!specContent.trim()) return [];
  const lines = specContent.split("\n");
  const boundary = storyScopeBoundary(lines);
  if (boundary >= lines.length) return [];

  const fenced = fencedLineIndices(lines);
  const placed: PlacedItem[] = [];
  for (let i = boundary; i < lines.length; i++) {
    if (fenced.has(i)) continue;
    const level = outOfScopeHeadingLevel(lines[i], lines[i + 1]);
    if (level === null || level <= 2) continue;
    const bodyStart = SETEXT_UNDERLINE.test(lines[i + 1] ?? "") ? i + 1 : i;
    placed.push(...itemsFromSection(sectionLines(lines, bodyStart, level)).map((text) => ({ lineIndex: i, text })));
  }
  placed.push(...itemsFromInlineMarkers(lines, fenced, boundary, lines.length));

  return placed.map(({ lineIndex, text }) => ({ storyId: owningStoryId(lines, lineIndex), text }));
}
