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
 * Special case: constitution content concatenation. Both sides are plain
 * objects (checked by the dispatcher); other fields deep-merge through the
 * recursive merger passed in by the dispatcher.
 */
export function mergeConstitution(
  baseConst: Record<string, unknown>,
  overrideConst: Record<string, unknown>,
  mergeDeep: MergeDeep,
): Record<string, unknown> {
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
