/**
 * Reopening a stored session for session/load and session/resume (S5 spec §5.3,
 * §5.4). Extracted from registry.ts so neither module grows past the complexity
 * limit; registry.ts owns the entry and lock lifecycle and passes its internals
 * in. Load replays the stored transcript (and warns when the last turn was
 * interrupted); resume reopens without replay.
 *
 * One open per session id at a time: two load/resume requests that arrive while
 * the first is still opening would otherwise each take the lock and open the S3
 * session, and the second entry would replace the first's without closing it.
 * The waiter takes whatever the first left — the open entry (replaying to it,
 * as an already-open load does), or a fresh attempt when that open failed.
 */
import type { AgentLogger, SessionMeta, SessionStorage, TranscriptStore } from "@nathapp/nax-agent";
import type { ClientPort } from "#src/server/client-port";
import { unknownSession } from "#src/server/errors";
import type { OpenedSession } from "#src/server/open-session";
import type { Entry, OpenInput, SessionState } from "#src/server/registry";
import type { ServerSession } from "#src/server/server-session";
import type { SessionSettings } from "#src/server/session-config";
import { announce } from "#src/server/translate/notice";
import { replayTranscript } from "#src/server/translate/replay";

export interface ReopenDeps {
  readonly entries: Map<string, Entry>;
  readonly storage: SessionStorage;
  readonly transcripts: TranscriptStore;
  readonly logger: AgentLogger;
  readonly openEntry: (
    meta: SessionMeta,
    port: ClientPort,
    mcpServers: readonly unknown[],
  ) => Promise<{ readonly server: ServerSession; readonly opened: OpenedSession }>;
  readonly closeEntry: (sessionId: string, entry: Entry) => Promise<void>;
  readonly stateOf: (settings: SessionSettings) => SessionState;
  readonly interruptedNotice: string;
}

export interface Reopener {
  reopen(sessionId: string, input: OpenInput, replay: boolean): Promise<SessionState>;
}

export const settingsOf = (meta: SessionMeta): SessionSettings => ({
  mode: meta.mode,
  model: meta.model,
  bashApproval: meta.bashApproval,
});

export function createReopen(deps: ReopenDeps): Reopener {
  /** The open in flight per session id; cleared once it settles, whether it succeeded or failed. */
  const inFlight = new Map<string, Promise<void>>();

  async function replayTo(
    port: ClientPort,
    messages: Parameters<typeof replayTranscript>[0],
    cwd: string,
    titleFor?: (name: string) => string | undefined,
  ): Promise<void> {
    for (const update of replayTranscript(messages, cwd, titleFor)) await port.update(update);
  }

  async function replayOpened(port: ClientPort, sessionId: string, opened: OpenedSession, cwd: string): Promise<void> {
    await replayTo(port, opened.doc?.messages ?? [], cwd, (name) => deps.entries.get(sessionId)?.mcp.titleFor(name));
    if (opened.session.lastTurn?.status === "interrupted") {
      await port.update(announce(port.features.updates.notices, "warning", deps.interruptedNotice));
    }
  }

  async function openAndReplay(sessionId: string, meta: SessionMeta, input: OpenInput, replay: boolean): Promise<void> {
    const port = input.port(sessionId);
    const { opened } = await deps.openEntry(meta, port, input.mcpServers);
    if (replay) {
      try {
        await replayOpened(port, sessionId, opened, meta.cwd);
      } catch (error) {
        // The client did not get its history: do not leave the session open and locked.
        const entry = deps.entries.get(sessionId);
        if (entry !== undefined) await deps.closeEntry(sessionId, entry);
        throw error;
      }
    }
  }

  /** An already-open session keeps its connection and ignores input.mcpServers (§4.4); a load still replays. */
  async function reuseOpen(sessionId: string, open: Entry, replay: boolean): Promise<SessionState> {
    if (open.server.isClosed()) throw unknownSession(sessionId);
    if (replay) {
      await replayTo(open.port, (await deps.transcripts.load(sessionId))?.messages ?? [], open.meta.cwd, (name) =>
        open.mcp.titleFor(name),
      );
    }
    return deps.stateOf(settingsOf(open.meta));
  }

  /** Reads the stored metadata and opens it: the state comes from the metadata that was opened. */
  async function openStored(sessionId: string, input: OpenInput, replay: boolean): Promise<SessionState> {
    const meta = await deps.storage.readMeta(sessionId);
    if (meta === null) throw unknownSession(sessionId);
    if (input.cwd !== meta.cwd) {
      deps.logger.debug("session", "reopening in the stored cwd", {
        sessionId,
        requested: input.cwd,
        stored: meta.cwd,
      });
    }
    await openAndReplay(sessionId, meta, input, replay);
    return deps.stateOf(settingsOf(meta));
  }

  async function reopen(sessionId: string, input: OpenInput, replay: boolean): Promise<SessionState> {
    const open = deps.entries.get(sessionId);
    if (open !== undefined) return reuseOpen(sessionId, open, replay);
    const pending = inFlight.get(sessionId);
    if (pending !== undefined) {
      // Whatever the open in flight left is this caller's answer: the open entry,
      // or a fresh attempt when it failed (its error is the first caller's alone).
      await pending.catch(() => undefined);
      return reopen(sessionId, input, replay);
    }
    // `openStored` runs synchronously up to its first await (storage.readMeta), so
    // this registers the open before anything else can observe it. The entry is
    // cleared by `finally` as the open settles, and the muted promise the map holds
    // settles after that, so a waiter never re-runs against a stale registration.
    const work = openStored(sessionId, input, replay).finally(() => inFlight.delete(sessionId));
    inFlight.set(
      sessionId,
      work.then(
        () => undefined,
        () => undefined,
      ),
    );
    return work;
  }

  return { reopen };
}
