/**
 * US-002 — an ambiguous MCP add is dispatched once.
 *
 * The defect: an `add` whose reply is lost (the server committed it and the connection went
 * before the answer) was dispatched a second time by the pool, and a later sync could send it
 * again from the outbox, so one note became two on the server.
 *
 * Every case here enters through the real composition — the memory host (or, for the deadline
 * case, the sync the host delegates to), the MCP memory provider, the run's MCP pool and
 * `connectMcpServer` — and fakes only the shared transport (`_mcpClientDeps.connect`). The
 * outbox is the one the mirror wrote to disk and the dispatch counts are what the fake server
 * actually received, so what is asserted is the path a session runs rather than a mock of the
 * provider.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createMemoryOutbox,
  createMemoryStore,
  type MemoryTimers,
  type MemoryWriteRequest,
  saveMemoryNote,
  syncMemory,
} from "@nathapp/nax-agent";
import { McpCallError, type McpCallResult, type McpToolInfo } from "@nathapp/nax-agent/mcp";
import {
  assertDefined,
  cleanupTempDir,
  fakeMcpConnect,
  type McpConnectHarness,
  type MockLogger,
  makeFakeMcpConnection,
  makeLogger,
  makeNaxConfig,
  makeTempDir,
  restoreMcpConnectSeam,
  waitForAsyncCondition,
} from "@test/helpers";
import type { McpServerConfig, NaxConfig } from "@/config";
import { createMcpPool } from "@/mcp";
import { createMemoryHost, type MemoryHost } from "@/memory";
import { _mcpIdMapDeps, createMcpIdMap, MCP_ID_MAP_FILE } from "@/memory/mcp-id-map";
import { type CreateMcpMemoryProviderInput, createMcpMemoryProvider } from "@/memory/mcp-provider";

/** The note every case writes. */
const SLUG = "replay-budget";
/** The configured memory server's two tools. */
const ADD = "add_memories";
const SEARCH = "search_memory";
/** The remote id an answering add reports. */
const REMOTE_ID = "r1";
/** The reason the shared layer reports for a stdio server whose process exited. */
const EXIT_REASON = "the server process exited";
/** The client id the fixture outbox entry is keyed by — also the mirror's note id. */
const CLIENT_ID = "c_save_replay_budget";
/** The memory block every case configures, as `memory.mcp`. */
const MCP_CONFIG = {
  server: "mem",
  tools: { add: ADD, search: SEARCH },
  args: { text: "text", query: "query" },
} as const;

/** The tool listing a connected memory server answers with. */
const TOOLS: readonly McpToolInfo[] = [
  { name: ADD, description: "add a memory", inputSchema: { type: "object" } },
  { name: SEARCH, description: "search memories", inputSchema: { type: "object" } },
];

/** What the fake server does with the calls it receives. */
interface ServerOptions {
  /** Apply the add, then lose the connection before answering: a reply lost after the write. */
  readonly loseReplyOnAdd?: boolean;
  /** Hold every add until `release()`, so a deadline can pass while the server still works. */
  readonly holdAdds?: boolean;
  /** Answer the add with an error, the shape a quota or a validation failure takes. */
  readonly errorOnAdd?: boolean;
  /** What an answering add says; the default names a remote id, `"ok"` names none. */
  readonly addAnswer?: string;
  /** The tool listing this connection offers; `[]` is a server that can take no call at all. */
  readonly tools?: readonly McpToolInfo[];
  /** Report an exit as soon as the pool listens, so the next call must open a new connection. */
  readonly exitOnListen?: string;
}

/** One fake memory server: what it received, what it applied, and how to let a held add go. */
interface FakeServer {
  readonly connection: ReturnType<typeof makeFakeMcpConnection>;
  /** Every tool call the server received, in order. */
  readonly dispatches: string[];
  /** The adds the server applied — the count that must never pass one. */
  readonly applied: number;
  /** Let a held add through: the server does its work after whatever deadline already passed. */
  release(): void;
}

/** The answer an add gives when it reports the remote copy it made. */
const ADD_ANSWER = JSON.stringify({ results: [{ id: REMOTE_ID, event: "ADD" }] });

