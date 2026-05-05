/**
 * Plugins Command
 *
 * Lists loaded plugins with their metadata.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { NaxConfig } from "../config/schema";
import { loadPlugins } from "../plugins/loader";

/**
 * List all loaded plugins with their metadata.
 *
 * @param config - nax configuration
 * @param workdir - Working directory for resolving plugin paths
 * @param overrideGlobalPluginsDir - Override global plugins directory (used in tests)
 */
export async function pluginsListCommand(
  config: NaxConfig,
  workdir: string,
  overrideGlobalPluginsDir?: string,
): Promise<void> {
  // Load plugins from all sources
  const globalPluginsDir = overrideGlobalPluginsDir ?? path.join(os.homedir(), ".nax", "plugins");
  const projectPluginsDir = path.join(workdir, ".nax", "plugins");
  const configPlugins = config.plugins || [];
  const registry = await loadPlugins(
    globalPluginsDir,
    projectPluginsDir,
    configPlugins,
    workdir,
    config.disabledPlugins,
  );
  const plugins = registry.plugins;

  if (plugins.length === 0) {
    console.log("No plugins installed.");
    console.log("\nTo install plugins:");
    console.log("  • Add to global directory: ~/.nax/plugins/");
    console.log("  • Add to project directory: ./.nax/plugins/");
    console.log("  • Configure in .nax/config.json");
    console.log("\nSee https://github.com/nax/nax#plugins for more details.");
    return;
  }

  // Build table data
  const disabledSet = new Set(config.disabledPlugins ?? []);
  const rows: Array<{
    name: string;
    version: string;
    provides: string;
    source: string;
    enabled: string;
  }> = plugins.map((plugin) => {
    const source = registry.getSource(plugin.name);
    const sourceStr = source ? formatSource(source.type, source.path) : "unknown";
    const isDisabled = disabledSet.has(plugin.name);

    return {
      name: plugin.name,
      version: plugin.version,
      provides: plugin.provides.join(", "),
      source: sourceStr,
      enabled: isDisabled ? "disabled" : "enabled",
    };
  });

  // Calculate column widths
  const widths = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    version: Math.max(7, ...rows.map((r) => r.version.length)),
    provides: Math.max(8, ...rows.map((r) => r.provides.length)),
    source: Math.max(6, ...rows.map((r) => r.source.length)),
    enabled: Math.max(7, ...rows.map((r) => r.enabled.length)),
  };

  // Display table
  console.log("\nInstalled Plugins:\n");
  console.log(
    `${pad("Name", widths.name)}  ${pad("Version", widths.version)}  ${pad("Provides", widths.provides)}  ${pad("Source", widths.source)}  ${pad("Status", widths.enabled)}`,
  );
  console.log(
    `${"-".repeat(widths.name)}  ${"-".repeat(widths.version)}  ${"-".repeat(widths.provides)}  ${"-".repeat(widths.source)}  ${"-".repeat(widths.enabled)}`,
  );

  for (const row of rows) {
    console.log(
      `${pad(row.name, widths.name)}  ${pad(row.version, widths.version)}  ${pad(row.provides, widths.provides)}  ${pad(row.source, widths.source)}  ${pad(row.enabled, widths.enabled)}`,
    );
  }

  console.log();
}

/**
 * Format source type and path for display.
 *
 * @param type - Source type (global/project/config)
 * @param sourcePath - Full path to plugin
 * @returns Formatted source string
 */
function formatSource(type: "builtin" | "global" | "project" | "config", sourcePath: string): string {
  if (type === "builtin") {
    return `built-in (${sourcePath})`;
  }
  if (type === "global") {
    return `global (${path.basename(sourcePath)})`;
  }
  if (type === "project") {
    return `project (${path.basename(sourcePath)})`;
  }
  return `config (${sourcePath})`;
}

/**
 * Pad string to width.
 *
 * @param str - String to pad
 * @param width - Target width
 * @returns Padded string
 */
function pad(str: string, width: number): string {
  return str.padEnd(width);
}
