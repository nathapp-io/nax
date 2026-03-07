/**
 * Pipeline Stages
 *
 * Composable stages for the execution pipeline.
 * Each stage performs a specific step in story execution.
 */

import type { PipelineStage } from "../types";
import { acceptanceStage } from "./acceptance";
import { autofixStage } from "./autofix";
import { completionStage } from "./completion";
import { constitutionStage } from "./constitution";
import { contextStage } from "./context";
import { executionStage } from "./execution";
import { optimizerStage } from "./optimizer";
import { promptStage } from "./prompt";
import { queueCheckStage } from "./queue-check";
import { rectifyStage } from "./rectify";
import { regressionStage } from "./regression";
import { reviewStage } from "./review";
import { routingStage } from "./routing";
import { verifyStage } from "./verify";

/**
 * Default pipeline stages in execution order.
 *
 * New stage order (ADR-005 Phase 2):
 * 1.  Check for queue commands (PAUSE/ABORT/SKIP)
 * 2.  Route (classify complexity → model tier)
 * 3.  Load constitution (project coding standards)
 * 4.  Build context (gather relevant code/docs)
 * 5.  Assemble prompt (story + context + constitution)
 * 6.  Optimize prompt (reduce token usage)
 * 7.  Execute agent session (TDD or test-after)
 * 8.  Verify output (tests pass — scoped via smart-runner)
 * 9.  Rectify (fix test failures before escalating)
 * 10. Review (quality checks: lint, typecheck, format)
 * 11. Autofix (auto-fix lint/format before escalating)
 * 12. Regression (full-suite gate, inline mode only)
 * 13. Mark complete (save PRD, fire hooks, log progress)
 * 14. Acceptance (run AC tests when all stories complete)
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
  rectifyStage,
  reviewStage,
  autofixStage,
  regressionStage,
  completionStage,
];

/**
 * Post-run pipeline stages — run once after all per-story iterations complete.
 * Handles deferred regression and acceptance tests.
 */
export const postRunPipeline: PipelineStage[] = [acceptanceStage];

// Re-export individual stages for custom pipeline construction
export { queueCheckStage } from "./queue-check";
export { routingStage } from "./routing";
export { constitutionStage } from "./constitution";
export { contextStage } from "./context";
export { promptStage } from "./prompt";
export { optimizerStage } from "./optimizer";
export { executionStage } from "./execution";
export { verifyStage } from "./verify";
export { rectifyStage } from "./rectify";
export { reviewStage } from "./review";
export { autofixStage } from "./autofix";
export { regressionStage } from "./regression";
export { completionStage } from "./completion";
export { acceptanceStage } from "./acceptance";
