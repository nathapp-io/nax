/** Record collaborator rulings durably on the PR; body ticks are best-effort presentation only. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { ForgeDeps } from "@/forge";
import {
  editComment,
  hasWriteAccess,
  ownComments,
  parseNaxBotMarker,
  readPrInfo,
  replyToThread,
  resolveThread,
  withNaxBotMarker,
} from "@/forge";
import type { PrComment, PrInfo, PrRef, PrThread } from "@/forge/pr-types";
import { getLogger } from "@/logger";
import { RULING_SHA_PATTERN } from "@/utils/ruling-sha";
import type { BotRulingReadInput, BotRulingReadVerdict } from "../operations/bot-ruling-read";
import { type DecisionEntry, sidecarKindFor } from "../workflow/decisions-sidecar";
import type { ItemThread, ReadItemThreads, SettledItems } from "../workflow/item-thread-state";
// Workflow leaves avoid pulling feature orchestration into the bot recorder.
import { readItemThreads, settleItemThreads, unindexedItemKeys } from "../workflow/item-thread-state";
import type { ItemIndex, PrRuling } from "../workflow/item-threads";
import {
  askKey,
  isOpenItemKind,
  parseItemFiles,
  parseItemOpener,
  renderItemIndex,
  renderRulingAsk,
  renderRulingEcho,
} from "../workflow/item-threads";
import { editBodyArgv, hasChecklistItem, tickChecklist } from "../workflow/promote";
import { parseRulingKeyword } from "../workflow/ruling-keyword";
import {
  CallerRecordingError,
  type CallerRuling,
  type CallerRulingsPlan,
  type CallerRulingsReport,
  planCallerRulings,
} from "./caller-rulings";
import { isConfirmingRuling, latestFindingRuling } from "./finding-rulings";
import { writerCheck } from "./writers";

export const MAX_RULING_ITEMS = 20;
type OpenRulingItem = SettledItems["open"][number];

export interface RecordRulingsInput {
  readonly ref: PrRef;
  readonly info: PrInfo;
  readonly login: string;
  readonly threads: Parameters<typeof readItemThreads>[0];
  readonly comments: readonly PrComment[];
  readonly deps: ForgeDeps;
  readonly cwd: string;
  readonly readModel: (input: BotRulingReadInput) => Promise<BotRulingReadVerdict | null>;
  /** Validated `--rulings` entries for this head; each acts as an authorized candidate for its item. */
  readonly callerRulings?: readonly CallerRuling[];
}

export interface RecordRulingsOutcome {
  readonly index?: ItemIndex;
  /** Owned threads omitted from the index without a durable obsolete-thread closure. */
  readonly unindexed?: readonly string[];
  readonly recorded: readonly PrRuling[];
  readonly settled: SettledItems["settled"];
  /** Confirmed advisor changes still awaiting a fix reply; absent when empty. */
  readonly confirmedWork?: readonly (ItemThread & { readonly ruling: PrRuling })[];
  readonly open: SettledItems["open"];
  readonly asked: number;
  readonly failed: number;
  /** Present only when caller rulings were supplied. */
  readonly callerRulings?: Pick<CallerRulingsReport, "applied" | "skipped">;
}

export const _rulingsDeps = {
  editComment,
  hasWriteAccess,
  readPrInfo,
  replyToThread,
  resolveThread,
  tickChecklist,
  getLogger,
};

function warn(message: string, data: Record<string, unknown>): void {
  _rulingsDeps.getLogger()?.warn("bot-rulings", `[bot-rulings] ${message}`, data);
}

/**
 * The permission gate settlement checks need; the input is any of the recorder's shapes.
 * Cache the promise, not just the result: settlement checks replies concurrently.
 */
function permissionReader(input: {
  readonly ref: RecordRulingsInput["ref"];
  readonly deps: RecordRulingsInput["deps"];
  readonly cwd: string;
}): (comment: PrComment) => Promise<boolean> {
  const check = writerCheck(
    input,
    (...args) => _rulingsDeps.hasWriteAccess(...args),
    (login, error) => warn("Could not check ruling permission", { login, error }),
  );
  return (comment) => check({ login: comment.author, id: comment.authorId });
}

async function resolve(input: RecordRulingsInput, item: ItemThread): Promise<void> {
  try {
    await _rulingsDeps.resolveThread(input.ref, item.thread, input.deps, input.cwd);
  } catch (error) {
    warn("Could not resolve settled item", {
      itemId: item.itemId,
      threadId: item.thread.id,
      error: errorMessage(error),
    });
  }
}

