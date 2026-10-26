import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { type AgentSession, createSessionStorage, LIST_PAGE_SIZE, type SessionStorage } from "@nathapp/nax-agent";
import {
  cleanupTempDir,
  makeFakeClock,
  makeInteractionChain,
  makeLogger,
  makeNaxConfig,
  makeTempDir,
} from "@test/helpers";
import { _askFallbackDeps } from "@/chat/ask-fallback";
import { createChatHost } from "@/chat/chat-host";
import { _openChatSessionDeps } from "@/chat/open-chat-session";
import { DEFAULT_CONFIG } from "@/config";
import { NaxError } from "@/errors";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const MODEL = "anthropic/test";
const DELAY = 1_234;
/** Sessions the store holds past one page: `list()` hands them back `LIST_PAGE_SIZE` at a time. */
const STORED_SESSIONS = LIST_PAGE_SIZE + 10;
/** A session index well inside the store's second page. */
const PAGE_TWO_INDEX = LIST_PAGE_SIZE + 5;
/** One minute between two stored sessions, so the store's newest-first order is this file's order. */
const MINUTE_MS = 60_000;
const originals = { ..._openChatSessionDeps };
const timers = { ..._askFallbackDeps };
let dir: string;
let storage: SessionStorage;
let host: ReturnType<typeof createChatHost>;
let clock: ReturnType<typeof makeFakeClock>;
let sessions: AgentSession[];
let backendOptions: Parameters<typeof _openChatSessionDeps.nativeBackend>[0][];
let failOpen: boolean;
let askOnSend: boolean;
let waiting: boolean;
let resumeSend: () => void;
let seenAsk: ReturnType<typeof Promise.withResolvers<void>>;
const prompt = mock(async () => ({ requestId: "chat-r1", action: "skip" as const, respondedAt: 0 }));
const destroy = mock(async () => {});

beforeEach(() => {
  dir = makeTempDir("chat-host-");
  storage = createSessionStorage({
    dir: join(dir, "sessions"),
    pid: process.pid,
    now: () => NOW,
    logger: makeLogger(),
    isAlive: () => true,
  });
  clock = makeFakeClock();
  _askFallbackDeps.setTimeout = clock.setTimeout;
  _askFallbackDeps.clearTimeout = (handle) => clock.clearTimeout(Number(handle));
  sessions = [];
  backendOptions = [];
  failOpen = false;
  askOnSend = false;
  waiting = false;
  resumeSend = () => {};
  seenAsk = Promise.withResolvers<void>();
  prompt.mockClear();
  destroy.mockClear();
  let id = 0;
  _openChatSessionDeps.randomUUID = () => `session-${++id}`;
  _openChatSessionDeps.now = () => NOW;
  _openChatSessionDeps.nativeBackend = mock((options) => {
    backendOptions.push(options);
    return {
      kind: "native",
      async open() {
        throw new NaxError("unused", "TEST_FAILURE", { stage: "test" });
      },
    };
  });
  _openChatSessionDeps.createAgentSession = mock(async (options) => {
    if (failOpen) throw new NaxError("opening failed", "TEST_OPEN_FAILED", { stage: "test" });
    const sessionId = options.sessionId ?? "missing";
    const session: AgentSession = {
      id: sessionId,
      backend: { kind: "native", capabilities: {}, sandbox: { kind: "disabled" } },
      lastTurn: undefined,
      async *send() {
        const base = { sessionId, turnId: "t1", at: NOW.toISOString(), metadata: {} };
        yield { ...base, type: "turn_start" };
        if (askOnSend) {
          const gate = Promise.withResolvers<void>();
          resumeSend = () => gate.resolve();
          yield {
            ...base,
            type: "approval_requested",
            requestId: "r1",
            tool: "Bash",
            command: "npm test",
            summary: "Run tests",
            reason: "guarded",
            expiresAt: NOW.toISOString(),
          };
          seenAsk.resolve();
          if (waiting) await gate.promise;
        }
        yield { ...base, type: "usage", round: 1, inputTokens: 100, outputTokens: 20, costUsd: 0.01 };
        yield {
          ...base,
          type: "turn_end",
          status: "completed",
          output: "done",
          usage: { inputTokens: 100, outputTokens: 20 },
          costUsd: 0.02,
        };
      },
      answer: mock(() => {
        resumeSend();
        return "accepted" as const;
      }),
      cancel: mock(() => resumeSend()),
      close: mock(async () => resumeSend()),
    };
    sessions.push(session);
    return session;
  });
  host = createChatHost({
    config: makeNaxConfig({ outputDir: join(dir, "output"), interaction: { defaults: { chatAskFallbackMs: DELAY } } }),
    cwd: dir,
    repoRoot: dir,
    storage,
    now: () => NOW,
    logger: makeLogger(),
    chain: makeInteractionChain({ prompt, destroy }),
  });
});
afterEach(async () => {
  resumeSend();
  await host?.close();
  Object.assign(_openChatSessionDeps, originals);
  Object.assign(_askFallbackDeps, timers);
  cleanupTempDir(dir);
});
const start = () => host.start({ mode: "guarded", model: MODEL });
const send = () => host.send("hello", () => {});

