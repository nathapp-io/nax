/**
 * AC Refinement Module
 *
 * Takes raw PRD acceptanceCriteria strings and refines them into concrete,
 * testable assertions using an LLM call via adapter.complete().
 */

import type { AgentAdapter } from "../agents";
import { ClaudeCodeAdapter } from "../agents/claude";
import { resolveModel } from "../config/schema";
import { getLogger } from "../logger";
import { errorMessage } from "../utils/errors";
import type { RefinedCriterion, RefinementContext } from "./types";

/**
 * Injectable dependencies — allows tests to mock adapter.complete()
 * without needing the claude binary.
 *
 * @internal
 */
export const _refineDeps = {
  adapter: new ClaudeCodeAdapter() as AgentAdapter,
};

/**
 * Build the LLM prompt for refining acceptance criteria.
 *
 * @param criteria - Raw AC strings from PRD
 * @param codebaseContext - File tree / dependency context
 * @returns Formatted prompt string
 */
export function buildRefinementPrompt(criteria: string[], codebaseContext: string): string {
  const criteriaList = criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");

  return `You are an acceptance criteria refinement assistant. Your task is to convert raw acceptance criteria into concrete, machine-verifiable assertions.

CODEBASE CONTEXT:
${codebaseContext}

ACCEPTANCE CRITERIA TO REFINE:
${criteriaList}

For each criterion, produce a refined version that is concrete and automatically testable where possible.
Respond with ONLY a JSON array (no markdown code fences):
[{
  "original": "<exact original criterion text>",
  "refined": "<concrete, machine-verifiable description>",
  "testable": true,
  "storyId": ""
}]

Rules:
- "original" must match the input criterion text exactly
- "refined" must be a concrete assertion (e.g., "Function returns array of length N", "HTTP status 200 returned")
- "testable" is false only if the criterion cannot be automatically verified (e.g., "UX feels responsive", "design looks good")
- "storyId" leave as empty string — it will be assigned by the caller
- Respond with ONLY the JSON array`;
}

/**
 * Parse the LLM JSON response into RefinedCriterion[].
 *
 * Falls back gracefully: if JSON is malformed or a criterion is missing,
 * uses the original text with testable: true.
 *
 * @param response - Raw LLM response text
 * @param criteria - Original criteria strings (used as fallback)
 * @returns Array of refined criteria
 */
export function parseRefinementResponse(response: string, criteria: string[]): RefinedCriterion[] {
  if (!response || !response.trim()) {
    return fallbackCriteria(criteria);
  }

  try {
    const parsed: unknown = JSON.parse(response);

    if (!Array.isArray(parsed)) {
      return fallbackCriteria(criteria);
    }

    return (parsed as RefinedCriterion[]).map((item, i) => ({
      original: typeof item.original === "string" && item.original.length > 0 ? item.original : (criteria[i] ?? ""),
      refined: typeof item.refined === "string" && item.refined.length > 0 ? item.refined : (criteria[i] ?? ""),
      testable: typeof item.testable === "boolean" ? item.testable : true,
      storyId: typeof item.storyId === "string" ? item.storyId : "",
    }));
  } catch {
    return fallbackCriteria(criteria);
  }
}

/**
 * Refine raw acceptance criteria strings into concrete, testable assertions.
 *
 * @param criteria - Raw AC strings from PRD
 * @param context - Refinement context (storyId, codebase context, config)
 * @returns Promise resolving to array of refined criteria
 */
export async function refineAcceptanceCriteria(
  criteria: string[],
  context: RefinementContext,
): Promise<RefinedCriterion[]> {
  if (criteria.length === 0) {
    return [];
  }

  const { storyId, codebaseContext, config } = context;
  const logger = getLogger();

  const modelTier = config.acceptance?.model ?? "fast";
  const modelEntry = config.models[modelTier] ?? config.models.fast;

  if (!modelEntry) {
    throw new Error(`[refinement] config.models.${modelTier} not configured`);
  }

  const modelDef = resolveModel(modelEntry);
  const prompt = buildRefinementPrompt(criteria, codebaseContext);

  let response: string;

  try {
    response = await _refineDeps.adapter.complete(prompt, {
      jsonMode: true,
      maxTokens: 4096,
      model: modelDef.model,
    });
  } catch (error) {
    const reason = errorMessage(error);
    logger.warn("refinement", "adapter.complete() failed, falling back to original criteria", {
      storyId,
      error: reason,
    });
    return fallbackCriteria(criteria, storyId);
  }

  const parsed = parseRefinementResponse(response, criteria);

  return parsed.map((item) => ({
    ...item,
    storyId: item.storyId || storyId,
  }));
}

/**
 * Build fallback RefinedCriterion[] using original criterion text.
 */
function fallbackCriteria(criteria: string[], storyId = ""): RefinedCriterion[] {
  return criteria.map((c) => ({
    original: c,
    refined: c,
    testable: true,
    storyId,
  }));
}
