/**
 * US-001 (#3002): a run-scoped MCP connection whose stdio server exited is
 * evicted on the exit report, and the next use reconnects. `pool.test.ts` keeps
 * the connect, close and caching cases; this file covers the exit report alone.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ConnectMcpOptions, McpTransportConfig } from "@nathapp/nax-agent/mcp";
import { assertDefined, type FakeMcpConnection, makeFakeMcpConnection, waitForAsyncCondition } from "@test/helpers";
import type { McpServerConfig } from "@/config";
import { _mcpClientDeps, connectMcpServer } from "@/mcp/client";
import { createMcpPool, type McpServerEvent } from "@/mcp/pool";

/** nax run only ever configures stdio servers; this is the variant the fake seam receives. */
type StdioConfig = Extract<McpTransportConfig, { kind: "stdio" }>;

const original = { ..._mcpClientDeps };
afterEach(() => Object.assign(_mcpClientDeps, original));

const servers: Record<string, McpServerConfig> = {
  memory: { command: "fake", args: [], env: {}, stages: ["*"], timeoutMs: 1000, enabled: true },
};

/**
 * Fakes the shared connect seam. Every call records its config and hands back a
 * fresh, independent connection — or the one `make` names for that attempt.
 */
function fakeConnect(make: (attempt: number) => FakeMcpConnection = () => makeFakeMcpConnection()) {
  const connections: FakeMcpConnection[] = [];
  const configs: StdioConfig[] = [];
  Object.assign(_mcpClientDeps, {
    connect: async (config: StdioConfig, options: ConnectMcpOptions) => {
      configs.push(config);
      const connection = make(configs.length);
      connections.push(connection);
      // The real layer reports the spawn once the stdio transport starts, before the handshake.
      if (connection.connectPid !== null) options.onSpawn?.(connection.connectPid);
      return connection;
    },
  });
  return { connections, configs };
}

const EXIT_REASON = "the server process exited";
const CALL_OPTS = { timeoutMs: 1000, maxBytes: 1000 };

type Disconnected = Extract<McpServerEvent, { kind: "disconnected" }>;

/** The `disconnected` events without their `at`, which no assertion can pin. */
function evictions(events: readonly McpServerEvent[]): Omit<Disconnected, "at">[] {
  return events
    .filter((event): event is Disconnected => event.kind === "disconnected")
    .map(({ kind, serverId, workdir, reason, reconnect }) => ({ kind, serverId, workdir, reason, reconnect }));
}

/** A PidRegistry that records what the pool registers and unregisters. */
function recordPids(over: { unregister?: (pid: number) => Promise<void> } = {}) {
  const registered: number[] = [];
  const unregistered: number[] = [];
  return {
    registered,
    unregistered,
    registry: {
      register: async (pid: number) => void registered.push(pid),
      unregister: over.unregister ?? (async (pid: number) => void unregistered.push(pid)),
    },
  };
}

describe("US-001 the adapter forwards the shared exit report", () => {
  test("AC-1: a listener passed to onClose hears the shared exit reason", async () => {
    const shared = makeFakeMcpConnection();
    fakeConnect(() => shared);
    const connection = await connectMcpServer({
      serverId: "memory",
      workdir: "/a",
      command: "fake",
      args: [],
      env: {},
      connectTimeoutMs: 1000,
    });
    const reasons: string[] = [];
    connection.onClose((reason) => reasons.push(reason));
    shared.exit("the server process exited");
    expect(reasons).toEqual(["the server process exited"]);
    await connection.close();
  });
});

