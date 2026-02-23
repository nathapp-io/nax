/**
 * Plugins Command
 *
 * Lists loaded plugins with their metadata.
 */

import type { NaxConfig } from "../config/schema";
import type { PluginRegistry } from "../plugins/registry";
import { loadPlugins } from "../plugins/loader";
import { getLogger } from "../logger";

/**
 * List all loaded plugins with their metadata.
 *
 * @param config - nax configuration
 * @param workdir - Working directory for resolving plugin paths
 */
export async function pluginsListCommand(
  config: NaxConfig,
  workdir: string,
): Promise<void> {
  const logger = getLogger();

  // Load plugins from config
  const plugins = await loadPlugins(config, workdir);

  if (plugins.length === 0) {
    console.log("No plugins configured.");
    console.log("\nTo add plugins, edit nax/config.json:");
    console.log(JSON.stringify({
      plugins: [
        {
          module: "./nax/plugins/my-plugin",
          config: {}
        }
      ]
    }, null, 2));
    return;
  }

  // Display plugin information
  console.log(`\nLoaded Plugins (${plugins.length}):\n`);

  for (const plugin of plugins) {
    console.log(`📦 ${plugin.name} v${plugin.version}`);
    console.log(`   Provides: ${plugin.provides.join(", ")}`);

    // Determine source (internal vs external)
    const pluginEntry = config.plugins?.find(p => {
      // Match by plugin name in module path
      return p.module.includes(plugin.name);
    });

    if (pluginEntry) {
      console.log(`   Source: ${pluginEntry.module}`);
    }

    console.log();
  }

  // Display extension type summary
  const registry = new PluginRegistry(plugins);

  console.log("Extension Summary:");
  console.log(`  Optimizers: ${registry.getOptimizers().length}`);
  console.log(`  Routers: ${registry.getRouters().length}`);
  console.log(`  Reviewers: ${registry.getReviewers().length}`);
  console.log(`  Context Providers: ${registry.getContextProviders().length}`);
  console.log(`  Reporters: ${registry.getReporters().length}`);
  console.log();
}
