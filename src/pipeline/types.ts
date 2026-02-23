/**
 * Pipeline Framework Types
 *
 * Composable stage-based execution pipeline for refactoring the monolithic runner.
 */

import type { NaxConfig } from "../config/schema";
import type { PRD, UserStory } from "../prd/types";
import type { AgentResult } from "../agents/types";
import type { ReviewResult } from "../review/types";
import type { HooksConfig } from "../hooks/types";
import type { ConstitutionResult } from "../constitution/types";
import type { StoryMetrics } from "../metrics/types";
import type { BuiltContext } from "../context/types";
import type { PluginRegistry } from "../plugins/registry";

/**
 * Routing result from complexity classification
 */
export interface RoutingResult {
  /** Classified complexity */
  complexity: "simple" | "medium" | "complex" | "expert";
  /** Selected model tier */
  modelTier: "fast" | "balanced" | "powerful";
  /** Test strategy */
  testStrategy: "test-after" | "three-session-tdd";
  /** Reasoning for the classification */
  reasoning: string;
  /** Estimated cost for this story */
  estimatedCost?: number;
}

/**
 * Pipeline context — shared state passed through all stages.
 *
 * Stages read from and write to this context. It accumulates data
 * as the pipeline progresses through each stage.
 *
 * @example
 * ```ts
 * const ctx: PipelineContext = {
 *   config: loadedConfig,
 *   prd: loadedPRD,
 *   story: currentStory,
 *   stories: [currentStory],
 *   routing: { complexity: "simple", modelTier: "fast", ... },
 *   workdir: "/home/user/project",
 *   hooks: loadedHooks,
 * };
 * ```
 */
export interface PipelineContext {
  /** Ngent configuration */
  config: NaxConfig;
  /** Full PRD document */
  prd: PRD;
  /** Current story (or batch leader) */
  story: UserStory;
  /** Batch of stories (length 1 for single-story execution) */
  stories: UserStory[];
  /** Routing result from complexity classification */
  routing: RoutingResult;
  /** Working directory (project root) */
  workdir: string;
  /** Feature directory (optional, e.g., nax/features/my-feature/) */
  featureDir?: string;
  /** Hooks configuration */
  hooks: HooksConfig;
  /** Plugin registry (optional, for plugin-provided extensions) */
  pluginRegistry?: PluginRegistry;
  /** Constitution result (set by constitutionStage) */
  constitution?: ConstitutionResult;
  /** Context markdown for the agent (set by contextStage) */
  contextMarkdown?: string;
  /** Built context with element-level token tracking (set by contextStage) */
  builtContext?: BuiltContext;
  /** Final prompt sent to agent (set by promptStage) */
  prompt?: string;
  /** Agent execution result (set by executionStage) */
  agentResult?: AgentResult;
  /** Review result (set by reviewStage) */
  reviewResult?: ReviewResult;
  /** Acceptance test failures (set by acceptanceStage) */
  acceptanceFailures?: {
    failedACs: string[];
    testOutput: string;
  };
  /** Story start timestamp (ISO string, set by runner before pipeline) */
  storyStartTime?: string;
  /** Collected story metrics (set by completionStage) */
  storyMetrics?: StoryMetrics[];
}

/**
 * Stage action — determines how the pipeline proceeds after a stage executes.
 */
export type StageAction =
  /** Continue to the next stage */
  | { action: "continue"; cost?: number }
  /** Skip this story (mark as skipped, don't run further stages) */
  | { action: "skip"; reason: string; cost?: number }
  /** Mark story as failed (don't run further stages) */
  | { action: "fail"; reason: string; cost?: number }
  /** Escalate to a higher tier and retry the pipeline */
  | { action: "escalate"; cost?: number }
  /** Pause execution (user intervention required via queue command) */
  | { action: "pause"; reason: string; cost?: number };

/**
 * Result returned by a pipeline stage after execution.
 */
export type StageResult = StageAction;

/**
 * A single pipeline stage.
 *
 * Stages are composable units of work that execute sequentially.
 * Each stage can read from and modify the pipeline context, then
 * return an action that determines whether to continue, skip, fail,
 * escalate, or pause.
 *
 * @example
 * ```ts
 * const routingStage: PipelineStage = {
 *   name: "routing",
 *   enabled: (ctx) => true,
 *   execute: async (ctx) => {
 *     const result = await classifyComplexity(ctx.story);
 *     ctx.routing = result;
 *     return { action: "continue" };
 *   },
 * };
 * ```
 */
export interface PipelineStage {
  /** Unique stage identifier (e.g., "routing", "execution", "review") */
  name: string;

  /**
   * Determines if this stage should run.
   *
   * If false, the stage is skipped and the pipeline continues to the next stage.
   *
   * @param ctx - Current pipeline context
   * @returns true if the stage should execute, false to skip
   */
  enabled: (ctx: PipelineContext) => boolean;

  /**
   * Execute the stage logic.
   *
   * Can read from and modify the pipeline context, then returns a result
   * that determines how the pipeline should proceed.
   *
   * @param ctx - Current pipeline context
   * @returns Stage result indicating next action
   */
  execute: (ctx: PipelineContext) => Promise<StageResult>;
}
