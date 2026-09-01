/**
 * Model reference, usage and cost for the native path.
 *
 * The provider travels inside the model string, not beside it: a multi-provider
 * agent needs it there, and opencode's entries already encode it that way
 * (ADR-027 section 1). Under acpx the same string stays opaque.
 */

import type { TokenUsage } from "@/agents/cost";
import type { TokenPricing } from "@/config/schema-types";
import { NaxError } from "@/errors";

/** nax-ai's usage shape. Declared locally: this file must not import nax-ai types into nax's surface. */
export interface NativeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

/** The one agent name that routes to this transport. Lives here, not in the
 *  barrel, so adapter.ts can import it without an index -> adapter -> index cycle. */
export const NATIVE_AGENT = "native";

export interface NativeModelRef {
  readonly provider: string;
  readonly model: string;
}

/**
 * Split on the FIRST slash: a provider id never contains one, a model id often
 * does (`huggingface/MiniMaxAI/MiniMax-M2.7`).
 */
export function parseNativeModel(raw: string): NativeModelRef {
  const slash = raw.indexOf("/");
  const provider = slash === -1 ? "" : raw.slice(0, slash);
  const model = slash === -1 ? "" : raw.slice(slash + 1);

  if (provider === "" || model === "") {
    throw new NaxError(
      `Native model "${raw}" must be written "provider/model" (e.g. "openai/gpt-5.4-mini"). There is no default provider.`,
      "NATIVE_MODEL_MALFORMED",
      { stage: "complete", model: raw },
    );
  }
  return { provider, model };
}

/**
 * The two sides name the cache fields differently. An absent field stays
 * absent rather than becoming 0, so "no cache data" and "zero cache tokens"
 * stay distinguishable downstream.
 */
export function toNaxTokenUsage(usage: NativeUsage): TokenUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined ? { cacheReadInputTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cacheCreationInputTokens: usage.cacheWriteTokens } : {}),
  };
}

const PER_MILLION = 1_000_000;

/**
 * Both sides express rates per 1M tokens (nax-ai's PricingRates is documented
 * so, and nax's TokenPricing is inputPer1M), so there is no unit conversion.
 *
 * Cache tokens bill at the input rate. Phase A does not model separate
 * cache-read / cache-write rates, and over-reporting a cache read as full input
 * is the safer direction of error.
 */
export function estimateCostUsd(usage: TokenUsage, rates: TokenPricing): number {
  const input = usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
  return (input / PER_MILLION) * rates.inputPer1M + (usage.outputTokens / PER_MILLION) * rates.outputPer1M;
}
