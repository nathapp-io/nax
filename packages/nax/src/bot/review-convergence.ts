/**
 * What a review reads from the conversation it already fetched: the PR's effective blocking policy
 * (US-003) — the set that decides which new findings get an inline thread and which agreed findings will
 * hold readiness, where that set came from, and the writer scope rulings the review ignored — and the
 * bot's own record of its pushes (US-005), which the prompt lists and the post node attributes lines to.
 *
 * `review-run.ts` keeps only the calls: both are read once, from the comments triage already fetched and
 * the writer set it already resolved, so a review never asks the forge a permission question twice.
 */
import type { OwnComment, PrComment, PrThread } from "@/forge";
import { getSafeLogger } from "@/logger";
import { configuredBlockingTriggers, effectiveBlockingTriggers } from "@/workflow/blocking-findings";
import { FIX_SUMMARY_KEY } from "./ci-waiver-ready";
import type { PostReviewInput } from "./post";
import { type BotPushEntry, readPushLedger } from "./push-ledger";
import { ownLedgerEntries } from "./push-record";
import { openFindings, unrecordedPushes } from "./unrecorded-pushes";

/** Only `bot.blockingTriggers` is read; taking the shared reader's own parameter keeps the two in step. */
export type BlockingPolicyConfig = Parameters<typeof configuredBlockingTriggers>[0];

export interface ReviewConvergenceInput {
  readonly comments: readonly PrComment[];
  readonly writers: ReadonlySet<string>;
  readonly config: BlockingPolicyConfig;
}

export type ReviewConvergence = Required<
  Pick<PostReviewInput, "blockingTriggers" | "blockingSource" | "ignoredScopeRulings">
>;

export function reviewConvergence(input: ReviewConvergenceInput): ReviewConvergence {
  const effective = effectiveBlockingTriggers({
    comments: input.comments,
    writers: input.writers,
    configured: configuredBlockingTriggers(input.config),
  });
  return {
    blockingTriggers: effective.triggers,
    blockingSource: effective.source,
    ignoredScopeRulings: effective.invalid,
  };
}

/** What the review reads out of the bot's own fix summary (US-005). */
export interface ReviewHistoryInput {
  /** The bot's own comments, already resolved by triage — the fix summary among them. */
  readonly own: readonly OwnComment[];
  readonly worktree: string;
  readonly head: string;
  /** The already-reviewed head an incremental range starts after; absent for a full review. */
  readonly rangeBase?: string;
  readonly isAncestor: (dir: string, ancestor: string, head: string) => Promise<boolean>;
  /** #3069: the bot's finding threads still open at the reviewed head, which an unrecorded push can answer. */
  readonly earlier?: readonly PrThread[];
}

export interface ReviewHistory {
  /** Every push the bot recorded, for the post node's reachability and lineage read. */
  readonly botPushes: readonly BotPushEntry[];
  /** Only the pushes an incremental range covers: the prompt lists these, a full review lists none. */
  readonly inRange?: readonly BotPushEntry[];
}

/** A ledger this version cannot read dates no finding: it reads as no history at all, and says so. */
function ownLedger(own: readonly OwnComment[]): readonly BotPushEntry[] {
  const body = own.find(({ key, threadId }) => key === FIX_SUMMARY_KEY && threadId === undefined)?.comment.body;
  if (body !== undefined && readPushLedger(body).unreadable)
    getSafeLogger()?.warn("bot", "Could not read the bot's own push ledger; reviewing without lineage");
  // B1: the summary's block is written by two whole-body writers, so a rewrite can drop an entry. The
  // append-only record each push posts cannot be rewritten, and the reader takes both.
  return ownLedgerEntries(own);
}

/**
 * US-005: whether a push falls inside the range — the head still reaches it, the range base does not.
 * `undefined` means the question went unanswered, which the prompt must not read as a yes.
 */
async function inRange(
  input: ReviewHistoryInput,
  entry: BotPushEntry,
  rangeBase: string,
): Promise<boolean | undefined> {
  try {
    if (!(await input.isAncestor(input.worktree, entry.sha, input.head))) return false;
    return !(await input.isAncestor(input.worktree, entry.sha, rangeBase));
  } catch {
    return undefined;
  }
}

/**
 * US-005: the pushes an incremental review's prompt lists. An entry whose membership cannot be proved is
 * left out of the prompt — never out of the ledger the post node needs.
 */
async function pushesInRange(
  input: ReviewHistoryInput,
  rangeBase: string,
  entries: readonly BotPushEntry[],
): Promise<readonly BotPushEntry[]> {
  const kept: BotPushEntry[] = [];
  for (const entry of entries) {
    const inside = await inRange(input, entry, rangeBase);
    if (inside === true) kept.push(entry);
    else if (inside === undefined)
      getSafeLogger()?.warn("bot", "Could not check whether a recorded bot push is inside the reviewed range", {
        sha: entry.sha,
      });
  }
  return kept;
}

/** The bot's recorded pushes, and for an incremental review the subset its prompt should describe. */
export async function reviewHistory(input: ReviewHistoryInput): Promise<ReviewHistory> {
  const recorded = ownLedger(input.own);
  if (input.rangeBase === undefined) return { botPushes: recorded };
  const derived = await unrecordedPushes({
    worktree: input.worktree,
    rangeBase: input.rangeBase,
    head: input.head,
    recorded,
    open: openFindings(input.earlier ?? []),
  });
  const botPushes = [...recorded, ...derived];
  if (botPushes.length === 0) return { botPushes };
  return { botPushes, inRange: await pushesInRange(input, input.rangeBase, botPushes) };
}

/** US-005: the push facts each half of the review environment needs, or nothing to add. */
interface ReviewPushFacts {
  readonly prompt: { readonly botPushes?: readonly BotPushEntry[] };
  readonly post: {
    readonly botPushes?: readonly BotPushEntry[];
    readonly worktree?: string;
    /** In-range candidates; carriedOpen still requires evidence of which review the fix saw. */
    readonly carriedFixPushes?: readonly BotPushEntry[];
  };
}

export async function reviewPushFacts(input: ReviewHistoryInput): Promise<ReviewPushFacts> {
  const history = await reviewHistory(input);
  const inRange = history.inRange ?? [];
  return {
    prompt: inRange.length > 0 ? { botPushes: inRange } : {},
    post:
      history.botPushes.length > 0
        ? { botPushes: history.botPushes, worktree: input.worktree, carriedFixPushes: inRange }
        : {},
  };
}
