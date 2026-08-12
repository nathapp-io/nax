/**
 * Interaction Chain Initialization Helper
 *
 * Creates and initializes interaction chain from config.
 */

import type { InteractionConfig } from "../config/selectors";
import { NaxError } from "../errors";
import { getSafeLogger } from "../logger";
import { InteractionChain } from "./chain";
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
      // Removed (BUG-09, latent-bugs-v2): decide() was structurally unreachable —
      // receive() only gets a requestId, not the full request it needs to decide
      // — and no configured project ever used it. Auto-approval remains available
      // via `interaction.defaults.fallback: "continue"`.
      throw new NaxError(
        'The "auto" interaction plugin was removed — it never functioned (see docs/reviews/2026-08-11-code-review-latent-bugs-v2.md, BUG-09). Use `interaction.defaults.fallback: "continue"` for auto-approval on timeout, or configure "cli", "telegram", or "webhook".',
        "INTERACTION_PLUGIN_REMOVED",
        { stage: "run", pluginName },
      );
    default:
      throw new NaxError(`Unknown interaction plugin: ${pluginName}`, "INTERACTION_PLUGIN_UNKNOWN", {
        stage: "run",
        pluginName,
      });
  }
}

/**
 * Initialize interaction chain from config
 *
 * @param config - Nax configuration
 * @param headless - Whether running in headless mode (skip interactions)
 * @returns Initialized interaction chain or null if disabled/headless
 */
export async function initInteractionChain(
  config: InteractionConfig,
  headless: boolean,
): Promise<InteractionChain | null> {
  const logger = getSafeLogger();

  // If no interaction config, skip
  if (!config.interaction) {
    logger?.debug("interaction", "No interaction config - skipping interaction system");
    return null;
  }

  // In headless mode, skip CLI plugin only — it requires stdin (TTY).
  // Telegram and Webhook plugins work via HTTP and don't need a TTY.
  const pluginName = config.interaction.plugin;
  if (headless && pluginName === "cli") {
    logger?.debug("interaction", "Headless mode with CLI plugin - skipping interaction system (stdin unavailable)");
    return null;
  }

  // Create chain
  const chain = new InteractionChain({
    defaultTimeout: config.interaction.defaults.timeout,
    defaultFallback: config.interaction.defaults.fallback,
  });

  // Create and register plugin
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
