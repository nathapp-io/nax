/**
 * Plugin extension types
 *
 * Defines interfaces for specific plugin extensions that can be provided.
 */

import type { UserStory } from "../prd/types";
import type { PluginLogger } from "./types";

// ============================================================================
// Review Extension
// ============================================================================

/**
 * A single structured finding from a review check.
 *
 * Designed to be service-agnostic — works with Semgrep, ESLint, SonarQube,
 * Snyk, CodeQL, and other SAST/DAST/linting tools.
 */
export interface ReviewFinding {
  /** Rule or check ID (e.g., "detect-non-literal-regexp", "no-unused-vars") */
  ruleId: string;
  /** Severity level (tool-agnostic scale) */
  severity: "critical" | "error" | "warning" | "info" | "low";
  /** File path (relative to workdir) */
  file: string;
  /** Line number (1-indexed) */
  line: number;
  /** Column number (1-indexed, optional) */
  column?: number;
  /** End line number (optional, for multi-line findings) */
  endLine?: number;
  /** End column number (optional) */
  endColumn?: number;
  /** Human-readable message */
  message: string;
  /** Optional URL for rule documentation or details */
  url?: string;
  /** Source tool that produced this finding (e.g., "semgrep", "eslint", "snyk") */
  source?: string;
  /** Finding category (e.g., "security", "performance", "style", "bug") */
  category?: string;
}

/**
 * Result from a review check.
 */
export interface ReviewCheckResult {
  /** Whether the review check passed */
  passed: boolean;
  /** Human-readable output or error messages */
  output: string;
  /** Exit code from the check process (if applicable) */
  exitCode?: number;
  /** Structured findings (optional — plugins can provide machine-readable results) */
  findings?: ReviewFinding[];
}

/**
 * Review plugin interface.
 *
 * Review plugins run custom checks after agent execution (e.g., security scans,
 * license checks, performance tests). Failures trigger retry/escalation.
 *
 * @example
 * ```ts
 * const reviewer: IReviewPlugin = {
 *   name: "security-scan",
 *   description: "Scans for security vulnerabilities",
 *   async check(workdir, changedFiles) {
 *     const result = await securityScanner.scan(workdir, changedFiles);
 *     return {
 *       passed: result.vulnerabilities.length === 0,
 *       output: result.report
 *     };
 *   }
 * };
 * ```
 */
export interface IReviewPlugin {
  /** Check name (e.g., "security-scan", "license-check") */
  name: string;

  /** Human-readable description */
  description: string;

  /**
   * Run the review check against the working directory.
   *
   * @param workdir - Project root directory
   * @param changedFiles - Files modified by the agent in this story
   * @returns Review check result
   */
  check(workdir: string, changedFiles: string[]): Promise<ReviewCheckResult>;
}

// ============================================================================
// Context Provider Extension
// ============================================================================

/**
 * Result from a context provider.
 */
export interface ContextProviderResult {
  /** Markdown content to inject */
  content: string;
  /** Token estimate for budget tracking */
  estimatedTokens: number;
  /** Section label in the prompt (e.g., "Jira Context") */
  label: string;
}

/**
 * Context provider interface.
 *
 * Context providers fetch external data (Jira tickets, Confluence docs,
 * Linear issues, etc.) and inject it into agent prompts.
 *
 * @example
 * ```ts
 * const provider: IContextProvider = {
 *   name: "jira",
 *   async getContext(story) {
 *     const ticket = await jiraApi.getTicket(story.tags[0]);
 *     return {
 *       content: `## ${ticket.key}\n\n${ticket.description}`,
 *       estimatedTokens: estimateTokens(ticket.description),
 *       label: "Jira Context"
 *     };
 *   }
 * };
 * ```
 */
export interface IContextProvider {
  /** Provider name (e.g., "jira", "linear", "confluence") */
  name: string;

  /**
   * Fetch external context relevant to a story.
   *
   * **Concurrency contract:** In parallel-story mode, a single cached provider
   * instance is shared across all concurrently running stories. Implementations
   * must be safe to call concurrently (no shared mutable state keyed on story,
   * or guarded by a lock if state is required).
   *
   * @param story - The user story being executed
   * @returns Markdown content to inject into the agent prompt
   */
  getContext(story: UserStory): Promise<ContextProviderResult>;
}

// ============================================================================
// Post-Run Action Extension
// ============================================================================

/**
 * Result from a post-run action.
 */
export interface PostRunActionResult {
  /** Whether the action succeeded */
  success: boolean;

  /** Human-readable message about the result */
  message: string;

  /** Optional URL for result details or reports */
  url?: string;

  /** Whether the action was skipped */
  skipped?: boolean;

  /** Reason for skipping or failure */
  reason?: string;
}

