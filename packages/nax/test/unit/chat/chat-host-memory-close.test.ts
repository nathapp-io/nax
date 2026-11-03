/**
 * US-014 — the two memory flushes and the guarded asks.
 *
 * A compaction and the chat's close are the two moments the mirror must be pushed,
 * and neither may fail the operation: the handler answers `undefined` (it never
 * replaces the summary) and `close()` resolves even when the sync throws.
 *
 * The host cases read the `loopHandlers` and the open requests the host built
 * through a stub opener, and the resources' `teardown` records its call into the
 * same event log as `memory.sync()`, so AC-10's ordering is observable rather
 * than inferred. The posture cases pin the array identity of the untouched rules:
 * a chat whose memory asks are off must hand the resolved posture through as the
 * same array, which is what keeps the existing identity fixtures meaningful.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type {
  AgentSession,
  BeforeCompactionPayload,
  LoopHandlerContext,
  LoopHandlerEntry,
  LoopHandlerSet,
  MemorySyncResult,
  RenderedMemoryIndex,
  SessionMeta,
} from "@nathapp/nax-agent";
import {
  assertDefined,
  CHAT_MODEL,
  type MockLogger,
  makeLogger,
  makeNaxConfig,
  makeScriptedSession,
} from "@test/helpers";
import {
  type ChatHost,
  type ChatResources,
  chatBackendPosture,
  createChatHost,
  createChatStorage,
  createHostMemory,
  type HostMemory,
  type OpenChatSessionRequest,
} from "@/chat";
import type { TuiPermissions } from "@/config";
import { RULE_DELIVERY_PLUGIN } from "@/context/rules/rule-delivery";
import type { MemoryHost } from "@/memory";
import { buildResourceCatalog } from "@/resources";

const NOW = new Date("2026-12-01T00:00:00.000Z");
/** What the fake host renders on every open; the value itself is not what this story asserts. */
const INDEX_TEXT = "# Memory\n- [project] close — the flush story";
const META: SessionMeta = {
  schemaVersion: 1,
  sessionId: "memory-close-session",
  cwd: "/r",
  mode: "ask",
  model: CHAT_MODEL,
  bashApproval: "gated",
  title: null,
  createdAt: NOW.toISOString(),
  updatedAt: null,
};
/** The one loop event this story's handler names. */
const COMPACTION: BeforeCompactionPayload = { reason: "proactive", toSummarize: [], estimatedTokens: 1_000 };
const SESSION: LoopHandlerContext = { sessionName: "chat-memory-close", role: "tui" };

type SyncFn = () => Promise<MemorySyncResult>;
type RenderFn = () => Promise<RenderedMemoryIndex>;

interface FakeMemory {
  readonly host: MemoryHost;
  readonly sync: ReturnType<typeof mock<SyncFn>>;
  /** Flip `rejects` to make every later sync throw, which is how a close-time failure is staged. */
  readonly control: { rejects: boolean };
}

/** A `MemoryHost` whose two open-time reads and its sync are the mocks; nothing else is read. */
function fakeMemory(events: string[]): FakeMemory {
  const control = { rejects: false };
  const sync = mock<SyncFn>(async (): Promise<MemorySyncResult> => {
    events.push("sync");
    if (control.rejects) throw new Error("the mirror is unreachable");
    return { outcome: "synced", pushed: 0, rejected: 0, pulled: 0, skipped: 0 };
  });
  const renderIndex = mock<RenderFn>(async (): Promise<RenderedMemoryIndex> => ({ text: INDEX_TEXT, omitted: 0 }));
  const unused = async (): Promise<never> => {
    throw new Error("the host does not read this here");
  };
  const host: MemoryHost = {
    dirs: { root: "/memory", projectDir: "/memory/project", userDir: "/memory/user" },
    providerId: "local",
    writeMode: "direct",
    notes: unused,
    getNote: unused,
    search: unused,
    renderIndex,
    sync,
    status: unused,
    save: unused,
    forget: unused,
    approve: unused,
  };
  return { host, sync, control };
}

/** The hazards a fixture can stage. */
interface FixtureOptions {
  /** Build resources without a memory host. */
  readonly memory?: boolean;
  /** Build no resources at all. */
  readonly resources?: boolean;
  /** Give the host a `naxEntry`, so it also installs the `nax-jobs` write guard. */
  readonly jobs?: boolean;
  /** Make the resources' `teardown` throw, after it has recorded its call. */
  readonly teardownRejects?: boolean;
}

interface Fixture {
  readonly host: ChatHost;
  /** `sync`, `teardown` and `open` in the order they happened. */
  readonly events: string[];
  readonly logger: MockLogger;
  readonly opens: OpenChatSessionRequest[];
  readonly memory: FakeMemory;
}

