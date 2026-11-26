/** Route a fix-induced chain finding to the advisor: which PRs and which findings qualify (US-004). */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { type AdviceResult, type Advisor, createAdvisor } from "@/advisor";
import { resolveAdvisorConfig } from "@/config";
import { type PrThread, parseNaxBotMarker, replyToThread, resolveThread, withNaxBotMarker } from "@/forge";
import { getLogger } from "@/logger";
import { configuredChainNoticeGeneration, isBlockingFinding } from "../workflow/blocking-findings";
import { buildChainQuestion } from "./chain-question";
import { type ChainRuling, chainRulingKey, parseChainRuling, renderChainRuling } from "./chain-rulings";
import type { BotFixEnv } from "./fix-steps";
import { featureIntentPaths } from "./intent";
import { ledgerFeature } from "./ledger-carry";
import type { AgreedItem } from "./post";
import { reviewBlockingTriggers } from "./review-blocking";
import { readConfirmedKeys } from "./rulings";

/** Final shape grows with US-005..US-007; only the dependencies that exist today are listed. */
export const _chainAdviseDeps = {
  createAdvisor,
  buildChainQuestion,
  readConfirmedKeys,
  replyToThread,
  resolveThread,
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
  if (ruling.outcome === "waived") await resolveAfterWaive(env, thread, ruling.key);
  return posted === null ? ruling : { key: ruling.key, ...posted };
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

/** Asks the advisor once per own-thread chain finding and applies each outcome; returns the env the fix runs on. */
export async function withChainRulings(env: BotFixEnv): Promise<BotFixEnv> {
  const routing = chainRoutingContext(env);
  if (routing === null) return env;
  const found = selectChainFindings(env);
  if (found.length === 0) return env;
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
  const rulings = new Map<string, ChainRuling>();
  for (const entry of found) {
    if (entry.thread === undefined) continue;
    const proposed = await askAdvisor(env, advisor, entry, routing.feature);
    if (proposed === null) continue;
    const posted = await postRuling(env, entry.thread, proposed);
    if (posted !== null) rulings.set(entry.item.key, posted);
  }
  if (rulings.size === 0) return env;
  const dropped = new Set([...rulings.values()].filter((r) => r.outcome !== "fix").map((r) => r.key));
  const ordered = env.review.agreed.flatMap((item) => rulings.get(item.key) ?? []);
  return {
    ...env,
    review: { ...env.review, agreed: env.review.agreed.filter((item) => !dropped.has(item.key)) },
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
