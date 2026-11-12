/**
 * Pipeline Framework Types
 *
 * Composable stage-based execution pipeline for refactoring the monolithic runner.
 */

import type { AgentResult } from "@/agents/types";
import type { NaxConfig } from "@/config/schema";
import type { ConstitutionResult } from "@/constitution/types";
import type { BuiltContext } from "@/context/types";
import type { HooksConfig } from "@/hooks/types";
import type { InteractionChain } from "@/interaction/chain";
import type { StoryMetrics } from "@/metrics/types";
import type { PluginRegistry } from "@/plugins/registry";
import type { PRD, UserStory } from "@/prd/types";
import type { DispatchContext } from "@/runtime/dispatch-context";
import type { StoryState } from "@/workflow/types";

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

export interface PipelineContext extends DispatchContext {
  workflowEndState?: StoryState;
  /** Reports live phases even in headless runs without an event emitter. */
  reportPhase?: (phase: string) => void;
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
   * agent.default (ADR-012), models, autoMode.escalation.
   */
  rootConfig: NaxConfig;
  /** Full PRD document */
  prd: PRD;
  /** Current story (or batch leader) */
  story: UserStory;
  /** Batch of stories (length 1 for single-story execution) */
  stories: UserStory[];
  /** Package directories for every story selected for this run, preserved across parallel workers. */
  runStoryWorkdirs?: readonly (string | undefined)[];
  /** Routing result from complexity classification */
  routing: RoutingResult;
  /**
   * Absolute path to the repository root where `.nax/` lives.
   * Never changes — stable in worktree mode (where workdir points to .nax-wt/<id>/)
   * and in monorepo mode (where workdir may be joined with story.workdir).
   */
  projectDir: string;
  /**
   * Agent-spawn working directory. Equals `projectDir` for single-package repos;
   * equals `join(projectDir, story.workdir)` in monorepo mode when the story targets
   * a sub-package. Providers and pipeline stages that need the repo root must use
   * `projectDir` — never re-join `story.workdir` onto this value.
   */
  workdir: string;
  /** Run-scoped pre-resolved .naxignore matcher index (repo-root + package-level). */
  naxIgnoreIndex?: import("../utils/path-filters").NaxIgnoreIndex;
  /**
   * Story-scoped ADR-009 test-file patterns, resolved once by the context stage
   * and reused by every later assembly. Carried here rather than re-resolved per
   * stage so later assembly performs no extra I/O; absent when the context
   * stage did not run or pattern resolution failed (providers then degrade by
   * skipping sibling-test hinting).
   */
  resolvedTestPatterns?: import("../test-runners/resolver").ResolvedTestPatterns;
  /**
   * Story-scoped scope-file evidence set, resolved once by the context stage
   * and reused by the prompt stage so `resolveScopeFiles` (git diff + ref
   * resolution) does not run twice per story.
   */
  scopeFiles?: string[];
  /** Absolute path to the prd.json file (used by routing stage to persist initial classification) */
  prdPath?: string;
  /** Feature directory (optional, e.g., nax/features/my-feature/) */
  featureDir?: string;
  /** Hooks configuration */
  hooks: HooksConfig;
  /** Plugin registry (optional, for plugin-provided extensions) */
  plugins?: PluginRegistry;
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
  // agentManager, sessionManager, runtime, abortSignal inherited from DispatchContext
  /**
   * Package-scoped view for the current story's package (ADR-018 Wave 1).
   * Use this for all op config slicing — ctx.packageView.select(selector).
   * Set once per story in iteration-runner.ts.
   */
  packageView?: import("../runtime").PackageView;
  /**
   * Per-run plugin-provider cache (Finding 5 / issue #473).
   * Constructed once in runner.ts and disposed at run completion.
   * When present, the context stage calls
   * pluginProviderCache.loadOrGet() instead of loadPluginProviders() so
   * providers are not re-imported and re-initialised on every assemble() call.
   */
  pluginProviderCache?: import("../context/engine").PluginProviderCache;
  /**
   * Per-run effectiveness provider-weights cache (nax-finish MEDIUM finding,
   * effectiveness-scoring-loop). Constructed once in runner.ts. When present,
   * the context stage calls
   * providerWeightsCache.loadOrGet() instead of loadFeatureManifests() +
   * deriveProviderWeights() directly, so a feature's manifests are read and
   * parsed once per run instead of once per story per stage. Invalidated by
   * annotateManifestEffectiveness after it persists a manifest's
   * chunkEffectiveness (the only field deriveProviderWeights reads), so the
   * next assembly picks up the fresh signal — assembly-time manifest writes
   * carry no chunkEffectiveness and must not discard the entry (PERF-1).
   */
  providerWeightsCache?: import("../context/engine").ProviderWeightsCache;
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
   * Written by verify and rectify; read by SessionScratchProvider via the
   * context request's storyScratchDirs.
   */
  sessionScratchDir?: string;
  /** Final prompt sent to agent (set by promptStage) */
  prompt?: string;
  /** Agent execution result (set by executionStage) */
  agentResult?: AgentResult;
  /** Story start timestamp (ISO string, set by runner before pipeline) */
  storyStartTime?: string;
  /** Git HEAD ref captured before agent ran this attempt (FEAT-010: precise smart-runner diff) */
  storyGitRef?: string;
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
  | { action: "escalate"; reason?: string; cost?: number }
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
