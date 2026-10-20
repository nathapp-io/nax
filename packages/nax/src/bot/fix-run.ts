/** Repo-scoped trusted, exact-head fix orchestration. Every invocation is fresh. */
import { join } from "node:path";
import { resolveDefaultAgent } from "@/agents";
import type { ConfiguredModel } from "@/config";
import { NaxError } from "@/errors";
import { ownComments } from "@/forge";
import { defineStepGraph, runStepGraph, type StepGraph } from "@/step-graph";
// Import lifecycle/workflow leaves, never their orchestration barrels.
import { runPreRunSteps } from "../execution/lifecycle/pre-run-steps";
import { botRunDir } from "../workflow/paths";
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
import { _botReviewDeps } from "./review-run";

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
  buildPrStepContext: _botReviewDeps.buildPrStepContext,
  readCurrentUser: _botReviewDeps.readCurrentUser,
  listReviewThreads: _botReviewDeps.listReviewThreads,
  listPrComments: _botReviewDeps.listPrComments,
  randomSuffix: _botReviewDeps.randomSuffix,
  writeJson: _botReviewDeps.writeJson,
  loadLatestReview,
  checkPushAccess,
  runPreRunSteps,
  fixStep,
  checkStep,
  gatesStep,
  pushStep,
  replyStep,
  readyStep,
  reportStep,
};

interface BotFixInput {
  readonly dir: string;
  readonly pr: number;
  readonly profiles: readonly string[];
  readonly model?: ConfiguredModel;
  readonly interactive: boolean;
}
export type BotFixResult =
  | { readonly outcome: "refused"; readonly reason: string }
  | (BotFixState & { readonly outcome: NonNullable<BotFixState["outcome"]> });

export const BOT_FIX_GRAPH: StepGraph<BotFixState, BotFixEnv, BotFixStep> = defineStepGraph({
  start: "fix",
  end: ["done"],
  costStopProduces: [],
  costStop: async () => undefined,
  nodes: {
    fix: {
      kind: "agent",
      commits: true,
      produces: ["agreedCount", "outcome", "fixFailure", "fixDirty"],
      exits: ["nothing", "ran"],
      transitions: [
        { on: "nothing", to: "ready" },
        { on: "ran", to: "check" },
      ],
      run: (env, state) => _botFixDeps.fixStep(env, state),
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
      produces: ["outcome", "failingGates", "recoveryPath"],
      exits: ["no-gates", "failed", "passed", "dirty"],
      transitions: [{ on: "passed", to: "push" }, { to: "report" }],
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
      produces: ["markedReady"],
      exits: ["report"],
      transitions: [{ to: "report" }],
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

async function triage(prepared: PreparedFix): Promise<Pick<BotFixEnv, "user" | "threads" | "own">> {
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
  return { user, threads, own };
}

async function executeFix(
  env: BotFixEnv,
  runtime: ReturnType<typeof _botFixDeps.createRuntime>,
): Promise<BotFixResult> {
  await _botFixDeps.runPreRunSteps({ steps: env.config.execution.preRun ?? [], workdir: env.checkout.worktree });
  const stateDir = botRunDir(runtime.outputDir, env.ref.number, runtime.runId);
  const state = await runStepGraph(
    BOT_FIX_GRAPH,
    env,
    { step: "fix", timings: {} },
    { persist: (value) => _botFixDeps.writeJson(join(stateDir, "bot-state.json"), value) },
    { aborted: () => runtime.signal.aborted, now: () => Date.now() },
  );
  if (!state.outcome)
    throw new NaxError("[bot-fix] Missing graph outcome", "BOT_FIX_OUTCOME_MISSING", { stage: "bot-fix" });
  return { ...state, outcome: state.outcome };
}

const SHORT_SHA_LENGTH = 7;

async function fixCheckout(input: BotFixInput, prepared: PreparedFix): Promise<BotFixResult> {
  const deps = _botFixDeps;
  const { repoRoot, ref, info, checkout } = prepared;
  const config = await deps.loadBotConfig({ snapshotDir: checkout.snapshotDir, profiles: input.profiles });
  const runtime = deps.createRuntime(config, repoRoot);
  let context: Awaited<ReturnType<typeof deps.buildPrStepContext>> | undefined;
  try {
    context = await deps.buildPrStepContext({
      runtime,
      config,
      repoRoot: checkout.worktree,
      agentName: resolveDefaultAgent(config),
      pr: { forge: ref.forge, number: ref.number, base: checkout.mergeBase, head: info.headSha },
    });
    const review = await deps.loadLatestReview(runtime.outputDir, ref.number, info.headSha);
    if (!review)
      return {
        outcome: "refused",
        reason: `no nax bot review of head ${info.headSha.slice(0, SHORT_SHA_LENGTH)}; run nax bot review ${ref.number} first`,
      };
    const access = await deps.checkPushAccess(checkout.worktree, info.headRef);
    if (!access.ok) return { outcome: "refused", reason: `cannot push to ${info.headRef}: ${access.reason}` };
    const items = await triage(prepared);
    return await executeFix(
      { ...prepared, ...items, ctx: context.ctx, config, review, model: input.model, forge: deps.forge },
      runtime,
    );
  } finally {
    try {
      await context?.dispose();
    } finally {
      await runtime.close();
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
    if (!checkout.hasBaseNax)
      return { outcome: "refused", reason: "the base branch has no nax config; gates cannot run" };
    return await fixCheckout(input, { repoRoot, ref, info, checkout });
  } finally {
    await checkout.dispose();
  }
}
