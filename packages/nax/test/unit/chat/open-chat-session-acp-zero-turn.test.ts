/**
 * US-003: openChatSession on an ACP model resumes a stored agent document only when it carries a
 * `turn` marker. A turn-less document is a session the agent never prompted: it is deleted and a
 * fresh agent session replaces it, silently, with the whole native history as its handoff.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import {
  type AgentSession,
  AgentSessionError,
  type CreateAgentSessionOptions,
  createFileTranscriptStore,
  createSessionStorage,
  type SessionBackend,
  type SessionEvent,
  type SessionStorage,
  type TranscriptDoc,
  type TranscriptStore,
} from "@nathapp/nax-agent";
import { assertDefined, cleanupTempDir, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import { acpHandoff } from "@/chat/acp/acp-handoff";
import { _acpSessionDeps } from "@/chat/acp/acp-session-options";
import {
  _openChatSessionDeps,
  type ChatSessionHandle,
  type OpenChatSessionRequest,
  openChatSession,
} from "@/chat/open-chat-session";
import { NaxError } from "@/errors";
import { buildChatHandoff } from "@/prompts";

type Messages = TranscriptDoc["messages"];
type SendFn = (message: string) => AsyncIterable<SessionEvent>;
type CreateFn = (options: CreateAgentSessionOptions) => Promise<AgentSession>;
type ResumeFn = (id: string, options: CreateAgentSessionOptions) => Promise<AgentSession>;

const ID = "acp-zero-turn-id";
const NOW = new Date("2026-10-01T00:00:00.000Z");
const BASE = { sessionId: ID, turnId: "t1", at: NOW.toISOString(), metadata: {} };
const acpBackendStub: SessionBackend = {
  kind: "acp:test",
  async open() {
    throw new NaxError("unexpected backend open", "TEST_FAILURE", { stage: "test" });
  },
};
const CODEX = { provider: "acp:codex", model: "gpt-5.5" };
const HISTORY: Messages = [
  { role: "user", content: "u1" },
  { role: "assistant", content: "a1", origin: CODEX },
  { role: "user", content: "native q" },
  { role: "assistant", content: "native a" },
];

let dir: string;
let storage: SessionStorage;
let request: OpenChatSessionRequest;
let deps: typeof _openChatSessionDeps;
let calls: string[];
let agentStore: TranscriptStore | undefined;
let retainMock: ReturnType<typeof mock<TranscriptStore["retainFailed"]>>;
let sendMock: ReturnType<typeof mock<SendFn>>;
let createMock: ReturnType<typeof mock<CreateFn>>;
let resumeMock: ReturnType<typeof mock<ResumeFn>>;
const originalAcpDeps = { ..._acpSessionDeps };
const releases: (() => Promise<void>)[] = [];

function agentPath(): string {
  return join(storage.dir, "acp-codex");
}

/** The real file store for the agent directory, with its delete and retainFailed recorded in `calls`. */
function recordingAgentStore(path: string): TranscriptStore {
  const real = createFileTranscriptStore(path);
  retainMock = mock(async (id: string) => {
    calls.push("retain");
    await real.retainFailed(id);
  });
  agentStore = {
    load: (id) => real.load(id),
    save: (id, doc) => real.save(id, doc),
    markTurn: (id, marker) => real.markTurn(id, marker),
    retainFailed: retainMock,
    delete: async (id) => {
      calls.push(`delete:${id}`);
      await real.delete(id);
    },
  };
  return agentStore;
}

