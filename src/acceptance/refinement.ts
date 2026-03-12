/**
 * AC Refinement Module
 *
 * Takes raw PRD acceptanceCriteria strings and refines them into concrete,
 * testable assertions using an LLM call via adapter.complete().
 *
 * STUB — implementation pending (ACC-001).
 */

import type { AgentAdapter } from "../agents";
import { ClaudeCodeAdapter } from "../agents/claude";
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
export function buildRefinementPrompt(_criteria: string[], _codebaseContext: string): string {
  throw new Error("[refinement] buildRefinementPrompt: not implemented");
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
export function parseRefinementResponse(_response: string, _criteria: string[]): RefinedCriterion[] {
  throw new Error("[refinement] parseRefinementResponse: not implemented");
}

/**
 * Refine raw acceptance criteria strings into concrete, testable assertions.
 *
 * @param criteria - Raw AC strings from PRD
 * @param context - Refinement context (storyId, codebase context, config)
 * @returns Promise resolving to array of refined criteria
 */
export async function refineAcceptanceCriteria(
  _criteria: string[],
  _context: RefinementContext,
): Promise<RefinedCriterion[]> {
  throw new Error("[refinement] refineAcceptanceCriteria: not implemented");
}