const hosts: ChatHost[] = [];
afterEach(async () => {
  // A close a case drove to rejection returns the same promise here; settle, never reject.
  await Promise.allSettled(hosts.splice(0).map((host) => host.close()));
});

function fixture(options: FixtureOptions = {}): Fixture {
  const events: string[] = [];
  const logger = makeLogger();
  const opens: OpenChatSessionRequest[] = [];
  const memory = fakeMemory(events);
  const withMemory = options.memory ?? true;
  const resources: ChatResources | undefined =
    options.resources === false
      ? undefined
      : {
          catalog: buildResourceCatalog([]),
          toolProviders: [],
          pluginHandlers: [{ plugin: "kit", event: "before_turn", handler: async () => {} }],
          naxPlugins: [],
          teardown: async () => {
            events.push("teardown");
            if (options.teardownRejects === true) throw new Error("teardown failed");
          },
          ...(withMemory ? { memory: memory.host } : {}),
        };
  const session: AgentSession = makeScriptedSession(META.sessionId, async function* () {});
  const storage = Object.assign(createChatStorage({ pid: process.pid, now: () => NOW, logger }), {
    acquireLock: async () => async () => {},
    writeMeta: async () => {},
    readMeta: async () => META,
  });
  const open = mock(async (request: OpenChatSessionRequest) => {
    events.push("open");
    opens.push(request);
    return {
      session,
      meta: { ...META, mode: request.mode === "full" ? ("full" as const) : ("ask" as const) },
      release: async () => {},
    };
  });
  const host = createChatHost({
    config: makeNaxConfig(),
    cwd: "/r",
    repoRoot: "/r",
    chain: null,
    storage,
    now: () => NOW,
    logger,
    open,
    ...(resources !== undefined ? { resources } : {}),
    ...(options.jobs === true ? { naxEntry: ["bun", "/n.ts"] } : {}),
  });
  hosts.push(host);
  return { host, events, logger, opens, memory };
}

/** The single memory entry of a handler set, or undefined when the set carries none. */
function memoryEntry(handlers: LoopHandlerSet): LoopHandlerEntry | undefined {
  return handlers.find((entry) => entry.plugin === "nax-memory");
}

function warnings(logger: MockLogger): readonly string[] {
  return logger.calls.filter((call) => call.level === "warn").map((call) => call.message);
}

/** The handlers `createHostMemory` built for a host with a memory host. */
function handlerOf(hostMemory: HostMemory): LoopHandlerEntry {
  const entry = hostMemory.handlers[0];
  assertDefined(entry, "the memory handler");
  return entry;
}

describe("createHostMemory compaction handler", () => {
  test("AC-5 AC-6 its one handler syncs the memory host once and answers undefined", async () => {
    const events: string[] = [];
    const memory = fakeMemory(events);
    const handler = handlerOf(createHostMemory({ memory: memory.host, logger: makeLogger() }));

    await expect(handler.handler(COMPACTION, SESSION)).resolves.toBeUndefined();

    expect(memory.sync).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["sync"]);
  });

  test("AC-7 AC-8 a rejecting sync still answers undefined and warns memory sync failed", async () => {
    const logger = makeLogger();
    const memory = fakeMemory([]);
    memory.control.rejects = true;
    const handler = handlerOf(createHostMemory({ memory: memory.host, logger }));

    await expect(handler.handler(COMPACTION, SESSION)).resolves.toBeUndefined();

    expect(memory.sync).toHaveBeenCalledTimes(1);
    expect(warnings(logger)).toEqual(["memory sync failed"]);
    const warn = logger.calls.find((call) => call.message === "memory sync failed");
    expect(warn?.stage).toBe("chat");
    expect(warn?.data?.error).toBe("the mirror is unreachable");
  });

  test("a chat with no memory host registers no handler and syncs nothing", async () => {
    const logger = makeLogger();
    const hostMemory = createHostMemory({ logger });

    expect(hostMemory.handlers).toEqual([]);
    await expect(hostMemory.closeSync()).resolves.toBeUndefined();
    expect(warnings(logger)).toEqual([]);
  });
});

