/** Repo-scoped trusted, exact-head fix orchestration with optional saved-commit reuse. */
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { resolveDefaultAgent } from "@/agents";
import type { ConfiguredModel } from "@/config";
import { NaxError } from "@/errors";
import { hasNaxWorkflowMarker, ownComments } from "@/forge";
import { getLogger } from "@/logger";
import { botChecksExtractOp } from "@/operations";
import { defineStepGraph, runStepGraph, type StepGraph } from "@/step-graph";
// Import lifecycle/workflow leaves, never their orchestration barrels.
import { runPreRunSteps } from "../execution/lifecycle/pre-run-steps";
import { botRunDir } from "../workflow/paths";
import { _workflowDeps } from "../workflow/step-context";
import { type BotChecks, resolveBotChecks } from "./checks";
import { botCostEnv } from "./cost";
import { checkPushAccess, loadLatestReview } from "./fix-input";
import { readyStep, replyStep, reportStep } from "./fix-report";
import {
  type BotFixEnv,
  type BotFixState,
  type BotFixStep,
  checkStep,
  fixStep,
  gatesStep,
  pushStep,
} from "./fix-steps";
import { botGit } from "./git";
import { type BotLog, openBotLog } from "./log";
import { repairStep } from "./repair-step";
import { _botReviewDeps } from "./review-run";
import { rulingModelReader } from "./ruling-reader";
import { recordPrRulings } from "./rulings";
import { clearSavedFix, persistSavedFix, readSavedFix, reuseSavedFix, saveFix } from "./saved-fix";

export const _botFixDeps = {
  gitToplevel: _botReviewDeps.gitToplevel,
  ensureProjectTrusted: _botReviewDeps.ensureProjectTrusted,
  forge: _botReviewDeps.forge,
  resolvePrRef: _botReviewDeps.resolvePrRef,
  readPrInfo: _botReviewDeps.readPrInfo,
  classifyPrTrust: _botReviewDeps.classifyPrTrust,
  preparePrCheckout: _botReviewDeps.preparePrCheckout,
  loadBotConfig: _botReviewDeps.loadBotConfig,
  createRuntime: _botReviewDeps.createRuntime,
  setupBotRuntime: _botReviewDeps.setupBotRuntime,
  openBotLog,
  buildPrStepContext: _botReviewDeps.buildPrStepContext,
  readCurrentUser: _botReviewDeps.readCurrentUser,
  listReviewThreads: _botReviewDeps.listReviewThreads,
  listPrComments: _botReviewDeps.listPrComments,
  randomSuffix: _botReviewDeps.randomSuffix,
  writeJson: _botReviewDeps.writeJson,
  fileExists: (path: string): Promise<boolean> => Bun.file(path).exists(),
  copyFile: async (from: string, to: string): Promise<void> => {
    await Bun.write(to, Bun.file(from));
  },
  loadLatestReview,
  savedFix: { read: readSavedFix, save: saveFix, clear: clearSavedFix },
  resolveBotChecks,
  checkPushAccess,
  runPreRunSteps,
  recordPrRulings,
  fixStep,
  repairStep,
  checkStep,
  gatesStep,
  pushStep,
  replyStep,
  readyStep,
  reportStep,
};

export interface BotFixInput {
  readonly inPlace?: boolean;
  readonly readyOnly?: boolean;
  readonly fresh?: boolean;
  readonly costLimitUsd?: number;
  readonly dir: string;
  readonly pr: number;
  readonly profiles: readonly string[];
  readonly model?: ConfiguredModel;
  readonly interactive: boolean;
}
export type BotFixResult = { readonly logPath?: string } & (
  | { readonly outcome: "refused"; readonly reason: string }
  | (BotFixState & {
      readonly outcome: NonNullable<BotFixState["outcome"]>;
      readonly spentUsd?: number;
      readonly limitUsd?: number;
    })
);

