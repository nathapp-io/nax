/**
 * US-007 AC-17: through the chat host with the real openChatSession, a turn on an ACP
 * model is already recorded in the native chat document when host.send resolves.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import {
  type AgentSession,
  createFileTranscriptStore,
  createSessionStorage,
  type SessionBackend,
  type SessionEvent,
  type SessionStorage,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeLogger, makeNaxConfig, makeTempDir, withDepsRestore } from "@test/helpers";
import { _acpSessionDeps } from "@/chat/acp/acp-session-options";
import { type ChatHost, createChatHost } from "@/chat/chat-host";
import { _openChatSessionDeps } from "@/chat/open-chat-session";
import { NaxError } from "@/errors";

const ID = "host-acp-history";
const NOW = new Date("2026-10-01T00:00:00.000Z");
const BASE = { sessionId: ID, turnId: "t1", at: NOW.toISOString(), metadata: {} };
const acpBackendStub: SessionBackend = {
  kind: "acp:test",
  async open() {
    throw new NaxError("unexpected backend open", "TEST_FAILURE", { stage: "test" });
  },
};

let dir: string;
let storage: SessionStorage;
let host: ChatHost | undefined;

function stubSession(): AgentSession {
  return {
    id: ID,
    backend: { kind: "acp:test", capabilities: {} },
    lastTurn: undefined,
    async *send() {
      yield { ...BASE, type: "turn_start" };
      yield { ...BASE, type: "text_delta", round: 1, text: "done" };
      yield {
        ...BASE,
        type: "turn_end",
        status: "completed",
        output: "done",
        usage: { inputTokens: 10, outputTokens: 2 },
        costUsd: 0.01,
      };
    },
    answer: () => "unknown",
    cancel() {},
    async close() {},
  };
}

describe("chat host recording an ACP turn", () => {
  withDepsRestore(_openChatSessionDeps);
  withDepsRestore(_acpSessionDeps);

  beforeEach(() => {
    dir = makeTempDir("chat-host-acp-history-");
    storage = createSessionStorage({
      dir: join(dir, "sessions"),
      pid: process.pid,
      now: () => NOW,
      logger: makeLogger(),
      isAlive: () => true,
    });
    _openChatSessionDeps.randomUUID = () => ID;
    _openChatSessionDeps.now = () => NOW;
    _openChatSessionDeps.createAgentSession = mock(async () => stubSession());
    _acpSessionDeps.acpBackend = mock(() => acpBackendStub);
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    cleanupTempDir(dir);
  });

  test("AC-17 host.send resolves with the native store already holding the go / done messages", async () => {
    host = createChatHost({
      models: ["openai/gpt-6"],
      config: makeNaxConfig(),
      cwd: dir,
      repoRoot: dir,
      chain: null,
      storage,
      now: () => NOW,
      logger: makeLogger(),
    });
    await host.start({ mode: "guarded", model: "acp:codex" });
    const events: SessionEvent[] = [];
    await host.send("go", (event) => events.push(event));
    const doc = await createFileTranscriptStore(storage.dir).load(ID);
    expect(events.some((event) => event.type === "turn_end")).toBe(true);
    expect(doc?.messages).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "done", origin: { provider: "acp:codex", model: "default" } },
    ]);
  });
});
