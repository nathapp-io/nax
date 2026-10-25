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
  host = createChatHost({
    config: makeNaxConfig({ outputDir: join(dir, "output") }),
    cwd: dir,
    repoRoot: dir,
    storage,
    chain: null,
    now: () => NOW,
    logger: makeLogger(),
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
const start = () => host.start({ mode: "guarded", model: MODEL });

describe("createChatHost resume and switch", () => {
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
    expect(order).toEqual(["open:ask", "close", "open:full"]);
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
    expect(order).toEqual(["open:ask", "close", "open:full", "open:ask"]);
    expect(optionsSeen[2]).toMatchObject({ sessionId: id, profile: "ask" });
    expect(await storage.readMeta(id)).toEqual(before);
    expect(host.current().mode).toBe("guarded");
    expect(await storage.readLockHolder(id)).toMatchObject({ state: "own" });
    await host.send("still works", () => {});
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
