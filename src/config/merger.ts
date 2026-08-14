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
 * Own-enumerable keys that, if assigned via `result[key] = value` on a plain
 * object, tamper with the prototype chain (`__proto__`) or defeat
 * `isPlainObject`'s `constructor === Object` check (`constructor`,
 * `prototype`). `JSON.parse('{"__proto__": {...}}')` creates `__proto__` as a
 * normal own data property — `Object.keys` includes it — so an untrusted
 * project/profile config can smuggle one of these in (SEC-07).
 */
const DANGEROUS_MERGE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

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
    // SEC-07: never assign into __proto__/constructor/prototype — doing so
    // would tamper with `result`'s actual prototype chain or defeat
    // isPlainObject's constructor check on a later merge pass.
    if (DANGEROUS_MERGE_KEYS.has(key)) {
      continue;
    }

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

        // For each hook event, flatten both sides (either may already be an array
        // from a prior merge pass) then concatenate into a single flat array.
        for (const hookName of allHookNames) {
          const baseHook = baseHookDefs[hookName];
          const overrideHook = overrideHookDefs[hookName];

          const baseItems: unknown[] = Array.isArray(baseHook) ? baseHook : baseHook ? [baseHook] : [];
          const overrideItems: unknown[] = Array.isArray(overrideHook)
            ? overrideHook
            : overrideHook
              ? [overrideHook]
              : [];
          const combined = [...baseItems, ...overrideItems];
          mergedHookDefs[hookName] = combined.length === 1 ? combined[0] : combined;
        }

        merged.hooks = mergedHookDefs;
      } else if (isPlainObject(overrideHooks.hooks)) {
        // Guard: only assign if it's a plain object (not an array or primitive)
        merged.hooks = overrideHooks.hooks;
      }

      // Handle other hook config fields (e.g., skipGlobal)
      for (const hookKey of Object.keys(overrideHooks)) {
        if (hookKey !== "hooks" && !DANGEROUS_MERGE_KEYS.has(hookKey)) {
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
 * SEC-07: checks the actual prototype rather than `value.constructor === Object`
 * — an object literal like `{ constructor: {...}, ... }` shadows the inherited
 * `constructor` accessor with an own data property, which would defeat the old
 * check and cause this branch to treat the object as non-plain, falling
 * through to full replacement instead of a recursive (key-filtered) merge.
 *
 * @param value - Value to check
 * @returns True if value is a plain object
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
