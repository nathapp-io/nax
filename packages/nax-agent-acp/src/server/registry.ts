/**
 * ACP session id -> open session, backed by files (S5 spec §5.1, §5.3). Opening
 * (new, load, resume) takes the session's lock, then reopens the S3 session;
 * close releases the lock and keeps the files; delete removes them. Mode and
 * config changes are a close-and-reopen (§3.3) that rolls back on failure and
 * writes metadata only on success. closeAll is the shutdown (§5.5).
 */
import { isAbsolute } from "node:path";
import {
  type ListSessionsResponse,
  RequestError,
  type SessionConfigOption,
  type SessionModeState,
} from "@agentclientprotocol/sdk";
import type { AgentLogger, EmbedderTool, TranscriptStore } from "@nathapp/nax-agent";
import { stripControl, stripInvisible } from "#src/client/text";
import type { ClientPort } from "#src/server/client-port";
import { invalidParams, messageOf, turnInProgress, unknownSession } from "#src/server/errors";
import { type ConnectSessionMcp, connectNothing, type SessionMcp } from "#src/server/mcp/connect";
import { disconnectNotice, modeNotice, openNotice } from "#src/server/mcp/notices";
import { NO_SERVERS, type ParsedServers, parseMcpServers } from "#src/server/mcp/parse";
import { mcpSecrets, scrubber } from "#src/server/mcp/secrets";
import type { McpSessionTools } from "#src/server/mcp/session-tools";
import type { OpenedSession, OpenSession } from "#src/server/open-session";
import type { ServerOptions } from "#src/server/options";
import { createReopen, settingsOf } from "#src/server/registry-open";
import { createServerSession, type ServerSession, type SwitchTarget } from "#src/server/server-session";
import {
  applyConfigChange,
  applyModeChange,
  configOptions,
  modeState,
  type SessionSettings,
  sameSettings,
} from "#src/server/session-config";
import type { SessionMeta, SessionStorage } from "#src/server/storage";
import type { ReadOldText } from "#src/server/translate/diff";

export const NO_MODEL_MESSAGE = "no model configured: set models.native.balanced or --model";
export const INTERRUPTED_NOTICE = "The previous turn was interrupted";
export const SHUTTING_DOWN = "server is shutting down";
export const SHUTDOWN_WAIT_MS = 5000;
export const TITLE_MAX = 80;

export interface SessionState {
  readonly modes: SessionModeState;
  readonly configOptions: SessionConfigOption[];
}

export interface OpenInput {
  readonly cwd: string;
  readonly mcpServers: readonly unknown[];
  readonly port: (sessionId: string) => ClientPort;
}

