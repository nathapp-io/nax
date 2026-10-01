/**
 * Routing Candidates Section
 *
 * Lists the available model tiers and their descriptions for LLM routing decisions.
 * Used by OneShotPromptBuilder for the "router" role.
 */

import type { PromptSection } from "../types";

export interface RoutingCandidate {
  tier: string;
  description: string;
  costPerMillion?: number;
}

export function routingCandidatesSection(candidates: RoutingCandidate[]): PromptSection {
  const body = candidates
    .map((c) => {
      const cost = c.costPerMillion ? ` ($${c.costPerMillion}/M tokens)` : "";
      return `- **${c.tier}**${cost}: ${c.description}`;
    })
    .join("\n");
  return {
    id: "candidates",
    overridable: false,
    content: `# AVAILABLE TIERS\n\n${body}`,
  };
}
