import { randomBytes } from "node:crypto";
import { NaxError } from "@/errors";
import {
  classifyPrTrust,
  defaultForgeDeps,
  hasWriteAccess,
  listPrComments,
  listReviewThreads,
  readCurrentUser,
  readLinkedIssues,
  readPrInfo,
  resolvePrRef,
} from "@/forge";
import { createRuntime } from "@/runtime";
import { ensureProjectTrusted } from "@/trust";
import { runPreRunSteps } from "../execution/lifecycle/pre-run-steps";
import { buildPrStepContext } from "../workflow/pr-step-context";
import { loadBotConfig } from "./base-config";
import { preparePrCheckout } from "./checkout";
import { prepareInPlaceCheckout } from "./checkout-in-place";
import { resolveBotChecks } from "./checks";
import { recordFindingRulings } from "./finding-rulings";
import { readHeadCi } from "./gate-baseline";
import { botGit } from "./git";
import { openBotLog } from "./log";
import { postPrReview } from "./post";
import { runPrReview } from "./review-step";
import { recordPrRulings } from "./rulings";
import { setupBotRuntime } from "./run-setup";

export const _botReviewDeps = {
  runGit: botGit,
  async isAncestor(dir: string, ancestor: string, head: string): Promise<boolean> {
    const result = await _botReviewDeps.runGit(["merge-base", "--is-ancestor", ancestor, head], dir);
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new NaxError("[bot] Cannot check reviewed ancestry", "BOT_ANCESTRY_FAILED", {
      stage: "bot",
      dir,
      ancestor,
      head,
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  },
  async gitToplevel(dir: string): Promise<string> {
    const result = await _botReviewDeps.runGit(["rev-parse", "--show-toplevel"], dir);
    if (result.exitCode !== 0)
      throw new NaxError("[bot] Cannot resolve repository root", "BOT_REPO_ROOT_FAILED", {
        stage: "bot",
        dir,
        stderr: result.stderr,
      });
    return result.stdout.trim();
  },
  ensureProjectTrusted,
  forge: defaultForgeDeps,
  resolvePrRef,
  readPrInfo,
  classifyPrTrust,
  readCurrentUser,
  hasWriteAccess,
  listReviewThreads,
  listPrComments,
  readLinkedIssues,
  readHeadCi,
  preparePrCheckout,
  prepareInPlaceCheckout,
  loadBotConfig,
  createRuntime,
  setupBotRuntime,
  openBotLog,
  buildPrStepContext,
  resolveBotChecks,
  runPreRunSteps,
  runPrReview,
  recordPrRulings,
  recordFindingRulings,
  postPrReview,
  async writeJson(path: string, value: unknown): Promise<void> {
    await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
  },
  randomSuffix: (): string => randomBytes(4).toString("hex"),
};
