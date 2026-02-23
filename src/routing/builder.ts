/**
 * Routing Strategy Chain Builder
 *
 * Builds the strategy chain based on configuration.
 */

import type { NaxConfig } from "../config";
import type { PluginRegistry } from "../plugins/registry";
import { StrategyChain } from "./chain";
import { loadCustomStrategy } from "./loader";
import { adaptiveStrategy, keywordStrategy, llmStrategy, manualStrategy } from "./strategies";
import type { RoutingStrategy } from "./strategy";

/**
 * Build the routing strategy chain based on configuration.
 *
 * Chain order (plugin routers first, then config-based, keyword always last):
 * - plugin routers (from plugin registry, in load order)
 * - manual (if strategy = "manual")
 * - custom (if strategy = "custom")
 * - llm (if strategy = "llm")
 * - adaptive (if strategy = "adaptive") [v0.5 Phase 3]
 * - keyword (always last — never returns null)
 *
 * @param config - nax configuration
 * @param workdir - Working directory for resolving custom strategy paths
 * @param plugins - Optional plugin registry for plugin-provided routers
 * @returns Strategy chain instance
 *
 * @example
 * ```ts
 * const chain = await buildStrategyChain(config, "/path/to/project", plugins);
 * const decision = chain.route(story, context);
 * ```
 */
export async function buildStrategyChain(
  config: NaxConfig,
  workdir: string,
  plugins?: PluginRegistry,
): Promise<StrategyChain> {
  const strategies: RoutingStrategy[] = [];

  // Prepend plugin routers before built-in strategies
  if (plugins) {
    const pluginRouters = plugins.getRouters();
    strategies.push(...pluginRouters);
  }

  // Add strategies based on config
  switch (config.routing.strategy) {
    case "manual":
      strategies.push(manualStrategy);
      break;

    case "llm":
      strategies.push(llmStrategy);
      break;

    case "adaptive":
      strategies.push(adaptiveStrategy);
      break;

    case "custom": {
      if (!config.routing.customStrategyPath) {
        throw new Error("routing.customStrategyPath is required when strategy is 'custom'");
      }
      const customStrategy = await loadCustomStrategy(config.routing.customStrategyPath, workdir);
      strategies.push(customStrategy);
      break;
    }

    case "keyword":
      // Keyword will be added at the end anyway
      break;
  }

  // Always add keyword strategy as final fallback
  strategies.push(keywordStrategy);

  return new StrategyChain(strategies);
}
