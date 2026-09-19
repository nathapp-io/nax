/**
 * Lifecycle module exports
 */

export {
  _runAcceptanceTestsOnceDeps,
  type AcceptanceLoopContext,
  type AcceptanceLoopResult,
  runAcceptanceLoop,
} from "./acceptance-loop";
export {
  applyBackfill,
  type BackfillMetricArgs,
  backfillDomain,
  hasBackfillEvidence,
  isExecutionFailure,
  synthesizeBackfillMetric,
} from "./backfill-story-metrics";
export {
  outputAdvisoryFindingsSummary,
  outputMutationSummary,
  outputRunFooter,
  outputRunHeader,
  type RunFooterOptions,
  type RunHeaderOptions,
} from "./headless-formatter";
export { _runCleanupDeps, cleanupRun, type RunCleanupOptions } from "./run-cleanup";
export {
  _runCompletionDeps,
  handleRunCompletion,
  type RunCompletionOptions,
  type RunCompletionResult,
} from "./run-completion";
export {
  _regressionDeps,
  type DeferredRegressionOptions,
  type DeferredRegressionResult,
  findResponsibleStoryByTransition,
  runDeferredRegression,
  type StorySnapshot,
} from "./run-regression";
// Warnings re-exported here so consumers can reach them through the lifecycle
// barrel without reaching into run-setup.ts (or the leaf warnings module).
export {
  type RunSetupOptions,
  type RunSetupResult,
  setupRun,
  warnFallbackMisconfiguration,
  warnProfileMismatch,
} from "./run-setup";
export {
  type InitializeAfterLockDeps,
  type InitializeAfterLockOptions,
  type InitializeAfterLockResult,
  initializeAfterLock,
} from "./run-setup-init";
