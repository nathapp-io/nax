import { DEFAULT_CONFIG } from "../../src/config";
import type { NaxConfig } from "../../src/config";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function deepMerge<T>(base: T, override: DeepPartial<T>): T {
  if (override === undefined || override === null) return base;
  if (typeof base !== "object" || base === null) return override as T;
  if (Array.isArray(base)) return (override as unknown as T) ?? base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    const baseVal = (base as Record<string, unknown>)[k];
    out[k] = typeof baseVal === "object" && baseVal !== null && !Array.isArray(baseVal) && typeof v === "object" && v !== null
      ? deepMerge(baseVal, v as DeepPartial<typeof baseVal>)
      : v;
  }
  return out as T;
}

export function makeNaxConfig(overrides: DeepPartial<NaxConfig> = {}): NaxConfig {
  return deepMerge(DEFAULT_CONFIG as NaxConfig, overrides);
}

export function makeSparseNaxConfig(partial: Partial<NaxConfig>): NaxConfig {
  return partial as NaxConfig;
}