/**
 * A memory server whose `call` this file drives.
 *
 * The fake connection supplies the lifecycle (`exit`, `onClose`, `close`) and the tool listing;
 * `call` is replaced here so a case can apply an add and then lose the connection before the
 * reply, or hold one past a deadline. `exit` is called BEFORE the rejection, in the order
 * `Protocol._onclose` uses, so the pool has already recorded the close when the call rejects.
 */
function fakeServer(options: ServerOptions = {}): FakeServer {
  const connection = makeFakeMcpConnection({
    tools: options.tools ?? TOOLS,
    ...(options.exitOnListen === undefined ? {} : { exitOnListen: options.exitOnListen }),
  });
  const dispatches: string[] = [];
  let applied = 0;
  const released = Promise.withResolvers<void>();
  connection.call = async (name: string): Promise<McpCallResult> => {
    dispatches.push(name);
    if (name === SEARCH) return { text: "[]", isError: false, bytesBeforeCap: 2 };
    if (options.loseReplyOnAdd === true) {
      applied += 1; // the server applied the add...
      connection.exit(EXIT_REASON); // ...and the connection went before the answer
      throw new McpCallError(`MCP call ${name} failed: the connection is closed`);
    }
    if (options.holdAdds === true) await released.promise;
    applied += 1;
    if (options.errorOnAdd === true) return { text: "quota exceeded", isError: true, bytesBeforeCap: 13 };
    const text = options.addAnswer ?? ADD_ANSWER;
    return { text, isError: false, bytesBeforeCap: text.length };
  };
  return {
    connection,
    dispatches,
    get applied() {
      return applied;
    },
    release: () => released.resolve(),
  };
}

/** The faked connect seam over `make`, with every server it built kept in attempt order. */
function connect(make: (attempt: number) => ServerOptions): { harness: McpConnectHarness; servers: FakeServer[] } {
  const servers: FakeServer[] = [];
  const harness = fakeMcpConnect((attempt) => {
    const server = fakeServer(make(attempt));
    servers.push(server);
    return server.connection;
  });
  return { harness, servers };
}

/** The server the `attempt`-th connection (1-based) reached. */
function serverAt(servers: readonly FakeServer[], attempt: number): FakeServer {
  const server = servers[attempt - 1];
  assertDefined(server, `server ${attempt}`);
  return server;
}

/** The `mcp.servers` entry the memory block names; the pool builds a real connection from it. */
function serverConfig(): McpServerConfig {
  return { command: "fake", args: [], env: {}, stages: ["*"], timeoutMs: 60_000, enabled: true };
}

/** A config whose memory provider is the MCP server above. */
function mcpConfig(): NaxConfig {
  return makeNaxConfig({
    memory: { provider: "mcp", mcp: MCP_CONFIG },
    mcp: { servers: { mem: serverConfig() } },
  });
}

/** The note a save writes: a body, a description and nothing else the store fills in. */
const NOTE_WRITE = {
  slug: SLUG,
  type: "project",
  scope: "project",
  description: "replay budget",
  body: "2048 MiB",
} as const;

/** The outbox request that note stages, for the cases that drive the drain directly. */
function requestOf(): MemoryWriteRequest {
  return {
    kind: "save",
    clientId: CLIENT_ID,
    scope: "project",
    slug: SLUG,
    writeMode: "direct",
    note: {
      id: CLIENT_ID,
      slug: SLUG,
      type: "project",
      scope: "project",
      description: "replay budget",
      source: "nax-chat",
      updatedAt: "2026-11-28T00:00:00.000Z",
      status: "active",
      body: "2048 MiB",
    },
  };
}

/**
 * The timers a sync races against, with only the drain's push deadline armed to fire at once.
 *
 * A sync arms its probe first (`providerAnswers`) and each push after it, so the second timer is
 * the push's: it loses immediately, while the probe and the pull are left to answer normally.
 */
function deadlineOnThePush(): MemoryTimers {
  let armed = 0;
  return {
    setTimeout: (callback) => {
      armed += 1;
      if (armed === 2) callback();
      return armed;
    },
    clearTimeout: () => undefined,
  };
}

/** A timer seam nothing fires on: every race is won by the work it races. */
function realDeadlines(): MemoryTimers {
  const armed = new Map<number, ReturnType<typeof globalThis.setTimeout>>();
  let next = 0;
  return {
    setTimeout: (callback) => {
      next += 1;
      armed.set(next, globalThis.setTimeout(callback, 60_000));
      return next;
    },
    clearTimeout: (id) => {
      if (typeof id !== "number") return;
      const handle = armed.get(id);
      if (handle === undefined) return;
      armed.delete(id);
      globalThis.clearTimeout(handle);
    },
  };
}

