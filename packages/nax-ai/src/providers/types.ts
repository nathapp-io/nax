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
export interface Pricing {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export type ProviderAuth =
  | { readonly kind: "api-key"; readonly env: string }
  | { readonly kind: "oauth"; readonly flow: string };

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
