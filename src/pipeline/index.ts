/**
 * Pipeline Module
 *
 * Composable stage-based execution pipeline.
 */

export type {
  PipelineEvent,
  PipelineEventType,
  PostRunPhaseCompletedEvent,
  PostRunPhaseStartedEvent,
  RunCompletedEvent,
  StoryEscalatedEvent,
  StoryFailedEvent,
  StoryPhaseCompletedEvent,
  StorySkippedEvent,
  StoryStartedEvent,
  StoryStepEvent,
} from "./event-bus";
export { PipelineEventBus, pipelineEventBus } from "./event-bus";
export type { PipelineEvents, RunSummary } from "./events";
export { PipelineEventEmitter } from "./events";
export type { PipelineRunResult } from "./runner";
export { MAX_STAGE_RESETS, MAX_STAGE_RETRIES, runPipeline } from "./runner";
export { _scopeFilesDeps, resolveScopeFiles } from "./scope-files";
export { _executionDeps, executionStage } from "./stages";
export { _acceptanceSetupDeps, acceptanceSetupStage } from "./stages/acceptance-setup";
export type { ResolvedExecutionAgent } from "./stages/execution-helpers";
export { resolveExecutionAgent } from "./stages/execution-helpers";
export { queueCheckStage } from "./stages/queue-check";
export { wireReporters } from "./subscribers/reporters";
export type {
  PipelineContext,
  PipelineStage,
  RoutingResult,
  StageAction,
  StageResult,
} from "./types";
