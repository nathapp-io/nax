/**
 * Plugin System Types
 *
 * Defines the plugin interface and extension point types for the nax plugin system.
 * Plugins export a NaxPlugin object with extension implementations.
 */

import type { AgentAdapter } from "../agents/types";
import type { IPromptOptimizer } from "../optimizer/types";
import type { UserStory } from "../prd/types";
import type { RoutingStrategy } from "../routing/strategy";

/**
 * Extension point types that plugins can provide.
 */
export type PluginType = "optimizer" | "router" | "agent" | "reviewer" | "context-provider" | "reporter";

/**
 * A nax plugin module.
 *
 * Plugins export a single NaxPlugin object (default or named export).
 * Each plugin declares which extension points it provides and supplies
 * the corresponding implementations.
 *
 * @example
 * ```ts
 * const myPlugin: NaxPlugin = {
 *   name: "my-security-scanner",
 *   version: "1.0.0",
 *   provides: ["reviewer"],
 *   async setup(config) {
 *     // Initialize plugin
 *   },
 *   async teardown() {
 *     // Cleanup
 *   },
 *   extensions: {
 *     reviewer: {
 *       name: "security-scan",
 *       description: "Scans for security vulnerabilities",
 *       async check(workdir, changedFiles) {
 *         // Perform check
 *       }
 *     }
 *   }
 * };
 * ```
 */
export interface NaxPlugin {
  /** Unique plugin name (e.g., "jira-context", "llmlingua-optimizer") */
  name: string;

  /** Plugin version (semver) */
  version: string;

  /** Which extension points this plugin provides */
  provides: PluginType[];

  /**
   * Called once when plugin is loaded. Use for initialization,
   * validating config, establishing connections, etc.
   *
   * @param config - Plugin-specific config from nax config.json
   */
  setup?(config: Record<string, unknown>): Promise<void>;

  /**
   * Called when the nax run ends (success or failure).
   * Use for cleanup, closing connections, flushing buffers.
   */
  teardown?(): Promise<void>;

  /**
   * Extension implementations. Only the types listed in `provides`
   * are required; others are ignored.
   */
  extensions: PluginExtensions;
}

/**
 * Extension implementations provided by a plugin.
 * Only extensions matching the plugin's `provides` array are required.
 */
export interface PluginExtensions {
  /** Custom prompt optimizer */
  optimizer?: IPromptOptimizer;

  /** Custom routing strategy (inserted into the strategy chain) */
  router?: RoutingStrategy;

  /** Custom agent adapter (e.g., Codex, Gemini, Aider) */
  agent?: AgentAdapter;

  /** Custom review check (runs alongside built-in typecheck/lint/test) */
  reviewer?: IReviewPlugin;

  /** Custom context provider (injects external context into prompts) */
  contextProvider?: IContextProvider;

  /** Custom reporter (receives run events for dashboards, CI, etc.) */
  reporter?: IReporter;
}

// ============================================================================
// Optimizer Extension
// ============================================================================

/**
 * Re-export optimizer types from the optimizer module.
 * Plugin optimizers use the same interface as built-in optimizers.
 */
export type {
  PromptOptimizerInput,
  PromptOptimizerResult,
} from "../optimizer/types";
export type { IPromptOptimizer } from "../optimizer/types";

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
   * @param story - The user story being executed
   * @returns Markdown content to inject into the agent prompt
   */
  getContext(story: UserStory): Promise<ContextProviderResult>;
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
  durationMs: number;
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

// ============================================================================
// Plugin Config
// ============================================================================

/**
 * Plugin configuration entry from nax config.json.
 *
 * @example
 * ```json
 * {
 *   "plugins": [
 *     {
 *       "module": "./nax/plugins/my-plugin",
 *       "config": { "apiKey": "secret" }
 *     }
 *   ]
 * }
 * ```
 */
export interface PluginConfigEntry {
  /** Module path or npm package name */
  module: string;
  /** Plugin-specific configuration */
  config?: Record<string, unknown>;
}
