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

export type { A3Hint } from "./a3-hints";
export { _a3HintsDeps, readA3Hints } from "./a3-hints";
export type { AcBlock, AcceptanceFile, PinnedAc } from "./acceptance-evidence";
export {
  _acceptanceEvidenceDeps,
  EXCERPT_LINES,
  findingIdentifiers,
  findPinnedAcs,
  loadAcceptanceFiles,
  MAX_PINNED_BLOCKS,
  splitAcBlocks,
} from "./acceptance-evidence";
export {
  type AdviceRef,
  buildFinishAdvisorForPhase,
  createFinishAdvisor,
  type FinishAdvisor,
  type FinishAdvisorDeps,
  type JudgedResult,
  judgeWithoutAdvisor,
} from "./advise";
export { concatJudged, emptyJudged } from "./advise-core";
export { MAX_NEAR_MATCH_QUESTIONS } from "./advise-rulings";
export type { AuditTarget, FinishLedgerEntry, WriteResultOptions } from "./audit";
export {
  appendRound,
  LEDGER_TERMINAL_STATUSES,
  ledgerPath,
  readLedger,
  readRounds,
  recordRound,
  resultPath,
  roundsPath,
  writeResult,
} from "./audit";
export { changedFiles } from "./changed-files";
export { _checkpointDeps, checkpointPath, writeCheckpoint } from "./checkpoint";
export {
  _finishGitDeps,
  buildCommitRound,
  commitAndPush,
  commitFixes,
  commitRoundOutcome,
  filesInCommit,
  headSha,
  isDirty,
  PUSH_TIMEOUT_MS,
} from "./commit";
export type { CommitMessageCtx } from "./commit-message";
export { buildFixCommitMessage } from "./commit-message";
export type { FinishSettings } from "./config";
export { readFinishConfig } from "./config";
export type { FinishContext, LoadFinishContextOptions } from "./context";
export { _finishContextDeps, loadFinishContext } from "./context";
export { _acceptanceGateDeps, runAcceptanceGate } from "./gates/acceptance";
export { _qualityGateDeps, resolveGateCommands, runQualityGates } from "./gates/quality";
export type { LedgerEntry, LedgerState } from "./ledger";
export type { FinishMachineDeps } from "./machine";
export { runFinishMachine } from "./machine";
export type { Contradiction, MergedFindings } from "./merge-findings";
export { mergeFindings } from "./merge-findings";
export {
  _notifyDeps,
  buildDraftMessage,
  buildTerminalMessage,
  isTelegramConfigured,
  sendTelegramNotify,
  TELEGRAM_MAX_MESSAGE_CHARS,
  telegramCreds,
} from "./notify";
export type { FinishOps, FixOutcome, FixPhase, FixRequest, ReviewInputs } from "./ops";
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
  resolveTitle,
  sanitizeTitle,
  TITLE_MAX_CHARS,
} from "./pr-title";
export type { ApprovalAction, Resolution } from "./resolve";
export { approvalFacts, computeFacts, draftReason, isClean, resolve } from "./resolve";
export { _reviewInputsDeps, loadReviewInputs, storiesFromText } from "./review-inputs";
export { isFinishReviewShape, MISSING_REVIEW, parseFinishReviewReply } from "./review-json";
export type { ReviewLoopDeps } from "./review-loop";
export { MAX_ADVISE_ROUNDS, runReviewLoop } from "./review-loop";
export type { ReviewRoundResult } from "./review-round";
export { runReviewRound } from "./review-round";
export {
  acceptanceFact,
  gateCommitRoute,
  gateFacts,
  MAX_FIX_ATTEMPTS,
  MAX_REVIEW_ROUNDS,
  partitionTestFiles,
  routeAcceptance,
  routeQualityGates,
} from "./route";
export {
  checkRulings,
  matchLevel,
  normTitle,
  type Ruling,
  type RulingCheck,
  rulingFromDecision,
  rulingFromDropped,
  splitForRulings,
} from "./ruling-check";
export {
  _setAsideDeps,
  captureFixBase,
  handoffDir,
  markHandoffConsumed,
  readHandoffNote,
  reapplyHandoff,
  restoreUntracked,
  setAside,
  snapshotUntracked,
  UNTRACKED_FILE_MAX,
  UNTRACKED_TOTAL_MAX,
} from "./set-aside";
export type { FinishPhaseState, FinishState, FinishStateInit, FinishStatus, ReviewLoopState } from "./state";
export { createFinishState, deserializeFinishState, serializeFinishState } from "./state";
export type {
  AcceptanceFact,
  AcceptanceGateResult,
  Finding,
  FindingDisposition,
  FinishPhase,
  FinishResolution,
  FinishResult,
  FinishResultStatus,
  FinishReviewOutput,
  FinishRound,
  FinishTimeouts,
  FixBase,
  GateFact,
  HandoffLimit,
  HandoffRecord,
  QualityGateResult,
  ResolutionFacts,
  ReviewLens,
  UntrackedEntry,
  UntrackedSnapshot,
} from "./types";
