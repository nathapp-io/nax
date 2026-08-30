/**
 * Cost rate tables for all supported model tiers and specific models.
 */

import type { ModelTier } from "@/config/schema";
import type { ModelCostRates } from "./types";

/** Model tier cost rates (as of 2025-01) */
export const COST_RATES: Record<ModelTier, ModelCostRates> = {
  fast: {
    // Haiku 4.5
    inputPer1M: 0.8,
    outputPer1M: 4.0,
  },
  balanced: {
    // Sonnet 4.5
    inputPer1M: 3.0,
    outputPer1M: 15.0,
  },
  powerful: {
    // Opus 4
    inputPer1M: 15.0,
    outputPer1M: 75.0,
  },
};

/** Per-model pricing in $/1M tokens: { input, output } */
export const MODEL_PRICING: Record<
  string,
  { input: number; output: number; cacheRead?: number; cacheCreation?: number }
> = {
  // Anthropic Claude models (short aliases)
  sonnet: { input: 3, output: 15 },
  haiku: { input: 0.8, output: 4.0, cacheRead: 0.1, cacheCreation: 1.0 },
  opus: { input: 15, output: 75 },

  // Anthropic Claude models (full names)
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku": { input: 0.8, output: 4.0, cacheRead: 0.1, cacheCreation: 1.0 },
  "claude-haiku-4-5": { input: 0.8, output: 4.0, cacheRead: 0.1, cacheCreation: 1.0 },
  "claude-opus": { input: 15, output: 75 },
  "claude-opus-4": { input: 15, output: 75 },
  "claude-opus-4-6": { input: 15, output: 75 },

  // OpenAI models
  "gpt-4.1": { input: 10, output: 30 },
  "gpt-4": { input: 30, output: 60 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5 },

  // OpenAI GPT-5.6 — the tier nax profiles actually pin (`gpt-5.6-terra`,
  // `gpt-5.6-luna`), reached through parseModelSpec, which strips the `[effort]`
  // suffix before this lookup (#1468).
  "gpt-5.6-sol": { input: 5, output: 30 },
  "gpt-5.6-terra": { input: 2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },

  // Google Gemini — ≤200K-token prompts. Above that Google bills $2.50/$15.00;
  // this table has no context dimension, so the common tier is what it carries.
  "gemini-2.5-pro": { input: 1.25, output: 10 },

  // DeepSeek via opencode. Since 2026-08-16 DeepSeek bills by time of day
  // (peak 01:00-04:00 and 06:00-10:00 UTC, off-peak at half the peak rate).
  // This table has no time dimension, so it carries the *peak* rate: an
  // over-estimate keeps `execution.costLimit` protective, where an off-peak
  // card would let a peak-hours run overshoot the budget by 2x.
  "opencode-go/deepseek-v4-pro": { input: 1.32, output: 3.96, cacheRead: 0.044 },
  "opencode-go/deepseek-v4-flash": { input: 0.44, output: 1.32, cacheRead: 0.014 },

  // MiniMax — standard tier, prompts ≤512K. Above that MiniMax doubles both
  // rates; as with Gemini, the common tier is what this table can express.
  "minimax/MiniMax-M3": { input: 0.3, output: 1.2, cacheRead: 0.06 },
};

/**
 * The date the rates above were last checked against each vendor's published
 * price list.
 *
 * A wrong row is worse than a missing one: `resolvePricingSource` only detects
 * an *absent* entry, so a stale rate is stamped `"model-rates"` and reads as
 * authoritative in the cost ledger with no downstream signal. The 2026-08-29
 * review found rows off by 16-33x (`gemini-2.5-pro` at Flash rates) and three
 * keys that were not model ids at all (`gemini-2-pro`, `codex`,
 * `code-davinci-002`, the last two at 2023 code-davinci rates) — all removed or
 * corrected here. Vendors reprice often: DeepSeek's peak/off-peak split above is
 * two weeks old. Re-check this date when reviewing cost data.
 */
export const RATE_CARD_REVIEWED = "2026-08-30";
