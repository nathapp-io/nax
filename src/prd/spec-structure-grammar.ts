/**
 * The line grammar of a spec's `## Stories` section.
 *
 * `./spec-structure` owns the public interface and every decision taken on top
 * of this — what to backfill, how a PRD diverges, how a violation reads. This
 * file answers one narrower question: what does one line declare?
 *
 * Everything here is scoped to `## Stories` and skips fenced lines: spec-kit
 * specs document their own markdown by example.
 *
 * A DECLARING line states a story id: a heading (`### US-001 — Core`), a bold
 * lead-in (`**US-001**: …`), or a bullet/numbered item whose first bold token is
 * a story id (`1. **US-001: Core** — …`). A `Workdir` or `Depends on` statement
 * belongs to the declaring line it sits on, or to the nearest one above it.
 *
 * `Workdir` is read from declaring lines, their prose, and the `### Context
 * Files` / `### Creates` subsections, in two forms: `Workdir:` followed by a
 * path, or `Workdir` followed by a backticked one. `Depends on` is read from
 * declaring lines and their prose ONLY — `### Modifies`, `### Seams`,
 * `### Context Files` and `### Creates` are free text about other things, and
 * their reasons routinely mention another story ("the count test depends on
 * US-003's registration").
 *
 * Pure and deterministic: no I/O, no PRD, no LLM.
 */

import { fencedLineIndices } from "../utils/markdown-fence";
import { stripEmphasis } from "./markdown-scan";

/** The `## Stories` heading that opens the only section this module reads. */
const STORIES_HEADING = /^##\s+Stories\b/i;
/** End of the `## Stories` section: the next H1/H2 heading. */
const SECTION_BOUNDARY = /^#{1,2}\s/;
/** Any ATX heading, with its title, for subsection detection. */
const ANY_HEADING_TITLE = /^#{1,6}\s+(.*)$/;

/**
 * A subsection whose `**US-00N**` lead-ins are group labels rather than story
 * declarations — shared with `./spec-structure`'s id reader, which skips the
 * same four so its unknown-story check does not become self-satisfying.
 */
export const GROUPED_PATH_SUBSECTION = /^#{1,6}\s*(modifi(?:es|ed\s+files)|context\s+files|creates|seams)\b/i;

/**
 * Whether a `Workdir` statement here belongs to the story: its declaring lines
 * and prose (null), plus the two subsections that name the story's own files. A
 * `### Modifies` / `### Seams` reason is free text about a change, not the
 * story's package.
 */
function readsWorkdir(subsection: string | null): boolean {
  return subsection !== "modifies" && subsection !== "seams";
}

/** Whether a `Depends on` statement here belongs to the story: declaring lines and prose only. */
function readsDependencies(subsection: string | null): boolean {
  return subsection === null;
}

/** The story id a declaring line states, or null when the line declares none. */
function declaringStoryId(line: string): string | null {
  const match =
    /^#{1,6}\s+(US-\d+)\b/i.exec(line) ??
    // A bullet/numbered item whose first bold token is the id — how spec-writing
    // writes a story list.
    /^\s*(?:\d+\.|[-*])\s+\*\*\s*(US-\d+)\b/i.exec(line) ??
    /^\s*\*\*\s*(US-\d+)\b/i.exec(line);
  return match?.[1] ? match[1].toUpperCase() : null;
}

/**
 * The subsection a heading opens: one of the four the grammar names, `"other"`
 * for any other heading (which closes the current one), or null for a
 * non-heading line.
 */
function openedSubsection(line: string): string | null {
  const title = ANY_HEADING_TITLE.exec(line)?.[1];
  if (title === undefined) return null;
  const normalized = stripEmphasis(title).trim().toLowerCase();
  if (/^modifi(?:es|ed\s*files)\b/.test(normalized)) return "modifies";
  if (/^seams\b/.test(normalized)) return "seams";
  if (/^context\s+files\b/.test(normalized)) return "context-files";
  if (/^creates\b/.test(normalized)) return "creates";
  return "other";
}

/**
 * A `Workdir` statement's keyword.
 *
 * Lookarounds rather than `\b`: what authors put in front of it is routinely `_`
 * or `*`, and `\b` counts `_` as a word character — so `_Workdir \`apps/web\`._`
 * would read as no statement at all, silently disabling the field on exactly the
 * shape spec-writing emits.
 */