/** A filesystem failure with the code the id map reads. */
function fsError(code: string): Error {
  return Object.assign(new Error(`${code}: injected failure`), { code });
}

afterEach(restoreMcpConnectSeam);

describe("US-002 a save whose add commits and then loses its reply", () => {
  let repoRoot: string;
  let logger: MockLogger;
  let originalIdMapDeps: typeof _mcpIdMapDeps;

  /** A host over this test's repository: a fresh pool and connection, the mirror on disk. */
  async function open(): Promise<MemoryHost> {
    const host = await createMemoryHost({ config: mcpConfig(), repoRoot, source: "nax-chat", logger });
    assertDefined(host, "the memory host");
    return host;
  }

  /** The id-map file the mirror keeps beside its notes. */
  function idMapPath(host: MemoryHost): string {
    return join(host.dirs.projectDir, MCP_ID_MAP_FILE);
  }

  beforeEach(() => {
    repoRoot = makeTempDir("nax-mcp-uncertain-");
    logger = makeLogger();
    originalIdMapDeps = { ..._mcpIdMapDeps };
  });

  afterEach(() => {
    Object.assign(_mcpIdMapDeps, originalIdMapDeps);
    cleanupTempDir(repoRoot);
  });

  test("AC-1: the interrupted add is dispatched once and no second attempt is made", async () => {
    const { harness, servers } = connect((attempt) => (attempt === 1 ? { loseReplyOnAdd: true } : {}));
    const host = await open();

    const result = await host.save(NOTE_WRITE);

    // One dispatch on the connection that went, and none on any replacement.
    expect(serverAt(servers, 1).dispatches).toEqual([ADD]);
    expect(servers.slice(1).flatMap((server) => server.dispatches)).toEqual([]);
    // The pool reconnected nothing to re-send it: one connection was opened.
    expect(harness.configs).toHaveLength(1);
    expect(result.delivered).toBe(false);
    expect(result.pending?.delivery).toBe("unknown");
    await host.close?.();
  });

  test("AC-4: the ambiguous save records no remote id and no delivered mirror copy", async () => {
    connect((attempt) => (attempt === 1 ? { loseReplyOnAdd: true } : {}));
    const host = await open();

    const result = await host.save(NOTE_WRITE);

    const note = await host.getNote("project", SLUG);
    // The note is in the mirror under the id nax minted; no remote id was invented for it.
    assertDefined(note, "the staged note");
    expect(note.id).not.toBe(REMOTE_ID);
    // Nothing was filed as a remote copy, because the server never answered.
    expect(await Bun.file(idMapPath(host)).exists()).toBe(false);
    expect(result.delivered).toBe(false);
    expect(result.pending?.clientId).toBe(note.id);
    await host.close?.();
  });

  test("AC-7: an add the server answers with an error is held, not dispatched again", async () => {
    const { servers } = connect(() => ({ errorOnAdd: true }));
    const host = await open();

    const saved = await host.save(NOTE_WRITE);
    const pending = saved.pending;
    assertDefined(pending, "the uncertain entry");
    const sync = await host.sync();
    await host.close?.();

    // The dispatch left this process and the answer says nothing about whether it was applied:
    // a tool error is not proof of a definite unsent write, so the entry is held, not re-sent.
    expect(saved).toMatchObject({ slug: SLUG, delivered: false });
    expect(pending.delivery).toBe("unknown");
    expect(sync.pushed).toBe(0);
    expect(sync.uncertain?.map((entry) => entry.clientId)).toEqual([pending.clientId]);
    expect(serverAt(servers, 1).dispatches.filter((name) => name === ADD)).toHaveLength(1);
  });

  test("AC-3: reopening the outbox and syncing twice sends no second add for that entry", async () => {
    const { servers } = connect((attempt) => (attempt === 1 ? { loseReplyOnAdd: true } : {}));
    const first = await open();
    const saved = await first.save(NOTE_WRITE);
    const pending = saved.pending;
    assertDefined(pending, "the uncertain entry");
    await first.close?.();

    // A second host over the same mirror: a fresh pool, a fresh connection, the outbox on disk.
    const reopened = await open();
    const firstSync = await reopened.sync();
    const secondSync = await reopened.sync();
    await reopened.close?.();

    // The entry is still held, and every run names it: the operator's to requeue or discard.
    expect(firstSync.uncertain?.map((entry) => entry.clientId)).toEqual([pending.clientId]);
    expect(secondSync.uncertain?.map((entry) => entry.clientId)).toEqual([pending.clientId]);
    // Every connection opened after the reopen was asked to add nothing, on either run.
    expect(servers.slice(1).flatMap((server) => server.dispatches)).toEqual([]);
    expect(servers.slice(1).map((server) => server.applied)).toEqual([0]);
  });

  test("AC-9: an acknowledged add files the remote id apart from the local note id", async () => {
    connect(() => ({}));
    const host = await open();

    const result = await host.save(NOTE_WRITE);

    const note = await host.getNote("project", SLUG);
    assertDefined(note, "the staged note");
    expect(result.delivered).toBe(true);
    // Two identities: the mirror's note keeps nax's own, and the server's copy is filed apart.
    expect(note.id).not.toBe(REMOTE_ID);
    const file = (await Bun.file(idMapPath(host)).json()) as { notes: Record<string, string[]> };
    expect(file.notes[SLUG]).toEqual([REMOTE_ID]);
    await host.close?.();
  });

  test("AC-10: an ok add with no remote id is delivered, maps nothing and is never re-added", async () => {
    const { servers } = connect(() => ({ addAnswer: "ok" }));
    const host = await open();

    const result = await host.save(NOTE_WRITE);
    const firstSync = await host.sync();
    const secondSync = await host.sync();

    expect(result).toMatchObject({ slug: SLUG, delivered: true, status: "active" });
    expect(await Bun.file(idMapPath(host)).exists()).toBe(false);
    expect(firstSync.pushed).toBe(0);
    expect(secondSync.pushed).toBe(0);
    // One add: the save's own. Neither sync sent it again.
    expect(serverAt(servers, 1).dispatches.filter((name) => name === ADD)).toHaveLength(1);
    await host.close?.();
  });

  test("AC-11: an id-map write failure after the server's add is held, not added again", async () => {
    const { servers } = connect(() => ({}));
    _mcpIdMapDeps.writeText = async () => {
      throw fsError("EACCES");
    };
    const host = await open();

    const saved = await host.save(NOTE_WRITE);
    const pending = saved.pending;
    assertDefined(pending, "the uncertain entry");

    // The diagnostic survives: the id map is named, and the write is not reported delivered.
    expect(saved.delivered).toBe(false);
    expect(pending.delivery).toBe("unknown");
    expect(pending.reason).toContain("MCP id map");
    // The server did take the add, exactly once.
    expect(serverAt(servers, 1).dispatches.filter((name) => name === ADD)).toHaveLength(1);

    // With the id map writable again, the next syncs hold the entry rather than repeating the add.
    Object.assign(_mcpIdMapDeps, originalIdMapDeps);
    const firstSync = await host.sync();
    await host.sync();

    expect(firstSync.uncertain?.map((entry) => entry.clientId)).toEqual([pending.clientId]);
    expect(serverAt(servers, 1).dispatches.filter((name) => name === ADD)).toHaveLength(1);
    await host.close?.();
  });
});

