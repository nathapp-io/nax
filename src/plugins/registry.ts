/**
 * Plugin Registry
 *
 * Central registry for all loaded plugins with typed getters.
 */

import type { AgentAdapter } from "../agents/types";
import type { RoutingStrategy } from "../routing/strategy";
import type { IContextProvider, IPromptOptimizer, IReporter, IReviewPlugin, NaxPlugin } from "./types";

/**
 * Plugin registry with typed getters for each extension type.
 *
 * Created once at run start and passed through the pipeline context.
 * Provides efficient access to plugins by extension type.
 */
export class PluginRegistry {
  /** All loaded plugins (readonly) */
  readonly plugins: ReadonlyArray<NaxPlugin>;

  constructor(plugins: NaxPlugin[]) {
    this.plugins = plugins;
  }

  /**
   * Get all prompt optimizers.
   *
   * @returns Array of optimizer implementations
   */
  getOptimizers(): IPromptOptimizer[] {
    return this.plugins
      .filter((p) => p.provides.includes("optimizer"))
      .map((p) => p.extensions.optimizer)
      .filter((opt): opt is IPromptOptimizer => opt !== undefined);
  }

  /**
   * Get all routing strategies.
   *
   * Plugin routers are returned in load order and should be inserted
   * before built-in strategies in the routing chain.
   *
   * @returns Array of routing strategy implementations
   */
  getRouters(): RoutingStrategy[] {
    return this.plugins
      .filter((p) => p.provides.includes("router"))
      .map((p) => p.extensions.router)
      .filter((router): router is RoutingStrategy => router !== undefined);
  }

  /**
   * Get agent adapter by name.
   *
   * If multiple plugins provide the same agent name, the last loaded wins.
   *
   * @param name - Agent name to lookup
   * @returns Agent adapter or undefined if not found
   */
  getAgent(name: string): AgentAdapter | undefined {
    const agents = this.plugins
      .filter((p) => p.provides.includes("agent"))
      .map((p) => p.extensions.agent)
      .filter((agent): agent is AgentAdapter => agent !== undefined);

    // Last loaded wins on name collision
    for (let i = agents.length - 1; i >= 0; i--) {
      if (agents[i].name === name) {
        return agents[i];
      }
    }

    return undefined;
  }

  /**
   * Get all review plugins.
   *
   * Review plugins run after built-in checks (typecheck, lint, test).
   * All plugin checks are additive.
   *
   * @returns Array of review plugin implementations
   */
  getReviewers(): IReviewPlugin[] {
    return this.plugins
      .filter((p) => p.provides.includes("reviewer"))
      .map((p) => p.extensions.reviewer)
      .filter((reviewer): reviewer is IReviewPlugin => reviewer !== undefined);
  }

  /**
   * Get all context providers.
   *
   * Context providers fetch external data (Jira, Linear, etc.) and
   * inject it into agent prompts. All providers are additive, subject
   * to token budget.
   *
   * @returns Array of context provider implementations
   */
  getContextProviders(): IContextProvider[] {
    return this.plugins
      .filter((p) => p.provides.includes("context-provider"))
      .map((p) => p.extensions.contextProvider)
      .filter((provider): provider is IContextProvider => provider !== undefined);
  }

  /**
   * Get all reporters.
   *
   * Reporters receive run lifecycle events for dashboards, CI, etc.
   * All reporters are additive and fire-and-forget.
   *
   * @returns Array of reporter implementations
   */
  getReporters(): IReporter[] {
    return this.plugins
      .filter((p) => p.provides.includes("reporter"))
      .map((p) => p.extensions.reporter)
      .filter((reporter): reporter is IReporter => reporter !== undefined);
  }

  /**
   * Teardown all plugins.
   *
   * Calls teardown() on each plugin (if defined) in order.
   * Logs errors but continues teardown for all plugins.
   *
   * Called when the nax run ends (success or failure).
   */
  async teardownAll(): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.teardown) {
        try {
          await plugin.teardown();
        } catch (error) {
          console.error(`[nax] Plugin '${plugin.name}' teardown failed:`, error);
        }
      }
    }
  }
}
