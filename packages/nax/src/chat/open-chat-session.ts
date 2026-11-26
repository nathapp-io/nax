import { randomUUID } from "node:crypto";
import {
  type AgentSession,
  type BackgroundCommandPort,
  buildCommandShadow,
  type CommandShadow,
  type CreateAgentSessionOptions,
  createAgentSession,
  createFileTranscriptStore,
  createSessionStorage,
  defaultSessionsDir,
  type LoopHandlerSet,
  nativeBackend,
  resumeAgentSession,
  SESSION_ID_PATTERN,
  type SessionMeta,
  type SessionStorage,
  type SessionStorageDeps,
  type ToolProvider,
  type TranscriptDoc,
  type TranscriptStore,
} from "@nathapp/nax-agent";
import { globalConfigDir, type NaxConfig, resolveTuiPermissions, type TuiPermissions } from "@/config";
import { resolveRuleSet } from "@/context/rules/rule-set";
import { NaxError } from "@/errors";
import { getLogger } from "@/logger";
import { buildChatHandoff, buildChatInstructions, toRulesIndexEntry } from "@/prompts";
import {
  ACP_FRESH_SESSION_NOTICE,
  ACP_HANDOFF_TRIMMED_NOTICE,
  acpAgentLabel,
  acpHandoff,
  acpSessionOptions,
  acpTranscriptDir,
  type ChatAcpModel,
  isFreshFallback,
  parseChatAcpModel,
  recordAcpTurns,
  unseenMessages,
} from "./acp";
import { chatCompactAtTokens } from "./chat-compaction";
import { type ChatMode, chatBackendPosture, chatModeOfMeta, chatSessionSettings } from "./chat-mode";
import { createHostQueue, type HostQueue } from "./host-queue";
import { persistSessionWeb, sessionWebProviders } from "./session-web";
import { type ChatWeb, createChatWeb } from "./web/wiring";

export const _openChatSessionDeps = {
  createChatWeb,
  getLogger,
  buildCommandShadow,
  createAgentSession,
  resumeAgentSession,
  nativeBackend,
  createSessionStorage,
  createFileTranscriptStore,
  resolveRuleSet,
  resolveTuiPermissions,
  randomUUID: (): string => randomUUID(),
  env: process.env,
  now: (): Date => new Date(),
};

export interface OpenChatSessionRequest {
  /** Share immediate exposure writes with the host's turn/compaction accounting queue. */
  readonly metadataQueue?: HostQueue;
  readonly backgroundCommands?: BackgroundCommandPort;
  readonly toolProviders?: readonly ToolProvider[];
  readonly storage: SessionStorage;
  readonly cwd: string;
  readonly repoRoot: string;
  readonly mode?: ChatMode;
  readonly model?: string;
  readonly resumeId?: string;
  readonly loopHandlers: LoopHandlerSet;
  readonly config: NaxConfig;
  /** The rendered memory index this open carries into the session's instructions; absent when there is none. */
  readonly memoryIndex?: string;
}

export interface ChatHistory {
  readonly messages: readonly TranscriptDoc["messages"][number][];
  readonly savedAt?: string;
}

export interface ChatSessionHandle {
  readonly web?: ChatWeb;
  /** The serialization point owned by this web-enabled open; absent on legacy/no-web handles. */
  readonly metadataQueue?: HostQueue;
  readonly history?: ChatHistory;
  readonly session: AgentSession;
  readonly meta: SessionMeta;
  /**
   * Set when an ACP brain's stored agent session was unusable and a fresh one replaced it, or when
   * its handoff of earlier messages had to be trimmed; both are joined with "; ". Absent otherwise.
   */
  readonly notice?: string;
  /** Retire per-open work; reopens retain the host's shared storage lock. */
  readonly release: (options?: { readonly retainLock?: boolean }) => Promise<void>;
}

export type ChatStorageOptions = Pick<SessionStorageDeps, "pid" | "now" | "logger"> & {
  readonly env?: Readonly<Record<string, string | undefined>>;
};

export function resolveChatSessionsDir(
  env: Readonly<Record<string, string | undefined>> = _openChatSessionDeps.env,
): string {
  return env.NAX_AGENT_SESSIONS_DIR ?? defaultSessionsDir(globalConfigDir());
}

export function createChatStorage(options: ChatStorageOptions): SessionStorage {
  const { env = _openChatSessionDeps.env, pid, now, logger } = options;
  return _openChatSessionDeps.createSessionStorage({ dir: resolveChatSessionsDir(env), pid, now, logger });
}

