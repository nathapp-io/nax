/**
 * LLM-Based Routing
 *
 * Plain async classify functions — not a RoutingStrategy object.
 * classifyWithLlm() is the entry point called by resolveRouting().
 * Supports batch mode for efficiency.
 */

import type { AgentAdapter } from "../../agents";
import type { NaxConfig } from "../../config";
import { resolveConfiguredModel } from "../../config";
import { getLogger } from "../../logger";
import type { UserStory } from "../../prd";
import { OneShotPromptBuilder, type RoutingCandidate, type SchemaDescriptor } from "../../prompts";
import { typedSpawn } from "../../utils/bun-deps";
import type { RoutingContext, RoutingDecision } from "../router";
import { determineTestStrategy } from "../router";
import { parseBatchResponse, parseRoutingResponse } from "./llm-parsing";

// Re-export parse/validate utilities for callers that import from this module
export { validateRoutingDecision, stripCodeFences, parseRoutingResponse } from "./llm-parsing";

// ─── Routing prompt constants ─────────────────────────────────────────────────

const ROUTING_INSTRUCTIONS = `Classify the user story's complexity and select the cheapest model tier that will succeed.

## Complexity Levels
- simple: Typos, config updates, boilerplate, barrel exports, re-exports. <30 min.
- medium: Standard features, moderate logic, straightforward tests. 30-90 min.
- complex: Multi-file refactors, new subsystems, integration work. >90 min.
- expert: Security-critical, novel algorithms, complex architecture decisions.

## Rules
- Default to the CHEAPEST tier that will succeed.
- Simple barrel exports, re-exports, or index files → always simple + fast.
- Many files ≠ complex — copy-paste refactors across files are simple.
- Pure refactoring/deletion with no new behavior → simple.`;

const ROUTING_CANDIDATES: RoutingCandidate[] = [
  { tier: "fast", description: "For simple tasks. Cheapest." },
  { tier: "balanced", description: "For medium tasks. Standard cost." },
  { tier: "powerful", description: "For complex/expert tasks. Most capable, highest cost." },
];

const ROUTING_SCHEMA: SchemaDescriptor = {
  name: "RoutingDecision",
  description: "Respond with JSON only — no explanation text before or after.",
  example: { complexity: "simple|medium|complex|expert", modelTier: "fast|balanced|powerful", reasoning: "<one line>" },
};

const BATCH_ROUTING_SCHEMA: SchemaDescriptor = {
  name: "BatchRoutingDecision[]",
  description: "Respond with a JSON array — no explanation, no markdown.",
  example: [{ id: "US-001", complexity: "simple", modelTier: "fast", reasoning: "<one line>" }],
};

async function buildRoutingPromptAsync(story: UserStory): Promise<string> {
  const criteria = story.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const storyMd = `Title: ${story.title}\nDescription: ${story.description}\nAcceptance Criteria:\n${criteria}\nTags: ${story.tags.join(", ")}`;
  return OneShotPromptBuilder.for("router")
    .instructions(ROUTING_INSTRUCTIONS)
    .inputData("Story", storyMd)
    .candidates(ROUTING_CANDIDATES)
    .jsonSchema(ROUTING_SCHEMA)
    .build();
}

async function buildBatchRoutingPromptAsync(stories: UserStory[]): Promise<string> {
  const storyBlocks = stories
    .map((story, idx) => {
      const criteria = story.acceptanceCriteria.map((c, i) => `   ${i + 1}. ${c}`).join("\n");
      return `${idx + 1}. ${story.id}: ${story.title}\n   Description: ${story.description}\n   Acceptance Criteria:\n${criteria}\n   Tags: ${story.tags.join(", ")}`;
    })
    .join("\n\n");
  return OneShotPromptBuilder.for("router")
    .instructions(ROUTING_INSTRUCTIONS)
    .inputData("Stories", storyBlocks)
    .candidates(ROUTING_CANDIDATES)
    .jsonSchema(BATCH_ROUTING_SCHEMA)
    .build();
}

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
  modelSelection: string | { agent: string; model: string },
  prompt: string,
  config: NaxConfig,
  timeoutMs: number,
): Promise<string> {
  const resolvedModel = resolveConfiguredModel(
    config.models,
    adapter.name,
    modelSelection,
    config.autoMode.defaultAgent,
  );

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`LLM call timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  timeoutPromise.catch(() => {});

  const outputPromise = adapter.complete(prompt, { model: resolvedModel.modelDef.model, config });

  try {
    const result = await Promise.race([outputPromise, timeoutPromise]);
    clearTimeout(timeoutId);
    return typeof result === "string" ? result : result.output;
  } catch (err) {
    clearTimeout(timeoutId);
    outputPromise.catch(() => {});
    throw err;
  }
}

/**
 * Call LLM via adapter.complete() with timeout and retry (BUG-033).
 */
async function callLlm(
  adapter: AgentAdapter,
  modelSelection: string | { agent: string; model: string },
  prompt: string,
  config: NaxConfig,
): Promise<string> {
  const llmConfig = config.routing.llm;
  const timeoutMs = llmConfig?.timeoutMs ?? 30000;
  const maxRetries = llmConfig?.retries ?? 1;
  const retryDelayMs = llmConfig?.retryDelayMs ?? 1000;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callLlmOnce(adapter, modelSelection, prompt, config, timeoutMs);
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

  const modelSelection = llmConfig.model ?? "fast";
  const prompt = await buildBatchRoutingPromptAsync(stories);

  try {
    const output = await callLlm(adapter, modelSelection, prompt, config);
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

  const modelSelection = llmConfig.model ?? "fast";
  const prompt = await buildRoutingPromptAsync(story);

  let decision: RoutingDecision;
  try {
    const output = await callLlm(effectiveAdapter, modelSelection, prompt, config);
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
