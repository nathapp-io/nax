/** Bounded registry shutdown and ownership cleanup. */
import type { AgentLogger } from "@nathapp/nax-agent";
import { stripControl, stripInvisible } from "#src/client/text";
import type { ClientPort } from "#src/server/client-port";
import { messageOf } from "#src/server/errors";
import type { McpSessionTools } from "#src/server/mcp/session-tools";
import type { OpenedSession } from "#src/server/open-session";
import type { Entry, RegistryDeps } from "#src/server/registry";
import { createServerSession, type ServerSession } from "#src/server/server-session";
import type { SessionMeta } from "#src/server/storage";

function waitAtMost(ms: number): { readonly done: Promise<"timeout">; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return { done, cancel: () => clearTimeout(timer) };
}

export async function closeEntries({
  open,
  wait,
  logger,
}: {
  readonly open: readonly (readonly [string, Entry])[];
  readonly wait: number;
  readonly logger: AgentLogger;
}): Promise<void> {
  await Promise.all(
    open.map(async ([sessionId, entry]) => {
      entry.server.cancel();
      const limit = waitAtMost(wait);
      const closed = entry.server.close().then(
        () => "closed" as const,
        (error: unknown) => {
          logger.warn("session", "session close failed", { sessionId, error: messageOf(error) });
          return "closed" as const;
        },
      );
      const outcome = await Promise.race([closed, limit.done]);
      limit.cancel();
      if (outcome === "timeout") logger.warn("session", "session did not close in time", { sessionId, waitMs: wait });
      try {
        await entry.mcp.closeAll();
      } finally {
        await entry.release();
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
    priorCostUsd: meta.costUsd ?? 0,
    onTurnEnd: (prompt, costUsd) => recordTurn(meta.sessionId, prompt, costUsd),
    titleFor: (name) => mcp.titleFor(name),
  });
}

export async function closeRegistryEntry(entries: Map<string, Entry>, sessionId: string, entry: Entry): Promise<void> {
  entries.delete(sessionId);
  try {
    await entry.server.close();
  } finally {
    try {
      await entry.mcp.closeAll();
    } finally {
      await entry.release();
    }
  }
}

export const TITLE_MAX = 80;

/** One line, no control or invisible characters, at most TITLE_MAX code points. */
export function titleOf(prompt: string): string {
  return Array.from(stripInvisible(stripControl(prompt)).replace(/\s+/g, " ").trim())
    .slice(0, TITLE_MAX)
    .join("");
}
