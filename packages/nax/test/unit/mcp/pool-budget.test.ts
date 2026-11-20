/**
 * US-002 (#3002): the reconnect budget. US-001 evicts an exited connection and
 * reconnects on the next use; this file bounds that — a key may connect
 * `1 + MCP_MAX_RECONNECTS` times per run, after which it is pinned to the
 * cached-unavailable state a failed connect leaves (spec R8) — and pins the
 * failures and shutdown edges that must never evict.
 *
 * The faked connect seam, the test server and the event/connection projections
 * come from `test/helpers/mcp-pool-harness.ts` (shared with `pool-reconnect` and
 * `pool-retry`); every case enters through `createMcpPool(...).call` /
 * `.listTools`, so the real `connectMcpServer` adapter and its `onClose`
 * forwarding sit on the path.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  disconnectedEvents,
  fakeMcpConnect,
  liveConnectionFor,
  MCP_CALL_OPTS,
  MCP_EXIT_REASON,
  MCP_TEST_SERVERS,
  type McpConnectHarness,
  makeFakeMcpConnection,
  restoreMcpConnectSeam,
  waitForAsyncCondition,
} from "@test/helpers";
import { createMcpPool, MCP_MAX_RECONNECTS, type McpPool, type McpServerEvent } from "@/mcp/pool";

afterEach(restoreMcpConnectSeam);

const UNAVAILABLE = `MCP server "memory" is unavailable; its tools cannot be called for this hop.`;

function reconnectFlagsOf(events: readonly McpServerEvent[], workdir: string): boolean[] {
  return disconnectedEvents(events)
    .filter((event) => event.workdir === workdir)
    .map((event) => event.reconnect);
}

/** Exit `exits` times, calling after each so the pool reconnects — or answers unavailable. */
async function driveExits(opts: {
  pool: McpPool;
  harness: McpConnectHarness;
  workdir: string;
  exits: number;
}): Promise<void> {
  for (let index = 0; index < opts.exits; index++) {
    liveConnectionFor(opts.harness, opts.workdir).exit(MCP_EXIT_REASON);
    await opts.pool.call("memory", opts.workdir, "t", {}, MCP_CALL_OPTS);
  }
}

describe("US-002 the reconnect budget", () => {
  test("AC-1: MCP_MAX_RECONNECTS is 3", () => {
    expect(MCP_MAX_RECONNECTS).toBe(3);
  });

  test("AC-2: the fourth exit on one key records disconnected with reconnect false", async () => {
    const harness = fakeMcpConnect();
    const pool = createMcpPool({ servers: MCP_TEST_SERVERS });
    await pool.listTools("memory", "/a");
    await driveExits({ pool, harness, workdir: "/a", exits: 4 });
    // The first three exits each buy one replacement; the fourth exhausts the budget.
    expect(reconnectFlagsOf(pool.events(), "/a")).toEqual([true, true, true, false]);
  });

  test("AC-3: a call after the budget is exhausted answers error-as-data", async () => {
    const harness = fakeMcpConnect();
    const pool = createMcpPool({ servers: MCP_TEST_SERVERS });
    await pool.listTools("memory", "/a");
    await driveExits({ pool, harness, workdir: "/a", exits: 4 });
    const result = await pool.call("memory", "/a", "t", {}, MCP_CALL_OPTS);
    expect({ content: result.content, isError: result.isError }).toEqual({ content: UNAVAILABLE, isError: true });
  });

  test("AC-4: the pinned key never opens another connection", async () => {
    const harness = fakeMcpConnect();
    const pool = createMcpPool({ servers: MCP_TEST_SERVERS });
    await pool.listTools("memory", "/a");
    await driveExits({ pool, harness, workdir: "/a", exits: 4 });
    // The first connection plus three replacements: 1 + MCP_MAX_RECONNECTS.
    expect(harness.configs).toHaveLength(4);
    await pool.call("memory", "/a", "t", {}, MCP_CALL_OPTS);
    await pool.call("memory", "/a", "t", {}, MCP_CALL_OPTS);
    expect(harness.configs).toHaveLength(4);
  });

  test("AC-5: pinning /a leaves /b free to reconnect", async () => {
    const harness = fakeMcpConnect();
    const pool = createMcpPool({ servers: MCP_TEST_SERVERS });
    await pool.listTools("memory", "/a");
    await pool.listTools("memory", "/b");
    await driveExits({ pool, harness, workdir: "/a", exits: 4 });
    liveConnectionFor(harness, "/b").exit(MCP_EXIT_REASON);
    const result = await pool.call("memory", "/b", "t", {}, MCP_CALL_OPTS);
    const replaced = liveConnectionFor(harness, "/b");
    // Each server/workdir has its own counter: /a is pinned, /b still got a fresh connection.
    expect({ flagsA: reconnectFlagsOf(pool.events(), "/a"), flagsB: reconnectFlagsOf(pool.events(), "/b") }).toEqual({
      flagsA: [true, true, true, false],
      flagsB: [true],
    });
    expect({ content: result.content, isError: result.isError }).toEqual({
      content: `ran t (pid ${replaced.connectPid})`,
      isError: false,
    });
  });
});

