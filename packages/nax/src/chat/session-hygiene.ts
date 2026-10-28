import type { SessionListEntry, SessionMeta, SessionStorage } from "@nathapp/nax-agent";
import type { Logger } from "@/logger";
import type { ChatSessionRow } from "./chat-host";
import type { ChatHistory, ChatSessionHandle } from "./open-chat-session";

type HygieneDeps = {
  readonly storage: SessionStorage;
  readonly logger: Pick<Logger, "warn">;
};

export function hasHadTurn(meta: SessionMeta): boolean {
  return meta.updatedAt !== null;
}

export async function resumableRows(
  input: HygieneDeps & {
    readonly sessions: readonly SessionListEntry[];
    readonly currentId?: string;
  },
): Promise<readonly ChatSessionRow[]> {
  const rows = await Promise.all(
    input.sessions.map(async ({ sessionId, title, updatedAt }) => {
      if (sessionId === input.currentId) return null;
      let meta: SessionMeta | null;
      try {
        meta = await input.storage.readMeta(sessionId);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "SESSION_META_UNREADABLE")) throw error;
        input.logger.warn("chat", "skipping unreadable session metadata", { sessionId });
        return null;
      }
      if (meta === null || meta.sessionId !== sessionId || !hasHadTurn(meta)) return null;
      const holder = await input.storage.readLockHolder(sessionId);
      return { sessionId, title, updatedAt, ...(holder?.state === "live" ? { heldByPid: holder.pid } : {}) };
    }),
  );
  return rows.filter((row): row is NonNullable<typeof row> => row !== null);
}

export async function removeIfEmpty(input: {
  readonly storage: Pick<SessionStorage, "readMeta" | "removeMeta">;
  readonly logger: Pick<Logger, "warn">;
  readonly sessionId: string;
  readonly history?: ChatHistory;
  readonly sentOn: ReadonlySet<string>;
}): Promise<void> {
  const { sessionId, history, sentOn, storage, logger } = input;
  // Missing history on a legacy handle cannot establish that it opened empty.
  if (history === undefined || history.messages.length > 0 || sentOn.has(sessionId)) return;
  try {
    const meta = await storage.readMeta(sessionId);
    if (meta !== null && meta.sessionId === sessionId && !hasHadTurn(meta)) await storage.removeMeta(sessionId);
  } catch (cause) {
    logger.warn("chat", "could not remove empty session", { sessionId, cause });
  }
}

/** Host-lifetime sent tracking survives same-id reopens, including failed first turns. */
export function createSessionHygiene(deps: HygieneDeps): {
  markSent(sessionId: string): void;
  close(handle: ChatSessionHandle, nextId?: string): Promise<void>;
} {
  const sentOn = new Set<string>();
  return {
    markSent: (sessionId) => {
      sentOn.add(sessionId);
    },
    async close(handle, nextId) {
      try {
        try {
          await handle.session.close();
        } finally {
          await handle.release();
        }
      } finally {
        if (handle.meta.sessionId !== nextId)
          await removeIfEmpty({ ...deps, sessionId: handle.meta.sessionId, history: handle.history, sentOn });
      }
    },
  };
}
