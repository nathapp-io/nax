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

import { type GroupedPathEntry, extractGroupedPathSection } from "./markdown-scan";

/** One `### Modifies` bullet, with the story its group lead-in attributed it to. */
export type SpecModifiedFile = GroupedPathEntry;

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

/**
 * Every `### Modifies` entry the spec declares, in document order.
 *
 * Grammar, fencing, and grouping are shared with `### Context Files`
 * extraction — see `extractGroupedPathSection` in `./markdown-scan`.
 *
 * Unattributed entries are returned with `storyId: null` rather than guessed at
 * — deciding what to do with one is the caller's business (see `./modifies`).
 */
export function extractSpecModifiedFiles(specContent: string): SpecModifiedFile[] {
  return extractGroupedPathSection(specContent, MODIFIES_HEADING, MAX_MODIFIED_FILES);
}
