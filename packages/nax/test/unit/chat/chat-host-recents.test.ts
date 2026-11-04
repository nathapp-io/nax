/**
 * US-006: the host's recording of recently used models.
 *
 * The host records on the three operations that land the session somewhere new — `start`,
 * `resume` and a `switchTo` that actually changes the model or its effort — and never on one
 * that failed, was rolled back, or only changed the permission mode. What it records is the
 * model the session ended up on, so a clamped effort is what is remembered rather than the
 * string the caller asked for.
 *
 * Saving is best-effort: the list the screen reads is updated first, so a store that cannot be
 * written warns once and still leaves the switch successful.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { type AgentSession, createSessionStorage, type SessionMeta, type SessionStorage } from "@nathapp/nax-agent";
import { cleanupTempDir, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import {
  type ChatHost,
  type ChatSessionHandle,
  createChatHost,
  createRecentModelStore,
  type OpenChatSessionRequest,
  type RecentModelStore,
} from "@/chat";

const NOW = new Date("2026-11-01T00:00:00.000Z");
const OPEN_MODEL = "b/y";
const hosts: ChatHost[] = [];
let dir: string;
let storage: SessionStorage;

beforeEach(() => {
  dir = makeTempDir("chat-recents-");
  storage = createSessionStorage({
    dir: join(dir, "sessions"),
    pid: process.pid,
    now: () => NOW,
    logger: makeLogger(),
  });
});
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  cleanupTempDir(dir);
});

function sessionStub(id: string): AgentSession {
  return {
    id,
    backend: { kind: "native", capabilities: {} },
    lastTurn: undefined,
    async *send() {},
    answer: () => "accepted",
    cancel: () => {},
    close: async () => {},
  };
}

function metaOf(sessionId: string, model: string): SessionMeta {
  return {
    schemaVersion: 1,
    sessionId,
    cwd: dir,
    mode: "ask",
    model,
    bashApproval: "gated",
    title: null,
    createdAt: NOW.toISOString(),
    updatedAt: null,
  };
}

interface FixtureOptions {
  /** What the store loaded before the host was built. */
  readonly initial?: readonly string[];
  /** The store's save; absent saves successfully. */
  readonly save?: RecentModelStore["save"];
  /** A model whose open rejects, standing in for a switch the backend refuses. */
  readonly failModel?: string;
  /** The model a resume opens on — its request carries no model of its own. */
  readonly resumeModel?: string;
  /** A store to use as it is (a real one on a real file); absent builds a mock. */
  readonly store?: RecentModelStore;
}

/** A host whose session opens are stubs: the lifecycle is real, the backend is not. */
function fixture(options: FixtureOptions = {}) {
  const initial = options.initial ?? [];
  const save = mock<RecentModelStore["save"]>(options.save ?? (async (_models: readonly string[]) => {}));
  const store: RecentModelStore = options.store ?? { load: mock(async () => initial), save };
  const open = async (input: OpenChatSessionRequest): Promise<ChatSessionHandle> => {
    const model = input.model ?? options.resumeModel ?? OPEN_MODEL;
    if (model === options.failModel) throw new Error(`refused ${model}`);
    const sessionId = input.resumeId ?? "recents-session";
    return { session: sessionStub(sessionId), meta: metaOf(sessionId, model), release: async () => {} };
  };
  const logger = makeLogger();
  const host = createChatHost({
    config: makeNaxConfig({ outputDir: join(dir, "output") }),
    cwd: dir,
    repoRoot: dir,
    chain: null,
    storage,
    now: () => NOW,
    logger,
    open,
    recents: { store, initial },
  });
  hosts.push(host);
  return { host, save, store, logger };
}

