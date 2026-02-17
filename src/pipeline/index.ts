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

export { runPipeline } from "./runner";
export type { PipelineRunResult } from "./runner";
