/**
 * Token estimation.
 *
 * One heuristic, one home. `estimateTokens` used to live in the optimizer
 * module, which was deleted along with the optimizer stage that consumed it;
 * eight context/constitution modules and two barrels used the function and
 * never the optimizer, so the function moved here unchanged and they import
 * this leaf.
 *
 * Deliberately dependency-free and pure — no I/O, no config, no logger.
 */

/**
 * Estimate token count using simple heuristic.
 * ~4 chars per token for English text (rough estimate).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
