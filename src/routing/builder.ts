/**
 * Routing Strategy Chain Builder
 *
 * Builds the strategy chain based on configuration.
 */

import type { NgentConfig } from "../config";
import type { RoutingStrategy } from "./strategy";
import { StrategyChain } from "./chain";
import { keywordStrategy, llmStrategy, manualStrategy, adaptiveStrategy } from "./strategies";
import { loadCustomStrategy } from "./loader";

/**
 * Build the routing strategy chain based on configuration.
 *
 * Chain order (custom strategies first, keyword always last as fallback):
 * - manual (if strategy = "manual")
 * - custom (if strategy = "custom")
 * - llm (if strategy = "llm")
 * - adaptive (if strategy = "adaptive") [v0.5 Phase 3]
 * - keyword (always last — never returns null)
 *
 * @param config - ngent configuration
 * @param workdir - Working directory for resolving custom strategy paths
 * @returns Strategy chain instance
 *
 * @example
 * ```ts
 * const chain = await buildStrategyChain(config, "/path/to/project");
 * const decision = chain.route(story, context);
 * ```
 */
export async function buildStrategyChain(
  config: NgentConfig,
  workdir: string,
): Promise<StrategyChain> {
  const strategies: RoutingStrategy[] = [];

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

    case "custom":
      if (!config.routing.customStrategyPath) {
        throw new Error(
          "routing.customStrategyPath is required when strategy is 'custom'"
        );
      }
      const customStrategy = await loadCustomStrategy(
        config.routing.customStrategyPath,
        workdir
      );
      strategies.push(customStrategy);
      break;

    case "keyword":
      // Keyword will be added at the end anyway
      break;
  }

  // Always add keyword strategy as final fallback
  strategies.push(keywordStrategy);

  return new StrategyChain(strategies);
}
