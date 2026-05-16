/**
 * Majority selector strategies — fail-closed and fail-open variants.
 *
 * Extracted from src/debate/resolvers.ts majorityResolver body.
 * resolvers.ts delegates to computeMajority for the compat wrapper.
 */

import type { Selector, SelectorContext, SelectorResult } from "./types";

function stripMarkdownFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  return match ? (match[1] ?? text) : text;
}

function parsePassedField(proposal: string): boolean | null {
  try {
    const stripped = stripMarkdownFence(proposal.trim());
    const parsed = JSON.parse(stripped) as unknown;
    if (typeof parsed === "object" && parsed !== null && "passed" in parsed) {
      const { passed } = parsed as Record<string, unknown>;
      if (typeof passed === "boolean") return passed;
    }
    return null;
  } catch {
    return null;
  }
}

export function computeMajority(proposals: string[], failOpen: boolean): "passed" | "failed" {
  let passCount = 0;
  let failCount = 0;

  for (const proposal of proposals) {
    const passed = parsePassedField(proposal);
    if (passed === true) passCount++;
    else if (failOpen)
      passCount++; // null (unparseable) counts as pass — fail-open
    else failCount++; // null (unparseable) counts as fail — fail-closed
  }

  return passCount > failCount ? "passed" : "failed";
}

export const majorityFailClosedSelector: Selector = async (ctx: SelectorContext): Promise<SelectorResult> => {
  const proposalOutputs = ctx.proposals.map((p) => p.output);
  return { outcome: computeMajority(proposalOutputs, false) };
};

export const majorityFailOpenSelector: Selector = async (ctx: SelectorContext): Promise<SelectorResult> => {
  const proposalOutputs = ctx.proposals.map((p) => p.output);
  return { outcome: computeMajority(proposalOutputs, true) };
};
