/**
 * DebatePromptBuilder — Phase 3
 *
 * Centralizes all debate prompt construction behind a single class.
 * Owns shared formatting logic as private methods and exposes one public
 * method per prompt phase (proposal, critique, rebuttal, synthesis, judge, close).
 */

import { PERSONA_FRAGMENTS } from "./personas";
import type { Debater, Proposal, Rebuttal } from "./types";

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface StageContext {
  /** Task description — spec, codebase context, constraints. No output format. */
  taskContext: string;
  /** Output format instructions — JSON schema, format directives, etc. */
  outputFormat: string;
  /** Stage name — used in critique framing text. */
  stage: string;
}

export interface PromptBuilderOptions {
  /** Debaters participating in this debate (with personas already resolved). */
  debaters: Debater[];
  /** Session mode — determines whether taskContext is re-sent in rebuttal prompts. */
  sessionMode: "stateful" | "one-shot";
}

// ─── Class ───────────────────────────────────────────────────────────────────

export class DebatePromptBuilder {
  constructor(
    private readonly stageContext: StageContext,
    private readonly options: PromptBuilderOptions,
  ) {}

  /**
   * Round 0 — initial proposal prompt.
   * Includes taskContext + optional persona block + outputFormat.
   */
  buildProposalPrompt(debaterIndex: number): string {
    const personaBlock = this.buildPersonaBlock(debaterIndex);
    return `${this.stageContext.taskContext}${personaBlock}\n\n${this.stageContext.outputFormat}`;
  }

  /**
   * Panel-mode critique (round 1+).
   * Excludes the calling debater's own proposal. No outputFormat block.
   */
  buildCritiquePrompt(debaterIndex: number, proposals: Proposal[]): string {
    const otherProposals = proposals.filter((_, i) => i !== debaterIndex);
    const proposalsSection = this.buildProposalsSection(otherProposals);
    const personaBlock = this.buildPersonaBlock(debaterIndex);

    return `You are reviewing proposals for a ${this.stageContext.stage} task.

## Task
${this.stageContext.taskContext}${personaBlock}

## Other Agents' Proposals
${proposalsSection}

Please critique these proposals and provide your refined analysis, identifying strengths, weaknesses, and your own updated position.`;
  }

  /**
   * Hybrid-mode rebuttal (round 1+).
   * All proposals + prior rebuttals + persona. No outputFormat.
   * In stateful mode, taskContext is omitted (debater already has it).
   * In one-shot mode, taskContext is included (fresh prompt each round).
   */
  buildRebuttalPrompt(debaterIndex: number, proposals: Proposal[], priorRebuttals: Rebuttal[]): string {
    const contextBlock = this.options.sessionMode === "one-shot" ? `${this.stageContext.taskContext}\n\n` : "";
    const proposalsSection = this.buildProposalsSection(proposals);
    const rebuttalsSection = this.buildRebuttalsSection(priorRebuttals);
    const personaBlock = this.buildPersonaBlock(debaterIndex);
    const debaterNumber = debaterIndex + 1;

    return `${contextBlock}## Proposals
${proposalsSection}${rebuttalsSection}${personaBlock}

## Your Task
You are debater ${debaterNumber}. Provide your critique in prose.
Identify strengths, weaknesses, and specific improvements for each proposal.
Do NOT output JSON — focus on analysis only.`;
  }

  /**
   * Synthesis resolver prompt.
   * Includes all proposals, critiques, taskContext, and outputFormat.
   */
  buildSynthesisPrompt(proposals: Proposal[], critiques: Rebuttal[], promptSuffix?: string): string {
    const proposalsSection = this.buildProposalsSection(proposals);
    const critiquesSection = this.buildCritiquesSection(critiques);

    return `You are a synthesis agent. Your task is to combine the strongest elements from multiple proposals into a single, optimal response.

${this.stageContext.taskContext}

## Proposals
${proposalsSection}

## Critiques
${critiquesSection}

Please synthesize these into the best possible unified response, incorporating the strongest elements from each proposal.
${this.stageContext.outputFormat}${promptSuffix ? `\n${promptSuffix}` : ""}`;
  }

  /**
   * Judge resolver prompt.
   * Same data as synthesis, judge framing.
   */
  buildJudgePrompt(proposals: Proposal[], critiques: Rebuttal[]): string {
    const proposalsSection = this.buildProposalsSection(proposals);
    const critiquesSection = this.buildCritiquesSection(critiques);

    return `You are a judge evaluating multiple proposals. Select the best proposal or synthesize the optimal response.

${this.stageContext.taskContext}

## Proposals
${proposalsSection}

## Critiques
${critiquesSection}

Evaluate each proposal against the critiques and provide the best possible response.
${this.stageContext.outputFormat}`;
  }

  /** Termination signal sent to close a stateful debate session. */
  buildClosePrompt(): string {
    return "Close this debate session.";
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private buildPersonaBlock(debaterIndex: number): string {
    const debater = this.options.debaters[debaterIndex];
    if (!debater?.persona) return "";
    const { identity, lens } = PERSONA_FRAGMENTS[debater.persona];
    return `\n\n## Your Role\n${identity}\n${lens}`;
  }

  private buildProposalsSection(proposals: Proposal[]): string {
    return proposals
      .map((p, i) => `### Proposal ${i + 1} (${this.buildDebaterLabel(p.debater)})\n${p.output}`)
      .join("\n\n");
  }

  private buildRebuttalsSection(rebuttals: Rebuttal[]): string {
    if (rebuttals.length === 0) return "";
    return `\n\n## Previous Rebuttals\n${rebuttals.map((r, i) => `${i + 1}. ${r.output}`).join("\n\n")}`;
  }

  private buildCritiquesSection(critiques: Rebuttal[]): string {
    if (critiques.length === 0) return "";
    return critiques
      .map((c, i) => `### Critique ${i + 1} (${this.buildDebaterLabel(c.debater)})\n${c.output}`)
      .join("\n\n");
  }

  private buildDebaterLabel(debater: Debater): string {
    return debater.persona ? `${debater.agent} (${debater.persona})` : debater.agent;
  }
}
