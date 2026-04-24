/**
 * ConfigLoader — In-memory config cache with memoized selector slicing
 *
 * Wraps a frozen NaxConfig and provides memoized selector-based views.
 * This is NOT the disk-reading loadConfig from loader.ts — it's a pure
 * in-memory cache used by NaxRuntime and other operations to avoid
 * repeating config projections.
 *
 * Future seam: hot-reload will swap the config reference, invalidating
 * the memo cache.
 */

import type { ConfigSelector } from "./selector";
import type { NaxConfig } from "./types";

export interface ConfigLoader {
  current(): NaxConfig;
  select<C>(selector: ConfigSelector<C>): C;
}

export function createConfigLoader(config: NaxConfig): ConfigLoader {
  const memo = new Map<string, unknown>();

  return {
    current() {
      return config;
    },
    select<C>(selector: ConfigSelector<C>): C {
      if (memo.has(selector.name)) {
        return memo.get(selector.name) as C;
      }
      const value = selector.select(config);
      memo.set(selector.name, value);
      return value;
    },
  };
}
