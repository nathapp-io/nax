export type { RunOptions, RunResult } from "./runner";
export { run } from "./runner";
export type { FailureCategory } from "../tdd/types";
export { appendProgress } from "./progress";
export { groupStoriesIntoBatches, type StoryBatch } from "./batching";
export { escalateTier, getTierConfig, calculateMaxIterations } from "./escalation";
export { readQueueFile, clearQueueFile } from "./queue-handler";
export {
  hookCtx,
  maybeGetContext,
  buildStoryContext,
  getAllReadyStories,
  acquireLock,
  releaseLock,
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
  _regressionDeps,
  handleRunCompletion,
  _runCompletionDeps,
  type DeferredRegressionOptions,
  type DeferredRegressionResult,
  type RunCompletionOptions,
  type RunCompletionResult,
} from "./lifecycle";
