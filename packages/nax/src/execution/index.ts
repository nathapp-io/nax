export type { FailureCategory } from "../tdd/types";
export { groupStoriesIntoBatches, type StoryBatch } from "./batching";
export { _workflowResumeDeps, type ResumeMode } from "./checkpoint";
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
// US-001 public surface: feature-lock primitive must be importable from the
// execution barrel (matching `acquireLock` / `_lockDeps` / etc.) so tests and
// production callers can depend on the public barrel rather than reaching
// into the internal `./feature-lock` module. `_featureLockDeps` is the
// testability seam for the host / process-alive / rename overrides.
export {
  _featureLockDeps,
  acquireFeatureLock,
  type FeatureLockRecord,
  type FeatureLockResult,
  featureLockPath,
  isLockReclaimable,
  isLockSuspect,
  lockHost,
  releaseFeatureLock,
} from "./feature-lock";
export {
  _lockDeps,
  acquireLock,
  buildStoryContext,
  type ExecutionResult,
  formatProgress,
  getAllReadyStories,
  hookCtx,
  type LockAcquisitionResult,
  maybeGetContext,
  releaseLock,
  type StoryCounts,
} from "./helpers";
export { releaseHeavyPipelineContext } from "./iteration-runner";
export {
  _runCleanupDeps,
  _runCompletionDeps,
  type BackfillMetricArgs,
  cleanupRun,
  handleRunCompletion,
  isExecutionFailure,
  outputAdvisoryFindingsSummary,
  outputMutationSummary,
  type RunCleanupOptions,
  type RunCompletionOptions,
  type RunCompletionResult,
  synthesizeBackfillMetric,
} from "./lifecycle";
export type { NbfWorthCheckRequest } from "./nbf-worth-check";
export { _nbfWorthCheckDeps, runNbfWorthCheck } from "./nbf-worth-check";
export { _newPackageSetupDeps, markNewPackageDirs, maybeRunNewPackageSetup } from "./new-package-setup";
export { countOscillationOutcomes, getOscillations, recordOscillations } from "./oscillation-store";
export { _pidRegistryDeps, PidRegistry } from "./pid-registry";
export {
  _resultHandlerDeps,
  handlePipelineFailure,
  handlePipelineSuccess,
  type PipelineFailureResult,
  type PipelineHandlerContext,
  type PipelineSuccessResult,
} from "./pipeline-result-handler";
export { appendProgress } from "./progress";
export type { BatchQueueDrainResult } from "./queue-handler";
export { clearQueueFile, drainQueueAtBatchBoundary, processQueueFile, readQueueFile } from "./queue-handler";
export {
  getReviewRecurrenceCount,
  type ReviewRecurrenceEntry,
  type ReviewRecurrenceStore,
  recordReviewFindings,
} from "./recurrence-store";
export type { RunOptions, RunResult } from "./runner";
export { _runnerDeps, _runnerReentrancyGuard, run } from "./runner";
export {
  _runnerCompletionDeps,
  type RunnerCompletionOptions,
  type RunnerCompletionResult,
  runCompletionPhase,
} from "./runner-completion";
export type { WorkflowStatusBlock } from "./status-file";
export { StatusWriter, type StatusWriterContext } from "./status-writer";
export {
  buildPhaseOutcomeLogData,
  formatPhaseResultMessage,
  logDeterministicPhaseOutcome,
} from "./story-orchestrator-logging";
export type { StoryRunResult } from "./types";
export { headsUpChannel } from "./uncategorised-advice";
// BUG-2 testability seam: re-export `executeUnified` + its `_deps`
// shim so test files can mutate `_unifiedExecutorDeps` via the barrel
// (alias-internals lint requires alias imports to target barrels, not
// internal files). `executeUnified` itself is also a legitimate part of
// the public surface — it's the main executor entry point.
export { _unifiedExecutorDeps, executeUnified } from "./unified-executor";
