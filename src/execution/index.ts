export type { FailureCategory } from "../tdd/types";
export { groupStoriesIntoBatches, type StoryBatch } from "./batching";
export { buildPlanForStrategy, requiresInitialRefCapture, resolveStoryPathAnchors } from "./build-plan-for-strategy";
export {
  applyResumeModeDeps,
  buildCheckpointLogData,
  buildResumePlan,
  type CaptureTreeStateDeps,
  type CaptureTreeStateOptions,
  type CheckpointReaderDeps,
  type CheckpointRecord,
  CheckpointWriter,
  type CheckpointWriterDeps,
  type CheckpointWriterOptions,
  captureTreeState,
  createCheckpointWriter,
  hydrateFromResumePlan,
  loadCheckpoints,
  type ResumeMode,
  type ResumePlan,
  type StoryCheckpoint,
  type TreeState,
} from "./checkpoint";
export {
  type CrashRecoveryContext,
  installCrashHandlers,
  resetCrashHandlers,
  startHeartbeat,
  stopHeartbeat,
  writeExitSummary,
} from "./crash-recovery";
export { ensureStoryPackageDirs } from "./ensure-package-dirs";
export { calculateMaxIterations, escalateTier, getTierConfig, resolveMaxAttemptsOutcome } from "./escalation";
export { buildPreviewRouting } from "./executor-types";
export {
  _lockDeps,
  acquireLock,
  buildStoryContext,
  type ExecutionResult,
  formatProgress,
  getAllReadyStories,
  hookCtx,
  maybeGetContext,
  releaseLock,
  type StoryCounts,
} from "./helpers";
export { releaseHeavyPipelineContext } from "./iteration-runner";
export {
  _regressionDeps,
  _runCleanupDeps,
  _runCompletionDeps,
  type BackfillMetricArgs,
  cleanupRun,
  type DeferredRegressionOptions,
  type DeferredRegressionResult,
  findResponsibleStoryByTransition,
  handleRunCompletion,
  isExecutionFailure,
  outputAdvisoryFindingsSummary,
  outputMutationSummary,
  type RunCleanupOptions,
  type RunCompletionOptions,
  type RunCompletionResult,
  runDeferredRegression,
  type StorySnapshot,
  synthesizeBackfillMetric,
} from "./lifecycle";
export { _newPackageSetupDeps, markNewPackageDirs, maybeRunNewPackageSetup } from "./new-package-setup";
export { runNonBlockingFix } from "./non-blocking-fix";
export { type BreakerDecision, inspectOscillationBreaker } from "./oscillation-breaker";
export { countOscillationOutcomes, getOscillations, recordOscillations } from "./oscillation-store";
export { type ParallelStoryMetricArgs, synthesizeParallelStoryMetric } from "./parallel-story-metrics";
export { _pidRegistryDeps, PidRegistry } from "./pid-registry";
export {
  _resultHandlerDeps,
  handlePipelineFailure,
  handlePipelineSuccess,
  type PipelineFailureResult,
  type PipelineHandlerContext,
  type PipelineSuccessResult,
} from "./pipeline-result-handler";
export { assemblePlanInputs, assemblePlanInputsFromCtx, type PlanInputs } from "./plan-inputs";
export {
  _postRunDeps,
  applyPostRunInspection,
  decideStageAction,
  deriveTddFailureCategory,
  extractPauseReason,
  type InspectionOptions,
  type PostRunInspectionResult,
} from "./post-run";
export { appendProgress } from "./progress";
export type { BatchQueueDrainResult } from "./queue-handler";
export { clearQueueFile, drainQueueAtBatchBoundary, processQueueFile, readQueueFile } from "./queue-handler";
export type { RunOptions, RunResult } from "./runner";
export { _runnerDeps, _runnerReentrancyGuard, run } from "./runner";
export {
  _runnerCompletionDeps,
  type RunnerCompletionOptions,
  type RunnerCompletionResult,
  runCompletionPhase,
} from "./runner-completion";
export { StatusWriter, type StatusWriterContext } from "./status-writer";
export {
  _storyOrchestratorDeps,
  CANONICAL_ORDER,
  createNbfFlakeTriageTransaction,
  deriveRepoScopedFixes,
  describeGateRegression,
  EXHAUSTED_EXIT_REASONS,
  ExecutionPlan,
  extractPhaseFindings,
  type GateRegressionDetail,
  type GateRegressionInput,
  gateFailureKeys,
  type InternalBuildState,
  type NbfFlakeTriageTransaction,
  type OrchestratorSlot,
  orderGateLast,
  PHASE_KIND_TO_STATE_KEY,
  type PhaseKind,
  phasePassed,
  phasesToRevalidate,
  REPO_SCOPED_STRATEGY_NAME,
  type RectificationOverrides,
  type RectificationPhaseOptions,
  type RepoScopedFixRecord,
  recordRepoScopedFixes,
  refreshReviewInputForDispatch,
  runPhase,
  runRectification,
  STRICT_VERDICT_PHASE_NAMES,
  StoryOrchestratorBuilder,
  type StoryOrchestratorResult,
  selectRegressedGateFindings,
  toReviewDecisionPayload,
  withIncreasingFailuresBail,
  withNoProgressBail,
} from "./story-orchestrator";
export {
  buildPhaseOutcomeLogData,
  formatPhaseResultMessage,
  logDeterministicPhaseOutcome,
} from "./story-orchestrator-logging";
export type { StoryRunResult } from "./types";
// BUG-2 testability seam: re-export `executeUnified` + its `_deps`
// shim so test files can mutate `_unifiedExecutorDeps` via the barrel
// (alias-internals lint requires alias imports to target barrels, not
// internal files). `executeUnified` itself is also a legitimate part of
// the public surface — it's the main executor entry point.
export { _unifiedExecutorDeps, executeUnified } from "./unified-executor";
