/**
 * LLM Batch Routing Helper
 */

import type { NaxConfig } from "../config";
import { getSafeLogger } from "../logger";
import type { UserStory } from "../prd";
import { routeBatch as llmRouteBatch } from "./strategies/llm";

/**
 * Attempt to pre-route a batch of stories using LLM to optimize cost and consistency.
 *
 * @param config - Global config
 * @param stories - Stories to route
 * @param label - Label for logging
 */
export async function tryLlmBatchRoute(config: NaxConfig, stories: UserStory[], label = "routing"): Promise<void> {
  const mode = config.routing.llm?.mode ?? "hybrid";
  if (config.routing.strategy !== "llm" || mode === "per-story" || stories.length === 0) return;

  const logger = getSafeLogger();
  try {
    logger?.debug("routing", `LLM batch routing: ${label}`, { storyCount: stories.length, mode });
    await llmRouteBatch(stories, { config });
    logger?.debug("routing", "LLM batch routing complete", { label });
  } catch (err) {
    logger?.warn("routing", "LLM batch routing failed, falling back to individual routing", {
      error: (err as Error).message,
      label,
    });
  }
}
