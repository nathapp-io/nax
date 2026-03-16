/**
 * Cost rate tables for all supported model tiers and specific models.
 */

import type { ModelTier } from "../../config/schema";
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
  // Anthropic Claude models
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku": { input: 0.8, output: 4.0, cacheRead: 0.1, cacheCreation: 1.0 },
  "claude-haiku-4-5": { input: 0.8, output: 4.0, cacheRead: 0.1, cacheCreation: 1.0 },
  "claude-opus": { input: 15, output: 75 },
  "claude-opus-4": { input: 15, output: 75 },

  // OpenAI models
  "gpt-4.1": { input: 10, output: 30 },
  "gpt-4": { input: 30, output: 60 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5 },

  // Google Gemini
  "gemini-2.5-pro": { input: 0.075, output: 0.3 },
  "gemini-2-pro": { input: 0.075, output: 0.3 },

  // OpenAI Codex
  codex: { input: 0.02, output: 0.06 },
  "code-davinci-002": { input: 0.02, output: 0.06 },
};
