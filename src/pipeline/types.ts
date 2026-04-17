/**
 * Pipeline Framework Types
 *
 * Composable stage-based execution pipeline for refactoring the monolithic runner.
 */

import type { AgentResult } from "../agents/types";
import type { NaxConfig } from "../config/schema";
import type { ConstitutionResult } from "../constitution/types";
import type { BuiltContext } from "../context/types";
import type { PidRegistry } from "../execution/pid-registry";
import type { HooksConfig } from "../hooks/types";
import type { InteractionChain } from "../interaction/chain";
import type { StoryMetrics } from "../metrics/types";
import type { PluginRegistry } from "../plugins/registry";
import type { PRD, UserStory } from "../prd/types";
import type { ReviewResult } from "../review/types";
import type { FailureCategory } from "../tdd/types";
import type { VerifyResult } from "../verification/orchestrator-types";

/**
 * Routing result from complexity classification
 */
export interface RoutingResult {
  /** Classified complexity */
  complexity: "simple" | "medium" | "complex" | "expert";
  /** Selected model tier */
  modelTier: "fast" | "balanced" | "powerful";
  /** Test strategy */
  testStrategy: "no-test" | "test-after" | "tdd-simple" | "three-session-tdd" | "three-session-tdd-lite";
  /** Reasoning for the classification */
  reasoning: string;
  /** Estimated cost for this story */
  estimatedCost?: number;
  /** Agent override from story.routing.agent (PRD-level per-agent routing) */
  agent?: string;
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
export type AgentGetFn = (name: string) => import("../agents/types").AgentAdapter | undefined;

export interface PipelineContext {
  /**
   * Effective config for this story's package.
   * When story.workdir is set, this is root config merged with package config.
   * When no workdir, this equals rootConfig.
   * Set once per story in the iteration runner before pipeline execution.
   */
  config: NaxConfig;
  /**
   * Root-level NaxConfig loaded from .nax/config.json. Unmerged with package overrides.
   * Use only for fields that must reflect the global project config:
   * autoMode.defaultAgent, models, autoMode.escalation.
   */
  rootConfig: NaxConfig;
  /** Full PRD document */
  prd: PRD;
  /** Current story (or batch leader) */
  story: UserStory;
  /** Batch of stories (length 1 for single-story execution) */
  stories: UserStory[];
  /** Routing result from complexity classification */
  routing: RoutingResult;
  /**
   * Absolute path to the repository root where `.nax/` lives.
   * Never changes — stable in worktree mode (where workdir points to .nax-wt/<id>/)
   * and in monorepo mode (where workdir may be joined with story.workdir).
   */
  projectDir: string;
  /** Working directory (project root) */
  workdir: string;
  /** Absolute path to the prd.json file (used by routing stage to persist initial classification) */
  prdPath?: string;
  /** Feature directory (optional, e.g., nax/features/my-feature/) */
  featureDir?: string;
  /** Hooks configuration */
  hooks: HooksConfig;
  /** Plugin registry (optional, for plugin-provided extensions) */
  plugins?: PluginRegistry;
  /**
   * Protocol-aware agent resolver. When set (ACP mode), returns AcpAgentAdapter;
   * falls back to standalone getAgent (CLI mode) when absent.
   */
  agentGetFn?: AgentGetFn;
  /** PID registry for crash recovery — passed through to agent.run() for child process registration. */
  pidRegistry?: PidRegistry;
  /** Interaction chain (optional, for human-in-the-loop triggers) */
  interaction?: InteractionChain;
  /** Constitution result (set by constitutionStage) */
  constitution?: ConstitutionResult;
  /** Context markdown for the agent (set by contextStage) */
  contextMarkdown?: string;
  /** Raw (unfiltered) feature context markdown — populated by context stage, used by prompt builders */
  featureContextMarkdown?: string;
  /** Built context with element-level token tracking (set by contextStage) */
  builtContext?: BuiltContext;
  /**
   * v2 context bundle (set by contextStage when context.v2.enabled).
   * Contains pushMarkdown, digest, manifest, and packed chunks.
   * Prompt builders read bundle.pushMarkdown instead of featureContextMarkdown.
   */
  contextBundle?: import("../context/engine").ContextBundle;
  /** Shared per-run pull-tool call counter for context-engine tool budgets. */
  contextToolRunCounter?: import("../context/engine").RunCallCounter;
  /** In-process session registry for story-level scratch aggregation and session lifecycle. */
  sessionManager?: import("../session").ISessionManager;
  /**
   * nax session ID for the current story's main execution session.
   * Set by the execution stage after SessionManager.create().
   * Format: sess-<uuid>
   */
  sessionId?: string;
  /**
   * Absolute path to this pipeline run's session scratch directory.
   * Set by the context stage when config.context.v2.enabled is true.
   * Format: <projectDir>/.nax/features/<featureId>/sessions/<sessionId>/
   * Written by verify and rectify; read by SessionScratchProvider via storyScratchDirs.
   */
  sessionScratchDir?: string;
  /** Final prompt sent to agent (set by promptStage) */
  prompt?: string;
  /** Agent execution result (set by executionStage) */
  agentResult?: AgentResult;
  /** Verify result (set by verifyStage) */
  verifyResult?: VerifyResult;
  /** Review result (set by reviewStage) */
  reviewResult?: ReviewResult;
  /** Acceptance test failures (set by acceptanceStage) */
  acceptanceFailures?: {
    failedACs: string[];
    testOutput: string;
  };
  /** Story start timestamp (ISO string, set by runner before pipeline) */
  storyStartTime?: string;
  /** Tracks how many times the rectify stage has run this pipeline (for event attempt numbers). */
  rectifyAttempt?: number;
  /** Tracks how many times the autofix stage has run this pipeline (for event attempt numbers). */
  autofixAttempt?: number;
  /** Git HEAD ref captured before agent ran this attempt (FEAT-010: precise smart-runner diff) */
  storyGitRef?: string;
  /** Collected story metrics (set by completionStage) */
  storyMetrics?: StoryMetrics[];
  /** Whether to retry the story in lite mode after a failure */
  retryAsLite?: boolean;
  /** Results from acceptance-setup stage (set by acceptanceSetupStage) */
  acceptanceSetup?: {
    totalCriteria: number;
    testableCount: number;
    redFailCount: number;
  };
  /** Per-package acceptance test paths (set by acceptanceSetupStage for US-001/002) */
  acceptanceTestPaths?: Array<{ testPath: string; packageDir: string }>;
  /** Failure category from TDD orchestrator (set by executionStage on TDD failure) */
  tddFailureCategory?: FailureCategory;
  /** Set to true when TDD full-suite gate already passed — verify stage skips to avoid redundant run (BUG-054) */
  fullSuiteGatePassed?: boolean;
  /** Number of runtime crashes (RUNTIME_CRASH verify status) encountered for this story (BUG-070) */
  storyRuntimeCrashes?: number;
  /** Structured review findings from plugin reviewers — passed to escalation for retry context */
  reviewFindings?: import("../plugins/types").ReviewFinding[];
  /** Active reviewer-implementer dialogue session (set by reviewStage when dialogue.enabled) */
  reviewerSession?: import("../review/dialogue").ReviewerSession;
  /** Accumulated cost across all prior escalation attempts (BUG-067) */
  accumulatedAttemptCost?: number;
  /**
   * Number of agent-swap hops completed for this story (Phase 5.5).
   * Incremented by executionStage each time rebuildForSwap triggers a new agent.
   * Checked against config.context.v2.fallback.maxHopsPerStory to cap swaps.
   */
  agentSwapCount?: number;
  /**
   * Set of review check names that already passed in a previous review pass within this
   * pipeline run. When autofix retries from "review", checks in this set are skipped to
   * avoid redundant re-runs (e.g. a 45s semantic check after a lint-only fix). (#136)
   * Only checks that were NOT the cause of the retry are eligible to be skipped.
   */
  retrySkipChecks?: Set<string>;
  /**
   * True when only mechanical checks failed (build/typecheck/lint) but LLM checks
   * (semantic/adversarial) passed in the most recent review pass. Signals to autofix
   * that the code is functionally correct — UNRESOLVED should not trigger tier escalation
   * for mechanical failures in files the agent cannot modify (e.g. lint in test files).
   */
  mechanicalFailedOnly?: boolean;
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
  | { action: "escalate"; reason?: string; cost?: number }
  /** Pause execution (user intervention required via queue command) */
  | { action: "pause"; reason: string; cost?: number }
  /** Retry from a specific stage (used by rectify/autofix stages) */
  | { action: "retry"; fromStage: string; cost?: number };

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
   * Optional human-readable reason why the stage was skipped.
   * Distinguishes "not needed" (conditions not met) from "disabled" (config).
   * Used by the pipeline runner for better observability (BUG-055).
   */
  skipReason?: (ctx: PipelineContext) => string;

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
