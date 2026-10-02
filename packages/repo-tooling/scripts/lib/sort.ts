/**
 * Code-point ordering for strings: a local copy of nax-agent's `byCodePoint`
 * (packages/nax-agent/src/internal/sort.ts). repo-tooling depends on no nax
 * package, so the gates that need a stable order use this one-liner instead.
 */
export const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
