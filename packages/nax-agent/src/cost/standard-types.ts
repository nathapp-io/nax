/**
 * The one usage and rate vocabulary (S1 spec, ruling R3): nax-ai's types.
 *
 * Staging re-export for S1-1. Code outside src/agents/native and
 * src/agents/catalog takes these types from here, so check-nax-ai-imports
 * keeps a single allow-listed file. In S1-5 this becomes a re-export in
 * packages/nax-agent and the allow-list entry is removed.
 */
export type { Pricing, PricingRates, PricingTier, TokenUsage } from "@nathapp/nax-ai";
