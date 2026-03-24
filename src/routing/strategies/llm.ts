/**
 * LLM-Based Routing
 *
 * Plain async classify functions — not a RoutingStrategy object.
 * classifyWithLlm() is the entry point called by resolveRouting().
 * Supports batch mode for efficiency.
 */

import type { AgentAdapter } from "../../agents/types";
import type { NaxConfig } from "../../config";
import { resolveModel } from "../../config";
import { getLogger } from "../../logger";
import type { UserStory } from "../../prd/types";
import { typedSpawn } from "../../utils/bun-deps";
import type { RoutingContext, RoutingDecision } from "../router";
import { determineTestStrategy } from "../router";
import { buildBatchRoutingPrompt, buildRoutingPrompt, parseBatchResponse, parseRoutingResponse } from "./llm-prompts";

// Re-export for backward compatibility
export {
  buildRoutingPrompt,
  buildBatchRoutingPrompt as buildBatchPrompt,
  validateRoutingDecision,
  stripCodeFences,
  parseRoutingResponse,
} from "./llm-prompts";

/** Module-level cache for routing decisions (PERF-1 fix: max 100 entries LRU) */
const cachedDecisions = new Map<string, RoutingDecision>();
const MAX_CACHE_SIZE = 100;

/** Clear the routing cache (for testing or new runs) */
export function clearCache(): void {
  cachedDecisions.clear();
}

/** Get the current cache size (for testing) */
export function getCacheSize(): number {
  return cachedDecisions.size;
}

/** Clear routing cache entry for a specific story (used on tier escalation) */
export function clearCacheForStory(storyId: string): void {
  cachedDecisions.delete(storyId);
}

/** Inject a cache entry directly (test helper only) */
export function injectCacheEntry(storyId: string, decision: RoutingDecision): void {
  cachedDecisions.set(storyId, decision);
}

/** Evict oldest entry when cache is full (LRU) */
function evictOldest(): void {
  const firstKey = cachedDecisions.keys().next().value;
  if (firstKey !== undefined) {
    cachedDecisions.delete(firstKey);
  }
}

