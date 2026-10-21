/** Record collaborator rulings durably on the PR; body ticks are best-effort presentation only. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { ForgeDeps } from "@/forge";
import { hasWriteAccess, readPrInfo, replyToThread, resolveThread, withNaxBotMarker } from "@/forge";
import type { PrComment, PrInfo, PrRef } from "@/forge/pr-types";
import { getLogger } from "@/logger";
import type { DecisionEntry, Disposition, SidecarKind } from "../workflow/decisions-sidecar";
import type { ItemThread, SettledItems } from "../workflow/item-thread-state";
// Workflow leaves avoid pulling feature orchestration into the bot recorder.
import { readItemThreads, settleItemThreads } from "../workflow/item-thread-state";
import type { ItemIndex, PrRuling } from "../workflow/item-threads";
import { renderRulingEcho } from "../workflow/item-threads";
import { editBodyArgv, tickChecklist } from "../workflow/promote";
import { parseRulingKeyword } from "../workflow/ruling-keyword";
import type { OpenItem } from "../workflow/types";

/** Structural seam until the model-read operation owns these types at integration. */
export interface BotRulingReadInput {
  readonly items: readonly {
    readonly id: string;
    readonly kind: string;
    readonly issue: string;
    readonly reply: { readonly id: string; readonly author: string; readonly body: string };
  }[];
  readonly model?: string;
}

export interface BotRulingReadVerdict {
  readonly rulings: readonly {
    readonly id: string;
    readonly disposition: Disposition | "none";
    readonly reason: string;
    readonly quote: string;
    readonly sha?: string;
  }[];
}

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
  readonly recorded: readonly PrRuling[];
  readonly settled: SettledItems["settled"];
  readonly open: SettledItems["open"];
  readonly asked: number;
  readonly failed: number;
}

export const _rulingsDeps = { hasWriteAccess, readPrInfo, replyToThread, resolveThread, tickChecklist, getLogger };

const CHECKLIST_KINDS = {
  finding: "finding",
  ruling: "advisor",
  advisor: "advisor",
  gate: "gate",
  ci: "ci",
  story: "story",
  "cannot-verify": "cannot-verify",
  reason: "reason",
} as const satisfies Record<OpenItem["kind"], SidecarKind>;

function warn(message: string, data: Record<string, unknown>): void {
  _rulingsDeps.getLogger()?.warn("bot-rulings", `[bot-rulings] ${message}`, data);
}

/** Cache the promise, not just the result: settlement checks replies concurrently. */
function permissionReader(input: RecordRulingsInput): (comment: PrComment) => Promise<boolean> {
  const permissions = new Map<string, Promise<boolean>>();
  return (comment) => {
    let pending = permissions.get(comment.author);
    if (!pending) {
      pending = (async () => {
        try {
          return await _rulingsDeps.hasWriteAccess(
            input.ref,
            { login: comment.author, id: comment.authorId },
            input.deps,
            input.cwd,
          );
        } catch (error) {
          warn("Could not check ruling permission", { login: comment.author, error: errorMessage(error) });
          return false;
        }
      })();
      permissions.set(comment.author, pending);
    }
    return pending;
  };
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
  const lines = body.split("\n");
  return settled.flatMap((item) => {
    const kind = Object.entries(CHECKLIST_KINDS).find(([name]) => name === item.kind)?.[1];
    const onChecklist = lines.some(
      (line) => line.startsWith(`- [ ] **${item.itemId}**`) || line.startsWith(`- [x] **${item.itemId}**`),
    );
    if (!kind || !onChecklist) return [];
    const { disposition, reason, sha } = item.ruling;
    return [{ id: item.itemId, kind, disposition, reason, ...(disposition === "fixed" && sha ? { sha } : {}) }];
  });
}

async function tickBody(input: RecordRulingsInput, settled: SettledItems["settled"]): Promise<void> {
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

/** Only successful echoes count as newly recorded; resolution failure never undoes an echo. */
export async function recordPrRulings(input: RecordRulingsInput): Promise<RecordRulingsOutcome> {
  const read = readItemThreads(input.threads, input.comments, input.login);
  const initial = await settleItemThreads(read, permissionReader(input));
  const settled = [...initial.settled];
  const open: SettledItems["open"][number][] = [];
  const recorded: PrRuling[] = [];
  let failed = 0;
  for (const item of initial.settled) {
    if (!item.thread.resolved) await resolve(input, item);
  }
  for (const item of initial.open) {
    const newest = item.kept.at(-1);
    const keyword = newest ? parseRulingKeyword(newest.body) : null;
    if (!keyword || !newest) {
      open.push(item);
      continue;
    }
    const ruling: PrRuling = { ...keyword, itemKey: item.key, itemId: item.itemId, by: newest.author };
    if (!(await postEcho(input, item, ruling))) {
      open.push(item);
      failed++;
      continue;
    }
    recorded.push(ruling);
    settled.push({ ...item, ruling });
    await resolve(input, item);
  }
  await tickBody(input, settled);
  return { ...(read.index ? { index: read.index } : {}), recorded, settled, open, asked: 0, failed };
}
