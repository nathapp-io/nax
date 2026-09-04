/**
 * Model reference, usage and cost for the native path.
 *
 * The provider travels inside the model string, not beside it: a multi-provider
 * agent needs it there, and opencode's entries already encode it that way
 * (ADR-027 section 1). Under acpx the same string stays opaque.
 */

import type { ThinkingLevel } from "@nathapp/nax-ai";
import type { TokenUsage } from "@/agents/cost";
import type { TokenPricing } from "@/config/schema-types";
import { NaxError } from "@/errors";
import { getSafeLogger } from "@/logger";
import { parseModelSpec } from "../model-spec";

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
  /** Reasoning-effort suffix, when the config string carried one. Free-form —
   *  validate with `toThinkingLevel` before sending it on the wire. */
  readonly effort?: string;
}

/**
 * Strip the nax-level `[effort]` suffix FIRST, then split on the FIRST slash: a
 * provider id never contains one, a model id often does
 * (`huggingface/MiniMaxAI/MiniMax-M2.7`). Order matters — the suffix is
 * trailing, so splitting on the slash before stripping it would leave the
 * suffix glued onto the model id (`"claude-opus-5[high]"`) and
 * `client.model()` would throw its own unknown-model error instead of this
 * function's clearer one.
 *
 * A suffix with no slash (`"claude-opus-5[high]"`) still fails malformed-model
 * validation: `parseModelSpec` only removes the suffix, it does not supply a
 * missing provider.
 */
export function parseNativeModel(raw: string): NativeModelRef {
  const { model: withoutSuffix, effort } = parseModelSpec(raw);
  const slash = withoutSuffix.indexOf("/");
  const provider = slash === -1 ? "" : withoutSuffix.slice(0, slash);
  const model = slash === -1 ? "" : withoutSuffix.slice(slash + 1);

  if (provider === "" || model === "") {
    throw new NaxError(
      `Native model "${raw}" must be written "provider/model" (e.g. "openai/gpt-5.4-mini"). There is no default provider.`,
      "NATIVE_MODEL_MALFORMED",
      { stage: "complete", model: raw },
    );
  }
  return { provider, model, ...(effort !== undefined ? { effort } : {}) };
}

/**
 * Every level nax-ai's `ThinkingLevel` union admits, as an exhaustive mapped
 * type rather than a hand-rolled string array. `Record<ThinkingLevel, true>`
 * only type-checks when every union member has an entry, so if nax-ai adds a
 * level upstream, this fails to COMPILE — a real gate, not a comment that can
 * silently drift out of sync with the union it mirrors.
 */
const THINKING_LEVELS: Record<ThinkingLevel, true> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
};

function isThinkingLevel(value: string): value is ThinkingLevel {
  return Object.hasOwn(THINKING_LEVELS, value);
}

/**
 * Translate nax's config-side "effort" suffix into nax-ai's request-side
 * "thinking" field. Kept in this one place, named for the seam it crosses: nax
 * calls the concept "effort", nax-ai calls the identical value "thinking".
 *
 * The suffix is a free-form string (see model-spec.ts), so a value outside
 * nax-ai's ThinkingLevel union is possible from a typo'd profile. This
 * mirrors applyReasoningEffort's stance in
 * src/agents/acp/reasoning-effort.ts: "Best-effort: a failure leaves the
 * session at the adapter default rather than failing the whole run. The
 * warning is what keeps that downgrade visible." nax does not clamp against
 * per-model capabilities here — that is nax-ai's clampThinkingLevel's job,
 * run inside client.complete against the resolved model's own
 * thinkingLevels.
 */
export function toThinkingLevel(effort: string | undefined): ThinkingLevel | undefined {
  if (effort === undefined) return undefined;
  if (isThinkingLevel(effort)) return effort;

  getSafeLogger()?.warn("native-adapter", `Unknown effort "${effort}"; continuing at provider default`, { effort });
  return undefined;
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
 * Cache reads and cache writes each bill at their own optional rate
 * (`cacheReadPer1M` / `cacheCreationPer1M`) when the rate card supplies one.
 * When a rate is absent, that class of token falls back to `inputPer1M` --
 * the old behaviour, kept as the fallback so `execution.costLimit` stays
 * protective for every rate card that has not been extended with cache rates.
 * Cache writes are priced separately from reads rather than folded into the
 * same sum: vendors typically charge a write a premium over plain input, so
 * billing it at the input (or read) rate would under-report in the opposite
 * direction from the over-report this function used to make on reads.
 */
export function estimateCostUsd(usage: TokenUsage, rates: TokenPricing): number {
  const cacheReadRate = rates.cacheReadPer1M ?? rates.inputPer1M;
  const cacheCreationRate = rates.cacheCreationPer1M ?? rates.inputPer1M;
  const inputCost = (usage.inputTokens / PER_MILLION) * rates.inputPer1M;
  const cacheReadCost = ((usage.cacheReadInputTokens ?? 0) / PER_MILLION) * cacheReadRate;
  const cacheCreationCost = ((usage.cacheCreationInputTokens ?? 0) / PER_MILLION) * cacheCreationRate;
  const outputCost = (usage.outputTokens / PER_MILLION) * rates.outputPer1M;
  return inputCost + cacheReadCost + cacheCreationCost + outputCost;
}
