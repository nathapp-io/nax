/**
 * Lifecycle module exports
 */

export { runAcceptanceLoop, type AcceptanceLoopContext, type AcceptanceLoopResult } from "./acceptance-loop";
export {
  outputRunHeader,
  outputRunFooter,
  outputAdvisoryFindingsSummary,
  type RunHeaderOptions,
  type RunFooterOptions,
} from "./headless-formatter";
export {
  handleRunCompletion,
  _runCompletionDeps,
  type RunCompletionOptions,
  type RunCompletionResult,
} from "./run-completion";
export { cleanupRun, type RunCleanupOptions } from "./run-cleanup";
export { setupRun, type RunSetupOptions, type RunSetupResult } from "./run-setup";
export {
  runDeferredRegression,
  findResponsibleStoryByTransition,
  _regressionDeps,
  type DeferredRegressionOptions,
  type DeferredRegressionResult,
  type StorySnapshot,
} from "./run-regression";
