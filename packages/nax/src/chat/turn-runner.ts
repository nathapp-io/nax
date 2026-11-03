import type { ImageAttachment, SendInput, SessionEvent, SessionMeta, SessionStorage } from "@nathapp/nax-agent";
import { NaxError } from "@/errors";
import type { ChatAskController } from "./ask-controller";
import type { ChatLedger } from "./chat-ledger";
import type { HostQueue } from "./host-queue";
import type { ChatSessionHandle } from "./open-chat-session";

const TITLE_CODE_POINT_LIMIT = 80;

export interface RunChatTurnOptions {
  readonly handle: ChatSessionHandle;
  readonly storage: SessionStorage;
  readonly message: string;
  /** Images to send with this turn; an absent or empty list sends the message alone. */
  readonly images?: readonly ImageAttachment[];
  readonly title?: string;
  readonly asks: Pick<ChatAskController, "handle">;
  readonly ledger: ChatLedger;
  readonly onEvent: (event: SessionEvent) => void;
  /** ISO timestamp for shared session metadata, not ledger milliseconds. */
  readonly now: string;
  /** Spend of nested sessions to add to this turn's metadata; read once, after `turn_end`. */
  readonly extraCostUsd?: () => number;
  /**
   * Resolves once every nested run of this turn has finished, abandoned ones included.
   * Awaited after `turn_end` and before the ledger flush and the metadata write, so a
   * late nested usage row and its spend still land on this turn.
   */
  readonly settleNested?: () => Promise<void>;
  /**
   * The host's metadata queue. Only this turn's metadata write is serialized through it — the
   * write is a read-modify-write of the session's cumulative spend, and a compaction that
   * settled a moment ago must not be replaced by a base this turn read before it. The turn
   * itself never waits on the queue: the session's claim has to exist the moment `send` is
   * called, or a ctrl+s in the same batch finds no turn to steer or to cancel.
   */
  readonly queue?: HostQueue;
}

async function writeTurnMeta(options: RunChatTurnOptions, costUsd: number): Promise<SessionMeta> {
  const { handle, storage, message, now } = options;
  // Re-read spend/title for repeated turns using the opener's immutable handle.
  const stored = (await storage.readMeta(handle.meta.sessionId)) ?? handle.meta;
  const meta: SessionMeta = {
    ...handle.meta,
    updatedAt: now,
    costUsd: (stored.costUsd ?? 0) + costUsd + (options.extraCostUsd?.() ?? 0),
    title:
      stored.title ??
      [...(options.title?.trim() || message).trim().replace(/\s+/gu, " ")].slice(0, TITLE_CODE_POINT_LIMIT).join(""),
  };
  await storage.writeMeta(meta);
  return meta;
}

/** Route interactive asks without treating command events as model turns or usage. */
export function routeAskEvent(event: SessionEvent, asks: Pick<ChatAskController, "handle">): void {
  if (event.type === "approval_requested" || event.type === "approval_resolved" || event.type === "question") {
    asks.handle(event);
  }
}

/**
 * The send input for one turn: the images when the caller supplied any, and no second
 * argument at all otherwise, so a text-only send keeps the session's one-argument call.
 */
function turnInput(images: readonly ImageAttachment[] | undefined): readonly [] | readonly [SendInput] {
  return images === undefined || images.length === 0 ? [] : [{ images }];
}

/** Consume one native turn; rejected sends must not flush or mutate shared state. */
export async function runChatTurn(options: RunChatTurnOptions): Promise<SessionMeta> {
  const { handle, message, asks, ledger, onEvent, images } = options;
  let previousAt: string | undefined;
  let ended: Extract<SessionEvent, { type: "turn_end" }> | undefined;
  for await (const event of handle.session.send(message, ...turnInput(images))) {
    if (event.type === "turn_start") previousAt = event.at;
    routeAskEvent(event, asks);
    if (event.type === "usage") {
      ledger.record(event, previousAt ?? event.at, handle.meta.model);
      previousAt = event.at;
    }
    onEvent(event);
    if (event.type === "turn_end") ended = event;
  }
  if (!ended) {
    throw new NaxError(`[chat] session ${handle.meta.sessionId} ended without turn_end`, "CHAT_TURN_INCOMPLETE", {
      stage: "chat",
      sessionId: handle.meta.sessionId,
    });
  }
  await options.settleNested?.();
  await ledger.drain();
  // The metadata write is the read-modify-write the host serializes; the turn above is not.
  const persist = (): Promise<SessionMeta> => writeTurnMeta(options, ended.costUsd);
  return options.queue === undefined ? persist() : options.queue.run(persist);
}
