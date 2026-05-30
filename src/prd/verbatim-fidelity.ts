/**
 * Spec `[verbatim]` AC preservation — deterministic fidelity check.
 *
 * `nax plan` decomposes a spec markdown into a PRD. Acceptance criteria the
 * spec author tags `[verbatim]` (executable greps, file-existence checks,
 * regex/count assertions, architectural invariants) are load-bearing: their
 * verification mechanism only survives if the literal tokens are copied into a
 * PRD acceptance criterion. Paraphrasing destroys the gate (see
 * docs/findings/nax-plan-prd-fidelity.md §1–§2).
 *
 * This module is the single source of truth for "did the PRD preserve every
 * `[verbatim]` spec AC?". It is pure and deterministic — no LLM, no I/O — so it
 * can back both the `planRefineOp.verify` hard gate and the `hopBody` self-heal
 * turn without divergence.
 *
 * Matching strategy: a `[verbatim]` AC is preserved iff every backtick-quoted
 * token in it (the grep, the path, the regex, the count) appears — modulo
 * whitespace and backtick formatting — in some PRD story's `acceptanceCriteria`.
 * Backtick tokens are the load-bearing payload the finding requires to be
 * "identical"; keying on them tolerates the planner's legitimate rephrasing of
 * the surrounding prose while still catching a destroyed verification mechanism.
 * ACs with no backtick tokens fall back to a tag-stripped full-line match.
 */

import type { PRD } from "./types";

/** Verification-mechanism tags the spec-writing guide emits on AC bullets. */
const AC_TAG_PATTERN = /\[(verbatim|file|unit|integration|cli|grep)\]/gi;

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

/** Extract the contents of every `…` span on a line, trimmed and non-empty. */
function backtickSpans(line: string): string[] {
  return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter((s) => s.length > 0);
}

/**
 * Every line in the spec that carries a `[verbatim]` tag, trimmed. Each line is
 * treated as one acceptance criterion (the spec-writing guide emits one AC per
 * bullet). Returned verbatim (tag included) so callers can quote them in
 * error/repair messages.
 */
export function extractVerbatimAcLines(specContent: string): string[] {
  return specContent
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /\[verbatim\]/i.test(line));
}

/**
 * The literal tokens that must survive into the PRD for a given `[verbatim]` AC
 * line. Prefers backtick-quoted spans (the load-bearing commands/paths). When a
 * line has no backtick spans, falls back to the tag-stripped, bullet-stripped
 * payload as a single token.
 */
function requiredTokens(line: string): string[] {
  const spans = backtickSpans(line);
  if (spans.length > 0) return spans;
  const payload = line.replace(AC_TAG_PATTERN, "").replace(/^[-*]\s*/, "");
  const canonicalPayload = canonical(payload);
  return canonicalPayload.length > 0 ? [canonicalPayload] : [];
}

/** All PRD acceptance-criteria text across every story, in canonical form. */
function prdAcHaystack(prd: Pick<PRD, "userStories">): string {
  const acText = (prd.userStories ?? []).flatMap((story) => story.acceptanceCriteria ?? []).join("\n");
  return canonical(acText);
}

/**
 * Return the `[verbatim]` spec AC lines that the PRD dropped or altered — i.e.
 * those for which at least one required token is absent from every PRD
 * acceptance criterion. An empty result means full preservation.
 *
 * `prd` is accepted as `Pick<PRD, "userStories">` so callers can pass a partial
 * (e.g. a freshly parsed draft) without the full envelope.
 */
export function findMissingVerbatimAcs(specContent: string, prd: Pick<PRD, "userStories">): string[] {
  const haystack = prdAcHaystack(prd);
  const missing: string[] = [];
  for (const line of extractVerbatimAcLines(specContent)) {
    const tokens = requiredTokens(line);
    if (tokens.length === 0) continue;
    const allPresent = tokens.every((token) => haystack.includes(canonical(token)));
    if (!allPresent) missing.push(line);
  }
  return missing;
}
