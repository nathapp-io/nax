/**
 * dialogue-prompts.ts
 *
 * Prompt builders for ReviewerSession — extracted from dialogue.ts to keep
 * that file under the 400-line limit.
 *
 * Covers:
 * - Standard review / re-review prompts (single-reviewer path)
 * - Debate resolver prompts (debate + dialogue path, US-001)
 */

import type { ResolverType } from "../debate/types";
import type { ReviewFinding } from "../plugins/types";
import type { SemanticStory } from "./semantic";
import type { SemanticReviewConfig } from "./types";

/** Context passed to resolveDebate() — varies by resolver type */
export interface DebateResolverContext {
  resolverType: ResolverType;
  /** For majority resolvers: the raw vote tally (computed before resolveDebate is called) */
  majorityVote?: { passed: boolean; passCount: number; failCount: number };
}

// ─── Standard (non-debate) prompts ──────────────────────────────────────────

export function buildReviewPrompt(diff: string, story: SemanticStory, _semanticConfig: SemanticReviewConfig): string {
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
    "Respond with JSON: { passed: boolean, findings: [...], findingReasoning: { [id]: string } }",
  ].join("\n");
}

export function buildReReviewPrompt(updatedDiff: string, previousFindings: ReviewFinding[]): string {
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
    "Respond with JSON: { passed: boolean, findings: [...], findingReasoning: { [id]: string }, deltaSummary: string }",
    "deltaSummary should describe which previous findings are resolved vs still present.",
  ].join("\n");
}

// ─── Debate resolver prompts ─────────────────────────────────────────────────

function buildProposalsSection(proposals: Array<{ debater: string; output: string }>): string {
  return proposals.map((p) => `### ${p.debater}\n${p.output}`).join("\n\n");
}

function buildCritiquesSection(critiques: string[]): string {
  if (critiques.length === 0) return "";
  return `\n\n## Critiques\n${critiques.map((c, i) => `### Critique ${i + 1}\n${c}`).join("\n\n")}`;
}

function buildVoteTallyLine(ctx: DebateResolverContext): string {
  if (!ctx.majorityVote) return "";
  const { passCount, failCount } = ctx.majorityVote;
  const failOpenNote =
    ctx.resolverType === "majority-fail-open"
      ? " (unparseable proposals count as pass)"
      : " (unparseable proposals count as fail)";
  return `\n\nThe preliminary majority vote is: **${passCount} passed, ${failCount} failed**${failOpenNote}. Verify the failing findings with tools before giving your authoritative verdict.`;
}

function buildResolverFraming(ctx: DebateResolverContext): string {
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

/**
 * Build a prompt for resolveDebate() — prompt strategy varies by resolver type.
 */
export function buildDebateResolverPrompt(
  proposals: Array<{ debater: string; output: string }>,
  critiques: string[],
  diff: string,
  story: SemanticStory,
  _semanticConfig: SemanticReviewConfig,
  resolverContext: DebateResolverContext,
): string {
  const criteria = story.acceptanceCriteria.map((c) => `- ${c}`).join("\n");
  const framing = buildResolverFraming(resolverContext);
  const voteTally = buildVoteTallyLine(resolverContext);
  const proposalsSection = buildProposalsSection(proposals);
  const critiquesSection = buildCritiquesSection(critiques);

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
    "## Diff",
    diff,
    voteTally,
    "",
    "Respond with JSON: { passed: boolean, findings: [...], findingReasoning: { [id]: string } }",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

/**
 * Build a prompt for reReviewDebate() — references previous findings.
 */
export function buildDebateReReviewPrompt(
  proposals: Array<{ debater: string; output: string }>,
  critiques: string[],
  updatedDiff: string,
  previousFindings: ReviewFinding[],
  resolverContext: DebateResolverContext,
): string {
  const framing = buildResolverFraming(resolverContext);
  const findingsList =
    previousFindings.length > 0 ? previousFindings.map((f) => `- ${f.ruleId}: ${f.message}`).join("\n") : "(none)";
  const proposalsSection = buildProposalsSection(proposals);
  const critiquesSection = buildCritiquesSection(critiques);

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
    "## Updated Diff",
    updatedDiff,
    "",
    "Respond with JSON: { passed: boolean, findings: [...], findingReasoning: { [id]: string }, deltaSummary: string }",
    "deltaSummary should describe which previous findings are resolved vs still present.",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}
