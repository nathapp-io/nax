/**
 * Pipeline Stages
 *
 * Composable stages for the execution pipeline.
 * Each stage performs a specific step in story execution.
 */

import type { PipelineStage } from "../types";
import { completionStage } from "./completion";
import { constitutionStage } from "./constitution";
import { queueCheckStage } from "./queue-check";
import { routingStage } from "./routing";
import { workflowContextStage } from "./workflow-context";

/**
 * A5 workflow mode (spec §5.1): the story loop runs as one workflow stage that builds
 * its own prompts. The stage body is a dynamic import, so src/workflow (which
 * imports operations) adds no load-time edge here (check:import-cycles).
 */
const lazyWorkflowStage: PipelineStage = {
  name: "workflow",
  enabled: () => true,
  async execute(ctx) {
    const { workflowStage } = await import("@/workflow");
    return workflowStage.execute(ctx);
  },
};

/**
 * US-004: workflow mode uses `workflowContextStage` in place of the context stage.
 * It keeps the name "context" (the position is the same and callers key on the
 * name) but fetches only the feature context, without booting the v2
 * orchestrator whose pull tools were never called. `context.rules.delivery:
 * "push"` and v2-disabled runs delegate to `contextStage` inside the stage, so
 * both modes stay reachable from here.
 */
function buildWorkflowPipeline(): PipelineStage[] {
  return [queueCheckStage, routingStage, constitutionStage, workflowContextStage, lazyWorkflowStage, completionStage];
}

let _workflowPipeline: PipelineStage[] | undefined;
export function getWorkflowPipeline(): PipelineStage[] {
  if (!_workflowPipeline) _workflowPipeline = buildWorkflowPipeline();
  return _workflowPipeline;
}

export { _completionDeps, completionStage } from "./completion";
export { constitutionStage } from "./constitution";
export { _contextStageDeps, contextStage } from "./context";
export { _contextSessionDeps, allocateStorySession } from "./context-session";
export { promptStage } from "./prompt";
// Re-export individual stages for custom pipeline construction
export { queueCheckStage } from "./queue-check";
export { routingStage } from "./routing";
export { _workflowContextStageDeps, workflowContextStage } from "./workflow-context";
