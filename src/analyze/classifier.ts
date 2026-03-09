/**
 * LLM-Enhanced Classifier
 *
 * Uses a single cheap LLM call (haiku) to classify all stories in one shot.
 * Falls back to keyword matching if LLM call fails.
 */

import type { AgentAdapter } from "../agents";
import { ClaudeCodeAdapter } from "../agents/claude";
import type { NaxConfig } from "../config";
import { resolveModel } from "../config/schema";
import { getLogger } from "../logger";
import type { UserStory } from "../prd";
import { classifyComplexity } from "../routing";
import type { ClassificationResult, CodebaseScan, StoryClassification } from "./types";

/**
 * Injectable dependencies for classifier — allows tests to mock adapter.complete()
 * without needing the claude binary.
 *
 * @internal
 */
export const _classifyDeps = {
  adapter: new ClaudeCodeAdapter() as AgentAdapter,
};

/**
 * Raw LLM classification item (before validation)
 */
interface LLMClassificationItem {
  storyId: unknown;
  complexity: unknown;
  relevantFiles: unknown;
  reasoning: unknown;
  estimatedLOC: unknown;
  risks: unknown;
}

/**
 * Classify stories using LLM-enhanced analysis with fallback to keyword matching.
 *
 * Makes a single Anthropic API call (haiku tier) to classify all stories.
 * If the LLM call fails or returns invalid JSON, falls back to keyword matching.
 *
 * @param stories - User stories to classify
 * @param scan - Codebase scan result
 * @param config - Ngent configuration
 * @returns Classification result with method used
 *
 * @example
 * ```ts
 * const result = await classifyStories(stories, scan, config);
 * if (result.method === "keyword-fallback") {
 *   console.warn("LLM classification failed:", result.fallbackReason);
 * }
 * console.log(result.classifications);
 * ```
 */
export async function classifyStories(
  stories: UserStory[],
  scan: CodebaseScan,
  config: NaxConfig,
): Promise<ClassificationResult> {
  // Check if LLM-enhanced analysis is enabled
  if (!config.analyze?.llmEnhanced) {
    return {
      classifications: stories.map((story) => fallbackClassification(story)),
      method: "keyword-fallback",
      fallbackReason: "LLM-enhanced analysis disabled in config",
    };
  }

  // Try LLM classification
  try {
    const classifications = await classifyWithLLM(stories, scan, config);
    return {
      classifications,
      method: "llm",
    };
  } catch (error) {
    // Fall back to keyword matching
    const reason = error instanceof Error ? error.message : String(error);
    const logger = getLogger();
    logger.warn("analyze", "LLM classification failed, falling back to keyword matching", { error: reason });

    return {
      classifications: stories.map((story) => fallbackClassification(story)),
      method: "keyword-fallback",
      fallbackReason: reason,
    };
  }
}

/**
 * Classify stories using LLM with structured JSON output.
 *
 * @param stories - User stories to classify
 * @param scan - Codebase scan result
 * @param config - Ngent configuration
 * @returns Array of story classifications
 */
async function classifyWithLLM(
  stories: UserStory[],
  scan: CodebaseScan,
  config: NaxConfig,
): Promise<StoryClassification[]> {
  // Check for required environment variables
  // In tests, ANTHROPIC_API_KEY may not be set, but adapter.complete will be mocked
  if (!process.env.ANTHROPIC_API_KEY && process.env.NODE_ENV !== "test") {
    throw new Error("ANTHROPIC_API_KEY environment variable not configured — cannot use LLM classification");
  }

  // Build prompt
  const prompt = buildClassificationPrompt(stories, scan);

  // Resolve model from config.models.fast
  const fastModelEntry = config.models.fast;
  if (!fastModelEntry) {
    throw new Error("config.models.fast not configured");
  }
  const modelDef = resolveModel(fastModelEntry);

  // Make API call via adapter (use haiku for cheap classification)
  const jsonText = await _classifyDeps.adapter.complete(prompt, {
    jsonMode: true,
    maxTokens: 4096,
    model: modelDef.model,
  });

  // Parse JSON response
  const parsed: unknown = JSON.parse(jsonText);

  // Validate structure
  if (!Array.isArray(parsed)) {
    throw new Error("LLM response is not an array");
  }

  // Map to StoryClassification[]
  const classifications: StoryClassification[] = parsed.map((item: unknown) => {
    const rawItem = item as LLMClassificationItem;
    return {
      storyId: String(rawItem.storyId),
      complexity: validateComplexity(rawItem.complexity),
      contextFiles: Array.isArray(rawItem.relevantFiles) ? rawItem.relevantFiles.map(String) : [],
      reasoning: String(rawItem.reasoning || "No reasoning provided"),
      estimatedLOC: Number(rawItem.estimatedLOC) || 0,
      risks: Array.isArray(rawItem.risks) ? rawItem.risks.map(String) : [],
    };
  });

  // Ensure all stories are classified
  const classifiedIds = new Set(classifications.map((c) => c.storyId));
  for (const story of stories) {
    if (!classifiedIds.has(story.id)) {
      throw new Error(`Story ${story.id} not classified by LLM`);
    }
  }

  return classifications;
}