describe("US-002 failures that must not evict", () => {
  test("AC-6: a callTool rejection on a connection that has not reported a close never reconnects", async () => {
    // The shared layer rejects a call without reporting an exit when the
    // transport fails but the connection is still considered open.
    const failing = Object.assign(makeFakeMcpConnection(), {
      call: async () => {
        throw new Error("EPIPE");
      },
    });
    const harness = fakeMcpConnect(() => failing);
    const pool = createMcpPool({ servers: MCP_TEST_SERVERS });
    await pool.listTools("memory", "/a");
    const first = await pool.call("memory", "/a", "t", {}, MCP_CALL_OPTS);
    await pool.call("memory", "/a", "t", {}, MCP_CALL_OPTS);
    expect(first.isError).toBe(true);
    expect(harness.configs).toHaveLength(1);
    expect(disconnectedEvents(pool.events())).toEqual([]);
  });

  test("AC-7: the pool deadline result does not reconnect", async () => {
    const held = makeFakeMcpConnection({ holdCalls: true });
    const harness = fakeMcpConnect(() => held);
    const pool = createMcpPool({ servers: MCP_TEST_SERVERS });
    await pool.listTools("memory", "/a");
    const timedOut = await pool.call("memory", "/a", "t", {}, { timeoutMs: 20, maxBytes: 1000 });
    // The next call reuses the same connection; a deadline is a call's problem, not the key's.
    held.release();
    await pool.call("memory", "/a", "t", {}, MCP_CALL_OPTS);
    expect({ content: timedOut.content, isError: timedOut.isError }).toEqual({
      content: "MCP call memory__t exceeded 20ms",
      isError: true,
    });
    expect(harness.configs).toHaveLength(1);
  }, 10_000);

  test("AC-8: the pool deadline result records no disconnected event", async () => {
    const held = makeFakeMcpConnection({ holdCalls: true });
    fakeMcpConnect(() => held);
    const pool = createMcpPool({ servers: MCP_TEST_SERVERS });
    await pool.listTools("memory", "/a");
    await pool.call("memory", "/a", "t", {}, { timeoutMs: 20, maxBytes: 1000 });
    expect(disconnectedEvents(pool.events())).toEqual([]);
    held.release();
  }, 10_000);
});

describe("US-002 shutdown", () => {
  test("AC-9: an exit reported after pool.close() resolved records no disconnected event", async () => {
    const harness = fakeMcpConnect();
    const pool = createMcpPool({ servers: MCP_TEST_SERVERS });
    await pool.listTools("memory", "/a");
    const live = liveConnectionFor(harness, "/a");
    await pool.close();
    live.exit(MCP_EXIT_REASON);
    expect(disconnectedEvents(pool.events())).toEqual([]);
  });

  test("AC-10: an exit reported after pool.close() resolved does not connect again", async () => {
    const harness = fakeMcpConnect();
    const pool = createMcpPool({ servers: MCP_TEST_SERVERS });
    await pool.listTools("memory", "/a");
    const live = liveConnectionFor(harness, "/a");
    await pool.close();
    live.exit(MCP_EXIT_REASON);
    const result = await pool.call("memory", "/a", "t", {}, MCP_CALL_OPTS);
    expect(harness.configs).toHaveLength(1);
    expect(result).toMatchObject({ content: UNAVAILABLE, isError: true });
  });

  test("AC-11: close after one eviction and reconnect reaps the new connection exactly once", async () => {
    const harness = fakeMcpConnect();
    const pool = createMcpPool({ servers: MCP_TEST_SERVERS });
    await pool.listTools("memory", "/a");
    await driveExits({ pool, harness, workdir: "/a", exits: 1 });
    const replacement = liveConnectionFor(harness, "/a");
    await pool.close();
    expect(replacement.closeCount).toBe(1);
  });

  test("AC-12: close after one eviction and reconnect leaves the dead connection's close at 1", async () => {
    const harness = fakeMcpConnect();
    const pool = createMcpPool({ servers: MCP_TEST_SERVERS });
    await pool.listTools("memory", "/a");
    const dead = liveConnectionFor(harness, "/a");
    await driveExits({ pool, harness, workdir: "/a", exits: 1 });
    await waitForAsyncCondition(
      async () => dead.closeCount,
      (count) => count > 0,
    );
    await pool.close();
    expect(dead.closeCount).toBe(1);
  });
});
