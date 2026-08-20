export type { RunOptions, RunResult } from "./runner";
export { recordOscillations, getOscillations, countOscillationOutcomes } from "./oscillation-store";
export { inspectOscillationBreaker, type BreakerDecision } from "./oscillation-breaker";
export { run, _runnerDeps, _runnerReentrancyGuard } from "./runner";
export type { FailureCategory } from "../tdd/types";
export { appendProgress } from "./progress";
export { releaseHeavyPipelineContext } from "./iteration-runner";
export { groupStoriesIntoBatches, type StoryBatch } from "./batching";
export { escalateTier, getTierConfig, calculateMaxIterations, resolveMaxAttemptsOutcome } from "./escalation";
export { readQueueFile, clearQueueFile, processQueueFile } from "./queue-handler";
export { StatusWriter, type StatusWriterContext } from "./status-writer";
export { ensureStoryPackageDirs } from "./ensure-package-dirs";
export { _newPackageSetupDeps, markNewPackageDirs, maybeRunNewPackageSetup } from "./new-package-setup";
export {
  hookCtx,
  maybeGetContext,
  buildStoryContext,
  getAllReadyStories,
  acquireLock,
  releaseLock,
  _lockDeps,
  formatProgress,
  type ExecutionResult,
  type StoryCounts,
} from "./helpers";
export {
  installCrashHandlers,
  startHeartbeat,
  stopHeartbeat,
  writeExitSummary,
  resetCrashHandlers,
  type CrashRecoveryContext,
} from "./crash-recovery";
export { PidRegistry, _pidRegistryDeps } from "./pid-registry";
export {
  runDeferredRegression,
  findResponsibleStoryByTransition,
  _regressionDeps,
  handleRunCompletion,
  _runCompletionDeps,
  outputAdvisoryFindingsSummary,
  outputMutationSummary,
  synthesizeBackfillMetric,
  type BackfillMetricArgs,
  type DeferredRegressionOptions,
  type DeferredRegressionResult,
  type StorySnapshot,
  type RunCompletionOptions,
  type RunCompletionResult,
  cleanupRun,
  _runCleanupDeps,
  type RunCleanupOptions,
} from "./lifecycle";
export {
  StoryOrchestratorBuilder,
  ExecutionPlan,
  _storyOrchestratorDeps,
  runPhase,
  runRectification,
  CANONICAL_ORDER,
  EXHAUSTED_EXIT_REASONS,
  PHASE_KIND_TO_STATE_KEY,
  STRICT_VERDICT_PHASE_NAMES,
  phasesToRevalidate,
  orderGateLast,
  gateFailureKeys,
  describeGateRegression,
  selectRegressedGateFindings,
  createNbfFlakeTriageTransaction,
  refreshReviewInputForDispatch,
  withNoProgressBail,
  withIncreasingFailuresBail,
  extractPhaseFindings,
  phasePassed,
  toReviewDecisionPayload,
  type GateRegressionDetail,
  type GateRegressionInput,
  type InternalBuildState,
  type NbfFlakeTriageTransaction,
  type OrchestratorSlot,
  type PhaseKind,
  type RectificationOverrides,
  type RectificationPhaseOptions,
  type StoryOrchestratorResult,
} from "./story-orchestrator";
export {
  buildPhaseOutcomeLogData,
  formatPhaseResultMessage,
  logDeterministicPhaseOutcome,
} from "./story-orchestrator-logging";
export { assemblePlanInputs, assemblePlanInputsFromCtx, type PlanInputs } from "./plan-inputs";
export {
  handlePipelineFailure,
  handlePipelineSuccess,
  _resultHandlerDeps,
  type PipelineHandlerContext,
  type PipelineSuccessResult,
  type PipelineFailureResult,
} from "./pipeline-result-handler";
export { runNonBlockingFix } from "./non-blocking-fix";
export { buildPlanForStrategy, resolveStoryPathAnchors } from "./build-plan-for-strategy";
export {
  CheckpointWriter,
  createCheckpointWriter,
  loadCheckpoints,
  buildResumePlan,
  buildCheckpointLogData,
  captureTreeState,
  hydrateFromResumePlan,
  applyResumeModeDeps,
  type ResumePlan,
  type ResumeMode,
  type CaptureTreeStateDeps,
  type CaptureTreeStateOptions,
  type CheckpointRecord,
  type CheckpointReaderDeps,
  type CheckpointWriterDeps,
  type CheckpointWriterOptions,
  type StoryCheckpoint,
  type TreeState,
} from "./checkpoint";
export type { StoryRunResult } from "./types";
// BUG-2 testability seam: re-export `executeUnified` + its `_deps`
// shim so test files can mutate `_unifiedExecutorDeps` via the barrel
// (alias-internals lint requires alias imports to target barrels, not
// internal files). `executeUnified` itself is also a legitimate part of
// the public surface — it's the main executor entry point.
export { executeUnified, _unifiedExecutorDeps } from "./unified-executor";
export {
  runCompletionPhase,
  _runnerCompletionDeps,
  type RunnerCompletionOptions,
  type RunnerCompletionResult,
} from "./runner-completion";
export {
  applyPostRunInspection,
  decideStageAction,
  extractPauseReason,
  deriveTddFailureCategory,
  _postRunDeps,
  type PostRunInspectionResult,
  type InspectionOptions,
} from "./post-run";
export { buildPreviewRouting } from "./executor-types";
export { requiresInitialRefCapture } from "./build-plan-for-strategy";
