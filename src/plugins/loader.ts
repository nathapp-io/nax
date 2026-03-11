/**
 * Plugin Loader
 *
 * Discovers, imports, validates, and initializes plugins from:
 * 1. Global directory (~/.nax/plugins/)
 * 2. Project directory (<project>/nax/plugins/)
 * 3. Config entries (explicit module paths)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getSafeLogger as _getSafeLoggerFromModule } from "../logger";
import { errorMessage } from "../utils/errors";
import { validateModulePath } from "../utils/path-security";
import { createPluginLogger } from "./plugin-logger";
import { PluginRegistry } from "./registry";
import type { NaxPlugin, PluginConfigEntry } from "./types";
import { validatePlugin } from "./validator";

/**
 * Swappable error sink — defaults to console.error.
 * Tests can replace this to capture plugin error output.
 * @internal
 */
export let _pluginErrorSink: (...args: unknown[]) => void = (...args) => console.error(...args);

/** @internal — for testing only */
export function _setPluginErrorSink(fn: (...args: unknown[]) => void): void {
  _pluginErrorSink = fn;
}

/** @internal — reset to default */
export function _resetPluginErrorSink(): void {
  _pluginErrorSink = (...args) => console.error(...args);
}

/**
 * Safely get logger instance, returns null if not initialized.
 * Delegates to the module's getSafeLogger which correctly returns null for noopLogger.
 */
function getSafeLogger() {
  return _getSafeLoggerFromModule();
}

/**
 * Plugin source metadata.
 */
export interface PluginSource {
  type: "global" | "project" | "config";
  path: string;
}

/**
 * Extract plugin name from file path.
 * For index files (e.g., /path/to/plugin/index.ts), returns the parent directory name.
 * For single files (e.g., /path/to/plugin.ts), returns the filename without extension.
 *
 * @param pluginPath - Path to plugin file
 * @returns Plugin name
 */
function extractPluginName(pluginPath: string): string {
  const basename = path.basename(pluginPath);
  if (basename === "index.ts" || basename === "index.js" || basename === "index.mjs") {
    // For index files, use the parent directory name
    return path.basename(path.dirname(pluginPath));
  }
  // For single files, use filename without extension
  return basename.replace(/\.(ts|js|mjs)$/, "");
}

/**
 * Plugin with source information.
 */
export interface LoadedPlugin {
  plugin: NaxPlugin;
  source: PluginSource;
}

/**
 * Load and validate all plugins from global + project + config sources.
 *
 * Load order:
 * 1. Scan ~/.nax/plugins/ (if exists)
 * 2. Scan <project>/nax/plugins/ (if exists)
 * 3. Load explicit modules from config.plugins[]
 *
 * Each plugin is validated, then setup() is called with its config.
 * Plugins can be disabled via config.plugins[].enabled or config.disabledPlugins[].
 *
 * @param globalDir - Global plugins directory (e.g., ~/.nax/plugins)
 * @param projectDir - Project plugins directory (e.g., <project>/nax/plugins)
 * @param configPlugins - Explicit plugin entries from config
 * @param projectRoot - Project root directory for resolving relative paths in config
 * @param disabledPlugins - List of plugin names to disable (auto-discovered plugins only)
 * @returns PluginRegistry with all loaded plugins and their sources
 */
