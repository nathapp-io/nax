/**
 * LLM Routing Prompts & Parsers
 *
 * Extracted from llm.ts: prompt building, response parsing, and validation
 * for LLM-based routing decisions.
 */

import type { Complexity, ModelTier, NaxConfig, TddStrategy } from "../../config";
import type { UserStory } from "../../prd/types";
import { extractJsonFromMarkdown, parseLLMJson, wrapJsonPrompt } from "../../utils/llm-json";
import { determineTestStrategy } from "../classify";
import type { RoutingDecision } from "../router";

/**
 * Build the routing prompt for a single story.
 *
 * @param story - User story to route
 * @param config - nax configuration
 * @returns Formatted prompt string
 */
export function buildRoutingPrompt(story: UserStory, _config: NaxConfig): string {
  const { title, description, acceptanceCriteria, tags } = story;
  const criteria = acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");

  const core = `You are a code task router. Classify a user story's complexity and select the cheapest model tier that will succeed.

## Story
Title: ${title}
Description: ${description}
Acceptance Criteria:
${criteria}
Tags: ${tags.join(", ")}

## Complexity Levels
- simple: Typos, config updates, boilerplate, barrel exports, re-exports. <30 min.
- medium: Standard features, moderate logic, straightforward tests. 30-90 min.
- complex: Multi-file refactors, new subsystems, integration work. >90 min.
- expert: Security-critical, novel algorithms, complex architecture decisions.

## Model Tiers
- fast: For simple tasks. Cheapest.
- balanced: For medium tasks. Standard cost.
- powerful: For complex/expert tasks. Most capable, highest cost.

## Rules
- Default to the CHEAPEST tier that will succeed.
- Simple barrel exports, re-exports, or index files → always simple + fast.
- Many files ≠ complex — copy-paste refactors across files are simple.
- Pure refactoring/deletion with no new behavior → simple.

Respond with:
{"complexity":"simple|medium|complex|expert","modelTier":"fast|balanced|powerful","reasoning":"<one line>"}`;

  return wrapJsonPrompt(core);
}

/**
 * Build batch routing prompt for multiple stories.
 *
 * @param stories - Array of user stories to route
 * @param config - nax configuration
 * @returns Formatted batch prompt string
 */
export function buildBatchRoutingPrompt(stories: UserStory[], _config: NaxConfig): string {
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

  const batchCore = `You are a code task router. Classify each story's complexity and select the cheapest model tier that will succeed.

## Stories
${storyBlocks}

## Complexity Levels
- simple: Typos, config updates, boilerplate, barrel exports, re-exports. <30 min.
- medium: Standard features, moderate logic, straightforward tests. 30-90 min.
- complex: Multi-file refactors, new subsystems, integration work. >90 min.
- expert: Security-critical, novel algorithms, complex architecture decisions.

## Model Tiers
- fast: For simple tasks. Cheapest.
- balanced: For medium tasks. Standard cost.
- powerful: For complex/expert tasks. Most capable, highest cost.

## Rules
- Default to the CHEAPEST tier that will succeed.
- Simple barrel exports, re-exports, or index files → always simple + fast.
- Many files ≠ complex — copy-paste refactors across files are simple.
- Pure refactoring/deletion with no new behavior → simple.

Respond with a JSON array:
[{"id":"US-001","complexity":"simple|medium|complex|expert","modelTier":"fast|balanced|powerful","reasoning":"<one line>"}]`;

  return wrapJsonPrompt(batchCore);
}

/**
 * Validate a parsed routing object and return a clean RoutingDecision.
 *
 * @param parsed - Parsed JSON object with routing fields
 * @param config - nax configuration (for modelTier validation)
 * @returns Validated routing decision
 * @throws Error if validation fails
 */
export function validateRoutingDecision(
  parsed: Record<string, unknown>,
  config: NaxConfig,
  story?: UserStory,
): RoutingDecision {
  // Validate required fields (testStrategy no longer required from LLM — derived via BUG-045)
  if (!parsed.complexity || !parsed.modelTier || !parsed.reasoning) {
    throw new Error(`Missing required fields in LLM response: ${JSON.stringify(parsed)}`);
  }

  // Validate field values
  const validComplexities: Complexity[] = ["simple", "medium", "complex", "expert"];

  if (!validComplexities.includes(parsed.complexity as Complexity)) {
    throw new Error(`Invalid complexity: ${parsed.complexity}`);
  }

  // Validate modelTier exists in config (check any agent's tier map)
  const modelTier = parsed.modelTier as string;
  const tierExistsInAnyAgent = Object.values(config.models).some((agentTiers) => modelTier in agentTiers);
  if (!tierExistsInAnyAgent) {
    throw new Error(`Invalid modelTier: ${modelTier} (not found in any agent's tier map)`);
  }

  // BUG-045: Derive testStrategy from determineTestStrategy() — single source of truth.
  // LLM decides complexity; testStrategy is a policy decision, not a judgment call.
  const tddStrategy: TddStrategy = config.tdd?.strategy ?? "auto";
  const testStrategy = determineTestStrategy(
    parsed.complexity as Complexity,
    story?.title ?? "",
    story?.description ?? "",
    story?.tags ?? [],
    tddStrategy,
  );

  return {
    complexity: parsed.complexity as Complexity,
    modelTier: parsed.modelTier as ModelTier,
    testStrategy,
    reasoning: parsed.reasoning as string,
  };
}

/**
 * Strip markdown code fences from LLM output.
 * @deprecated Use extractJsonFromMarkdown from utils/llm-json directly.
 */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fromFence = extractJsonFromMarkdown(trimmed);
  if (fromFence !== trimmed) return fromFence;
  // Handle bare 'json\n...' pattern (LLM outputs language hint without backticks)
  if (trimmed.startsWith("json")) {
    return trimmed.slice(4).trim();
  }
  return trimmed;
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
  const parsed = parseLLMJson<Record<string, unknown>>(output);
  return validateRoutingDecision(parsed, config, story);
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
export function parseBatchResponse(
  output: string,
  stories: UserStory[],
  config: NaxConfig,
): Map<string, RoutingDecision> {
  const parsed = parseLLMJson(output);

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
    const decision = validateRoutingDecision(entry, config, story);
    decisions.set(entry.id, decision);
  }

  return decisions;
}
