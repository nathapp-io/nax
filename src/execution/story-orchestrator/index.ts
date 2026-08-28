// Public API barrel — re-exports every symbol that story-orchestrator.ts previously exported.
// Internal files may import each other directly via relative leaf paths within this directory.

export { StoryOrchestratorBuilder } from "./builder";
export { ExecutionPlan } from "./execution-plan";
export {
  type CreateNbfFlakeTriageTransactionInput,
  createNbfFlakeTriageTransaction,
  type NbfFlakeTriageTransaction,
} from "./nbf-flake-triage";
export { withNoProgressBail } from "./no-progress-bail";
export {
  describeGateRegression,
  extractPhaseFindings,
  type GateRegressionDetail,
  type GateRegressionInput,
  gateFailureKeys,
  orderGateLast,
  phasePassed,
  phasesToRevalidate,
  selectRegressedGateFindings,
} from "./phase-eval";
export { gatherRectificationFindings, runRectification, type TriageResult, triageGateFindings } from "./rectification";
export { recordReviewRecurrencesForAttempt } from "./recurrence-recording";
export type { RepoScopedFixRecord } from "./repo-scoped-fix-record";
export { deriveRepoScopedFixes, REPO_SCOPED_STRATEGY_NAME, recordRepoScopedFixes } from "./repo-scoped-fix-record";
export { toReviewDecisionPayload } from "./review-decision";
export {
  classifyMissingReviewPhases,
  type ReviewPhaseReport,
  type ReviewPhaseReportInput,
} from "./review-phase-report";
export {
  _storyOrchestratorDeps,
  refreshReviewInputForDispatch,
  runPhase,
  withIncreasingFailuresBail,
} from "./run-phase";
export type {
  AnySlot,
  DroppedFindingSummary,
  InternalBuildState,
  InternalPhase,
  OrchestratorSlot,
  PhaseKind,
  RectificationOverrides,
  RectificationPhaseOptions,
  RectificationResult,
  ReviewDecisionPayload,
  StoryOrchestratorResult,
} from "./types";
export {
  CANONICAL_ORDER,
  EXHAUSTED_EXIT_REASONS,
  PHASE_KIND_TO_STATE_KEY,
  STRATEGY_TO_REVALIDATION_PHASES,
  STRICT_VERDICT_PHASE_NAMES,
  TDD_OP_NAMES,
} from "./types";
