/** Record collaborator rulings durably on the PR; body ticks are best-effort presentation only. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { ForgeDeps } from "@/forge";
import {
  editComment,
  hasWriteAccess,
  ownComments,
  readPrInfo,
  replyToThread,
  resolveThread,
  withNaxBotMarker,
} from "@/forge";
import type { PrComment, PrInfo, PrRef } from "@/forge/pr-types";
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
  parseItemOpener,
  renderItemIndex,
  renderRulingAsk,
  renderRulingEcho,
} from "../workflow/item-threads";
import { editBodyArgv, hasChecklistItem, tickChecklist } from "../workflow/promote";
import { parseRulingKeyword } from "../workflow/ruling-keyword";
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

/** Cache the promise, not just the result: settlement checks replies concurrently. */
function permissionReader(input: RecordRulingsInput): (comment: PrComment) => Promise<boolean> {
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

/** Only successful echoes count as newly recorded; resolution failure never undoes an echo. */
export async function recordPrRulings(input: RecordRulingsInput): Promise<RecordRulingsOutcome> {
  const read = readItemThreads(input.threads, input.comments, input.login);
  const initial = await settleItemThreads(read, permissionReader(input));
  const settled = initial.settled.filter((item) => !isConfirmedWork(item));
  const confirmedWork = initial.settled.filter(isConfirmedWork);
  const open: SettledItems["open"][number][] = [];
  const recorded: PrRuling[] = [];
  const model = await readModelCandidates(input, initial.open);
  let failed = model.failed;
  for (const item of settled) {
    if (!item.thread.resolved) await resolve(input, item);
  }
  for (const item of initial.open) {
    const newest = item.kept.at(-1);
    const keyword = newest ? parseRulingKeyword(newest.body) : null;
    const ruling: PrRuling | undefined =
      keyword && newest
        ? { ...keyword, itemKey: item.key, itemId: item.itemId, by: newest.author }
        : model.candidates.get(item);
    if (!ruling) {
      open.push(item);
      continue;
    }
    if (!(await postEcho(input, item, ruling))) {
      open.push(item);
      failed++;
      continue;
    }
    recorded.push(ruling);
    const entry = renewedRuling(item, ruling);
    if (isConfirmedWork(entry)) confirmedWork.push(entry);
    else {
      settled.push(entry);
      await resolve(input, item);
    }
  }
  await tickBody(input, settled);
  await refreshIndex(input, read, settled);
  const unindexed = unindexedItemKeys(read, input.login);
  return {
    ...(read.index ? { index: read.index } : {}),
    ...(unindexed.length ? { unindexed } : {}),
    recorded,
    settled,
    ...(confirmedWork.length ? { confirmedWork } : {}),
    open,
    asked: model.asked,
    failed,
  };
}
