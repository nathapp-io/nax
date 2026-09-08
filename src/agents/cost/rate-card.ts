/**
 * Rate-card resolver. Maps a configured model id to a `TokenPricing` card and
 * stamps which branch produced it.
 *
 * The counterpart to `native/models.ts:buildRateCard` — one source of truth on
 * each side, with the same shape so consumers do not branch on path.
 *
 * Flow:
 *  1. Strip any trailing `[effort]` suffix (`parseModelSpec`).
 *  2. Split on the FIRST slash: a provider id never contains one, a model id
 *     often does (`huggingface/MiniMaxAI/MiniMax-M2.7`). A string with no
 *     slash falls back to the bundled alias file (`model-aliases.json`); if
 *     no alias entry matches, infer a provider from the model id prefix
 *     (`gpt*` -> openai, `claude*` -> anthropic, `gemini*` -> google) and
 *     query the catalog with that.
 *  3. Hand `(provider, model)` to `lookupPricing`. On hit: `catalog-rates`.
 *     On miss: `fallback-rates` with a per-id warning. On lookup rejection:
 *     `fallback-rates` with a one-shot load-failure warning.
 *
 * Alias file path is `./model-aliases.json` (sibling). The file is bundled by
 * `bun build`; `resolveJsonModule` is enabled.
 */

import { lookupPricing as defaultLookupPricing } from "@/agents/catalog";
import type { TokenPricing } from "@/config/schema-types";
import { getSafeLogger } from "@/logger";
import { parseModelSpec } from "../model-spec";
import modelAliases from "./model-aliases.json";

/** The discriminated stamp the adapter writes on `pricingSource`. */
export type RateCardSource = "catalog-rates" | "fallback-rates";

export interface RateCard {
  readonly rates: TokenPricing;
  readonly source: RateCardSource;
}

/**
 * Coordinates one alias entry maps to. Both the bundled `model-aliases.json`
 * file and the lookup call use this shape.
 */
interface AliasEntry {
  readonly provider: string;
  readonly model: string;
}

/**
 * The generic fallback card used when neither the alias file nor the catalog
 * resolves a model. Stamped `fallback-rates`, never `catalog-rates`.
 */
export const FALLBACK_RATES: TokenPricing = Object.freeze({ inputPer1M: 3, outputPer1M: 15 });

/**
 * Lookup seam. The signature matches `@/agents/catalog:lookupPricing` so a
 * direct reference can be passed in, and tests can pass a stub.
 */
export type LookupPricing = (provider: string, model: string) => Promise<TokenPricing | undefined>;

/** One-line form for tests and consumers that just want the bare alias table. */
export const MODEL_ALIASES: Readonly<Record<string, AliasEntry>> = modelAliases;

/**
 * Set of ids whose catalog lookup has already been logged as missing this
 * run. Bounded by the number of distinct model ids the run touches; never
 * reset between calls so AC12 (one warning per distinct id) holds across
 * repeat lookups. Exposed via `_resetRateCardWarnings` so tests can clear it.
 */
const unresolvedIds = new Set<string>();

/**
 * Single-shot flag for catalog-load failures. A rejecting loader is logged
 * once (AC21); every later call under the same failure falls back silently.
 */
let warnedLoadFailure = false;

/**
 * Split a bare-or-slashed model id into `(provider, model)`. Returns
 * `undefined` when no provider is encoded — the caller then consults the
 * alias file and, failing that, infers a provider from the model-id prefix.
 */
function splitProviderModel(bare: string): AliasEntry | undefined {
  const slash = bare.indexOf("/");
  if (slash === -1) return undefined;
  const provider = bare.slice(0, slash);
  const model = bare.slice(slash + 1);
  if (provider === "" || model === "") return undefined;
  return { provider, model };
}

/**
 * Infer a provider from a model id that carries no slash. Mirrors the
 * heuristic `resolveModel` uses in `schema-types.ts` for the literal-id
 * fallback — "unknown" when none of the prefixes match, which the catalog
 * lookup then resolves as a miss.
 */
function inferProvider(modelId: string): string {
  if (modelId.startsWith("claude")) return "anthropic";
  if (modelId.startsWith("gpt") || modelId.startsWith("o1") || modelId.startsWith("o3")) return "openai";
  if (modelId.startsWith("gemini")) return "google";
  return "unknown";
}

/**
 * Resolve a model id to a rate card.
 *
 * - Strips `[effort]` via `parseModelSpec`.
 * - Splits `provider/model` on the first slash; otherwise consults the
 *   bundled alias file (no user override). If neither yields a known pair,
 *   infers the provider from the model id prefix and queries the catalog
 *   with that — `gpt-5.6-luna` becomes `(openai, gpt-5.6-luna)`.
 * - On miss (catalog miss, alias miss) returns the generic fallback card
 *   with `source: "fallback-rates"` and warns ONCE per distinct unresolved
 *   id.
 * - On catalog-load failure returns the fallback card with a single
 *   load-failure warning per process.
 */
export async function resolveRateCard(
  modelId: string,
  lookupPricing: LookupPricing = defaultLookupPricing,
): Promise<RateCard> {
  const { model: bare } = parseModelSpec(modelId);
  const splitCoords = splitProviderModel(bare);
  const coords = splitCoords ?? MODEL_ALIASES[bare] ?? { provider: inferProvider(bare), model: bare };

  if (coords.provider === "unknown") {
    warnUnresolved(modelId);
    return { rates: FALLBACK_RATES, source: "fallback-rates" };
  }

  let rates: TokenPricing | undefined;
  try {
    rates = await lookupPricing(coords.provider, coords.model);
  } catch (err) {
    if (!warnedLoadFailure) {
      getSafeLogger()?.warn("rate-card", `Catalog lookup failed; falling back to generic rate card`, {
        modelId,
        error: err instanceof Error ? err.message : String(err),
      });
      warnedLoadFailure = true;
    }
    return { rates: FALLBACK_RATES, source: "fallback-rates" };
  }

  if (rates === undefined) {
    warnUnresolved(modelId);
    return { rates: FALLBACK_RATES, source: "fallback-rates" };
  }
  return { rates, source: "catalog-rates" };
}

function warnUnresolved(modelId: string): void {
  if (unresolvedIds.has(modelId)) return;
  unresolvedIds.add(modelId);
  getSafeLogger()?.warn("rate-card", `No rate card found for model id; using generic fallback`, {
    modelId,
  });
}

/** Test seam — clears the per-process warning state. */
export function _resetRateCardWarnings(): void {
  unresolvedIds.clear();
  warnedLoadFailure = false;
}
