/** Bounded registry shutdown and ownership cleanup. */
import type { AgentLogger, SessionMeta } from "@nathapp/nax-agent";
import { stripControl, stripInvisible } from "#src/client/text";
import type { ClientPort } from "#src/server/client-port";
import { messageOf } from "#src/server/errors";
import type { McpSessionTools } from "#src/server/mcp/session-tools";
import type { OpenedSession } from "#src/server/open-session";
import type { Entry, RegistryDeps } from "#src/server/registry";
import { type CloseOutcome, createServerSession, type ServerSession } from "#src/server/server-session";

function waitAtMost(ms: number): { readonly done: Promise<"timeout">; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return { done, cancel: () => clearTimeout(timer) };
}

/**
 * An entry's ownership given up once, however many close paths ask (§Design 1,
 * finding 7): an ordinary close, shutdown and delete share this one completion,
 * so the MCP tools close and the lock is released exactly once.
 */
const ownership = new WeakMap<Entry, Promise<void>>();

function giveUpOwnership(entry: Entry): Promise<void> {
  const known = ownership.get(entry);
  if (known !== undefined) return known;
  const givenUp = (async () => {
    try {
      await entry.mcp.closeAll();
    } finally {
      await entry.release();
    }
  })();
  ownership.set(entry, givenUp);
  return givenUp;
}

export async function closeEntries({
  open,
  entries,
  wait,
  logger,
}: {
  readonly open: readonly (readonly [string, Entry])[];
  readonly entries: Map<string, Entry>;
  readonly wait: number;
  readonly logger: AgentLogger;
}): Promise<void> {
  await Promise.all(
    open.map(async ([sessionId, entry]) => {
      entry.server.cancel();
      const limit = waitAtMost(wait);
      const closed: Promise<CloseOutcome> = entry.server.close().catch((error: unknown) => {
        logger.warn("session", "session close failed", { sessionId, error: messageOf(error) });
        return "disposed" as const;
      });
      const outcome = await Promise.race([closed, limit.done]);
      limit.cancel();
      const cleanup = async () => {
        entries.delete(sessionId);
        await giveUpOwnership(entry);
      };
      const deferred = (error: unknown) => {
        logger.warn("session", "deferred session cleanup failed", { sessionId, error: messageOf(error) });
      };
      if (outcome !== "disposed") {
        logger.warn("session", "session did not close in time", { sessionId, waitMs: wait });
        // Bound shutdown, not ownership: a slow cancelled turn or a held output
        // write must still persist its cost before another process can resume it.
        if (entry.server.running) {
          void entry.server.disposal.then(cleanup).catch(deferred);
          return;
        }
        // Nothing can be lost, so the cap releases ownership even when the S3
        // session's own close has not settled.
      }
      // Cleanup is bounded too: a release waiting on a live lock guard keeps
      // ownership in the background instead of hanging shutdown.
      const cleaning = cleanup();
      const cleanupLimit = waitAtMost(wait);
      let settled: "cleaned" | "timeout";
      try {
        settled = await Promise.race([cleaning.then(() => "cleaned" as const), cleanupLimit.done]);
      } finally {
        cleanupLimit.cancel();
      }
      if (settled === "timeout") {
        logger.warn("session", "session cleanup did not finish in time", { sessionId, waitMs: wait });
        cleaning.catch(deferred);
      }
    }),
  );
}

export function createEntryServer({
  meta,
  port,
  opened,
  mcp,
  deps,
  contextWindow,
  recordTurn,
}: {
  meta: SessionMeta;
  port: ClientPort;
  opened: OpenedSession;
  mcp: McpSessionTools;
  deps: RegistryDeps;
  contextWindow: number | undefined;
  recordTurn: (id: string, prompt: string, cost: number) => Promise<void>;
}): ServerSession {
  return createServerSession({
    session: opened.session,
    port,
    cwd: meta.cwd,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    readOldText: deps.readOldText,
    logger: deps.logger,
    turnTimeoutSeconds: deps.turnTimeoutSeconds,
    ...(deps.closeWaitMs !== undefined ? { closeWaitMs: deps.closeWaitMs } : {}),
    priorCostUsd: meta.costUsd ?? 0,
    onTurnEnd: (prompt, costUsd) => recordTurn(meta.sessionId, prompt, costUsd),
    titleFor: (name) => mcp.titleFor(name),
  });
}

/** What a close caller may ask for (§Design 1, finding 7). */
export interface CloseEntryOptions {
  readonly logger: AgentLogger;
  /**
   * Wait for the session's true disposal before giving up ownership: delete must
   * not remove storage under a session that is still finishing its turn.
   */
  readonly awaitCleanup?: boolean;
}

/**
 * Closes an entry and gives up its ownership. The caller's wait is the session's
 * own bounded close; when a held output write keeps the session alive past it,
 * ownership follows the session instead, so the lock is never released while a
 * competing owner could resume a half-closed session.
 */
export async function closeRegistryEntry(
  entries: Map<string, Entry>,
  sessionId: string,
  entry: Entry,
  { logger, awaitCleanup = false }: CloseEntryOptions,
): Promise<void> {
  const giveUp = async (): Promise<void> => {
    try {
      await giveUpOwnership(entry);
    } finally {
      entries.delete(sessionId);
    }
  };
  let outcome: CloseOutcome;
  try {
    outcome = await entry.server.close();
  } catch (error) {
    // A close that failed is not a live session any more: ownership goes now, and
    // the failure still reaches the caller (as the unconditional finally did).
    await giveUp();
    throw error;
  }
  if (awaitCleanup) {
    await entry.server.disposal;
    await giveUp();
    return;
  }
  if (outcome === "timed_out") {
    void entry.server.disposal.then(giveUp).catch((error: unknown) => {
      logger.warn("session", "deferred session cleanup failed", { sessionId, error: messageOf(error) });
    });
    return;
  }
  await giveUp();
}

export const TITLE_MAX = 80;

/** One line, no control or invisible characters, at most TITLE_MAX code points. */
export function titleOf(prompt: string): string {
  return Array.from(stripInvisible(stripControl(prompt)).replace(/\s+/g, " ").trim())
    .slice(0, TITLE_MAX)
    .join("");
}