async function postEcho(input: RecordRulingsInput, item: ItemThread, ruling: PrRuling): Promise<boolean> {
  try {
    const body = withNaxBotMarker(renderRulingEcho(ruling), `wr-${ruling.disposition}-${item.key}`);
    await _rulingsDeps.replyToThread(input.ref, item.thread, body, input.deps, input.cwd);
    return true;
  } catch (error) {
    warn("Could not record ruling echo", { itemId: item.itemId, threadId: item.thread.id, error: errorMessage(error) });
    return false;
  }
}

function checklistEntries(body: string, settled: SettledItems["settled"]): DecisionEntry[] {
  return settled.flatMap((item) => {
    if (!isOpenItemKind(item.kind) || !hasChecklistItem(body, item.itemId)) return [];
    const kind = sidecarKindFor({ id: item.itemId, kind: item.kind, issue: "" });
    const { disposition, reason, sha } = item.ruling;
    return [{ id: item.itemId, kind, disposition, reason, ...(disposition === "fixed" && sha ? { sha } : {}) }];
  });
}

async function tickBody(input: RecordRulingsInput, settled: SettledItems["settled"]): Promise<void> {
  if (!settled.length) return;
  try {
    const current = await _rulingsDeps.readPrInfo(input.ref, input.deps, input.cwd);
    const ticked = _rulingsDeps.tickChecklist(current.body, checklistEntries(current.body, settled));
    if (ticked.body === current.body) return;
    const result = await input.deps.run(editBodyArgv(input.ref.forge, current.url, ticked.body), {
      cwd: input.cwd,
    });
    if (result.exitCode !== 0) warn("Could not edit checklist body", { ref: input.ref, error: result.stderr });
  } catch (error) {
    warn("Could not update checklist body", { ref: input.ref, error: errorMessage(error) });
  }
}

function modelCandidate(item: OpenRulingItem, entry?: BotRulingReadVerdict["rulings"][number]): PrRuling | null {
  const reply = item.kept.at(-1);
  if (!reply || !entry || entry.disposition === "none") return null;
  const collapse = (text: string) => text.replace(/\s+/g, " ").trim();
  const quote = collapse(entry.quote);
  const reason = entry.reason.trim();
  if (!quote || !collapse(reply.body).includes(quote) || !reason || /[\r\n]/.test(reason)) return null;
  const sha = entry.sha?.trim() ?? "";
  if (entry.disposition === "fixed" && (!RULING_SHA_PATTERN.test(sha) || !reply.body.includes(sha))) return null;
  return {
    itemKey: item.key,
    itemId: item.itemId,
    disposition: entry.disposition,
    reason,
    by: reply.author,
    ...(entry.disposition === "fixed" ? { sha } : {}),
  };
}

async function ask(input: RecordRulingsInput, item: OpenRulingItem): Promise<"asked" | "failed" | "existing"> {
  const key = askKey(item.key, item.kept.at(-1)?.id ?? "");
  if (ownComments(item.thread.comments, input.login).some((own) => own.key === key)) return "existing";
  try {
    await _rulingsDeps.replyToThread(
      input.ref,
      item.thread,
      withNaxBotMarker(renderRulingAsk(), key),
      input.deps,
      input.cwd,
    );
    return "asked";
  } catch (error) {
    warn("Could not post ruling clarification", { itemId: item.itemId, error: errorMessage(error) });
    return "failed";
  }
}

function modelItems(batch: readonly OpenRulingItem[]): BotRulingReadInput["items"] {
  return batch.flatMap((item) => {
    const reply = item.kept.at(-1);
    const opener = parseItemOpener(item.thread.comments[0]?.body ?? "");
    if (!opener) return []; // Only parsed, owned item openers are model inputs.
    const issue = opener.issue;
    return reply
      ? [{ id: item.itemId, kind: item.kind, issue, reply: { id: reply.id, author: reply.author, body: reply.body } }]
      : [];
  });
}

async function readModelCandidates(input: RecordRulingsInput, open: SettledItems["open"]) {
  const batch = open
    .filter((item) => {
      const reply = item.kept.at(-1);
      return reply && !parseRulingKeyword(reply.body);
    })
    .slice(0, MAX_RULING_ITEMS);
  const candidates = new Map<OpenRulingItem, PrRuling>();
  const result = { candidates, asked: 0, failed: 0 };
  if (!batch.length) return result;
  let verdict: BotRulingReadVerdict | null;
  try {
    verdict = await input.readModel({ items: modelItems(batch) });
  } catch (error) {
    warn("Could not read model rulings", { error: errorMessage(error) });
    return result;
  }
  if (!verdict) return result;
  for (const item of batch) {
    const ruling = modelCandidate(
      item,
      verdict.rulings.find((entry) => entry.id === item.itemId),
    );
    if (ruling) candidates.set(item, ruling);
    else {
      const posted = await ask(input, item);
      if (posted !== "existing") result[posted]++;
    }
  }
  return result;
}

