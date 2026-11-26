/** Route a fix-induced chain finding to the advisor: which PRs and which findings qualify (US-004). */
import { createAdvisor } from "@/advisor";
import { resolveAdvisorConfig } from "@/config";
import { type PrThread, parseNaxBotMarker, replyToThread, resolveThread } from "@/forge";
import { getLogger } from "@/logger";
import { configuredChainNoticeGeneration, isBlockingFinding } from "../workflow/blocking-findings";
import { buildChainQuestion } from "./chain-question";
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
