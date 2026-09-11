/**
 * Native model resolver — owns the local catalog lookup for native ids.
 *
 * Precheck must not import nax-ai directly (scripts/check-nax-ai-imports.ts),
 * so the resolver sits next to the rest of the native path. Production callers
 * go through `resolveNativeId` (which uses the cached nax-ai client); tests
 * bypass the function entirely and stub `_modelResolutionDeps` in
 * `src/precheck/checks-model-resolution.ts` to drive specific outcomes without
 * loading the bundled catalog.
 *
 * Three states the resolver reports:
 *   - "resolved":     id resolves in the catalog (optionally with override data)
 *   - "unresolved":   id is provider-qualified but absent from the catalog and
 *                     not declared under agent.native.catalogOverrides
 *   - "error":        the catalog itself failed to load (network, schema, …)
 *
 * The third state is a warning, not a blocker — a transient catalog miss
 * should not stop a run, but it must be surfaced loudly enough to prevent the
 * adversarial-review parse error the story exists to fix.
 */

import type { ProviderCatalogOverride } from "@/config/schema-types";
import { getNativeClient } from "./client";

export type ResolveStatus = "resolved" | "unresolved" | "error";

export interface ResolveResult {
  status: ResolveStatus;
  /**
   * When `status === "resolved"` and the matched entry declared pricing /
   * contextWindow, the resolved values. The precheck check uses the PRESENCE
   * of these fields to decide whether a literal pin dropped tier-configured
   * overrides — the actual numbers do not need to flow through.
   */
  hasPricing?: boolean;
  hasContextWindow?: boolean;
}

/**
 * Translate a `catalogOverrides` list into the precheck-side "id is resolvable"
 * table. The precheck check uses this so a user-declared override that the
 * bundled pi-ai snapshot does not know about counts as resolved (AC4).
 *
 * Mirrors `toProviderOverrides` in `models.ts` at the level of detail precheck
 * needs — just the id, the provider, and whether pricing/contextWindow were
 * declared. A real provider-overrides wiring would emit the same table; the
 * implementer can swap implementations without changing the call site.
 */
export function overrideResolvability(
  overrides: readonly ProviderCatalogOverride[],
): ReadonlyMap<string, { hasPricing: boolean; hasContextWindow: boolean }> {
  const out = new Map<string, { hasPricing: boolean; hasContextWindow: boolean }>();
  for (const override of overrides) {
    for (const model of override.models) {
      out.set(`${override.provider}/${model.id}`, {
        hasPricing: model.pricing !== undefined,
        hasContextWindow: model.contextWindow !== undefined,
      });
    }
  }
  return out;
}

/**
 * Production resolver. Builds the cached client once per override set, then
 * calls `client.model(provider, model)` for every native id the precheck
 * walker hands it. The bundled catalog loads once per process via
 * `getNativeClient` (cached) so repeated calls amortise to a single load.
 *
 * The override table is checked first: a user-declared override is always
 * resolvable (AC4) regardless of what the bundled catalog says.
 *
 * Error shape: a rejected promise from `client.model()` (id the bundled
 * catalog doesn't know) becomes "unresolved" — the check emits a blocker at
 * that site. The client construction itself can throw (catalog load failure);
 * that becomes "unresolved" too — the check emits a blocker — because by the
 * time we reach this function, the override table is already empty (the
 * check short-circuited on it) so the only failure mode is "the bundled
 * catalog does not know this id".
 */
export async function resolveNativeId(
  provider: string,
  model: string,
  overrides: readonly ProviderCatalogOverride[],
): Promise<ResolveResult> {
  const resolvability = overrideResolvability(overrides);
  const key = `${provider}/${model}`;
  const override = resolvability.get(key);
  if (override !== undefined) {
    return {
      status: "resolved",
      hasPricing: override.hasPricing,
      hasContextWindow: override.hasContextWindow,
    };
  }
  try {
    const client = await getNativeClient(overrides);
    const resolved = await client.model(provider, model);
    return {
      status: "resolved",
      hasPricing: resolved.pricing !== undefined,
      hasContextWindow: resolved.contextWindow !== undefined,
    };
  } catch {
    return { status: "unresolved" };
  }
}