/**
 * Context provided to post-run actions with run metadata.
 */
export interface PostRunContext {
  /** Unique run identifier */
  runId: string;

  /** Feature name being worked on */
  feature: string;

  /** Working directory path */
  workdir: string;

  /** Path to the PRD file */
  prdPath: string;

  /** Git branch name */
  branch: string;

  /** Total run duration in milliseconds */
  totalDurationMs: number;

  /** Total cost of the run */
  totalCost: number;

  /** Summary of story completion status */
  storySummary: {
    completed: number;
    failed: number;
    skipped: number;
    paused: number;
  };

  /** All stories that were executed */
  stories: UserStory[];

  /** Version of nax or the feature */
  version: string;

  /** Plugin-specific configuration */
  pluginConfig: Record<string, unknown>;

  /** Write-only logger scoped to this plugin */
  logger: PluginLogger;

  /** Project output directory (for curator and other plugins) — optional for backward compatibility */
  outputDir?: string;

  /** Global output directory (for curator and other plugins) — optional for backward compatibility */
  globalDir?: string;

  /** Project key (for curator and other plugins) — optional for backward compatibility */
  projectKey?: string;

  /** Path to curator rollup file (for curator plugin) — optional for backward compatibility */
  curatorRollupPath?: string;

  /** Path to active run JSONL (for curator and other plugins) — optional for backward compatibility */
  logFilePath?: string;

  /** Full nax config (for curator and other plugins) — optional for backward compatibility */
  config?: unknown;
}

/**
 * Post-run action interface.
 *
 * Post-run actions execute after a run completes (success or failure),
 * allowing plugins to emit results to external systems (dashboards, webhooks, etc.).
 *
 * @example
 * ```ts
 * const postAction: IPostRunAction = {
 *   name: "webhook-reporter",
 *   description: "Sends run results to external webhook",
 *   async shouldRun(context) {
 *     return context.storySummary.completed > 0;
 *   },
 *   async execute(context) {
 *     await webhook.send({
 *       status: context.storySummary.failed > 0 ? "partial" : "success",
 *       completed: context.storySummary.completed,
 *       results_url: "..."
 *     });
 *     return { success: true, message: "Webhook sent" };
 *   }
 * };
 * ```
 */
export interface IPostRunAction {
  /** Action name (e.g., "webhook-reporter", "slack-notifier") */
  name: string;

  /** Human-readable description */
  description: string;

  /**
   * Determine whether this action should execute for the given run context.
   *
   * @param context - Run context with metadata
   * @returns True if the action should execute, false to skip
   */
  shouldRun(context: PostRunContext): Promise<boolean>;

  /**
   * Execute the post-run action.
   *
   * @param context - Run context with all necessary metadata
   * @returns Result of the action execution
   */
  execute(context: PostRunContext): Promise<PostRunActionResult>;
}

// ============================================================================
// Reporter Extension
// ============================================================================

/**
 * Event emitted when a run starts.
 */
export interface RunStartEvent {
  runId: string;
  feature: string;
  totalStories: number;
  startTime: string;
}

/**
 * Event emitted when a story completes.
 */
export interface StoryCompleteEvent {
  runId: string;
  storyId: string;
  status: "completed" | "failed" | "skipped" | "paused";
  runElapsedMs: number;
  cost: number;
  tier: string;
  testStrategy: string;
}

/**
 * Event emitted when a run ends.
 */
export interface RunEndEvent {
  runId: string;
  totalDurationMs: number;
  totalCost: number;
  storySummary: {
    completed: number;
    failed: number;
    skipped: number;
    paused: number;
  };
}

/**
 * Reporter interface.
 *
 * Reporters receive run lifecycle events and can emit them to external
 * systems (dashboards, Slack, CI, databases, etc.).
 *
 * All reporter methods are fire-and-forget — failures are logged but
 * never block the pipeline.
 *
 * @example
 * ```ts
 * const reporter: IReporter = {
 *   name: "telegram",
 *   async onRunStart(event) {
 *     await telegram.send(`Started ${event.feature}`);
 *   },
 *   async onStoryComplete(event) {
 *     await telegram.send(`${event.storyId} ${event.status}`);
 *   },
 *   async onRunEnd(event) {
 *     await telegram.send(`Completed ${event.storySummary.completed} stories`);
 *   }
 * };
 * ```
 */
export interface IReporter {
  /** Reporter name */
  name: string;

  /** Called when a run starts */
  onRunStart?(event: RunStartEvent): Promise<void>;

  /** Called when a story completes (success or failure) */
  onStoryComplete?(event: StoryCompleteEvent): Promise<void>;

  /** Called when a run ends */
  onRunEnd?(event: RunEndEvent): Promise<void>;
}
