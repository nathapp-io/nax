import { DEFAULT_CONFIG } from "@/config";
import type { NaxConfig } from "@/config";

/**
 * `NonNullable` before the `extends object` test: for an OPTIONAL nested config
 * (`debate?: DebateConfig`), `T[K]` is `DebateConfig | undefined`, and a union
 * with `undefined` does not extend `object` — so the old form fell through to
 * `: T[K]` and demanded the FULL `DebateConfig` for a one-field override.
 * See #1514 §Patterns learned item 2.
 */
export type DeepPartial<T> = {
  [K in keyof T]?: NonNullable<T[K]> extends object ? DeepPartial<NonNullable<T[K]>> : T[K];
};

function isEmptyObject(val: unknown): boolean {
  return typeof val === "object" && val !== null && !Array.isArray(val) && Object.keys(val).length === 0;
}

function deepMerge<T>(base: T, override: DeepPartial<T>): T {
  if (override === undefined || override === null) return base;
  if (typeof base !== "object" || base === null) return override as T;
  if (Array.isArray(base)) return (override as unknown as T) ?? base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    const baseVal = (base as Record<string, unknown>)[k];
    out[k] =
      typeof baseVal === "object" &&
      baseVal !== null &&
      !Array.isArray(baseVal) &&
      typeof v === "object" &&
      v !== null &&
      !isEmptyObject(v)
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