const WORKDIR_MENTION = /(?<![A-Za-z0-9])workdir(?![A-Za-z0-9])/gi;
/** `Workdir:` — the label form. */
const WORKDIR_LABEL = /^\s*:\s*/;
/** The path: the first run of characters that is neither whitespace nor a backtick. */
const WORKDIR_BARE_PATH = /^[^\s`]+/;
/** `Workdir` followed by a backticked path, allowing the emphasis authors write. */
const WORKDIR_BACKTICKED_PATH = /^[\s:*_(]*`([^\s`]+)`/;
const TRAILING_PUNCTUATION = /[.,;)_]+$/;

/** Read the workdir value a `Workdir` mention introduces, or null when it states none. */
function readWorkdirValue(rest: string): string | null {
  const label = WORKDIR_LABEL.exec(rest);
  if (label) {
    const bare = WORKDIR_BARE_PATH.exec(rest.slice(label[0].length))?.[0];
    if (bare !== undefined) {
      const value = bare.replace(TRAILING_PUNCTUATION, "");
      if (value.length > 0) return value;
    }
  }
  const backticked = WORKDIR_BACKTICKED_PATH.exec(rest)?.[1]?.trim().replace(TRAILING_PUNCTUATION, "");
  return backticked !== undefined && backticked.length > 0 ? backticked : null;
}

/** Every workdir a line states — more than one for a story means the field conflicts. */
function workdirStatements(line: string): string[] {
  const stated: string[] = [];
  WORKDIR_MENTION.lastIndex = 0;
  let mention = WORKDIR_MENTION.exec(line);
  while (mention !== null) {
    const value = readWorkdirValue(line.slice(mention.index + mention[0].length));
    if (value !== null) stated.push(value);
    mention = WORKDIR_MENTION.exec(line);
  }
  return stated;
}

const NO_DEPENDENCIES = /(?<![A-Za-z0-9])no\s+dependencies(?![A-Za-z0-9])/i;
const DEPENDS_ON_MENTION = /(?<![A-Za-z0-9])depends\s+on(?![A-Za-z0-9])/gi;
/** `none` after the label, past optional `:`, `*`, `_`, `(` and whitespace. */
const DEPENDS_ON_NONE = /^[\s:*_(]*none\b/i;
/** One id, ending on a whole-token boundary so `US-003's` is not read as a list member. */
const DEPENDENCY_ID = /^(US-\d+)(?![A-Za-z0-9])/i;
/** Separators between ids: `,`, `and`, `&` and whitespace. */
const DEPENDENCY_SEPARATOR = /^(?:\s+|[*:_(,;&]+|\band\b)+/i;

/** The dependency a `depends on` mention introduces: `"none"`, an id list, or null. */
function readDependencyValue(rest: string): "none" | string[] | null {
  let index = DEPENDENCY_SEPARATOR.exec(rest)?.[0].length ?? 0;
  if (DEPENDS_ON_NONE.test(rest.slice(index))) return "none";

  const ids: string[] = [];
  for (;;) {
    const id = DEPENDENCY_ID.exec(rest.slice(index))?.[1];
    if (id === undefined) break;
    const upper = id.toUpperCase();
    if (!ids.includes(upper)) ids.push(upper);
    index += id.length;
    const separated = DEPENDENCY_SEPARATOR.exec(rest.slice(index))?.[0].length ?? 0;
    // No separator after an id ends the list — that is what stops
    // "(shared type)" or "'s registration" from being read as another id.
    if (separated === 0) break;
    index += separated;
  }
  return ids.length > 0 ? ids : null;
}

/** The dependency statements one line carries. */
function dependencyStatements(line: string): Array<"none" | string[]> {
  const stated: Array<"none" | string[]> = [];
  DEPENDS_ON_MENTION.lastIndex = 0;
  let mention = DEPENDS_ON_MENTION.exec(line);
  while (mention !== null) {
    const value = readDependencyValue(line.slice(mention.index + mention[0].length));
    if (value !== null) stated.push(value);
    mention = DEPENDS_ON_MENTION.exec(line);
  }
  return stated;
}

/** What one story's lines have said. */
export interface StoryDeclarations {
  readonly id: string;
  /** Every workdir stated for it — one value means it said so once. */
  readonly workdirs: readonly string[];
  /** Every dependency id list stated for it, in the order stated. */
  readonly dependencyLists: readonly string[][];
  /** It said "no dependencies", or `none`. */
  readonly statesNone: boolean;
}

/** Mutable accumulator, so one walk can keep appending to the story in force. */
interface Accumulator {
  readonly id: string;
  readonly workdirs: Set<string>;
  readonly dependencyLists: string[][];
  statesNone: boolean;
}

function accumulatorFor(byId: Map<string, Accumulator>, id: string): Accumulator {
  const existing = byId.get(id);
  if (existing) return existing;
  const created: Accumulator = { id, workdirs: new Set(), dependencyLists: [], statesNone: false };
  byId.set(id, created);
  return created;
}

/**
 * Walk the `## Stories` body, attributing every statement to the story whose
 * declaring line is in force.
 *
 * A `**US-00N**` lead-in INSIDE a grouped subsection (`### Modifies` — the shape
 * every real spec uses) attributes the lines below it to that story while the
 * subsection's own rules still apply: its prose is a reason, not a declaration.
 * A heading has already reset that state: only the four named subsections
 * survive `openedSubsection` as state, and any other heading clears it.
 */
export function collectStoryDeclarations(specContent: string): StoryDeclarations[] {
  const lines = specContent.split("\n");
  const start = lines.findIndex((line) => STORIES_HEADING.test(line));
  if (start < 0) return [];

  const fenced = fencedLineIndices(lines);
  const byId = new Map<string, Accumulator>();
  let current: Accumulator | null = null;
  let subsection: string | null = null;

  for (let i = start + 1; i < lines.length; i++) {
    if (fenced.has(i)) continue;
    const line = lines[i];
    if (SECTION_BOUNDARY.test(line)) break;

    const opened = openedSubsection(line);
    if (opened !== null) subsection = opened === "other" ? null : opened;
    const declared = declaringStoryId(line);
    if (declared !== null) current = accumulatorFor(byId, declared);
    if (current === null) continue;

    if (readsWorkdir(subsection)) {
      for (const value of workdirStatements(line)) current.workdirs.add(value);
    }
    if (readsDependencies(subsection)) {
      if (NO_DEPENDENCIES.test(line)) current.statesNone = true;
      for (const stated of dependencyStatements(line)) {
        if (stated === "none") current.statesNone = true;
        else current.dependencyLists.push(stated);
      }
    }
  }

  return [...byId.values()].map((accumulator) => ({
    id: accumulator.id,
    workdirs: [...accumulator.workdirs],
    dependencyLists: accumulator.dependencyLists,
    statesNone: accumulator.statesNone,
  }));
}
