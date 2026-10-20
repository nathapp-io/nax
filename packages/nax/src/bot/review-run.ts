import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { resolveDefaultAgent } from "@/agents";
import { type ConfiguredModel, PROJECT_FEATURES_DIR } from "@/config";
import { NaxError } from "@/errors";
import {
  classifyPrTrust,
  defaultForgeDeps,
  listPrComments,
  listReviewThreads,
  type OwnComment,
  type PrComment,
  parseNaxBotMarker,
  readCurrentUser,
  readLinkedIssues,
  readPrInfo,
  resolvePrRef,
} from "@/forge";
import type { PrReviewVerdict } from "@/operations";
import { createRuntime } from "@/runtime";
import { defineStepGraph, type GraphState, runStepGraph, type StepGraph } from "@/step-graph";
import { ensureProjectTrusted } from "@/trust";
import { gitWithTimeout } from "@/utils/git";
import type { PrStepContext } from "../workflow/branch-step-context";
import { botRunDir } from "../workflow/paths";
import { buildPrStepContext } from "../workflow/pr-step-context";
import { loadBotConfig } from "./base-config";
import { type PrCheckout, preparePrCheckout } from "./checkout";
import { botModel } from "./models";
import { sensitivePaths } from "./path-policy";
import { type PostReviewInput, type PostReviewOutcome, postPrReview } from "./post";
import { type PrReviewInput, runPrReview } from "./review-step";

export const _botReviewDeps = {
  async gitToplevel(dir: string): Promise<string> {
    const result = await gitWithTimeout(["rev-parse", "--show-toplevel"], dir);
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
  listReviewThreads,
  listPrComments,
  readLinkedIssues,
  preparePrCheckout,
  loadBotConfig,
  createRuntime,
  buildPrStepContext,
  runPrReview,
  postPrReview,
  async writeJson(path: string, value: unknown): Promise<void> {
    await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
  },
  randomSuffix: (): string => randomBytes(4).toString("hex"),
};

export type BotReviewResult =
  | ({
      readonly outcome: "posted";
      readonly intent: PrReviewVerdict["intent"];
      readonly quality: PrReviewVerdict["quality"];
      readonly staticMode: boolean;
    } & PostReviewOutcome)
  | { readonly outcome: "not-reviewed" | "refused"; readonly reason: string };

interface BotReviewInput {
  readonly dir: string;
  readonly pr: number;
  readonly profiles: readonly string[];
  readonly model?: ConfiguredModel;
  readonly interactive: boolean;
}
type ReviewStep = "review" | "post" | "done";
interface ReviewState extends GraphState<ReviewStep> {
  readonly reviewRan?: boolean;
  readonly reason?: string;
  readonly verdict?: PrReviewVerdict;
  readonly posted?: PostReviewOutcome;
}
interface ReviewEnv {
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
      produces: ["reviewRan", "reason", "verdict"],
      transitions: [{ to: "post", when: (state) => state.reviewRan === true }, { to: "done" }],
      async run(env) {
        const result = await _botReviewDeps.runPrReview(env.ctx, env.review);
        return {
          patch: result.ran ? { reviewRan: true, verdict: result.verdict } : { reviewRan: false, reason: result.why },
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
        return { patch: { posted: await _botReviewDeps.postPrReview({ ...env.post, verdict: state.verdict }) } };
      },
    },
  },
});

function featurePrd(checkout: PrCheckout): string | undefined {
  const prefix = `${PROJECT_FEATURES_DIR}/`;
  const paths = checkout.changedFiles.filter((path) => {
    if (!path.startsWith(prefix)) return false;
    const parts = path.slice(prefix.length).split("/");
    return parts.length === 2 && parts[0] !== "" && parts[0] !== "." && parts[0] !== ".." && parts[1] === "prd.json";
  });
  return paths.length === 1 ? join(checkout.worktree, paths[0] ?? "") : undefined;
}

async function triage(
  ref: PostReviewInput["ref"],
  cwd: string,
): Promise<Pick<PostReviewInput, "threads" | "comments" | "own">> {
  const deps = _botReviewDeps;
  const user = await deps.readCurrentUser(ref, deps.forge, cwd);
  const threads = await deps.listReviewThreads(ref, deps.forge, cwd);
  const comments = await deps.listPrComments(ref, deps.forge, cwd);
  const own: OwnComment[] = [];
  const collect = (comment: PrComment, threadId?: string): void => {
    const marker = comment.author === user.login ? parseNaxBotMarker(comment.body) : null;
    if (marker) own.push({ comment, key: marker.key, ...(threadId === undefined ? {} : { threadId }) });
  };
  for (const thread of threads) for (const comment of thread.comments) collect(comment, thread.id);
  for (const comment of comments) collect(comment);
  const isOwn = (comment: PrComment | undefined): boolean =>
    comment !== undefined && comment.author === user.login && parseNaxBotMarker(comment.body) !== null;
  return {
    own,
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

async function reviewEnvironment(
  input: BotReviewInput,
  prepared: PreparedReview,
  context: { ctx: PrStepContext; stateDir: string },
): Promise<ReviewEnv> {
  const { repoRoot, ref, info, checkout, staticMode } = prepared;
  const { ctx, stateDir } = context;
  const items = await triage(ref, repoRoot);
  const issues = await _botReviewDeps.readLinkedIssues(ref, info.body, _botReviewDeps.forge, repoRoot);
  const prdPath = featurePrd(checkout);
  return {
    ctx,
    review: {
      mergeBase: checkout.mergeBase,
      info,
      issues,
      threads: items.threads,
      comments: items.comments,
      staticMode,
      model: botModel(ctx.config, "review", input.model),
      ...(prdPath === undefined ? {} : { prdPath }),
    },
    post: {
      ref,
      info,
      ...items,
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
  return {
    outcome: "posted",
    ...state.posted,
    intent: state.verdict.intent,
    quality: state.verdict.quality,
    staticMode: env.review.staticMode,
  };
}

async function reviewCheckout(input: BotReviewInput, prepared: PreparedReview): Promise<BotReviewResult> {
  const deps = _botReviewDeps;
  const { repoRoot, ref, info, checkout, staticMode } = prepared;
  const loaded = await deps.loadBotConfig({ snapshotDir: checkout.snapshotDir, profiles: input.profiles });
  const config = staticMode ? { ...loaded, mcp: { ...loaded.mcp, servers: {} } } : loaded;
  const runtime = deps.createRuntime(config, repoRoot);
  let context: Awaited<ReturnType<typeof buildPrStepContext>> | undefined;
  try {
    context = await deps.buildPrStepContext({
      runtime,
      config,
      repoRoot: checkout.worktree,
      agentName: resolveDefaultAgent(config),
      pr: { forge: ref.forge, number: ref.number, base: checkout.mergeBase, head: info.headSha },
    });
    const stateDir = botRunDir(runtime.outputDir, ref.number, runtime.runId);
    const env = await reviewEnvironment(input, prepared, { ctx: context.ctx, stateDir });
    return await executeReview(env, runtime);
  } finally {
    try {
      await context?.dispose();
    } finally {
      await runtime.close();
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