export async function loadPlugins(
  globalDir: string,
  projectDir: string,
  configPlugins: PluginConfigEntry[],
  projectRoot?: string,
  disabledPlugins?: string[],
): Promise<PluginRegistry> {
  const loadedPlugins: LoadedPlugin[] = [];
  const effectiveProjectRoot = projectRoot || projectDir;
  const pluginNames = new Set<string>();
  const disabledSet = new Set(disabledPlugins ?? []);
  const logger = getSafeLogger();

  // 1. Load plugins from global directory
  const globalPlugins = await discoverPlugins(globalDir);
  for (const plugin of globalPlugins) {
    const pluginName = extractPluginName(plugin.path);
    if (disabledSet.has(pluginName)) {
      logger?.info("plugins", `Skipping disabled plugin: '${pluginName}' (global directory)`);
      continue;
    }
    const validated = await loadAndValidatePlugin(plugin.path, {}, [globalDir]);
    if (validated) {
      if (pluginNames.has(validated.name)) {
        logger?.warn("plugins", `Plugin name collision: '${validated.name}' (global directory)`);
      }
      loadedPlugins.push({
        plugin: validated,
        source: { type: "global", path: plugin.path },
      });
      pluginNames.add(validated.name);
    }
  }

  // 2. Load plugins from project directory
  const projectPlugins = await discoverPlugins(projectDir);
  for (const plugin of projectPlugins) {
    const pluginName = extractPluginName(plugin.path);
    if (disabledSet.has(pluginName)) {
      logger?.info("plugins", `Skipping disabled plugin: '${pluginName}' (project directory)`);
      continue;
    }
    const validated = await loadAndValidatePlugin(plugin.path, {}, [projectDir]);
    if (validated) {
      if (pluginNames.has(validated.name)) {
        logger?.warn("plugins", `Plugin name collision: '${validated.name}' (project directory overrides global)`);
      }
      loadedPlugins.push({
        plugin: validated,
        source: { type: "project", path: plugin.path },
      });
      pluginNames.add(validated.name);
    }
  }

  // 3. Load plugins from config entries
  for (const entry of configPlugins) {
    // Check if plugin is explicitly disabled in config
    if (entry.enabled === false) {
      logger?.info("plugins", `Skipping disabled plugin: '${entry.module}'`);
      continue;
    }
    // Resolve module path relative to effective project root for relative paths
    const resolvedModule = resolveModulePath(entry.module, effectiveProjectRoot);
    const validated = await loadAndValidatePlugin(
      resolvedModule,
      entry.config ?? {},
      [globalDir, projectDir, effectiveProjectRoot].filter(Boolean),
      entry.module,
    );
    if (validated) {
      if (pluginNames.has(validated.name)) {
        logger?.warn("plugins", `Plugin name collision: '${validated.name}' (config entry overrides previous)`);
      }
      loadedPlugins.push({
        plugin: validated,
        source: { type: "config", path: entry.module },
      });
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
    // ERR-1 fix: Only catch ENOENT, re-throw other errors
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // Directory doesn't exist — not an error, just no plugins
      return [];
    }
    // Re-throw permission errors, disk failures, etc.
    throw error;
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
 * Resolve a module path, handling relative paths, absolute paths, and npm packages.
 *
 * @param modulePath - Module path from config (can be relative, absolute, or npm package)
 * @param projectRoot - Project root directory for resolving relative paths
 * @returns Resolved absolute path or npm package name
 */
function resolveModulePath(modulePath: string, projectRoot?: string): string {
  // Absolute paths and npm packages (no leading ./ or ../) work as-is
  if (path.isAbsolute(modulePath) || (!modulePath.startsWith("./") && !modulePath.startsWith("../"))) {
    return modulePath;
  }

  // Relative paths need to be resolved relative to project root
  if (projectRoot) {
    return path.resolve(projectRoot, modulePath);
  }

  // Fallback: resolve relative to cwd (shouldn't happen in normal usage)
  return path.resolve(modulePath);
}

/**
 * Load and validate a plugin from a module path.
 *
 * @param modulePath - Path to plugin module (should be resolved)
 * @param config - Plugin-specific config
 * @param originalPath - Original path from config (for error messages)
 * @returns Validated plugin or null if invalid
 */
async function loadAndValidatePlugin(
  initialModulePath: string,
  config: Record<string, unknown>,
  allowedRoots: string[] = [],
  originalPath?: string,
): Promise<NaxPlugin | null> {
  let attemptedPath = initialModulePath;
  try {
    // SEC-1: Validate module path if it's a file path (not an npm package)
    let modulePath = initialModulePath;
    const isFilePath = modulePath.startsWith("/") || modulePath.startsWith("./") || modulePath.startsWith("../");

    if (isFilePath && allowedRoots.length > 0) {
      const validation = validateModulePath(modulePath, allowedRoots);
      if (!validation.valid) {
        const logger = getSafeLogger();
        logger?.error("plugins", `Security: ${validation.error}`);
        _pluginErrorSink(`[plugins] Security: ${validation.error}`);
        return null;
      }
      // Use the normalized absolute path from the validator
      const validatedPath = validation.absolutePath as string;
      modulePath = validatedPath;
    }

    // Import the module
    attemptedPath = modulePath;
    const imported = await import(modulePath);

    // Try default export first, then named exports
    const module = imported.default || imported;

    // Validate plugin shape
    const validated = validatePlugin(module);
    if (!validated) {
      return null;
    }

    // Call setup() if defined — pass plugin-scoped logger
    if (validated.setup) {
      try {
        const pluginLogger = createPluginLogger(validated.name);
        await validated.setup(config, pluginLogger);
      } catch (error) {
        const logger = getSafeLogger();
        logger?.error("plugins", `Plugin '${validated.name}' setup failed`, { error });
        return null;
      }
    }

    return validated;
  } catch (error) {
    const displayPath = originalPath || initialModulePath;
    const errorMsg = errorMessage(error);
    const logger = getSafeLogger();

    // Provide helpful error message with attempted paths
    if (errorMsg.includes("Cannot find module") || errorMsg.includes("ENOENT")) {
      const msg = `Failed to load plugin module '${displayPath}'`;
      logger?.error("plugins", msg);
      logger?.error("plugins", `Attempted path: ${attemptedPath}`);
      logger?.error(
        "plugins",
        "Ensure the module exists and the path is correct (relative paths are resolved from project root)",
      );
      // Always emit to sink so tests (and headless mode without logger) can capture output
      _pluginErrorSink(`[plugins] ${msg}`);
      _pluginErrorSink(`[plugins] Attempted path: ${attemptedPath}`);
      _pluginErrorSink(
        "[plugins] Ensure the module exists and the path is correct (relative paths are resolved from project root)",
      );
    } else {
      logger?.warn("plugins", `Failed to load plugin from '${displayPath}'`, { error: errorMsg });
      // Always emit to sink
      _pluginErrorSink(`[plugins] Failed to load plugin from '${displayPath}': ${errorMsg}`);
    }
    return null;
  }
}
