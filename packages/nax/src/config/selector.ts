/**
 * ConfigSelector — Named, reusable config-slicing primitive
 *
 * A ConfigSelector<C> is a named, type-safe view of NaxConfig.
 * Used by operations (and later by NaxRuntime) to declare config dependencies
 * without duplicating projection logic.
 *
 * One factory: pickSelector, which selects named keys from NaxConfig.
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
