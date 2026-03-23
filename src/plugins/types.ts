/**
 * Plugin System Types — Hub file
 *
 * Defines the plugin interface and extension point types for the nax plugin system.
 * Plugins export a NaxPlugin object with extension implementations.
 */

import type { AgentAdapter } from "../agents/types";
import type { IPromptOptimizer } from "../optimizer/types";
import type { RoutingStrategy } from "../routing/router";
import type { IContextProvider, IReporter, IReviewPlugin } from "./extensions";

// Re-export extension types
export type {
  ContextProviderResult,
  IContextProvider,
  IReporter,
  IReviewPlugin,
  ReviewCheckResult,
  ReviewFinding,
  RunEndEvent,
  RunStartEvent,
  StoryCompleteEvent,
} from "./extensions";

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
   * @param logger - Write-only logger scoped to this plugin (stage auto-prefixed as `plugin:<name>`)
   */
  setup?(config: Record<string, unknown>, logger: PluginLogger): Promise<void>;

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
  IPromptOptimizer,
  PromptOptimizerInput,
  PromptOptimizerResult,
} from "../optimizer/types";

// ============================================================================
// Plugin Logger
// ============================================================================

/**
 * Write-only, level-gated logger provided to plugins via setup().
 *
 * All log entries are auto-prefixed with `plugin:<name>` as the stage,
 * so plugins cannot impersonate core nax stages. The interface is
 * intentionally minimal — plugins only need to emit messages, not
 * configure log levels or access log files.
 *
 * @example
 * ```ts
 * let log: PluginLogger;
 *
 * const myPlugin: NaxPlugin = {
 *   name: "my-plugin",
 *   version: "1.0.0",
 *   provides: ["reviewer"],
 *   async setup(config, logger) {
 *     log = logger;
 *     log.info("Initialized with config", { keys: Object.keys(config) });
 *   },
 *   extensions: {
 *     reviewer: {
 *       name: "my-check",
 *       description: "Custom check",
 *       async check(workdir, changedFiles) {
 *         log.debug("Scanning files", { count: changedFiles.length });
 *         // ...
 *       }
 *     }
 *   }
 * };
 * ```
 */
export interface PluginLogger {
  /** Log an error message */
  error(message: string, data?: Record<string, unknown>): void;
  /** Log a warning message */
  warn(message: string, data?: Record<string, unknown>): void;
  /** Log an informational message */
  info(message: string, data?: Record<string, unknown>): void;
  /** Log a debug message */
  debug(message: string, data?: Record<string, unknown>): void;
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
  /** Whether this plugin is enabled (default: true) */
  enabled?: boolean;
}
