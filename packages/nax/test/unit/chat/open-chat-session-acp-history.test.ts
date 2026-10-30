/**
 * US-007: openChatSession carries the conversation into and out of an ACP brain —
 * the unseen-history handoff on the first send, the trimmed/fallback notices, and the
 * native-document recording that lets a later native model resume the same session.
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
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import { ACP_HANDOFF_TRIMMED_NOTICE, acpHandoff } from "@/chat/acp/acp-handoff";
import { _acpSessionDeps, ACP_FRESH_SESSION_NOTICE } from "@/chat/acp/acp-session-options";
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

const ID = "acp-history-id";
const NOW = new Date("2026-10-01T00:00:00.000Z");
const BASE = { sessionId: ID, turnId: "t1", at: NOW.toISOString(), metadata: {} };
const acpBackendStub: SessionBackend = {
  kind: "acp:test",
  async open() {
    throw new NaxError("unexpected backend open", "TEST_FAILURE", { stage: "test" });
  },
};
const CODEX = { provider: "acp:codex", model: "gpt-5.5" };

let dir: string;
let storage: SessionStorage;
let request: OpenChatSessionRequest;
let deps: typeof _openChatSessionDeps;
let sendMock: ReturnType<typeof mock<SendFn>>;
let agentSession: AgentSession;
let createMock: ReturnType<typeof mock<CreateFn>>;
let resumeMock: ReturnType<typeof mock<ResumeFn>>;
const originalAcpDeps = { ..._acpSessionDeps };
const releases: (() => Promise<void>)[] = [];

function doneEvents(): SessionEvent[] {
  return [
    { ...BASE, type: "text_delta", round: 1, text: "done" },
    {
      ...BASE,
      type: "turn_end",
      status: "completed",
      output: "done",
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: 0,
    },
  ];
}

beforeEach(() => {
  dir = makeTempDir("chat-open-acp-history-");
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
  sendMock = mock<SendFn>((_message) =>
    (async function* () {
      yield* doneEvents();
    })(),
  );
  agentSession = {
    id: ID,
    backend: { kind: "acp:test", capabilities: {} },
    lastTurn: undefined,
    send: sendMock,
    answer: () => "unknown",
    cancel() {},
    async close() {},
  };
  createMock = mock<CreateFn>(async () => agentSession);
  resumeMock = mock<ResumeFn>(async () => agentSession);
  deps = {
    ..._openChatSessionDeps,
    randomUUID: () => ID,
    now: () => NOW,
    nativeBackend: mock(() => acpBackendStub),
    createAgentSession: createMock,
    resumeAgentSession: resumeMock,
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

async function seedAgentDoc(agent = "codex"): Promise<void> {
  await createFileTranscriptStore(join(storage.dir, `acp-${agent}`)).save(ID, {
    savedAt: NOW.toISOString(),
    messages: [],
    turn: { turnId: "t1", state: "ended" },
  });
}

async function drain(handle: ChatSessionHandle, message = "go"): Promise<void> {
  for await (const _event of handle.session.send(message)) {
    // consume the turn
  }
}

function sentOnce(): string {
  expect(sendMock).toHaveBeenCalledTimes(1);
  const [message] = sendMock.mock.calls[0] ?? [];
  if (message === undefined) throw new Error("send was not called with a message");
  return message;
}

function handoffOf(messages: Messages): string {
  return buildChatHandoff(acpHandoff(messages));
}

function userMessages(count: number, size: number): Messages {
  return Array.from({ length: count }, (_, i) => ({
    role: "user" as const,
    content: `${i}`.padEnd(size, "x"),
  }));
}

const PLAN: Messages = [
  { role: "user", content: "plan it" },
  { role: "assistant", content: "ok" },
];

describe("openChatSession ACP handoff: first send", () => {
  test("AC-1 a new agent session's first send is prefixed with the handoff of the native document", async () => {
    await seedNative(PLAN);
    const handle = await open();
    await drain(handle);
    expect(handoffOf(PLAN)).not.toBe("");
    expect(sentOnce()).toBe(`${handoffOf(PLAN)}\n\ngo`);
  });

  test("AC-2 with no native document the first send is the bare message", async () => {
    const handle = await open();
    await drain(handle);
    expect(sentOnce()).toBe("go");
  });

  test("AC-3 resuming an agent whose turn ended the native document sends the bare message", async () => {
    await seedMeta("acp:codex");
    await seedNative([
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1", origin: CODEX },
    ]);
    await seedAgentDoc();
    const handle = await open({ resumeId: ID, model: undefined });
    expect(resumeMock).toHaveBeenCalledTimes(1);
    await drain(handle);
    expect(sentOnce()).toBe("go");
  });

  test("AC-4 resuming the agent hands over only what follows its last own turn", async () => {
    const messages: Messages = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1", origin: CODEX },
      { role: "user", content: "native q" },
      { role: "assistant", content: "native a" },
    ];
    await seedMeta("acp:codex");
    await seedNative(messages);
    await seedAgentDoc();
    const handle = await open({ resumeId: ID, model: undefined });
    await drain(handle);
    const suffix = messages.slice(2);
    expect(sentOnce()).toBe(`${handoffOf(suffix)}\n\ngo`);
    expect(sentOnce()).toContain("native q");
    expect(sentOnce()).not.toContain("u1");
  });

  test("AC-5 the fresh fallback after an unusable agent document hands over every native message", async () => {
    const messages: Messages = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1", origin: CODEX },
      { role: "user", content: "u2" },
    ];
    await seedMeta("acp:codex");
    await seedNative(messages);
    await seedAgentDoc();
    resumeMock.mockImplementation(async () => {
      throw new AgentSessionError("gone", "AGENT_SESSION_NOT_FOUND", {});
    });
    const handle = await open({ resumeId: ID, model: undefined });
    await drain(handle);
    expect(sentOnce()).toBe(`${handoffOf(messages)}\n\ngo`);
  });
});

describe("openChatSession ACP handoff: notices", () => {
  test("AC-6 the fallback notice begins with the fresh-session notice", async () => {
    await seedMeta("acp:codex");
    await seedAgentDoc();
    resumeMock.mockImplementation(async () => {
      throw new AgentSessionError("gone", "AGENT_SESSION_NOT_FOUND", {});
    });
    const handle = await open({ resumeId: ID, model: undefined });
    expect(handle.notice?.startsWith(ACP_FRESH_SESSION_NOTICE("Codex"))).toBe(true);
  });

  test("AC-8 a handoff that drops 3 entries reports the trimmed notice", async () => {
    await seedNative(userMessages(12, 4_000));
    const handle = await open();
    expect(handle.notice).toBe(ACP_HANDOFF_TRIMMED_NOTICE("Codex", 3));
  });

  test("AC-9 the fallback and the trimmed notice are joined with a semicolon", async () => {
    await seedMeta("acp:codex");
    await seedNative(userMessages(12, 4_000));
    await seedAgentDoc();
    resumeMock.mockImplementation(async () => {
      throw new AgentSessionError("gone", "AGENT_SESSION_NOT_FOUND", {});
    });
    const handle = await open({ resumeId: ID, model: undefined });
    expect(handle.notice).toBe(`${ACP_FRESH_SESSION_NOTICE("Codex")}; ${ACP_HANDOFF_TRIMMED_NOTICE("Codex", 3)}`);
  });

  test("AC-10 with no fallback and nothing dropped the handle has no notice key", async () => {
    await seedNative(PLAN);
    const handle = await open();
    expect("notice" in handle).toBe(false);
  });
});

describe("openChatSession ACP recording", () => {
  test("AC-7 a consumed ACP turn lands in the native document with the ACP origin", async () => {
    const handle = await open();
    await drain(handle);
    const doc = await createFileTranscriptStore(storage.dir).load(ID);
    expect(doc?.messages.slice(-2)).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "done", origin: { provider: "acp:codex", model: "gpt-5.5" } },
    ]);
  });

  test("AC-11 a native model's session is returned as createAgentSession made it", async () => {
    const created = mock<CreateFn>(async () => agentSession);
    deps.createAgentSession = created;
    const handle = await open({ model: "openai/gpt-6", mode: "full" });
    expect(created).toHaveBeenCalledTimes(1);
    expect(handle.session).toBe(agentSession);
  });

  test("AC-12 a native reopen after an ACP-only chat resumes the session instead of creating one", async () => {
    const acp = await open();
    await drain(acp);
    await acp.release();
    createMock.mockClear();
    await open({ resumeId: ID, model: "openai/gpt-6", mode: "full" });
    expect(createMock).not.toHaveBeenCalled();
    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(resumeMock.mock.calls[0]?.[0]).toBe(ID);
  });

  test("AC-13 that reopen's history holds the recorded user and assistant messages", async () => {
    const acp = await open();
    await drain(acp);
    await acp.release();
    const native = await open({ resumeId: ID, model: "openai/gpt-6", mode: "full" });
    expect(native.history?.messages).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "done", origin: { provider: "acp:codex", model: "gpt-5.5" } },
    ]);
  });
});
