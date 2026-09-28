/**
 * Special-case merge handlers for `deepMergeConfig` (src/config/merger.ts).
 *
 * Extracted for the complexity drain (batch C1b). `DANGEROUS_MERGE_KEYS` and
 * `isPlainObject` moved here wholesale — merger.ts re-exports the keys set, so
 * the historical `./merger` import path (resolveEnvVars, SEC-09) is unchanged.
 * The two special-case handlers receive the recursive merger as a parameter so
 * this file stays a leaf: importing merger.ts back would cycle.
 */

/**
 * Own-enumerable keys that, if assigned via `result[key] = value` on a plain
 * object, tamper with the prototype chain (`__proto__`) or defeat
 * `isPlainObject`'s `constructor === Object` check (`constructor`,
 * `prototype`). `JSON.parse('{"__proto__": {...}}')` creates `__proto__` as a
 * normal own data property — `Object.keys` includes it — so an untrusted
 * project/profile config can smuggle one of these in (SEC-07).
 *
 * Exported so `resolveEnvVars` (SEC-09) can reuse the same guard rather than
 * duplicating the set (a second copy is how one of them goes stale).
 */
export const DANGEROUS_MERGE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

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
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Recursive-merge seam: lets mergeConstitution re-enter deepMergeConfig without an import cycle. */
type MergeDeep = (base: Record<string, unknown>, override: Record<string, unknown>) => Record<string, unknown>;

/**
 * Merge the nested hooks object: for each hook event, flatten both sides
 * (either may already be an array from a prior merge pass) then concatenate
 * into a single flat array.
 */
function mergeHookDefs(
  baseHookDefs: Record<string, unknown>,
  overrideHookDefs: Record<string, unknown>,
): Record<string, unknown> {
  const mergedHookDefs: Record<string, unknown> = {};

  // Collect all hook event names
  const allHookNames = new Set([...Object.keys(baseHookDefs), ...Object.keys(overrideHookDefs)]);

  for (const hookName of allHookNames) {
    const baseHook = baseHookDefs[hookName];
    const overrideHook = overrideHookDefs[hookName];

    const baseItems: unknown[] = Array.isArray(baseHook) ? baseHook : baseHook ? [baseHook] : [];
    const overrideItems: unknown[] = Array.isArray(overrideHook) ? overrideHook : overrideHook ? [overrideHook] : [];
    const combined = [...baseItems, ...overrideItems];
    mergedHookDefs[hookName] = combined.length === 1 ? combined[0] : combined;
  }

  return mergedHookDefs;
}

/**
 * Special case: hooks concatenation. Both sides are plain objects (checked by
 * the dispatcher); the merged value concatenates hook definitions and carries
 * the override's other hook config fields (e.g., skipGlobal).
 */
export function mergeHooks(baseValue: unknown, overrideValue: unknown): Record<string, unknown> {
  const baseHooks = baseValue as Record<string, unknown>;
  const overrideHooks = overrideValue as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...baseHooks };

  // Merge the nested hooks object
  if (isPlainObject(baseHooks.hooks) && isPlainObject(overrideHooks.hooks)) {
    const baseHookDefs = baseHooks.hooks as Record<string, unknown>;
    const overrideHookDefs = overrideHooks.hooks as Record<string, unknown>;
    merged.hooks = mergeHookDefs(baseHookDefs, overrideHookDefs);
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

  return merged;
}

/**
 * Special case: constitution content concatenation. Both sides are plain
 * objects (checked by the dispatcher); other fields deep-merge through the
 * recursive merger passed in by the dispatcher.
 */
export function mergeConstitution(
  baseValue: unknown,
  overrideValue: unknown,
  mergeDeep: MergeDeep,
): Record<string, unknown> {
  const baseConst = baseValue as Record<string, unknown>;
  const overrideConst = overrideValue as Record<string, unknown>;

  const baseContent = typeof baseConst.content === "string" ? baseConst.content : "";
  const overrideContent = typeof overrideConst.content === "string" ? overrideConst.content : "";

  // Compute desired content before merging so we never mutate deepMergeConfig's return value
  const desiredContent =
    baseContent && overrideContent ? `${baseContent}\n\n${overrideContent}` : overrideContent || baseContent;

  return {
    ...mergeDeep(baseConst, overrideConst),
    ...(desiredContent ? { content: desiredContent } : {}),
  };
}
