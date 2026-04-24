/**
 * ConfigSelector — Named, reusable config-slicing primitives
 *
 * A ConfigSelector<C> is a named, type-safe view of NaxConfig.
 * Used by operations (and later by NaxRuntime) to declare config dependencies
 * without duplicating projection logic.
 *
 * Two factories:
 * - pickSelector: select named keys from NaxConfig
 * - reshapeSelector: apply an arbitrary transform function
 */

import type { NaxConfig } from "./types";

export interface ConfigSelector<C> {
  readonly name: string;
  select(config: NaxConfig): C;
}

/**
 * Create a selector that picks named keys from NaxConfig.
 *
 * @param name — Human-readable name for this selector (e.g., "routing-config")
 * @param keys — One or more keys from NaxConfig to include in the result
 * @returns A ConfigSelector that picks only those keys
 *
 * @example
 * const sel = pickSelector("routing-config", "routing", "execution");
 * const config = loadConfig(...);
 * const routingAndExecution = sel.select(config);
 */
export function pickSelector<K extends keyof NaxConfig>(
  name: string,
  ...keys: readonly K[]
): ConfigSelector<Pick<NaxConfig, K>> {
  return {
    name,
    select(config) {
      const result = {} as Pick<NaxConfig, K>;
      for (const key of keys) {
        result[key] = config[key];
      }
      return result;
    },
  };
}

/**
 * Create a selector that applies an arbitrary transform function to NaxConfig.
 *
 * @param name — Human-readable name for this selector
 * @param fn — Transform function that projects NaxConfig to some output type C
 * @returns A ConfigSelector with the custom projection
 *
 * @example
 * const sel = reshapeSelector("fast-tier", (config) => ({
 *   models: config.routing?.models,
 *   timeout: config.execution?.timeout,
 * }));
 * const fastTierConfig = sel.select(config);
 */
export function reshapeSelector<C>(name: string, fn: (config: NaxConfig) => C): ConfigSelector<C> {
  return { name, select: fn };
}
