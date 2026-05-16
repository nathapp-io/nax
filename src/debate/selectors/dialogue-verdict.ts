/**
 * Dialogue-Verdict Selector Strategy
 *
 * Extracted from session-helpers.ts resolveOutcome() dialogue path.
 * Dispatches to ReviewerSession.resolveDebate() or reReviewDebate() based on context,
 * with majority-vote pre-computation for majority-fail-closed/fail-open resolvers.
 */

import type { ReviewDialogueResult } from "@/review/dialogue";
import type { DiffContext } from "@/review/types";
import { tryParseLLMJson } from "@/utils/llm-json";
import { majorityResolver } from "../resolvers";
import { pickBaseSelectorKind } from "./pick";
import { resolveSelector } from "./registry";
import type { Selector, SelectorContext, SelectorResult } from "./types";

export const dialogueVerdictSelector: Selector = async (ctx: SelectorContext): Promise<SelectorResult> => {
  // When reviewerSession and resolverContextInput are both present,
  // delegate to the session for tool-verified verdict
  if (ctx.reviewerSession && ctx.resolverContextInput) {
    try {
      const debateCtx: import("../types").DebateResolverContext = {
        resolverType: ctx.stageConfig.resolver.type,
      };

      // For majority resolvers: compute raw vote + tally first, pass as context
      if (
        ctx.stageConfig.resolver.type === "majority-fail-closed" ||
        ctx.stageConfig.resolver.type === "majority-fail-open"
      ) {
        const failOpen = ctx.stageConfig.resolver.type === "majority-fail-open";
        const rawOutcome = majorityResolver(
          ctx.proposals.map((p) => p.output),
          failOpen,
        );
        let passCount = 0;
        let failCount = 0;
        for (const proposal of ctx.proposals) {
          const parsed = tryParseLLMJson<Record<string, unknown>>(proposal.output);
          if (parsed !== null && typeof parsed.passed === "boolean" && parsed.passed) {
            passCount++;
          } else if (failOpen) {
            passCount++;
          } else {
            failCount++;
          }
        }
        debateCtx.majorityVote = { passed: rawOutcome === "passed", passCount, failCount };
      }

      const story = {
        id: ctx.resolverContextInput.story.id,
        title: ctx.resolverContextInput.story.title,
        description: "",
        acceptanceCriteria: ctx.resolverContextInput.story.acceptanceCriteria,
      };

      // Build diffContext from resolverContext — discriminated on diffMode
      const rcRecord = ctx.resolverContextInput as Record<string, unknown>;
      const diffContext: DiffContext =
        ctx.resolverContextInput.diffMode === "ref"
          ? {
              mode: "ref",
              storyGitRef: (rcRecord.storyGitRef as string) ?? "",
              stat: (rcRecord.stat as string) ?? undefined,
              productionExcludePatterns: rcRecord.productionExcludePatterns as readonly string[] | undefined,
            }
          : { mode: "embedded", diff: (rcRecord.diff as string) ?? "" };

      const labeledProposals =
        ctx.labeledProposals ??
        ctx.proposals.map((p) => ({
          debater: p.debater.agent,
          output: p.output,
        }));

      let dialogueResult: ReviewDialogueResult;
      if (ctx.resolverContextInput.isReReview) {
        dialogueResult = await ctx.reviewerSession.reReviewDebate(
          labeledProposals,
          ctx.critiques,
          diffContext,
          debateCtx,
        );
      } else {
        dialogueResult = await ctx.reviewerSession.resolveDebate(
          labeledProposals,
          ctx.critiques,
          diffContext,
          story,
          ctx.resolverContextInput.semanticConfig,
          debateCtx,
        );
      }

      const outcome = dialogueResult.checkResult.success ? "passed" : "failed";
      return {
        outcome,
        findings: dialogueResult.checkResult.findings,
        dialogueResult,
      };
    } catch {
      // Fall through to stateless resolver
    }
  }

  // When session or context is undefined, fall back to base selector
  const baseKind = pickBaseSelectorKind(ctx.stageConfig);

  // Invoke the base selector
  const baseSelector = resolveSelector(baseKind);
  return baseSelector(ctx);
};