/**
 * Build classification prompt for LLM.
 *
 * @param stories - User stories to classify
 * @param scan - Codebase scan result
 * @returns Formatted prompt string
 */
function buildClassificationPrompt(stories: UserStory[], scan: CodebaseScan): string {
  // Format codebase summary
  const codebaseSummary = `
FILE TREE:
${scan.fileTree}

DEPENDENCIES:
${Object.entries(scan.dependencies)
  .map(([name, version]) => `- ${name}: ${version}`)
  .join("\n")}

DEV DEPENDENCIES:
${Object.entries(scan.devDependencies)
  .map(([name, version]) => `- ${name}: ${version}`)
  .join("\n")}

TEST PATTERNS:
${scan.testPatterns.map((p) => `- ${p}`).join("\n")}
`.trim();

  // Format stories as JSON for LLM
  const storiesJson = JSON.stringify(
    stories.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      acceptanceCriteria: s.acceptanceCriteria,
      tags: s.tags,
    })),
    null,
    2,
  );

  return `You are a code complexity classifier. Given a codebase summary and user stories,
classify each story's implementation complexity.

CODEBASE:
${codebaseSummary}

STORIES:
${storiesJson}

For each story, respond with a JSON array (and ONLY the JSON array, no markdown code fences):
[{
  "storyId": "US-001",
  "complexity": "simple|medium|complex|expert",
  "relevantFiles": ["src/path/to/file.ts"],
  "reasoning": "Why this complexity level",
  "estimatedLOC": 50,
  "risks": ["No existing cache layer"]
}]

Classification rules:
- simple: 1-3 files, <100 LOC, straightforward implementation, existing patterns
- medium: 3-6 files, 100-300 LOC, moderate logic, some new patterns
- complex: 6+ files, 300-800 LOC, architectural changes, cross-cutting concerns
- expert: Security/crypto/real-time/distributed systems, >800 LOC, new infrastructure

Consider:
1. Does infrastructure exist? (e.g., "add caching" when no cache layer exists = complex)
2. How many files will be touched?
3. Are there cross-cutting concerns (auth, validation, error handling)?
4. Does it require new dependencies or architectural decisions?

Respond with ONLY the JSON array.`;
}

/**
 * Validate complexity value from LLM response.
 *
 * @param value - Complexity value from LLM
 * @returns Valid Complexity type
 */
function validateComplexity(value: unknown): "simple" | "medium" | "complex" | "expert" {
  if (value === "simple" || value === "medium" || value === "complex" || value === "expert") {
    return value;
  }
  // Default to medium if invalid
  return "medium";
}

/**
 * Fallback classification using keyword matching.
 *
 * @param story - User story to classify
 * @returns Story classification using keyword-based complexity
 */
function fallbackClassification(story: UserStory): StoryClassification {
  const complexity = classifyComplexity(story.title, story.description, story.acceptanceCriteria, story.tags);

  return {
    storyId: story.id,
    complexity,
    contextFiles: [],
    reasoning: `Keyword-based classification: ${complexity}`,
    estimatedLOC: estimateLOCFromComplexity(complexity),
    risks: [],
  };
}

/**
 * Estimate LOC from complexity level (rough heuristic).
 *
 * @param complexity - Complexity level
 * @returns Estimated lines of code
 */
function estimateLOCFromComplexity(complexity: "simple" | "medium" | "complex" | "expert"): number {
  switch (complexity) {
    case "simple":
      return 50;
    case "medium":
      return 150;
    case "complex":
      return 400;
    case "expert":
      return 800;
  }
}