describe("US-002 an add that outlives the drain's own deadline", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir("nax-mcp-slow-add-");
  });

  afterEach(() => cleanupTempDir(dir));

  test("AC-6: a slow add that commits after the deadline is not sent again", async () => {
    const logger = makeLogger();
    const projectDir = join(dir, "projects", "p-1");
    const userDir = join(dir, "user");
    const store = createMemoryStore({ projectDir, userDir, logger });
    const outbox = createMemoryOutbox({ dir: store.paths.outboxDir });
    const slow = fakeServer({ holdAdds: true });
    fakeMcpConnect(() => slow.connection);
    const pool = createMcpPool({ servers: { mem: serverConfig() } });
    const providerInput: CreateMcpMemoryProviderInput = {
      pool,
      serverId: "mem",
      workdir: "/repo",
      mcp: { ...MCP_CONFIG, tools: { ...MCP_CONFIG.tools }, args: { ...MCP_CONFIG.args } },
      idMap: createMcpIdMap({ dirs: { root: dir, projectDir, userDir }, server: "mem" }),
      logger,
      callTimeoutMs: 60_000,
    };
    const provider = createMcpMemoryProvider(providerInput);
    const request = requestOf();
    const staged = request.note;
    assertDefined(staged, "the staged note");
    await store.writeNote(staged);
    await outbox.enqueue(request);

    try {
      const timedOut = await syncMemory({ store, outbox, provider, logger, timers: deadlineOnThePush() });

      // The drain gave up on the dispatch while the server still had it: an unknown outcome.
      expect(timedOut.uncertain?.map((entry) => entry.clientId)).toEqual([CLIENT_ID]);
      expect(slow.dispatches).toEqual([ADD]);
      // The abandoned add then commits — the exact shape of a slow server.
      slow.release();
      await waitForAsyncCondition(
        async () => slow.applied,
        (applied) => applied === 1,
      );

      const after = await syncMemory({ store, outbox, provider, logger, timers: realDeadlines() });

      expect(after.pushed).toBe(0);
      expect(after.uncertain?.map((entry) => entry.clientId)).toEqual([CLIENT_ID]);
      // Still one dispatch: nothing re-sent an add the server may already hold.
      expect(slow.dispatches).toEqual([ADD]);
    } finally {
      await pool.close();
    }
  });
});

