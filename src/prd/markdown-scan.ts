/**
 * Shared markdown scanning primitives for spec parsing.
 *
 * `./out-of-scope-extract` and `./modifies-extract` both walk a spec's raw lines
 * looking for a named section and folding its bullets into items. The mechanics
 * they share — what counts as a heading, what counts as a bullet, and which
 * lines sit inside a fenced code block — live here so the two parsers cannot
 * drift on the question that matters most: whether a construct written *inside*
 * a fence is real.
 *
 * Fence handling in particular is not a detail. spec-kit specs routinely
 * document their own markdown by example, so a literal ` ```markdown / ###
 * Modifies ` block appears in specs *about* specs. A parser that treats it as a
 * real declaration fabricates a directive that is then written into the PRD and
 * rendered to an implementer as fact.
 *
 * Pure and deterministic — no I/O, no PRD types, no LLM.
 */

/** Any markdown ATX heading, captured so section nesting can be compared. */
export const ANY_HEADING = /^(#{1,6})\s/;

/** A list item — used both to split bullets and to bound folded prose. */
export const LIST_ITEM_START = /^\s*(?:[-*+•‣◦⁃∙]|\d+\.)\s+/;

/** A fenced code block delimiter (``` or ~~~), with optional info string. */
export const FENCE = /^\s*(?:```|~~~)/;

/**
 * Strip inline emphasis/backticks so heading matching is not defeated by
 * formatting. `## **Out of Scope**` and `## \`Out of Scope\`` are the same
 * heading as `## Out of Scope` — treating them differently silently drops the
 * entire section, which is the exact failure these parsers exist to prevent.
 */
export function stripEmphasis(text: string): string {
  return text.replace(/\*\*/g, "").replace(/[*`_]/g, "");
}

/** Strip a leading `-`/`*`/`1.` bullet marker. */
export function stripBullet(line: string): string {
  return line.replace(LIST_ITEM_START, "").trim();
}

/**
 * Indices of every line inside a fenced code block.
 *
 * Fenced content is illustrative — a spec documenting markdown (which spec-kit
 * specs routinely do) contains a literal `## Out of Scope` example. Treating it
 * as a real declaration fabricates an entry that is then backfilled into the
 * PRD, pushed onto a story, and rendered to the implementer as a hard
 * instruction. Every scan over raw lines must consult this.
 */
export function fencedLineIndices(lines: readonly string[]): Set<number> {
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

// ─────────────────────────────────────────────────────────────────────────────
// **US-00N**-grouped path sections
//
// `### Modifies` and `### Context Files` are both written by spec-writing to
// the SAME shape: a heading, then one `**US-00N**` group lead-in per story,
// then bulleted `` `path` `` entries with an optional trailing reason. Two
// independent copies of this grammar would silently drift on what counts as
// a path, a group boundary, or a section end — so both parsers route through
// `extractGroupedPathSection` below.
// ─────────────────────────────────────────────────────────────────────────────

/** One bullet from a `**US-00N**`-grouped section: a path plus its stated reason. */
export interface GroupedPathEntry {
  /** Owning story from the nearest `**US-00N**` group above — null when none. */
  readonly storyId: string | null;
  readonly path: string;
  /** The spec's stated reason, verbatim. Empty when the author listed a bare path. */
  readonly reason: string;
}

/** A `**US-001**` group lead-in on its own line — the ownership marker. */
const GROUP_LEAD_IN = /^\s*\*\*\s*(US-\d+)\s*\*\*\s*:?\s*$/i;

/** A heading naming a story — `#### US-001`, the alternative group form. */
const STORY_HEADING = /^#{1,6}\s.*\b(US-\d+)\b/i;

/** The dash separating a path from its reason: em, en, or hyphen. */
const PATH_REASON_SEPARATOR = /^\s*[—–-]\s*/;

/** A leading backticked span — the canonical way a spec writes the path. */
const BACKTICKED_PATH = /^`([^`]+)`/;

/** Minimum evidence that an unbackticked token is a path and not the first word of a sentence. */
const PATH_SHAPED = /[/.]/;

/**
 * Lines belonging to a section starting at `startIndex`.
 *
 * Ends at the next heading whose level is the same as or shallower than the
 * section heading's, so neighbouring sections at the same nesting are never
 * absorbed. The `level === 1` guard is a safety rail: when the section
 * heading is H1 every other section nests under it, and folding the whole
 * document in would fabricate authorisations from unrelated prose.
 *
 * A story heading is deliberately NOT exempted from the boundary. A DEEPER one
 * (`#### US-001` under `### Modifies`) already survives — it fails the level
 * test and is collected, then read as a group lead-in. Exempting a heading at
 * the section's own level would only ever swallow a sibling section: `## US-002:
 * Second story` following `## Modifies` would be read as a group, and every
 * bullet beneath it would become a fabricated authorisation.
 */
function sectionLines(lines: readonly string[], startIndex: number, level: number, fenced: Set<number>): string[] {
  const collected: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (fenced.has(i)) continue;
    const heading = lines[i].match(ANY_HEADING);
    if (heading && (heading[1].length <= level || level === 1)) break;
    collected.push(lines[i]);
  }
  return collected;
}

/**
 * Split one bullet's folded text into a path and the reason behind it.
 *
 * A leading backticked span is taken as the path verbatim — the author marked it
 * explicitly, so nothing further is inferred. Without backticks the first
 * whitespace-delimited token is accepted only when it is **path-shaped** (holds
 * a `/` or a `.`), which is what stops a stray prose bullet inside the section —
 * "- see the notes below" — from being written into the PRD as a file named
 * `see`. Returns null in that case, dropping the bullet.
 *
 * The cost of the rule is a bare extensionless filename (`Makefile`) written
 * without backticks, which is rejected. That is the right trade: spec-writing
 * tells authors to backtick paths, and fabricating an entry is worse than
 * declining an ambiguous one.
 */
function parsePathEntry(text: string): { path: string; reason: string } | null {
  const backticked = text.match(BACKTICKED_PATH);
  if (backticked) {
    const path = backticked[1].trim();
    if (!path) return null;
    return { path, reason: text.slice(backticked[0].length).replace(PATH_REASON_SEPARATOR, "").trim() };
  }

  const candidate = text.match(/^\S+/)?.[0]?.trim() ?? "";
  if (!candidate || !PATH_SHAPED.test(candidate)) return null;
  return { path: candidate, reason: text.replace(/^\S+/, "").replace(PATH_REASON_SEPARATOR, "").trim() };
}

/**
 * Nearest ancestor `### US-00N: ...` heading strictly shallower than the
 * section heading at `headingIndex` — the section's ambient story when the
 * section itself is nested under a per-story heading rather than declaring
 * its own `**US-00N**` group lead-ins (e.g. `#### Context Files` written
 * directly under `### US-001: ...`, the shape spec-writing's own template
 * produces — see #1466).
 *
 * Stops at the FIRST shallower heading found, story or not: a section
 * nested two levels under a non-story ancestor (`## Stories` → `### Design
 * notes` → `#### Context Files`) has no story to inherit, and climbing
 * further up would misattribute it to an unrelated ancestor.
 */
function enclosingStoryId(
  lines: readonly string[],
  headingIndex: number,
  level: number,
  fenced: Set<number>,
): string | null {
  for (let i = headingIndex - 1; i >= 0; i--) {
    if (fenced.has(i)) continue;
    const heading = lines[i].match(ANY_HEADING);
    if (!heading || heading[1].length >= level) continue;
    return lines[i].match(STORY_HEADING)?.[1]?.toUpperCase() ?? null;
  }
  return null;
}

/**
 * One pass over a section body, tracking the group lead-in currently in
 * force. `defaultStoryId` seeds attribution for a section with no explicit
 * `**US-00N**` lead-ins of its own (see `enclosingStoryId`); an explicit
 * lead-in inside the body still overrides it from that point on.
 */
function collectGroupedPathEntries(body: readonly string[], defaultStoryId: string | null = null): GroupedPathEntry[] {
  const entries: GroupedPathEntry[] = [];
  let storyId: string | null = defaultStoryId;
  let current: string[] = [];

  const flush = () => {
    const parsed = current.length > 0 ? parsePathEntry(current.join(" ").replace(/\s+/g, " ").trim()) : null;
    if (parsed) entries.push({ storyId, ...parsed });
    current = [];
  };

  for (const line of body) {
    const group = line.match(GROUP_LEAD_IN) ?? line.match(STORY_HEADING);
    if (group) {
      flush();
      storyId = group[1].toUpperCase();
      continue;
    }
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    if (LIST_ITEM_START.test(line)) {
      flush();
      current.push(stripBullet(line));
      continue;
    }
    // A continuation line only folds into an OPEN bullet; prose sitting under the
    // heading before any bullet is a lead-in sentence, not an authorisation.
    if (current.length > 0) current.push(line.trim());
  }
  flush();
  return entries;
}

/**
 * Every entry a `**US-00N**`-grouped OR per-story-nested section declares,
 * in document order.
 *
 * `headingPattern` identifies the section (e.g. `### Modifies`, `### Context
 * Files`); `maxEntries` bounds total extraction so a runaway spec cannot
 * produce an unbounded list. Fenced lines are skipped entirely — spec-kit
 * specs document their own markdown by example, so a literal fenced block
 * containing the heading text would otherwise fabricate entries.
 *
 * Two attribution shapes are supported, since real specs use both:
 *   1. A single section with `**US-00N**` group lead-ins per story
 *      (`### Modifies` — always this shape in this repo's specs).
 *   2. A section repeated once per story, nested directly under that
 *      story's own heading (`### US-001: ...` → `#### Context Files` — the
 *      shape spec-writing's own template produces for `Context Files`).
 *      `enclosingStoryId` resolves the ambient story for this case; an
 *      explicit `**US-00N**` lead-in inside the body still overrides it.
 *
 * Unattributed entries are returned with `storyId: null` — deciding what to
 * do with one is the caller's business.
 */
export function extractGroupedPathSection(
  specContent: string,
  headingPattern: RegExp,
  maxEntries: number,
): GroupedPathEntry[] {
  if (!specContent.trim()) return [];
  const lines = specContent.split("\n");
  const fenced = fencedLineIndices(lines);

  const entries: GroupedPathEntry[] = [];
  for (let i = 0; i < lines.length && entries.length < maxEntries; i++) {
    if (fenced.has(i)) continue;
    const heading = stripEmphasis(lines[i]).match(headingPattern);
    if (!heading) continue;
    const level = heading[1].length;
    const defaultStoryId = enclosingStoryId(lines, i, level, fenced);
    entries.push(...collectGroupedPathEntries(sectionLines(lines, i, level, fenced), defaultStoryId));
  }
  return entries.slice(0, maxEntries);
}
