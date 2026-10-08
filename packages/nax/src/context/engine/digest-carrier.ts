/**
 * Context Engine v2 — Prior-stage digest carrier resolution.
 *
 * The prior-stage digest has exactly one carrier: either a scored `plan-digest`
 * chunk (Amendment B AC-51) that pays for itself inside the packer, or the
 * legacy rendered preamble. The chunk is only *attempted* before packing — it
 * can be evicted under budget pressure — so the final carrier is resolved
 * AFTER packing (see {@link resolveDigestCarrier}) to guarantee the digest is
 * never dropped and never carried twice.
 */

import type { PackedChunk } from "./packing";
import type { ContextRequest } from "./types";

/** providerId stamped on the injected digest chunk by the orchestrator. */
export const PLAN_DIGEST_PROVIDER_ID = "plan-digest";

/**
 * The digest to inject as a scored `plan-digest` chunk, or undefined to use the
 * legacy preamble. Requires boost > 1 AND a non-blank digest: a whitespace-only
 * digest is treated as absent so no blank chunk is injected, consistent with the
 * preamble renderer and the token accounting (both trim).
 */
export function boostedDigestChunk(request: ContextRequest): string | undefined {
  const digest = request.priorStageDigest?.trim();
  return digest && (request.planDigestBoost ?? 1.0) > 1.0 ? request.priorStageDigest : undefined;
}

/** The single carrier chosen for the prior-stage digest. */
export interface DigestCarrier {
  /** True when the digest rode as a packed chunk (so the preamble is suppressed). */
  digestAsChunk: boolean;
  /** Preamble digest to render, or undefined when carried as a chunk. */
  renderPriorDigest: string | undefined;
  /** Request as the manifest should see it (digest stripped iff carried as a chunk). */
  manifestRequest: ContextRequest;
}

/**
 * Resolve the final carrier after packing. When the boosted chunk was evicted
 * (budget, dedupe, or below-min), fall back to the legacy preamble and retain
 * `priorStageDigest` in the manifest request so its tokens are counted exactly
 * as the unboosted path does. Exactly one carrier is chosen: the packed chunk,
 * or the preamble — never zero, never two.
 */
export function resolveDigestCarrier(
  request: ContextRequest,
  boostedDigest: string | undefined,
  packed: PackedChunk[],
): DigestCarrier {
  if (boostedDigest === undefined) {
    return { digestAsChunk: false, renderPriorDigest: request.priorStageDigest, manifestRequest: request };
  }
  const landed = packed.some((c) => c.providerId === PLAN_DIGEST_PROVIDER_ID);
  if (landed) {
    return {
      digestAsChunk: true,
      renderPriorDigest: undefined,
      manifestRequest: { ...request, priorStageDigest: undefined },
    };
  }
  return { digestAsChunk: false, renderPriorDigest: request.priorStageDigest, manifestRequest: request };
}
