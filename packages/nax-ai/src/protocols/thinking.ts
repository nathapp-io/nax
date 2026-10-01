/**
 * Clamping a requested thinking level onto what a model actually supports.
 *
 * Clamping rather than throwing is deliberate: models expose different
 * granularities, and a profile that says "high" should not fail outright
 * because one model only offers off/low/medium. The caller's intent — think
 * harder than default — is still expressible.
 */

import { THINKING_LEVELS, type ThinkingLevel } from "./types.ts";

const rank = (level: ThinkingLevel): number => THINKING_LEVELS.indexOf(level);

export function clampThinkingLevel(requested: ThinkingLevel, supported: readonly ThinkingLevel[]): ThinkingLevel {
  if (supported.length === 0) return "off";
  if (supported.includes(requested)) return requested;

  // Sorted ascending so that "first seen wins on a tie" means "lower level
  // wins" — callers are not required to pass an ordered list.
  const ordered = [...supported].sort((a, b) => rank(a) - rank(b));
  const target = rank(requested);

  // Safe: `ordered` is non-empty, guarded above. noUncheckedIndexedAccess
  // still widens the type, hence the assertion.
  let best = ordered[0] as ThinkingLevel;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const level of ordered) {
    const distance = Math.abs(rank(level) - target);
    // Strict `<` keeps the first-seen (lower) candidate on a tie: spending
    // fewer thinking tokens than asked is the safer surprise.
    if (distance < bestDistance) {
      best = level;
      bestDistance = distance;
    }
  }

  return best;
}
