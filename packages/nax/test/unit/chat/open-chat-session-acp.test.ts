import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import {
  type AgentSession,
  AgentSessionError,
  type AgentSessionErrorCode,
  buildCommandShadow,
  type CreateAgentSessionOptions,
  createSessionStorage,
  type ProviderTool,
  type SessionBackend,
  type SessionStorage,
  type ToolProvider,
  type TranscriptDoc,
  type TranscriptStore,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import { _acpSessionDeps, ACP_FRESH_SESSION_NOTICE } from "@/chat/acp/acp-session-options";
import {
  _openChatSessionDeps,
  type ChatSessionHandle,
  type OpenChatSessionRequest,
  openChatSession,
} from "@/chat/open-chat-session";
import { NaxError } from "@/errors";

const ID = "acp-session-id";
/** A stored agent document only resumes once its agent ran a turn. */
const ENDED_TURN: NonNullable<TranscriptDoc["turn"]> = { turnId: "t1", state: "ended" };
const NOW = new Date("2026-10-01T00:00:00.000Z");
const acpBackendStub: SessionBackend = {
  kind: "acp:test",
  async open() {
    throw new NaxError("unexpected backend open", "TEST_FAILURE", { stage: "test" });
  },
};
const session: AgentSession = {
  id: ID,
  backend: { kind: "acp:test", capabilities: {} },
  lastTurn: undefined,
  async *send() {},
  answer: () => "unknown",
  cancel() {},
  async close() {},
};

type CreateFn = (options: CreateAgentSessionOptions) => Promise<AgentSession>;
type ResumeFn = (id: string, options: CreateAgentSessionOptions) => Promise<AgentSession>;

let dir: string;
let storage: SessionStorage;
let request: OpenChatSessionRequest;
let deps: typeof _openChatSessionDeps;
let docs: Map<string, TranscriptDoc | null>;
let stores: Map<string, TranscriptStore>;
let calls: string[];
let createMock: ReturnType<typeof mock<CreateFn>>;
let resumeMock: ReturnType<typeof mock<ResumeFn>>;
const originalAcpDeps = { ..._acpSessionDeps };
const releases: (() => Promise<void>)[] = [];

/** One recording fake store per directory, so a test can assert which store a call reached. */
function storeFor(path: string): TranscriptStore {
  const existing = stores.get(path);
  if (existing !== undefined) return existing;
  const store: TranscriptStore = {
    load: mock(async () => docs.get(path) ?? null),
    save: async () => {},
    retainFailed: mock(async () => {
      calls.push(`retain:${path}`);
    }),
    delete: async () => {},
    markTurn: async () => {},
  };
  stores.set(path, store);
  return store;
}

function tool(localName: string): ProviderTool {
  return {
    localName,
    description: `${localName} tool`,
    inputSchema: { type: "object", properties: {} },
    run: async () => ({ content: "ok" }),
  };
}

function provider(id: string, extra: Partial<ToolProvider> = {}): ToolProvider {
  return { id, kind: "static", stages: ["*"], tools: async () => [tool("state")], ...extra };
}

beforeEach(() => {
  dir = makeTempDir("chat-open-acp-");
  storage = createSessionStorage({ dir, pid: process.pid, now: () => NOW, logger: makeLogger() });
  request = {
    storage,
    cwd: join(dir, "work"),
    repoRoot: dir,
    model: "acp:codex/gpt-5.5",
    mode: "guarded",
    loopHandlers: [],
    config: makeNaxConfig(),
  };
  docs = new Map();
  stores = new Map();
  calls = [];
  createMock = mock<CreateFn>(async () => {
    calls.push("create");
    return session;
  });
  resumeMock = mock<ResumeFn>(async () => session);
  deps = {
    ..._openChatSessionDeps,
    randomUUID: () => ID,
    now: () => NOW,
    nativeBackend: mock(() => {
      throw new NaxError("native backend must not open", "TEST_FAILURE", { stage: "test" });
    }),
    buildCommandShadow: mock(buildCommandShadow),
    createAgentSession: createMock,
    resumeAgentSession: resumeMock,
    createFileTranscriptStore: mock((path: string) => storeFor(path)),
  };
  _acpSessionDeps.acpBackend = mock(() => acpBackendStub);
});

afterEach(async () => {
  await Promise.all(releases.splice(0).map((release) => release()));
  Object.assign(_acpSessionDeps, originalAcpDeps);
  mock.restore();
  cleanupTempDir(dir);
});

async function open(overrides: Partial<OpenChatSessionRequest> = {}): Promise<ChatSessionHandle> {
  const handle = await openChatSession({ ...request, ...overrides }, deps);
  releases.push(handle.release);
  return handle;
}

async function seed(model: string): Promise<void> {
  await storage.writeMeta({
    schemaVersion: 1,
    sessionId: ID,
    cwd: request.cwd,
    mode: "ask",
    model,
    bashApproval: "raw",
    title: "Existing",
    createdAt: NOW.toISOString(),
    updatedAt: null,
  });
}

function agentDir(agent: string): string {
  return join(storage.dir, `acp-${agent}`);
}

function agentError(code: AgentSessionErrorCode, context: Record<string, unknown> = {}): AgentSessionError {
  return new AgentSessionError(`injected ${code}`, code, context);
}

/** A stored agent document for `agent` and a resume that fails with `error`. */
async function resumeFailing(error: unknown, agent = "codex"): Promise<void> {
  await seed(`acp:${agent}`);
  docs.set(agentDir(agent), { savedAt: NOW.toISOString(), messages: [], turn: ENDED_TURN });
  resumeMock.mockImplementation(async () => {
    throw error;
  });
}

function createdOptions(): CreateAgentSessionOptions {
  const options = createMock.mock.calls[0]?.[0];
  if (options === undefined) throw new Error("createAgentSession was not called");
  return options;
}

describe("openChatSession on an ACP model: new session", () => {
  test("AC-1 creates once with the ACP backend and profile ask", async () => {
    await open();
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(_acpSessionDeps.acpBackend).toHaveBeenCalledTimes(1);
    expect(createdOptions().backend).toBe(acpBackendStub);
    expect(createdOptions().profile).toBe("ask");
    expect(createdOptions().sessionId).toBe(ID);
  });

  test("AC-2 never opens the native backend or builds a command shadow", async () => {
    await open({ mode: "guarded" });
    expect(deps.nativeBackend).not.toHaveBeenCalled();
    expect(deps.buildCommandShadow).not.toHaveBeenCalled();
  });

  test("AC-3 passes the file transcript store created for acp-codex", async () => {
    await open();
    expect(deps.createFileTranscriptStore).toHaveBeenCalledWith(join(storage.dir, "acp-codex"));
    expect(createdOptions().transcriptStore).toBe(storeFor(join(storage.dir, "acp-codex")));
    expect(createdOptions().transcriptStore).not.toBe(storeFor(storage.dir));
  });

  test("AC-4 instructions name the agent and carry the workflow provider's text", async () => {
    const workflow = provider("nax-workflow", { instructions: async () => "WORKFLOW-INSTRUCTIONS-TEXT" });
    await open({ toolProviders: [workflow] });
    expect(createdOptions().instructions).toContain("Codex");
    expect(createdOptions().instructions).toContain("WORKFLOW-INSTRUCTIONS-TEXT");
  });

  test("AC-5 delivers only workflow and jobs tools", async () => {
    const providers = [provider("nax-workflow"), provider("nax-jobs"), provider("nax-skills")];
    await open({ model: "acp:codex", toolProviders: providers });
    const names = (createdOptions().tools ?? []).map((t) => t.name);
    expect(names.length).toBe(2);
    for (const name of names) expect(/^(nax-workflow|nax-jobs)__/.test(name)).toBe(true);
  });

  test.each([
    ["nax-workflow", "nax-jobs"],
    ["nax-jobs", "nax-workflow"],
  ] as const)(
    "AC-21 a rejecting %s provider contributes no tools but the session opens",
    async (brokenId, healthyId) => {
      const broken = provider(brokenId, {
        tools: async () => {
          throw new Error(`${brokenId} unavailable`);
        },
      });
      await open({ toolProviders: [broken, provider(healthyId)] });
      expect(createMock).toHaveBeenCalledTimes(1);
      const names = (createdOptions().tools ?? []).map((t) => t.name);
      expect(names).toEqual([`${healthyId}__state`]);
    },
  );

  test("AC-14 a handle opened without a fallback has no notice", async () => {
    const handle = await open();
    expect(handle.notice).toBeUndefined();
    expect("notice" in handle).toBe(false);
  });

  test("AC-16 an invalid ACP model rejects before the lock is taken", async () => {
    const acquire = spyOn(storage, "acquireLock");
    await expect(open({ model: "acp:gemini" })).rejects.toMatchObject({ code: "CHAT_ACP_MODEL_INVALID" });
    expect(acquire).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  test("AC-17 a native model still opens the native backend and never the ACP one", async () => {
    deps.nativeBackend = mock(() => acpBackendStub);
    await open({ model: "openai/gpt-6" });
    expect(deps.nativeBackend).toHaveBeenCalledTimes(1);
    expect(_acpSessionDeps.acpBackend).not.toHaveBeenCalled();
    expect(deps.createFileTranscriptStore).toHaveBeenCalledTimes(1);
    expect(deps.createFileTranscriptStore).toHaveBeenCalledWith(storage.dir);
  });

  test.each([
    ["AGENT_SESSION_CAPABILITY_UNSUPPORTED", { capability: "resume" }],
    ["AGENT_SESSION_MODEL_MISMATCH", {}],
    ["AGENT_SESSION_BACKEND_UNAVAILABLE", {}],
  ] as const)("AC-20 a new-session open failing with %s propagates without a fallback", async (code, context) => {
    const error = agentError(code, context);
    createMock.mockImplementation(async () => {
      throw error;
    });
    await expect(open()).rejects.toBe(error);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(resumeMock).not.toHaveBeenCalled();
    expect(await storage.readLockHolder(ID)).toBeNull();
  });

  test("AC-20 a new-session timeout propagates without a fallback", async () => {
    const error = new Error("timed out");
    createMock.mockImplementation(async () => {
      throw error;
    });
    await expect(open()).rejects.toBe(error);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(await storage.readLockHolder(ID)).toBeNull();
  });
});

describe("openChatSession on an ACP model: resume", () => {
  test("AC-6 resumes the agent document with the session id and the agent store", async () => {
    await seed("acp:codex");
    docs.set(agentDir("codex"), { savedAt: NOW.toISOString(), messages: [], turn: ENDED_TURN });
    const handle = await open({ resumeId: ID, model: undefined });
    expect(createMock).not.toHaveBeenCalled();
    const [id, options] = resumeMock.mock.calls[0] ?? [];
    expect(id).toBe(ID);
    expect(options?.transcriptStore).toBe(storeFor(agentDir("codex")));
    expect(handle.notice).toBeUndefined();
  });

  test("AC-7 creates with the same session id when the agent store has no document", async () => {
    await seed("acp:claude");
    await open({ resumeId: ID, model: undefined });
    expect(resumeMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createdOptions().sessionId).toBe(ID);
    expect(createdOptions().transcriptStore).toBe(storeFor(agentDir("claude")));
  });

  test("AC-8/AC-9 NOT_FOUND retains the document, then creates once, with a notice", async () => {
    await resumeFailing(agentError("AGENT_SESSION_NOT_FOUND"));
    const handle = await open({ resumeId: ID, model: undefined });
    expect(storeFor(agentDir("codex")).retainFailed).toHaveBeenCalledWith(ID);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([`retain:${agentDir("codex")}`, "create"]);
    expect(handle.notice).toBe(ACP_FRESH_SESSION_NOTICE("Codex"));
  });

  test("AC-10 a resume capability refusal takes the same fallback", async () => {
    await resumeFailing(agentError("AGENT_SESSION_CAPABILITY_UNSUPPORTED", { capability: "resume" }));
    const handle = await open({ resumeId: ID, model: undefined });
    expect(calls).toEqual([`retain:${agentDir("codex")}`, "create"]);
    expect(handle.notice).toBe(ACP_FRESH_SESSION_NOTICE("Codex"));
  });

  test("AC-11 a model capability refusal propagates and retains nothing", async () => {
    const error = agentError("AGENT_SESSION_CAPABILITY_UNSUPPORTED", { capability: "model" });
    await resumeFailing(error);
    await expect(open({ resumeId: ID, model: undefined })).rejects.toBe(error);
    expect(storeFor(agentDir("codex")).retainFailed).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    expect(await storage.readLockHolder(ID)).toBeNull();
  });

  test("AC-12 an unavailable backend propagates, never retains nor creates", async () => {
    const error = agentError("AGENT_SESSION_BACKEND_UNAVAILABLE");
    await resumeFailing(error);
    await expect(open({ resumeId: ID, model: undefined })).rejects.toBe(error);
    expect(createMock).not.toHaveBeenCalled();
    expect(storeFor(agentDir("codex")).retainFailed).not.toHaveBeenCalled();
  });

  test("AC-13 an auth requirement propagates and retains nothing", async () => {
    const error = agentError("AGENT_SESSION_AUTH_REQUIRED");
    await resumeFailing(error);
    await expect(open({ resumeId: ID, model: undefined })).rejects.toBe(error);
    expect(storeFor(agentDir("codex")).retainFailed).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  test.each([
    ["AGENT_SESSION_BACKEND_MISMATCH", "claude", "Claude Code"],
    ["TRANSCRIPT_CORRUPT", "codex", "Codex"],
  ] as const)("AC-18 %s retains the document before a fresh session with a notice", async (code, agent, label) => {
    await resumeFailing(new NaxError("unusable", code, { stage: "test" }), agent);
    const handle = await open({ resumeId: ID, model: undefined });
    expect(calls).toEqual([`retain:${agentDir(agent)}`, "create"]);
    expect(createdOptions().sessionId).toBe(ID);
    expect(handle.notice).toBe(ACP_FRESH_SESSION_NOTICE(label));
  });

  test("AC-19 a resume timeout rejects without replacing the stored document", async () => {
    const error = new Error("timed out");
    await resumeFailing(error);
    await expect(open({ resumeId: ID, model: undefined })).rejects.toBe(error);
    expect(storeFor(agentDir("codex")).retainFailed).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    expect(await storage.readLockHolder(ID)).toBeNull();
  });

  test("a failed fresh session after the fallback still releases the lock", async () => {
    await resumeFailing(agentError("AGENT_SESSION_NOT_FOUND"));
    const error = agentError("AGENT_SESSION_AUTH_REQUIRED");
    createMock.mockImplementation(async () => {
      throw error;
    });
    await expect(open({ resumeId: ID, model: undefined })).rejects.toBe(error);
    expect(await storage.readLockHolder(ID)).toBeNull();
  });
});

describe("openChatSession on an ACP model: history", () => {
  test("AC-15 history is the native document's messages, not the agent's", async () => {
    await seed("acp:codex");
    const messages: TranscriptDoc["messages"] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    docs.set(storage.dir, { savedAt: "2026-10-28T01:00:00.000Z", messages });
    docs.set(agentDir("codex"), {
      savedAt: NOW.toISOString(),
      messages: [{ role: "user", content: "agent-only" }],
      turn: ENDED_TURN,
    });
    const handle = await open({ resumeId: ID, model: undefined });
    expect(handle.history?.messages).toEqual(messages);
  });
});