describe("ChatHost recent models", () => {
  test("AC-10 the loaded list is readable before any session is opened", () => {
    const f = fixture({ initial: ["b/y"] });
    expect(f.host.recentModels?.()).toEqual(["b/y"]);
  });

  test("without recents deps the host answers no recent-model list at all", async () => {
    const logger = makeLogger();
    const host = createChatHost({
      config: makeNaxConfig({ outputDir: join(dir, "output") }),
      cwd: dir,
      repoRoot: dir,
      chain: null,
      storage,
      now: () => NOW,
      logger,
    });
    hosts.push(host);
    expect(host.recentModels).toBeUndefined();
  });

  test("AC-11 AC-12 a successful switch records the model first and saves that same list", async () => {
    const f = fixture({ initial: ["b/y"] });
    await f.host.start({ mode: "guarded", model: OPEN_MODEL });
    await f.host.switchTo({ model: "a/x[high]" });
    expect(f.host.recentModels?.()[0]).toBe("a/x[high]");
    expect(f.save.mock.calls.at(-1)?.[0]).toBe(f.host.recentModels?.());
    expect(f.host.recentModels?.()).toEqual(["a/x[high]", "b/y"]);
  });

  test("AC-13 AC-14 a switch that rejects records nothing and saves nothing", async () => {
    const f = fixture({ initial: ["b/y"], failModel: "a/x[high]" });
    await f.host.start({ mode: "guarded", model: OPEN_MODEL });
    f.save.mockClear();
    await expect(f.host.switchTo({ model: "a/x[high]" })).rejects.toThrow("refused a/x[high]");
    expect(f.host.recentModels?.()).toEqual(["b/y"]);
    expect(f.save).not.toHaveBeenCalled();
  });

  test("AC-15 a successful start records the model it opened on", async () => {
    const f = fixture();
    await f.host.start({ mode: "guarded", model: "a/x" });
    expect(f.host.recentModels?.()).toEqual(["a/x"]);
  });

  test("AC-16 a successful resume records the model the resumed session is on", async () => {
    const f = fixture({ resumeModel: "c/z[low]" });
    await f.host.resume({ id: "c-1" });
    expect(f.host.recentModels?.()).toEqual(["c/z[low]"]);
  });

  test.each([{}, { mode: "full" as const }])(
    "a switch that changes nothing but the mode records nothing",
    async (input) => {
      const f = fixture();
      await f.host.start({ mode: "guarded", model: OPEN_MODEL });
      f.save.mockClear();
      await f.host.switchTo(input);
      expect(f.save).not.toHaveBeenCalled();
      expect(f.host.recentModels?.()).toEqual([OPEN_MODEL]);
    },
  );

  test("the recorded model is the clamped one the session landed on", async () => {
    const f = fixture();
    await f.host.start({ mode: "guarded", model: OPEN_MODEL });
    await f.host.switchTo({ model: "a/x[turbo]" });
    expect(f.host.recentModels?.()[0]).toBe("a/x");
  });

  test("AC-17 AC-18 a save that rejects still resolves the switch and warns once", async () => {
    const f = fixture({
      save: async () => {
        throw new Error("disk full");
      },
    });
    await f.host.start({ mode: "guarded", model: OPEN_MODEL });
    f.logger.warn.mockClear();
    await f.host.switchTo({ model: "a/x[high]" });
    expect(f.host.recentModels?.()[0]).toBe("a/x[high]");
    expect(f.logger.warn).toHaveBeenCalledTimes(1);
    expect(f.logger.warn.mock.calls[0]?.[0]).toBe("chat");
  });

  test("F1 two hosts sharing one recent-model file keep each other's models", async () => {
    const path = join(dir, "shared", "chat-recent-models.json");
    const first = createRecentModelStore({ path });
    const second = createRecentModelStore({ path });
    // Both chats start together: each loaded the same empty file before either recorded.
    const a = fixture({ store: first, initial: await first.load() });
    const b = fixture({ store: second, initial: await second.load() });
    await a.host.start({ mode: "guarded", model: "a/x[high]" });
    await b.host.start({ mode: "guarded", model: "b/y[low]" });
    expect(await first.load()).toEqual(["b/y[low]", "a/x[high]"]);
  });
});
