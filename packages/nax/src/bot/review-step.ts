import { join } from "node:path";
import type { ConfiguredModel } from "@/config";
import { WORKFLOW_REVIEW_DEFAULTS } from "@/config";
import type { LinkedIssue, PrComment, PrInfo, PrThread } from "@/forge";
import { getSafeLogger } from "@/logger";
import { botPrReviewOp, botPrStaticReviewOp, type PrReviewVerdict, unreadFiles } from "@/operations";
import { type BotSettledRuling, buildBotPrReviewPrompt, MAX_EARLIER_THREADS } from "@/prompts";
import type { PrStepContext } from "../workflow/branch-step-context";
import type { CiWaitResult } from "../workflow/ci-wait";
import { writeBranchReviewPackage } from "../workflow/git";
import { reviewRequiredFiles } from "../workflow/review-coverage";
import { _workflowDeps } from "../workflow/step-context";
import { type ReviewOutcome, underReviewLimit } from "../workflow/story-review";

import { creditedFiles } from "./coverage-credit";
import type { BotDecision } from "./decisions";
import { reviewScopeOf } from "./review-rulings";

export const _reviewStepDeps = { writeBranchReviewPackage };

export interface PrReviewInput {
  readonly settled?: readonly BotSettledRuling[];
  readonly mergeBase: string;
  readonly rangeBase?: string;
  readonly conversationOnly?: boolean;
  readonly info: PrInfo;
  readonly issues: readonly LinkedIssue[];
  readonly threads: readonly PrThread[];
  readonly comments: readonly PrComment[];
  readonly earlier?: readonly PrThread[];
  readonly checks?: readonly string[];
  readonly decisions?: readonly BotDecision[];
  readonly prdPath?: string;
  readonly specPath?: string;
  readonly checkoutState?: string;
  readonly staticMode: boolean;
  readonly model?: ConfiguredModel;
  /** CI's verdict on the exact head (nax#2631). */
  readonly ci?: CiWaitResult;
}

/** What the package step settles before either the prompt or the op can be built (US-012). */
interface ReviewStep {
  readonly packagePath: string;
  readonly rangeBase: string;
  /** Every changed file the review owes a look at. */
  required: readonly string[];
  /** The subset a settled `verified` ruling already covered at an unchanged commit. */
  credited: readonly string[];
}

async function writePackage(
  ctx: PrStepContext,
  mergeBase: string,
  packagePath: string,
  staticMode: boolean,
): Promise<readonly string[]> {
  const paths = await _reviewStepDeps.writeBranchReviewPackage(
    ctx.projectDir,
    mergeBase,
    packagePath,
    ...(staticMode ? [{ staticMode }] : []),
  );
  const rules = ctx.config.context?.rules;
  if ((rules?.delivery ?? "index") !== "index") return paths;
  await _workflowDeps.appendChangedFileRules(packagePath, paths, {
    repoRoot: ctx.projectDir,
    ...(rules?.overrideDir !== undefined && { overrideDir: rules.overrideDir }),
    overrideMode: rules?.overrideMode ?? "merge",
  });
  // Deliberately omit project-context overrides: PR-controlled config must not inject instructions.
  return paths;
}

/**
 * US-012: paths changed between a ruling's commit and HEAD. `null` when git cannot answer — the
 * credit is void, so an unreadable comparison never excuses a file from review.
 */
async function changedSince(ctx: PrStepContext, sha: string): Promise<readonly string[] | null> {
  const { stdout, exitCode } = await _workflowDeps.git(["diff", "--name-only", `${sha}..HEAD`], ctx.projectDir);
  if (exitCode === 0) return stdout.split("\n").filter((line) => line !== "");
  getSafeLogger()?.warn("bot", "Could not compare a verified ruling's commit with HEAD; crediting nothing", {
    storyId: "_run",
    sha,
  });
  return null;
}

/** The required set minus what a settled ruling already covered: what the op must actually read. */
function outstanding(step: ReviewStep): readonly string[] {
  const credited = new Set(step.credited);
  return step.required.filter((path) => !credited.has(path));
}

