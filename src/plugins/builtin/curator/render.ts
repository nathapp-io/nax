/**
 * Curator Render — Phase 3
 *
 * Renders proposals to markdown format for human review.
 */

import type { Proposal } from "./heuristics";

/**
 * Render proposals to markdown format.
 *
 * Groups proposals by target action and canonical file, with severity and evidence.
 * Includes timestamp, observation count, and checkbox sections.
 *
 * @param proposals - Array of proposals to render
 * @param runId - Identifier of the run
 * @param observationCount - Total observation count from this run
 * @returns Markdown string
 */
export function renderProposals(proposals: Proposal[], runId: string, observationCount: number): string {
  // TODO: Implement markdown rendering
  return "";
}
