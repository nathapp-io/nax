/**
 * Pipeline Stages
 *
 * Composable stages for the execution pipeline.
 * Each stage performs a specific step in story execution.
 */

import type { PipelineStage } from "../types";
import { acceptanceStage } from "./acceptance";
import { completionStage } from "./completion";
import { constitutionStage } from "./constitution";
import { contextStage } from "./context";
import { executionStage } from "./execution";
import { optimizerStage } from "./optimizer";
import { promptStage } from "./prompt";
import { queueCheckStage } from "./queue-check";
import { reviewStage } from "./review";
import { routingStage } from "./routing";
import { verifyStage } from "./verify";

/**
 * Default pipeline stages in execution order.
 *
 * This is the standard pipeline for executing a story:
 * 1. Check for queue commands (PAUSE/ABORT/SKIP)
 * 2. Route (classify complexity → model tier)
 * 3. Load constitution (project coding standards)
 * 4. Build context (gather relevant code/docs)
 * 5. Assemble prompt (story + context + constitution)
 * 6. Optimize prompt (reduce token usage)
 * 7. Execute agent session (TDD or test-after)
 * 8. Verify output (tests pass, build succeeds)
 * 9. Review (quality checks, linting, etc.)
 * 10. Mark complete (save PRD, fire hooks, log progress)
 * 11. Acceptance (run acceptance tests when all stories complete)
 */
export const defaultPipeline: PipelineStage[] = [
  queueCheckStage,
  routingStage,
  constitutionStage,
  contextStage,
  promptStage,
  optimizerStage,
  executionStage,
  verifyStage,
  reviewStage,
  completionStage,
  acceptanceStage,
];

// Re-export individual stages for custom pipeline construction
export { queueCheckStage } from "./queue-check";
export { routingStage } from "./routing";
export { constitutionStage } from "./constitution";
export { contextStage } from "./context";
export { promptStage } from "./prompt";
export { optimizerStage } from "./optimizer";
export { executionStage } from "./execution";
export { verifyStage } from "./verify";
export { reviewStage } from "./review";
export { completionStage } from "./completion";
export { acceptanceStage } from "./acceptance";
