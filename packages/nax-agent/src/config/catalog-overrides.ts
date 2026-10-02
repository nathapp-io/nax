/**
 * Catalog-override and thinking-level types: the config shapes the native
 * agent reads (S1 spec section 4.2, port 4). Pure types with no imports, so
 * they move into nax-agent unchanged; `schema-types.ts` re-exports them for
 * nax's config schema.
 */

/**
 * Reasoning levels the catalog may declare, mirrored from nax-ai's
 * `ThinkingLevel` union (nax#1982). nax-ai cannot be imported here
 * (`packages/repo-tooling/scripts/check-nax-ai-imports.ts`), so the union is hand-mirrored;
 * `test/unit/agents/native/models.test.ts` pins it against
 * `THINKING_LEVELS` in `src/agents/native/models.ts`, which is itself a
 * compile-time-exhaustive `Record<ThinkingLevel, true>` over the nax-ai
 * union.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Rates for a catalog override, in the CATALOG's vocabulary (`input`,
 * `output`, `cacheRead`, `cacheWrite`, per 1M tokens) — not `ConfigPricing`'s
 * `*Per1M` names. This block describes the simulated catalog entry, so it
 * speaks the catalog's language; `ModelDef.pricing` remains the cost-math
 * override in nax's own vocabulary.
 */
export interface CatalogPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * nax#2191: OpenRouter-compatible provider routing, mirrored from nax-ai
 * 0.1.15's `OpenRouterRouting`. Snake_case on purpose — keys are wire field
 * names and pass through unmapped. The protocol-side rejection (non-
 * `openai-completions` protocols, empty declaration) is nax-ai's, owned in
 * `providers/override-model.ts`'s `assertOverrideModelRouting`.
 *
 * `sort: "latency"` / `"throughput"` pair with `quantizations` in the typical
 * case: OpenRouter's default routing for a slug is overwhelmingly a single
 * quantization from a single endpoint, and a sort change may otherwise pick
 * a lower-precision endpoint that the call site never intended (the issue's
 * own note). The schema does not enforce the pairing — that is UX clutter
 * for an opt-in override — but `docs/guides/configuration.md` and the config
 * description should call it out.
 */
export interface OpenRouterRouting {
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  data_collection?: "deny" | "allow";
  zdr?: boolean;
  order?: readonly string[];
  only?: readonly string[];
  ignore?: readonly string[];
  quantizations?: readonly string[];
  sort?: "price" | "throughput" | "latency";
}

/**
 * One complete catalog entry for a model the bundled pi-ai snapshot does not
 * know. Complete, not a patch: nax-ai's `normaliseCatalog` replaces any
 * same-id entry wholesale and lazily creates the provider bucket, so nothing
 * here may be left to the bundled value.
 */
export interface CatalogModelOverride {
  id: string;
  /** nax-ai protocol id, e.g. "openai-completions" or "anthropic-messages". */
  protocol: string;
  contextWindow: number;
  /**
   * Output ceiling. Optional: when absent, nax-ai inherits the ceiling of the
   * bundled sibling it synthesises the override from, which can be smaller
   * than the newer model's real one (nax-ai 0.1.11, nax#1982).
   */
  maxTokens?: number;
  supportsTools: boolean;
  thinkingLevels: ThinkingLevel[];
  pricing: CatalogPricing;
  /**
   * nax#2191: OpenRouter-compatible provider routing forwarded verbatim to
   * nax-ai's `ResolvedModel.openRouterRouting`. Reaches the wire only on
   * `protocol: "openai-completions"` (nax-ai `assertOverrideModelRouting`).
   */
  openRouterRouting?: OpenRouterRouting;
}

/** Provider-scoped catalog overrides — maps 1:1 onto nax-ai's `ProviderOverride[]`. */
export interface ProviderCatalogOverride {
  provider: string;
  /**
   * Provider-wide endpoint redirect (nax#2019). Applies to the whole provider,
   * not to `models` individually, despite sitting alongside a model list.
   */
  baseUrl?: string;
  /** Provider-wide extra request headers (nax#2019). May carry credentials. */
  headers?: Record<string, string>;
  models: CatalogModelOverride[];
}
