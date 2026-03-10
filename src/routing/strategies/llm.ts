/**
 * LLM-Based Routing Strategy
 *
 * Routes stories using an LLM to perform semantic analysis of story requirements.
 * Falls back to keyword strategy on failure. Supports batch mode for efficiency.
 */

import type { AgentAdapter } from "../../agents/types";
import type { NaxConfig } from "../../config";
import { resolveModel } from "../../config";
import { getLogger } from "../../logger";
import type { UserStory } from "../../prd/types";
import { determineTestStrategy } from "../router";
import type { RoutingContext, RoutingDecision, RoutingStrategy } from "../strategy";
import { keywordStrategy } from "./keyword";
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
 * Includes spawn for backward compatibility with BUG-039 tests, and adapter for new AA-003.
 */
export const _deps = {
  spawn: (cmd: string[], opts: { stdout: "pipe"; stderr: "pipe" }): PipedProc =>
    Bun.spawn(cmd, opts) as unknown as PipedProc,
  adapter: undefined as AgentAdapter | undefined,
};

/**
 * Call LLM via adapter.complete() with timeout.
 *
 * @param adapter - Agent adapter to use for completion
 * @param modelTier - Model tier to use for routing call
 * @param prompt - Prompt to send to LLM
 * @param config - nax configuration
 * @returns LLM response text
 * @throws Error on timeout or completion failure
 */
async function callLlmOnce(
  adapter: AgentAdapter,
  modelTier: string,
  prompt: string,
  config: NaxConfig,
  timeoutMs: number,
): Promise<string> {
  // Resolve model tier to actual model identifier
  const modelEntry = config.models[modelTier];
  if (!modelEntry) {
    throw new Error(`Model tier "${modelTier}" not found in config.models`);
  }

  const modelDef = resolveModel(modelEntry);
  const modelArg = modelDef.model;

  // Race between completion and timeout, ensuring cleanup on either path
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`LLM call timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  // Prevent unhandled rejection if timer fires between race resolution and clearTimeout
  timeoutPromise.catch(() => {});

  const outputPromise = adapter.complete(prompt, { model: modelArg });

  try {
    const result = await Promise.race([outputPromise, timeoutPromise]);
    clearTimeout(timeoutId);
    return result;
  } catch (err) {
    clearTimeout(timeoutId);
    // Silence the floating outputPromise to prevent unhandled rejection
    outputPromise.catch(() => {});
    throw err;
  }
}

/**
 * Call LLM via adapter.complete() with timeout and retry (BUG-033).
 *
 * @param adapter - Agent adapter to use for completion
 * @param modelTier - Model tier to use for routing call
 * @param prompt - Prompt to send to LLM
 * @param config - nax configuration
 * @returns LLM response text
 * @throws Error after all retries exhausted
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
          {
            error: lastError.message,
          },
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
 * This function pre-populates the cache with routing decisions for all stories.
 * Individual route() calls will then hit the cache.
 *
 * @param stories - Array of user stories to route
 * @param context - Routing context
 * @returns Map of story ID to routing decision
 */
export async function routeBatch(stories: UserStory[], context: RoutingContext): Promise<Map<string, RoutingDecision>> {
  const config = context.config;
  const llmConfig = config.routing.llm;

  if (!llmConfig) {
    throw new Error("LLM routing config not found");
  }

  // Resolve adapter from context or _deps
  const adapter = context.adapter ?? _deps.adapter;
  if (!adapter) {
    throw new Error("No agent adapter available for batch routing (AA-003)");
  }

  const modelTier = llmConfig.model ?? "fast";
  const prompt = buildBatchRoutingPrompt(stories, config);

  try {
    const output = await callLlm(adapter, modelTier, prompt, config);
    const decisions = parseBatchResponse(output, stories, config);

    // Populate cache (PERF-1 fix: evict oldest if full)
    if (llmConfig.cacheDecisions) {
      for (const [storyId, decision] of decisions.entries()) {
        if (cachedDecisions.size >= MAX_CACHE_SIZE) {
          evictOldest();
        }
        cachedDecisions.set(storyId, decision);
      }
    }

    return decisions;
  } catch (err) {
    throw new Error(`Batch LLM routing failed: ${(err as Error).message}`);
  }
}

/**
 * LLM-based routing strategy.
 *
 * This strategy:
 * - Checks cache first (if enabled)
 * - Calls LLM with story context to classify complexity (via adapter.complete())
 * - Parses structured JSON response
 * - Maps complexity to model tier and test strategy
 * - Falls back to null (keyword fallback) on any failure
 */
export const llmStrategy: RoutingStrategy = {
  name: "llm",

  async route(story: UserStory, context: RoutingContext): Promise<RoutingDecision | null> {
    const config = context.config;
    const llmConfig = config.routing.llm;

    if (!llmConfig) {
      return null; // LLM routing not configured
    }

    const mode = llmConfig.mode ?? "hybrid";

    // Check cache first
    if (llmConfig.cacheDecisions && cachedDecisions.has(story.id)) {
      const cached = cachedDecisions.get(story.id);
      if (!cached) {
        throw new Error(`Cached decision not found for story: ${story.id}`);
      }
      // Recompute testStrategy from complexity — cache is authoritative on complexity/modelTier
      // only. testStrategy must always reflect the current determineTestStrategy() rules
      // (e.g. TS-001: simple → tdd-simple) even if the cache was populated under older rules.
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

    // One-shot mode: cache miss -> keyword fallback without new LLM call
    if (mode === "one-shot") {
      const logger = getLogger();
      logger.info("routing", "One-shot mode cache miss, falling back to keyword", {
        storyId: story.id,
      });
      return keywordStrategy.route(story, context);
    }

    try {
      // Resolve adapter from context or _deps (AA-003)
      const adapter = context.adapter ?? _deps.adapter;
      if (!adapter) {
        throw new Error("No agent adapter available for LLM routing (AA-003)");
      }

      const modelTier = llmConfig.model ?? "fast";
      const prompt = buildRoutingPrompt(story, config);
      const output = await callLlm(adapter, modelTier, prompt, config);
      const decision = parseRoutingResponse(output, story, config);

      // Cache decision (PERF-1 fix: evict oldest if full)
      if (llmConfig.cacheDecisions) {
        if (cachedDecisions.size >= MAX_CACHE_SIZE) {
          evictOldest();
        }
        cachedDecisions.set(story.id, decision);
      }

      // Log decision
      const logger = getLogger();
      logger.info("routing", "LLM classified story", {
        storyId: story.id,
        complexity: decision.complexity,
        modelTier: decision.modelTier,
        testStrategy: decision.testStrategy,
        reasoning: decision.reasoning,
      });

      return decision;
    } catch (err) {
      const logger = getLogger();
      const errorMsg = (err as Error).message;
      logger.warn("routing", "LLM routing failed", { storyId: story.id, error: errorMsg });

      // Fall back to keyword strategy if configured
      if (llmConfig.fallbackToKeywords) {
        logger.info("routing", "Falling back to keyword strategy", { storyId: story.id });
        return null; // Delegate to next strategy (keyword)
      }

      // Re-throw if no fallback
      throw err;
    }
  },
};
