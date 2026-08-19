/**
 * Barrel for `src/finish/operations/` — the `RunOperation`s finish's machine
 * dispatches through `callOp`.
 */
export { finishFixOp } from "./fix-op";
export type { FinishFixInput } from "./fix-op";
export {
  buildNarrativePrompt,
  finishNarrativeOp,
  NARRATIVE_MAX_CHARS,
  parseNarrative,
  parseNarrativeNode,
  readSpecSummary,
  resolveNarrative,
} from "./narrative-op";
export type { FinishNarrativeInput, FinishNarrativeOutput } from "./narrative-op";
export { parseTitle, resolveTitle, sanitizeTitle, TITLE_CLOSE_TAG, TITLE_MAX_CHARS, TITLE_OPEN_TAG } from "./pr-title";
export { finishReviewOp } from "./review-op";
export type { FinishReviewInput, FinishReviewOutput } from "./review-op";
