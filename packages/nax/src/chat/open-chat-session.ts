import { randomUUID } from "node:crypto";
import {
  type AgentSession,
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
import { globalConfigDir, type NaxConfig } from "@/config";
import { resolveRuleSet } from "@/context/rules/rule-set";
import { NaxError } from "@/errors";
import { buildChatInstructions, toRulesIndexEntry } from "@/prompts";
import { type ChatMode, chatModeOfMeta, chatSessionSettings } from "./chat-mode";

export const _openChatSessionDeps = {
  createAgentSession,
  resumeAgentSession,
  nativeBackend,
  createSessionStorage,
  createFileTranscriptStore,
  resolveRuleSet,
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

/** Validate stored modes before taking ownership, including on an explicit switch. */
async function sessionMeta(request: OpenChatSessionRequest, deps: typeof _openChatSessionDeps): Promise<SessionMeta> {
  if (request.resumeId !== undefined) {
    const id = request.resumeId;
    const stored = await readResumeMeta(request.storage, id);
    const mode = chatModeOfMeta(stored.mode);
    if (mode === null) {
      throw new NaxError(
        `session ${id} was created in mode ${stored.mode}; nax chat opens full or ask sessions only`,
        "CHAT_SESSION_MODE_UNSUPPORTED",
        { stage: "chat", sessionId: id },
      );
    }
    const settings = chatSessionSettings(request.mode ?? mode);
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
  const settings = chatSessionSettings(request.mode ?? "guarded");
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
  meta: SessionMeta,
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
    profile: chatSessionSettings(mode).profile,
    workdir: request.cwd,
    instructions: buildChatInstructions({ mode, rulesIndex: set.rules.map(toRulesIndexEntry) }),
    approvalTimeoutMs: request.config.execution.approvalTimeout,
  };
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
  const meta = await sessionMeta(request, deps);
  const release = await request.storage.acquireLock(meta.sessionId);
  try {
    if (request.resumeId === undefined) await request.storage.writeMeta(meta);
    const options = { ...(await sessionOptions(request, meta, deps)), transcriptStore: transcripts };
    const doc = await transcripts.load(meta.sessionId);
    const session =
      doc === null ? await deps.createAgentSession(options) : await deps.resumeAgentSession(meta.sessionId, options);
    return { session, meta, release };
  } catch (error) {
    await release();
    throw error;
  }
}