/** Metadata must identify the same session as its filename before it can own a lock. */
async function readResumeMeta(storage: SessionStorage, id: string): Promise<SessionMeta> {
  const stored = await storage.readMeta(id);
  if (stored === null) {
    throw new NaxError(`no session ${id} in ${storage.dir}`, "CHAT_SESSION_NOT_FOUND", {
      stage: "chat",
      sessionId: id,
    });
  }
  if (stored.sessionId !== id) {
    throw new NaxError(`[chat] session metadata for ${id} has a mismatched sessionId`, "SESSION_META_UNREADABLE", {
      stage: "chat",
      sessionId: id,
    });
  }
  return stored;
}

interface SessionPosture {
  readonly mode: ChatMode;
  readonly posture: TuiPermissions | undefined;
  readonly stored: SessionMeta | undefined;
}

/** Stored mode validation must precede posture resolution and lock ownership. */
function validatedMode(stored: SessionMeta): ChatMode {
  const mode = chatModeOfMeta(stored.mode);
  if (mode === null) {
    throw new NaxError(
      `session ${stored.sessionId} was created in mode ${stored.mode}; nax chat opens full or ask sessions only`,
      "CHAT_SESSION_MODE_UNSUPPORTED",
      { stage: "chat", sessionId: stored.sessionId },
    );
  }
  return mode;
}

function sessionMeta(
  request: OpenChatSessionRequest,
  { mode, posture, stored }: SessionPosture,
  deps: typeof _openChatSessionDeps,
): SessionMeta {
  const settings = chatSessionSettings(mode, posture);
  if (stored !== undefined) {
    return {
      ...stored,
      mode: settings.metaMode,
      bashApproval: settings.bashApproval,
      model: request.model ?? stored.model,
    };
  }
  if (request.model === undefined) {
    throw new NaxError("[chat] a model is required for a new session", "CHAT_SESSION_MODEL_REQUIRED", {
      stage: "chat",
    });
  }
  return {
    schemaVersion: 1,
    sessionId: deps.randomUUID(),
    cwd: request.cwd,
    mode: settings.metaMode,
    model: request.model,
    bashApproval: settings.bashApproval,
    title: null,
    createdAt: deps.now().toISOString(),
    updatedAt: null,
  };
}

async function sessionOptions(
  request: OpenChatSessionRequest,
  {
    meta,
    posture,
    commandShadow,
    web,
  }: {
    readonly meta: SessionMeta;
    readonly posture: TuiPermissions | undefined;
    readonly commandShadow: CommandShadow | undefined;
    readonly web?: ChatWeb;
  },
  deps: typeof _openChatSessionDeps,
): Promise<Omit<CreateAgentSessionOptions, "transcriptStore">> {
  const rules = request.config.context.rules;
  const set = await deps.resolveRuleSet({
    repoRoot: request.repoRoot,
    packageDir: request.repoRoot,
    overrideDir: rules?.overrideDir,
    overrideMode: rules?.overrideMode,
  });
  const mode = meta.mode === "full" ? "full" : "guarded";
  const catalogOverrides = request.config.agent?.native?.catalogOverrides;
  // US-006: chat compaction is the execution percentages with the chat's own absolute cap on
  // top. `0` in `chat.compaction` turns the cap off rather than falling back to execution's.
  const compaction = { ...request.config.execution.compaction, compactAtTokens: chatCompactAtTokens(request.config) };
  return {
    backend: deps.nativeBackend({
      ...chatBackendPosture(mode, request.config, posture),
      ...(web ? { sandbox: web.sandbox } : {}),
      ...(commandShadow !== undefined || request.backgroundCommands !== undefined || web !== undefined
        ? {
            hostPorts: {
              ...(web ? { webExposure: web.guard } : {}),
              ...(commandShadow !== undefined ? { commandShadow } : {}),
              ...(request.backgroundCommands !== undefined ? { backgroundCommands: request.backgroundCommands } : {}),
            },
          }
        : {}),
      model: meta.model,
      bashApproval: meta.bashApproval,
      allowUnsandboxed: true,
      allowUnsandboxedCommands: true,
      carryHistoryAcrossModels: true,
      loopHandlers: request.loopHandlers,
      ...(request.toolProviders !== undefined ? { toolProviders: request.toolProviders } : {}),
      loopHandlerRole: "tui",
      ...(catalogOverrides?.length ? { catalogOverrides } : {}),
      compaction,
    }),
    sessionId: meta.sessionId,
    profile: chatSessionSettings(mode, posture).profile,
    workdir: request.cwd,
    instructions: buildChatInstructions({
      mode,
      rulesIndex: set.rules.map(toRulesIndexEntry),
      ...(request.memoryIndex !== undefined ? { memoryIndex: request.memoryIndex } : {}),
    }),
    approvalTimeoutMs: request.config.execution.approvalTimeout,
    // A chat turn is the user's: it runs until it finishes or they stop it with Esc, never
    // against a wall clock (#2962).
    turnTimeoutSeconds: "none",
  };
}

