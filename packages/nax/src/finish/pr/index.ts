/**
 * Barrel for `src/finish/pr/` — the PR body's advisor section and the
 * open/promote/edit operations. Consumers import from `src/finish/`'s barrel,
 * never from this file directly.
 */

export { buildAdvisorSection } from "./body";
export { escapeInline, escapeTableCell } from "./escape";
export { NARRATIVE_MAX_CHARS, readSpecSummary, resolveNarrative } from "./narrative";
export { openDraftFinishPr, openOrPromotePr, parseView, updatePrBody } from "./open";
