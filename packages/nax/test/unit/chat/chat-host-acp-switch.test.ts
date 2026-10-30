/**
 * US-005 AC-12..AC-15: through the chat host over the real openChatSession, an ACP effort
 * switch is applied in place on the live session, and a failed reopen recovers onto a
 * usable session.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import {
  type AgentSession,
  AgentSessionError,
  createSessionStorage,
  type SessionBackend,
  type SessionEvent,
  type SessionStorage,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeLogger, makeNaxConfig, makeTempDir, withDepsRestore } from "@test/helpers";
import type { AcpCatalog } from "@/chat/acp";
import { _acpSessionDeps } from "@/chat/acp/acp-session-options";
import { type ChatHost, createChatHost } from "@/chat/chat-host";
import { _openChatSessionDeps } from "@/chat/open-chat-session";
import { ROLLBACK_NEW_SESSION_NOTICE } from "@/chat/session-switch";
import { NaxError } from "@/errors";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const OLD_ID = "chat-acp-switch-old";
const FRESH_ID = "chat-acp-switch-fresh";
const BASE_MODEL = "acp:codex/gpt-5.5";
const HIGH_MODEL = "acp:codex/gpt-5.5[high]";
const acpBackendStub: SessionBackend = {
  kind: "acp:test",
  async open() {
    throw new NaxError("unexpected backend open", "TEST_FAILURE", { stage: "test" });
  },
};

interface Stub {
  readonly session: AgentSession;
  readonly configure: ReturnType<typeof mock<NonNullable<AgentSession["configure"]>>>;
  readonly close: ReturnType<typeof mock<() => Promise<void>>>;
}

let dir: string;
let storage: SessionStorage;
let host: ChatHost | undefined;
let stubs: Stub[];

/** A session that refuses a send once closed, as a real one does. */
function stubSession(id: string): Stub {
  let closed = false;
  const configure = mock<NonNullable<AgentSession["configure"]>>(async () => {});
  const close = mock(async () => {
    closed = true;
  });
  const base = { sessionId: id, turnId: "t1", at: NOW.toISOString(), metadata: {} };
  const session: AgentSession = {
    id,
    backend: { kind: "acp:test", capabilities: {} },
    lastTurn: undefined,
    async *send() {
      if (closed) throw new AgentSessionError("session is closed", "AGENT_SESSION_CLOSED");
      yield { ...base, type: "turn_start" };
      yield { ...base, type: "text_delta", round: 1, text: "done" };
      yield {
        ...base,
        type: "turn_end",
        status: "completed",
        output: "done",
        usage: { inputTokens: 1, outputTokens: 1 },
        costUsd: 0,
      };
    },
    answer: () => "unknown",
    cancel() {},
    close,
    configure,
  };
  const stub = { session, configure, close };
  stubs.push(stub);
  return stub;
}

function catalog(): AcpCatalog {
  return {
    load: async () => {},
    warm: () => {},
    close: () => {},
    rows: () => [],
    effortLevels: () => ["default", "high"],
    installed: () => true,
    unavailable: () => undefined,
    opened: mock(() => {}),
    failed: mock(() => {}),
  };
}

function makeHost(): ChatHost {
  return createChatHost({
    models: ["openai/gpt-6"],
    acp: catalog(),
    config: makeNaxConfig(),
    cwd: dir,
    repoRoot: dir,
    chain: null,
    storage,
    now: () => NOW,
    logger: makeLogger(),
  });
}

describe("chat host switching an ACP session", () => {
  withDepsRestore(_openChatSessionDeps);
  withDepsRestore(_acpSessionDeps);

  beforeEach(() => {
    dir = makeTempDir("chat-host-acp-switch-");
    stubs = [];
    storage = createSessionStorage({
      dir: join(dir, "sessions"),
      pid: process.pid,
      now: () => NOW,
      logger: makeLogger(),
      isAlive: () => true,
    });
    _openChatSessionDeps.now = () => NOW;
    _acpSessionDeps.acpBackend = mock(() => acpBackendStub);
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    cleanupTempDir(dir);
  });

  describe("in place", () => {
    test("AC-12 AC-13 an effort change configures the live session and neither creates nor resumes another", async () => {
      _openChatSessionDeps.randomUUID = () => OLD_ID;
      const create = mock(async () => stubSession(OLD_ID).session);
      const resume = mock(async () => stubSession(OLD_ID).session);
      _openChatSessionDeps.createAgentSession = create;
      _openChatSessionDeps.resumeAgentSession = resume;
      host = makeHost();
      await host.start({ mode: "guarded", model: BASE_MODEL });
      await host.switchTo({ model: HIGH_MODEL });
      expect(stubs).toHaveLength(1);
      expect(stubs[0]?.configure).toHaveBeenCalledTimes(1);
      expect(stubs[0]?.configure).toHaveBeenCalledWith({ effort: "high" });
      expect(stubs[0]?.close).not.toHaveBeenCalled();
      expect(host.current().model).toBe(HIGH_MODEL);
      expect(host.current().sessionId).toBe(OLD_ID);
      expect(create).toHaveBeenCalledTimes(1);
      expect(resume).not.toHaveBeenCalled();
      expect((await storage.readMeta(OLD_ID))?.model).toBe(HIGH_MODEL);
    });
  });

  describe("recovery", () => {
    test("AC-14 a switch whose reopen and rollback both fail recovers onto a new, usable session", async () => {
      const ids = [OLD_ID, FRESH_ID];
      _openChatSessionDeps.randomUUID = () => ids.shift() ?? "chat-acp-switch-extra";
      const switchFailure = new Error("reopen failed\nsecond line");
      let calls = 0;
      _openChatSessionDeps.createAgentSession = mock(async () => {
        calls += 1;
        if (calls === 2) throw switchFailure;
        if (calls === 3) throw new Error("rollback failed");
        return stubSession(calls === 1 ? OLD_ID : FRESH_ID).session;
      });
      host = makeHost();
      await host.start({ mode: "guarded", model: BASE_MODEL });
      // A mode change is never applied in place, so it takes the reopen path.
      await expect(host.switchTo({ mode: "full" })).rejects.toBe(switchFailure);
      expect(calls).toBe(4);
      expect(host.current().sessionId).toBe(FRESH_ID);
      expect(host.current().model).toBe(BASE_MODEL);
      expect(host.current().mode).toBe("guarded");
      expect(host.notice()).toBe(ROLLBACK_NEW_SESSION_NOTICE(OLD_ID, "reopen failed"));
      const events: SessionEvent[] = [];
      await host.send("hi", (event) => events.push(event));
      expect(events.some((event) => event.type === "turn_end")).toBe(true);
    });

    test("AC-15 a failed reopen with a working rollback rejects with the switch error and keeps the original session", async () => {
      _openChatSessionDeps.randomUUID = () => OLD_ID;
      const switchFailure = new Error("reopen failed");
      let calls = 0;
      _openChatSessionDeps.createAgentSession = mock(async () => {
        calls += 1;
        if (calls === 2) throw switchFailure;
        return stubSession(OLD_ID).session;
      });
      host = makeHost();
      await host.start({ mode: "guarded", model: BASE_MODEL });
      await expect(host.switchTo({ mode: "full" })).rejects.toBe(switchFailure);
      expect(host.current().model).toBe(BASE_MODEL);
      expect(host.current().sessionId).toBe(OLD_ID);
      expect(host.notice()).toBeUndefined();
    });
  });
});
