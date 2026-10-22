/** Repo-scoped, bounded post-push review and readiness cycle. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { DEFAULT_CONFIG } from "@/config";
import { NaxError } from "@/errors";
import type { PrRef } from "@/forge";
import { getLogger } from "@/logger";
import { botCostLimit } from "./cost";
import { _botFixDeps, type BotFixInput, type BotFixResult, runBotFix } from "./fix-run";
import { type BotReviewResult, runBotReview } from "./review-run";

export const PR_HEAD_POLL_MS = 5_000;
export const PR_HEAD_WAIT_MS = 60_000;
const SHORT_SHA_LENGTH = 7;

export const _fixCycleDeps = {
  readPrInfo: _botFixDeps.readPrInfo,
  forge: _botFixDeps.forge,
  sleep: (ms: number): Promise<void> => Bun.sleep(ms),
  now: () => Date.now(),
  runBotFix,
  runBotReview,
  gitToplevel: _botFixDeps.gitToplevel,
  resolvePrRef: _botFixDeps.resolvePrRef,
  waitForPrHead,
};

export async function waitForPrHead(
  input: { ref: PrRef; repoRoot: string; sha: string },
  deps = _fixCycleDeps,
): Promise<boolean> {
  const deadline = deps.now() + PR_HEAD_WAIT_MS;
  while (true) {
    try {
      const info = await deps.readPrInfo(input.ref, deps.forge, input.repoRoot);
      if (info.headSha === input.sha) return true;
    } catch (error) {
      getLogger()?.warn("bot-fix", "Could not read PR head; retrying within poll window", {
        pr: input.ref.number,
        error: errorMessage(error),
      });
    }
    const remaining = deadline - deps.now();
    if (remaining <= 0) return false;
    await deps.sleep(Math.min(PR_HEAD_POLL_MS, remaining));
  }
}

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
    const review = await deps.runBotReview({ ...input, costLimitUsd: remaining });
    if (review.outcome !== "posted") return { fix, review };
    const ready = await deps.runBotFix({ ...input, readyOnly: true, costLimitUsd: remaining - (review.spentUsd ?? 0) });
    return { fix, review, ready };
  } catch (error) {
    return { fix, skipped: errorMessage(error) };
  }
}