async function refreshIndex(
  input: RecordRulingsInput,
  read: ReadItemThreads,
  settled: SettledItems["settled"],
): Promise<void> {
  if (!read.index || !read.indexComment) return;
  const keys = new Set(read.index.keys);
  const count = new Set(settled.filter((item) => keys.has(item.key)).map((item) => item.key)).size;
  const body = withNaxBotMarker(renderItemIndex(read.index, count), "w-index");
  if (body === read.indexComment.body) return;
  try {
    await _rulingsDeps.editComment(input.ref, read.indexComment, body, input.deps, input.cwd);
  } catch (error) {
    warn("Could not refresh the item index", { error: errorMessage(error) });
  }
}

function isConfirmedWork(item: ItemThread & { readonly ruling: PrRuling }): boolean {
  return item.kind === "advisor" && item.ruling.disposition === "confirmed" && !item.fixClosed;
}

function renewedRuling(item: ItemThread, ruling: PrRuling): ItemThread & { readonly ruling: PrRuling } {
  // A new echo starts a new cycle: an older fix cannot answer this ruling.
  const { fixClosed: _previousFix, ...current } = item;
  return { ...current, ruling };
}

/** The ruling an authorized writer's newest kept reply states, if its first line is a keyword. */
function replyRuling(item: OpenRulingItem): PrRuling | undefined {
  const newest = item.kept.at(-1);
  const keyword = newest ? parseRulingKeyword(newest.body) : null;
  return keyword && newest ? { ...keyword, itemKey: item.key, itemId: item.itemId, by: newest.author } : undefined;
}

/** Everything the per-item loop accumulates; a failure part-way still reports it. */
interface RulingProgress {
  readonly open: SettledItems["open"][number][];
  readonly recorded: PrRuling[];
  readonly settled: SettledItems["settled"][number][];
  readonly confirmedWork: (ItemThread & { readonly ruling: PrRuling })[];
  readonly echoFailed: string[];
  failed: number;
}

function callerReport(
  plan: CallerRulingsPlan,
  progress: RulingProgress,
  unreached: boolean,
): Pick<CallerRulingsReport, "applied" | "skipped"> {
  const applied = progress.recorded
    .filter((ruling) => ruling.callerBy !== undefined)
    .map(({ itemId, disposition }) => ({ item: itemId, disposition }));
  const done = new Set([...applied.map(({ item }) => item), ...progress.echoFailed]);
  const notReached = unreached
    ? [...plan.candidates.values()].filter(({ itemId }) => !done.has(itemId)).map(({ itemId }) => itemId)
    : [];
  return {
    applied,
    skipped: [
      ...plan.skipped,
      ...progress.echoFailed.map((item) => ({ item, reason: "echo-failed" as const })),
      ...notReached.map((item) => ({ item, reason: "recorder-failed" as const })),
    ],
  };
}

/**
 * US-011: a `verified` ruling on an item whose opener lists files records the head the bot sees when it
 * records the ruling, so the approval names the commit it covered. A caller ruling is already exact (its
 * file's `headSha` must equal the PR head); a thread reply carries no head, so a push between the reply
 * and this recording is credited as read. Items with no file list, every other disposition and a ruling
 * that already carries a sha are left untouched. Only indexed, owned openers reach `ruleItem`
 * (`readThread` rejects anything else), so the opener's Files block is the run's own.
 *
 * A head the echo grammar could not carry back (`RULING_SHA_PATTERN`) is not stamped: the ruling would
 * be recorded against a commit no reader could recover, so it records no head at all.
 */
function stampVerifiedHead(input: RecordRulingsInput, item: OpenRulingItem, ruling: PrRuling): PrRuling {
  if (ruling.disposition !== "verified" || ruling.sha !== undefined) return ruling;
  if (!RULING_SHA_PATTERN.test(input.info.headSha)) return ruling;
  if (parseItemFiles(item.thread.comments[0]?.body ?? "").length === 0) return ruling;
  return { ...ruling, sha: input.info.headSha };
}

async function ruleItem(
  input: RecordRulingsInput,
  item: OpenRulingItem,
  ruling: PrRuling | undefined,
  progress: RulingProgress,
): Promise<void> {
  if (!ruling) {
    progress.open.push(item);
    return;
  }
  const stamped = stampVerifiedHead(input, item, ruling);
  if (!(await postEcho(input, item, stamped))) {
    progress.open.push(item);
    if (stamped.callerBy !== undefined) progress.echoFailed.push(item.itemId);
    progress.failed++;
    return;
  }
  progress.recorded.push(stamped);
  const entry = renewedRuling(item, stamped);
  if (isConfirmedWork(entry)) progress.confirmedWork.push(entry);
  else {
    progress.settled.push(entry);
    await resolve(input, item);
  }
}

