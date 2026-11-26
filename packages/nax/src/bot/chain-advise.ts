/** Route a fix-induced chain finding to the advisor: which PRs and which findings qualify (US-004). */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { type AdviceResult, type Advisor, createAdvisor, ledgerPath } from "@/advisor";
import { resolveAdvisorConfig } from "@/config";
import {
  type OwnComment,
  ownComments,
  type PrThread,
  parseNaxBotMarker,
  replyToThread,
  resolveThread,
  unresolveThread,
  withNaxBotMarker,
} from "@/forge";
import { getLogger } from "@/logger";
import { configuredChainNoticeGeneration, isBlockingFinding } from "../workflow/blocking-findings";
import { buildChainQuestion } from "./chain-question";
import { type ChainRuling, chainRulingKey, parseChainRuling, renderChainRuling } from "./chain-rulings";
import type { BotFixEnv } from "./fix-steps";
import { featureIntentPaths } from "./intent";
import { ledgerFeature } from "./ledger-carry";
import type { AgreedItem } from "./post";
import { reviewBlockingTriggers } from "./review-blocking";
import { readFindingDispositions } from "./rulings";

/** Final shape grows with US-005..US-007; only the dependencies that exist today are listed. */
export const _chainAdviseDeps = {
  createAdvisor,
  buildChainQuestion,
  readFindingDispositions,
  replyToThread,
  resolveThread,
  unresolveThread,
  getLogger,
};

export interface ChainFinding {
  readonly item: Extract<AgreedItem, { kind: "finding" }>;
  /** The finding's own thread, when the bot posted one. */
  readonly thread?: PrThread;
}

export interface ChainRoutingContext {
  readonly feature: string;
  readonly specPath: string;
}

/** Null when the routing does not apply to this pull request at all. */
export function chainRoutingContext(env: BotFixEnv): ChainRoutingContext | null {
  const advisor = resolveAdvisorConfig(env.config);
  if (!advisor.enabled || !advisor.callers.botFixChain) return null;
  const feature = ledgerFeature(env);
  if (feature === undefined) return null;
  const { specPath } = featureIntentPaths(env.checkout);
  return specPath === undefined ? null : { feature, specPath };
}

function ownThread(env: BotFixEnv, key: string): PrThread | undefined {
  return env.threads.find((thread) => {
    const first = thread.comments[0];
    return first?.author === env.user.login && parseNaxBotMarker(first.body)?.key === key;
  });
}

type Decision = NonNullable<AdviceResult["decision"]>;

/** Maps an advisor decision to a ruling to post; null when it leaves the item unruled. */
function rulingFromDecision(key: string, decision: Decision): ChainRuling | null {
  const { action, needsHumanConfirm } = decision;
  if (action.type === "hold") return { key, outcome: "held", text: action.reason };
  if (action.type === "fix") {
    if (!needsHumanConfirm) return { key, outcome: "fix", text: action.instruction };
    return { key, outcome: "held", text: decision.rationale, proposed: { outcome: "fix", text: action.instruction } };
  }
  if (action.type === "waive") {
    if (!needsHumanConfirm) return { key, outcome: "waived", text: action.reason };
    return { key, outcome: "held", text: decision.rationale, proposed: { outcome: "waived", text: action.reason } };
  }
  return null;
}

async function askAdvisor(
  env: BotFixEnv,
  advisor: Advisor,
  found: ChainFinding,
  feature: string,
): Promise<ChainRuling | null> {
  const key = found.item.key;
  try {
    const draft = await _chainAdviseDeps.buildChainQuestion(env, found, feature);
    const advise = () => advisor.advise(draft, { findingSeverity: found.item.severity });
    const result = await (env.ctx.sessionScope ? env.ctx.sessionScope(advise) : advise());
    if (result.decision === null) {
      _chainAdviseDeps.getLogger()?.warn("bot-chain", "advisor returned no decision", {
        storyId: env.ctx.feature,
        key,
        fallbackReason: result.fallbackReason,
      });
      return null;
    }
    return rulingFromDecision(key, result.decision);
  } catch (err) {
    _chainAdviseDeps.getLogger()?.warn("bot-chain", "advisor call failed", {
      storyId: env.ctx.feature,
      key,
      error: errorMessage(err),
    });
    return null;
  }
}

