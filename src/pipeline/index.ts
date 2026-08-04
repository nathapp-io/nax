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

export { resolveScopeFiles, _scopeFilesDeps } from "./scope-files";

export { PipelineEventEmitter } from "./events";
export type { PipelineEvents, RunSummary } from "./events";
export { executionStage, _executionDeps } from "./stages";
export { queueCheckStage } from "./stages/queue-check";
export { resolveExecutionAgent } from "./stages/execution-helpers";
export type { ResolvedExecutionAgent } from "./stages/execution-helpers";

export { acceptanceSetupStage, _acceptanceSetupDeps } from "./stages/acceptance-setup";

export { PipelineEventBus, pipelineEventBus } from "./event-bus";
export { wireReporters } from "./subscribers/reporters";
export type {
  PipelineEvent,
  PipelineEventType,
  RunCompletedEvent,
  StorySkippedEvent,
  StoryEscalatedEvent,
  StoryStartedEvent,
  StoryFailedEvent,
  StoryPhaseCompletedEvent,
  StoryStepEvent,
  PostRunPhaseStartedEvent,
  PostRunPhaseCompletedEvent,
} from "./event-bus";