describe("US-001 eviction on the exit report", () => {
  test("AC-2: the next call after an exit reconnects at the same workdir", async () => {
    const harness = fakeConnect();
    const pool = createMcpPool({ servers });
    await pool.listTools("memory", "/a");
    const [first] = harness.connections;
    assertDefined(first, "first connection");
    first.exit(EXIT_REASON);
    await pool.call("memory", "/a", "t", {}, CALL_OPTS);
    expect(harness.configs.map((config) => config.cwd)).toEqual(["/a", "/a"]);
  });

  test("AC-3: the next call returns the reconnected connection's result", async () => {
    const harness = fakeConnect();
    const pool = createMcpPool({ servers });
    await pool.listTools("memory", "/a");
    const [first] = harness.connections;
    assertDefined(first, "first connection");
    first.exit(EXIT_REASON);
    const result = await pool.call("memory", "/a", "t", {}, CALL_OPTS);
    const second = harness.connections[1];
    assertDefined(second, "second connection");
    // The fake's result text carries its own pid, so this can only come from the second connection.
    expect({ content: result.content, isError: result.isError }).toEqual({
      content: `ran t (pid ${second.connectPid})`,
      isError: false,
    });
  });

  test("AC-4: the exit records one disconnected event, reconnect true, redacted shape", async () => {
    const harness = fakeConnect();
    const pool = createMcpPool({ servers });
    await pool.listTools("memory", "/a");
    const [first] = harness.connections;
    assertDefined(first, "first connection");
    first.exit(EXIT_REASON);
    expect(evictions(pool.events())).toEqual([
      { kind: "disconnected", serverId: "memory", workdir: "/a", reason: EXIT_REASON, reconnect: true },
    ]);
  });

  test("AC-5: the recorded reason is passed through redactMcpReason", async () => {
    const secretServers: Record<string, McpServerConfig> = {
      memory: { ...servers.memory, headers: { Authorization: "Bearer tok123" } },
    };
    const harness = fakeConnect();
    const pool = createMcpPool({ servers: secretServers });
    await pool.listTools("memory", "/a");
    const [first] = harness.connections;
    assertDefined(first, "first connection");
    first.exit("rejected 401 for Bearer tok123");
    const reasons = evictions(pool.events()).map((event) => event.reason);
    expect(reasons).toEqual(["rejected 401 for ***"]);
  });

  test("AC-6: the dead connection's close() is called exactly once", async () => {
    const harness = fakeConnect();
    const pool = createMcpPool({ servers });
    await pool.listTools("memory", "/a");
    const [first] = harness.connections;
    assertDefined(first, "first connection");
    first.exit(EXIT_REASON);
    await waitForAsyncCondition(
      async () => first.closeCount,
      (count) => count > 0,
    );
    expect(first.closeCount).toBe(1);
  });

  test("AC-7: the pid read at connect time is unregistered after the exit", async () => {
    const shared = makeFakeMcpConnection({ pid: 777 });
    fakeConnect(() => shared);
    const pids = recordPids();
    const pool = createMcpPool({ servers, pidRegistry: pids.registry });
    await pool.listTools("memory", "/a");
    shared.exit(EXIT_REASON);
    // The live getter already reads null; the pool must remember the connect-time pid.
    expect(shared.pid).toBeNull();
    await waitForAsyncCondition(
      async () => pids.unregistered,
      (unregistered) => unregistered.length > 0,
    );
    expect({ registered: pids.registered, unregistered: pids.unregistered }).toEqual({
      registered: [777],
      unregistered: [777],
    });
  });

  test("AC-8: a connection with no pid at connect time never unregisters", async () => {
    const shared = makeFakeMcpConnection({ pid: null });
    fakeConnect(() => shared);
    const pids = recordPids();
    const pool = createMcpPool({ servers, pidRegistry: pids.registry });
    await pool.listTools("memory", "/a");
    shared.exit(EXIT_REASON);
    // `close()` is the other half of the same asynchronous cleanup: once it has
    // run, an unregister would already have happened.
    await waitForAsyncCondition(
      async () => shared.closeCount,
      (count) => count > 0,
    );
    expect(pids.unregistered).toEqual([]);
  });

  test("AC-9: a failing cleanup still evicts, so the next call reconnects", async () => {
    const shared = makeFakeMcpConnection({ pid: 900, closeRejects: true });
    const harness = fakeConnect((attempt) => (attempt === 1 ? shared : makeFakeMcpConnection()));
    const pids = recordPids({
      unregister: async () => {
        throw new Error("registry unavailable");
      },
    });
    const pool = createMcpPool({ servers, pidRegistry: pids.registry });
    await pool.listTools("memory", "/a");
    shared.exit(EXIT_REASON);
    const result = await pool.call("memory", "/a", "t", {}, CALL_OPTS);
    expect(harness.configs).toHaveLength(2);
    expect(result.isError).toBe(false);
  });

  test("AC-10: an exit on /a leaves the /b connection alone", async () => {
    const harness = fakeConnect();
    const pool = createMcpPool({ servers });
    await pool.listTools("memory", "/a");
    await pool.listTools("memory", "/b");
    const [first, second] = harness.connections;
    assertDefined(first, "first connection");
    assertDefined(second, "second connection");
    first.exit(EXIT_REASON);
    const result = await pool.call("memory", "/b", "t", {}, CALL_OPTS);
    // The /a exit was evicted (so this really exercised the new path) without
    // costing /b a second connect.
    expect(evictions(pool.events()).map((event) => event.workdir)).toEqual(["/a"]);
    expect(harness.configs.map((config) => config.cwd)).toEqual(["/a", "/b"]);
    expect(result.content).toBe(`ran t (pid ${second.connectPid})`);
  });
});

