/**
 * DebatePromptBuilder — centralises all debate and review-dialogue prompt construction.
 *
 * Owns shared formatting logic as private methods and exposes one public
 * method per prompt phase (proposal, critique, rebuttal, synthesis, judge, close)
 * plus review-specific methods (review, re-review, resolver, re-resolver).
 *
 * Moved from: src/debate/prompt-builder.ts
 * Imports from debate internals directly (not via src/debate barrel) to
 * avoid a circular dependency: src/debate/index.ts re-exports this class
 * from src/prompts, so importing the barrel here would form a cycle.
 */

import { PERSONA_FRAGMENTS } from "../../debate/personas";
import type { DebateResolverContext, Debater, Proposal, Rebuttal } from "../../debate/types";
import type { ReviewFinding } from "../../plugins/types";
import type { DiffContext } from "../../review/types";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Canonical ReviewFinding schema for all LLM-facing JSON directives (issue #368). */
const FINDING_SCHEMA = `{ ruleId: string; severity: "critical" | "error" | "warning" | "info" | "low"; file: string; line: number; message: string }`;

const REVIEW_JSON_DIRECTIVE = `Respond with JSON: { passed: boolean; findings: Array<${FINDING_SCHEMA}>; findingReasoning: { [ruleId: string]: string } }`;

const RE_REVIEW_JSON_DIRECTIVE = `Respond with JSON: { passed: boolean; findings: Array<${FINDING_SCHEMA}>; findingReasoning: { [ruleId: string]: string }; deltaSummary: string }`;

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Story fields required by review-specific prompt methods. */
export interface ReviewStoryContext {
  id: string;
  title: string;
  acceptanceCriteria: string[];
}

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
   * Assembly order: persona → task → proposals (no prose directive after JSON-only gate).
   */
  buildCritiquePrompt(debaterIndex: number, proposals: Proposal[]): string {
    const otherProposals = proposals.filter((_, i) => i !== debaterIndex);
    const proposalsSection = this.buildProposalsSection(otherProposals);
    const personaBlock = this.buildPersonaBlock(debaterIndex);

    // Issue 7: persona first, then task, then proposals.
    // taskContext owns the output format — do not append a contradictory prose directive.
    return `You are reviewing proposals for a ${this.stageContext.stage} task.${personaBlock}

## Task
${this.stageContext.taskContext}

## Other Agents' Proposals
${proposalsSection}`;
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

  // ─── Review-specific public methods ───────────────────────────────────────

  /** Standard (non-debate) review prompt. */
  buildReviewPrompt(diff: string, story: ReviewStoryContext): string {
    const criteria = story.acceptanceCriteria.map((c) => `- ${c}`).join("\n");
    return [
      `Review the following code diff for story ${story.id}: ${story.title}`,
      "",
      "## Acceptance Criteria",
      criteria,
      "",
      "## Diff",
      diff,
      "",
      "Also flag any changes in the diff not required by the acceptance criteria above as out-of-scope findings.",
      REVIEW_JSON_DIRECTIVE,
    ].join("\n");
  }

  /** Re-review prompt — references previous findings and updated diff. */
  buildReReviewPrompt(updatedDiff: string, previousFindings: ReviewFinding[]): string {
    const findingsList =
      previousFindings.length > 0 ? previousFindings.map((f) => `- ${f.ruleId}: ${f.message}`).join("\n") : "(none)";
    return [
      "This is a follow-up re-review. Please review the updated diff below.",
      "",
      "## Previous Findings",
      findingsList,
      "",
      "## Updated Diff",
      updatedDiff,
      "",
      RE_REVIEW_JSON_DIRECTIVE,
      "deltaSummary should describe which previous findings are resolved vs still present.",
    ].join("\n");
  }

  /** Debate resolver prompt — varies by resolver type. */
  buildResolverPrompt(
    proposals: Array<{ debater: string; output: string }>,
    critiques: string[],
    diffContext: DiffContext,
    story: ReviewStoryContext,
    resolverContext: DebateResolverContext,
  ): string {
    const criteria = story.acceptanceCriteria.map((c) => `- ${c}`).join("\n");
    const framing = this.buildResolverFraming(resolverContext);
    const voteTally = this.buildVoteTallyLine(resolverContext);
    const proposalsSection = this.buildLabeledProposalsSection(proposals);
    const critiquesSection = this.buildLabeledCritiquesSection(critiques);
    const diffSection = buildDebateDiffSection(diffContext);

    return [
      framing,
      "",
      `## Story ${story.id}: ${story.title}`,
      "",
      "## Acceptance Criteria",
      criteria,
      "",
      "## Debater Proposals",
      proposalsSection,
      critiquesSection,
      "",
      diffSection,
      voteTally,
      "",
      REVIEW_JSON_DIRECTIVE,
    ]
      .filter((line) => line !== undefined)
      .join("\n");
  }

  /** Debate re-review prompt — references previous findings + updated proposals. */
  buildReResolverPrompt(
    proposals: Array<{ debater: string; output: string }>,
    critiques: string[],
    diffContext: DiffContext,
    previousFindings: ReviewFinding[],
    resolverContext: DebateResolverContext,
  ): string {
    const framing = this.buildResolverFraming(resolverContext);
    const findingsList =
      previousFindings.length > 0 ? previousFindings.map((f) => `- ${f.ruleId}: ${f.message}`).join("\n") : "(none)";
    const proposalsSection = this.buildLabeledProposalsSection(proposals);
    const critiquesSection = this.buildLabeledCritiquesSection(critiques);
    const diffSection = buildDebateDiffSection(diffContext);

    return [
      `${framing} This is a re-review after implementer changes.`,
      "",
      "## Previous Findings",
      findingsList,
      "",
      "## Updated Debater Proposals",
      proposalsSection,
      critiquesSection,
      "",
      diffSection,
      "",
      RE_REVIEW_JSON_DIRECTIVE,
      "deltaSummary should describe which previous findings are resolved vs still present.",
    ]
      .filter((line) => line !== undefined)
      .join("\n");
  }

  // ─── Review-specific private helpers ──────────────────────────────────────

  private buildResolverFraming(ctx: DebateResolverContext): string {
    switch (ctx.resolverType) {
      case "majority-fail-closed":
      case "majority-fail-open":
        return "You are the authoritative reviewer resolving a debate. A preliminary vote was taken — see tally below. Verify disputed findings using tools (READ files, GREP for usage) and give your final verdict.";
      case "synthesis":
        return "You are a synthesis reviewer. Synthesize the debater proposals into a single, coherent, tool-verified verdict. Use READ and GREP to verify claims before ruling.";
      case "custom":
        return "You are the judge. Evaluate the debater proposals independently. Verify claims with tools (READ, GREP) and give your final authoritative verdict.";
      default:
        return "You are the reviewer. Evaluate the debater proposals and give your final authoritative verdict.";
    }
  }

  private buildVoteTallyLine(ctx: DebateResolverContext): string {
    if (!ctx.majorityVote) return "";
    const { passCount, failCount } = ctx.majorityVote;
    const failOpenNote =
      ctx.resolverType === "majority-fail-open"
        ? " (unparseable proposals count as pass)"
        : " (unparseable proposals count as fail)";
    return `\n\nThe preliminary majority vote is: **${passCount} passed, ${failCount} failed**${failOpenNote}. Verify the failing findings with tools before giving your authoritative verdict.`;
  }

  private buildLabeledProposalsSection(proposals: Array<{ debater: string; output: string }>): string {
    return proposals.map((p) => `### ${p.debater}\n\`\`\`json\n${p.output}\n\`\`\``).join("\n\n");
  }

  private buildLabeledCritiquesSection(critiques: string[]): string {
    if (critiques.length === 0) return "";
    return `\n\n## Critiques\n${critiques.map((c, i) => `### Critique ${i + 1}\n${c}`).join("\n\n")}`;
  }
}

// ─── Private helpers ─────────────────────────────────────────────────────────���

/**
 * Build the diff section for debate resolver prompts.
 * embedded mode: emits the diff block (same as original behaviour).
 * ref mode: emits stat summary + git ref + self-serve commands.
 */
function buildDebateDiffSection(ctx: DiffContext): string {
  if (ctx.mode === "ref") {
    // ref mode: reviewer self-serves the full diff via tools
    const stat = ctx.stat ?? "(no stat available)";
    const ref = ctx.storyGitRef;
    return [
      "## Changed Files",
      "```",
      stat,
      "```",
      "",
      `## Git Baseline: \`${ref}\``,
      "",
      "To inspect the implementation:",
      `- Full diff: \`git diff --unified=3 ${ref}..HEAD\``,
      `- Production diff: \`git diff --unified=3 ${ref}..HEAD -- . ':!test/' ':!tests/' ':!*.test.ts' ':!*.spec.ts' ':!.nax/' ':!.nax-pids'\``,
      `- Commit history: \`git log --oneline ${ref}..HEAD\``,
      "",
      "Use these commands to inspect the code. Do NOT rely solely on the file list above.",
    ].join("\n");
  }
  // embedded mode: emit the diff block
  return ["## Diff", ctx.diff].join("\n");
}