export const BOT_FIX_GRAPH: StepGraph<BotFixState, BotFixEnv, BotFixStep> = defineStepGraph({
  start: "fix",
  end: ["done"],
  costStopProduces: ["outcome", "costSpentUsd", "costLimitUsd"],
  costStop: async (node, _state, env) =>
    node === "fix" || node === "repair"
      ? {
          patch: { outcome: "cost-limit", costSpentUsd: env.cost.spentUsd(), costLimitUsd: env.cost.limitUsd },
          to: "report",
        }
      : undefined,
  nodes: {
    fix: {
      kind: "agent",
      commits: true,
      produces: ["agreedCount", "outcome", "fixFailure", "fixDirty", "fixSha"],
      exits: ["nothing", "ran"],
      transitions: [
        { on: "nothing", to: "ready" },
        { on: "ran", to: "check" },
      ],
      run: (env, state) => _botFixDeps.fixStep(env, state),
    },
    repair: {
      kind: "agent",
      commits: true,
      produces: [
        "gateRepairRounds",
        "repairMode",
        "outcome",
        "fixFailure",
        "fixDirty",
        "fixSha",
        "prepareTreeUnreadable",
      ],
      exits: ["ran", "out-of-scope"],
      transitions: [
        { on: "ran", to: "check" },
        { on: "out-of-scope", to: "report" },
      ],
      run: (env, state) => _botFixDeps.repairStep(env, state),
    },
    check: {
      kind: "git",
      produces: ["changed", "protectedFiles", "outcome", "recoveryPath"],
      exits: ["no-change", "protected", "changed", "dirty"],
      transitions: [{ on: "changed", to: "gates" }, { to: "report" }],
      run: (env, state) => _botFixDeps.checkStep(env, state),
    },
    gates: {
      kind: "gate",
      produces: [
        "outcome",
        "failingGates",
        "baselineFailing",
        "ciOutcome",
        "recoveryPath",
        "fixSha",
        "gateTails",
        "repairSkippedForCost",
      ],
      exits: ["no-gates", "failed", "passed", "dirty", "repair"],
      transitions: [{ on: "passed", to: "push" }, { on: "repair", to: "repair" }, { to: "report" }],
      run: (env, state) => _botFixDeps.gatesStep(env, state),
    },
    push: {
      kind: "git",
      produces: ["pushedSha", "outcome", "recoveryPath"],
      exits: ["rejected", "pushed", "dirty"],
      transitions: [{ on: "pushed", to: "reply" }, { to: "report" }],
      run: (env, state) => _botFixDeps.pushStep(env, state),
    },
    reply: {
      kind: "forge",
      needs: ["pushedSha"],
      produces: ["replied", "resolved"],
      exits: ["ready"],
      transitions: [{ to: "ready" }],
      run: (env, state) => _botFixDeps.replyStep(env, state),
    },
    ready: {
      kind: "forge",
      produces: ["markedReady", "readyHeld"],
      exits: ["report"],
      transitions: [{ to: "done", when: (state) => state.readyOnly === true }, { to: "report" }],
      run: (env, state) => _botFixDeps.readyStep(env, state),
    },
    report: {
      kind: "forge",
      needs: ["outcome"],
      produces: [],
      exits: ["done"],
      transitions: [{ to: "done" }],
      run: (env, state) => _botFixDeps.reportStep(env, state),
    },
  },
});

type PreparedFix = Pick<BotFixEnv, "repoRoot" | "ref" | "info" | "checkout">;

async function triage(
  prepared: PreparedFix,
): Promise<
  Pick<BotFixEnv, "user" | "threads" | "own"> & { comments: Awaited<ReturnType<typeof _botFixDeps.listPrComments>> }
> {
  const deps = _botFixDeps;
  const { ref, repoRoot } = prepared;
  const [user, threads, comments] = await Promise.all([
    deps.readCurrentUser(ref, deps.forge, repoRoot),
    deps.listReviewThreads(ref, deps.forge, repoRoot),
    deps.listPrComments(ref, deps.forge, repoRoot),
  ]);
  const own = [
    ...threads.flatMap((thread) => ownComments(thread.comments, user.login, thread.id)),
    ...ownComments(comments, user.login),
  ];
  return { user, threads, own, comments };
}