describe("US-001 an exit reported from inside onClose", () => {
  test("AC-11: the key's events stay connected then disconnected", async () => {
    const shared = makeFakeMcpConnection({ exitOnListen: EXIT_REASON });
    fakeConnect(() => shared);
    const pool = createMcpPool({ servers });
    await pool.listTools("memory", "/a");
    const keyEvents = pool.events().filter((event) => event.serverId === "memory" && event.workdir === "/a");
    expect(keyEvents.map((event) => event.kind)).toEqual(["connected", "disconnected"]);
  });

  test("AC-12: the synchronously evicted key reconnects on the next call", async () => {
    const harness = fakeConnect((attempt) =>
      makeFakeMcpConnection({ exitOnListen: attempt === 1 ? EXIT_REASON : undefined }),
    );
    const pool = createMcpPool({ servers });
    // The listTools that owns the exit still resolves with the tools it listed.
    expect((await pool.listTools("memory", "/a")).map((tool) => tool.name)).toEqual(["t"]);
    const result = await pool.call("memory", "/a", "t", {}, CALL_OPTS);
    expect(harness.configs).toHaveLength(2);
    expect(result.isError).toBe(false);
  });
});

describe("US-001 repeated exit reports", () => {
  test("AC-13: a second report after the key reconnected is ignored", async () => {
    const first = makeFakeMcpConnection();
    const harness = fakeConnect((attempt) => (attempt === 1 ? first : makeFakeMcpConnection()));
    const pool = createMcpPool({ servers });
    await pool.listTools("memory", "/a");
    first.exit(EXIT_REASON);
    await pool.call("memory", "/a", "t", {}, CALL_OPTS);
    // The shared layer reports once, but the pool must not depend on that.
    first.exit(EXIT_REASON);
    expect(evictions(pool.events())).toHaveLength(1);
    expect(harness.configs).toHaveLength(2);
    // The live connection survived the repeat: a further call reuses it.
    await pool.call("memory", "/a", "t", {}, CALL_OPTS);
    expect(harness.configs).toHaveLength(2);
  });

  test("AC-14: a second report before any reconnect is ignored", async () => {
    const first = makeFakeMcpConnection();
    fakeConnect(() => first);
    const pool = createMcpPool({ servers });
    await pool.listTools("memory", "/a");
    first.exit(EXIT_REASON);
    first.exit(EXIT_REASON);
    expect(evictions(pool.events())).toHaveLength(1);
  });
});
