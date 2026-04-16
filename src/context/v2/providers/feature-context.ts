/**
 * Context Engine v2 — FeatureContextProvider (v2 adapter)
 *
 * Wraps the existing v1 FeatureContextProvider to implement IContextProvider.
 * This adapter preserves exact v1 behavior in Phase 0 (parity requirement).
 *
 * The v1 provider reads .nax/features/<featureId>/context.md and returns
 * the raw markdown with a header. The v2 adapter packages that result as a
 * "feature" kind chunk with budget-floor guarantee.
 *
 * story and config are injected at construction time (the orchestrator
 * builds a fresh provider per assemble() call).
 *
 * Phase 0: behavioral parity with v1 — same file, same header, same tokens.
 * Phase 2+: staleness detection, effectiveness signal (Amendment A.2/A.3).
 */

import { createHash } from "node:crypto";
import type { NaxConfig } from "../../../config/types";
import { getLogger } from "../../../logger";
import type { UserStory } from "../../../prd";
import { errorMessage } from "../../../utils/errors";
import { FeatureContextProvider as FeatureContextProviderV1 } from "../../providers/feature-context";
import type { ContextProviderResult, ContextRequest, IContextProvider, RawChunk } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

export const _featureContextV2Deps = {
  createV1Provider: () => new FeatureContextProviderV1(),
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function contentHash8(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * v2 adapter for the feature context engine.
 * Constructed per-request by the orchestrator with story and config bound.
 */
export class FeatureContextProviderV2 implements IContextProvider {
  readonly id = "feature-context";
  readonly kind = "feature" as const;

  constructor(
    private readonly story: UserStory,
    private readonly config: NaxConfig,
  ) {}

  /**
   * Fetch feature context via the v1 provider and adapt the result into a
   * v2 RawChunk.  Returns empty chunks when the feature engine is disabled
   * or no context.md exists.
   */
  async fetch(request: ContextRequest): Promise<ContextProviderResult> {
    const logger = getLogger();

    try {
      const v1 = _featureContextV2Deps.createV1Provider();
      const result = await v1.getContext(this.story, request.workdir, this.config);
      if (!result) {
        return { chunks: [], pullTools: [] };
      }

      const hash = contentHash8(result.content);
      const chunk: RawChunk = {
        id: `feature-context:${hash}`,
        kind: "feature",
        scope: "feature",
        // Feature context is relevant to both implementers and reviewers
        role: ["implementer", "reviewer", "tdd"],
        content: result.content,
        tokens: result.estimatedTokens,
        // Full score — feature context is always maximally relevant
        rawScore: 1.0,
      };

      logger.debug("feature-context-v2", "Loaded feature context chunk", {
        storyId: request.storyId,
        featureId: result.featureId,
        tokens: result.estimatedTokens,
      });

      return { chunks: [chunk], pullTools: [] };
    } catch (err) {
      logger.warn("feature-context-v2", "Failed to fetch feature context — returning empty", {
        storyId: request.storyId,
        error: errorMessage(err),
      });
      return { chunks: [], pullTools: [] };
    }
  }
}
