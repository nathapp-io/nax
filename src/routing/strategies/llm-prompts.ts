/**
 * LLM Routing Prompts & Parsers
 *
 * Extracted from llm.ts: prompt building, response parsing, and validation
 * for LLM-based routing decisions.
 */

import type { Complexity, ModelTier, NaxConfig, TddStrategy, TestStrategy } from "../../config";
import type { UserStory } from "../../prd/types";
import { determineTestStrategy } from "../router";
import type { RoutingDecision } from "../strategy";

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

## Test Strategies (derived from complexity)
Your complexity classification will determine the execution strategy:
- simple → tdd-simple: Single-session TDD (agent writes tests first, then implements)
- medium → three-session-tdd-lite: Multi-session with lite isolation
- complex/expert → three-session-tdd: Strict multi-session TDD isolation
- test-after: Reserved for non-TDD work (refactors, deletions, config-only changes)

## Rules
- Default to the CHEAPEST tier that will succeed.
- Simple barrel exports, re-exports, or index files are ALWAYS simple + fast.
- A story touching many files doesn't automatically mean complex — copy-paste refactors are simple.
- If the story is pure refactoring/deletion with no new behavior, consider it "simple" for tdd-simple strategy.

Respond with ONLY this JSON (no markdown, no explanation):
{"complexity":"simple|medium|complex|expert","modelTier":"fast|balanced|powerful","reasoning":"<one line>"}`;
}

/**
 * Build batch routing prompt for multiple stories.
 *
 * @param stories - Array of user stories to route
 * @param config - nax configuration
 * @returns Formatted batch prompt string
 */
export function buildBatchRoutingPrompt(stories: UserStory[], config: NaxConfig): string {
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

## Test Strategies (derived from complexity)
Your complexity classification will determine the execution strategy:
- simple → tdd-simple: Single-session TDD (agent writes tests first, then implements)
- medium → three-session-tdd-lite: Multi-session with lite isolation
- complex/expert → three-session-tdd: Strict multi-session TDD isolation
- test-after: Reserved for non-TDD work (refactors, deletions, config-only changes)

## Rules
- Default to the CHEAPEST tier that will succeed.
- Simple barrel exports, re-exports, or index files are ALWAYS simple + fast.
- A story touching many files doesn't automatically mean complex — copy-paste refactors are simple.
- If the story is pure refactoring/deletion with no new behavior, consider it "simple" for tdd-simple strategy.

Respond with ONLY a JSON array (no markdown, no explanation):
[{"id":"US-001","complexity":"simple|medium|complex|expert","modelTier":"fast|balanced|powerful","reasoning":"<one line>"}]`;
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

  // Validate modelTier exists in config
  if (!config.models[parsed.modelTier as string]) {
    throw new Error(`Invalid modelTier: ${parsed.modelTier} (not in config.models)`);
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

/** Strip markdown code fences from LLM output. */
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
    const decision = validateRoutingDecision(entry, config, story);
    decisions.set(entry.id, decision);
  }

  return decisions;
}