/** Only successful echoes count as newly recorded; resolution failure never undoes an echo. */
export async function recordPrRulings(input: RecordRulingsInput): Promise<RecordRulingsOutcome> {
  const read = readItemThreads(input.threads, input.comments, input.login);
  const initial = await settleItemThreads(read, permissionReader(input));
  const caller = input.callerRulings === undefined ? undefined : planCallerRulings(input.callerRulings, initial);
  // A caller ruling decides its item outright; an item it does not decide (including one a newer writer reply
  // supersedes) keeps the normal reply, model and ask path.
  const model = await readModelCandidates(
    input,
    initial.open.filter((item) => !caller?.candidates.has(item)),
  );
  const progress: RulingProgress = {
    open: [],
    recorded: [],
    settled: initial.settled.filter((item) => !isConfirmedWork(item)),
    confirmedWork: initial.settled.filter(isConfirmedWork),
    echoFailed: [],
    failed: model.failed,
  };
  try {
    for (const item of progress.settled) {
      if (!item.thread.resolved) await resolve(input, item);
    }
    for (const item of initial.open) {
      await ruleItem(
        input,
        item,
        caller?.candidates.get(item) ?? replyRuling(item) ?? model.candidates.get(item),
        progress,
      );
    }
    await tickBody(input, progress.settled);
    await refreshIndex(input, read, progress.settled);
    const unindexed = unindexedItemKeys(read, input.login);
    return {
      ...(read.index ? { index: read.index } : {}),
      ...(unindexed.length ? { unindexed } : {}),
      recorded: progress.recorded,
      settled: progress.settled,
      ...(progress.confirmedWork.length ? { confirmedWork: progress.confirmedWork } : {}),
      open: progress.open,
      asked: model.asked,
      failed: progress.failed,
      ...(caller === undefined ? {} : { callerRulings: callerReport(caller, progress, false) }),
    };
  } catch (error) {
    if (caller === undefined) throw error;
    throw new CallerRecordingError(error, callerReport(caller, progress, true));
  }
}

export type SettlementReadInput = Omit<RecordRulingsInput, "readModel" | "callerRulings">;

/**
 * A finding thread the bot opened that is not an indexed item. `recordFindingRulings` owns these: the
 * newest authorized writer ruling decides, and thread resolution is presentation on top of it. Reading
 * resolution alone disagreed with the recorder twice:
 *
 * - an authorized non-confirming ruling (waive, override, fixed) settles the finding whether or not the
 *   thread was resolved, so a waiver whose presentation-only resolve failed still lifts the hold (B1);
 * - a confirmed or verified ruling reconfirms outstanding work, so a resolved thread does not settle a
 *   finding an authorized writer has since reconfirmed (B5).
 *
 * Without an authorized ruling, resolution alone settles the thread, as before. Only own openers count,
 * and an indexed item is skipped: its ruling echo settles it, never a bare thread resolution.
 */
async function settledFindingKeys(
  threads: readonly PrThread[],
  login: string,
  canRule: (comment: PrComment) => Promise<boolean>,
): Promise<string[]> {
  const settled: string[] = [];
  for (const thread of threads) {
    const first = thread.comments[0];
    if (first === undefined || first.author !== login) continue;
    if (parseItemOpener(first.body) !== null) continue;
    const key = parseNaxBotMarker(first.body)?.key;
    if (key === undefined) continue;
    const ruling = await latestFindingRuling({ login, isWriter: canRule }, thread);
    if (ruling === null ? thread.resolved : !isConfirmingRuling(ruling.keyword)) settled.push(key);
  }
  return settled;
}

/**
 * US-001: what a durable, permission-checked settlement has closed on the PR *now*, read without
 * recording anything (no echo, no model read, no comment write). The readiness hold reconciles the
 * immutable artifact's open findings against this, so a ruling written after that review lifts it.
 *
 * A reply only keeps its item settled when an authorized writer wrote it, exactly as the recorder
 * decides; an unreadable permission check settles nothing.
 */
export async function readSettledKeys(input: SettlementReadInput): Promise<ReadonlySet<string>> {
  const read = readItemThreads(input.threads, input.comments, input.login);
  // One reader for both: an author's write access is looked up once per login.
  const canRule = permissionReader(input);
  const [settled, findings] = await Promise.all([
    settleItemThreads(read, canRule),
    settledFindingKeys(input.threads, input.login, canRule),
  ]);
  return new Set([...settled.settled.map(({ key }) => key), ...findings]);
}
