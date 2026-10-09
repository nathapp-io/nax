/**
 * Reopening a stored session for session/load and session/resume (S5 spec §5.3,
 * §5.4). Extracted from registry.ts so neither module grows past the complexity
 * limit; registry.ts owns the entry and lock lifecycle and passes its internals
 * in. Load replays the stored transcript (and warns when the last turn was
 * interrupted); resume reopens without replay.
 */
import type { AgentLogger, TranscriptStore } from "@nathapp/nax-agent";
import type { ClientPort } from "#src/server/client-port";
import { unknownSession } from "#src/server/errors";
import type { OpenedSession } from "#src/server/open-session";
import type { Entry, OpenInput, SessionState } from "#src/server/registry";
import type { ServerSession } from "#src/server/server-session";
import type { SessionSettings } from "#src/server/session-config";
import type { SessionMeta, SessionStorage } from "#src/server/storage";
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
  async function replayTo(
    port: ClientPort,
    messages: Parameters<typeof replayTranscript>[0],
    cwd: string,
  ): Promise<void> {
    for (const update of replayTranscript(messages, cwd)) await port.update(update);
  }

  async function replayOpened(port: ClientPort, opened: OpenedSession, cwd: string): Promise<void> {
    await replayTo(port, opened.doc?.messages ?? [], cwd);
    if (opened.session.lastTurn?.status === "interrupted") {
      await port.update(announce(port.features.updates.notices, "warning", deps.interruptedNotice));
    }
  }

  async function openAndReplay(sessionId: string, meta: SessionMeta, input: OpenInput, replay: boolean): Promise<void> {
    const port = input.port(sessionId);
    const { opened } = await deps.openEntry(meta, port, input.mcpServers);
    if (replay) {
      try {
        await replayOpened(port, opened, meta.cwd);
      } catch (error) {
        // The client did not get its history: do not leave the session open and locked.
        const entry = deps.entries.get(sessionId);
        if (entry !== undefined) await deps.closeEntry(sessionId, entry);
        throw error;
      }
    }
  }

  return {
    async reopen(sessionId, input, replay) {
      const open = deps.entries.get(sessionId);
      if (open !== undefined) {
        // An already-open session keeps its connection and ignores input.mcpServers (§4.4).
        if (replay) {
          await replayTo(open.port, (await deps.transcripts.load(sessionId))?.messages ?? [], open.meta.cwd);
        }
        return deps.stateOf(settingsOf(open.meta));
      }
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
    },
  };
}