/** Minimal proc shape returned by spawn for piped stdio. */
export interface PipedProc {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

/**
 * Swappable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 */
export const _llmStrategyDeps = {
  spawn: typedSpawn,
  adapter: undefined as AgentAdapter | undefined,
};

/**
 * Call LLM via adapter.complete() with timeout.
 */
async function callLlmOnce(
  adapter: AgentAdapter,
  modelTier: string,
  prompt: string,
  config: NaxConfig,
  timeoutMs: number,
): Promise<string> {
  const modelEntry = config.models[modelTier];
  if (!modelEntry) {
    throw new Error(`Model tier "${modelTier}" not found in config.models`);
  }

  const modelDef = resolveModel(modelEntry);
  const modelArg = modelDef.model;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`LLM call timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  timeoutPromise.catch(() => {});

  const outputPromise = adapter.complete(prompt, { model: modelArg, config });

  try {
    const result = await Promise.race([outputPromise, timeoutPromise]);
    clearTimeout(timeoutId);
    return result;
  } catch (err) {
    clearTimeout(timeoutId);
    outputPromise.catch(() => {});
    throw err;
  }
}

/**
 * Call LLM via adapter.complete() with timeout and retry (BUG-033).
 */
async function callLlm(adapter: AgentAdapter, modelTier: string, prompt: string, config: NaxConfig): Promise<string> {
  const llmConfig = config.routing.llm;
  const timeoutMs = llmConfig?.timeoutMs ?? 30000;
  const maxRetries = llmConfig?.retries ?? 1;
  const retryDelayMs = llmConfig?.retryDelayMs ?? 1000;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callLlmOnce(adapter, modelTier, prompt, config, timeoutMs);
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries) {
        const logger = getLogger();
        logger.warn(
          "routing",
          `LLM call failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${retryDelayMs}ms`,
          { error: lastError.message },
        );
        await Bun.sleep(retryDelayMs);
      }
    }
  }

  throw lastError ?? new Error("LLM call failed with unknown error");
}

/**
 * Route multiple stories in a single batch LLM call.
 *
 * Pre-populates the cache with routing decisions for all stories.
 */
export async function routeBatch(stories: UserStory[], context: RoutingContext): Promise<Map<string, RoutingDecision>> {
  const config = context.config;
  const llmConfig = config.routing.llm;

  if (!llmConfig) {
    throw new Error("LLM routing config not found");
  }

  const adapter = context.adapter ?? _llmStrategyDeps.adapter;
  if (!adapter) {
    throw new Error("No agent adapter available for batch routing (AA-003)");
  }

  const modelTier = llmConfig.model ?? "fast";
  const prompt = buildBatchRoutingPrompt(stories, config);

  try {
    const output = await callLlm(adapter, modelTier, prompt, config);
    const decisions = parseBatchResponse(output, stories, config);

    if (llmConfig.cacheDecisions) {
      for (const [storyId, decision] of decisions.entries()) {
        if (cachedDecisions.size >= MAX_CACHE_SIZE) evictOldest();
        cachedDecisions.set(storyId, decision);
      }
    }

    return decisions;
  } catch (err) {
    throw new Error(`Batch LLM routing failed: ${(err as Error).message}`);
  }
}

/**
 * Classify a story using the LLM.
 *
 * Returns a RoutingDecision on success, or null to signal keyword fallback.
 * Called by resolveRouting() in router.ts.
 *
 * - Checks cache first (if cacheDecisions enabled)
 * - One-shot mode: cache miss → return null (caller does keyword fallback)
 * - hybrid/per-story mode: call LLM, cache result
 */
export async function classifyWithLlm(
  story: UserStory,
  config: NaxConfig,
  adapter?: AgentAdapter,
): Promise<RoutingDecision | null> {
  const llmConfig = config.routing.llm;
  if (!llmConfig) return null;

  const mode = llmConfig.mode ?? "hybrid";

  // Cache hit: return cached decision with fresh testStrategy
  if (llmConfig.cacheDecisions && cachedDecisions.has(story.id)) {
    const cached = cachedDecisions.get(story.id);
    if (!cached) throw new Error(`Cached decision not found for story: ${story.id}`);

    const tddStrategy = config.tdd?.strategy ?? "auto";
    const freshTestStrategy = determineTestStrategy(
      cached.complexity,
      story.title,
      story.description,
      story.tags,
      tddStrategy,
    );
    const logger = getLogger();
    logger.debug("routing", "LLM cache hit", {
      storyId: story.id,
      complexity: cached.complexity,
      modelTier: cached.modelTier,
      testStrategy: freshTestStrategy,
    });
    return { ...cached, testStrategy: freshTestStrategy };
  }

  // One-shot mode: cache miss → defer to keyword (return null)
  if (mode === "one-shot") {
    const logger = getLogger();
    logger.info("routing", "One-shot mode cache miss, falling back to keyword", { storyId: story.id });
    return null;
  }

  // Call the LLM
  const effectiveAdapter = adapter ?? _llmStrategyDeps.adapter;
  if (!effectiveAdapter) {
    throw new Error("No agent adapter available for LLM routing (AA-003)");
  }

  const modelTier = llmConfig.model ?? "fast";
  const prompt = buildRoutingPrompt(story, config);

  let decision: RoutingDecision;
  try {
    const output = await callLlm(effectiveAdapter, modelTier, prompt, config);
    decision = parseRoutingResponse(output, story, config);
  } catch (err) {
    if (llmConfig.fallbackToKeywords) {
      return null;
    }
    throw err;
  }

  if (llmConfig.cacheDecisions) {
    if (cachedDecisions.size >= MAX_CACHE_SIZE) evictOldest();
    cachedDecisions.set(story.id, decision);
  }

  const logger = getLogger();
  logger.info("routing", "LLM classified story", {
    storyId: story.id,
    complexity: decision.complexity,
    modelTier: decision.modelTier,
    testStrategy: decision.testStrategy,
    reasoning: decision.reasoning,
  });

  return decision;
}
