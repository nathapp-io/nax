/**
 * Barrel for `src/finish/review/` — the reply parsing, obligation gate, and
 * prompt-assembly modules that make up the review subtree.
 */
export { auditGaps, validateDispositions } from "./audit-gaps";
export { parseDispositions, parseReviewReport } from "./parse";
export { buildFixPrompt, buildReviewPrompt } from "./prompt";
export {
  FINDING_BLOCK_SHAPE,
  QUALITY_REVIEW_DIMENSIONS,
  SPEC_REVIEW_DIMENSIONS,
  WORKER_PROTOCOL,
  WORKER_PROTOCOL_MECHANICS,
} from "./prompts.gen";
