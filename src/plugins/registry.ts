/**
 * Plugin Registry
 *
 * Central registry for all loaded plugins with typed getters.
 */

import { LOOP_EVENTS } from "../agents/native/session/loop-events";
import type {
  ExternalHandlerOf,
  LoopEvent,
  LoopHandlerEntry,
  LoopHandlerSet,
} from "../agents/native/session/loop-events/types";
import type { AgentAdapter } from "../agents/types";
import { getSafeLogger } from "../logger";
import type { RoutingStrategy } from "../routing/router";
import { errorMessage } from "../utils/errors";
import type { LoadedPlugin, PluginSource } from "./loader";
import type {
  IContextProvider,
  ILoopHandlerProvider,
  IPostRunAction,
  IPromptOptimizer,
  IReporter,
  IReviewPlugin,
  LoopHandlerRegistrar,
  NaxPlugin,
} from "./types";

/**
 * The event names a plugin may register against, for the one place that reads
 * an event name off a plugin rather than off the type system.
 */
const LOOP_EVENT_NAMES: ReadonlySet<string> = new Set<string>(LOOP_EVENTS);

export interface PostRunActionRegistration {
  pluginName: string;
  action: IPostRunAction;
}

/**
 * Stage one provider's registrations, in the order its `register` makes them.
 *
 * Both ways a stage can fail drop the plugin's entries WHOLESALE rather than
 * keep the ones that arrived before the failure: a plugin that throws
 * mid-`register`, or names an event that does not exist, has declared a
 * registration set nax cannot honour, so half-installing it would leave the
 * loop running a contract the plugin never asked for. Each failure logs a
 * `plugins` warning naming the plugin — and, for an unknown event, the event.
 *
 * @param pluginName - The declaring plugin's name, carried onto every entry
 * @param provider - The plugin's loop-handler extension
 * @returns The plugin's staged entries, empty when it failed
 */
function stagePluginHandlers(pluginName: string, provider: ILoopHandlerProvider): LoopHandlerEntry[] {
  const logger = getSafeLogger();
  const staged: LoopHandlerEntry[] = [];
  let failed = false;

  const on: LoopHandlerRegistrar = (event, handler) => {
    if (!LOOP_EVENT_NAMES.has(event)) {
      failed = true;
      logger?.warn("plugins", `Plugin '${pluginName}' registered a handler for unknown loop event '${event}'`, {
        plugin: pluginName,
        event,
      });
      return;
    }
    // Erase E for storage: the entry is what the installer reads, and it can
    // only be dispatched back to the event it names.
    staged.push({ plugin: pluginName, event, handler: handler as unknown as ExternalHandlerOf<LoopEvent> });
  };

  try {
    provider.register(on);
  } catch (err) {
    failed = true;
    logger?.warn("plugins", `Plugin '${pluginName}' loop-handler registration failed; its handlers are skipped`, {
      plugin: pluginName,
      error: errorMessage(err),
    });
  }

  return failed ? [] : staged;
}

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

  /**
   * Built-in post-run actions registered by the loader for built-in plugins
   * that contribute side-channel actions without appearing in `plugins`.
   *
   * Built-in plugins opt into one of two layouts:
   *  - Full plugin in `plugins` (curator): participates in name collisions,
   *    setup/teardown, and source tracking.
   *  - Side-channel action only (auto-pr): registered here so callers using
   *    `getPostRunActions()` see it, but `plugins.length` and source-collision
   *    logic treat it as transparent — opt-in semantics live in the action's
   *    own `shouldRun()` (e.g. `config.autoPr.enabled`).
   */
  private readonly builtinPostRunActions: ReadonlyArray<PostRunActionRegistration>;

  /**
   * The run's loop handlers, built on first `getLoopHandlers()` (US-001).
   * `undefined` until then: a plugin's `register` may only run inside the run
   * whose sessions will receive the handlers.
   */
  private loopHandlers: LoopHandlerSet | undefined;

  constructor(
    loadedPlugins: LoadedPlugin[] | NaxPlugin[],
    builtinPostRunActions: Array<IPostRunAction | PostRunActionRegistration> = [],
  ) {
    this.builtinPostRunActions = builtinPostRunActions.map((registration) =>
      "action" in registration ? registration : { pluginName: registration.name, action: registration },
    );
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
   * All post-run actions are additive and execute in registration order,
   * returning plugin-derived actions first followed by side-channel
   * built-in actions.
   *
   * @returns Array of post-run action implementations
   */
  getPostRunActions(): IPostRunAction[] {
    return this.getPostRunActionRegistrations().map(({ action }) => action);
  }

  /** Return post-run actions together with their owning plugin identity. */
  getPostRunActionRegistrations(): PostRunActionRegistration[] {
    const pluginActions = this.plugins.flatMap((plugin) => {
      const action = plugin.extensions.postRunAction;
      return plugin.provides.includes("post-run-action") && action ? [{ pluginName: plugin.name, action }] : [];
    });
    return [...pluginActions, ...this.builtinPostRunActions];
  }

  /**
   * Get every plugin-contributed loop handler for this run (US-001).
   *
   * Built once, from the plugins whose `provides` includes `"loop-handlers"`,
   * in plugin load order and, within one plugin, in `on(...)` call order. The
   * returned set is frozen and memoised: the second call returns the same
   * array, and no plugin's `register` runs twice.
   *
   * @returns The run's loop handlers, empty when no plugin provides any
   */
  getLoopHandlers(): LoopHandlerSet {
    if (this.loopHandlers !== undefined) {
      return this.loopHandlers;
    }
    const entries: LoopHandlerEntry[] = [];
    for (const plugin of this.plugins) {
      if (!plugin.provides.includes("loop-handlers")) {
        continue;
      }
      const provider = plugin.extensions.loopHandlers;
      if (provider !== undefined) {
        entries.push(...stagePluginHandlers(plugin.name, provider));
      }
    }
    this.loopHandlers = Object.freeze(entries);
    return this.loopHandlers;
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
