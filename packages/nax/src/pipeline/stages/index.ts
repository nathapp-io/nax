/**
 * Pipeline Stages
 *
 * Composable stages for the execution pipeline.
 * Each stage performs a specific step in story execution.
 */

import type { PipelineStage } from "../types";
import { acceptanceStage } from "./acceptance";
import { acceptanceSetupStage } from "./acceptance-setup";
import { completionStage } from "./completion";
import { constitutionStage } from "./constitution";
import { contextStage } from "./context";
import { executionStage } from "./execution";
import { optimizerStage } from "./optimizer";
import { promptStage } from "./prompt";
import { queueCheckStage } from "./queue-check";
import { routingStage } from "./routing";
import { workflowContextStage } from "./workflow-context";

/**
 * Default pipeline stages in execution order (issue #1116: regression stage removed — 8 stages).
 *
 * 1. Check for queue commands (PAUSE/ABORT/SKIP)
 * 2. Route (classify complexity → model tier)
 * 3. Load constitution (project coding standards)
 * 4. Build context (gather relevant code/docs)
 * 5. Assemble prompt (story + context + constitution)
 * 6. Optimize prompt (reduce token usage)
 * 7. Execute agent session (TDD or test-after, incl. verify/rectify/review/autofix)
 * 8. Mark complete (save PRD, fire hooks, log progress)
 *
 * Built lazily on first access — `stages/index.ts` is reached via
 * `execution.ts` → `@/execution` → … → `@/pipeline` → `stages` while
 * `execution.ts` is still mid-load, so a top-level literal that references
 * `executionStage` closes the cycle in a TDZ violation. The Proxy below
 * creates the array on first read and forwards every operation to the same
 * instance, so existing array-mutation callers (e.g. parallel-worker.test.ts)
 * keep working unchanged.
 */
function buildDefaultPipeline(): PipelineStage[] {
  return [
    queueCheckStage,
    routingStage,
    constitutionStage,
    contextStage,
    promptStage,
    optimizerStage,
    executionStage,
    completionStage,
  ];
}

/**
 * A5 workflow mode (spec §5.1): the prompt, optimizer and execution stages give way to
 * one workflow stage that builds its own prompts. Built lazily for the same TDZ reason
 * as the default pipeline. The stage body is a dynamic import, so src/workflow (which
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
 * US-004: workflow mode uses `workflowContextStage` in place of `contextStage`.
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

let _defaultPipeline: PipelineStage[] | undefined;
export function getDefaultPipeline(): PipelineStage[] {
  if (!_defaultPipeline) _defaultPipeline = buildDefaultPipeline();
  return _defaultPipeline;
}

export const defaultPipeline: PipelineStage[] = new Proxy([] as PipelineStage[], {
  get(_target, prop) {
    const arr = getDefaultPipeline();
    const value = Reflect.get(arr, prop);
    return typeof value === "function" ? value.bind(arr) : value;
  },
  set(_target, prop, value) {
    return Reflect.set(getDefaultPipeline(), prop, value);
  },
  has(_target, prop) {
    return Reflect.has(getDefaultPipeline(), prop);
  },
  deleteProperty(_target, prop) {
    return Reflect.deleteProperty(getDefaultPipeline(), prop);
  },
  ownKeys(_target) {
    return Reflect.ownKeys(getDefaultPipeline());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Reflect.getOwnPropertyDescriptor(getDefaultPipeline(), prop);
  },
});

/**
 * Post-run pipeline stages — run once after all per-story iterations complete.
 * Handles deferred regression and acceptance tests.
 */
export const postRunPipeline: PipelineStage[] = [acceptanceStage];

/**
 * Pre-run pipeline stages — run once before the per-story loop, after PRD is loaded.
 * Used for acceptance test setup (generation + RED gate).
 */
export const preRunPipeline: PipelineStage[] = [acceptanceSetupStage];

export { acceptanceStage } from "./acceptance";
export { _acceptanceSetupDeps, acceptanceSetupStage } from "./acceptance-setup";
export { _completionDeps, completionStage } from "./completion";
export { constitutionStage } from "./constitution";
export { _contextStageDeps, contextStage } from "./context";
export { _contextSessionDeps, allocateStorySession } from "./context-session";
export { _executionDeps, executionStage } from "./execution";
export { optimizerStage } from "./optimizer";
export { promptStage } from "./prompt";
// Re-export individual stages for custom pipeline construction
export { queueCheckStage } from "./queue-check";
export { routingStage } from "./routing";
export { _workflowContextStageDeps, workflowContextStage } from "./workflow-context";
