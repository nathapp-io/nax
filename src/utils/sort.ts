/**
 * Comparators for `Array.prototype.sort`.
 *
 * A bare `.sort()` coerces every element to a string and orders by UTF-16 code
 * unit. That is correct for a `string[]` and silently wrong for a `number[]`
 * (`[2, 10]` sorts to `[10, 2]`), so `suspicious/useArraySortCompare` bans the
 * bare form outright. These are the comparators it should resolve to.
 */

/**
 * Code-point ordering for strings.
 *
 * Byte-identical to what a bare `.sort()` already does on a `string[]`, so
 * adopting it never changes an existing ordering. Preferred over
 * `localeCompare` wherever the order is part of a contract: locale-aware
 * collation is not stable across locales or ICU versions (CTX-5 — see
 * `src/context/engine/digest.ts`).
 */
export const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Ascending numeric ordering — the comparison a bare `.sort()` does *not* do. */
export const byNumber = (a: number, b: number): number => a - b;
