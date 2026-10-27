import { randomUUID } from "node:crypto";
import {
  type AgentSession,
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
} from "@nathapp/nax-agent";
import { globalConfigDir, type NaxConfig, resolveTuiPermissions, type TuiPermissions } from "@/config";
import { resolveRuleSet } from "@/context/rules/rule-set";
import { NaxError } from "@/errors";
import { buildChatInstructions, toRulesIndexEntry } from "@/prompts";
import { type ChatMode, chatBackendPosture, chatModeOfMeta, chatSessionSettings } from "./chat-mode";

export const _openChatSessionDeps = {
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
  readonly toolProviders?: readonly ToolProvider[];
  readonly storage: SessionStorage;
  readonly cwd: string;
  readonly repoRoot: string;
  readonly mode?: ChatMode;
  readonly model?: string;
  readonly resumeId?: string;
  readonly loopHandlers: LoopHandlerSet;
  readonly config: NaxConfig;
}

export interface ChatSessionHandle {
  readonly session: AgentSession;
  readonly meta: SessionMeta;
  readonly release: () => Promise<void>;
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
  }: {
    readonly meta: SessionMeta;
    readonly posture: TuiPermissions | undefined;
    readonly commandShadow: CommandShadow | undefined;
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
  const compaction = request.config.execution.compaction;
  return {
    backend: deps.nativeBackend({
      ...chatBackendPosture(mode, request.config, posture),
      ...(commandShadow !== undefined ? { hostPorts: { commandShadow } } : {}),
      model: meta.model,
      bashApproval: meta.bashApproval,
      allowUnsandboxed: true,
      allowUnsandboxedCommands: true,
      carryHistoryAcrossModels: true,
      loopHandlers: request.loopHandlers,
      ...(request.toolProviders !== undefined ? { toolProviders: request.toolProviders } : {}),
      loopHandlerRole: "tui",
      ...(catalogOverrides?.length ? { catalogOverrides } : {}),
      ...(compaction !== undefined ? { compaction } : {}),
    }),
    sessionId: meta.sessionId,
    profile: chatSessionSettings(mode, posture).profile,
    workdir: request.cwd,
    instructions: buildChatInstructions({ mode, rulesIndex: set.rules.map(toRulesIndexEntry) }),
    approvalTimeoutMs: request.config.execution.approvalTimeout,
  };
}

/** The shadow's drain is total and bounded; retain lock ownership until it settles. */
function sessionRelease(unlock: () => Promise<void>, shadow: () => CommandShadow | undefined): () => Promise<void> {
  let released: Promise<void> | undefined;
  return () =>
    (released ??= (async () => {
      try {
        await shadow()?.drain();
      } finally {
        await unlock();
      }
    })());
}

/** Open the shared native session while holding its store lock until the host releases it. */
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
  const unlock = await request.storage.acquireLock(meta.sessionId);
  let commandShadow: CommandShadow | undefined;
  const release = sessionRelease(unlock, () => commandShadow);
  try {
    if (mode === "guarded")
      commandShadow = deps.buildCommandShadow({
        config: request.config.execution.commandSafety,
        outputDir: request.storage.dir,
        runId: meta.sessionId,
        env: deps.env,
      });
    if (request.resumeId === undefined) await request.storage.writeMeta(meta);
    const options = {
      ...(await sessionOptions(request, { meta, posture, commandShadow }, deps)),
      transcriptStore: transcripts,
    };
    const doc = await transcripts.load(meta.sessionId);
    const session =
      doc === null ? await deps.createAgentSession(options) : await deps.resumeAgentSession(meta.sessionId, options);
    return { session, meta, release };
  } catch (error) {
    await release();
    throw error;
  }
}
