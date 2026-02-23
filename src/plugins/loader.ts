/**
 * Plugin Loader
 *
 * Discovers, imports, validates, and initializes plugins from:
 * 1. Global directory (~/.nax/plugins/)
 * 2. Project directory (<project>/nax/plugins/)
 * 3. Config entries (explicit module paths)
 */

import { PluginRegistry } from "./registry";
import { validatePlugin } from "./validator";
import type { NaxPlugin, PluginConfigEntry } from "./types";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Load and validate all plugins from global + project + config sources.
 *
 * Load order:
 * 1. Scan ~/.nax/plugins/ (if exists)
 * 2. Scan <project>/nax/plugins/ (if exists)
 * 3. Load explicit modules from config.plugins[]
 *
 * Each plugin is validated, then setup() is called with its config.
 *
 * @param globalDir - Global plugins directory (e.g., ~/.nax/plugins)
 * @param projectDir - Project plugins directory (e.g., <project>/nax/plugins)
 * @param configPlugins - Explicit plugin entries from config
 * @returns PluginRegistry with all loaded plugins
 */
export async function loadPlugins(
	globalDir: string,
	projectDir: string,
	configPlugins: PluginConfigEntry[]
): Promise<PluginRegistry> {
	const loadedPlugins: NaxPlugin[] = [];
	const pluginNames = new Set<string>();

	// 1. Load plugins from global directory
	const globalPlugins = await discoverPlugins(globalDir);
	for (const plugin of globalPlugins) {
		const validated = await loadAndValidatePlugin(plugin.path, {});
		if (validated) {
			if (pluginNames.has(validated.name)) {
				console.warn(`[nax] Plugin name collision: '${validated.name}' (global directory)`);
			}
			loadedPlugins.push(validated);
			pluginNames.add(validated.name);
		}
	}

	// 2. Load plugins from project directory
	const projectPlugins = await discoverPlugins(projectDir);
	for (const plugin of projectPlugins) {
		const validated = await loadAndValidatePlugin(plugin.path, {});
		if (validated) {
			if (pluginNames.has(validated.name)) {
				console.warn(`[nax] Plugin name collision: '${validated.name}' (project directory overrides global)`);
			}
			loadedPlugins.push(validated);
			pluginNames.add(validated.name);
		}
	}

	// 3. Load plugins from config entries
	for (const entry of configPlugins) {
		const validated = await loadAndValidatePlugin(entry.module, entry.config);
		if (validated) {
			if (pluginNames.has(validated.name)) {
				console.warn(`[nax] Plugin name collision: '${validated.name}' (config entry overrides previous)`);
			}
			loadedPlugins.push(validated);
			pluginNames.add(validated.name);
		}
	}

	return new PluginRegistry(loadedPlugins);
}

/**
 * Discover plugin files in a directory.
 *
 * Scans for:
 * - Single-file plugins (*.ts, *.js, *.mjs)
 * - Directory plugins with index.ts/index.js/index.mjs
 *
 * @param dir - Directory to scan
 * @returns Array of discovered plugin paths
 */
async function discoverPlugins(dir: string): Promise<Array<{ path: string }>> {
	const discovered: Array<{ path: string }> = [];

	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);

			if (entry.isFile()) {
				// Single-file plugin
				if (isPluginFile(entry.name)) {
					discovered.push({ path: fullPath });
				}
			} else if (entry.isDirectory()) {
				// Directory plugin — check for index file
				const indexPaths = ["index.ts", "index.js", "index.mjs"];
				for (const indexFile of indexPaths) {
					const indexPath = path.join(fullPath, indexFile);
					try {
						await fs.access(indexPath);
						discovered.push({ path: indexPath });
						break;
					} catch {
						// Index file doesn't exist, try next
					}
				}
			}
		}
	} catch (error) {
		// Directory doesn't exist or can't be read — not an error, just no plugins
		return [];
	}

	return discovered;
}

/**
 * Check if a filename is a valid plugin file.
 *
 * @param filename - Filename to check
 * @returns Whether the file could be a plugin
 */
function isPluginFile(filename: string): boolean {
	return /\.(ts|js|mjs)$/.test(filename) && !filename.endsWith(".test.ts") && !filename.endsWith(".spec.ts");
}

/**
 * Load and validate a plugin from a module path.
 *
 * @param modulePath - Path to plugin module
 * @param config - Plugin-specific config
 * @returns Validated plugin or null if invalid
 */
async function loadAndValidatePlugin(modulePath: string, config: Record<string, unknown>): Promise<NaxPlugin | null> {
	try {
		// Import the module
		const imported = await import(modulePath);

		// Try default export first, then named exports
		const module = imported.default || imported;

		// Validate plugin shape
		const validated = validatePlugin(module);
		if (!validated) {
			return null;
		}

		// Call setup() if defined
		if (validated.setup) {
			try {
				await validated.setup(config);
			} catch (error) {
				console.error(`[nax] Plugin '${validated.name}' setup failed:`, error);
				return null;
			}
		}

		return validated;
	} catch (error) {
		console.warn(`[nax] Failed to load plugin from '${modulePath}':`, error);
		return null;
	}
}