export interface SessionRegistry {
  create(input: OpenInput): Promise<{ readonly sessionId: string } & SessionState>;
  load(sessionId: string, input: OpenInput): Promise<SessionState>;
  resume(sessionId: string, input: OpenInput): Promise<SessionState>;
  list(query: { readonly cwd?: string | null; readonly cursor?: string | null }): Promise<ListSessionsResponse>;
  get(sessionId: string): ServerSession;
  find(sessionId: string): ServerSession | undefined;
  close(sessionId: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
  setMode(sessionId: string, modeId: string): Promise<void>;
  setConfigOption(sessionId: string, configId: string, value: unknown): Promise<SessionConfigOption[]>;
  closeAll(): Promise<void>;
}

export interface RegistryDeps {
  readonly options: ServerOptions;
  readonly openSession: OpenSession;
  readonly storage: SessionStorage;
  readonly transcripts: TranscriptStore;
  readonly newId: () => string;
  readonly now: () => Date;
  readonly readOldText: ReadOldText;
  readonly logger: AgentLogger;
  readonly turnTimeoutSeconds: number;
  readonly shutdownWaitMs?: number;
  /** S5-4 M-30: refuses (auth_required) when the model's provider has no credential. */
  readonly ensureCredentials?: (model: string) => Promise<void>;
  /** S5-5: connects a session's client-supplied MCP servers. Default: connects nothing (plan M-38). */
  readonly connectMcp?: ConnectSessionMcp;
}

export interface Entry {
  readonly server: ServerSession;
  readonly port: ClientPort;
  readonly meta: SessionMeta;
  readonly release: () => Promise<void>;
  readonly mcp: McpSessionTools;
}

/** One line, no control or invisible characters, at most TITLE_MAX code points. */
export function titleOf(prompt: string): string {
  return Array.from(stripInvisible(stripControl(prompt)).replace(/\s+/g, " ").trim())
    .slice(0, TITLE_MAX)
    .join("");
}

function waitAtMost(ms: number): { readonly done: Promise<"timeout">; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return { done, cancel: () => clearTimeout(timer) };
}

export function createSessionRegistry(deps: RegistryDeps): SessionRegistry {
  const entries = new Map<string, Entry>();
  const { options } = deps;
  const connectMcp = deps.connectMcp ?? connectNothing;
  const shutdown = new AbortController();
  let closing = false;

  const contextWindowFor = (model: string): number | undefined =>
    options.tiers.find((tier) => tier.model === model)?.contextWindow;

  const stateOf = (settings: SessionSettings): SessionState => ({
    modes: modeState(settings),
    configOptions: configOptions(settings, options.tiers),
  });

  function entryOf(sessionId: string): Entry {
    const entry = entries.get(sessionId);
    if (entry === undefined) throw unknownSession(sessionId);
    return entry;
  }

  async function recordTurn(sessionId: string, prompt: string): Promise<void> {
    const entry = entries.get(sessionId);
    if (entry === undefined) return;
    const meta: SessionMeta = {
      ...entry.meta,
      title: entry.meta.title ?? (titleOf(prompt) || null),
      updatedAt: deps.now().toISOString(),
    };
    entries.set(sessionId, { ...entry, meta });
    await deps.storage.writeMeta(meta);
  }

  async function target(
    sessionId: string,
    cwd: string,
    settings: SessionSettings,
    tools: readonly EmbedderTool[],
  ): Promise<SwitchTarget> {
    const opened = await deps.openSession({
      sessionId,
      cwd,
      model: settings.model,
      profile: settings.mode,
      bashApproval: settings.bashApproval,
      tools,
    });
    const contextWindow = contextWindowFor(settings.model);
    return { session: opened.session, ...(contextWindow !== undefined ? { contextWindow } : {}) };
  }

  function startMcp(parsed: ParsedServers, meta: SessionMeta, port: ClientPort): Promise<SessionMcp> {
    // Built before connecting: a disconnect fired before connectMcp resolves must still be scrubbed.
    const scrub = scrubber(mcpSecrets(parsed.servers));
    return connectMcp({
      parsed,
      cwd: meta.cwd,
      signal: shutdown.signal,
      onDisconnect: (server, reason) => {
        port.update(disconnectNotice(port.features.updates.notices, server, reason, scrub)).catch((error: unknown) => {
          deps.logger.warn("session", "MCP disconnect notice failed", {
            sessionId: meta.sessionId,
            error: messageOf(error),
          });
        });
      },
    });
  }

  function queueMcpNotices(
    server: ServerSession,
    port: ClientPort,
    mcp: SessionMcp,
    mode: SessionSettings["mode"],
  ): void {
    const notices = port.features.updates.notices;
    const open = openNotice(notices, mcp.noticeLines, mcp.scrub);
    if (open !== undefined) server.queueNotice(open);
    if (mcp.tools.connectedCount > 0 && !mcp.tools.offersTools(mode)) server.queueNotice(modeNotice(notices, mode));
  }

  /** Parses MCP servers, takes the lock, connects MCP, opens the S3 session, registers it. Everything is undone on failure. */
  async function openEntry(meta: SessionMeta, port: ClientPort, mcpServers: readonly unknown[]) {
    if (closing) throw RequestError.internalError(undefined, SHUTTING_DOWN);
    const parsed = mcpServers.length === 0 ? NO_SERVERS : parseMcpServers(mcpServers);
    await deps.ensureCredentials?.(meta.model);
    const release = await deps.storage.acquireLock(meta.sessionId);
    let mcp: SessionMcp | undefined;
    let opened: OpenedSession | undefined;
    try {
      mcp = await startMcp(parsed, meta, port);
      if (closing) throw RequestError.internalError(undefined, SHUTTING_DOWN); // shutdown during connect
      const settings = settingsOf(meta);
      opened = await deps.openSession({
        sessionId: meta.sessionId,
        cwd: meta.cwd,
        model: settings.model,
        profile: settings.mode,
        bashApproval: settings.bashApproval,
        tools: mcp.tools.embedderTools(settings.mode),
      });
      if (closing) {
        // Shutdown started while this open was in flight (M-26).
        await opened.session.close().catch(() => undefined);
        opened = undefined; // already closed; the catch must not close it twice
        throw RequestError.internalError(undefined, SHUTTING_DOWN);
      }
      const server = createEntryServer(meta, port, opened, mcp.tools);
      queueMcpNotices(server, port, mcp, settings.mode);
      entries.set(meta.sessionId, { server, port, meta, release, mcp: mcp.tools });
      return { server, opened };
    } catch (error) {
      // If the facade session opened but a later step threw, do not orphan it.
      await opened?.session.close().catch(() => undefined);
      await mcp?.tools.closeAll();
      await release();
      throw closing ? RequestError.internalError(undefined, SHUTTING_DOWN) : error;
    }
  }

  function createEntryServer(
    meta: SessionMeta,
    port: ClientPort,
    opened: OpenedSession,
    mcp: McpSessionTools,
  ): ServerSession {
    const contextWindow = contextWindowFor(meta.model);
    return createServerSession({
      session: opened.session,
      port,
      cwd: meta.cwd,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      readOldText: deps.readOldText,
      logger: deps.logger,
      turnTimeoutSeconds: deps.turnTimeoutSeconds,
      onTurnEnd: (prompt) => recordTurn(meta.sessionId, prompt),
      titleFor: (name) => mcp.titleFor(name),
    });
  }

  async function closeEntry(sessionId: string, entry: Entry): Promise<void> {
    entries.delete(sessionId);
    try {
      await entry.server.close();
    } finally {
      await entry.mcp.closeAll();
      await entry.release();
    }
  }

  const reopen = createReopen({
    entries,
    storage: deps.storage,
    transcripts: deps.transcripts,
    logger: deps.logger,
    openEntry,
    closeEntry,
    stateOf,
    interruptedNotice: INTERRUPTED_NOTICE,
  }).reopen;

  /** Close-and-reopen with `next` (§3.3). Metadata is written only after the reopen succeeds. */
  async function switchTo(sessionId: string, entry: Entry, next: SessionSettings): Promise<void> {
    const from = settingsOf(entry.meta);
    // A busy session answers "turn in progress" first, as ServerSession.switchTo would.
    if (entry.server.running) throw turnInProgress();
    // Before the live session is closed, so a refused model changes nothing (final review I6).
    if (next.model !== from.model) await deps.ensureCredentials?.(next.model);
    await entry.server.switchTo(
      () => target(sessionId, entry.meta.cwd, next, entry.mcp.embedderTools(next.mode)),
      () => target(sessionId, entry.meta.cwd, from, entry.mcp.embedderTools(from.mode)),
    );
    const meta: SessionMeta = { ...entry.meta, mode: next.mode, model: next.model, bashApproval: next.bashApproval };
    entries.set(sessionId, { ...entry, meta });
    await deps.storage.writeMeta(meta);
    if (next.mode !== from.mode && entry.mcp.connectedCount > 0 && !entry.mcp.offersTools(next.mode))
      await entry.port.update(modeNotice(entry.port.features.updates.notices, next.mode));
  }

  async function announceConfig(entry: Entry, settings: SessionSettings): Promise<void> {
    await entry.port.update({
      sessionUpdate: "config_option_update",
      configOptions: configOptions(settings, options.tiers),
    });
  }

  /**
   * The one path for set_mode and set_config_option: reopen when anything changed,
   * then announce. `current_mode_update` follows every set_mode and any mode
   * change; `config_option_update` follows every change (M-25).
   */
  async function applySettings(
    sessionId: string,
    entry: Entry,
    next: SessionSettings,
    alwaysAnnounceMode: boolean,
  ): Promise<void> {
    const from = settingsOf(entry.meta);
    const changed = !sameSettings(from, next);
    if (changed) await switchTo(sessionId, entry, next);
    if (alwaysAnnounceMode || next.mode !== from.mode) {
      await entry.port.update({ sessionUpdate: "current_mode_update", currentModeId: next.mode });
    }
    if (changed) await announceConfig(entry, next);
  }

  return {
    async create(input) {
      if (!isAbsolute(input.cwd)) throw invalidParams(`cwd must be an absolute path: ${input.cwd}`);
      const model = options.defaultModel;
      if (model === undefined) throw invalidParams(NO_MODEL_MESSAGE);
      const sessionId = deps.newId();
      const meta: SessionMeta = {
        schemaVersion: 1,
        sessionId,
        cwd: input.cwd,
        mode: options.defaultMode,
        model,
        bashApproval: options.bashApproval,
        title: null,
        createdAt: deps.now().toISOString(),
        updatedAt: null,
      };
      const port = input.port(sessionId);
      await openEntry(meta, port, input.mcpServers);
      try {
        await deps.storage.writeMeta(meta);
      } catch (error) {
        const entry = entries.get(sessionId);
        if (entry !== undefined) await closeEntry(sessionId, entry);
        throw error;
      }
      if (closing) {
        // Shutdown started while this create's metadata write was in flight (M-26).
        // closeAll has already cleared the map and closed the entry (releasing its
        // lock), but the write it raced landed after the clear; remove it so no
        // phantom session survives shutdown, then refuse.
        const raced = entries.get(sessionId);
        if (raced !== undefined) await closeEntry(sessionId, raced);
        await deps.storage.removeMeta(sessionId);
        throw RequestError.internalError(undefined, SHUTTING_DOWN);
      }
      deps.logger.info("session", "session opened", { sessionId, cwd: input.cwd, model, mode: meta.mode });
      return { sessionId, ...stateOf(settingsOf(meta)) };
    },
    load: (sessionId, input) => reopen(sessionId, input, true),
    resume: (sessionId, input) => reopen(sessionId, input, false),
    list: (query) => deps.storage.list(query),
    get: (sessionId) => entryOf(sessionId).server,
    find: (sessionId) => entries.get(sessionId)?.server,
    async close(sessionId) {
      await closeEntry(sessionId, entryOf(sessionId));
    },
    async delete(sessionId) {
      const entry = entries.get(sessionId);
      if (entry !== undefined) await closeEntry(sessionId, entry);
      else if (!(await deps.storage.hasMeta(sessionId))) throw unknownSession(sessionId);
      const release = await deps.storage.acquireLock(sessionId);
      try {
        await deps.transcripts.delete(sessionId);
        await deps.storage.removeMeta(sessionId);
      } finally {
        await release();
      }
    },
    async setMode(sessionId, modeId) {
      const entry = entryOf(sessionId);
      const next = applyModeChange(settingsOf(entry.meta), modeId);
      await applySettings(sessionId, entry, next, true);
    },
    async setConfigOption(sessionId, configId, value) {
      const entry = entryOf(sessionId);
      const next = applyConfigChange(settingsOf(entry.meta), configId, value, options.tiers);
      await applySettings(sessionId, entry, next, false);
      return configOptions(next, options.tiers);
    },
    async closeAll() {
      closing = true;
      shutdown.abort();
      const open = [...entries.entries()];
      entries.clear();
      const wait = deps.shutdownWaitMs ?? SHUTDOWN_WAIT_MS;
      await Promise.all(
        open.map(async ([sessionId, entry]) => {
          entry.server.cancel();
          const limit = waitAtMost(wait);
          const closed = entry.server.close().then(
            () => "closed" as const,
            (error: unknown) => {
              deps.logger.warn("session", "session close failed", { sessionId, error: messageOf(error) });
              return "closed" as const;
            },
          );
          const outcome = await Promise.race([closed, limit.done]);
          limit.cancel();
          if (outcome === "timeout")
            deps.logger.warn("session", "session did not close in time", { sessionId, waitMs: wait });
          await entry.mcp.closeAll();
          await entry.release();
        }),
      );
    },
  };
}
