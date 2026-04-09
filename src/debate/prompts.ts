/**
 * Debate Prompt Templates
 *
 * Prompt builders for critique, synthesis, and judge rounds.
 */

import type { Debater } from "./types";

/**
 * Build a critique prompt for a debater.
 * Includes all other debaters' proposals but excludes the current debater's own proposal.
 */
export function buildCritiquePrompt(taskPrompt: string, allProposals: string[], debaterIndex: number): string {
  const othersProposals = allProposals.filter((_, i) => i !== debaterIndex);
  const proposalsSection = othersProposals.map((p, i) => `### Proposal ${i + 1}\n${p}`).join("\n\n");

  return `You are reviewing proposals from other agents for the following task.

## Task
${taskPrompt}

## Other Agents' Proposals
${proposalsSection}

Please critique these proposals and provide your refined analysis, identifying strengths, weaknesses, and your own updated position.`;
}

/**
 * Build a synthesis prompt containing all proposals and critiques.
 */
export function buildSynthesisPrompt(proposals: string[], critiques: string[]): string {
  const proposalsSection = proposals.map((p, i) => `### Proposal ${i + 1}\n${p}`).join("\n\n");

  const critiquesSection =
    critiques.length > 0
      ? `\n\n## Critiques\n${critiques.map((c, i) => `### Critique ${i + 1}\n${c}`).join("\n\n")}`
      : "";

  return `You are a synthesis agent. Your task is to synthesize the following proposals into a single coherent, high-quality response.

## Proposals
${proposalsSection}${critiquesSection}

Please synthesize these into the best possible unified response, incorporating the strongest elements from each proposal.`;
}

/**
 * Build a judge prompt for evaluating all proposals and critiques.
 * Distinct from synthesis — the judge makes a final verdict rather than synthesizing.
 */
export function buildJudgePrompt(proposals: string[], critiques: string[]): string {
  const proposalsSection = proposals.map((p, i) => `### Proposal ${i + 1}\n${p}`).join("\n\n");

  const critiquesSection =
    critiques.length > 0
      ? `\n\n## Critiques\n${critiques.map((c, i) => `### Critique ${i + 1}\n${c}`).join("\n\n")}`
      : "";

  return `You are a judge evaluating multiple proposals. Review each proposal carefully and make a final authoritative determination.

## Proposals
${proposalsSection}${critiquesSection}

As the judge, provide your final verdict with clear reasoning, selecting or synthesizing the best approach.`;
}

/**
 * Build a rebuttal context prompt for a debater in a rebuttal round.
 *
 * In stateful mode the debater already saw taskContext during the proposal turn — omit it.
 * In one-shot mode each round is a fresh prompt, so taskContext must be included.
 *
 * The task instruction is prose-only: debaters must critique, not produce JSON.
 */
export function buildRebuttalContext(
  taskContext: string,
  proposals: Array<{ debater: Debater; output: string }>,
  rebuttalOutputs: string[],
  currentDebaterIndex: number,
  sessionMode: "stateful" | "one-shot",
): string {
  const contextBlock = sessionMode === "one-shot" ? `${taskContext}\n\n` : "";

  const proposalsSection = proposals
    .map((p, i) => `### Proposal ${i + 1} (${p.debater.agent})\n${p.output}`)
    .join("\n\n");

  const rebuttalsSection =
    rebuttalOutputs.length > 0
      ? `\n\n## Previous Rebuttals\n${rebuttalOutputs.map((r, i) => `${i + 1}. ${r}`).join("\n\n")}`
      : "";

  const debaterNumber = currentDebaterIndex + 1;

  return `${contextBlock}## Proposals
${proposalsSection}${rebuttalsSection}

## Your Task
You are debater ${debaterNumber}. Provide your critique in prose.
Identify strengths, weaknesses, and specific improvements for each proposal.
Do NOT output JSON — focus on analysis only.`;
}