interface OpenedBrain {
  readonly session: AgentSession;
  readonly notice?: string;
  /** True when the agent session was created (with or without the fallback), so it has seen none of the document. */
  readonly fresh: boolean;
}

/**
 * Create or resume the agent's own session over its own transcript document. Only a document
 * with a `turn` marker is resumed; a turn-less one is deleted and replaced silently. A stored
 * document the agent can no longer use is retained and replaced; any other failure propagates.
 */
async function openAcpBrain(
  request: OpenChatSessionRequest,
  { meta, acp }: { readonly meta: SessionMeta; readonly acp: ChatAcpModel },
  deps: typeof _openChatSessionDeps,
): Promise<OpenedBrain> {
  const store = deps.createFileTranscriptStore(acpTranscriptDir(request.storage.dir, acp.agent));
  const options = {
    ...(await acpSessionOptions({
      acp,
      mode: meta.mode === "full" ? "full" : "guarded",
      sessionId: meta.sessionId,
      cwd: request.cwd,
      toolProviders: request.toolProviders ?? [],
      approvalTimeoutMs: request.config.execution.approvalTimeout,
      ...(request.memoryIndex !== undefined ? { memoryIndex: request.memoryIndex } : {}),
    })),
    transcriptStore: store,
  };
  let unusable = false;
  try {
    const stored = await store.load(meta.sessionId);
    // A document without a turn marker is a session the agent never prompted: resuming it would
    // fail the same way, so drop it and create a fresh one (nothing was lost, so no notice).
    if (stored?.turn === undefined) {
      if (stored !== null) await store.delete(meta.sessionId);
    } else {
      return { session: await deps.resumeAgentSession(meta.sessionId, options), fresh: false };
    }
  } catch (error) {
    if (!isFreshFallback(error)) throw error;
    unusable = true;
  }
  if (unusable) await store.retainFailed(meta.sessionId);
  const session = await deps.createAgentSession(options);
  return unusable
    ? { session, notice: ACP_FRESH_SESSION_NOTICE(acpAgentLabel(acp.agent)), fresh: true }
    : { session, fresh: true };
}

/**
 * Hand the opened agent the conversation it has not seen and record its turns into the native
 * document. The notice joins the fallback notice and the trimmed-handoff notice; absent when neither applies.
 */
function withAcpHistory(
  opened: OpenedBrain,
  context: {
    readonly meta: SessionMeta;
    readonly acp: ChatAcpModel;
    readonly history: ChatHistory;
    readonly transcripts: TranscriptStore;
  },
): { readonly session: AgentSession; readonly notice?: string } {
  const { meta, acp, history, transcripts } = context;
  const handoff = acpHandoff(unseenMessages(history.messages, acp.agent, opened.fresh));
  const session = recordAcpTurns(opened.session, {
    store: transcripts,
    sessionId: meta.sessionId,
    acp,
    handoff: buildChatHandoff(handoff),
  });
  const trimmed =
    handoff.omitted > 0 ? ACP_HANDOFF_TRIMMED_NOTICE(acpAgentLabel(acp.agent), handoff.omitted) : undefined;
  const notice = [opened.notice, trimmed].filter((part) => part !== undefined).join("; ");
  return notice === "" ? { session } : { session, notice };
}

/** The shadow's drain is total and bounded; retain lock ownership until it settles. */
function sessionRelease(
  unlock: () => Promise<void>,
  shadow: () => CommandShadow | undefined,
  retireWeb: () => Promise<void>,
): ChatSessionHandle["release"] {
  let drained: Promise<void> | undefined;
  let unlocked: Promise<void> | undefined;
  return async (options) => {
    try {
      drained ??= Promise.allSettled([retireWeb(), Promise.resolve().then(() => shadow()?.drain())]).then((results) => {
        for (const result of results) if (result.status === "rejected") throw result.reason;
      });
      await drained;
    } finally {
      if (!options?.retainLock) {
        unlocked ??= unlock();
        await unlocked;
      }
    }
  };
}

function historyOf(doc: TranscriptDoc | null): ChatHistory {
  return doc === null ? { messages: [] } : { messages: doc.messages, savedAt: doc.savedAt };
}

/** Open the native brain's session over the shared transcript store. */
async function openNativeBrain(
  request: OpenChatSessionRequest,
  state: {
    readonly meta: SessionMeta;
    readonly posture: TuiPermissions | undefined;
    readonly commandShadow: CommandShadow | undefined;
    readonly web?: ChatWeb;
  },
  transcripts: TranscriptStore,
  deps: typeof _openChatSessionDeps,
): Promise<{ readonly session: AgentSession; readonly history: ChatHistory }> {
  const { meta, posture } = state;
  const options = {
    ...(await sessionOptions(request, { ...state, meta, posture }, deps)),
    transcriptStore: transcripts,
  };
  const doc = await transcripts.load(meta.sessionId);
  const session =
    doc === null ? await deps.createAgentSession(options) : await deps.resumeAgentSession(meta.sessionId, options);
  return { session, history: historyOf(doc) };
}

