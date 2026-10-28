import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { type AgentSession, createSessionStorage, type SessionMeta, type SessionStorage } from "@nathapp/nax-agent";
import { cleanupTempDir, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import { createChatHost } from "@/chat/chat-host";
import { _openChatSessionDeps } from "@/chat/open-chat-session";
import { NaxError } from "@/errors";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const MODEL = "anthropic/test";
const originals = { ..._openChatSessionDeps };
let dir: string;
let storage: SessionStorage;
let host: ReturnType<typeof createChatHost>;
let sessions: AgentSession[];
let optionsSeen: Parameters<typeof _openChatSessionDeps.createAgentSession>[0][];
let backends: Parameters<typeof _openChatSessionDeps.nativeBackend>[0][];
let order: string[];
let failNext: boolean;
let logger: ReturnType<typeof makeLogger>;
let status: "completed" | "interrupted" | undefined;
const failure = new NaxError("opening failed", "TEST_OPEN_FAILED", { stage: "test" });

beforeEach(() => {
  dir = makeTempDir("chat-resume-");
  storage = createSessionStorage({
    dir: join(dir, "sessions"),
    pid: process.pid,
    now: () => NOW,
    logger: makeLogger(),
    isAlive: () => true,
  });
  sessions = [];
  optionsSeen = [];
  backends = [];
  order = [];
  failNext = false;
  status = undefined;
  let id = 0;
  _openChatSessionDeps.randomUUID = () => `new-${++id}`;
  _openChatSessionDeps.nativeBackend = (options) => {
    backends.push(options);
    return {
      kind: "native",
      async open() {
        throw failure;
      },
    };
  };
  _openChatSessionDeps.createAgentSession = async (options) => {
    optionsSeen.push(options);
    order.push(`open:${options.profile}`);
    if (failNext) {
      failNext = false;
      throw failure;
    }
    const sessionId = options.sessionId ?? "missing";
    const session: AgentSession = {
      id: sessionId,
      backend: { kind: "native", capabilities: {} },
      lastTurn: status === undefined ? undefined : { turnId: "prior", status },
      async *send() {
        yield {
          type: "usage",
          sessionId,
          turnId: "t",
          at: NOW.toISOString(),
          metadata: {},
          round: 1,
          inputTokens: 10,
          outputTokens: 2,
          costUsd: 0.01,
        };
        yield {
          type: "turn_end",
          sessionId,
          turnId: "t",
          at: NOW.toISOString(),
          metadata: {},
          status: "completed",
          output: "ok",
          usage: { inputTokens: 0, outputTokens: 0 },
          costUsd: 0,
        };
      },
      answer: mock(() => "accepted" as const),
      cancel: mock(() => {}),
      close: mock(async () => {
        order.push("close");
      }),
    };
    sessions.push(session);
    return session;
  };
  logger = makeLogger();
  host = createChatHost({
    config: makeNaxConfig({ outputDir: join(dir, "output") }),
    cwd: dir,
    repoRoot: dir,
    storage,
    chain: null,
    now: () => NOW,
    logger,
  });
});
afterEach(async () => {
  await host.close();
  Object.assign(_openChatSessionDeps, originals);
  cleanupTempDir(dir);
});

async function stored(id: string, mode: SessionMeta["mode"] = "ask", updatedAt = "2026-09-01T00:00:00.000Z") {
  await storage.writeMeta({
    schemaVersion: 1,
    sessionId: id,
    cwd: dir,
    mode,
    model: MODEL,
    bashApproval: mode === "full" ? "raw" : "gated",
    title: null,
    createdAt: updatedAt,
    updatedAt,
  });
}
async function live(id: string) {
  await Bun.write(
    join(storage.dir, `${id}.lock`),
    JSON.stringify({ pid: 4242, startedAt: NOW.toISOString(), heartbeatAt: NOW.toISOString(), nonce: "other" }),
  );
}
function ask(id: string) {
  host.asks.handle({
    type: "approval_requested",
    sessionId: host.current().sessionId,
    turnId: "t",
    at: NOW.toISOString(),
    metadata: {},
    requestId: id,
    tool: "Bash",
    command: "npm test",
    summary: "tests",
    reason: "guarded",
    expiresAt: NOW.toISOString(),
  });
}
const start = (): Promise<void> => host.start({ mode: "guarded", model: MODEL });

describe("createChatHost resume and switch", () => {
  function shadows() {
    const drains: ReturnType<typeof mock<() => Promise<void>>>[] = [];
    _openChatSessionDeps.buildCommandShadow = () => {
      const drain = mock(async () => {
        expect(await storage.readLockHolder(host.current().sessionId)).toMatchObject({ state: "own" });
      });
      drains.push(drain);
      return { observe() {}, settle() {}, drain };
    };
    return drains;
  }

  test("full to guarded drains the reopened shadow before unlocking on close", async () => {
    const drains = shadows();
    await host.start({ mode: "full", model: MODEL });
    const id = host.current().sessionId;
    await host.switchTo({ mode: "guarded" });
    expect(drains).toHaveLength(1);
    expect(drains[0]).not.toHaveBeenCalled();
    await host.close();
    expect(drains[0]).toHaveBeenCalledTimes(1);
    expect(await storage.readLockHolder(id)).toBeNull();
  });

  test("guarded model and mode switches retire each shadow without unlocking", async () => {
    const drains = shadows();
    await start();
    const id = host.current().sessionId;
    await host.switchTo({ model: "other/model" });
    expect(drains[0]).toHaveBeenCalledTimes(1);
    expect(drains[1]).not.toHaveBeenCalled();
    await host.switchTo({ mode: "full" });
    expect(drains[1]).toHaveBeenCalledTimes(1);
    expect(await storage.readLockHolder(id)).toMatchObject({ state: "own" });
    await host.close();
    expect(drains.map((drain) => drain.mock.calls.length)).toEqual([1, 1]);
    expect(await storage.readLockHolder(id)).toBeNull();
  });

  test.each(["open", "persist"] as const)("failed %s retires attempted and rollback shadows", async (kind) => {
    const drains = shadows();
    await start();
    const id = host.current().sessionId;
    if (kind === "open") failNext = true;
    else {
      const writeMeta = storage.writeMeta.bind(storage);
      storage.writeMeta = mock(async () => {
        storage.writeMeta = writeMeta;
        throw failure;
      });
    }
    await expect(host.switchTo({ model: "other/model" })).rejects.toBe(failure);
    expect(drains).toHaveLength(3);
    expect(drains.map((drain) => drain.mock.calls.length)).toEqual([1, 1, 0]);
    expect(host.current().model).toBe(MODEL);
    expect(await storage.readLockHolder(id)).toMatchObject({ state: "own" });
    await host.close();
    expect(drains.map((drain) => drain.mock.calls.length)).toEqual([1, 1, 1]);
    expect(await storage.readLockHolder(id)).toBeNull();
  });
  test("AC-1 latest uses storage order and preserves stored settings", async () => {
    await stored("older");
    await stored("newer", "full", NOW.toISOString());
    const first = (await storage.list({ cwd: dir })).sessions[0]?.sessionId;
    await host.resume({});
    expect(host.current()).toMatchObject({ sessionId: first, mode: "full", model: MODEL });
  });
  test.each(["read", "live"] as const)("AC-2/3 skips newer %s entry", async (kind) => {
    await stored("older");
    await stored("newer", kind === "read" ? "read" : "ask", NOW.toISOString());
    if (kind === "live") await live("newer");
    await host.resume({});
    expect(host.current().sessionId).toBe("older");
  });
  test("AC-4 no usable session has exact error", async () => {
    await stored("read-only", "read");
    await expect(host.resume({})).rejects.toMatchObject({
      code: "CHAT_SESSION_NOT_FOUND",
      message: `no resumable session for ${dir}`,
    });
  });
  test("AC-5 explicit live lock has pid in error", async () => {
    await stored("busy");
    await live("busy");
    await expect(host.resume({ id: "busy" })).rejects.toMatchObject({
      code: "CHAT_SESSION_LOCKED",
      message: "session busy is in use by pid 4242",
    });
  });
  test.each(["interrupted", "completed"] as const)("AC-6/7 notice for %s", async (lastStatus) => {
    status = lastStatus;
    await stored("prior");
    await host.resume({ id: "prior" });
    expect(host.notice()).toBe(
      lastStatus === "interrupted" ? "The last turn was interrupted. Send a message to continue it." : undefined,
    );
  });
  test("AC-8 another session releases lock and forgets approvals", async () => {
    await start();
    const old = host.current().sessionId;
    ask("r1");
    host.asks.resolve("r1", "allow_session");
    await stored("other");
    await host.resume({ id: "other" });
    ask("r2");
    expect(await storage.readLockHolder(old)).toBeNull();
    expect(sessions[0]?.close).toHaveBeenCalledTimes(1);
    expect(host.asks.pending().map((event) => event.requestId)).toEqual(["r2"]);
    expect(sessions[1]?.answer).not.toHaveBeenCalled();
  });
  test("AC-9/10 closes before reopening full while retaining ownership and committing settings", async () => {
    await start();
    const id = host.current().sessionId;
    await host.switchTo({ mode: "full" });
    expect(order).toEqual(["open:full", "close", "open:full"]);
    expect(optionsSeen[1]).toMatchObject({ sessionId: id, profile: "full" });
    expect(await storage.readMeta(id)).toMatchObject({ mode: "full", bashApproval: "raw" });
    expect(await storage.readLockHolder(id)).toMatchObject({ state: "own" });
  });
  test("AC-11 same-session switches preserve remembered decisions even back in guarded", async () => {
    await start();
    ask("r1");
    host.asks.resolve("r1", "allow_session");
    await host.switchTo({ mode: "full" });
    await host.switchTo({ mode: "guarded" });
    ask("r2");
    expect(host.asks.pending()).toEqual([]);
    expect(sessions[2]?.answer).toHaveBeenCalledWith("r2", { decision: "allow" });
  });
  test("AC-12 model switch uses same id and persists model", async () => {
    await start();
    const id = host.current().sessionId;
    const model = "anthropic/claude-sonnet-5-5";
    await host.switchTo({ model });
    expect(optionsSeen[1]?.sessionId).toBe(id);
    expect(backends[1]?.model).toBe(model);
    expect(await storage.readMeta(id)).toMatchObject({ model });
  });
  test("AC-13 failed switch restores ask session and unchanged metadata", async () => {
    await start();
    const id = host.current().sessionId;
    const before = await storage.readMeta(id);
    failNext = true;
    await expect(host.switchTo({ mode: "full" })).rejects.toBe(failure);
    expect(order).toEqual(["open:full", "close", "open:full", "open:full"]);
    expect(optionsSeen[2]).toMatchObject({ sessionId: id, profile: "full" });
    expect(await storage.readMeta(id)).toEqual(before);
    expect(host.current().mode).toBe("guarded");
    expect(await storage.readLockHolder(id)).toMatchObject({ state: "own" });
    await host.send("still works", () => {});
  });
  test("F1 model switches attribute each usage row to the active model and retain prior rows", async () => {
    await start();
    const id = host.current().sessionId;
    await host.send("first", () => {});
    await host.switchTo({ model: "other/model" });
    await host.send("second", () => {});
    await host.switchTo({ model: MODEL });
    await host.send("third", () => {});
    const rows = (await Bun.file(join(dir, "output", "cost", `chat-${id}-${NOW.getTime()}.jsonl`)).text())
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row));
    expect(rows.map((row) => row.model)).toEqual([MODEL, "other/model", MODEL]);
    expect(rows.map((row) => row.runId)).toEqual(Array(3).fill(`chat-${id}-${NOW.getTime()}`));
  });
  test("F1 resume attributes usage to the active session and preserves rows when returning", async () => {
    await start();
    const id = host.current().sessionId;
    await host.send("first", () => {});
    const originalFile = join(dir, "output", "cost", `chat-${id}-${NOW.getTime()}.jsonl`);
    const first = await Bun.file(originalFile).text();
    await stored("other");
    await host.resume({ id: "other" });
    await host.send("second", () => {});
    expect(await Bun.file(originalFile).text()).toBe(first);
    const otherFile = join(dir, "output", "cost", `chat-other-${NOW.getTime()}.jsonl`);
    const other = await Bun.file(otherFile).text();
    expect(JSON.parse(other)).toMatchObject({ runId: `chat-other-${NOW.getTime()}`, model: MODEL, costUsd: 0.01 });
    await host.resume({ id });
    await host.send("third", () => {});
    expect((await Bun.file(originalFile).text()).trim().split("\n")).toHaveLength(2);
    expect(await Bun.file(otherFile).text()).toBe(other);
  });
  test("AC-14 two reopens reuse handler identity", async () => {
    await start();
    await host.switchTo({ mode: "full" });
    await host.switchTo({ model: "other/model" });
    expect(backends).toHaveLength(3);
    expect(backends[0]?.loopHandlers).toBe(backends[1]?.loopHandlers);
    expect(backends[1]?.loopHandlers).toBe(backends[2]?.loopHandlers);
  });
  test("AC-15 newest corrupt metadata is skipped", async () => {
    await stored("older");
    await stored("newer", "ask", NOW.toISOString());
    const list = storage.list.bind(storage);
    const page = await list({ cwd: dir });
    storage.list = mock(async () => page);
    await Bun.write(join(storage.dir, "newer.session.json"), "{bad");
    await host.resume({});
    expect(host.current().sessionId).toBe("older");
  });
  test.each(["none", "read"] as const)("explicit %s mode refuses before locking", async (mode) => {
    await stored("unsupported", mode);
    await expect(host.resume({ id: "unsupported" })).rejects.toMatchObject({
      code: "CHAT_SESSION_MODE_UNSUPPORTED",
      message: `session unsupported was created in mode ${mode}; nax chat opens full or ask sessions only`,
    });
    expect(await storage.readLockHolder("unsupported")).toBeNull();
    expect(optionsSeen).toEqual([]);
  });
  test("explicit corrupt and missing metadata propagate without locking", async () => {
    await stored("corrupt");
    await Bun.write(join(storage.dir, "corrupt.session.json"), "{bad");
    await expect(host.resume({ id: "corrupt" })).rejects.toMatchObject({ code: "SESSION_META_UNREADABLE" });
    await expect(host.resume({ id: "missing" })).rejects.toMatchObject({
      code: "CHAT_SESSION_NOT_FOUND",
      message: `no session missing in ${storage.dir}`,
    });
    expect(await storage.readLockHolder("corrupt")).toBeNull();
    expect(await storage.readLockHolder("missing")).toBeNull();
    expect(optionsSeen).toEqual([]);
  });
  test("AC-16 failed resume leaves current session open and owned", async () => {
    await start();
    const id = host.current().sessionId;
    await stored("other");
    failNext = true;
    await expect(host.resume({ id: "other" })).rejects.toBe(failure);
    expect(host.current().sessionId).toBe(id);
    expect(sessions[0]?.close).not.toHaveBeenCalled();
    expect(await storage.readLockHolder(id)).toMatchObject({ state: "own" });
    expect(await storage.readLockHolder("other")).toBeNull();
    await host.send("still works", () => {});
  });
});

