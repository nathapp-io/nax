import { join } from "node:path";
import { resolveDefaultAgent } from "@/agents";
import { type ConfiguredModel, DEFAULT_SANDBOX_CONFIG, type NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import { ownComments, type PrComment, parseNaxBotMarker } from "@/forge";
import { getLogger } from "@/logger";
import { botChecksExtractOp, type PrReviewVerdict } from "@/operations";
import { renderCheckoutState } from "@/prompts";
import type { createRuntime } from "@/runtime";
import { defineStepGraph, type GraphState, runStepGraph, type StepGraph } from "@/step-graph";
import type { PrStepContext } from "../workflow/branch-step-context";
import type { CiWaitResult } from "../workflow/ci-wait";
import { botRunDir } from "../workflow/paths";
import type { buildPrStepContext } from "../workflow/pr-step-context";
import { _workflowDeps } from "../workflow/step-context";
import type { PrCheckout } from "./checkout";
import { listCiConfigFiles } from "./checkout-state";
import { type BotCheckSource, type BotChecks, checkCommands } from "./checks";
import type { BotDecision } from "./decisions";
import { featureIntentPaths } from "./intent";
import type { BotLog } from "./log";
import { botModel } from "./models";
import { sensitivePaths } from "./path-policy";
import { BOT_REVIEW_FILENAME, type PostReviewInput, type PostReviewOutcome } from "./post";
import { _botReviewDeps } from "./review-deps";
import { readReviewRulings, reviewRange } from "./review-rulings";
import type { PrReviewInput } from "./review-step";

export { _botReviewDeps } from "./review-deps";

export type BotReviewResult =
  | ({
      readonly outcome: "posted";
      readonly intent: PrReviewVerdict["intent"];
      readonly quality: PrReviewVerdict["quality"];
      readonly staticMode: boolean;
      readonly checksSource: BotCheckSource | null;
      readonly artifactPath: string;
      readonly logPath?: string;
    } & PostReviewOutcome)
  | { readonly outcome: "not-reviewed" | "refused"; readonly reason: string };

interface BotReviewInput {
  readonly decisions?: readonly BotDecision[];
  readonly dir: string;
  readonly pr: number;
  readonly profiles: readonly string[];
  readonly model?: ConfiguredModel;
  readonly interactive: boolean;
}
type ReviewStep = "review" | "post" | "done";
interface ReviewState extends GraphState<ReviewStep> {
  readonly unreadFiles?: readonly string[];
  readonly reviewRan?: boolean;
  readonly reason?: string;
  readonly verdict?: PrReviewVerdict;
  readonly posted?: PostReviewOutcome;
}
interface ReviewPreparation {
  readonly checks: BotChecks | null;
  readonly preRunFailed?: string;
  readonly ci: CiWaitResult;
}
interface ReviewEnv extends ReviewPreparation {
  readonly ctx: PrStepContext;
  readonly review: PrReviewInput;
  readonly post: Omit<PostReviewInput, "verdict">;
}

export const BOT_REVIEW_GRAPH: StepGraph<ReviewState, ReviewEnv, ReviewStep> = defineStepGraph({
  start: "review",
  end: ["done"],
  costStopProduces: [],
  costStop: async () => undefined,
  nodes: {
    review: {
      kind: "agent",
      produces: ["reviewRan", "reason", "verdict", "unreadFiles"],
      transitions: [{ to: "post", when: (state) => state.reviewRan === true }, { to: "done" }],
      async run(env) {
        const result = await _botReviewDeps.runPrReview(env.ctx, env.review);
        return {
          patch: result.ran
            ? { reviewRan: true, verdict: result.verdict, unreadFiles: result.unreadFiles }
            : { reviewRan: false, reason: result.why },
        };
      },
    },
    post: {
      kind: "forge",
      needs: ["verdict"],
      produces: ["posted"],
      transitions: [{ to: "done" }],
      async run(env, state) {
        if (!state.verdict)
          throw new NaxError("[bot] Missing review verdict", "BOT_REVIEW_VERDICT_MISSING", { stage: "bot" });
        return {
          patch: {
            posted: await _botReviewDeps.postPrReview({
              ...env.post,
              verdict: state.verdict,
              ...(state.unreadFiles?.length && { unreadFiles: state.unreadFiles }),
            }),
          },
        };
      },
    },
  },
});

async function triage(
  ref: PostReviewInput["ref"],
  cwd: string,
): Promise<
  Required<Pick<PostReviewInput, "threads" | "comments" | "own" | "earlier" | "login">> & {
    rawThreads: PostReviewInput["threads"];
    rawComments: PostReviewInput["comments"];
  }
> {
  const deps = _botReviewDeps;
  const [user, threads, comments] = await Promise.all([
    deps.readCurrentUser(ref, deps.forge, cwd),
    deps.listReviewThreads(ref, deps.forge, cwd),
    deps.listPrComments(ref, deps.forge, cwd),
  ]);
  const own = [
    ...threads.flatMap((thread) => ownComments(thread.comments, user.login, thread.id)),
    ...ownComments(comments, user.login),
  ];
  const isOwn = (comment: PrComment | undefined): boolean =>
    comment !== undefined && ownComments([comment], user.login).length > 0;
  return {
    rawThreads: threads,
    rawComments: comments,
    own,
    login: user.login,
    earlier: threads.filter((thread) => {
      const first = thread.comments[0];
      return !thread.resolved && isOwn(first) && parseNaxBotMarker(first?.body ?? "")?.key.startsWith("f-");
    }),
    threads: threads.filter((thread) => !thread.resolved && !isOwn(thread.comments[0])),
    comments: comments.filter(
      (comment) =>
        (comment.kind === "comment" || comment.kind === "review") && comment.body.trim() !== "" && !isOwn(comment),
    ),
  };
}

interface PreparedReview {
  readonly repoRoot: string;
  readonly ref: PostReviewInput["ref"];
  readonly info: PostReviewInput["info"];
  readonly checkout: PrCheckout;
  readonly staticMode: boolean;
}

function reviewConfig(loaded: NaxConfig, staticMode: boolean): NaxConfig {
  if (staticMode) return { ...loaded, mcp: { ...loaded.mcp, servers: {} } };
  const sandbox = loaded.execution.sandbox ?? DEFAULT_SANDBOX_CONFIG;
  if (sandbox.network?.allowLocalBinding !== undefined) return loaded;
  return {
    ...loaded,
    execution: {
      ...loaded.execution,
      sandbox: {
        ...sandbox,
        network: { ...sandbox.network, allowLocalBinding: true },
      },
    },
  };
}

async function prepareReviewChecks(
  prepared: PreparedReview,
  ctx: PrStepContext,
): Promise<Omit<ReviewPreparation, "ci">> {
  if (prepared.staticMode) return { checks: null };
  const { repoRoot, checkout } = prepared;
  const config = ctx.config;
  const checks = await _botReviewDeps.resolveBotChecks({
    repoRoot,
    baseSha: checkout.baseSha,
    snapshotDir: checkout.snapshotDir,
    hasBaseNax: checkout.hasBaseNax,
    config,
    extract: (input) =>
      _workflowDeps.callOp(ctx.callCtx, botChecksExtractOp, { ...input, model: config.bot?.models.checks }),
  });
  getLogger().info("bot", "Checks resolved", { source: checks.source, commands: checkCommands(checks) });
  try {
    await _botReviewDeps.runPreRunSteps({ steps: checks.preRun, workdir: checkout.worktree });
    return { checks };
  } catch (err) {
    if (!(err instanceof NaxError) || err.code !== "PRE_RUN_FAILED") throw err;
    const command = err.context?.command;
    getLogger().warn("bot", "Install step failed", { command });
    return { checks, ...(typeof command === "string" ? { preRunFailed: command } : {}) };
  }
}

async function reviewEnvironment(
  input: BotReviewInput,
  prepared: PreparedReview,
  context: { ctx: PrStepContext; stateDir: string },
): Promise<ReviewEnv> {
  const { repoRoot, ref, info, checkout, staticMode } = prepared;
  const { ctx, stateDir } = context;
  const checks = await prepareReviewChecks(prepared, ctx);
  const [items, issues, ci] = await Promise.all([
    triage(ref, repoRoot),
    _botReviewDeps.readLinkedIssues(ref, info.body, _botReviewDeps.forge, repoRoot),
    // The agent sandbox cannot run the full checks; CI on this exact head can vouch for them (nax#2631).
    _botReviewDeps.readHeadCi({ forge: ref.forge, url: info.url, repoRoot, headSha: info.headSha }),
  ]);
  const { rawThreads, rawComments, ...triaged } = items;
  const { reviewedIndex, ...recorded } = await readReviewRulings(
    {
      ref,
      info,
      login: items.login,
      threads: rawThreads,
      comments: rawComments,
      deps: _botReviewDeps.forge,
      cwd: repoRoot,
      staticMode,
      ctx,
    },
    _botReviewDeps.recordPrRulings,
  );
  const preparation: ReviewPreparation = { ...checks, ci };
  const intent = featureIntentPaths(checkout);
  const checkoutState = staticMode
    ? undefined
    : renderCheckoutState({
        phase: "fresh",
        headSha: info.headSha,
        setup: preparation.checks?.preRun.map((step) => step.command) ?? [],
        setupFailed: preparation.preRunFailed,
        ciFiles: await listCiConfigFiles(checkout.worktree),
      });
  return {
    ...preparation,
    ctx,
    review: {
      mergeBase: checkout.mergeBase,
      ...(await reviewRange({ index: reviewedIndex, checkout, head: info.headSha }, _botReviewDeps.isAncestor)),
      info,
      issues,
      threads: items.threads,
      comments: items.comments,
      earlier: [...items.earlier, ...(recorded.itemEarlier ?? [])],
      checks: preparation.checks === null ? [] : checkCommands(preparation.checks),
      decisions: input.decisions ?? [],
      staticMode,
      ci,
      model: botModel(ctx.config, "review", input.model),
      ...intent,
      ...(checkoutState !== undefined && { checkoutState }),
    },
    post: {
      ...preparation,
      ref,
      info,
      ...triaged,
      ...recorded,
      staticMode,
      sensitive: sensitivePaths(checkout.changedFiles),
      stateDir,
      deps: _botReviewDeps.forge,
      cwd: repoRoot,
    },
  };
}

async function executeReview(env: ReviewEnv, runtime: ReturnType<typeof createRuntime>): Promise<BotReviewResult> {
  const state = await runStepGraph(
    BOT_REVIEW_GRAPH,
    env,
    { step: "review", timings: {} },
    { persist: (value) => _botReviewDeps.writeJson(join(env.post.stateDir, "bot-state.json"), value) },
    { aborted: () => runtime.signal.aborted, now: () => Date.now() },
  );
  if (!state.posted || !state.verdict) return { outcome: "not-reviewed", reason: state.reason ?? "review did not run" };
  getLogger().info("bot", "Bot review posted", {
    inlineFindings: state.posted.inlineFindings,
    threadsAnswered: state.posted.threadsAnswered,
    earlierAnswered: state.posted.earlierAnswered,
    failed: state.posted.failed,
    intent: state.verdict.intent,
    quality: state.verdict.quality,
  });
  return {
    outcome: "posted",
    ...state.posted,
    intent: state.verdict.intent,
    quality: state.verdict.quality,
    staticMode: env.review.staticMode,
    checksSource: env.checks?.source ?? null,
    artifactPath: join(env.post.stateDir, BOT_REVIEW_FILENAME),
  };
}

async function reviewCheckout(input: BotReviewInput, prepared: PreparedReview): Promise<BotReviewResult> {
  const deps = _botReviewDeps;
  const { repoRoot, ref, info, checkout, staticMode } = prepared;
  const loaded = await deps.loadBotConfig({ snapshotDir: checkout.snapshotDir, profiles: input.profiles });
  const config = reviewConfig(loaded, staticMode);
  const runtime = deps.createRuntime(config, repoRoot);
  const stateDir = botRunDir(runtime.outputDir, ref.number, runtime.runId);
  let log: BotLog | undefined;
  let context: Awaited<ReturnType<typeof buildPrStepContext>> | undefined;
  try {
    log = deps.openBotLog(join(stateDir, "bot.jsonl"));
    await deps.setupBotRuntime(runtime, config, checkout.worktree);
    getLogger().info("bot", "Bot review started", { pr: ref.number, headSha: info.headSha, trusted: !staticMode });
    context = await deps.buildPrStepContext({
      runtime,
      config,
      repoRoot: checkout.worktree,
      agentName: resolveDefaultAgent(config),
      pr: { forge: ref.forge, number: ref.number, base: checkout.mergeBase, head: info.headSha },
    });
    const env = await reviewEnvironment(input, prepared, { ctx: context.ctx, stateDir });
    const result = await executeReview(env, runtime);
    return result.outcome === "posted" && log.path !== undefined ? { ...result, logPath: log.path } : result;
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

/** Every invocation is fresh; no checkout or runtime survives the call. */
export async function runBotReview(input: BotReviewInput): Promise<BotReviewResult> {
  const deps = _botReviewDeps;
  const repoRoot = await deps.gitToplevel(input.dir);
  await deps.ensureProjectTrusted(repoRoot, { interactive: input.interactive });
  const ref = await deps.resolvePrRef(input.pr, deps.forge, repoRoot);
  const info = await deps.readPrInfo(ref, deps.forge, repoRoot);
  if (info.state !== "open") return { outcome: "refused", reason: `PR #${ref.number} is ${info.state}` };
  const trust = await deps.classifyPrTrust(ref, info, deps.forge, repoRoot);
  const checkout = await deps.preparePrCheckout({
    repoRoot,
    ref,
    info,
    suffix: deps.randomSuffix(),
    pinBaseFiles: true,
  });
  try {
    return await reviewCheckout(input, { repoRoot, ref, info, checkout, staticMode: !trust.trusted });
  } finally {
    await checkout.dispose();
  }
}
