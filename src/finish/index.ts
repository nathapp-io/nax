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
 * a deep relative import.
 */

export type { AuditTarget, FinishLedgerEntry, WriteResultOptions } from "./audit";
export {
  appendRound,
  ledgerPath,
  readLedger,
  readRounds,
  recordRound,
  resultPath,
  roundsPath,
  writeResult,
} from "./audit";
export {
  _finishGitDeps,
  buildCommitRound,
  commitAndPush,
  commitFixes,
  commitRoundOutcome,
  filesInCommit,
  headSha,
  PUSH_TIMEOUT_MS,
} from "./commit";
export type { CommitMessageCtx } from "./commit-message";
export { buildFixCommitMessage } from "./commit-message";
export type { FinishSettings } from "./config";
export { readFinishConfig } from "./config";
export type { FinishContext, LoadFinishContextOptions } from "./context";
export { _finishContextDeps, loadFinishContext } from "./context";
export type { EscalationOutcome } from "./escalate";
export { buildEscalationComment, postEscalation } from "./escalate";
export { _acceptanceGateDeps, runAcceptanceGate } from "./gates/acceptance";
export { _qualityGateDeps, resolveGateCommands, runQualityGates } from "./gates/quality";
export type { FinishMachineDeps } from "./machine";
export { runFinishMachine } from "./machine";
export {
  _notifyDeps,
  buildEscalationMessage,
  buildTerminalMessage,
  isTelegramConfigured,
  sendTelegramNotify,
  TELEGRAM_MAX_MESSAGE_CHARS,
  telegramCreds,
} from "./notify";
export type { FinishOps, FixOutcome, FixRequest, ReviewRequest } from "./ops";
export type { FinishOpsDeps } from "./ops-impl";
export { _finishOpsDeps, createFinishOps } from "./ops-impl";
export type { FinishPhaseContext, FinishSkipReason } from "./phase";
export { _finishPhaseDeps, finishSkipReason, runFinishPhase, shouldRunFinish } from "./phase";
export type { FinishPrContext, FinishPrStory, LoadPrContextArgs } from "./pr";
export {
  _finishPrDeps,
  buildFinishBody,
  buildFinishTitle,
  loadFinishPrContext,
  openDraftFinishPr,
  openOrPromotePr,
  parseView,
  updatePrBody,
} from "./pr";
export {
  parseTitle,
  resolveTitle,
  sanitizeTitle,
  TITLE_CLOSE_TAG,
  TITLE_MAX_CHARS,
  TITLE_OPEN_TAG,
} from "./pr-title";
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
export type { ReviewOutcome, RoutedReview } from "./route";
export {
  gateCommitRoute,
  MAX_FIX_ATTEMPTS,
  MAX_INCOMPLETE_ATTEMPTS,
  partitionTestFiles,
  routeAcceptance,
  routeQualityGates,
  routeReview,
} from "./route";
export type { FinishPhaseState, FinishState, FinishStateInit, FinishStatus } from "./state";
export { createFinishState, deserializeFinishState, serializeFinishState } from "./state";
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
