/**
 * The append-only copy of each recorded push (B1).
 *
 * The `fix-summary` comment is written by two nodes — the report node and the ready-only waiver
 * rewrite — and every write replaces the whole body. The forge offers no conditional update, so a
 * write built from a read taken a moment earlier can erase an entry another run recorded in between,
 * and no amount of re-reading at write time closes that window: the write carries whatever it read.
 *
 * A *posted* comment cannot be rewritten by those writers at all, so each push also posts one record
 * of its own, keyed by its full sha, holding the same block the summary carries. The summary's block
 * stays the readable record the spec describes; these comments are the copy none of its writers can
 * erase, and every reader that needs the pushes takes the two together (`ownLedgerEntries`).
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { OwnComment } from "@/forge";
import { getLogger } from "@/logger";
import { FIX_SUMMARY_KEY } from "./ci-waiver-ready";
import type { BotFixEnv } from "./fix-steps";
import {
  type BotPushEntry,
  fitted,
  mergeLedgerEntries,
  pushRecordBody,
  pushRecordEntries,
  readPushLedger,
} from "./push-ledger";

/** The summary body the record is read beside; absent means the PR has no published summary yet. */
function summaryEntries(own: readonly OwnComment[]): readonly BotPushEntry[] {
  const body = own.find(({ key, threadId }) => key === FIX_SUMMARY_KEY && threadId === undefined)?.comment.body;
  return body === undefined ? [] : readPushLedger(body).entries;
}

/**
 * Every push the bot recorded on this PR, in push order: the block the `fix-summary` carries and the
 * append-only copies beside it. A rewrite that dropped an entry from the block leaves it here, so
 * lineage, the push count and the fixer's facts still see the push. The union is held to the same
 * retention as the summary (entry cap, then encoded size), so a push the summary evicted does not
 * come back into lineage or prompt work; the backup comments themselves are left alone.
 */
export function ownLedgerEntries(own: readonly OwnComment[]): readonly BotPushEntry[] {
  return fitted(mergeLedgerEntries(summaryEntries(own), pushRecordEntries(own)));
}

/** The post seam, so the caller's `_fixReportDeps` stub observes the record exactly like any comment. */
export type PushRecordPost = (
  ref: BotFixEnv["ref"],
  body: string,
  deps: BotFixEnv["forge"],
  cwd: string,
) => Promise<unknown>;

export interface PushRecordInput {
  readonly env: BotFixEnv;
  readonly entry: BotPushEntry;
  /** The records the write-time read already found: a push is posted once, however often it is reported. */
  readonly recorded: readonly BotPushEntry[];
  readonly post: PushRecordPost;
}

/**
 * Post this push's record unless the PR already holds one. A failed post is a warning, not a failed
 * report: the summary's own block still carries the entry, and the next write re-reads it.
 */
export async function recordPush({ env, entry, recorded, post }: PushRecordInput): Promise<void> {
  if (recorded.some(({ sha }) => sha === entry.sha)) return;
  try {
    await post(env.ref, pushRecordBody(entry), env.forge, env.repoRoot);
  } catch (error) {
    getLogger()?.warn("bot-fix", "Could not post the record of this push", {
      pr: env.ref.number,
      sha: entry.sha,
      error: errorMessage(error),
    });
  }
}
