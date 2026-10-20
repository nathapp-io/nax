import { join } from "node:path";
import type { ConfiguredModel } from "@/config";
import type { LinkedIssue, PrComment, PrInfo, PrThread } from "@/forge";
import { botPrReviewOp, botPrStaticReviewOp, type PrReviewVerdict } from "@/operations";
import { buildBotPrReviewPrompt } from "@/prompts";
import type { PrStepContext } from "../workflow/branch-step-context";
import { writeBranchReviewPackage } from "../workflow/git";
import { _workflowDeps } from "../workflow/step-context";
import { type ReviewOutcome, underReviewLimit } from "../workflow/story-review";

export const _reviewStepDeps = { writeBranchReviewPackage };

export interface PrReviewInput {
  readonly mergeBase: string;
  readonly info: PrInfo;
  readonly issues: readonly LinkedIssue[];
  readonly threads: readonly PrThread[];
  readonly comments: readonly PrComment[];
  readonly prdPath?: string;
  readonly staticMode: boolean;
  readonly model?: ConfiguredModel;
}

async function writePackage(ctx: PrStepContext, mergeBase: string, packagePath: string): Promise<void> {
  const paths = await _reviewStepDeps.writeBranchReviewPackage(ctx.projectDir, mergeBase, packagePath);
  const rules = ctx.config.context?.rules;
  if ((rules?.delivery ?? "index") !== "index") return;
  await _workflowDeps.appendChangedFileRules(packagePath, paths, {
    repoRoot: ctx.projectDir,
    ...(rules?.overrideDir !== undefined && { overrideDir: rules.overrideDir }),
    overrideMode: rules?.overrideMode ?? "merge",
  });
  // Deliberately omit project-context overrides: PR-controlled config must not inject instructions.
}

/** Review a PR with the shared package-failure, timeout and abort semantics; triage retries live in the op. */
export async function runPrReview(ctx: PrStepContext, input: PrReviewInput): Promise<ReviewOutcome<PrReviewVerdict>> {
  const packagePath = join(ctx.runDir, "package-pr.diff");
  const prompt = buildBotPrReviewPrompt({
    packagePath,
    range: `${input.mergeBase}..HEAD`,
    pr: { number: input.info.number, title: input.info.title, body: input.info.body, author: input.info.author.login },
    issues: input.issues,
    threads: input.threads,
    comments: input.comments,
    ...(input.prdPath !== undefined && { prdPath: input.prdPath }),
    staticMode: input.staticMode,
  });
  return underReviewLimit(
    ctx,
    () => writePackage(ctx, input.mergeBase, packagePath),
    (signal) =>
      _workflowDeps.callOp(
        { ...ctx.callCtx, ...(signal ? { signal } : {}) },
        input.staticMode ? botPrStaticReviewOp : botPrReviewOp,
        {
          prompt,
          threadIds: input.threads.map((thread) => thread.id),
          commentIds: input.comments.map((comment) => comment.id),
          timeoutMs: ctx.workflow.timeouts.reviewMs,
          ...(input.model !== undefined && { model: input.model }),
        },
      ),
  );
}