describe("session hygiene", () => {
  async function turnless(id: string) {
    await stored(id);
    const meta = await storage.readMeta(id);
    if (!meta) throw failure;
    await storage.writeMeta({ ...meta, updatedAt: null, createdAt: NOW.toISOString() });
  }
  function transcript() {
    const doc = {
      savedAt: "2026-10-28T01:00:00.000Z",
      messages: [
        { role: "user" as const, content: "hello" },
        { role: "assistant" as const, content: "hi" },
      ],
    };
    const factory = _openChatSessionDeps.createFileTranscriptStore;
    _openChatSessionDeps.createFileTranscriptStore = (path) => ({ ...factory(path), load: async () => doc });
    _openChatSessionDeps.resumeAgentSession = async (_id, options) => _openChatSessionDeps.createAgentSession(options);
    return doc;
  }
  test("hygiene AC-3 history exposes resumed transcript snapshot", async () => {
    await stored("prior");
    const doc = transcript();
    await host.resume({ id: "prior" });
    expect(host.history?.()).toEqual(doc);
  });
  test("hygiene AC-4 excludes own session even with a recorded turn", async () => {
    await start();
    await host.send("hello", () => {});
    expect(await host.listSessions()).toEqual([]);
  });
  test("hygiene AC-5 lists recorded sessions without an open handle", async () => {
    await stored("prior");
    expect(await host.listSessions()).toEqual([expect.objectContaining({ sessionId: "prior" })]);
  });
  test("hygiene AC-7 hides turnless stored sessions", async () => {
    await stored("prior");
    await turnless("empty");
    expect((await host.listSessions()).map((row) => row.sessionId)).toEqual(["prior"]);
    expect(await storage.readMeta("empty")).not.toBeNull();
  });
  test("hygiene AC-8 latest skips a newer turnless session", async () => {
    await stored("prior");
    await turnless("empty");
    await host.resume({});
    expect(host.current().sessionId).toBe("prior");
  });
  test.each(["close", "replace", "switch-close"] as const)(
    "cleanup retains lock during metadata re-read and removal on %s",
    async (operation) => {
      await start();
      const id = host.current().sessionId;
      if (operation === "switch-close") await host.switchTo({ mode: "full" });
      if (operation === "replace") await stored("prior");
      const read = storage.readMeta.bind(storage);
      const remove = storage.removeMeta.bind(storage);
      const holders: unknown[] = [];
      storage.readMeta = async (sessionId) => {
        if (sessionId === id) holders.push(await storage.readLockHolder(id));
        return read(sessionId);
      };
      storage.removeMeta = async (sessionId) => {
        if (sessionId === id) holders.push(await storage.readLockHolder(id));
        await remove(sessionId);
      };
      if (operation === "replace") await host.resume({ id: "prior" });
      else await host.close();
      expect(holders).toEqual([expect.objectContaining({ state: "own" }), expect.objectContaining({ state: "own" })]);
      expect(await storage.readLockHolder(id)).toBeNull();
      expect(await read(id)).toBeNull();
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );
  test("hygiene AC-9 closes an unsent new session and removes meta", async () => {
    await start();
    const id = host.current().sessionId;
    await host.close();
    expect(await storage.readMeta(id)).toBeNull();
  });
  test.each([false, true])("hygiene AC-6/10 sent session survives close (switch %s)", async (switchMode) => {
    await start();
    const id = host.current().sessionId;
    if (switchMode) await host.switchTo({ mode: "full" });
    expect(await storage.readMeta(id)).not.toBeNull();
    await host.send("hello", () => {});
    await host.close();
    expect(await storage.readMeta(id)).not.toBeNull();
  });
  test("hygiene AC-11 replacing an unsent new session removes its meta", async () => {
    await start();
    const id = host.current().sessionId;
    await stored("prior");
    await host.resume({ id: "prior" });
    expect(await storage.readMeta(id)).toBeNull();
    expect(host.current().sessionId).toBe("prior");
  });
  test("hygiene AC-12 explicit turnless resume with history keeps meta", async () => {
    await turnless("prior");
    transcript();
    await host.resume({ id: "prior" });
    await host.close();
    expect(await storage.readMeta("prior")).not.toBeNull();
  });
  test("hygiene AC-13 already removed meta closes silently", async () => {
    await start();
    await storage.removeMeta(host.current().sessionId);
    await host.close();
    expect(logger.warn).not.toHaveBeenCalled();
  });
  test.each(["close", "replace", "missing"] as const)(
    "hygiene AC-14/16/17 removal failure during %s only warns",
    async (kind) => {
      await start();
      const id = host.current().sessionId;
      if (kind === "missing") Reflect.deleteProperty(storage, "removeMeta");
      else
        storage.removeMeta = mock(async () => {
          throw failure;
        });
      if (kind === "replace") {
        await stored("prior");
        await host.resume({ id: "prior" });
        expect(host.current().sessionId).toBe("prior");
      } else await host.close();
      expect(await storage.readLockHolder(id)).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith("chat", "could not remove empty session", {
        sessionId: id,
        cause: expect.anything(),
      });
    },
  );
  test("hygiene AC-15 unreadable row is skipped while other rows list", async () => {
    await stored("prior");
    await stored("bad");
    const read = storage.readMeta.bind(storage);
    storage.readMeta = async (id) => {
      if (id === "bad") throw new NaxError("bad meta", "SESSION_META_UNREADABLE", { stage: "test" });
      return read(id);
    };
    expect((await host.listSessions()).map((row) => row.sessionId)).toEqual(["prior"]);
    expect(logger.warn).toHaveBeenCalledWith("chat", "skipping unreadable session metadata", { sessionId: "bad" });
  });
  test("hygiene failed send survives same-id reopen and close without turn metadata", async () => {
    await start();
    const id = host.current().sessionId;
    const session = sessions[0];
    if (!session) throw failure;
    session.send = async function* () {
      yield { type: "turn_start", sessionId: id, turnId: "failed", at: NOW.toISOString(), metadata: {} };
      throw failure;
    };
    await expect(host.send("hello", () => {})).rejects.toBe(failure);
    await host.switchTo({ mode: "full" });
    await host.close();
    expect(await storage.readMeta(id)).toMatchObject({ updatedAt: null });
  });
});
