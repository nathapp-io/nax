/** Deterministic, writer-authorized keyword rulings on the bot's own finding threads. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import {
  type ForgeDeps,
  isNaxBotMarkerKey,
  ownComments,
  replyToThread,
  resolveThread,
  withNaxBotMarker,
} from "@/forge";
import type { PrComment, PrRef, PrThread } from "@/forge/pr-types";
import { getLogger } from "@/logger";
import type { BotSettledRuling } from "@/prompts";
import { type PrRuling, renderRulingEcho } from "../workflow/item-threads";
import { parseRulingKeyword, type RulingKeyword } from "../workflow/ruling-keyword";
import { earlierIssue } from "./post-earlier";
import { earlierKey } from "./render";

export interface FindingRulingsInput {
  readonly ref: PrRef;
  readonly login: string;
  readonly threads: readonly PrThread[];
  readonly deps: ForgeDeps;
  readonly cwd: string;
  readonly isWriter: (comment: PrComment) => Promise<boolean>;
}

type FindingRulingEntry = {
  readonly threadId: string;
  readonly ruling: BotSettledRuling;
  /** A bot fix reply after this ruling closed the confirmed work. */
  readonly fixClosed?: boolean;
};
export interface FindingRulingsOutcome {
  readonly settled: readonly FindingRulingEntry[];
  readonly confirmed: readonly FindingRulingEntry[];
  readonly echoed: number;
  readonly failed: number;
}

export const _findingRulingsDeps = { replyToThread, resolveThread, getLogger };

/** Stable echo identity, separate from earlier-finding verdict replies. */
export function findingRulingKey(threadId: string): string {
  return `fr-${earlierKey(threadId).slice(2)}`;
}

function warn(message: string, thread: PrThread, error: unknown): void {
  _findingRulingsDeps.getLogger()?.warn("bot-rulings", `[bot-rulings] ${message}`, {
    threadId: thread.id,
    error: errorMessage(error),
  });
}

interface Candidate {
  readonly keyword: RulingKeyword;
  readonly reply: PrComment;
  readonly index: number;
}

async function lastRuling(input: FindingRulingsInput, thread: PrThread): Promise<Candidate | null> {
  const own = new Set(ownComments(thread.comments, input.login).map(({ comment }) => comment));
  for (let index = thread.comments.length - 1; index > 0; index--) {
    const reply = thread.comments[index];
    if (!reply || own.has(reply)) continue;
    const keyword = parseRulingKeyword(reply.body);
    if (!keyword) continue;
    try {
      if (await input.isWriter(reply)) return { keyword, reply, index };
    } catch (error) {
      // Authorization failure denies this reply, not an earlier authorized ruling.
      warn("Could not check finding ruling permission", thread, error);
    }
  }
  return null;
}

async function echo(input: FindingRulingsInput, thread: PrThread, ruling: PrRuling): Promise<boolean> {
  try {
    const body = withNaxBotMarker(renderRulingEcho(ruling), findingRulingKey(thread.id));
    await _findingRulingsDeps.replyToThread(input.ref, thread, body, input.deps, input.cwd);
    return true;
  } catch (error) {
    warn("Could not echo finding ruling", thread, error);
    return false;
  }
}

async function resolve(input: FindingRulingsInput, thread: PrThread): Promise<boolean> {
  try {
    await _findingRulingsDeps.resolveThread(input.ref, thread, input.deps, input.cwd);
    return true;
  } catch (error) {
    warn("Could not resolve settled finding", thread, error);
    return false;
  }
}

async function recordThread(
  input: FindingRulingsInput,
  thread: PrThread,
  { key, candidate }: { key: string; candidate: Candidate },
) {
  const { keyword, reply, index } = candidate;
  const ruling: BotSettledRuling = {
    id: key,
    kind: "finding",
    issue: earlierIssue(thread).split(/\r?\n/)[0] ?? "",
    ...keyword,
  };
  const confirming = keyword.disposition === "confirmed" || keyword.disposition === "verified";
  let echoed = 0;
  let failed = 0;
  if (!thread.resolved) {
    const hasEcho = ownComments(thread.comments.slice(index + 1), input.login).some(
      (own) => own.key === findingRulingKey(thread.id),
    );
    if (!hasEcho) {
      if (await echo(input, thread, { ...keyword, itemKey: key, itemId: key, by: reply.author })) echoed++;
      else failed++;
    }
    if (!confirming && !(await resolve(input, thread))) failed++;
  }
  const fixClosed =
    confirming &&
    thread.resolved &&
    ownComments(thread.comments.slice(index + 1), input.login).some((own) => own.key === `fix-${key}`);
  return { entry: { threadId: thread.id, ruling, ...(fixClosed && { fixClosed: true }) }, confirming, echoed, failed };
}

/** Echo/resolve failures are presentation failures: authorized rulings still apply. */
export async function recordFindingRulings(input: FindingRulingsInput): Promise<FindingRulingsOutcome> {
  const settled: FindingRulingEntry[] = [];
  const confirmed: FindingRulingEntry[] = [];
  let echoed = 0;
  let failed = 0;
  for (const thread of input.threads) {
    const opener = ownComments(thread.comments.slice(0, 1), input.login)[0];
    if (!opener?.key.startsWith("f-") || !isNaxBotMarkerKey(opener.key)) continue;
    const candidate = await lastRuling(input, thread);
    if (!candidate) continue;
    const recorded = await recordThread(input, thread, { key: opener.key, candidate });
    (recorded.confirming ? confirmed : settled).push(recorded.entry);
    echoed += recorded.echoed;
    failed += recorded.failed;
  }
  return { settled, confirmed, echoed, failed };
}
