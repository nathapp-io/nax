import type { SessionEvent, SessionMeta, SessionStorage } from "@nathapp/nax-agent";
import { NaxError } from "@/errors";
import type { ChatAskController } from "./ask-controller";
import type { ChatLedger } from "./chat-ledger";
import type { ChatSessionHandle } from "./open-chat-session";

const TITLE_CODE_POINT_LIMIT = 80;

export interface RunChatTurnOptions {
  readonly handle: ChatSessionHandle;
  readonly storage: SessionStorage;
  readonly message: string;
  readonly asks: Pick<ChatAskController, "handle">;
  readonly ledger: ChatLedger;
  readonly onEvent: (event: SessionEvent) => void;
  /** ISO timestamp for shared session metadata, not ledger milliseconds. */
  readonly now: string;
}

async function writeTurnMeta(options: RunChatTurnOptions, costUsd: number): Promise<SessionMeta> {
  const { handle, storage, message, now } = options;
  // Re-read spend/title for repeated turns using the opener's immutable handle.
  const stored = (await storage.readMeta(handle.meta.sessionId)) ?? handle.meta;
  const meta: SessionMeta = {
    ...handle.meta,
    updatedAt: now,
    costUsd: (stored.costUsd ?? 0) + costUsd,
    title: stored.title ?? [...message.trim().replace(/\s+/gu, " ")].slice(0, TITLE_CODE_POINT_LIMIT).join(""),
  };
  await storage.writeMeta(meta);
  return meta;
}

/** Consume one native turn; rejected sends must not flush or mutate shared state. */
export async function runChatTurn(options: RunChatTurnOptions): Promise<SessionMeta> {
  const { handle, message, asks, ledger, onEvent } = options;
  let previousAt: string | undefined;
  let ended: Extract<SessionEvent, { type: "turn_end" }> | undefined;
  for await (const event of handle.session.send(message)) {
    if (event.type === "turn_start") previousAt = event.at;
    if (event.type === "approval_requested" || event.type === "approval_resolved" || event.type === "question") {
      asks.handle(event);
    }
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
  await ledger.drain();
  return writeTurnMeta(options, ended.costUsd);
}
