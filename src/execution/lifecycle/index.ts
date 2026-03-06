/**
 * Lifecycle module exports
 */

export { runAcceptanceLoop, type AcceptanceLoopContext, type AcceptanceLoopResult } from "./acceptance-loop";
export { outputRunHeader, outputRunFooter, type RunHeaderOptions, type RunFooterOptions } from "./headless-formatter";
export { handleParallelCompletion, type ParallelCompletionOptions } from "./parallel-lifecycle";
export { handleRunCompletion, type RunCompletionOptions, type RunCompletionResult } from "./run-completion";
export { cleanupRun, type RunCleanupOptions } from "./run-cleanup";
export { setupRun, type RunSetupOptions, type RunSetupResult } from "./run-setup";
export { runDeferredRegression, type DeferredRegressionOptions, type DeferredRegressionResult } from "./run-regression";
