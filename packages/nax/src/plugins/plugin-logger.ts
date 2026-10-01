/**
 * Plugin Logger Factory
 *
 * Creates write-only, stage-prefixed loggers for plugins.
 * Each logger auto-tags entries with `plugin:<name>` so plugin
 * output is filterable and cannot impersonate core stages.
 *
 * @module plugins/plugin-logger
 */

import { getSafeLogger } from "../logger";
import type { PluginLogger } from "./types";

/**
 * Create a PluginLogger scoped to a plugin name.
 *
 * The returned logger delegates to the global nax Logger with
 * `plugin:<pluginName>` as the stage. If the global logger is
 * not initialized (e.g., during tests), calls are silently dropped.
 *
 * @param pluginName - Plugin name used as stage prefix
 * @returns PluginLogger instance
 */
export function createPluginLogger(pluginName: string): PluginLogger {
  const stage = `plugin:${pluginName}`;

  return {
    error(message: string, data?: Record<string, unknown>): void {
      getSafeLogger()?.error(stage, message, data);
    },
    warn(message: string, data?: Record<string, unknown>): void {
      getSafeLogger()?.warn(stage, message, data);
    },
    info(message: string, data?: Record<string, unknown>): void {
      getSafeLogger()?.info(stage, message, data);
    },
    debug(message: string, data?: Record<string, unknown>): void {
      getSafeLogger()?.debug(stage, message, data);
    },
  };
}