interface OpenBrainState {
  readonly meta: SessionMeta;
  readonly posture: TuiPermissions | undefined;
  readonly commandShadow: CommandShadow | undefined;
  readonly acp: ChatAcpModel | undefined;
  readonly transcripts: TranscriptStore;
  readonly release: ChatSessionHandle["release"];
  readonly retireWeb: (release: () => Promise<void>) => void;
}

async function openWebNative(
  input: { readonly request: OpenChatSessionRequest; readonly state: OpenBrainState; readonly web?: ChatWeb },
  deps: typeof _openChatSessionDeps,
): Promise<ChatSessionHandle> {
  const { request, state, web } = input;
  const { meta, posture, commandShadow, transcripts, release } = state;
  const metadataQueue = request.metadataQueue ?? createHostQueue();
  const persistence = web
    ? persistSessionWeb({
        web,
        storage: request.storage,
        sessionId: meta.sessionId,
        queue: metadataQueue,
        logger: deps.getLogger(),
      })
    : undefined;
  if (persistence) state.retireWeb(persistence.release);
  const opened = await openNativeBrain(request, { meta, posture, commandShadow, web }, transcripts, deps);
  return {
    session: persistence?.wrap(opened.session) ?? opened.session,
    meta,
    release,
    history: opened.history,
    ...(web ? { web, metadataQueue } : {}),
  };
}

async function openChatBrain(
  request: OpenChatSessionRequest,
  state: OpenBrainState,
  deps: typeof _openChatSessionDeps,
): Promise<ChatSessionHandle> {
  const { meta, acp, transcripts, release } = state;
  const result = await deps.createChatWeb({
    config: request.config,
    repoRoot: request.repoRoot,
    meta,
    backend: acp === undefined ? "native" : "acp",
  });
  const providers = sessionWebProviders({
    providers: request.toolProviders,
    web: result.web,
    acp: acp !== undefined,
    logger: deps.getLogger(),
  });
  const webRequest = { ...request, ...(providers === undefined ? {} : { toolProviders: providers }) };
  let handle: ChatSessionHandle;
  if (acp === undefined) handle = await openWebNative({ request: webRequest, state, web: result.web }, deps);
  else {
    const history = historyOf(await transcripts.load(meta.sessionId));
    const opened = await openAcpBrain(webRequest, { meta, acp }, deps);
    handle = { ...withAcpHistory(opened, { meta, acp, history, transcripts }), meta, release, history };
  }
  const notice = [handle.notice, result.notice].filter((part) => part !== undefined).join("; ");
  return notice ? { ...handle, notice } : handle;
}

/** Open the shared chat session while holding its store lock until the host releases it. */
export async function openChatSession(
  request: OpenChatSessionRequest,
  deps = _openChatSessionDeps,
): Promise<ChatSessionHandle> {
  if (request.resumeId !== undefined && !SESSION_ID_PATTERN.test(request.resumeId)) {
    throw new NaxError("[chat] invalid session id", "CHAT_SESSION_ID_INVALID", { stage: "chat" });
  }
  const transcripts = deps.createFileTranscriptStore(request.storage.dir);
  const stored = request.resumeId === undefined ? undefined : await readResumeMeta(request.storage, request.resumeId);
  const storedMode = stored === undefined ? undefined : validatedMode(stored);
  const mode = request.mode ?? storedMode ?? "guarded";
  const posture = mode === "guarded" ? deps.resolveTuiPermissions(request.config) : undefined;
  const meta = sessionMeta(request, { mode, posture, stored }, deps);
  // An invalid ACP model string must refuse before the storage lock is taken.
  const acp = parseChatAcpModel(meta.model);
  const unlock = await request.storage.acquireLock(meta.sessionId);
  let commandShadow: CommandShadow | undefined;
  let retireWeb = async (): Promise<void> => {};
  const release = sessionRelease(
    unlock,
    () => commandShadow,
    () => retireWeb(),
  );
  try {
    if (acp === undefined && mode === "guarded")
      commandShadow = deps.buildCommandShadow({
        config: request.config.execution.commandSafety,
        outputDir: request.storage.dir,
        runId: meta.sessionId,
        env: deps.env,
      });
    if (request.resumeId === undefined) await request.storage.writeMeta(meta);
    return await openChatBrain(
      request,
      {
        meta,
        posture,
        commandShadow,
        acp,
        transcripts,
        release,
        retireWeb: (retire) => {
          retireWeb = retire;
        },
      },
      deps,
    );
  } catch (error) {
    await release();
    throw error;
  }
}
