/** Shared finish helpers and result contracts used by workflow mode and `nax bot`. */

export {
  _finishGitDeps,
  commitAndPush,
  commitFixes,
  headSha,
  isDirty,
  PUSH_TIMEOUT_MS,
} from "./commit";
export type { GateRunRecord, GateRunStatus } from "./gates/quality";
export {
  _qualityGateDeps,
  classifyGateExit,
  DEFAULT_GATE_TAIL_LINES,
  DEFAULT_GATE_TIMEOUT_MS,
  GATE_ORDER,
  gateOutputTail,
  resolveGateCommands,
  runQualityGates,
} from "./gates/quality";
export type { LedgerEntry, LedgerState } from "./ledger";
export {
  buildAdvisorSection,
  escapeInline,
  escapeTableCell,
  openDraftFinishPr,
  openOrPromotePr,
  parseView,
  updatePrBody,
} from "./pr";
export { sanitizeTitle, TITLE_MAX_CHARS } from "./pr-title";
export type {
  AcceptanceFact,
  Finding,
  FindingDisposition,
  FinishPhase,
  FinishResult,
  FinishResultStatus,
  FinishRound,
  GateFact,
  HandoffLimit,
  QualityGateResult,
  ResolutionFacts,
  ReviewLens,
} from "./types";
