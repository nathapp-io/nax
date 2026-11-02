/**
 * US-013 — the chat host prepares the memory index once per open and hands the
 * parent snapshot to every subagent session it starts.
 *
 * The host runs against a stub opener, so each case reads the exact
 * `OpenChatSessionRequest` the host built: the memory index it carries, and the
 * order in which `memory.sync()` and the open were called. The fake host records
 * both calls, and the host's own logger is the assertion surface for the two
 * warnings a failing fake produces.
 *
 * The subagent case (AC-16) runs through the shared subagent harness, so the
 * nested session is the real `runSubagent` path with its instructions captured.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AgentSession, MemorySyncResult, RenderedMemoryIndex, SessionMeta } from "@nathapp/nax-agent";
import {
  CHAT_MODEL,
  type MockLogger,
  makeAgentResource,
  makeLogger,
  makeNaxConfig,
  makeSubagentHostHarness,
  type SubagentHostHarness,
  waitForCondition,
} from "@test/helpers";
import {
  type ChatHost,
  type ChatResources,
  createChatHost,
  createChatStorage,
  type OpenChatSessionRequest,
} from "@/chat";
import { createHostMemory } from "@/chat/host-memory";
import type { MemoryHost } from "@/memory";
import { buildResourceCatalog } from "@/resources";

/** What the fake host renders: the note the motivation names, as index text. */
const INDEX_TEXT = "# Memory\n- [project] slice-2 — the second slice of the delivery plan";
const NOW = new Date("2026-11-05T00:00:00.000Z");
const OTHER_MODEL = "anthropic/other-model";

const META: SessionMeta = {
  schemaVersion: 1,
  sessionId: "memory-session",
  cwd: "/r",
  mode: "ask",
  model: CHAT_MODEL,
  bashApproval: "gated",
  title: null,
  createdAt: NOW.toISOString(),
  updatedAt: null,
};

type SyncFn = () => Promise<MemorySyncResult>;
type RenderFn = () => Promise<RenderedMemoryIndex>;

interface FakeMemoryOptions {
  /** The rendered text; defaults to `INDEX_TEXT`. */
  readonly text?: string;
  /** One text per `renderIndex` call, the last one repeating; overrides `text` when given. */
  readonly texts?: readonly string[];
  /** The outcome the synced run reports; defaults to `synced`. */
  readonly outcome?: MemorySyncResult["outcome"];
  readonly syncRejects?: boolean;
  readonly renderRejects?: boolean;
}

interface FakeMemory {
  readonly host: MemoryHost;
  readonly sync: ReturnType<typeof mock<SyncFn>>;
  readonly renderIndex: ReturnType<typeof mock<RenderFn>>;
}

/** The text one render returns: the next of `texts`, else `text`, else the default. */
function renderedText(options: FakeMemoryOptions, call: number): string {
  const texts = options.texts;
  if (texts === undefined) return options.text ?? INDEX_TEXT;
  return texts[Math.min(call, texts.length - 1)] ?? INDEX_TEXT;
}

/** A `MemoryHost` whose two session-open reads are mocks; nothing else is read by the host. */
function fakeMemory(events: string[], options: FakeMemoryOptions = {}): FakeMemory {
  const sync = mock<SyncFn>(async (): Promise<MemorySyncResult> => {
    events.push("sync");
    if (options.syncRejects === true) throw new Error("the mirror is unreachable");
    return { outcome: options.outcome ?? "synced", pushed: 0, rejected: 0, pulled: 0, skipped: 0 };
  });
  const renderIndex = mock<RenderFn>(async (): Promise<RenderedMemoryIndex> => {
    const call = events.filter((event) => event === "render").length;
    events.push("render");
    if (options.renderRejects === true) throw new Error("the mirror cannot be read");
    return { text: renderedText(options, call), omitted: 0 };
  });
  const unused = async (): Promise<never> => {
    throw new Error("the host does not read this in these tests");
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
  return { host, sync, renderIndex };
}

interface Fixture {
  readonly host: ChatHost;
  readonly events: string[];
  readonly logger: MockLogger;
  /** Every open request that was allowed to complete, in order. */
  readonly opens: OpenChatSessionRequest[];
  readonly memory?: FakeMemory;
  /** How many of the next opens reject, to drive the switch's rollback and openFresh paths. */
  failOpens(count: number): void;
  /**
   * Hold every session close on a gate, so a test can interleave another session
   * operation between an operation's prepare and the open that follows it.
   */
  blockClose(): { readonly entered: Promise<void>; readonly release: () => void };
}

const hosts: ChatHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});

