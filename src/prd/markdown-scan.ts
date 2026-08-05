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
