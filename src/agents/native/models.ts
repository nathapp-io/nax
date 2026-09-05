/**
 * Model reference, usage and cost for the native path.
 *
 * The provider travels inside the model string, not beside it: a multi-provider
 * agent needs it there, and opencode's entries already encode it that way
 * (ADR-027 section 1). Under acpx the same string stays opaque.
 */

import type { Pricing, ThinkingLevel } from "@nathapp/nax-ai";
import { inputClassTokens, type TokenUsage } from "@/agents/cost";
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
      // Naming the sibling field is the point (nax#1851): a reader looking at
      // `{ provider: "anthropic", model: "claude-sonnet-5" }` assumes the field
      // right there is the one being used, and the old message said nothing to
      // correct that. No suggested id is composed from it — on this path the
      // value reaching us may be `resolveModel`'s inference rather than
      // anything configured, and a guessed suggestion is worse than none.
      `Native model "${raw}" must be written "provider/model" (e.g. "openai/gpt-5.4-mini"). There is no default provider. A "provider" field beside "model" in config is NOT used on the native path — the provider belongs in the model id itself.`,
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
/**
 * Select the tier that applies to this request, or the base rates when none
 * does (nax#1847). "The highest matching threshold applies to the whole
 * request" (nax-ai's own framing) -- this returns one rate card, never a
 * blend of base and tier rates.
 *
 * What counts toward `inputTokensAbove`: `inputTokens + cacheReadInputTokens
 * + cacheCreationInputTokens` -- ALL input-class tokens, not just fresh
 * input. nax-ai's doc comment says "total input usage", which reads most
 * literally as the total. This is an ASSUMPTION, not confirmed against a
 * real vendor bill: the alternative reading -- counting only fresh
 * `inputTokens` toward the threshold -- is also plausible, and would cross
 * the threshold later. Counting the total is the conservative direction (it
 * crosses sooner, so any error over-reports cost rather than under-reports
 * it), matching this repo's existing bias toward keeping
 * `execution.costLimit` protective. Revisit if this is ever checked against
 * a real bill.
 *
 * "Exceeds" (nax-ai's own wording) is strict: a request landing exactly on
 * a threshold does NOT cross it, so the base rate wins at that boundary.
 * `inputTokensAbove` values do not nest into further tiers by construction
 * (`PricingTier extends PricingRates`, not `Pricing`), so at most one
 * threshold ever needs comparing per candidate.
 */
function selectRates(usage: TokenUsage, rates: TokenPricing): TokenPricing {
  if (rates.tiers === undefined || rates.tiers.length === 0) return rates;

  const totalInputTokens = inputClassTokens(usage);

  let selected: TokenPricing | undefined;
  let selectedThreshold = -1;
  for (const tier of rates.tiers) {
    if (totalInputTokens > tier.inputTokensAbove && tier.inputTokensAbove > selectedThreshold) {
      selected = tier;
      selectedThreshold = tier.inputTokensAbove;
    }
  }
  return selected ?? rates;
}

export function estimateCostUsd(usage: TokenUsage, rates: TokenPricing): number {
  const effectiveRates = selectRates(usage, rates);
  const cacheReadRate = effectiveRates.cacheReadPer1M ?? effectiveRates.inputPer1M;
  const cacheCreationRate = effectiveRates.cacheCreationPer1M ?? effectiveRates.inputPer1M;
  const inputCost = (usage.inputTokens / PER_MILLION) * effectiveRates.inputPer1M;
  const cacheReadCost = ((usage.cacheReadInputTokens ?? 0) / PER_MILLION) * cacheReadRate;
  const cacheCreationCost = ((usage.cacheCreationInputTokens ?? 0) / PER_MILLION) * cacheCreationRate;
  const outputCost = (usage.outputTokens / PER_MILLION) * effectiveRates.outputPer1M;
  return inputCost + cacheReadCost + cacheCreationCost + outputCost;
}

/**
 * Turn nax-ai's catalog `Pricing` into nax's own `TokenPricing` shape,
 * carrying `cacheRead` / `cacheWrite` / `tiers` through instead of
 * discarding them (nax#1843, nax#1847). Both `adapter.ts` call sites
 * (`complete()` and `sendTurn()`) build the rate object this way so the fix
 * cannot drift between them.
 *
 * An explicit `modelDef.pricing` override wins WHOLESALE: a user who
 * configured only `inputPer1M` / `outputPer1M` still gets
 * `estimateCostUsd`'s own `?? inputPer1M` fallback for cache classes, but
 * catalog values are never merged into an override -- that would silently
 * rewrite rates the user configured on purpose.
 */
export function buildRateCard(catalog: Pricing, override: TokenPricing | undefined): TokenPricing {
  if (override !== undefined) return override;
  return {
    inputPer1M: catalog.input,
    outputPer1M: catalog.output,
    cacheReadPer1M: catalog.cacheRead,
    cacheCreationPer1M: catalog.cacheWrite,
    ...(catalog.tiers !== undefined
      ? {
          tiers: catalog.tiers.map((tier) => ({
            inputPer1M: tier.input,
            outputPer1M: tier.output,
            cacheReadPer1M: tier.cacheRead,
            cacheCreationPer1M: tier.cacheWrite,
            inputTokensAbove: tier.inputTokensAbove,
          })),
        }
      : {}),
  };
}

/**
 * Resolve the context window `runNativeTurn` compacts against: an explicit
 * `ModelDef.contextWindow` override, falling back to nax-ai's
 * `ResolvedModel.contextWindow` (nax#1848). Same override-then-fallback shape
 * as `buildRateCard`, but with a direction guard that has no pricing
 * equivalent: the window never reaches the provider, so it feeds only
 * `shouldCompact` / `keepBudget` (`session/turn-loop.ts`). Lowering it is
 * therefore safe -- compaction just fires earlier against an otherwise real
 * request. Raising it above the real window would defeat compaction and
 * reintroduce the overflow it exists to prevent, so that direction is
 * rejected outright rather than clamped: this is a deliberate testing / cost
 * lever, not a value set by accident, and a wrong value should be loud. An
 * override equal to the real window is accepted -- it changes nothing.
 */
export function resolveContextWindow(override: number | undefined, realWindow: number): number {
  if (override === undefined) return realWindow;
  if (override > realWindow) {
    throw new NaxError(
      `configured contextWindow (${override}) exceeds the model's real context window (${realWindow}); ` +
        "raising it above the real window would defeat compaction and risk a provider overflow",
      "CONTEXT_WINDOW_OVERRIDE_EXCEEDS_REAL_WINDOW",
      { configuredContextWindow: override, realContextWindow: realWindow },
    );
  }
  return override;
}
