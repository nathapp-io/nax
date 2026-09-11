/**
 * Native model resolver — owns the local catalog lookup for native ids.
 *
 * Precheck must not import nax-ai directly (scripts/check-nax-ai-imports.ts),
 * so the resolver sits next to the rest of the native path and exports one
 * injectable seam. Production callers receive the bundled pi-ai catalog; tests
 * replace the seam to drive specific resolution outcomes.
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

/** Look up one (provider, model) id against the catalog + overrides. */
export type ResolveFn = (provider: string, model: string) => Promise<ResolveResult>;

export interface ModelResolverDeps {
  resolve: ResolveFn;
}

/**
 * Default seam. Replaced in tests. Production wires `resolve` to the local
 * catalog (nax-ai's normalised bundled snapshot) — but that wiring is the
 * implementer's job; this stub just returns "unresolved" so the precheck
 * failure mode is observable without a real catalog import.
 */
export const _nativeModelResolverDeps: ModelResolverDeps = {
  resolve: async (_provider: string, _model: string): Promise<ResolveResult> => {
    // Touch the seam so a future wiring into getNativeClient can replace this
    // body without touching the call site. Importing getNativeClient here would
    // load the bundled catalog (~50ms) at module-eval time; that's the
    // implementer's call, not the stub's.
    void getNativeClient;
    return { status: "unresolved" };
  },
};

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