interface FixtureOptions {
  readonly memory?: FakeMemoryOptions;
  /** Build resources without a memory host; `false` builds no resources at all. */
  readonly resources?: boolean;
}

function fixture(options: FixtureOptions = {}): Fixture {
  const events: string[] = [];
  const logger = makeLogger();
  const opens: OpenChatSessionRequest[] = [];
  let closeGate: Promise<void> = Promise.resolve();
  const enteredClose = Promise.withResolvers<void>();
  const memory = options.memory === undefined ? undefined : fakeMemory(events, options.memory);
  const catalog = buildResourceCatalog([]);
  const resources: ChatResources | undefined =
    options.resources === false
      ? undefined
      : {
          catalog,
          toolProviders: [],
          pluginHandlers: [],
          naxPlugins: [],
          teardown: async () => {},
          ...(memory !== undefined ? { memory: memory.host } : {}),
        };
  const session: AgentSession = {
    id: META.sessionId,
    backend: { kind: "native", capabilities: {} },
    lastTurn: undefined,
    async *send() {},
    answer: () => "unknown",
    cancel() {},
    close: async () => {
      enteredClose.resolve();
      await closeGate;
    },
  };
  const release = async (): Promise<void> => {};
  const storage = Object.assign(createChatStorage({ pid: process.pid, now: () => NOW, logger }), {
    acquireLock: async () => release,
    writeMeta: async () => {},
    readMeta: async () => META,
  });
  let failures = 0;
  const open = mock(async (request: OpenChatSessionRequest) => {
    events.push("open");
    if (failures > 0) {
      failures--;
      throw new Error("[chat] reopen failed");
    }
    opens.push(request);
    return {
      session,
      meta: {
        ...META,
        sessionId: request.resumeId ?? `session-${opens.length}`,
        mode: request.mode === "full" ? ("full" as const) : ("ask" as const),
        model: request.model ?? META.model,
      },
      release,
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
  });
  hosts.push(host);
  return {
    host,
    events,
    logger,
    opens,
    ...(memory !== undefined ? { memory } : {}),
    failOpens(count) {
      failures = count;
    },
    blockClose() {
      const gate = Promise.withResolvers<void>();
      closeGate = gate.promise;
      return { entered: enteredClose.promise, release: gate.resolve };
    },
  };
}

/** A fake host the fixture certainly built; the type keeps the call sites below terse. */
function memoryOf(f: Fixture): FakeMemory {
  if (f.memory === undefined) throw new Error("this fixture has no memory host");
  return f.memory;
}

function warnings(logger: MockLogger): readonly string[] {
  return logger.calls.filter((call) => call.level === "warn").map((call) => call.message);
}

describe("chat host memory on open", () => {
  test("AC-1 AC-2 start syncs the memory host exactly once, before the open", async () => {
    const f = fixture({ memory: {} });

    await f.host.start({ mode: "guarded", model: CHAT_MODEL });

    expect(memoryOf(f).sync).toHaveBeenCalledTimes(1);
    expect(f.events.indexOf("sync")).toBeGreaterThanOrEqual(0);
    expect(f.events.indexOf("sync")).toBeLessThan(f.events.indexOf("open"));
  });

  test("AC-3 start's open request carries the rendered index", async () => {
    const f = fixture({ memory: {} });

    await f.host.start({ mode: "guarded", model: CHAT_MODEL });

    expect(f.opens[0]?.memoryIndex).toBe(INDEX_TEXT);
  });

  test("AC-4 AC-5 resume syncs before its open, and that open carries the index", async () => {
    const f = fixture({ memory: {} });
    await f.host.start({ mode: "guarded", model: CHAT_MODEL });
    f.events.length = 0;
    memoryOf(f).sync.mockClear();

    await f.host.resume({ id: "prior" });

    expect(memoryOf(f).sync).toHaveBeenCalledTimes(1);
    expect(f.events.indexOf("sync")).toBeLessThan(f.events.indexOf("open"));
    expect(f.opens.at(-1)?.resumeId).toBe("prior");
    expect(f.opens.at(-1)?.memoryIndex).toBe(INDEX_TEXT);
  });

  test("AC-6 a mode switch's reopen carries the index", async () => {
    const f = fixture({ memory: {} });
    await f.host.start({ mode: "guarded", model: CHAT_MODEL });

    await f.host.switchTo({ mode: "full" });

    expect(f.opens.at(-1)?.mode).toBe("full");
    expect(f.opens.at(-1)?.memoryIndex).toBe(INDEX_TEXT);
  });

  test("AC-7 AC-8 a model switch opens a fresh session carrying the index, syncing once", async () => {
    const f = fixture({ memory: {} });
    await f.host.start({ mode: "guarded", model: CHAT_MODEL });
    memoryOf(f).sync.mockClear();
    // Both the target reopen and its rollback fail, which is what reaches openFresh.
    f.failOpens(2);

    await expect(f.host.switchTo({ model: OTHER_MODEL })).rejects.toThrow("reopen failed");

    expect(memoryOf(f).sync).toHaveBeenCalledTimes(1);
    expect(f.opens.at(-1)?.resumeId).toBeUndefined();
    expect(f.opens.at(-1)?.memoryIndex).toBe(INDEX_TEXT);
  });

  test("AC-9 clear passes the index to its open", async () => {
    const f = fixture({ memory: {} });
    await f.host.start({ mode: "guarded", model: CHAT_MODEL });

    await f.host.clear();

    expect(f.opens).toHaveLength(2);
    expect(f.opens.at(-1)?.resumeId).toBeUndefined();
    expect(f.opens.at(-1)?.memoryIndex).toBe(INDEX_TEXT);
  });

  test("AC-10 AC-11 a failing sync still opens with the rendered index and warns once", async () => {
    const f = fixture({ memory: { syncRejects: true } });

    await f.host.start({ mode: "guarded", model: CHAT_MODEL });

    expect(f.opens[0]?.memoryIndex).toBe(INDEX_TEXT);
    expect(warnings(f.logger)).toEqual(["memory sync failed"]);
    expect(f.logger.calls.find((call) => call.message === "memory sync failed")?.stage).toBe("chat");
  });

  test("AC-12 a sync that reports unreachable is not a throw and warns at all", async () => {
    const f = fixture({ memory: { outcome: "unreachable" } });

    await f.host.start({ mode: "guarded", model: CHAT_MODEL });

    expect(f.opens[0]?.memoryIndex).toBe(INDEX_TEXT);
    expect(warnings(f.logger)).toEqual([]);
  });

  test("AC-13 AC-14 a failing render opens with no index and warns once", async () => {
    const f = fixture({ memory: { renderRejects: true } });

    await f.host.start({ mode: "guarded", model: CHAT_MODEL });

    expect(f.opens[0]).not.toHaveProperty("memoryIndex");
    expect(warnings(f.logger)).toEqual(["memory index unavailable"]);
  });

  test("AC-15 a host whose resources carry no memory opens with no index", async () => {
    for (const f of [fixture(), fixture({ resources: false })]) {
      await f.host.start({ mode: "guarded", model: CHAT_MODEL });
      expect(f.opens[0]).not.toHaveProperty("memoryIndex");
    }
  });

  test("AC-17 host.memory is the resources' memory host, absent without one", () => {
    const withMemory = fixture({ memory: {} });
    expect(withMemory.host.memory).toBe(memoryOf(withMemory).host);
    expect(fixture().host.memory).toBeUndefined();
    expect(fixture({ resources: false }).host.memory).toBeUndefined();
  });

  test("F1 an open carries its own operation's snapshot, not one a concurrent operation prepared", async () => {
    const f = fixture({ memory: { texts: ["index-one", "index-two", "index-three"] } });
    await f.host.start({ mode: "guarded", model: CHAT_MODEL });
    // A switch prepares its own index, then spends its time retiring the previous session.
    const block = f.blockClose();
    const switching = f.host.switchTo({ mode: "full" });
    await block.entered;
    // A second start prepares index-three and opens while the switch is parked.
    const starting = f.host.start({ mode: "guarded", model: CHAT_MODEL });
    await waitForCondition(() => f.opens.length === 2);
    block.release();
    await Promise.all([switching, starting]);

    const reopened = f.opens.find((request) => request.resumeId !== undefined);
    expect(f.opens[0]?.memoryIndex).toBe("index-one");
    expect(f.opens[1]?.memoryIndex).toBe("index-three");
    expect(reopened?.memoryIndex).toBe("index-two");
  });
});

describe("createHostMemory", () => {
  test("current stays undefined until prepare stores an index", async () => {
    const memory = fakeMemory([]);
    const hostMemory = createHostMemory({ memory: memory.host, logger: makeLogger() });

    expect(hostMemory.current()).toBeUndefined();
    await hostMemory.prepare();
    expect(hostMemory.current()).toBe(INDEX_TEXT);
  });

  test("closeSync syncs once and resolves when the sync throws", async () => {
    const logger = makeLogger();
    const memory = fakeMemory([], { syncRejects: true });
    const hostMemory = createHostMemory({ memory: memory.host, logger });

    await expect(hostMemory.closeSync()).resolves.toBeUndefined();

    expect(memory.sync).toHaveBeenCalledTimes(1);
    expect(warnings(logger)).toEqual(["memory sync failed"]);
  });

  test("a host with no memory prepares nothing, closes with nothing and registers no handler", async () => {
    const hostMemory = createHostMemory({ logger: makeLogger() });

    await expect(hostMemory.prepare()).resolves.toBeUndefined();
    await expect(hostMemory.closeSync()).resolves.toBeUndefined();

    expect(hostMemory.current()).toBeUndefined();
    expect(hostMemory.handlers).toEqual([]);
  });
});

describe("chat host memory for subagents", () => {
  let harness: SubagentHostHarness | undefined;
  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  test("AC-16 a subagent session's instructions carry the index the parent session opened with", async () => {
    const memory = fakeMemory([]);
    harness = makeSubagentHostHarness({ agents: [makeAgentResource()], memory: memory.host });

    await harness.host.start({ mode: "guarded", model: CHAT_MODEL });
    await harness.host.send("go", () => {});

    expect(harness.nestedSessionOptions).toHaveLength(1);
    expect(harness.nestedSessionOptions[0]?.instructions).toContain(INDEX_TEXT);
  });

  test("F1 a resume of the open session prepares, but a subagent inherits the open's own snapshot", async () => {
    const memory = fakeMemory([], { texts: ["index-one", "index-two"] });
    harness = makeSubagentHostHarness({ agents: [makeAgentResource()], memory: memory.host });
    await harness.host.start({ mode: "guarded", model: CHAT_MODEL });
    // A resume of the session that is already open: it prepares, but reopens nothing.
    await harness.host.resume({ id: harness.host.current().sessionId });
    expect(memory.sync).toHaveBeenCalledTimes(2);

    await harness.host.send("go", () => {});

    expect(harness.nestedSessionOptions[0]?.instructions).toContain("index-one");
  });
});
