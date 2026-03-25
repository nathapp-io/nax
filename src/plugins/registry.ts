/**
 * Plugin Registry
 *
 * Central registry for all loaded plugins with typed getters.
 */

import type { AgentAdapter } from "../agents/types";
import { getSafeLogger } from "../logger";
import type { RoutingStrategy } from "../routing/router";
import type { LoadedPlugin, PluginSource } from "./loader";
import type { IContextProvider, IPostRunAction, IPromptOptimizer, IReporter, IReviewPlugin, NaxPlugin } from "./types";

/**
 * Plugin registry with typed getters for each extension type.
 *
 * Created once at run start and passed through the pipeline context.
 * Provides efficient access to plugins by extension type.
 */
export class PluginRegistry {
  /** All loaded plugins (readonly) */
  readonly plugins: ReadonlyArray<NaxPlugin>;

  /** Plugin source information (maps plugin name to source) */
  private readonly sources: Map<string, PluginSource>;

  constructor(loadedPlugins: LoadedPlugin[] | NaxPlugin[]) {
    // Support both LoadedPlugin[] and NaxPlugin[] for backward compatibility
    if (loadedPlugins.length > 0 && "plugin" in loadedPlugins[0]) {
      // New format: LoadedPlugin[]
      const typed = loadedPlugins as LoadedPlugin[];
      this.plugins = typed.map((lp) => lp.plugin);
      this.sources = new Map(typed.map((lp) => [lp.plugin.name, lp.source]));
    } else {
      // Legacy format: NaxPlugin[]
      const typed = loadedPlugins as NaxPlugin[];
      this.plugins = typed;
      this.sources = new Map();
    }
  }

  /**
   * Get the source information for a plugin.
   *
   * @param pluginName - Name of the plugin
   * @returns Plugin source or undefined if not found
   */
  getSource(pluginName: string): PluginSource | undefined {
    return this.sources.get(pluginName);
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
   * Get all post-run actions.
   *
   * Post-run actions execute after a run completes (success or failure),
   * allowing plugins to emit results to external systems.
   * All post-run actions are additive and execute in registration order.
   *
   * @returns Array of post-run action implementations
   */
  getPostRunActions(): IPostRunAction[] {
    return this.plugins
      .filter((p) => p.provides.includes("post-run-action"))
      .map((p) => p.extensions.postRunAction)
      .filter((action): action is IPostRunAction => action !== undefined);
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
    const logger = getSafeLogger();
    for (const plugin of this.plugins) {
      if (plugin.teardown) {
        try {
          await plugin.teardown();
        } catch (error) {
          logger?.error("plugins", `Plugin '${plugin.name}' teardown failed`, { error });
        }
      }
    }
  }
}
