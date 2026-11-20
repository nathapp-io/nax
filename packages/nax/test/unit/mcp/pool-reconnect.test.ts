/**
 * US-001 (#3002): a run-scoped MCP connection whose stdio server exited is
 * evicted on the exit report, and the next use reconnects. `pool.test.ts` keeps
 * the connect, close and caching cases; this file covers the exit report alone.
 *
 * The faked connect seam, the test server and the event/connection projections
 * come from `test/helpers/mcp-pool-harness.ts`, which `pool-budget` and
 * `pool-retry` share.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  connectionAt,
  disconnectedEvents,
  fakeMcpConnect,
  MCP_CALL_OPTS,
  MCP_EXIT_REASON,
  MCP_TEST_SERVERS,
  makeFakeMcpConnection,
  restoreMcpConnectSeam,
  waitForAsyncCondition,
} from "@test/helpers";
import type { McpServerConfig } from "@/config";
import { connectMcpServer } from "@/mcp/client";
import { createMcpPool } from "@/mcp/pool";

afterEach(restoreMcpConnectSeam);

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
    fakeMcpConnect(() => shared);
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
    const harness = fakeMcpConnect();
    const pool = createMcpPool({ servers: MCP_TEST_SERVERS });
    await pool.listTools("memory", "/a");
    const first = connectionAt(harness, 1);
    first.exit(MCP_EXIT_REASON);
    await pool.call("memory", "/a", "t", {}, MCP_CALL_OPTS);
    expect(harness.configs.map((config) => config.cwd)).toEqual(["/a", "/a"]);
  });

  test("AC-3: the next call returns the reconnected connection's result", async () => {
    const harness = fakeMcpConnect();
    const pool = createMcpPool({ servers: MCP_TEST_SERVERS });
    await pool.listTools("memory", "/a");
    const first = connectionAt(harness, 1);
    first.exit(MCP_EXIT_REASON);
    const result = await pool.call("memory", "/a", "t", {}, MCP_CALL_OPTS);
    const second = connectionAt(harness, 2);
    // The fake's result text carries its own pid, so this can only come from the second connection.
    expect({ content: result.content, isError: result.isError }).toEqual({
      content: `ran t (pid ${second.connectPid})`,
      isError: false,
    });
  });

  test("AC-4: the exit records one disconnected event, reconnect true, redacted shape", async () => {
    const harness = fakeMcpConnect();
    const pool = createMcpPool({ servers: MCP_TEST_SERVERS });
    await pool.listTools("memory", "/a");
    const first = connectionAt(harness, 1);
    first.exit(MCP_EXIT_REASON);
    expect(disconnectedEvents(pool.events())).toEqual([
      { kind: "disconnected", serverId: "memory", workdir: "/a", reason: MCP_EXIT_REASON, reconnect: true },
    ]);
  });

  test("AC-5: the recorded reason is passed through redactMcpReason", async () => {
    const secretServers: Record<string, McpServerConfig> = {
      memory: { ...MCP_TEST_SERVERS.memory, headers: { Authorization: "Bearer tok123" } },
    };
    const harness = fakeMcpConnect();
    const pool = createMcpPool({ servers: secretServers });
    await pool.listTools("memory", "/a");
    const first = connectionAt(harness, 1);
    first.exit("rejected 401 for Bearer tok123");
    const reasons = disconnectedEvents(pool.events()).map((event) => event.reason);
    expect(reasons).toEqual(["rejected 401 for ***"]);
  });

  test("AC-6: the dead connection's close() is called exactly once", async () => {
    const harness = fakeMcpConnect();
    const pool = createMcpPool({ servers: MCP_TEST_SERVERS });
    await pool.listTools("memory", "/a");
    const first = connectionAt(harness, 1);
    first.exit(MCP_EXIT_REASON);
    await waitForAsyncCondition(
      async () => first.closeCount,
      (count) => count > 0,
    );
    expect(first.closeCount).toBe(1);
  });

  test("AC-7: the pid read at connect time is unregistered after the exit", async () => {
    const shared = makeFakeMcpConnection({ pid: 777 });
    fakeMcpConnect(() => shared);
    const pids = recordPids();
    const pool = createMcpPool({ servers: MCP_TEST_SERVERS, pidRegistry: pids.registry });
    await pool.listTools("memory", "/a");
    shared.exit(MCP_EXIT_REASON);
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

  test("AC-15: an exit while the pid registration is still pending still unregisters the spawned pid", async () => {
    const shared = makeFakeMcpConnection({ pid: 777 });
    fakeMcpConnect(() => shared);
    // `register` is held open, so the exit below lands while `open()` awaits it.
    const registered: number[] = [];
    const unregistered: number[] = [];
    const held = Promise.withResolvers<void>();
    const pool = createMcpPool({
      servers: MCP_TEST_SERVERS,
      pidRegistry: {
        register: async (pid) => {
          registered.push(pid);
          await held.promise;
        },
        unregister: async (pid) => void unregistered.push(pid),
      },
    });
    const opened = pool.listTools("memory", "/a");
    await waitForAsyncCondition(
      async () => registered,
      (pids) => pids.length > 0,
    );
    shared.exit(MCP_EXIT_REASON);
    // From here the live getter reads null, while 777 is still registered: the
    // pool must keep the pid it read when the spawn was reported.
    expect(shared.pid).toBeNull();
    held.resolve();
    await opened;
    await waitForAsyncCondition(
      async () => unregistered,
      (pids) => pids.length > 0,
    );
    expect({ registered, unregistered }).toEqual({ registered: [777], unregistered: [777] });
  });

  test("AC-8: a connection with no pid at connect time never unregisters", async () => {
    const shared = makeFakeMcpConnection({ pid: null });
    fakeMcpConnect(() => shared);
    const pids = recordPids();
    const pool = createMcpPool({ servers: MCP_TEST_SERVERS, pidRegistry: pids.registry });
    await pool.listTools("memory", "/a");
    shared.exit(MCP_EXIT_REASON);
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
    const harness = fakeMcpConnect((attempt) => (attempt === 1 ? shared : makeFakeMcpConnection()));
    const pids = recordPids({
      unregister: async () => {
        throw new Error("registry unavailable");
      },
    });
    const pool = createMcpPool({ servers: MCP_TEST_SERVERS, pidRegistry: pids.registry });
    await pool.listTools("memory", "/a");
    shared.exit(MCP_EXIT_REASON);
    const result = await pool.call("memory", "/a", "t", {}, MCP_CALL_OPTS);
    expect(harness.configs).toHaveLength(2);
    expect(result.isError).toBe(false);
  });

  test("AC-10: an exit on /a leaves the /b connection alone", async () => {
    const harness = fakeMcpConnect();
    const pool = createMcpPool({ servers: MCP_TEST_SERVERS });
    await pool.listTools("memory", "/a");
    await pool.listTools("memory", "/b");
    const first = connectionAt(harness, 1);
    const second = connectionAt(harness, 2);
    first.exit(MCP_EXIT_REASON);
    const result = await pool.call("memory", "/b", "t", {}, MCP_CALL_OPTS);
    // The /a exit was evicted (so this really exercised the new path) without
    // costing /b a second connect.
    expect(disconnectedEvents(pool.events()).map((event) => event.workdir)).toEqual(["/a"]);
    expect(harness.configs.map((config) => config.cwd)).toEqual(["/a", "/b"]);
    expect(result.content).toBe(`ran t (pid ${second.connectPid})`);
  });
});

describe("US-001 an exit reported from inside onClose", () => {
  test("AC-11: the key's events stay connected then disconnected", async () => {
    const shared = makeFakeMcpConnection({ exitOnListen: MCP_EXIT_REASON });
    fakeMcpConnect(() => shared);
    const pool = createMcpPool({ servers: MCP_TEST_SERVERS });
    await pool.listTools("memory", "/a");
    const keyEvents = pool.events().filter((event) => event.serverId === "memory" && event.workdir === "/a");
    expect(keyEvents.map((event) => event.kind)).toEqual(["connected", "disconnected"]);
  });

  test("AC-12: the synchronously evicted key reconnects on the next call", async () => {
    const harness = fakeMcpConnect((attempt) =>
      makeFakeMcpConnection({ exitOnListen: attempt === 1 ? MCP_EXIT_REASON : undefined }),
    );
    const pool = createMcpPool({ servers: MCP_TEST_SERVERS });
    // The listTools that owns the exit still resolves with the tools it listed.
    expect((await pool.listTools("memory", "/a")).map((tool) => tool.name)).toEqual(["t"]);
    const result = await pool.call("memory", "/a", "t", {}, MCP_CALL_OPTS);
    expect(harness.configs).toHaveLength(2);
    expect(result.isError).toBe(false);
  });
});

describe("US-001 repeated exit reports", () => {
  test("AC-13: a second report after the key reconnected is ignored", async () => {
    const first = makeFakeMcpConnection();
    const harness = fakeMcpConnect((attempt) => (attempt === 1 ? first : makeFakeMcpConnection()));
    const pool = createMcpPool({ servers: MCP_TEST_SERVERS });
    await pool.listTools("memory", "/a");
    first.exit(MCP_EXIT_REASON);
    await pool.call("memory", "/a", "t", {}, MCP_CALL_OPTS);
    // The shared layer reports once, but the pool must not depend on that.
    first.exit(MCP_EXIT_REASON);
    expect(disconnectedEvents(pool.events())).toHaveLength(1);
    expect(harness.configs).toHaveLength(2);
    // The live connection survived the repeat: a further call reuses it.
    await pool.call("memory", "/a", "t", {}, MCP_CALL_OPTS);
    expect(harness.configs).toHaveLength(2);
  });

  test("AC-14: a second report before any reconnect is ignored", async () => {
    const first = makeFakeMcpConnection();
    fakeMcpConnect(() => first);
    const pool = createMcpPool({ servers: MCP_TEST_SERVERS });
    await pool.listTools("memory", "/a");
    first.exit(MCP_EXIT_REASON);
    first.exit(MCP_EXIT_REASON);
    expect(disconnectedEvents(pool.events())).toHaveLength(1);
  });
});
