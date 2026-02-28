/**
 * LLM-Based Routing Strategy
 *
 * Routes stories using an LLM to perform semantic analysis of story requirements.
 * Falls back to keyword strategy on failure. Supports batch mode for efficiency.
 */

import type { Complexity, ModelTier, NaxConfig, TestStrategy } from "../../config";
import { resolveModel } from "../../config";
import { getLogger } from "../../logger";
import type { UserStory } from "../../prd/types";
import type { RoutingContext, RoutingDecision, RoutingStrategy } from "../strategy";
import { keywordStrategy } from "./keyword";

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

/** Evict oldest entry when cache is full (LRU) */
function evictOldest(): void {
  const firstKey = cachedDecisions.keys().next().value;
  if (firstKey !== undefined) {
    cachedDecisions.delete(firstKey);
  }
}

/**
 * Build the routing prompt for a single story.
 *
 * @param story - User story to route
 * @param config - nax configuration
 * @returns Formatted prompt string
 */
export function buildRoutingPrompt(story: UserStory, config: NaxConfig): string {
  const { title, description, acceptanceCriteria, tags } = story;
  const criteria = acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");

  return `You are a code task router. Given a user story, classify its complexity and select the appropriate execution strategy.

## Story
Title: ${title}
Description: ${description}
Acceptance Criteria:
${criteria}
Tags: ${tags.join(", ")}

## Available Tiers
- fast: Simple changes, typos, config updates, boilerplate. <30 min of coding.
- balanced: Standard features, moderate logic, straightforward tests. 30-90 min.
- powerful: Complex architecture, security-critical, multi-file refactors, novel algorithms. >90 min.

## Available Test Strategies
- test-after: Write implementation first, add tests after. For straightforward work.
- three-session-tdd: Separate test-writer → implementer → verifier sessions. For complex/critical work where test design matters.

## Rules
- Default to the CHEAPEST option that will succeed.
- three-session-tdd ONLY when: (a) security/auth logic, (b) complex algorithms, (c) public API contracts that consumers depend on.
- Simple barrel exports, re-exports, or index files are ALWAYS test-after + fast, regardless of keywords.
- A story touching many files doesn't automatically mean complex — copy-paste refactors are simple.

Respond with ONLY this JSON (no markdown, no explanation):
{"complexity":"simple|medium|complex|expert","modelTier":"fast|balanced|powerful","testStrategy":"test-after|three-session-tdd","reasoning":"<one line>"}`;
}

/**
 * Build batch routing prompt for multiple stories.
 *
 * @param stories - Array of user stories to route
 * @param config - nax configuration
 * @returns Formatted batch prompt string
 */
export function buildBatchPrompt(stories: UserStory[], config: NaxConfig): string {
  const storyBlocks = stories
    .map((story, idx) => {
      const criteria = story.acceptanceCriteria.map((c, i) => `   ${i + 1}. ${c}`).join("\n");
      return `${idx + 1}. ${story.id}: ${story.title}
   Description: ${story.description}
   Acceptance Criteria:
${criteria}
   Tags: ${story.tags.join(", ")}`;
    })
    .join("\n\n");

  return `You are a code task router. Given multiple user stories, classify each story's complexity and select the appropriate execution strategy.

## Stories
${storyBlocks}

## Available Tiers
- fast: Simple changes, typos, config updates, boilerplate. <30 min of coding.
- balanced: Standard features, moderate logic, straightforward tests. 30-90 min.
- powerful: Complex architecture, security-critical, multi-file refactors, novel algorithms. >90 min.

## Available Test Strategies
- test-after: Write implementation first, add tests after. For straightforward work.
- three-session-tdd: Separate test-writer → implementer → verifier sessions. For complex/critical work where test design matters.

## Rules
- Default to the CHEAPEST option that will succeed.
- three-session-tdd ONLY when: (a) security/auth logic, (b) complex algorithms, (c) public API contracts that consumers depend on.
- Simple barrel exports, re-exports, or index files are ALWAYS test-after + fast, regardless of keywords.
- A story touching many files doesn't automatically mean complex — copy-paste refactors are simple.

Respond with ONLY a JSON array (no markdown, no explanation):
[{"id":"US-001","complexity":"simple|medium|complex|expert","modelTier":"fast|balanced|powerful","testStrategy":"test-after|three-session-tdd","reasoning":"<one line>"}]`;
}

/**
 * Call LLM via claude CLI with timeout.
 *
 * @param modelTier - Model tier to use for routing call
 * @param prompt - Prompt to send to LLM
 * @param config - nax configuration
 * @returns LLM response text
 * @throws Error on timeout or spawn failure
 */
