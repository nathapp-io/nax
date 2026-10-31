import { join } from "node:path";
import { resolveDefaultAgent } from "@/agents";
import { type ConfiguredModel, DEFAULT_SANDBOX_CONFIG, type NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import type { InteractionChain } from "@/interaction";
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
import { initBotInteractionChain } from "./chat-asks";
import type { PrCheckout } from "./checkout";
import { listCiConfigFiles } from "./checkout-state";
import { type BotCheckSource, type BotChecks, checkCommands, reviewBuildSteps } from "./checks";
import { type BotCostEnv, botCostEnv } from "./cost";
import type { BotDecision } from "./decisions";
import { featureIntentPaths } from "./intent";
import type { BotLog } from "./log";
import { botModel } from "./models";
import { sensitivePaths } from "./path-policy";
import { BOT_REVIEW_FILENAME, type PostReviewInput, type PostReviewOutcome } from "./post";
import { _botReviewDeps } from "./review-deps";
import { readReviewRulings, reviewRange, reviewScopeOf } from "./review-rulings";
import type { PrReviewInput } from "./review-step";
import { triage } from "./review-triage";
import { hasNonWriterAuthor } from "./writers";

export { _botReviewDeps } from "./review-deps";

export type BotReviewResult =
  | ({
      readonly outcome: "posted";
      readonly spentUsd?: number;
      readonly limitUsd?: number;
      readonly intent: PrReviewVerdict["intent"];
      readonly quality: PrReviewVerdict["quality"];
      readonly staticMode: boolean;
      readonly checksSource: BotCheckSource | null;
      readonly artifactPath: string;
      readonly logPath?: string;
    } & PostReviewOutcome)
  | { readonly outcome: "not-reviewed" | "refused"; readonly reason: string };

export interface BotReviewInput {
  readonly chatAsksDir?: string;
  readonly chatAskSecret?: Uint8Array;
  readonly inPlace?: boolean;
  readonly costLimitUsd?: number;
  readonly decisions?: readonly BotDecision[];
  readonly dir: string;
  readonly pr: number;
  readonly profiles: readonly string[];
  readonly model?: ConfiguredModel;
  readonly interactive: boolean;
  /** Review everything since the merge base, ignoring any earlier reviewed head (nax#2667). */
  readonly full?: boolean;
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
  /** The build step that failed; the review still runs. */
  readonly buildFailed?: string;
  /** Every build command once the build was attempted, `[]` otherwise. */
  readonly buildRan: readonly string[];
}
interface ReviewEnv extends ReviewPreparation {
  readonly cost: BotCostEnv;
  readonly ctx: PrStepContext;
  readonly review: PrReviewInput;
  readonly post: Omit<PostReviewInput, "verdict">;
}

export const BOT_REVIEW_GRAPH: StepGraph<ReviewState, ReviewEnv, ReviewStep> = defineStepGraph({
  start: "review",
  end: ["done"],
  costStopProduces: ["reviewRan", "reason"],
  costStop: async (node, _state, env) =>
    node === "review"
      ? {
          patch: {
            reviewRan: false,
            reason: `cost limit reached: ${env.cost.spentUsd().toFixed(2)} of ${env.cost.limitUsd.toFixed(2)} USD`,
          },
          to: "done",
        }
      : undefined,
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
  if (prepared.staticMode) return { checks: null, buildRan: [] };
  const { checkout } = prepared;
  const checks = await resolveReviewChecks(prepared, ctx);
  getLogger().info("bot", "Checks resolved", { source: checks.source, commands: checkCommands(checks) });
  try {
    await _botReviewDeps.runPreRunSteps({ steps: checks.preRun, workdir: checkout.worktree });
  } catch (err) {
    const failed = preRunFailedCommand(err, "Install step failed");
    return { checks, buildRan: [], ...(failed === undefined ? {} : { preRunFailed: failed }) };
  }
  return { checks, ...(await runReviewBuild(prepared, checks)) };
}

async function resolveReviewChecks(prepared: PreparedReview, ctx: PrStepContext): Promise<BotChecks> {
  const { repoRoot, checkout } = prepared;
  const config = ctx.config;
  return _botReviewDeps.resolveBotChecks({
    repoRoot,
    baseSha: checkout.baseSha,
    snapshotDir: checkout.snapshotDir,
    hasBaseNax: checkout.hasBaseNax,
    config,
    extract: (input) =>
      _workflowDeps.callOp(ctx.callCtx, botChecksExtractOp, { ...input, model: config.bot?.models.checks }),
  });
}

/**
 * Absorb only a `PRE_RUN_FAILED` — it names the step that stopped the setup,
 * and the review runs anyway. Anything else (a trust refusal, a spawn failure)
 * propagates rather than reading as a setup warning.
 */
function preRunFailedCommand(err: unknown, message: string): string | undefined {
  if (!(err instanceof NaxError) || err.code !== "PRE_RUN_FAILED") throw err;
  const command = err.context?.command;
  getLogger().warn("bot", message, { command });
  return typeof command === "string" ? command : undefined;
}

interface ReviewBuildRun {
  readonly buildRan: readonly string[];
  readonly buildFailed?: string;
}

/**
 * Build the fresh checkout after a successful install. An `--in-place` review
 * reuses the user's own build, and a repo with no root `build` gate has nothing
 * to run. `buildRan` still lists every command when a step fails, so the prompt
 * reports the whole build it asked for rather than stopping at the failure.
 */
async function runReviewBuild(prepared: PreparedReview, checks: BotChecks): Promise<ReviewBuildRun> {
  const steps = reviewBuildSteps(checks);
  const { inPlace, worktree } = prepared.checkout;
  if (inPlace === true || steps.length === 0) return { buildRan: [] };
  const buildRan = steps.map(({ command }) => command);
  try {
    await _botReviewDeps.runPreRunSteps({ steps, workdir: worktree });
    return { buildRan };
  } catch (err) {
    const failed = preRunFailedCommand(err, "Build step failed");
    return { buildRan, ...(failed === undefined ? {} : { buildFailed: failed }) };
  }
}

/**
 * What the checkout state reports nax ran: the install commands, then whatever
 * build commands were attempted — including the ones after a build step that
 * failed, since the review's prompt describes the setup it asked for.
 */
function setupCommands(preparation: ReviewPreparation): string[] {
  const install = preparation.checks?.preRun.map((step) => step.command) ?? [];
  return [...install, ...preparation.buildRan];
}

async function reviewEnvironment(
  input: BotReviewInput,
  prepared: PreparedReview,
  context: { ctx: PrStepContext; stateDir: string; cost: BotCostEnv; checks: Omit<ReviewPreparation, "ci"> },
): Promise<ReviewEnv> {
  const { repoRoot, ref, info, checkout, staticMode } = prepared;
  const { ctx, stateDir } = context;
  const { checks } = context;
  const [items, issues, ci] = await Promise.all([
    triage(ref, repoRoot),
    _botReviewDeps.readLinkedIssues(ref, info.body, _botReviewDeps.forge, repoRoot),
    // The agent sandbox cannot run the full checks; CI on this exact head can vouch for them (nax#2631).
    _botReviewDeps.readHeadCi({ forge: ref.forge, url: info.url, repoRoot, headSha: info.headSha }),
  ]);
  const { rawThreads, rawComments, ownFindingThreads, writerCheck, ...triaged } = items;
  const findings = await _botReviewDeps.recordFindingRulings({
    ref,
    login: items.login,
    threads: ownFindingThreads,
    deps: _botReviewDeps.forge,
    cwd: repoRoot,
    isWriter: (comment) => writerCheck({ login: comment.author, id: comment.authorId }),
  });
  const settledIds = new Set(findings.settled.map(({ threadId }) => threadId));
  const confirmedIds = new Set(findings.confirmed.map(({ threadId }) => threadId));
  const activeConfirmedIds = new Set(
    findings.confirmed.filter(({ fixClosed }) => !fixClosed).map(({ threadId }) => threadId),
  );
  // Triage omits resolved threads, but a later confirmation can restore their fix work.
  const postEarlier = [
    ...new Map(
      [
        ...items.earlier.filter(({ id }) => !settledIds.has(id)),
        ...ownFindingThreads.filter(({ id }) => activeConfirmedIds.has(id)),
      ].map((thread) => [thread.id, thread]),
    ).values(),
  ];
  const { reviewedIndex, settled, ...recorded } = await readReviewRulings(
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
  const findingSettled = [...findings.settled, ...findings.confirmed].map(({ ruling }) => ruling);
  const rulings =
    recorded.rulings || findings.echoed > 0
      ? {
          recorded: (recorded.rulings?.recorded ?? 0) + findings.echoed,
          open: recorded.rulings?.open ?? 0,
          asked: recorded.rulings?.asked ?? 0,
        }
      : undefined;
  const preparation: ReviewPreparation = { ...checks, ci };
  const intent = featureIntentPaths(checkout);
  const checkoutState = staticMode
    ? undefined
    : renderCheckoutState({
        phase: "fresh",
        headSha: info.headSha,
        setup: setupCommands(preparation),
        setupFailed: preparation.preRunFailed ?? preparation.buildFailed,
        ciFiles: await listCiConfigFiles(checkout.worktree),
      });
  // One chosen range feeds the review, the summary and the artifact, so no two can disagree.
  const range =
    input.full === true
      ? { rangeBase: checkout.mergeBase }
      : await reviewRange({ index: reviewedIndex, checkout, head: info.headSha }, _botReviewDeps.isAncestor);
  const scope = reviewScopeOf({ ...range, mergeBase: checkout.mergeBase });
  return {
    ...preparation,
    cost: context.cost,
    ctx,
    review: {
      mergeBase: checkout.mergeBase,
      ...range,
      info,
      issues,
      threads: items.threads,
      comments: items.comments,
      earlier: [...postEarlier.filter(({ id }) => !confirmedIds.has(id)), ...(recorded.itemEarlier ?? [])],
      ...((settled !== undefined || findingSettled.length > 0) && { settled: [...(settled ?? []), ...findingSettled] }),
      checks: preparation.checks === null ? [] : checkCommands(preparation.checks),
      decisions: input.decisions ?? [],
      staticMode,
      ci,
      model: botModel(ctx.config, "review", input.model),
      ...(!staticMode && intent),
      ...(checkoutState !== undefined && { checkoutState }),
    },
    post: {
      ...preparation,
      ref,
      info,
      ...triaged,
      // Includes itemConfirmed for fixes; the explicit review input above excludes it.
      ...recorded,
      ...((recorded.itemEarlier?.length ?? 0) > 0 && {
        itemFixedBlocked: await hasNonWriterAuthor(
          [
            ...items.threads.flatMap((thread) => thread.comments),
            ...items.comments,
            ...postEarlier.flatMap((thread) => thread.comments),
          ],
          items.login,
          writerCheck,
        ),
      }),
      earlier: postEarlier,
      settledKeys: new Set(findings.settled.map(({ ruling }) => ruling.id)),
      resolvedThreadIds: new Set(ownFindingThreads.filter(({ resolved }) => resolved).map(({ id }) => id)),
      ...(rulings !== undefined && { rulings }),
      scope,
      ...(scope === "incremental" && { incrementalSince: range.rangeBase }),
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
    {
      aborted: () => runtime.signal.aborted,
      now: () => Date.now(),
      costExceeded: () => env.cost.spentUsd() >= env.cost.limitUsd,
    },
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
    spentUsd: env.cost.spentUsd(),
    limitUsd: env.cost.limitUsd,
    ...state.posted,
    intent: state.verdict.intent,
    quality: state.verdict.quality,
    staticMode: env.review.staticMode,
    checksSource: env.checks?.source ?? null,
    artifactPath: join(env.post.stateDir, BOT_REVIEW_FILENAME),
  };
}

async function checkoutClean(workdir: string): Promise<boolean> {
  const result = await _botReviewDeps.runGit(["status", "--porcelain", "--untracked-files=all"], workdir);
  if (result.exitCode !== 0) {
    throw new NaxError("[bot] Cannot check in-place checkout after setup", "BOT_CHECKOUT_FAILED", {
      stage: "bot",
      workdir,
      stderr: result.stderr,
    });
  }
  return result.stdout.trim() === "";
}

async function reviewCheckout(input: BotReviewInput, prepared: PreparedReview): Promise<BotReviewResult> {
  const deps = _botReviewDeps;
  const { repoRoot, ref, info, checkout, staticMode } = prepared;
  const loaded = await deps.loadBotConfig({ snapshotDir: checkout.snapshotDir, profiles: input.profiles });
  const config = reviewConfig(loaded, staticMode);
  const runtime = deps.createRuntime(config, repoRoot, { featureName: `bot-pr-${ref.number}` });
  const stateDir = botRunDir(runtime.outputDir, ref.number, runtime.runId);
  let interactionChain: InteractionChain | null = null;
  let log: BotLog | undefined;
  let context: Awaited<ReturnType<typeof buildPrStepContext>> | undefined;
  try {
    log = deps.openBotLog(join(stateDir, "bot.jsonl"));
    await deps.setupBotRuntime(runtime, config, checkout.worktree);
    getLogger().info("bot", "Bot review started", { pr: ref.number, headSha: info.headSha, trusted: !staticMode });
    interactionChain = await initBotInteractionChain({ input, config, init: deps.initInteractionChain });
    context = await deps.buildPrStepContext({
      ...(interactionChain ? { interactionChain } : {}),
      runtime,
      config,
      repoRoot: checkout.worktree,
      agentName: resolveDefaultAgent(config),
      pr: { forge: ref.forge, number: ref.number, base: checkout.mergeBase, head: info.headSha },
    });
    const checks = await prepareReviewChecks(prepared, context.ctx);
    if (checkout.inPlace && !(await checkoutClean(checkout.worktree))) {
      return { outcome: "refused", reason: "in-place checkout not clean after setup" };
    }
    const env = await reviewEnvironment(input, prepared, {
      checks,
      ctx: context.ctx,
      stateDir,
      cost: botCostEnv(config, runtime, input.costLimitUsd),
    });
    const result = await executeReview(env, runtime);
    return result.outcome === "posted" && log.path !== undefined ? { ...result, logPath: log.path } : result;
  } finally {
    try {
      try {
        await context?.dispose();
      } finally {
        await interactionChain?.destroy();
      }
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
  if (input.inPlace && !trust.trusted) return { outcome: "refused", reason: "--in-place needs a trusted PR" };
  const checkoutInput = { repoRoot, ref, info, suffix: deps.randomSuffix() };
  const checkout = input.inPlace
    ? await deps.prepareInPlaceCheckout(checkoutInput)
    : await deps.preparePrCheckout({ ...checkoutInput, pinBaseFiles: true });
  try {
    return await reviewCheckout(input, { repoRoot, ref, info, checkout, staticMode: !trust.trusted });
  } finally {
    await checkout.dispose();
  }
}