describe("chat host memory loop handlers", () => {
  test("AC-1 AC-2 start registers exactly one nax-memory entry, for before_compaction", async () => {
    const f = fixture();

    await f.host.start({ mode: "guarded", model: CHAT_MODEL });

    const handlers = f.opens[0]?.loopHandlers ?? [];
    const memory = handlers.filter((entry) => entry.plugin === "nax-memory");
    expect(memory).toHaveLength(1);
    expect(memory[0]?.event).toBe("before_compaction");
  });

  test("AC-3 the memory entry comes after every nax-rules entry", async () => {
    const f = fixture();

    await f.host.start({ mode: "guarded", model: CHAT_MODEL });

    const plugins = (f.opens[0]?.loopHandlers ?? []).map((entry) => entry.plugin);
    const rules = plugins.lastIndexOf(RULE_DELIVERY_PLUGIN);
    expect(rules).toBeGreaterThanOrEqual(0);
    expect(plugins.indexOf("nax-memory")).toBeGreaterThan(rules);
  });

  test("the memory entry comes before the nax-jobs write guard", async () => {
    const f = fixture({ jobs: true });

    await f.host.start({ mode: "guarded", model: CHAT_MODEL });

    const plugins = (f.opens[0]?.loopHandlers ?? []).map((entry) => entry.plugin);
    const memory = plugins.indexOf("nax-memory");
    const jobs = plugins.indexOf("nax-jobs");
    expect(memory).toBeGreaterThanOrEqual(0);
    expect(jobs).toBeGreaterThanOrEqual(0);
    expect(memory).toBeLessThan(jobs);
  });

  test("AC-4 a host whose resources carry no memory registers no nax-memory entry", async () => {
    for (const options of [{ memory: false }, { resources: false }] as const) {
      const f = fixture(options);

      await f.host.start({ mode: "guarded", model: CHAT_MODEL });

      expect(memoryEntry(f.opens[0]?.loopHandlers ?? [])).toBeUndefined();
      expect(f.memory.sync).not.toHaveBeenCalled();
    }
  });
});

describe("chat host memory at close", () => {
  test("AC-9 AC-10 close syncs once more than the open did, after the resources' teardown", async () => {
    const f = fixture();
    await f.host.start({ mode: "guarded", model: CHAT_MODEL });
    expect(f.memory.sync).toHaveBeenCalledTimes(1);

    await f.host.close();

    expect(f.memory.sync).toHaveBeenCalledTimes(2);
    expect(f.events).toEqual(["sync", "open", "teardown", "sync"]);
  });

  test("AC-11 a second close reuses the first promise, so the close-time sync runs once", async () => {
    const f = fixture();
    await f.host.start({ mode: "guarded", model: CHAT_MODEL });

    await Promise.all([f.host.close(), f.host.close()]);
    await f.host.close();

    expect(f.memory.sync).toHaveBeenCalledTimes(2);
    expect(f.events.filter((event) => event === "teardown")).toHaveLength(1);
  });

  test("AC-12 AC-13 a close-time sync that rejects still resolves, and the host logger warns", async () => {
    const f = fixture();
    await f.host.start({ mode: "guarded", model: CHAT_MODEL });
    f.memory.control.rejects = true;

    await expect(f.host.close()).resolves.toBeUndefined();

    expect(f.memory.sync).toHaveBeenCalledTimes(2);
    expect(warnings(f.logger)).toEqual(["memory sync failed"]);
    expect(f.logger.calls.find((call) => call.message === "memory sync failed")?.stage).toBe("chat");
  });

  test("a close-time sync still runs when the resources' teardown rejects, and the teardown error propagates", async () => {
    const f = fixture({ teardownRejects: true });
    await f.host.start({ mode: "guarded", model: CHAT_MODEL });

    await expect(f.host.close()).rejects.toThrow("teardown failed");

    // The open's sync plus the close's: the flush was not skipped by the failed teardown.
    expect(f.memory.sync).toHaveBeenCalledTimes(2);
    expect(f.events).toEqual(["sync", "open", "teardown", "sync"]);
  });
});

describe("chatBackendPosture memory asks", () => {
  const posture: TuiPermissions = { bashApproval: "gated", askRules: ["Write"], denyRules: ["Delete(src/**)"] };

  test("AC-14 guarded with memory enabled and askOnSave adds the two memory writes", () => {
    const config = makeNaxConfig({ memory: { enabled: true, askOnSave: true } });

    const options = chatBackendPosture("guarded", config, posture);

    expect(options.askRules).toEqual([...posture.askRules, "nax-memory__save", "nax-memory__forget"]);
    expect(options.askRules).not.toContain("nax-memory__get");
    expect(options.askRules).not.toContain("nax-memory__search");
    expect(options.askRules).not.toBe(posture.askRules);
  });

  test("AC-15 guarded with askOnSave false passes the posture's own array through", () => {
    const config = makeNaxConfig({ memory: { enabled: true, askOnSave: false } });

    const options = chatBackendPosture("guarded", config, posture);

    expect(options.askRules).toBe(posture.askRules);
  });

  test("AC-16 guarded with memory disabled passes the posture's own array through", () => {
    const config = makeNaxConfig({ memory: { enabled: false, askOnSave: true } });

    const options = chatBackendPosture("guarded", config, posture);

    expect(options.askRules).toBe(posture.askRules);
  });

  test("AC-17 full carries no askRules at all", () => {
    const config = makeNaxConfig({ memory: { enabled: true, askOnSave: true } });

    const options = chatBackendPosture("full", config, posture);

    expect(options).not.toHaveProperty("askRules");
  });
});
