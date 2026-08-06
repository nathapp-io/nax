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
  const budget = Math.max(0, Math.floor(max));
  if (length === 0 || budget <= 0) return [];
  if (length <= budget) return mutants.slice();

  const stride = Math.floor(length / budget);
  const picked: Mutant[] = [];
  for (let i = 0; i < budget; i++) {
    const index = i * stride;
    picked.push(mutants[index]);
  }
  return picked;
}
