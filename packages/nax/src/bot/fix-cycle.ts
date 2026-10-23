/** Repo-scoped, bounded post-push review and readiness cycle. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { DEFAULT_CONFIG } from "@/config";
import { NaxError } from "@/errors";
import { botCostLimit } from "./cost";
import { _botFixDeps, type BotFixInput, type BotFixResult, runBotFix } from "./fix-run";
import { _prHeadWaitDeps, PR_HEAD_WAIT_MS, waitForPrHead } from "./pr-head-wait";
import { type BotReviewResult, runBotReview } from "./review-run";

export { PR_HEAD_POLL_MS, PR_HEAD_WAIT_MS, waitForPrHead } from "./pr-head-wait";

const SHORT_SHA_LENGTH = 7;

export const _fixCycleDeps = {
  ..._prHeadWaitDeps,
  runBotFix,
  runBotReview,
  gitToplevel: _botFixDeps.gitToplevel,
  resolvePrRef: _botFixDeps.resolvePrRef,
  waitForPrHead,
};

export interface BotFixCycleResult {
  readonly fix: BotFixResult;
  readonly review?: BotReviewResult;
  readonly ready?: BotFixResult;
  readonly skipped?: string;
}

export async function runBotFixCycle(
  input: BotFixInput & { readonly rereview: boolean },
  deps = _fixCycleDeps,
): Promise<BotFixCycleResult> {
  const fix = await deps.runBotFix(input);
  if (fix.outcome !== "pushed" || !input.rereview) return { fix };
  let review: BotReviewResult | undefined;
  try {
    if (!fix.pushedSha)
      throw new NaxError("[bot-fix] Pushed result is missing pushedSha", "BOT_PUSH_SHA_MISSING", { stage: "bot-fix" });
    const repoRoot = await deps.gitToplevel(input.dir);
    const ref = await deps.resolvePrRef(input.pr, deps.forge, repoRoot);
    const sha = fix.pushedSha;
    if (!(await deps.waitForPrHead({ ref, repoRoot, sha }, deps)))
      return {
        fix,
        skipped: `PR head did not reach ${sha.slice(0, SHORT_SHA_LENGTH)} within ${PR_HEAD_WAIT_MS / 1_000} s; run nax bot review ${ref.number}`,
      };
    const remaining = (input.costLimitUsd ?? fix.limitUsd ?? botCostLimit(DEFAULT_CONFIG)) - (fix.spentUsd ?? 0);
    if (remaining <= 0) return { fix, skipped: `cost limit reached; run nax bot review ${ref.number}` };
    review = await deps.runBotReview({ ...input, costLimitUsd: remaining });
    if (review.outcome !== "posted") return { fix, review };
    const readyBudget = remaining - (review.spentUsd ?? 0);
    // Exhaustion is an expected internal boundary, not an invalid external limit.
    if (readyBudget <= 0)
      return { fix, review, skipped: `cost limit reached; readiness skipped; run nax bot fix ${ref.number}` };
    const ready = await deps.runBotFix({ ...input, readyOnly: true, costLimitUsd: readyBudget });
    return { fix, review, ready };
  } catch (error) {
    return { fix, ...(review ? { review } : {}), skipped: errorMessage(error) };
  }
}
