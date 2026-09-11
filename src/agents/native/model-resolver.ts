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
 * Production resolver. Builds the cached client once per override set, then
 * calls `client.model(provider, model)` for every native id the precheck
 * walker hands it. The bundled catalog loads once per process via
 * `getNativeClient` (cached) so repeated calls amortise to a single load.
 *
 * Status mapping:
 *   - "resolved":   id resolves from the override-aware `client.model()` call
 *   - "error":      `getNativeClient(overrides)` rejected (catalog load
 *                   failed — network, schema, …). AC6 requires the check
 *                   to surface this as a warning, not a blocker, because
 *                   a transient catalog miss should not stop a run.
 *   - "unresolved": client built successfully but `client.model()` rejected
 *                   for this (provider, model) pair — id absent from the
 *                   catalog. The check emits a blocker at that site
 *                   (AC1/AC2), because the bundled snapshot not knowing
 *                   an id is the failure mode `nax#1983` exists to catch.
 *
 * The two catch arms are split so the resolver honours the AC6 contract;
 * a single `try { … } catch { "unresolved" }` would collapse the catalog
 * load failure into a per-id blocker and leave the "error" handlers in
 * `checkModelResolution` permanently dead code.
 */
export async function resolveNativeId(
  provider: string,
  model: string,
  overrides: readonly ProviderCatalogOverride[],
): Promise<ResolveResult> {
  // The native client's `Client` type comes from nax-ai; we declare the
  // variable as `unknown` to keep the file free of nax-ai type imports
  // (scripts/check-nax-ai-imports.ts forbids it). The single property we
  // touch (`model(provider, model)`) is what we actually need.
  let client: unknown;
  try {
    // Catalog load failure — the bundled snapshot itself is unavailable
    // (network, schema mismatch, …). Distinct from "id not in catalog":
    // the resolver never got far enough to look anything up.
    client = await getNativeClient(overrides);
  } catch {
    return { status: "error" };
  }

  try {
    const resolved = await (
      client as {
        model: (
          provider: string,
          model: string,
        ) => Promise<{
          pricing?: unknown;
          contextWindow?: number;
        }>;
      }
    ).model(provider, model);
    return {
      status: "resolved",
      hasPricing: resolved.pricing !== undefined,
      hasContextWindow: resolved.contextWindow !== undefined,
    };
  } catch {
    // Client built successfully but this (provider, model) is not in the
    // catalog. Per AC1/AC2 the check emits a blocker at this site.
    return { status: "unresolved" };
  }
}