async function recordFixRulings(
  env: BotFixEnv,
  comments: Awaited<ReturnType<typeof _botFixDeps.listPrComments>>,
): Promise<void> {
  if (!hasNaxWorkflowMarker(env.info.body)) return;
  try {
    await _botFixDeps.recordPrRulings({
      ref: env.ref,
      info: env.info,
      login: env.user.login,
      threads: env.threads,
      comments,
      deps: env.forge,
      cwd: env.repoRoot,
      readModel: rulingModelReader(env.ctx, env.config),
    });
  } catch (error) {
    getLogger()?.warn("bot-fix", "Could not record PR rulings", { pr: env.ref.number, error: errorMessage(error) });
  }
}

async function initialFixState(env: BotFixEnv, outputDir: string, input: BotFixInput): Promise<BotFixState> {
  if (input.readyOnly) return { step: "ready", timings: {}, readyOnly: true, outcome: "ready-pass" };
  let initial = await reuseSavedFix({ env, outputDir, fresh: input.fresh, savedFix: _botFixDeps.savedFix });
  try {
    await _botFixDeps.runPreRunSteps({ steps: env.checks.preRun, workdir: env.checkout.worktree });
  } catch (error) {
    if (!(error instanceof NaxError) || error.code !== "PRE_RUN_FAILED") throw error;
    const setupFailed = typeof error.context?.command === "string" ? error.context.command : "unknown";
    getLogger()?.warn("bot-fix", "Fix setup failed", {
      pr: env.ref.number,
      command: setupFailed,
      error: errorMessage(error),
    });
    initial = { step: "report", timings: {}, outcome: "setup-failed", setupFailed };
  }
  return initial;
}

async function executeFix(
  env: BotFixEnv,
  runtime: ReturnType<typeof _botFixDeps.createRuntime>,
  input: BotFixInput,
): Promise<BotFixResult> {
  const initial = await initialFixState(env, runtime.outputDir, input);
  const stateDir = botRunDir(runtime.outputDir, env.ref.number, runtime.runId);
  const state = await runStepGraph(
    BOT_FIX_GRAPH,
    env,
    initial,
    { persist: (value) => _botFixDeps.writeJson(join(stateDir, "bot-state.json"), value) },
    {
      aborted: () => runtime.signal.aborted,
      now: () => Date.now(),
      costExceeded: () => env.cost.spentUsd() >= env.cost.limitUsd,
    },
  );
  if (!state.outcome)
    throw new NaxError("[bot-fix] Missing graph outcome", "BOT_FIX_OUTCOME_MISSING", { stage: "bot-fix" });
  return { ...state, outcome: state.outcome, spentUsd: env.cost.spentUsd(), limitUsd: env.cost.limitUsd };
}

const SHORT_SHA_LENGTH = 7;

async function fixChecks(
  env: Pick<BotFixEnv, "repoRoot" | "checkout" | "config" | "ctx" | "review">,
): Promise<BotChecks> {
  const { repoRoot, checkout, config, ctx, review } = env;
  // Saved checks belong to this reviewed head, even if the base has since moved.
  if (review.version >= 2 && review.checks != null) return review.checks;
  return _botFixDeps.resolveBotChecks({
    repoRoot,
    baseSha: checkout.baseSha,
    snapshotDir: checkout.snapshotDir,
    hasBaseNax: checkout.hasBaseNax,
    config,
    extract: (input) =>
      _workflowDeps.callOp(ctx.callCtx, botChecksExtractOp, {
        ...input,
        model: config.bot?.models.checks,
      }),
  });
}

function finishFix(result: BotFixResult, log: BotLog): BotFixResult {
  getLogger().info("bot", "Bot fix finished", {
    outcome: result.outcome,
    ...(result.outcome === "refused" ? { reason: result.reason } : {}),
  });
  return log.path === undefined ? result : { ...result, logPath: log.path };
}

async function preserveFixReport(reportPath: string, stateDir: string): Promise<void> {
  try {
    if (!(await _botFixDeps.fileExists(reportPath))) return;
    await _botFixDeps.copyFile(reportPath, join(stateDir, "fix-report.md"));
  } catch (error) {
    getLogger()?.warn("bot-fix", "Could not preserve fix session report", {
      reportPath,
      stateDir,
      error: errorMessage(error),
    });
  }
}

