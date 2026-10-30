/**
 * US-009 AC-1..AC-13, AC-18, AC-19: the chat host's lifecycle around an ACP brain —
 * open reporting, the install preflight, the context-window skip, the `!` refusal,
 * notice precedence and the switch rollback.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import {
  type AgentSession,
  AgentSessionError,
  type AgentSessionErrorCode,
  createSessionStorage,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeLogger, makeNaxConfig, makeTempDir, withDepsRestore } from "@test/helpers";
import { _acpCatalogDeps, ACP_RUN_COMMAND_UNSUPPORTED, type AcpCatalog, createAcpCatalog } from "@/chat/acp";
import { _chatHostDeps, type ChatHost, createChatHost } from "@/chat/chat-host";
import type { ChatSessionHandle, OpenChatSessionRequest } from "@/chat/open-chat-session";
import { NaxError } from "@/errors";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const NATIVE = "openai/gpt-6";

interface FakeSession extends AgentSession {
  readonly close: ReturnType<typeof mock<() => Promise<void>>>;
  readonly runCommand: ReturnType<typeof mock<NonNullable<AgentSession["runCommand"]>>>;
}

let dir: string;
let hosts: ChatHost[];
let sessions: FakeSession[];
let opens: OpenChatSessionRequest[];
/** Per-model scripted open failure. */
let failures: Map<string, Error>;
let capabilities: Record<string, unknown>;
let handleNotice: string | undefined;

/** The NaxError a promise rejects with; fails the test when it resolves or rejects otherwise. */
async function rejectionOf(promise: Promise<unknown>): Promise<NaxError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof NaxError)) throw new Error(`expected a NaxError rejection, got ${String(error)}`);
  return error;
}

function sessionError(code: AgentSessionErrorCode): AgentSessionError {
  return new AgentSessionError(`injected ${code}`, code);
}

function fakeSession(id: string): FakeSession {
  const session: FakeSession = {
    id,
    backend: { kind: "acp", capabilities },
    lastTurn: undefined,
    async *send() {},
    answer: () => "unknown",
    cancel() {},
    close: mock(async () => {}),
    runCommand: mock(async () => ({ isError: false, content: "ran" })),
  };
  sessions.push(session);
  return session;
}

async function open(request: OpenChatSessionRequest): Promise<ChatSessionHandle> {
  opens.push(request);
  const model = request.model ?? NATIVE;
  const failure = failures.get(model);
  if (failure) throw failure;
  const sessionId = request.resumeId ?? "s-1";
  return {
    session: fakeSession(sessionId),
    meta: {
      schemaVersion: 1,
      sessionId,
      cwd: dir,
      mode: request.mode === "full" ? "full" : "ask",
      model,
      bashApproval: "gated",
      title: null,
      createdAt: NOW.toISOString(),
      updatedAt: null,
    },
    ...(handleNotice === undefined ? {} : { notice: handleNotice }),
    release: async () => {},
  };
}

function stubCatalog(overrides: Partial<AcpCatalog> = {}): AcpCatalog {
  return {
    load: async () => {},
    rows: () => [],
    effortLevels: () => ["default"],
    installed: () => true,
    unavailable: () => undefined,
    opened: mock(() => {}),
    failed: mock(() => {}),
    ...overrides,
  };
}

function makeHost(acp: AcpCatalog): ChatHost {
  const host = createChatHost({
    models: [NATIVE],
    acp,
    open,
    config: makeNaxConfig(),
    cwd: dir,
    repoRoot: dir,
    chain: null,
    storage: createSessionStorage({
      dir: join(dir, "sessions"),
      pid: process.pid,
      now: () => NOW,
      logger: makeLogger(),
      isAlive: () => true,
    }),
    now: () => NOW,
    logger: makeLogger(),
  });
  hosts.push(host);
  return host;
}