describe("US-001 B2 a save whose add was never dispatched", () => {
  let dir: string;
  let logger: MockLogger;

  /** The mirror, the outbox and a provider over the pool of whoever the seam builds next. */
  function parts(): {
    store: ReturnType<typeof createMemoryStore>;
    outbox: ReturnType<typeof createMemoryOutbox>;
    provider: (pool: ReturnType<typeof createMcpPool>) => ReturnType<typeof createMcpMemoryProvider>;
  } {
    const projectDir = join(dir, "projects", "p-1");
    const userDir = join(dir, "user");
    const store = createMemoryStore({ projectDir, userDir, logger });
    return {
      store,
      outbox: createMemoryOutbox({ dir: store.paths.outboxDir }),
      provider: (pool) =>
        createMcpMemoryProvider({
          pool,
          serverId: "mem",
          workdir: "/repo",
          mcp: { ...MCP_CONFIG, tools: { ...MCP_CONFIG.tools }, args: { ...MCP_CONFIG.args } },
          idMap: createMcpIdMap({ dirs: { root: dir, projectDir, userDir }, server: "mem" }),
          logger,
          callTimeoutMs: 60_000,
        }),
    };
  }

  beforeEach(() => {
    dir = makeTempDir("nax-mcp-undispatched-");
    logger = makeLogger();
  });

  afterEach(() => cleanupTempDir(dir));

  /**
   * One save through the production composition, over the connections `attempts` names.
   *
   * Everything above the shared transport is real: the MCP provider, the run's pool and the
   * immediate-save path in the operations layer. The seam decides what each connect attempt
   * finds, which is how a failure that precedes any dispatch is staged.
   */
  async function saveOver(
    attempts: (attempt: number) => FakeServer["connection"],
  ): Promise<{ saved: Awaited<ReturnType<typeof saveMemoryNote>> }> {
    const { store, outbox, provider } = parts();
    const first = fakeServer({ exitOnListen: EXIT_REASON });
    fakeMcpConnect((attempt) => (attempt === 1 ? first.connection : attempts(attempt)));
    const pool = createMcpPool({ servers: { mem: serverConfig() } });
    const staged = requestOf().note;
    assertDefined(staged, "the staged note");
    await store.writeNote(staged);
    try {
      const saved = await saveMemoryNote({
        store,
        outbox,
        provider: provider(pool),
        logger,
        write: NOTE_WRITE,
        writeMode: "direct",
        source: "nax-chat",
        timers: realDeadlines(),
      });
      // A definite unsent write: queued for the next sync, not held as an unknown delivery.
      expect(saved).toMatchObject({ slug: SLUG, delivered: false, pending: { delivery: "queued" } });
      expect(first.dispatches).toEqual([]);
      expect(await outbox.list()).toMatchObject([{ state: "queued" }]);
      return { saved };
    } finally {
      await pool.close();
    }
  }

  /** The next sync, over a working server: whatever the failure held back must be delivered. */
  async function recoveredSync(): Promise<{ pushed: number; dispatches: readonly string[] }> {
    const { store, outbox, provider } = parts();
    const recovered = fakeServer({});
    fakeMcpConnect(() => recovered.connection);
    const pool = createMcpPool({ servers: { mem: serverConfig() } });
    try {
      const run = await syncMemory({ store, outbox, provider: provider(pool), logger, timers: realDeadlines() });
      return { pushed: run.pushed, dispatches: recovered.dispatches };
    } finally {
      await pool.close();
    }
  }

  test("B2: a discovery failure after the probe answered leaves the write queued, and the next sync sends it", async () => {
    const { saved } = await saveOver(() => fakeServer({ tools: [] }).connection);

    expect(saved.pending?.delivery).toBe("queued");

    const run = await recoveredSync();

    expect(run).toMatchObject({ pushed: 1, dispatches: [ADD] });
  });

  test("B2: an add the pool never dispatched leaves the write queued, and the next sync sends it", async () => {
    // Attempt 2 answers the add's discovery and exits, attempt 3 cannot connect at all: the add
    // itself never finds a connection, and the probe before it had already succeeded.
    const { saved } = await saveOver((attempt) => {
      if (attempt === 2) return fakeServer({ exitOnListen: EXIT_REASON }).connection;
      throw new Error("connection refused");
    });

    expect(saved.pending?.delivery).toBe("queued");

    const run = await recoveredSync();

    expect(run).toMatchObject({ pushed: 1, dispatches: [ADD] });
  });
});

