import type { SessionListEntry, SessionStorage } from "@nathapp/nax-agent";
import { NaxError } from "@/errors";
import type { Logger } from "@/logger";
import { chatModeOfMeta } from "./chat-mode";
import { hasHadTurn } from "./session-hygiene";

/**
 * Every session this cwd has, in the store's newest-first order — not just its first page.
 * The store hands sessions back `LIST_PAGE_SIZE` at a time with a cursor, so a read that
 * stopped at the first page would hide every session past the fiftieth from `/resume`: the
 * picker's list is exactly this list, and an older free session is as resumable as a new
 * one. Both readers go through here, so neither can forget the cursor.
 */
export async function listCwdSessions(
  storage: Pick<SessionStorage, "list">,
  cwd: string,
): Promise<readonly SessionListEntry[]> {
  const sessions: SessionListEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await storage.list({ cwd, ...(cursor ? { cursor } : {}) });
    sessions.push(...page.sessions);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return sessions;
}

/** The newest session of `cwd` that has had a turn, is ask/full mode and is not held by a live process. */
export async function latestResumableId(input: {
  readonly storage: Pick<SessionStorage, "list" | "readMeta" | "readLockHolder">;
  readonly cwd: string;
  readonly logger: Pick<Logger, "warn">;
}): Promise<string> {
  const { storage, cwd, logger } = input;
  for (const { sessionId } of await listCwdSessions(storage, cwd)) {
    try {
      const meta = await storage.readMeta(sessionId);
      if (meta === null || !hasHadTurn(meta) || meta.sessionId !== sessionId || chatModeOfMeta(meta.mode) === null)
        continue;
      if ((await storage.readLockHolder(sessionId))?.state !== "live") return sessionId;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "SESSION_META_UNREADABLE")) throw error;
      logger.warn("chat", "skipping unreadable session metadata", { sessionId, cause: error });
    }
  }
  throw new NaxError(`no resumable session for ${cwd}`, "CHAT_SESSION_NOT_FOUND", { stage: "chat" });
}