/** Posts the ruling on the finding's thread; returns the ruling as posted, or null when posting failed. */
async function postRuling(env: BotFixEnv, thread: PrThread, ruling: ChainRuling): Promise<ChainRuling | null> {
  const body = withNaxBotMarker(renderChainRuling(ruling), chainRulingKey(ruling.key));
  try {
    await _chainAdviseDeps.replyToThread(env.ref, thread, body, env.forge, env.repoRoot);
  } catch (err) {
    _chainAdviseDeps.getLogger()?.warn("bot-chain", "posting the chain ruling failed", {
      storyId: env.ctx.feature,
      key: ruling.key,
      error: errorMessage(err),
    });
    return null;
  }
  const posted = parseChainRuling(body);
  if (ruling.outcome === "held" && thread.resolved) await reopenAfterHold(env, thread, ruling.key);
  if (ruling.outcome === "waived") await resolveAfterWaive(env, thread, ruling.key);
  return posted === null ? ruling : { key: ruling.key, ...posted };
}

async function reopenAfterHold(env: BotFixEnv, thread: PrThread, key: string): Promise<void> {
  try {
    await _chainAdviseDeps.unresolveThread(env.ref, thread, env.forge, env.repoRoot);
  } catch (err) {
    _chainAdviseDeps.getLogger()?.warn("bot-chain", "reopening the held thread failed", {
      storyId: env.ctx.feature,
      key,
      error: errorMessage(err),
    });
  }
}

async function resolveAfterWaive(env: BotFixEnv, thread: PrThread, key: string): Promise<void> {
  try {
    await _chainAdviseDeps.resolveThread(env.ref, thread, env.forge, env.repoRoot);
  } catch (err) {
    _chainAdviseDeps.getLogger()?.warn("bot-chain", "resolving the waived thread failed", {
      storyId: env.ctx.feature,
      key,
      error: errorMessage(err),
    });
  }
}

const FIX_REPEATED_TEXT = "raised again after an advisor-ruled fix";
const SECOND_ON_CHAIN_TEXT = "a second finding on this chain";
const RULING_KEY_PREFIX = "cr-";

interface RoutingState {
  readonly rulings: Map<string, ChainRuling>;
  readonly dropped: Set<string>;
  /** Chain ruling marker keys present on the pull request or made in this call. */
  readonly ruledKeys: Set<string>;
  costReached: boolean;
}

function ownOnThread(env: BotFixEnv, thread: PrThread): OwnComment[] {
  return ownComments(thread.comments, env.user.login, thread.id);
}

/** The newest own chain ruling on the thread, with the own comments after it. */
function replayOn(env: BotFixEnv, thread: PrThread): { ruling: Omit<ChainRuling, "key">; after: OwnComment[] } | null {
  const own = ownOnThread(env, thread);
  for (let i = own.length - 1; i >= 0; i--) {
    const entry = own[i];
    if (entry === undefined || !entry.key.startsWith(RULING_KEY_PREFIX)) continue;
    const ruling = parseChainRuling(entry.comment.body);
    if (ruling !== null) return { ruling, after: own.slice(i + 1) };
  }
  return null;
}

function existingRulingKeys(env: BotFixEnv): Set<string> {
  const all = [...env.threads.flatMap((t) => ownOnThread(env, t)), ...env.own];
  const keys = new Set<string>();
  for (const { key, comment } of all) {
    if (key.startsWith(RULING_KEY_PREFIX) && parseChainRuling(comment.body) !== null) keys.add(key);
  }
  return keys;
}

function record(state: RoutingState, ruling: ChainRuling): void {
  state.rulings.set(ruling.key, ruling);
  state.ruledKeys.add(chainRulingKey(ruling.key));
  if (ruling.outcome !== "fix") state.dropped.add(ruling.key);
}

async function holdAndPost(env: BotFixEnv, state: RoutingState, found: ChainFinding, text: string): Promise<void> {
  if (found.thread === undefined) return;
  const posted = await postRuling(env, found.thread, { key: found.item.key, outcome: "held", text });
  if (posted !== null) record(state, posted);
}

