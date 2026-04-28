/**
 * Configuration Merger Utility
 *
 * Deep merge utility for NaxConfig with special handling:
 * - Arrays: replace (not merge)
 * - Null values: remove keys
 * - Hooks: concatenate from both configs
 * - Constitution content: concatenate with newline separator
 */

import type { NaxConfig } from "./schema";

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
    const overrideValue = override[key];

    // Skip undefined values
    if (overrideValue === undefined) {
      continue;
    }

    // Handle null values - remove key from result
    if (overrideValue === null) {
      delete result[key];
      continue;
    }

    const baseValue = result[key];

    // Special case: hooks concatenation
    if (key === "hooks" && isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      const baseHooks = baseValue as Record<string, unknown>;
      const overrideHooks = overrideValue as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...baseHooks };

      // Merge the nested hooks object
      if (isPlainObject(baseHooks.hooks) && isPlainObject(overrideHooks.hooks)) {
        const baseHookDefs = baseHooks.hooks as Record<string, unknown>;
        const overrideHookDefs = overrideHooks.hooks as Record<string, unknown>;
        const mergedHookDefs: Record<string, unknown> = {};

        // Collect all hook event names
        const allHookNames = new Set([...Object.keys(baseHookDefs), ...Object.keys(overrideHookDefs)]);

        // For each hook event, concatenate hooks into an array
        for (const hookName of allHookNames) {
          const baseHook = baseHookDefs[hookName];
          const overrideHook = overrideHookDefs[hookName];

          if (baseHook && overrideHook) {
            // Both exist - create array with both
            mergedHookDefs[hookName] = [baseHook, overrideHook];
          } else if (overrideHook) {
            // Only override exists
            mergedHookDefs[hookName] = overrideHook;
          } else {
            // Only base exists
            mergedHookDefs[hookName] = baseHook;
          }
        }

        merged.hooks = mergedHookDefs;
      } else if (overrideHooks.hooks) {
        merged.hooks = overrideHooks.hooks;
      }

      // Handle other hook config fields (e.g., skipGlobal)
      for (const hookKey of Object.keys(overrideHooks)) {
        if (hookKey !== "hooks") {
          merged[hookKey] = overrideHooks[hookKey];
        }
      }

      result[key] = merged;
      continue;
    }

    // Special case: constitution content concatenation
    if (key === "constitution" && isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      const baseConst = baseValue as Record<string, unknown>;
      const overrideConst = overrideValue as Record<string, unknown>;

      const baseContent = typeof baseConst.content === "string" ? baseConst.content : "";
      const overrideContent = typeof overrideConst.content === "string" ? overrideConst.content : "";

      // Compute desired content before merging so we never mutate deepMergeConfig's return value
      const desiredContent =
        baseContent && overrideContent ? `${baseContent}\n\n${overrideContent}` : overrideContent || baseContent;

      const mergedConstitution = {
        ...deepMergeConfig(baseConst, overrideConst),
        ...(desiredContent ? { content: desiredContent } : {}),
      };

      result[key] = mergedConstitution;
      continue;
    }

    // Arrays replace completely (no merging)
    if (Array.isArray(overrideValue)) {
      result[key] = [...overrideValue];
      continue;
    }

    // Recursive merge for plain objects
    if (isPlainObject(overrideValue) && isPlainObject(baseValue)) {
      result[key] = deepMergeConfig(baseValue as Record<string, unknown>, overrideValue as Record<string, unknown>);
      continue;
    }

    // Default: override replaces base
    result[key] = overrideValue;
  }

  return result as T;
}

/**
 * Check if value is a plain object (not null, not array, not class instance).
 *
 * @param value - Value to check
 * @returns True if value is a plain object
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && value.constructor === Object;
}
