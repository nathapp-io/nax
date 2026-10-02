/** Pure usage arithmetic shared by the pricing core and nax's reporting helpers. */
import type { TokenUsage } from "./standard-types";

/** Coerce a token count to a finite number, falling back to 0. Defense in
 * depth (BUG-10): upstream guards in parser.ts / token-mapper.ts should
 * already keep non-numeric values out, but `addTokenUsage` is a cheap pure
 * function reachable from multiple call sites, so it validates its own
 * inputs rather than trusting the static TokenUsage type — a malformed
 * operand (e.g. a stringified number) would otherwise trigger `+`'s string
 * concatenation instead of numeric addition, and a genuinely non-numeric
 * value would propagate NaN into the running total. */
function toFiniteTokenCount(value: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Sum two TokenUsage values. Pure.
 * A cache field is present on the result when either operand carries it or the
 * sum is positive, preserving the zero-versus-absent distinction producers set. */
export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  // BUG-58: apply the same finite-number guard to the cache fields as
  // inputTokens/outputTokens above — `?? 0` alone only guards undefined/null,
  // not a malformed non-numeric operand (e.g. a stringified number), which
  // would otherwise hit `+`'s string-concatenation behavior here too.
  const cacheRead = toFiniteTokenCount(a.cacheReadTokens ?? 0) + toFiniteTokenCount(b.cacheReadTokens ?? 0);
  const cacheWrite = toFiniteTokenCount(a.cacheWriteTokens ?? 0) + toFiniteTokenCount(b.cacheWriteTokens ?? 0);
  return {
    inputTokens: toFiniteTokenCount(a.inputTokens) + toFiniteTokenCount(b.inputTokens),
    outputTokens: toFiniteTokenCount(a.outputTokens) + toFiniteTokenCount(b.outputTokens),
    ...(cacheRead > 0 || a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined
      ? { cacheReadTokens: cacheRead }
      : {}),
    ...(cacheWrite > 0 || a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: cacheWrite }
      : {}),
  };
}

/**
 * Tokens the provider counted as part of the prompt.
 *
 * Cache reads and writes are prompt tokens that the provider reports
 * separately because it prices them differently — not tokens that were
 * absent from the request. Any consumer asking "how big was the prompt"
 * needs all three; `inputTokens` alone answers a different question and,
 * under prompt caching, collapses to near zero (nax#1852).
 *
 * Output is deliberately excluded: this measures the prompt, not the call.
 */
export function inputClassTokens(usage: TokenUsage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}
