/**
 * Pipeline Module
 *
 * Composable stage-based execution pipeline.
 */

export type {
  PipelineContext,
  PipelineStage,
  StageResult,
  StageAction,
  RoutingResult,
} from "./types";

export { runPipeline, MAX_STAGE_RETRIES, MAX_STAGE_RESETS } from "./runner";
export type { PipelineRunResult } from "./runner";

export { PipelineEventEmitter } from "./events";
export type { PipelineEvents, RunSummary } from "./events";
export { executionStage, _executionDeps } from "./stages";

export { pipelineEventBus } from "./event-bus";
export type {
  PipelineEvent,
  PipelineEventType,
  RunCompletedEvent,
  StorySkippedEvent,
  StoryEscalatedEvent,
  StoryStartedEvent,
  StoryFailedEvent,
  StoryStepEvent,
  PostRunPhaseStartedEvent,
  PostRunPhaseCompletedEvent,
} from "./event-bus";
