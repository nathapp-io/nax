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

// Re-export individual stages for custom pipeline construction
export { queueCheckStage } from "./queue-check";
export { routingStage } from "./routing";
export { constitutionStage } from "./constitution";
export { contextStage, _contextStageDeps } from "./context";
export { promptStage } from "./prompt";
export { optimizerStage } from "./optimizer";
export { executionStage, _executionDeps } from "./execution";
export { completionStage, _completionDeps } from "./completion";
export { acceptanceStage } from "./acceptance";
export { acceptanceSetupStage, _acceptanceSetupDeps } from "./acceptance-setup";
