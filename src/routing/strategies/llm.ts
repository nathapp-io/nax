/**
 * LLM-Based Routing — prompt builders and re-exports.
 *
 * classifyWithLlm() and routeBatch() have been removed (ADR-019 Phase B1).
 * Router.ts now calls classifyRouteOp / classifyRouteBatchOp via callOp.
 * Cache lives in llm-cache.ts; re-exported here for backward compat.
 */

import type { UserStory } from "../../prd";
import { OneShotPromptBuilder, type RoutingCandidate, type SchemaDescriptor } from "../../prompts";
import { typedSpawn } from "../../utils/bun-deps";

// Re-export parse/validate utilities for callers that import from this module
export { validateRoutingDecision, stripCodeFences, parseRoutingResponse } from "./llm-parsing";

// Re-export cache utilities (now live in llm-cache.ts) — backward compat
export {
  cachedDecisions,
  MAX_CACHE_SIZE,
  clearCache,
  getCacheSize,
  clearCacheForStory,
  injectCacheEntry,
  evictOldest,
} from "./llm-cache";

// ─── Routing prompt constants ─────────────────────────────────────────────────

export const ROUTING_INSTRUCTIONS = `Classify the user story's complexity and select the cheapest model tier that will succeed.

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

export async function buildRoutingPromptAsync(story: UserStory): Promise<string> {
  const criteria = story.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const storyMd = `Title: ${story.title}\nDescription: ${story.description}\nAcceptance Criteria:\n${criteria}\nTags: ${story.tags.join(", ")}`;
  return OneShotPromptBuilder.for("router")
    .instructions(ROUTING_INSTRUCTIONS)
    .inputData("Story", storyMd)
    .candidates(ROUTING_CANDIDATES)
    .jsonSchema(ROUTING_SCHEMA)
    .build();
}

export async function buildBatchRoutingPromptAsync(stories: UserStory[]): Promise<string> {
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

/** Minimal proc shape returned by spawn for piped stdio. */
export interface PipedProc {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

/**
 * Swappable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 * spawn is kept for backward compat with tests that assert it is NOT called.
 */
export const _llmStrategyDeps = {
  spawn: typedSpawn,
};