/** Composition tests 4-7 for one chain finding that has an own thread and is not confirmed. */
async function ruleOne(ctx: AskContext, found: ChainFinding & { thread: PrThread }): Promise<void> {
  const { env, state } = ctx;
  const key = found.item.key;
  const replay = replayOn(env, found.thread);
  if (replay !== null) {
    const { ruling, after } = replay;
    if (ruling.outcome === "waived") {
      state.dropped.add(key);
      state.ruledKeys.add(chainRulingKey(key));
    } else if (ruling.outcome === "held") record(state, { key, outcome: "held", text: ruling.text });
    else if (after.some((o) => o.key === `fix-${key}`)) await holdAndPost(env, state, found, FIX_REPEATED_TEXT);
    else record(state, { key, outcome: "fix", text: ruling.text });
    return;
  }
  const parents = found.item.lineage?.parents ?? [];
  if (parents.some((parent) => state.ruledKeys.has(chainRulingKey(parent)))) {
    await holdAndPost(env, state, found, SECOND_ON_CHAIN_TEXT);
    return;
  }
  if (state.costReached || env.cost.spentUsd() >= env.cost.limitUsd) {
    state.costReached = true;
    return;
  }
  const proposed = await askAdvisor(env, ctx.advisor, found, ctx.feature);
  if (proposed === null) return;
  const posted = await postRuling(env, found.thread, proposed);
  if (posted !== null) record(state, posted);
}

interface AskContext {
  readonly env: BotFixEnv;
  readonly advisor: Advisor;
  readonly feature: string;
  readonly state: RoutingState;
}

async function readLedgerText(repoRoot: string, feature: string): Promise<string | null> {
  try {
    return await Bun.file(ledgerPath(repoRoot, feature)).text();
  } catch {
    return null;
  }
}

/** Asks the advisor once per own-thread chain finding and applies each outcome; returns the env the fix runs on. */
export async function withChainRulings(env: BotFixEnv): Promise<BotFixEnv> {
  const routing = chainRoutingContext(env);
  if (routing === null) return env;
  const found = selectChainFindings(env);
  if (found.length === 0) return env;
  // An unreadable ruling aborts preparation rather than sending potentially confirmed work to a fixer.
  const { confirmed, writerSettled } = await _chainAdviseDeps.readFindingDispositions({
    ref: env.ref,
    login: env.user.login,
    threads: env.threads,
    comments: env.own.filter(({ threadId }) => threadId === undefined).map(({ comment }) => comment),
    deps: env.forge,
    cwd: env.repoRoot,
  });
  const { runtime } = env.ctx.callCtx;
  const advisor = _chainAdviseDeps.createAdvisor({
    callCtx: env.ctx.callCtx,
    repoRoot: env.repoRoot,
    outputDir: runtime.outputDir,
    runId: runtime.runId,
    feature: routing.feature,
    specPath: routing.specPath,
    workdir: env.checkout.worktree,
  });
  const state: RoutingState = {
    rulings: new Map(),
    dropped: new Set(),
    ruledKeys: existingRulingKeys(env),
    costReached: false,
  };
  const ctx = { env, advisor, feature: routing.feature, state };
  const ledgerBefore = await readLedgerText(env.repoRoot, routing.feature);
  for (const entry of found) {
    if (writerSettled.has(entry.item.key)) {
      // An authorized writer disposition outranks the advisor's earlier ruling: drop it without replay.
      state.dropped.add(entry.item.key);
      continue;
    }
    if (confirmed.has(entry.item.key) || entry.thread === undefined) continue;
    await ruleOne(ctx, { ...entry, thread: entry.thread });
  }
  const ledgerAfter = await readLedgerText(env.repoRoot, routing.feature);
  const advisorLedger =
    ledgerAfter !== null && ledgerAfter !== ledgerBefore
      ? { feature: routing.feature, before: ledgerBefore, after: ledgerAfter }
      : undefined;
  const withLedger = advisorLedger === undefined ? env : { ...env, advisorLedger };
  if (state.rulings.size === 0 && state.dropped.size === 0) return withLedger;
  const ordered = env.review.agreed.flatMap((item) => state.rulings.get(item.key) ?? []);
  return {
    ...withLedger,
    review: { ...env.review, agreed: env.review.agreed.filter((item) => !state.dropped.has(item.key)) },
    chainRulings: ordered,
  };
}

/** Blocking findings at or past the notice generation, in `review.agreed` order. */
export function selectChainFindings(env: BotFixEnv): readonly ChainFinding[] {
  const blocking = reviewBlockingTriggers(env);
  const noticeGeneration = configuredChainNoticeGeneration(env.config);
  const found: ChainFinding[] = [];
  for (const item of env.review.agreed) {
    if (item.kind !== "finding" || !isBlockingFinding(item, blocking)) continue;
    if (item.lineage === undefined || item.lineage.generation < noticeGeneration) continue;
    const thread = ownThread(env, item.key);
    found.push(thread === undefined ? { item } : { item, thread });
  }
  return found;
}
