/**
 * Interaction Chain Initialization Helper
 *
 * Creates and initializes interaction chain from config.
 */

import type { NaxConfig } from "../config";
import { getSafeLogger } from "../logger";
import { InteractionChain } from "./chain";
import { AutoInteractionPlugin } from "./plugins/auto";
import { CLIInteractionPlugin } from "./plugins/cli";
import { TelegramInteractionPlugin } from "./plugins/telegram";
import { WebhookInteractionPlugin } from "./plugins/webhook";
import type { InteractionPlugin } from "./types";

/**
 * Create interaction plugin based on config
 */
function createInteractionPlugin(pluginName: string): InteractionPlugin {
  switch (pluginName) {
    case "cli":
      return new CLIInteractionPlugin();
    case "telegram":
      return new TelegramInteractionPlugin();
    case "webhook":
      return new WebhookInteractionPlugin();
    case "auto":
      return new AutoInteractionPlugin();
    default:
      throw new Error(`Unknown interaction plugin: ${pluginName}`);
  }
}

/**
 * Initialize interaction chain from config
 *
 * @param config - Nax configuration
 * @param headless - Whether running in headless mode (skip interactions)
 * @returns Initialized interaction chain or null if disabled/headless
 */
export async function initInteractionChain(config: NaxConfig, headless: boolean): Promise<InteractionChain | null> {
  const logger = getSafeLogger();

  // If headless mode, skip interaction system
  if (headless) {
    logger?.debug("interaction", "Headless mode - skipping interaction system");
    return null;
  }

  // If no interaction config, skip
  if (!config.interaction) {
    logger?.debug("interaction", "No interaction config - skipping interaction system");
    return null;
  }

  // Create chain
  const chain = new InteractionChain({
    defaultTimeout: config.interaction.defaults.timeout,
    defaultFallback: config.interaction.defaults.fallback,
  });

  // Create and register plugin
  const pluginName = config.interaction.plugin;
  try {
    const plugin = createInteractionPlugin(pluginName);
    chain.register(plugin, 100);

    // Initialize plugin
    const pluginConfig = config.interaction.config ?? {};
    await chain.init({ [pluginName]: pluginConfig });

    logger?.info("interaction", `Initialized ${pluginName} interaction plugin`, {
      timeout: config.interaction.defaults.timeout,
      fallback: config.interaction.defaults.fallback,
    });

    return chain;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger?.error("interaction", `Failed to initialize interaction plugin: ${error}`);
    throw err;
  }
}
