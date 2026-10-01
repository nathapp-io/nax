/**
 * Mapping from the underlying client's usage record to this package's.
 *
 * Kept as a standalone pure function, separate from any call path, because it
 * is the piece most likely to be re-pointed at a different backend later: a
 * hand-rolled protocol would produce the same `TokenUsage` from a different
 * source shape, and nothing else would need to change.
 *
 * Two deliberate differences from the upstream shape:
 *
 *  - `reasoning` is dropped. Upstream documents it as a *subset* of `output`,
 *    so surfacing it alongside would invite double-counting when a consumer
 *    sums fields to compute cost.
 *  - `cacheWrite1h` is folded into `cacheWriteTokens` rather than exposed.
 *    It is a subset of `cacheWrite` that only one provider reports, and the
 *    generic vocabulary here should not grow a provider-specific field.
 *
 * Zeroes are preserved rather than elided: upstream always populates the four
 * base counters, so a zero means "the provider reported none", which is a
 * different claim from a missing field.
 */

import type { TokenUsage } from "./types.ts";

/** The subset of the upstream usage record this mapping reads. */
export interface UpstreamUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export function toTokenUsage(usage: UpstreamUsage): TokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
  };
}

/**
 * Total billable tokens for a call.
 *
 * Cache reads and writes are counted because providers bill them; they are
 * priced differently from uncached input, which is why the caller needs the
 * separated `TokenUsage` rather than a single number.
 */
export function totalTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}