beforeEach(() => {
  dir = makeTempDir("chat-open-acp-zero-turn-");
  storage = createSessionStorage({ dir, pid: process.pid, now: () => NOW, logger: makeLogger() });
  request = {
    storage,
    cwd: join(dir, "work"),
    repoRoot: dir,
    mode: "guarded",
    loopHandlers: [],
    config: makeNaxConfig(),
  };
  calls = [];
  agentStore = undefined;
  sendMock = mock<SendFn>((_message) =>
    (async function* () {
      yield { ...BASE, type: "text_delta", round: 1, text: "done" } satisfies SessionEvent;
      yield {
        ...BASE,
        type: "turn_end",
        status: "completed",
        output: "done",
        usage: { inputTokens: 1, outputTokens: 1 },
        costUsd: 0,
      } satisfies SessionEvent;
    })(),
  );
  const agentSession: AgentSession = {
    id: ID,
    backend: { kind: "acp:test", capabilities: {} },
    lastTurn: undefined,
    send: sendMock,
    answer: () => "unknown",
    cancel() {},
    async close() {},
  };
  createMock = mock<CreateFn>(async () => {
    calls.push("create");
    return agentSession;
  });
  resumeMock = mock<ResumeFn>(async () => {
    calls.push("resume");
    return agentSession;
  });
  deps = {
    ..._openChatSessionDeps,
    randomUUID: () => ID,
    now: () => NOW,
    nativeBackend: mock(() => acpBackendStub),
    createAgentSession: createMock,
    resumeAgentSession: resumeMock,
    createFileTranscriptStore: (path) =>
      path === agentPath() ? recordingAgentStore(path) : createFileTranscriptStore(path),
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

async function seedMeta(model: string): Promise<void> {
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

async function seedNative(messages: Messages): Promise<void> {
  await createFileTranscriptStore(storage.dir).save(ID, { savedAt: NOW.toISOString(), messages });
}

async function seedAgentDoc(turn?: TranscriptDoc["turn"]): Promise<void> {
  await createFileTranscriptStore(agentPath()).save(ID, {
    savedAt: NOW.toISOString(),
    messages: [],
    ...(turn !== undefined ? { turn } : {}),
  });
}

async function resumeAcp(): Promise<ChatSessionHandle> {
  return open({ resumeId: ID, model: undefined });
}

describe("openChatSession on ACP: a stored agent document without a turn", () => {
  beforeEach(async () => {
    await seedMeta("acp:codex");
    await seedNative(HISTORY);
    await seedAgentDoc();
  });

  test("AC-1 deletes the document with the session id, then creates, and never resumes", async () => {
    await resumeAcp();
    expect(calls).toEqual([`delete:${ID}`, "create"]);
    expect(resumeMock).not.toHaveBeenCalled();
    expect(await createFileTranscriptStore(agentPath()).load(ID)).toBeNull();
  });

  test("AC-2 the handle carries no notice", async () => {
    const handle = await resumeAcp();
    expect(handle.notice).toBeUndefined();
    expect("notice" in handle).toBe(false);
  });

  test("AC-3 the agent store's retainFailed is not called", async () => {
    await resumeAcp();
    expect(retainMock).not.toHaveBeenCalled();
  });

  test("AC-4 the first send is prefixed with the handoff of every native message", async () => {
    const handle = await resumeAcp();
    for await (const _event of handle.session.send("go")) {
      // consume the turn
    }
    const expected = buildChatHandoff(acpHandoff(HISTORY));
    expect(expected).toContain("native q");
    expect(expected).toContain("u1");
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[0]).toBe(`${expected}\n\ngo`);
  });
});

describe("openChatSession on ACP: a stored agent document with a turn marker", () => {
  test.each([
    ["ended", { turnId: "t1", state: "ended" }],
    ["running", { turnId: "t1", state: "running" }],
  ] as const)("AC-5/AC-6 a %s turn is resumed with the session id and options, never deleted", async (_name, turn) => {
    await seedMeta("acp:codex");
    await seedAgentDoc(turn);
    await resumeAcp();
    expect(createMock).not.toHaveBeenCalled();
    expect(resumeMock).toHaveBeenCalledTimes(1);
    const [id, options] = resumeMock.mock.calls[0] ?? [];
    expect(id).toBe(ID);
    assertDefined(agentStore, "agent store");
    expect(options?.transcriptStore).toBe(agentStore);
    expect(options?.sessionId).toBe(ID);
    expect(calls).toEqual(["resume"]);
  });

  test("AC-9 an auth requirement on resume rejects with the same error and creates nothing", async () => {
    const error = new AgentSessionError("auth", "AGENT_SESSION_AUTH_REQUIRED", {});
    await seedMeta("acp:codex");
    await seedAgentDoc({ turnId: "t1", state: "ended" });
    resumeMock.mockImplementation(async () => {
      throw error;
    });
    await expect(resumeAcp()).rejects.toBe(error);
    expect(createMock).not.toHaveBeenCalled();
    expect(calls).not.toContain(`delete:${ID}`);
    expect(retainMock).not.toHaveBeenCalled();
  });
});

describe("openChatSession on ACP: no stored agent document", () => {
  test("AC-7 creates without deleting anything", async () => {
    await seedMeta("acp:codex");
    await resumeAcp();
    expect(calls).toEqual(["create"]);
    expect(resumeMock).not.toHaveBeenCalled();
  });
});

describe("openChatSession on the native brain", () => {
  test("AC-8 a native document without a turn is still resumed", async () => {
    await seedMeta("openai/gpt-6");
    await seedNative(HISTORY);
    await open({ resumeId: ID, model: undefined, mode: "full" });
    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(resumeMock.mock.calls[0]?.[0]).toBe(ID);
    expect(createMock).not.toHaveBeenCalled();
    expect(agentStore).toBeUndefined();
  });
});
