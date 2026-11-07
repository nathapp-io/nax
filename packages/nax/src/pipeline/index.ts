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
  WorkflowPublishedEvent,
  WorkflowStartedEvent,
  WorkflowStepEvent,
} from "./event-bus";
export { PipelineEventBus, pipelineEventBus } from "./event-bus";
export type { PipelineEvents, RunSummary } from "./events";
export { PipelineEventEmitter } from "./events";
export type { PipelineRunResult } from "./runner";
export { runPipeline } from "./runner";
export { _scopeFilesDeps, resolveScopeFiles } from "./scope-files";
export { queueCheckStage } from "./stages/queue-check";
export { wireReporters } from "./subscribers/reporters";
export type {
  PipelineContext,
  PipelineStage,
  RoutingResult,
  StageAction,
  StageResult,
} from "./types";