describe("US-002 B1 the operator's two ways out of an unknown delivery", () => {
  let repoRoot: string;
  let logger: MockLogger;

  /** A host over this test's repository: a fresh pool and connection, the mirror on disk. */
  async function open(): Promise<MemoryHost> {
    const host = await createMemoryHost({ config: mcpConfig(), repoRoot, source: "nax-chat", logger });
    assertDefined(host, "the memory host");
    return host;
  }

  /** One ambiguous save through the host, answering the client id its entry is held under. */
  async function ambiguousSave(): Promise<string> {
    const host = await open();
    const saved = await host.save(NOTE_WRITE);
    const pending = saved.pending;
    assertDefined(pending, "the uncertain entry");
    await host.close?.();
    return pending.clientId;
  }

  beforeEach(() => {
    repoRoot = makeTempDir("nax-mcp-recovery-");
    logger = makeLogger();
  });

  afterEach(() => cleanupTempDir(repoRoot));

  test("B1: an unacknowledged requeue leaves the entry held, and the acknowledged one sends it again", async () => {
    const { servers } = connect((attempt) => (attempt === 1 ? { loseReplyOnAdd: true } : {}));
    const clientId = await ambiguousSave();

    const host = await open();
    const refused = await host.requeue?.({ clientId });
    // The duplicate risk is the operator's to accept: nothing is sent on their behalf.
    expect(refused).toEqual({ moved: 0, heldBack: [clientId] });

    const accepted = await host.requeue?.({ clientId }, { allowDuplicate: true });
    const sync = await host.sync();
    await host.close?.();

    expect(accepted).toEqual({ moved: 1, heldBack: [] });
    expect(sync.pushed).toBe(1);
    // The acknowledged requeue is the second dispatch, on a fresh connection: exactly the
    // duplicate the operator agreed to, and none from the refused attempt before it.
    expect(servers.flatMap((server) => server.dispatches.filter((name) => name === ADD))).toHaveLength(2);
  });

  test("B1: discard drops the entry, so a later save of that note reaches the server again", async () => {
    const { servers } = connect((attempt) => (attempt === 1 ? { loseReplyOnAdd: true } : {}));
    const clientId = await ambiguousSave();

    const host = await open();
    const discarded = await host.discard?.({ clientId });
    const saved = await host.save(NOTE_WRITE);
    const again = await host.discard?.({ clientId });
    await host.close?.();

    expect(discarded).toEqual({ moved: 1, heldBack: [] });
    // Gone, so the next save of that note is dispatched rather than queued behind a write
    // nothing will ever send (the block the un-recoverable state left behind).
    expect(saved.delivered).toBe(true);
    expect(again).toEqual({ moved: 0, heldBack: [] });
    expect(servers.flatMap((server) => server.dispatches.filter((name) => name === ADD))).toHaveLength(2);
  });
});
