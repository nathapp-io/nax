/** Publish owned item threads, maintain their durable index, and close obsolete threads. */
import { posix } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { PROJECT_FEATURES_DIR } from "@/config";
import {
  type ForgeDeps,
  listPrComments,
  listReviewThreads,
  postInlineComment,
  postItemComment,
  prNumberFromUrl,
  readCurrentUser,
  readPrInfo,
  resolvePrRef,
  withNaxBotMarker,
} from "@/forge";
import type { PrInfo, PrRef } from "@/forge/pr-types";
import { getLogger } from "@/logger";
import { _featureDeps } from "./feature-deps";
import { readItemThreads } from "./item-thread-state";
import { isPostable, itemKey, renderItemOpener } from "./item-threads";
import { maintainItemIndex } from "./item-threads-index";
import { reopenReraisedItems } from "./item-threads-reopen";
import { buildOpenItems } from "./open-items";
import type { OpenItem, WorkflowFeatureRecord } from "./types";

export interface ItemThreadsInput {
  readonly record: WorkflowFeatureRecord;
  readonly url: string;
  readonly head?: string;
  readonly projectDir: string;
  readonly feature: string;
  readonly changedFiles: readonly string[];
}

export interface ItemThreadsOutcome {
  readonly posted: number;
  readonly closed: number;
  readonly skipped: number;
  readonly failed: number;
}

interface PostingContext {
  readonly ref: PrRef;
  readonly info: PrInfo;
  readonly deps: ForgeDeps;
  readonly cwd: string;
  readonly anchor?: string;
}

function warn(identity: string | { feature: string }, message: string, error?: unknown): void {
  getLogger()?.warn("item-threads", message, {
    ...(typeof identity === "string" ? { itemId: identity } : identity),
    ...(error === undefined ? {} : { error: errorMessage(error) }),
  });
}

async function attempt(item: OpenItem, post: () => Promise<unknown>): Promise<boolean> {
  try {
    await post();
    return true;
  } catch (error) {
    warn(item.id, "[item-threads] Posting attempt failed", error);
    return false;
  }
}

async function postItem(item: OpenItem, context: PostingContext): Promise<boolean> {
  const { ref, info, deps, cwd, anchor } = context;
  const body = withNaxBotMarker(renderItemOpener(item), itemKey(item));
  const common = { body, headSha: info.headSha };
  if (item.file && item.line !== undefined) {
    const inline = { ...common, path: item.file, line: item.line, diffRefs: info.diffRefs };
    if (await attempt(item, () => postInlineComment(ref, inline, deps, cwd))) return true;
    if (await attempt(item, () => postItemComment(ref, { ...common, path: inline.path }, deps, cwd))) return true;
  }
  if (anchor === undefined && ref.forge === "github") {
    warn(item.id, "[item-threads] No changed file available for item anchor");
    return false;
  }
  return attempt(item, () => postItemComment(ref, { ...common, path: anchor ?? "" }, deps, cwd));
}

/** Read everything before writing: an incomplete ownership snapshot must never create duplicates. */
async function readContext(input: ItemThreadsInput, deps: ForgeDeps) {
  const number = prNumberFromUrl(input.url);
  if (number === null) {
    warn({ feature: input.feature }, "[item-threads] Cannot read PR number from URL");
    return null;
  }
  try {
    const ref = await resolvePrRef(number, deps, input.projectDir);
    const info = await readPrInfo(ref, deps, input.projectDir);
    const [user, threads, comments] = await Promise.all([
      readCurrentUser(ref, deps, input.projectDir),
      listReviewThreads(ref, deps, input.projectDir),
      listPrComments(ref, deps, input.projectDir),
    ]);
    return { ref, info, login: user.login, read: readItemThreads(threads, comments, user.login) };
  } catch (error) {
    warn({ feature: input.feature }, "[item-threads] Initial PR read failed; posting nothing", error);
    return null;
  }
}

export async function postItemThreads(
  input: ItemThreadsInput,
  deps: ForgeDeps = _featureDeps.forge,
): Promise<ItemThreadsOutcome> {
  const snapshot = await readContext(input, deps);
  if (!snapshot) return { posted: 0, closed: 0, skipped: 0, failed: 1 };
  const prd = posix.join(PROJECT_FEATURES_DIR, input.feature, "prd.json");
  const anchor = input.changedFiles.includes(prd) ? prd : input.changedFiles[0];
  const context: PostingContext = { ...snapshot, deps, cwd: input.projectDir, anchor };
  const owned = new Set(snapshot.read.items.map((item) => item.key));
  const outcome = { posted: 0, closed: 0, skipped: 0, failed: 0 };
  const items = buildOpenItems(input.record).filter((item) => item.kind !== "ci");
  for (const item of items) {
    const key = itemKey(item);
    if (!isPostable(item)) {
      warn(item.id, "[item-threads] Skipping non-postable item");
      outcome.skipped++;
    } else if (owned.has(key)) {
      outcome.skipped++;
    } else if (await postItem(item, context)) {
      outcome.posted++;
      owned.add(key);
    } else {
      outcome.failed++;
    }
  }
  const keys = items.map(itemKey);
  const maintenance = { ...snapshot, deps, cwd: input.projectDir };
  const reopen = await reopenReraisedItems(input, keys, maintenance);
  outcome.failed += reopen.failed;
  const settled = new Set(
    snapshot.read.items
      .filter((item) => item.ruling && item.replies.length === 0 && !reopen.reopened.has(item.key))
      .map((item) => item.key),
  );
  const index = await maintainItemIndex(input, keys, maintenance, {
    keepReviewed: reopen.failed > 0,
    pendingReopens: reopen.pendingReopens,
    settled: keys.filter((key) => settled.has(key)).length,
  });
  return { ...outcome, closed: index.closed, failed: outcome.failed + index.failed };
}