async function waitingTurn() {
  askOnSend = true;
  waiting = true;
  const turn = send();
  await seenAsk.promise;
  return { turn };
}

/** The id the store sorts at `index`: index 0 is the newest session. */
function storedId(index: number): string {
  return `zz${String(index).padStart(3, "0")}-session`;
}

/** Fill the store newest-first, one session a minute going back from `NOW`. */
async function storedSessions(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const updatedAt = new Date(NOW.getTime() - index * MINUTE_MS).toISOString();
    await storage.writeMeta({
      schemaVersion: 1,
      sessionId: storedId(index),
      cwd: dir,
      mode: "ask",
      model: MODEL,
      bashApproval: "gated",
      title: `title ${index}`,
      createdAt: updatedAt,
      updatedAt,
    });
  }
}

/** A second process's lock file: what the store reads as a live holder. */
async function liveHold(session: string): Promise<void> {
  await Bun.write(
    join(storage.dir, `${session}.lock`),
    JSON.stringify({ pid: 4242, startedAt: NOW.toISOString(), heartbeatAt: NOW.toISOString(), nonce: "other" }),
  );
}

describe("createChatHost", () => {
  test("AC-1 start maps guarded to persisted ask mode", async () => {
    await start();
    expect(host.current()).toMatchObject({ mode: "guarded", model: MODEL, meta: { mode: "ask" } });
    expect((await storage.readMeta(host.current().sessionId))?.mode).toBe("ask");
    expect(host.repoRoot).toBe(dir);
  });
  test("AC-2 send keeps cumulative persisted spend current", async () => {
    await start();
    await send();
    await send();
    expect(host.current().meta.costUsd).toBeCloseTo(0.04);
    expect(await storage.readMeta(host.current().sessionId)).toEqual(host.current().meta);
  });
  test("AC-3 send offers a waiting guarded approval after configured delay", async () => {
    await start();
    const { turn } = await waitingTurn();
    await clock.advance(DELAY - 1);
    expect(prompt).not.toHaveBeenCalled();
    await clock.advance(1);
    expect(prompt).toHaveBeenCalledTimes(1);
    host.asks.resolve("r1", "deny");
    await turn;
  });
  test("AC-4 usage reaches the chat ledger under outputDir/cost", async () => {
    await start();
    await send();
    const file = join(dir, "output", "cost", `chat-${host.current().sessionId}-${NOW.getTime()}.jsonl`);
    const rows = (await Bun.file(file).text())
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: "chat", sessionRole: "tui", costUsd: 0.01, model: MODEL });
  });
  test("AC-5 list marks a live lock held by pid 4242", async () => {
    await start();
    const id = host.current().sessionId;
    await Bun.write(
      join(storage.dir, `${id}.lock`),
      JSON.stringify({ pid: 4242, startedAt: NOW.toISOString(), heartbeatAt: NOW.toISOString(), nonce: "external" }),
    );
    expect(await storage.readLockHolder(id)).toMatchObject({ state: "live", pid: 4242 });
    expect(await host.listSessions()).toEqual([expect.objectContaining({ sessionId: id, heldByPid: 4242 })]);
  });
  test("AC-5a list follows the store's pages instead of stopping at the first", async () => {
    await storedSessions(STORED_SESSIONS);
    // The first page alone is short: the list is every page, or `/resume` cannot reach the rest.
    const page = await storage.list({ cwd: dir });
    expect(page.sessions).toHaveLength(LIST_PAGE_SIZE);
    expect(page.nextCursor).toBeDefined();
    const rows = await host.listSessions();
    expect(rows).toHaveLength(STORED_SESSIONS);
    expect(rows.map((row) => row.sessionId)).toEqual(
      Array.from({ length: STORED_SESSIONS }, (_unused, index) => storedId(index)),
    );
  });
  test("AC-5b list marks a live holder of a session past the first page", async () => {
    await storedSessions(STORED_SESSIONS);
    await liveHold(storedId(PAGE_TWO_INDEX));
    const rows = await host.listSessions();
    expect(rows[PAGE_TWO_INDEX]).toMatchObject({
      sessionId: storedId(PAGE_TWO_INDEX),
      title: `title ${PAGE_TWO_INDEX}`,
      heldByPid: 4242,
    });
    expect(rows.filter((row) => row.heldByPid !== undefined)).toHaveLength(1);
  });
  test("AC-6 clear opens same settings under new id and releases old lock", async () => {
    await start();
    const old = host.current().sessionId;
    await host.clear();
    expect(host.current()).toMatchObject({ mode: "guarded", model: MODEL });
    expect(host.current().sessionId).not.toBe(old);
    expect(await storage.readLockHolder(old)).toBeNull();
    expect(sessions[0]?.close).toHaveBeenCalledTimes(1);
    expect(_openChatSessionDeps.nativeBackend).toHaveBeenCalledTimes(2);
    const calls = _openChatSessionDeps.nativeBackend;
    expect(calls).toHaveBeenLastCalledWith(
      expect.objectContaining({
        loopHandlers: expect.arrayContaining([expect.objectContaining({ plugin: "nax-rules" })]),
      }),
    );
  });
  test("AC-7 clear forgets allow_session and answers stay bound to new session", async () => {
    await start();
    askOnSend = true;
    await send();
    host.asks.resolve("r1", "allow_session");
    await host.clear();
    await send();
    expect(host.asks.pending()).toHaveLength(1);
    expect(sessions[1]?.answer).not.toHaveBeenCalled();
    host.asks.resolve("r1", "allow_once");
    expect(sessions[1]?.answer).toHaveBeenCalledWith("r1", { decision: "allow" });
    expect(sessions[0]?.answer).toHaveBeenCalledTimes(1);
  });
  test("AC-8 fallback and chain survive clear", async () => {
    await start();
    await host.clear();
    const { turn } = await waitingTurn();
    await clock.advance(DELAY);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    host.asks.resolve("r1", "deny");
    await turn;
  });
  test.each(["clear", "start"] as const)(
    "AC-9/11 failed %s retains open current session and ownership",
    async (operation) => {
      await start();
      const id = host.current().sessionId;
      failOpen = true;
      const result = operation === "clear" ? host.clear() : host.start({ mode: "full", model: "other/model" });
      await expect(result).rejects.toMatchObject({ code: "TEST_OPEN_FAILED", message: "opening failed" });
      expect(host.current().sessionId).toBe(id);
      expect(await storage.readLockHolder(id)).toMatchObject({ state: "own" });
      expect(sessions[0]?.close).not.toHaveBeenCalled();
      expect(await storage.readLockHolder("session-2")).toBeNull();
      await send();
      expect(host.current().meta.costUsd).toBe(0.02);
    },
  );
  test("models deduplicate native tiers and skip absent entries", async () => {
    const other = createChatHost({
      config: makeNaxConfig({
        models: {
          native: { fast: MODEL, balanced: { provider: "anthropic", model: "test" }, powerful: "other/model" },
        },
      }),
      cwd: dir,
      repoRoot: dir,
      storage,
      chain: null,
      now: () => NOW,
      logger: makeLogger(),
    });
    expect(other.models).toEqual([MODEL, "other/model"]);
    await other.close();
    const defaultsBefore = structuredClone(DEFAULT_CONFIG);
    // The config helper shares untouched nested defaults; isolate before deleting fields.
    const sparse = structuredClone(makeNaxConfig());
    delete sparse.models.native;
    expect(DEFAULT_CONFIG).toEqual(defaultsBefore);
    const empty = createChatHost({
      config: sparse,
      cwd: dir,
      repoRoot: dir,
      storage,
      chain: null,
      now: () => NOW,
      logger: makeLogger(),
    });
    expect(empty.models).toEqual([]);
    await empty.close();
  });
  test("default fallback delay is 60000 for a hand-written optional field", async () => {
    await host.close();
    const defaultsBefore = structuredClone(DEFAULT_CONFIG);
    const config = structuredClone(makeNaxConfig({ outputDir: join(dir, "output") }));
    if (config.interaction) delete config.interaction.defaults.chatAskFallbackMs;
    expect(DEFAULT_CONFIG).toEqual(defaultsBefore);
    host = createChatHost({
      config,
      cwd: dir,
      repoRoot: dir,
      storage,
      chain: makeInteractionChain({ prompt }),
      now: () => NOW,
      logger: makeLogger(),
    });
    await start();
    const { turn } = await waitingTurn();
    await clock.advance(59_999);
    expect(prompt).not.toHaveBeenCalled();
    await clock.advance(1);
    expect(prompt).toHaveBeenCalledTimes(1);
    host.cancel();
    await turn;
    expect(sessions[0]?.cancel).toHaveBeenCalledTimes(1);
  });
  test("keeps the process ledger and rule handler identities across clear", async () => {
    await start();
    const id = host.current().sessionId;
    await send();
    await host.clear();
    await send();
    const file = join(dir, "output", "cost", `chat-${id}-${NOW.getTime()}.jsonl`);
    expect((await Bun.file(file).text()).trim().split("\n")).toHaveLength(1);
    const nextFile = join(dir, "output", "cost", `chat-${host.current().sessionId}-${NOW.getTime()}.jsonl`);
    expect((await Bun.file(nextFile).text()).trim().split("\n")).toHaveLength(1);
    expect(backendOptions[0]?.loopHandlers).toBe(backendOptions[1]?.loopHandlers);
    expect(_openChatSessionDeps.nativeBackend).toHaveBeenCalledTimes(2);
  });
  test("keeps state readable when quitting with a pending ask", async () => {
    await start();
    askOnSend = true;
    await send();
    const state = host.current();
    const closed = Promise.withResolvers<void>();
    const session = sessions[0];
    if (!session) throw new Error("missing session");
    session.close = mock(() => closed.promise);
    const changed = mock(() => host.current());
    const unsubscribe = host.asks.onChange(changed);
    try {
      const closing = host.close();
      expect(changed).not.toHaveBeenCalled();
      expect(host.asks.pending()).toHaveLength(1);
      expect(host.current()).toEqual(state);
      closed.resolve();
      await closing;
      expect(host.current()).toEqual(state);
      await expect(send()).rejects.toMatchObject({ code: "CHAT_HOST_CLOSED" });
    } finally {
      unsubscribe();
      closed.resolve();
    }
  });
  test("keeps state readable for the final refresh when quitting mid-turn", async () => {
    await start();
    const { turn } = await waitingTurn();
    const refreshed = turn.finally(() => {
      expect(host.current()).toMatchObject({ sessionId: "session-1", model: MODEL });
    });
    host.cancel();
    const closing = host.close();
    await refreshed;
    await closing;
    expect(host.current().meta.costUsd).toBe(0.02);
    expect(await storage.readLockHolder("session-1")).toBeNull();
  });
  test("AC-10 close releases ownership, destroys chain and disposes timers once", async () => {
    await start();
    askOnSend = true;
    await send();
    const id = host.current().sessionId;
    await host.close();
    await host.close();
    expect(await storage.readLockHolder(id)).toBeNull();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(sessions[0]?.close).toHaveBeenCalledTimes(1);
    expect(clock.pending()).toBe(0);
    await expect(start()).rejects.toMatchObject({ code: "CHAT_HOST_CLOSED" });
  });
});
