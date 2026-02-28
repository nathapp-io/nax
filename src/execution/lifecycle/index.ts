/**
 * Lifecycle module exports
 */

export { RunLifecycle, type SetupResult, type TeardownOptions } from "./run-lifecycle";
export { runAcceptanceLoop, type AcceptanceLoopContext, type AcceptanceLoopResult } from "./acceptance-loop";
export { emitStoryComplete, type StoryCompleteEvent } from "./story-hooks";
export { outputRunHeader, outputRunFooter, type RunHeaderOptions, type RunFooterOptions } from "./headless-formatter";
export { handleParallelCompletion, type ParallelCompletionOptions } from "./parallel-lifecycle";
export { handleRunCompletion, type RunCompletionOptions, type RunCompletionResult } from "./run-completion";
export { cleanupRun, type RunCleanupOptions } from "./run-cleanup";
export { setupRun, type RunSetupOptions, type RunSetupResult } from "./run-setup";
