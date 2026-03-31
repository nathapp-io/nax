/**
 * Debate Resolvers
 *
 * Strategies for resolving the outcome of a debate session:
 * - majorityResolver: parses JSON pass/fail from each proposal, returns majority vote
 * - synthesisResolver: calls adapter.complete() with a synthesis prompt
 * - judgeResolver: calls adapter.complete() with a judge prompt using resolver.agent
 */

import type { AgentAdapter } from "../agents/types";
import { buildJudgePrompt, buildSynthesisPrompt } from "./prompts";
import type { ResolverConfig } from "./types";

const DEFAULT_FALLBACK_AGENT = "claude";

/**
 * Strip markdown fences from a string, returning the inner content.
 */
function stripMarkdownFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  return match ? (match[1] ?? text) : text;
}

/**
 * Parse a proposal string and extract the "passed" boolean.
 * Returns null when the proposal is not valid JSON or lacks a "passed" field.
 */
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

/**
 * Majority resolver — parses JSON pass/fail from each proposal.
 * Returns 'passed' when a strict majority pass. Fail-closed on tie.
 */
export function majorityResolver(proposals: string[], failOpen: boolean): "passed" | "failed" {
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

/**
 * Synthesis resolver — calls adapter.complete() once with a synthesis prompt.
 * Returns the raw output string from the adapter.
 */
export async function synthesisResolver(
  proposals: string[],
  critiques: string[],
  opts: { adapter: AgentAdapter },
): Promise<string> {
  const prompt = buildSynthesisPrompt(proposals, critiques);
  return opts.adapter.complete(prompt);
}

/**
 * Judge resolver — calls adapter.complete() once with a judge prompt.
 * Uses resolver.agent (or defaultAgentName) to look up the judge adapter.
 */
export async function judgeResolver(
  proposals: string[],
  critiques: string[],
  resolverConfig: ResolverConfig,
  opts: {
    getAgent: (name: string) => AgentAdapter | undefined;
    defaultAgentName?: string;
  },
): Promise<string> {
  const agentName = resolverConfig.agent ?? opts.defaultAgentName ?? DEFAULT_FALLBACK_AGENT;
  const adapter = opts.getAgent(agentName);

  if (!adapter) {
    throw new Error(`[debate] Judge agent '${agentName}' not found`);
  }

  const prompt = buildJudgePrompt(proposals, critiques);
  return adapter.complete(prompt);
}
