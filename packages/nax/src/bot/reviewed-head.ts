/**
 * Advance the reviewed head on the bot's own workflow index.
 *
 * The index comment is the only place the reviewed pair is recorded, so advancing it is what lets
 * the next review narrow its range. The write is a re-read followed by an edit: another writer
 * (a workflow re-publish) may have moved the index since this review read it, and its value wins.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { editComment, type ForgeDeps, listPrComments, type PrComment, type PrRef, withNaxBotMarker } from "@/forge";
import { getLogger } from "@/logger";
import { readItemThreads } from "../workflow/item-thread-state";
import { type ItemIndex, parseItemIndexSettled, renderItemIndex } from "../workflow/item-threads";

export interface AdvanceReviewedHeadInput {
  readonly ref: PrRef;
  readonly login: string;
  /** `reviewedHead` of the index this review read at preparation; undefined when that index had none. */
  readonly expectedHead: string | undefined;
  /** The head the review just covered (`info.headSha`). */
  readonly head: string;
  /** The merge base the review diffed against (`checkout.mergeBase`). */
  readonly base: string;
  readonly deps: ForgeDeps;
  readonly cwd: string;
}

export type AdvanceReviewedHeadOutcome =
  | { readonly kind: "advanced" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "skipped"; readonly reason: "invalid-sha" | "no-index" | "unparseable" | "moved" }
  | { readonly kind: "failed" };

export const _reviewedHeadDeps = { listPrComments, editComment };

/** A commit the index can name: the reviewed head and the merge base the review diffed against. */
const SHA_PATTERN = /^[a-fA-F0-9]{40}$/;

function warn(message: string, data: Record<string, unknown>): void {
  getLogger()?.warn("bot-reviewed-head", `[bot-reviewed-head] ${message}`, data);
}

/** The PR's top-level comments; null when the forge read failed. */
async function readComments(input: AdvanceReviewedHeadInput): Promise<readonly PrComment[] | null> {
  try {
    return await _reviewedHeadDeps.listPrComments(input.ref, input.deps, input.cwd);
  } catch (error) {
    warn("Could not read the PR comments to advance the reviewed head", {
      pr: input.ref.number,
      error: errorMessage(error),
    });
    return null;
  }
}

/** Re-render the re-read index with the reviewed pair this review covered, and edit it in place. */
async function writeIndex(
  input: AdvanceReviewedHeadInput,
  comment: PrComment,
  fresh: ItemIndex,
): Promise<AdvanceReviewedHeadOutcome> {
  const settled = parseItemIndexSettled(comment.body) ?? 0;
  const body = withNaxBotMarker(
    renderItemIndex({ ...fresh, reviewedHead: input.head, reviewedBase: input.base }, settled),
    "w-index",
  );
  try {
    await _reviewedHeadDeps.editComment(input.ref, comment, body, input.deps, input.cwd);
  } catch (error) {
    warn("Could not advance the reviewed head", { pr: input.ref.number, error: errorMessage(error) });
    return { kind: "failed" };
  }
  return { kind: "advanced" };
}

/**
 * Advance the reviewed head of the bot's own `w-index` comment, keeping the rest of that index.
 *
 * Nothing is written unless the re-read index still names the reviewed head this review read: a
 * writer that moved the index in between owns it, and the next review falls back to the wider range.
 */
export async function advanceReviewedHead(input: AdvanceReviewedHeadInput): Promise<AdvanceReviewedHeadOutcome> {
  if (!SHA_PATTERN.test(input.head) || !SHA_PATTERN.test(input.base)) {
    return { kind: "skipped", reason: "invalid-sha" };
  }
  const comments = await readComments(input);
  if (!comments) return { kind: "failed" };
  // The reader that owns the own `w-index` comment owns its parsed index too; no threads are needed here.
  const read = readItemThreads([], comments, input.login);
  const fresh = read.index;
  if (!read.indexComment) return { kind: "skipped", reason: "no-index" };
  if (!fresh) return { kind: "skipped", reason: "unparseable" };
  if (fresh.reviewedHead !== input.expectedHead) {
    warn("The item index moved; the reviewed head it names wins", { pr: input.ref.number });
    return { kind: "skipped", reason: "moved" };
  }
  if (fresh.reviewedHead === input.head && fresh.reviewedBase === input.base) return { kind: "unchanged" };
  return writeIndex(input, read.indexComment, fresh);
}
