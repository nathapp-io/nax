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
 */
export const defaultPipeline: PipelineStage[] = [
  queueCheckStage,
  routingStage,
  constitutionStage,
  contextStage,
  promptStage,
  optimizerStage,
  executionStage,
  completionStage,
];

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
export { completionStage } from "./completion";
export { acceptanceStage } from "./acceptance";
