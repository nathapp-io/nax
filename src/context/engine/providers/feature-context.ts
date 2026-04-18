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
 * Phase 2 (Amendment A): staleness detection (AC-46/AC-47).
 */

import { createHash } from "node:crypto";
import type { NaxConfig } from "../../../config/types";
import { getLogger } from "../../../logger";
import type { UserStory } from "../../../prd";
import { errorMessage } from "../../../utils/errors";
import { FeatureContextProvider as FeatureContextProviderV1 } from "../../providers/feature-context";
import { applyStaleness, detectContradictions, parseFeatureContextEntries, selectStaleByAge } from "../staleness";
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

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function renderEntryContent(section: string, text: string): string {
  return section ? `### ${section}\n\n${text}` : text;
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
   *
   * When staleness detection is enabled (Amendment A AC-46/AC-47), the chunk
   * is annotated with staleCandidate: true and a scoreMultiplier when any
   * entries in the content are age-stale or contradiction-stale.
   */
  async fetch(request: ContextRequest): Promise<ContextProviderResult> {
    const logger = getLogger();

    try {
      const v1 = _featureContextV2Deps.createV1Provider();
      const result = await v1.getContext(this.story, request.repoRoot, this.config);
      if (!result) {
        return { chunks: [], pullTools: [] };
      }

      const hash = contentHash8(result.content);
      const baseChunk: RawChunk = {
        id: `feature-context:${hash}`,
        kind: "feature",
        scope: "feature",
        role: ["implementer", "reviewer", "tdd"],
        content: result.content,
        tokens: result.estimatedTokens,
        rawScore: 1.0,
      };

      let chunks: RawChunk[] = [baseChunk];

      // Amendment A AC-46/AC-47: staleness detection (read-time, no LLM).
      const stalenessConfig = this.config.context?.v2?.staleness;
      if (stalenessConfig?.enabled !== false) {
        const maxStoryAge = stalenessConfig?.maxStoryAge ?? 10;
        const scoreMultiplier = stalenessConfig?.scoreMultiplier ?? 0.4;

        const entries = parseFeatureContextEntries(result.content);
        if (entries.length > 1) {
          const contradicted = detectContradictions(entries);
          const ageStale = selectStaleByAge(entries, maxStoryAge);
          chunks = entries.map((entry) => {
            const entryContent = renderEntryContent(entry.section, entry.text);
            const entryChunk: RawChunk = {
              id: `feature-context:${hash}:entry-${entry.index}`,
              kind: "feature",
              scope: "feature",
              role: ["implementer", "reviewer", "tdd"],
              content: entryContent,
              tokens: estimateTokens(entryContent),
              rawScore: 1.0,
            };
            const isStale = contradicted.has(entry.index) || ageStale.has(entry.index);
            return applyStaleness(entryChunk, { isStale, scoreMultiplier });
          });

          if (chunks.some((chunk) => chunk.staleCandidate)) {
            logger.debug("feature-context-v2", "Stale entries detected in feature context", {
              storyId: request.storyId,
              contradicted: contradicted.size,
              ageStale: ageStale.size,
            });
          }
        } else if (entries.length === 1) {
          const contradicted = detectContradictions(entries);
          const ageStale = selectStaleByAge(entries, maxStoryAge);
          const isStale = contradicted.has(entries[0].index) || ageStale.has(entries[0].index);
          chunks = [applyStaleness(baseChunk, { isStale, scoreMultiplier })];
        }
      }

      logger.debug("feature-context-v2", "Loaded feature context chunk", {
        storyId: request.storyId,
        featureId: result.featureId,
        tokens: result.estimatedTokens,
      });

      return { chunks, pullTools: [] };
    } catch (err) {
      logger.warn("feature-context-v2", "Failed to fetch feature context — returning empty", {
        storyId: request.storyId,
        error: errorMessage(err),
      });
      return { chunks: [], pullTools: [] };
    }
  }
}
