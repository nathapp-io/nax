/**
 * `### Context Files` *extraction* — the spec's reads a story should see before
 * implementing (#1466).
 *
 * Unlike `### Modifies`, `contextFiles` is intentionally something the planner
 * chooses: the LLM reasons about what it needs to read, and `FILE_INJECTION_MAX_FILES`
 * caps injected reads to 5. A spec-declared entry that loses its slot under that
 * cap is a legitimate eviction, not a bug — so this module extracts the spec's
 * declared list purely so a caller can detect drift (see `warnOnDroppedContextFiles`
 * in `../operations/plan-fidelity`), never to carry or backfill a PRD field the
 * way `./modifies-extract` does.
 *
 * Grammar, fencing, and `**US-00N**` grouping are shared with `### Modifies` —
 * see `extractGroupedPathSection` in `./markdown-scan`.
 */

import { extractGroupedPathSection, type GroupedPathEntry } from "./markdown-scan";

/** One `### Context Files` bullet, with the story its group lead-in attributed it to. */
export type SpecContextFile = GroupedPathEntry;

/**
 * Upper bound on extracted entries across the whole spec. A well-formed spec
 * lists at most a handful of context files per story; this only guards against
 * a runaway document, not the per-story 5-file injection cap.
 */
export const MAX_SPEC_CONTEXT_FILES = 200;

/**
 * `### Context Files`, `#### Context Files (per story)` …
 *
 * The trailing `\b` admits the parenthetical suffix real specs use, mirroring
 * `MODIFIES_HEADING` in `./modifies-extract`.
 *
 * Deliberately narrow, matching only an ATX heading (`#{1,6} Context Files`).
 * A bold pseudo-heading (`**Context Files:**`) or an inline list item
 * (`- Context Files: \`a.ts\`, \`b.ts\``) are NOT matched — both appear in a
 * handful of older specs in this repo, predating spec-writing's current
 * template. Widening the regex to catch them risks false-matching prose that
 * merely mentions "context files" in a sentence; the current heading-only
 * match trades those specs' coverage for that safety.
 */
const CONTEXT_FILES_HEADING = /^(#{1,6})\s*context\s*files\b/i;

/**
 * Every `### Context Files` entry the spec declares, in document order.
 *
 * Unattributed entries are returned with `storyId: null` — deciding what to do
 * with one is the caller's business.
 */
export function extractSpecContextFiles(specContent: string): SpecContextFile[] {
  return extractGroupedPathSection(specContent, CONTEXT_FILES_HEADING, MAX_SPEC_CONTEXT_FILES);
}
