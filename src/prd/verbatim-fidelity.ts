/**
 * Spec `[verbatim]` AC preservation — deterministic fidelity check.
 *
 * `nax plan` decomposes a spec markdown into a PRD. Acceptance criteria the
 * spec author tags `[verbatim]` (executable greps, file-existence checks,
 * regex/count assertions, architectural invariants) are load-bearing: their
 * verification mechanism only survives if the AC text is copied into a PRD
 * acceptance criterion essentially unchanged. Paraphrasing destroys the gate
 * (see docs/findings/nax-plan-prd-fidelity.md §1–§2).
 *
 * This module is the single source of truth for "did the PRD preserve every
 * `[verbatim]` spec AC?". It is pure and deterministic — no LLM, no I/O — so it
 * can back both the `planRefineOp.verify` soft warning and the `hopBody`
 * self-heal turn without divergence.
 *
 * ## Matching semantics — full-payload, per-AC
 *
 * `[verbatim]` is a *character-for-character* contract (the author opted into
 * exactness). So a verbatim AC is preserved iff its **entire canonical payload**
 * — the AC text with its tag prefix removed, whitespace collapsed and backticks
 * stripped — appears as a contiguous substring of **a single** PRD acceptance
 * criterion (same normalization applied).
 *
 * Why the whole payload and not just the backtick tokens: keying on tokens alone
 * loses polarity. `File `x.ts` does not exist` and `x.ts still exists` share the
 * token `x.ts`; only matching the full phrase ("does not exist after this story")
 * catches an inverted assertion. Per-AC scoping (not a flattened haystack) stops
 * tokens from *different* PRD ACs jointly satisfying one spec AC. Normalization
 * is intentionally limited to whitespace + backticks: case and punctuation stay
 * significant because commands, paths, and regexes are case-sensitive.
 */

import type { PRD } from "./types";

/**
 * Matches the leading verification-mechanism tag group on an AC bullet, e.g.
 * `- [verbatim] `, `1. [file] [verbatim] `, `[verbatim] `. Anchored to line
 * start (after an optional `-`/`*`/`N.` bullet) so a prose sentence that merely
 * mentions `[verbatim]` is not mistaken for an AC.
 */
const LEADING_TAG_GROUP = /^\s*(?:[-*]|\d+\.)?\s*((?:\[[a-z][a-z-]*\]\s*)+)/i;

/** A new list item (tagged or not) — a boundary that ends a folded AC block. */
const LIST_ITEM_START = /^\s*(?:[-*]|\d+\.)\s/;

/** A markdown heading — also an AC-block boundary. */
const HEADING = /^\s*#/;

/** Collapse all whitespace runs to a single space and trim. */
function normalizeWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Drop backticks so formatting differences never cause a false "missing". */
function stripBackticks(text: string): string {
  return text.replace(/`/g, "");
}

/** Canonical form used on both sides of every comparison. */
function canonical(text: string): string {
  return normalizeWs(stripBackticks(text));
}

/** The leading tag group of a line, or null when the line is not a tagged AC. */
function leadingTagGroup(line: string): string | null {
  return line.match(LEADING_TAG_GROUP)?.[1] ?? null;
}

/** True when a line begins a `[verbatim]`-tagged AC bullet. */
function isVerbatimBullet(line: string): boolean {
  const tags = leadingTagGroup(line);
  return tags !== null && /\[verbatim\]/i.test(tags);
}

/**
 * True when `line` continues the previous AC (wrapped prose) rather than
 * starting a new block: non-blank, not a heading, not a new list item.
 */
function isContinuation(line: string): boolean {
  if (line.trim().length === 0) return false;
  if (HEADING.test(line)) return false;
  if (LIST_ITEM_START.test(line)) return false;
  return true;
}

/** Strip the leading bullet + tag group from a folded AC block. */
function stripTagPrefix(block: string): string {
  return block.replace(LEADING_TAG_GROUP, "");
}

/**
 * Every `[verbatim]`-tagged acceptance criterion in the spec, returned as a
 * single folded string each (continuation lines joined with a space). Returned
 * with tag prefix intact so callers can quote them in error/repair messages.
 *
 * Scope / assumptions (deliberate, given the warning is non-fatal):
 * - A verbatim AC is expected to be a single bullet, optionally wrapped across
 *   plain prose lines. Continuation folding stops at the next list item, blank
 *   line, or heading — so an AC whose payload lives in an indented sub-bullet or
 *   an embedded code fence (```) is not fully captured and may yield a spurious
 *   warning. Acceptable because the gate only warns; write verbatim ACs inline.
 * - The tag vocabulary is intentionally open: any `[token]` group at line start
 *   counts as a tag, but only `[verbatim]` triggers extraction — so unrelated
 *   bracket tags never cause a false warning.
 */
export function extractVerbatimAcs(specContent: string): string[] {
  const lines = specContent.split("\n");
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isVerbatimBullet(lines[i])) continue;
    const parts = [lines[i].trim()];
    let j = i + 1;
    while (j < lines.length && isContinuation(lines[j])) {
      parts.push(lines[j].trim());
      j += 1;
    }
    blocks.push(parts.join(" "));
    i = j - 1;
  }
  return blocks;
}

/** Canonical payloads of every PRD acceptance criterion, across all stories. */
function prdAcPayloads(prd: Pick<PRD, "userStories">): string[] {
  return (prd.userStories ?? []).flatMap((story) => (story.acceptanceCriteria ?? []).map(canonical));
}

/**
 * Return the `[verbatim]` spec ACs the PRD dropped or altered — those whose full
 * canonical payload is not a contiguous substring of any single PRD acceptance
 * criterion. An empty result means full preservation.
 *
 * `prd` is accepted as `Pick<PRD, "userStories">` so callers can pass a partial
 * (e.g. a freshly parsed draft) without the full envelope.
 */
export function findMissingVerbatimAcs(specContent: string, prd: Pick<PRD, "userStories">): string[] {
  const prdAcs = prdAcPayloads(prd);
  const missing: string[] = [];
  for (const block of extractVerbatimAcs(specContent)) {
    const payload = canonical(stripTagPrefix(block));
    if (payload.length === 0) continue;
    if (!prdAcs.some((ac) => ac.includes(payload))) missing.push(block);
  }
  return missing;
}
