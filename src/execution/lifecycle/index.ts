/**
 * Lifecycle module exports
 */

export {
  _runAcceptanceTestsOnceDeps,
  type AcceptanceLoopContext,
  type AcceptanceLoopResult,
  runAcceptanceLoop,
} from "./acceptance-loop";
export { type BackfillMetricArgs, synthesizeBackfillMetric } from "./backfill-story-metrics";
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
export { type RunSetupOptions, type RunSetupResult, setupRun } from "./run-setup";
