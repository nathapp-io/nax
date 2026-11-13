/** Publish owned item threads, maintain their durable index, and close obsolete threads. */
import { posix } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { PROJECT_FEATURES_DIR, WORKFLOW_ITEM_PUBLISH_DEFAULTS } from "@/config";
import {
  type ForgeDeps,
  listPrComments,
  listReviewThreads,
  ownComments,
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
import { createItemPublishPacer, type ItemPublishConfig, type ItemPublishPacer } from "./item-publish-pacer";
import { type ReadItemThreads, readItemThreads } from "./item-thread-state";
import { isPostable, itemKey, renderItemOpener } from "./item-threads";
import { type IndexContext, type IndexWriteFailure, maintainItemIndex } from "./item-threads-index";
import { type ReopenContext, reopenReraisedItems } from "./item-threads-reopen";
import { buildOpenItems } from "./open-items";
import type { OpenItem, WorkflowFeatureRecord } from "./types";

export interface ItemThreadsInput {
  readonly record: WorkflowFeatureRecord;
  readonly url: string;
  readonly head?: string;
  readonly projectDir: string;
  readonly feature: string;
  readonly changedFiles: readonly string[];
  /** US-002: the publish's pacing; absent reads as `WORKFLOW_ITEM_PUBLISH_DEFAULTS`. */
  readonly pacing?: ItemPublishConfig;
}

export interface ItemThreadsOutcome {
  readonly posted: number;
  readonly closed: number;
  readonly skipped: number;
  readonly failed: number;
  /** US-002: this publish's final index write succeeded. */
  readonly indexWritten: boolean;
  /**
   * US-002/B1: true only when the PR is *known* to have no `w-index` comment after this publish.
   * Absent when the publish cannot tell — an index write that may have landed and a readback that
   * then failed — so the record keeps any earlier answer instead of clearing it with a `false`.
   */
  readonly indexMissing?: boolean;
}

interface PostingContext {
  readonly ref: PrRef;
  readonly info: PrInfo;
  readonly deps: ForgeDeps;
  readonly cwd: string;
  readonly anchor?: string;
  readonly pacer: ItemPublishPacer;
}

/** The maintenance context both later phases share, so an index created by one is reused by the other. */
type MaintenanceContext = IndexContext & ReopenContext;

const STAGE = "item-threads";
const BUDGET_SPENT = "[item-threads] Pacing budget spent; skipping remaining threads";

function warn(identity: string | { feature: string }, message: string, error?: unknown): void {
  getLogger()?.warn(STAGE, message, {
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
  const { ref, info, deps, cwd, anchor, pacer } = context;
  const body = withNaxBotMarker(renderItemOpener(item), itemKey(item));
  const common = { body, headSha: info.headSha };
  /** A file-level post: the configured retries apply, so a rejection that stays is retried. */
  const postFile = (path: string) =>
    pacer.write(() => postItemComment(ref, { ...common, path }, deps, cwd), { itemId: item.id });
  const { file, line } = item;
  if (file !== undefined && line !== undefined) {
    const inline = { ...common, path: file, line, diffRefs: info.diffRefs };
    // A line outside the diff answers HTTP 422, which no back-off can fix, so the inline attempt
    // takes no retry: the file-level fallback runs at once.
    const postInline = () =>
      pacer.write(() => postInlineComment(ref, inline, deps, cwd), { itemId: item.id, retries: 0 });
    if (await attempt(item, postInline)) return true;
    if (await attempt(item, () => postFile(file))) return true;
  }
  if (anchor === undefined && ref.forge === "github") {
    warn(item.id, "[item-threads] No changed file available for item anchor");
    return false;
  }
  return attempt(item, () => postFile(anchor ?? ""));
}

/**
 * Count and name what a spent budget leaves unsent: the item whose gap was refused, plus every later
 * postable item this publish does not own yet. Returns the count it does not already own.
 */
function stopThreads(rest: readonly OpenItem[], owned: ReadonlySet<string>): number {
  const unposted = rest.filter((item) => isPostable(item) && !owned.has(itemKey(item))).length;
  getLogger()?.warn(STAGE, BUDGET_SPENT, { skipped: unposted + 1 });
  return unposted;
}

/**
 * Whether this publish leaves the PR with no index comment at all. A failed write alone cannot say
 * so: `gh` can accept an index and still answer with a reply this code cannot parse, which records
 * no posted name. Absence is therefore read back off the PR instead of inferred.
 *
 * A readback that fails leaves the writes' own evidence: absence is known only if every index write
 * was refused. A final refusal cannot disprove that an earlier pre-notice write landed. Any write
 * that may have landed leaves the answer `undefined` — neither a confirmed presence nor a licence
 * to clear an earlier `itemIndexMissing`.
 */
async function indexIsMissing(options: {
  readonly feature: string;
  readonly read: ReadItemThreads;
  readonly indexed: boolean;
  readonly failure: IndexWriteFailure | undefined;
  readonly context: MaintenanceContext;
}): Promise<boolean | undefined> {
  const { feature, read, indexed, failure, context } = options;
  if (indexed || read.indexComment !== undefined || context.postedIndex !== undefined) return false;
  try {
    const comments = await listPrComments(context.ref, context.deps, context.cwd);
    return !ownComments(comments, context.login).some(({ key }) => key === "w-index");
  } catch (error) {
    warn({ feature }, "[item-threads] Cannot confirm the index state; reading the failed write instead", error);
    return failure === "refused" && !context.indexWriteUnconfirmed ? true : undefined;
  }
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
  if (!snapshot) return { posted: 0, closed: 0, skipped: 0, failed: 1, indexWritten: false, indexMissing: true };
  const pacer = createItemPublishPacer(input.pacing ?? WORKFLOW_ITEM_PUBLISH_DEFAULTS);
  const prd = posix.join(PROJECT_FEATURES_DIR, input.feature, "prd.json");
  const anchor = input.changedFiles.includes(prd) ? prd : input.changedFiles[0];
  const context: PostingContext = { ...snapshot, deps, cwd: input.projectDir, anchor, pacer };
  const owned = new Set(snapshot.read.items.map((item) => item.key));
  const outcome = { posted: 0, closed: 0, skipped: 0, failed: 0 };
  const items = buildOpenItems(input.record).filter((item) => item.kind !== "ci");
  for (const [index, item] of items.entries()) {
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
      // The budget is the only reason to stop: a rejected item is otherwise left to the next run.
      if (pacer.spent) {
        outcome.failed += stopThreads(items.slice(index + 1), owned);
        break;
      }
    }
  }
  const keys = items.map(itemKey);
  const maintenance: MaintenanceContext = { ...snapshot, deps, cwd: input.projectDir, pacer };
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
  const indexMissing = await indexIsMissing({
    feature: input.feature,
    read: snapshot.read,
    indexed: index.indexed,
    failure: index.indexFailure,
    context: maintenance,
  });
  return {
    ...outcome,
    closed: index.closed,
    failed: outcome.failed + index.failed,
    indexWritten: index.indexed,
    // Only ever a PR that ends the publish with a known answer: an index created by a pre-notice
    // write is on the PR, a stale one still accepts bot commands, uniformly refused writes prove
    // none was created, and an unconfirmed one states no key at all rather than a `false` nobody can stand
    // behind (B1).
    ...(indexMissing === undefined ? {} : { indexMissing }),
  };
}
