/**
 * Mutation candidate selection — pure, deterministic even-spread sampler.
 *
 * Selection is a separate concern from generation: `generateMutants` returns
 * every candidate for a file, and the operation calls `selectEvenlySpaced`
 * once over the combined list. Splitting selection out keeps it pure and
 * testable in isolation, and gives downstream callers a single hook for
 * future budget algorithms without re-touching the mutation core.
 */

import type { Mutant } from "./types";

export function selectEvenlySpaced(mutants: readonly Mutant[], max: number): Mutant[] {
  const length = mutants.length;
  if (length === 0 || max <= 0) return [];
  if (length <= max) return mutants.slice();

  const stride = Math.floor(length / max);
  const picked: Mutant[] = [];
  for (let i = 0; i < max; i++) {
    const index = i * stride;
    const mutant = mutants[index];
    if (mutant === undefined) break;
    picked.push(mutant);
  }
  return picked;
}