async function callLlm(modelTier: string, prompt: string, config: NaxConfig): Promise<string> {
  const llmConfig = config.routing.llm;
  const timeoutMs = llmConfig?.timeoutMs ?? 15000;

  // Resolve model tier to actual model identifier
  const modelEntry = config.models[modelTier];
  if (!modelEntry) {
    throw new Error(`Model tier "${modelTier}" not found in config.models`);
  }

  const modelDef = resolveModel(modelEntry);
  const modelArg = modelDef.model;

  // Spawn claude CLI with timeout
  const proc = Bun.spawn(["claude", "-p", prompt, "--model", modelArg], {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Race between completion and timeout, ensuring cleanup on either path
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`LLM call timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const outputPromise = (async () => {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`claude CLI failed with exit code ${exitCode}: ${stderr}`);
    }

    return stdout.trim();
  })();

  try {
    const result = await Promise.race([outputPromise, timeoutPromise]);
    clearTimeout(timeoutId);
    return result;
  } catch (err) {
    clearTimeout(timeoutId);
    proc.kill();
    throw err;
  }
}

/**
 * Validate a parsed routing object and return a clean RoutingDecision.
 *
 * @param parsed - Parsed JSON object with routing fields
 * @param config - nax configuration (for modelTier validation)
 * @returns Validated routing decision
 * @throws Error if validation fails
 */
export function validateRoutingDecision(parsed: Record<string, unknown>, config: NaxConfig): RoutingDecision {
  // Validate required fields
  if (!parsed.complexity || !parsed.modelTier || !parsed.testStrategy || !parsed.reasoning) {
    throw new Error(`Missing required fields in LLM response: ${JSON.stringify(parsed)}`);
  }

  // Validate field values
  const validComplexities: Complexity[] = ["simple", "medium", "complex", "expert"];
  const validTestStrategies: TestStrategy[] = ["test-after", "three-session-tdd"];

  if (!validComplexities.includes(parsed.complexity as Complexity)) {
    throw new Error(`Invalid complexity: ${parsed.complexity}`);
  }

  if (!validTestStrategies.includes(parsed.testStrategy as TestStrategy)) {
    throw new Error(`Invalid testStrategy: ${parsed.testStrategy}`);
  }

  // Validate modelTier exists in config
  if (!config.models[parsed.modelTier as string]) {
    throw new Error(`Invalid modelTier: ${parsed.modelTier} (not in config.models)`);
  }

  return {
    complexity: parsed.complexity as Complexity,
    modelTier: parsed.modelTier as ModelTier,
    testStrategy: parsed.testStrategy as TestStrategy,
    reasoning: parsed.reasoning as string,
  };
}

/**
 * Strip markdown code fences from LLM output.
 */
export function stripCodeFences(text: string): string {
  let result = text.trim();
  if (result.startsWith("```")) {
    const lines = result.split("\n");
    result = lines.slice(1, -1).join("\n").trim();
  }
  if (result.startsWith("json")) {
    result = result.slice(4).trim();
  }
  return result;
}

/**
 * Parse and validate LLM routing response.
 *
 * @param output - Raw LLM output text
 * @param story - User story being routed (for error context)
 * @param config - nax configuration
 * @returns Validated routing decision
 * @throws Error if JSON parsing or validation fails
 */
export function parseRoutingResponse(output: string, story: UserStory, config: NaxConfig): RoutingDecision {
  const jsonText = stripCodeFences(output);
  const parsed = JSON.parse(jsonText);
  return validateRoutingDecision(parsed, config);
}

/**
 * Parse batch LLM response into a map of decisions.
 *
 * @param output - Raw LLM output text (JSON array)
 * @param stories - User stories being routed
 * @param config - nax configuration
 * @returns Map of story ID to routing decision
 * @throws Error if JSON parsing or validation fails
 */
function parseBatchResponse(output: string, stories: UserStory[], config: NaxConfig): Map<string, RoutingDecision> {
  // Strip markdown code blocks if present
  let jsonText = output.trim();
  if (jsonText.startsWith("```")) {
    const lines = jsonText.split("\n");
    jsonText = lines.slice(1, -1).join("\n").trim();
  }
  if (jsonText.startsWith("json")) {
    jsonText = jsonText.slice(4).trim();
  }

  const parsed = JSON.parse(jsonText);

  if (!Array.isArray(parsed)) {
    throw new Error("Batch LLM response must be a JSON array");
  }

  const decisions = new Map<string, RoutingDecision>();

  for (const entry of parsed) {
    if (!entry.id) {
      throw new Error("Batch entry missing 'id' field");
    }

    const story = stories.find((s) => s.id === entry.id);
    if (!story) {
      throw new Error(`Batch entry has unknown story ID: ${entry.id}`);
    }

    // Validate entry directly (no re-serialization needed)
    const decision = validateRoutingDecision(entry, config);
    decisions.set(entry.id, decision);
  }

  return decisions;
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

  const modelTier = llmConfig.model ?? "fast";
  const prompt = buildBatchPrompt(stories, config);

  try {
    const output = await callLlm(modelTier, prompt, config);
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
 * - Calls LLM with story context to classify complexity
 * - Parses structured JSON response
 * - Maps complexity to model tier and test strategy
 * - Falls back to null (keyword fallback) on any failure
 *
 * @example
 * ```ts
 * // Single story routing
 * const decision = await llmStrategy.route(story, context);
 *
 * // Batch routing (call before individual routes)
 * await routeBatch(stories, context);
 * const decision = await llmStrategy.route(stories[0], context); // hits cache
 * ```
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
      const cached = cachedDecisions.get(story.id)!;
      const logger = getLogger();
      logger.debug("routing", "LLM cache hit", {
        storyId: story.id,
        complexity: cached.complexity,
        modelTier: cached.modelTier,
        testStrategy: cached.testStrategy,
      });
      return cached;
    }

    // One-shot mode: cache miss → keyword fallback without new LLM call
    if (mode === "one-shot") {
      const logger = getLogger();
      logger.info("routing", "One-shot mode cache miss, falling back to keyword", {
        storyId: story.id,
      });
      return keywordStrategy.route(story, context);
    }

    try {
      const modelTier = llmConfig.model ?? "fast";
      const prompt = buildRoutingPrompt(story, config);
      const output = await callLlm(modelTier, prompt, config);
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
