import type { NaxConfig } from "../../config/types";
/**
 * FeatureContextProvider — reads context.md for the current feature and
 * returns its raw contents for role-filtered injection at prompt-build time.
 *
 * v1 scope: read path only. Returns full (unfiltered) context.md content.
 * Role filtering and budget enforcement happen in the prompt builders.
 */
import { getLogger } from "../../logger";
import type { UserStory } from "../../prd";
import { errorMessage } from "../../utils/errors";
import { resolveFeatureId } from "../feature-resolver";

/** Injectable deps for testing */
export const _featureContextDeps = {
  resolveFeatureId,
  readFile: async (path: string) => Bun.file(path).text(),
  fileExists: async (path: string) => Bun.file(path).exists(),
};

/** Result returned by the provider (null when not applicable) */
export interface FeatureContextResult {
  /** Raw (unfiltered) content of context.md, wrapped in injection header */
  content: string;
  /** Estimated tokens for the raw content */
  estimatedTokens: number;
  /** Label for logging/display */
  label: string;
  /** Feature ID for downstream budget enforcement */
  featureId: string;
}

const INJECTION_HEADER = `## Feature Context

The following context was accumulated by prior stories in this feature. Use it to avoid re-discovering known constraints and decisions. This context is scoped to this feature — not a global project rule.`;

/**
 * Format the raw context.md content with an injection header.
 */
function formatForInjection(content: string, featureId: string): string {
  return `${INJECTION_HEADER}\n\n_Feature: ${featureId}_\n\n${content.trim()}`;
}

export class FeatureContextProvider {
  /**
   * Fetch the feature context for the given story.
   * Returns null when: feature engine disabled, story unattached, no context.md.
   */
  async getContext(story: UserStory, workdir: string, config: NaxConfig): Promise<FeatureContextResult | null> {
    const logger = getLogger();

    if (!config.context?.featureEngine?.enabled) return null;

    const featureId = await _featureContextDeps.resolveFeatureId(story, workdir);
    if (!featureId) return null;

    const contextPath = `${workdir}/.nax/features/${featureId}/context.md`;

    try {
      const exists = await _featureContextDeps.fileExists(contextPath);
      if (!exists) return null;

      const content = await _featureContextDeps.readFile(contextPath);
      if (!content.trim()) return null;

      const formatted = formatForInjection(content, featureId);

      logger.info("feature-context", "Loaded feature context", {
        storyId: story.id,
        featureId,
        estimatedTokens: Math.ceil(formatted.length / 4),
      });

      return {
        content: formatted,
        estimatedTokens: Math.ceil(formatted.length / 4),
        label: `feature-context:${featureId}`,
        featureId,
      };
    } catch (err) {
      logger.warn("feature-context", "Failed to read feature context — skipping", {
        storyId: story.id,
        featureId,
        error: errorMessage(err),
      });
      return null;
    }
  }
}
