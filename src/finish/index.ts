/**
 * Public barrel for `src/finish/` — the first this module gets.
 *
 * Exports what a consumer outside the module needs to drive a finish (Plan
 * 4's wiring) or implement `FinishOps` (Plan 3): the machine entry point,
 * context/state construction, the `FinishOps` contract, the routing/gate
 * functions, and the types a caller reads results through. It also exports
 * each module's injectable `_*Deps` seam, matching the convention already
 * used by `src/pipeline` (`_scopeFilesDeps`, `_executionDeps`,
 * `_acceptanceSetupDeps`) — tests reach them through this barrel rather than
 * a deep relative import, per `scripts/check-deep-relatives.ts`.
 */
export { appendRound, readRounds, recordRound, resultPath, roundsPath, writeResult } from "./audit";
export type { AuditTarget } from "./audit";
export {
  _finishGitDeps,
  buildCommitRound,
  commitAndPush,
  commitFixes,
  commitRoundOutcome,
  filesInCommit,
  PUSH_TIMEOUT_MS,
} from "./commit";
export { buildFixCommitMessage } from "./commit-message";
export type { CommitMessageCtx } from "./commit-message";
export { _finishContextDeps, loadFinishContext } from "./context";
export type { FinishContext } from "./context";
export { _acceptanceGateDeps, runAcceptanceGate } from "./gates/acceptance";
export { _qualityGateDeps, resolveGateCommands, runQualityGates } from "./gates/quality";
export { runFinishMachine } from "./machine";
export type { FinishMachineDeps } from "./machine";
export type { FinishOps, FixOutcome, FixRequest, ReviewRequest } from "./ops";
export {
  buildNarrativePrompt,
  finishFixOp,
  finishNarrativeOp,
  finishReviewOp,
  NARRATIVE_MAX_CHARS,
  parseNarrative,
  parseNarrativeNode,
  parseTitle,
  readSpecSummary,
  resolveNarrative,
  resolveTitle,
  sanitizeTitle,
  TITLE_CLOSE_TAG,
  TITLE_MAX_CHARS,
  TITLE_OPEN_TAG,
} from "./operations";
export type {
  FinishFixInput,
  FinishNarrativeInput,
  FinishNarrativeOutput,
  FinishReviewInput,
  FinishReviewOutput,
} from "./operations";
export {
  gateCommitRoute,
  MAX_FIX_ATTEMPTS,
  MAX_INCOMPLETE_ATTEMPTS,
  partitionTestFiles,
  routeAcceptance,
  routeQualityGates,
  routeReview,
} from "./route";
export type { ReviewOutcome, RoutedReview } from "./route";
export {
  auditGaps,
  buildFixPrompt,
  buildReviewPrompt,
  FINDING_BLOCK_SHAPE,
  parseDispositions,
  parseReviewReport,
  QUALITY_REVIEW_DIMENSIONS,
  SPEC_REVIEW_DIMENSIONS,
  validateDispositions,
  WORKER_PROTOCOL,
  WORKER_PROTOCOL_MECHANICS,
} from "./review";
export { createFinishState, deserializeFinishState, serializeFinishState } from "./state";
export type { FinishPhaseState, FinishState, FinishStateInit, FinishStatus } from "./state";
export type {
  AcceptanceGateResult,
  Finding,
  FindingDisposition,
  FinishPhase,
  FinishResult,
  FinishRound,
  FinishTimeouts,
  QualityGateResult,
  ReviewReport,
  Touchpoint,
} from "./types";
