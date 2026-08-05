/**
 * `### Modifies` *extraction* — the markdown side of modification authority.
 *
 * A spec's `### Modifies` block is the channel that authorises an implementer to
 * update an EXISTING file its own correct change necessarily breaks — most often
 * a test whose closed-world assertion no longer holds under the new behaviour.
 * spec-review treats a missing entry as a blocker precisely because the
 * implementer's other option, when a correct implementation fails an existing
 * assertion, is to revert until the assertion passes.
 *
 * ## Why this is parsed, not prompted
 *
 * The field is never asked of the planner (#1450). `outOfScope` asks first on
 * purpose — a planner paraphrase is usually better-worded prose. Here the value
 * IS the specificity: which test, which assertion, what the new invariant is.
 * A paraphrase ("update affected engine tests") is exactly the loss this module
 * exists to prevent, so the spec's words are taken verbatim and the planner is
 * left out of the loop entirely.
 *
 * ## Grammar
 *
 * Narrower than the out-of-scope grammar by design — this heading is emitted by
 * spec-writing to a fixed shape, so there is no setext, table, or prose-paragraph
 * fallback to support:
 *
 * ```
 * ### Modifies
 *
 * **US-001**
 * - `path/to/file.ts` — reason, folded across continuation lines
 * ```
 *
 * Ownership comes from the nearest `**US-00N**` group lead-in above a bullet —
 * NOT from the nearest heading, which is how `./out-of-scope-extract` attributes
 * its story-scoped items. The two sections sit in different territory: `Modifies`
 * lives between `## Stories` and `## Acceptance Criteria`, where no per-story
 * headings exist yet.
 *
 * Reconciling extracted entries against a PRD lives in `./modifies`; this file
 * never sees a `PRD`. Pure and deterministic — no I/O, no LLM.
 */

import { ANY_HEADING, LIST_ITEM_START, fencedLineIndices, stripBullet, stripEmphasis } from "./markdown-scan";

/** One `### Modifies` bullet, with the story its group lead-in attributed it to. */
export interface SpecModifiedFile {
  /** Owning story from the nearest `**US-00N**` group above — null when none. */
  readonly storyId: string | null;
  readonly path: string;
  /** The spec's stated reason, verbatim. Empty when the author listed a bare path. */
  readonly reason: string;
}

/**
 * Upper bound on extracted entries. A spec authorising more than this many
 * existing-file changes has a scope problem, not a modification list; truncating
 * keeps every downstream story prompt bounded.
 */
export const MAX_MODIFIED_FILES = 25;

/**
 * `### Modifies`, `## Modified Files (per story)`, `### Modifies:` …
 *
 * The trailing `\b` (rather than an end anchor) is what admits the parenthetical
 * suffix real specs use — `### Creates (per story)` and `### Context Files (per
 * story)` both appear in this repo's own specs, so the sibling heading must
 * tolerate the same shape.
 */
const MODIFIES_HEADING = /^(#{1,6})\s*modifi(?:es|ed\s+files)\b/i;

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
 * Lines belonging to the `Modifies` section starting at `startIndex`.
 *
 * Ends at the next heading whose level is the same as or shallower than the
 * section heading's, so the neighbouring `### Creates` / `### Seams` blocks are
 * never absorbed. The `level === 1` guard is a safety rail: when the section
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
 * `see` and rendered to the implementer as a file it may change. Returns null in
 * that case, dropping the bullet.
 *
 * The cost of the rule is a bare extensionless filename (`Makefile`) written
 * without backticks, which is rejected. That is the right trade: spec-writing
 * tells authors to backtick paths, and fabricating an authorisation is worse
 * than declining an ambiguous one.
 */
function parseEntry(text: string): { path: string; reason: string } | null {
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
 * Every `### Modifies` entry the spec declares, in document order.
 *
 * Fenced lines are skipped entirely: spec-kit specs document their own markdown
 * by example, so a literal ` ```markdown / ### Modifies ` block would otherwise
 * fabricate an authorisation that is written into the PRD and rendered to an
 * implementer as fact.
 *
 * Unattributed entries are returned with `storyId: null` rather than guessed at
 * — deciding what to do with one is the caller's business (see `./modifies`).
 */
export function extractSpecModifiedFiles(specContent: string): SpecModifiedFile[] {
  if (!specContent.trim()) return [];
  const lines = specContent.split("\n");
  const fenced = fencedLineIndices(lines);

  const entries: SpecModifiedFile[] = [];
  for (let i = 0; i < lines.length && entries.length < MAX_MODIFIED_FILES; i++) {
    if (fenced.has(i)) continue;
    const heading = stripEmphasis(lines[i]).match(MODIFIES_HEADING);
    if (!heading) continue;
    entries.push(...collectSection(sectionLines(lines, i, heading[1].length, fenced)));
  }
  return entries.slice(0, MAX_MODIFIED_FILES);
}

/** One pass over a section body, tracking the group lead-in currently in force. */
function collectSection(body: readonly string[]): SpecModifiedFile[] {
  const entries: SpecModifiedFile[] = [];
  let storyId: string | null = null;
  let current: string[] = [];

  const flush = () => {
    const parsed = current.length > 0 ? parseEntry(current.join(" ").replace(/\s+/g, " ").trim()) : null;
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
