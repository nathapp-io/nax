/**
 * Provider and model vocabulary.
 *
 * These are nax-ai's own types, deliberately not pi-ai's. A future hand-written
 * protocol backend needs baseUrl, auth and headers, and must be able to obtain
 * them without importing pi-ai — which is only true if the catalog is
 * normalised into this shape at the boundary.
 */

import type { ThinkingLevel } from "../protocols/types.ts";

/** Rates per 1M tokens. nax-ai supplies rates; the consumer computes cost. */
export interface PricingRates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/**
 * A request-wide pricing tier. The highest matching threshold applies to the
 * whole request.
 *
 * Extends the rates rather than `Pricing` so a tier cannot carry its own tiers.
 */
export interface PricingTier extends PricingRates {
  /** Applies when total input usage exceeds this token count. */
  readonly inputTokensAbove: number;
}

export interface Pricing extends PricingRates {
  /**
   * Present for the 22 upstream models that price in tiers. A consumer that
   * ignores this bills the base rates and will under-report a long-context
   * request; one that honours it is correct. nax-ai still computes no cost.
   */
  readonly tiers?: readonly PricingTier[];
}

export type ProviderAuth =
  /**
   * `env` is descriptive only and is often absent: the upstream catalog does
   * not expose variable names in a form that can be read without consulting
   * the ambient environment. Auth resolution never reads this field.
   */
  { readonly kind: "api-key"; readonly env?: string } | { readonly kind: "oauth"; readonly flow: string };

export interface ResolvedProvider {
  readonly id: string;
  readonly baseUrl: string;
  readonly auth: ProviderAuth;
  readonly headers?: Readonly<Record<string, string>>;
  readonly defaultProtocol: string;
}

export interface ResolvedModel {
  readonly id: string;
  readonly provider: string;
  /** May differ from the provider default: one provider can span several. */
  readonly protocol: string;
  readonly pricing: Pricing;
  readonly contextWindow: number;
  readonly supportsTools: boolean;
  /** Empty means the model has no thinking support. */
  readonly thinkingLevels: readonly ThinkingLevel[];
}

/**
 * Declaration-data overrides only.
 *
 * Behaviour changes are a wrapping protocol backend, not an override. Keeping
 * that line sharp stops this growing into a second, weaker extension mechanism
 * competing with the registry.
 */
export interface ProviderOverride {
  readonly provider: string;
  readonly baseUrl?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly models?: readonly ResolvedModel[];
}