describe("chat host ACP lifecycle", () => {
  withDepsRestore(_chatHostDeps);
  withDepsRestore(_acpCatalogDeps);

  beforeEach(() => {
    dir = makeTempDir("chat-host-acp-");
    hosts = [];
    sessions = [];
    opens = [];
    failures = new Map();
    capabilities = {};
    handleNotice = undefined;
  });
  afterEach(async () => {
    await Promise.all(hosts.map((host) => host.close()));
    cleanupTempDir(dir);
  });

  describe("open reporting", () => {
    test("AC-1 start on an ACP model reports the open's capabilities to catalog.opened", async () => {
      capabilities = { offeredModels: ["gpt-5.5"] };
      const catalog = stubCatalog();
      await makeHost(catalog).start({ mode: "guarded", model: "acp:codex" });
      expect(catalog.opened).toHaveBeenCalledWith("acp:codex", { offeredModels: ["gpt-5.5"] });
    });

    test("AC-2 with a real catalog the offered model reaches host.models", async () => {
      _acpCatalogDeps.launchCandidateKind = () => "local";
      capabilities = { offeredModels: ["gpt-5.5"] };
      const host = makeHost(createAcpCatalog({ env: {} }));
      await host.start({ mode: "guarded", model: "acp:codex" });
      expect(host.models).toContain("acp:codex/gpt-5.5");
    });

    test("AC-18 an ACP open failing with BACKEND_UNAVAILABLE propagates after catalog.failed", async () => {
      const failure = sessionError("AGENT_SESSION_BACKEND_UNAVAILABLE");
      failures.set("acp:codex", failure);
      const catalog = stubCatalog();
      await expect(makeHost(catalog).start({ mode: "guarded", model: "acp:codex" })).rejects.toBe(failure);
      expect(catalog.failed).toHaveBeenCalledWith("acp:codex", failure);
    });

    test("AC-13 a failing resume reports neither failed nor opened and rejects with the open's error", async () => {
      const failure = new Error("resume failed");
      const catalog = stubCatalog();
      const host = makeHost(catalog);
      failures.set(NATIVE, failure);
      await expect(host.resume({ id: "prior" })).rejects.toBe(failure);
      expect(catalog.failed).not.toHaveBeenCalled();
      expect(catalog.opened).not.toHaveBeenCalled();
    });
  });

  describe("switching", () => {
    async function startedOn(model: string, catalog: AcpCatalog): Promise<ChatHost> {
      const host = makeHost(catalog);
      await host.start({ mode: "guarded", model });
      return host;
    }

    test("AC-3 AC-4 a switch whose ACP open needs login reports failed, rejects with the error and keeps the model", async () => {
      const failure = sessionError("AGENT_SESSION_AUTH_REQUIRED");
      const catalog = stubCatalog();
      const host = await startedOn(NATIVE, catalog);
      failures.set("acp:claude", failure);
      await expect(host.switchTo({ model: "acp:claude" })).rejects.toBe(failure);
      expect(catalog.failed).toHaveBeenCalledWith("acp:claude", failure);
      expect(host.current().model).toBe(NATIVE);
    });

    test.each(["AGENT_SESSION_CAPABILITY_UNSUPPORTED", "AGENT_SESSION_RATE_LIMITED"] as const)(
      "AC-19 a switch to ACP failing with %s restores the previous brain before propagating",
      async (code) => {
        const failure = sessionError(code);
        const host = await startedOn(NATIVE, stubCatalog());
        failures.set("acp:codex", failure);
        await expect(host.switchTo({ model: "acp:codex" })).rejects.toBe(failure);
        expect(opens.at(-1)?.model).toBe(NATIVE);
        expect(host.current().model).toBe(NATIVE);
      },
    );

    test("AC-19 a switch to ACP that times out restores the previous brain before propagating", async () => {
      const timeout = new NaxError("[chat] open timed out", "AGENT_SESSION_TIMEOUT", { stage: "chat" });
      const host = await startedOn(NATIVE, stubCatalog());
      failures.set("acp:codex", timeout);
      await expect(host.switchTo({ model: "acp:codex" })).rejects.toBe(timeout);
      expect(host.current().model).toBe(NATIVE);
    });

    test("AC-5 a switch to an agent that is not installed rejects with CHAT_ACP_AGENT_UNAVAILABLE", async () => {
      const host = await startedOn(NATIVE, stubCatalog({ installed: (model) => model !== "acp:cursor" }));
      const error = await rejectionOf(host.switchTo({ model: "acp:cursor" }));
      expect(error.code).toBe("CHAT_ACP_AGENT_UNAVAILABLE");
      expect(error.message).toContain("Cursor");
      expect(error.message).toContain("not installed");
    });

    test("AC-6 that refused switch closes nothing and opens nothing", async () => {
      const host = await startedOn(NATIVE, stubCatalog({ installed: (model) => model !== "acp:cursor" }));
      const opensBefore = opens.length;
      await host.switchTo({ model: "acp:cursor" }).catch(() => {});
      expect(sessions[0]?.close).not.toHaveBeenCalled();
      expect(opens).toHaveLength(opensBefore);
      expect(host.current().model).toBe(NATIVE);
    });

    test("AC-11 a switch from an ACP model to a native one opens that model on the same session id", async () => {
      const host = await startedOn("acp:codex", stubCatalog());
      await host.switchTo({ model: NATIVE });
      const request = opens.at(-1);
      expect(request?.model).toBe(NATIVE);
      expect(request?.resumeId).toBe("s-1");
    });
  });

  describe("start", () => {
    test("AC-7 start on an agent that is not installed rejects and never opens", async () => {
      const host = makeHost(stubCatalog({ installed: () => false }));
      const error = await rejectionOf(host.start({ mode: "guarded", model: "acp:cursor" }));
      expect(error.code).toBe("CHAT_ACP_AGENT_UNAVAILABLE");
      expect(opens).toHaveLength(0);
    });

    test("AC-8 AC-9 start on an ACP model never looks up a context window and leaves it unset", async () => {
      const lookup = mock(async () => 200_000);
      _chatHostDeps.lookupContextWindow = lookup;
      const host = makeHost(stubCatalog());
      await host.start({ mode: "guarded", model: "acp:codex/gpt-5.5" });
      expect(lookup).not.toHaveBeenCalled();
      expect(host.current().contextWindow).toBeUndefined();
    });

    test("a native model with a provider is still looked up", async () => {
      const lookup = mock(async () => 200_000);
      _chatHostDeps.lookupContextWindow = lookup;
      const host = makeHost(stubCatalog());
      await host.start({ mode: "guarded", model: NATIVE });
      expect(lookup).toHaveBeenCalledWith("openai", "gpt-6");
      expect(host.current().contextWindow).toBe(200_000);
    });
  });

  describe("commands and notices", () => {
    test("AC-10 a ! command on an ACP model is refused without reaching the session", async () => {
      const host = makeHost(stubCatalog());
      await host.start({ mode: "guarded", model: "acp:codex" });
      const result = await host.runCommand?.("ls", () => {});
      expect(result).toEqual({ isError: true, content: ACP_RUN_COMMAND_UNSUPPORTED });
      expect(sessions[0]?.runCommand).not.toHaveBeenCalled();
    });

    test("a ! command on a native model still reaches the session", async () => {
      const host = makeHost(stubCatalog());
      await host.start({ mode: "guarded", model: NATIVE });
      await host.runCommand?.("ls", () => {});
      expect(sessions[0]?.runCommand).toHaveBeenCalledTimes(1);
    });

    test("AC-12 notice returns the current handle's notice after a start", async () => {
      handleNotice = "N";
      const host = makeHost(stubCatalog());
      await host.start({ mode: "guarded", model: "acp:codex" });
      expect(host.notice()).toBe("N");
    });

    test("notice is undefined when neither a resume notice nor a handle notice exists", async () => {
      const host = makeHost(stubCatalog());
      await host.start({ mode: "guarded", model: NATIVE });
      expect(host.notice()).toBeUndefined();
    });
  });
});
