/**
 * Configuration Merger Utility
 *
 * Deep merge utility for NaxConfig with special handling:
 * - Arrays: replace (not merge)
 * - Null values: remove keys
 * - Hooks: concatenate from both configs
 * - Constitution content: concatenate with newline separator
 *
 * The two special-case handlers (and the SEC-07 primitives they share with
 * the rest of the config layer) live in `./merger-special-cases`; this file
 * sequences the per-key decision chain.
 */

import { DANGEROUS_MERGE_KEYS, isPlainObject, mergeConstitution, mergeHooks } from "./merger-special-cases";
import type { NaxConfig } from "./schema";

export { DANGEROUS_MERGE_KEYS };

/**
 * Apply one override key to the in-place result accumulator. Every branch of
 * the original loop settled the key (`continue`), so there is no fall-through:
 * the three guard arms skip/delete and the merge arms assign.
 */
function applyOverrideKey(result: Record<string, unknown>, key: string, overrideValue: unknown): void {
  // SEC-07: never assign into __proto__/constructor/prototype — doing so
  // would tamper with `result`'s actual prototype chain or defeat
  // isPlainObject's constructor check on a later merge pass.
  if (DANGEROUS_MERGE_KEYS.has(key)) {
    return;
  }

  // Skip undefined values
  if (overrideValue === undefined) {
    return;
  }

  // Handle null values - remove key from result
  if (overrideValue === null) {
    delete result[key];
    return;
  }

  const baseValue = result[key];

  // Special case: hooks concatenation
  if (key === "hooks" && isPlainObject(baseValue) && isPlainObject(overrideValue)) {
    result[key] = mergeHooks(baseValue, overrideValue);
    return;
  }

  // Special case: constitution content concatenation
  if (key === "constitution" && isPlainObject(baseValue) && isPlainObject(overrideValue)) {
    result[key] = mergeConstitution(baseValue, overrideValue, deepMergeConfig);
    return;
  }

  // Arrays replace completely (no merging)
  if (Array.isArray(overrideValue)) {
    result[key] = [...overrideValue];
    return;
  }

  // Recursive merge for plain objects
  if (isPlainObject(overrideValue) && isPlainObject(baseValue)) {
    result[key] = deepMergeConfig(baseValue as Record<string, unknown>, overrideValue as Record<string, unknown>);
    return;
  }

  // Default: override replaces base
  result[key] = overrideValue;
}

/**
 * Deep merge two configuration objects.
 *
 * Rules:
 * - Objects are merged recursively
 * - Arrays replace (override completely replaces base)
 * - Null values in override remove the key from result
 * - Undefined values in override are skipped
 * - Hooks are concatenated (both base and override hooks preserved)
 * - Constitution content is concatenated with newline separator
 *
 * @param base - Base configuration object
 * @param override - Override configuration object
 * @returns New merged configuration (immutable - does not mutate inputs)
 */
export function deepMergeConfig<T = NaxConfig>(base: Record<string, unknown>, override: Record<string, unknown>): T {
  // Start with a clone of base to ensure immutability
  const result: Record<string, unknown> = { ...base };

  for (const key of Object.keys(override)) {
    applyOverrideKey(result, key, override[key]);
  }

  return result as T;
}
