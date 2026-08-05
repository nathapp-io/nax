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

/**
 * Lines belonging to the `Modifies` section starting at `startIndex`.
 *
 * Ends at the next heading whose level is the same as or shallower than the
 * section heading's, so the neighbouring `### Creates` / `### Seams` blocks are
 * never absorbed. The `level === 1` guard is a safety rail: when the section
 * heading is H1 every other section nests under it, and folding the whole
 * document in would fabricate authorisations from unrelated prose.
 */
function sectionLines(lines: readonly string[], startIndex: number, level: number, fenced: Set<number>): string[] {
  const collected: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (fenced.has(i)) continue;
    const heading = lines[i].match(ANY_HEADING);
    // A story heading is a group lead-in, not a section boundary — keep it.
    if (heading && !STORY_HEADING.test(lines[i]) && (heading[1].length <= level || level === 1)) break;
    collected.push(lines[i]);
  }
  return collected;
}

/**
 * Split one bullet's folded text into a path and the reason behind it.
 *
 * The path is the leading backticked span when present, else the first
 * whitespace-delimited token — so an author who omits backticks still gets a
 * usable entry rather than a silent drop. Returns null when nothing path-shaped
 * leads the item, which is how a stray prose bullet inside the section is
 * rejected instead of being written into the PRD as a file path.
 */
function parseEntry(text: string): { path: string; reason: string } | null {
  const backticked = text.match(BACKTICKED_PATH);
  const [path, rest] = backticked
    ? [backticked[1].trim(), text.slice(backticked[0].length)]
    : [(text.match(/^\S+/)?.[0] ?? "").trim(), text.replace(/^\S+/, "")];

  if (!path) return null;
  return { path, reason: rest.replace(PATH_REASON_SEPARATOR, "").trim() };
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