async function fixCheckout(input: BotFixInput, prepared: PreparedFix): Promise<BotFixResult> {
  const deps = _botFixDeps;
  const { repoRoot, ref, info, checkout } = prepared;
  const config = await deps.loadBotConfig({ snapshotDir: checkout.snapshotDir, profiles: input.profiles });
  const runtime = deps.createRuntime(config, repoRoot);
  const stateDir = botRunDir(runtime.outputDir, ref.number, runtime.runId);
  let log: BotLog | undefined;
  let context: Awaited<ReturnType<typeof deps.buildPrStepContext>> | undefined;
  try {
    log = deps.openBotLog(join(stateDir, "bot.jsonl"));
    await deps.setupBotRuntime(runtime, config, checkout.worktree);
    getLogger().info("bot", "Bot fix started", { pr: ref.number, headSha: info.headSha });
    context = await deps.buildPrStepContext({
      runtime,
      config,
      repoRoot: checkout.worktree,
      agentName: resolveDefaultAgent(config),
      pr: { forge: ref.forge, number: ref.number, base: checkout.mergeBase, head: info.headSha },
    });
    const review = await deps.loadLatestReview(runtime.outputDir, ref.number, info.headSha);
    if (!review)
      return finishFix(
        {
          outcome: "refused",
          reason: `no nax bot review of head ${info.headSha.slice(0, SHORT_SHA_LENGTH)}; run nax bot review ${ref.number} first`,
        },
        log,
      );
    if (!input.readyOnly) {
      const access = await deps.checkPushAccess(checkout.worktree, info.headRef);
      if (!access.ok)
        return finishFix({ outcome: "refused", reason: `cannot push to ${info.headRef}: ${access.reason}` }, log);
    }
    const checks = await fixChecks({ ...prepared, ctx: context.ctx, config, review });
    if (checks.source === "none")
      return finishFix(
        {
          outcome: "refused",
          reason:
            "no check commands found on the base branch; add quality.commands to .nax/config.json, or list the commands in AGENTS.md or CLAUDE.md, then merge it",
        },
        log,
      );
    const items = await triage(prepared);
    const env: BotFixEnv = {
      ...prepared,
      ...items,
      checks,
      ctx: { ...context.ctx, runGit: botGit },
      config,
      review,
      model: input.model,
      forge: deps.forge,
      cost: botCostEnv(config, runtime, input.costLimitUsd),
    };
    await recordFixRulings(env, items.comments);
    try {
      const result = await executeFix(env, runtime, input);
      if (!input.readyOnly && result.outcome !== "refused")
        await persistSavedFix({ env, state: result, outputDir: runtime.outputDir, savedFix: deps.savedFix });
      return finishFix(result, log);
    } finally {
      await preserveFixReport(env.ctx.reportPath, stateDir);
    }
  } finally {
    try {
      await context?.dispose();
    } finally {
      try {
        await log?.close();
      } finally {
        await runtime.close();
      }
    }
  }
}

export async function runBotFix(input: BotFixInput): Promise<BotFixResult> {
  const deps = _botFixDeps;
  const repoRoot = await deps.gitToplevel(input.dir);
  await deps.ensureProjectTrusted(repoRoot, { interactive: input.interactive });
  const ref = await deps.resolvePrRef(input.pr, deps.forge, repoRoot);
  const info = await deps.readPrInfo(ref, deps.forge, repoRoot);
  if (info.state !== "open") return { outcome: "refused", reason: `PR #${ref.number} is ${info.state}` };
  if (info.crossRepo)
    return { outcome: "refused", reason: "head branch is in another repository; nax bot fix cannot push to it" };
  const trust = await deps.classifyPrTrust(ref, info, deps.forge, repoRoot);
  if (!trust.trusted) return { outcome: "refused", reason: `untrusted PR: ${trust.reasons.join("; ")}` };
  const checkout = await deps.preparePrCheckout({
    repoRoot,
    ref,
    info,
    suffix: deps.randomSuffix(),
    pinBaseFiles: false,
  });
  try {
    return await fixCheckout(input, { repoRoot, ref, info, checkout });
  } finally {
    await checkout.dispose();
  }
}