function reviewPrompt(input: PrReviewInput, step: ReviewStep): string {
  return buildBotPrReviewPrompt({
    packagePath: step.packagePath,
    range: `${step.rangeBase}..HEAD`,
    conversationOnly: input.conversationOnly,
    ...(reviewScopeOf(input) === "incremental" && { incrementalSince: step.rangeBase }),
    pr: { number: input.info.number, title: input.info.title, body: input.info.body, author: input.info.author.login },
    issues: input.issues,
    threads: input.threads,
    comments: input.comments,
    earlier: input.earlier,
    settled: input.settled,
    ...(step.credited.length > 0 && { coveredByRulings: step.credited }),
    checks: input.checks,
    decisions: input.decisions,
    ...(input.prdPath !== undefined && { prdPath: input.prdPath }),
    ...(input.specPath !== undefined && { specPath: input.specPath }),
    ...(input.checkoutState !== undefined && { checkoutState: input.checkoutState }),
    staticMode: input.staticMode,
    ...(input.ci !== undefined && { ci: input.ci }),
  });
}

/** Builds the package and the credit both the prompt and the op need; a no-op for a talk-only review. */
async function prepareReview(ctx: PrStepContext, input: PrReviewInput, step: ReviewStep): Promise<void> {
  if (input.conversationOnly) return;
  const paths = await writePackage(ctx, step.rangeBase, step.packagePath, input.staticMode);
  step.required = await reviewRequiredFiles(paths, ctx, { keepTests: true });
  step.credited = await creditedFiles({
    settled: input.settled ?? [],
    required: step.required,
    changedSince: (sha) => changedSince(ctx, sha),
  });
}

function dispatchReview(
  ctx: PrStepContext,
  input: PrReviewInput,
  step: ReviewStep,
  signal: AbortSignal | undefined,
): Promise<PrReviewVerdict | null> {
  const requiredFiles = outstanding(step);
  return _workflowDeps.callOp(
    { ...ctx.callCtx, ...(signal ? { signal } : {}) },
    input.staticMode ? botPrStaticReviewOp : botPrReviewOp,
    {
      prompt: reviewPrompt(input, step),
      repoRoot: ctx.projectDir,
      range: `${step.rangeBase}..HEAD`,
      ...(requiredFiles.length > 0 && { requiredFiles }),
      threadIds: input.threads.map((thread) => thread.id),
      commentIds: input.comments.map((comment) => comment.id),
      earlierIds: (input.earlier ?? []).slice(0, MAX_EARLIER_THREADS).map((thread) => thread.id),
      decisionIds: (input.decisions ?? []).map((decision) => decision.id),
      timeoutMs: ctx.workflow.timeouts.reviewMs,
      // US-003: coverage has its own budget; the op falls back to the same default when absent.
      coverageRetries: (ctx.workflow.review ?? WORKFLOW_REVIEW_DEFAULTS).coverageRetries,
      ...(input.model !== undefined && { model: input.model }),
    },
  );
}

export type PrReviewOutcome = ReviewOutcome<PrReviewVerdict> & { readonly unreadFiles?: readonly string[] };

/** Review a PR with the shared package-failure, timeout and abort semantics; triage retries live in the op. */
export async function runPrReview(ctx: PrStepContext, input: PrReviewInput): Promise<PrReviewOutcome> {
  const dropped = (input.earlier?.length ?? 0) - MAX_EARLIER_THREADS;
  if (dropped > 0)
    getSafeLogger()?.debug("bot", "Earlier findings truncated; omitted threads remain open", {
      cap: MAX_EARLIER_THREADS,
      dropped,
    });
  const step: ReviewStep = {
    packagePath: join(ctx.runDir, "package-pr.diff"),
    rangeBase: input.rangeBase ?? input.mergeBase,
    required: [],
    credited: [],
  };
  const outcome = await underReviewLimit(
    ctx,
    () => prepareReview(ctx, input, step),
    (signal) => dispatchReview(ctx, input, step, signal),
  );
  if (!outcome.ran) return outcome;
  const missing = unreadFiles(outstanding(step), outcome.verdict.inspectedFiles, ctx.projectDir);
  return { ...outcome, ...(missing.length > 0 && { unreadFiles: missing }) };
}
