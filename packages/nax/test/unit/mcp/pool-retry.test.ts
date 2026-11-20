/**
 * US-003 (#3002): a call interrupted by its connection's exit is re-dispatched
 * ONCE through the pool. US-001 evicts an exited connection and US-002 bounds
 * the reconnects; this file covers what an interrupted `pool.call` does — it
 * retries through `entry()` (so it reconnects, or reads the pinned-unavailable
 * state) with the same tool, input and options, and never retries again.
 *
 * The setup follows `pool-reconnect.test.ts` / `pool-budget.test.ts`:
 * `_mcpClientDeps.connect` is faked and every case enters through
 * `createMcpPool(...).call`, so the real `connectMcpServer` adapter (and its
 * `onClose` forwarding, per-attempt `AbortSignal` and byte cap) sits on the
 * tested path. Exit/connect counts come from the faked seam; a call in flight is
 * held by the shared fake and interrupted by `exit()`, which notifies the pool
 * before it rejects the held call — the order `Protocol._onclose` uses.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ConnectMcpOptions, McpCallOptions, McpTransportConfig } from "@nathapp/nax-agent/mcp";
import {
  assertDefined,
  type FakeMcpConnection,
  type FakeMcpConnectionOptions,
  makeFakeMcpConnection,
  waitForAsyncCondition,
} from "@test/helpers";
import type { McpServerConfig } from "@/config";
import { _mcpClientDeps } from "@/mcp/client";
import { createMcpPool, MCP_MAX_RECONNECTS, type McpPool } from "@/mcp/pool";
import type { McpCallResult } from "@/mcp/types";

/** nax run only ever configures stdio servers; this is the variant the fake seam receives. */
type StdioConfig = Extract<McpTransportConfig, { kind: "stdio" }>;

const original = { ..._mcpClientDeps };
afterEach(() => Object.assign(_mcpClientDeps, original));

const servers: Record<string, McpServerConfig> = {
  memory: { command: "fake", args: [], env: {}, stages: ["*"], timeoutMs: 1000, enabled: true },
};

const EXIT_REASON = "the server process exited";
const CALL_OPTS = { timeoutMs: 1000, maxBytes: 1000 };
const PINNED = `MCP server "memory" is unavailable; its tools cannot be called for this hop.`;
const REJECTED_PREFIX = `MCP server "memory" is unavailable:`;

/** One call the adapter forwarded to a shared connection. */
interface Dispatch {
  readonly name: string;
  readonly input: unknown;
  readonly opts: McpCallOptions;
}

interface Harness {
  /** Every connection handed back, in attempt order. */
  readonly connections: FakeMcpConnection[];
  /** The config each attempt received; its length is the total connect count. */
  readonly configs: StdioConfig[];
  /** The calls each connection received, in attempt order. */
  readonly dispatches: Dispatch[][];
}

/** Records what the adapter forwards, without changing what the fake does with it. */
function recordDispatches(connection: FakeMcpConnection): Dispatch[] {
  const dispatches: Dispatch[] = [];
  const send = connection.call.bind(connection);
  connection.call = async (name, input, opts) => {
    dispatches.push({ name, input, opts });
    return send(name, input, opts);
  };
  return dispatches;
}

/**
 * Fakes the shared connect seam: each attempt records its config and hands back
 * the connection `make` names for that attempt — or rejects, as a connect whose
 * every attempt fails does.
 */
function fakeConnect(make: (attempt: number) => FakeMcpConnection = () => makeFakeMcpConnection()): Harness {
  const connections: FakeMcpConnection[] = [];
  const configs: StdioConfig[] = [];
  const dispatches: Dispatch[][] = [];
  Object.assign(_mcpClientDeps, {
    connect: async (config: StdioConfig, options: ConnectMcpOptions) => {
      configs.push(config);
      const connection = make(configs.length);
      connections.push(connection);
      dispatches.push(recordDispatches(connection));
      // The real layer reports the spawn once the stdio transport starts, before the handshake.
      if (connection.connectPid !== null) options.onSpawn?.(connection.connectPid);
      return connection;
    },
  });
  return { connections, configs, dispatches };
}

function connectionAt(harness: Harness, attempt: number): FakeMcpConnection {
  const connection = harness.connections[attempt - 1];
  assertDefined(connection, `connection ${attempt}`);
  return connection;
}

/** Waits until connection `attempt` has received `count` calls, never a fixed sleep. */
async function waitForDispatches(harness: Harness, attempt: number, count: number): Promise<void> {
  await waitForAsyncCondition(
    async () => harness.dispatches[attempt - 1]?.length ?? 0,
    (seen) => seen >= count,
  );
}

/** The result shape worth comparing: the fake's text carries its own pid. */
function outcome(result: McpCallResult): { content: string; isError: boolean } {
  return { content: result.content, isError: result.isError };
}

/**
 * Starts a call that the FIRST connection holds, waits until it is in flight,
 * then exits that connection — the interrupted-call shape every case starts from.
 */
async function interruptedFirstCall(input: Record<string, unknown> = { query: "needle" }): Promise<{
  harness: Harness;
  pool: McpPool;
  result: McpCallResult;
}> {
  // Attempt 1 holds calls so the exit can interrupt one; later attempts answer directly.
  const harness = fakeConnect((attempt) => makeFakeMcpConnection({ holdCalls: attempt === 1 }));
  const pool = createMcpPool({ servers });
  const pending = pool.call("memory", "/a", "t", input, CALL_OPTS);
  await waitForDispatches(harness, 1, 1);
  connectionAt(harness, 1).exit(EXIT_REASON);
  return { harness, pool, result: await pending };
}

describe("US-003 the interrupted call is retried once", () => {
  test("AC-1: a call rejected after its connection reported an exit returns the new connection's result", async () => {
    const { harness, result } = await interruptedFirstCall();
    expect(harness.configs).toHaveLength(2);
    expect(outcome(result)).toEqual({ content: `ran t (pid ${connectionAt(harness, 2).connectPid})`, isError: false });
  });

  test("AC-2: the retried call carries the same tool name and input to the new connection", async () => {
    const input = { query: "needle", limit: 3 };
    const { harness } = await interruptedFirstCall(input);
    const retried = harness.dispatches[1] ?? [];
    expect(retried.map((dispatch) => ({ name: dispatch.name, input: dispatch.input }))).toEqual([{ name: "t", input }]);
  });

  test("AC-3: the retried call carries the same timeoutMs and maxBytes, under a fresh deadline", async () => {
    const { harness } = await interruptedFirstCall();
    const first = harness.dispatches[0]?.[0];
    const retried = harness.dispatches[1]?.[0];
    assertDefined(first, "first dispatch");
    assertDefined(retried, "retried dispatch");
    const budget = (opts: McpCallOptions) => ({ timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes });
    expect(budget(retried.opts)).toEqual(CALL_OPTS);
    expect(budget(first.opts)).toEqual(CALL_OPTS);
    // The real adapter builds a fresh AbortSignal per dispatch, so the deadline
    // is the retried attempt's own rather than a reused, partly-spent one.
    expect(retried.opts.signal).not.toBe(first.opts.signal);
  });
});

describe("US-003 a retried call whose connection also exits", () => {
  test("AC-4: the call answers error-as-data with the unavailable detail", async () => {
    // Every connection holds, so the second exit can interrupt the retry too.
    const harness = fakeConnect(() => makeFakeMcpConnection({ holdCalls: true }));
    const pool = createMcpPool({ servers });
    const pending = pool.call("memory", "/a", "t", {}, CALL_OPTS);
    await waitForDispatches(harness, 1, 1);
    connectionAt(harness, 1).exit(EXIT_REASON);
    await waitForDispatches(harness, 2, 1);
    connectionAt(harness, 2).exit(EXIT_REASON);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content.startsWith(REJECTED_PREFIX)).toBe(true);
  });

  test("AC-5: the double exit costs exactly two connects and no third dispatch", async () => {
    const harness = fakeConnect(() => makeFakeMcpConnection({ holdCalls: true }));
    const pool = createMcpPool({ servers });
    const pending = pool.call("memory", "/a", "t", {}, CALL_OPTS);
    await waitForDispatches(harness, 1, 1);
    connectionAt(harness, 1).exit(EXIT_REASON);
    await waitForDispatches(harness, 2, 1);
    connectionAt(harness, 2).exit(EXIT_REASON);
    await pending;
    expect(harness.configs).toHaveLength(2);
    expect(harness.dispatches.map((calls) => calls.length)).toEqual([1, 1]);
  });
});

describe("US-003 failures the retry must not turn into another dispatch", () => {
  test("AC-6: a reconnect that fails every connect attempt answers pinned-unavailable", async () => {
    const harness = fakeConnect((attempt) => {
      if (attempt === 1) return makeFakeMcpConnection({ holdCalls: true });
      throw new Error("spawn ENOENT");
    });
    // No backoff: the attempt budget is what this test spends, not wall clock.
    const pool = createMcpPool({ servers, retry: { maxAttempts: 3, baseDelayMs: 0 } });
    const pending = pool.call("memory", "/a", "t", {}, CALL_OPTS);
    await waitForDispatches(harness, 1, 1);
    connectionAt(harness, 1).exit(EXIT_REASON);
    const result = await pending;
    // The interrupted call itself answers the pinned-unavailable result.
    expect(outcome(result)).toEqual({ content: PINNED, isError: true });
    expect(harness.configs).toHaveLength(4);
  });

  test("AC-7: a rejection on a connection that has not reported a close never retries", async () => {
    // The shared layer rejects a call without reporting an exit when the
    // transport fails but the connection is still considered open.
    const failing = Object.assign(makeFakeMcpConnection(), {
      call: async () => {
        throw new Error("EPIPE");
      },
    });
    const harness = fakeConnect(() => failing);
    const pool = createMcpPool({ servers });
    await pool.listTools("memory", "/a");
    const result = await pool.call("memory", "/a", "t", {}, CALL_OPTS);
    expect(result.isError).toBe(true);
    expect(result.content.startsWith(REJECTED_PREFIX)).toBe(true);
    expect(harness.configs).toHaveLength(1);
  });

  test("AC-12: after the failed reconnect the key stays cached, so a further call opens nothing", async () => {
    const harness = fakeConnect((attempt) => {
      if (attempt === 1) return makeFakeMcpConnection({ holdCalls: true });
      throw new Error("spawn ENOENT");
    });
    const pool = createMcpPool({ servers, retry: { maxAttempts: 3, baseDelayMs: 0 } });
    const pending = pool.call("memory", "/a", "t", {}, CALL_OPTS);
    await waitForDispatches(harness, 1, 1);
    connectionAt(harness, 1).exit(EXIT_REASON);
    // Premise: the interrupted call did spend the reconnect budget's 3 attempts.
    expect(outcome(await pending).content).toBe(PINNED);
    expect(harness.configs).toHaveLength(1 + 3);
    const further = await pool.call("memory", "/a", "t", {}, CALL_OPTS);
    expect(outcome(further)).toEqual({ content: PINNED, isError: true });
    expect(harness.configs).toHaveLength(4);
  });
});

describe("US-003 concurrent callers interrupted by one exit", () => {
  /** Two calls held in flight on the first connection, then interrupted by its exit. */
  async function interruptTwoCalls(): Promise<{ harness: Harness; results: McpCallResult[] }> {
    const first: FakeMcpConnectionOptions = { holdCalls: true };
    const harness = fakeConnect((attempt) => makeFakeMcpConnection(attempt === 1 ? first : {}));
    const pool = createMcpPool({ servers });
    await pool.listTools("memory", "/a");
    const pending = [pool.call("memory", "/a", "t", {}, CALL_OPTS), pool.call("memory", "/a", "t", {}, CALL_OPTS)];
    await waitForDispatches(harness, 1, 2);
    connectionAt(harness, 1).exit(EXIT_REASON);
    return { harness, results: await Promise.all(pending) };
  }

  test("AC-8: both in-flight calls return the replacement connection's result", async () => {
    const { harness, results } = await interruptTwoCalls();
    const replacement = connectionAt(harness, 2);
    const expected = { content: `ran t (pid ${replacement.connectPid})`, isError: false };
    expect(results.map(outcome)).toEqual([expected, expected]);
  });

  test("AC-9: the two retries share one reconnect", async () => {
    const { harness } = await interruptTwoCalls();
    // The memoized open promise gives both callers the same replacement.
    expect(harness.configs).toHaveLength(2);
    expect(harness.dispatches.map((calls) => calls.length)).toEqual([2, 2]);
  });
});

describe("US-003 an exit reported from inside onClose", () => {
  test("AC-10: the first call on the key still returns the second connection's result", async () => {
    const harness = fakeConnect((attempt) =>
      makeFakeMcpConnection({ exitOnListen: attempt === 1 ? EXIT_REASON : undefined }),
    );
    const pool = createMcpPool({ servers });
    // The exit is reported while `open` registers the listener, i.e. before the
    // entry resolves: the call it interrupted is the first one on the key.
    const result = await pool.call("memory", "/a", "t", {}, CALL_OPTS);
    expect(outcome(result)).toEqual({ content: `ran t (pid ${connectionAt(harness, 2).connectPid})`, isError: false });
  });
});

describe("US-003 an exit that exhausts the budget while a call is in flight", () => {
  test("AC-11: the interrupted call answers pinned-unavailable without a fourth connect", async () => {
    // Attempt 4 is flipped to holding AFTER the drive loop below has used it, so
    // the loop's own call returns while this test's call is held (§ FakeMcpConnectionOptions).
    const fourth: FakeMcpConnectionOptions = {};
    const harness = fakeConnect((attempt) => makeFakeMcpConnection(attempt === 4 ? fourth : {}));
    const pool = createMcpPool({ servers });
    await pool.listTools("memory", "/a");
    for (let index = 0; index < MCP_MAX_RECONNECTS; index++) {
      connectionAt(harness, index + 1).exit(EXIT_REASON);
      await pool.call("memory", "/a", "t", {}, CALL_OPTS);
    }
    expect(harness.configs).toHaveLength(1 + MCP_MAX_RECONNECTS);
    fourth.holdCalls = true;
    const pending = pool.call("memory", "/a", "t", {}, CALL_OPTS);
    await waitForDispatches(harness, 4, 2);
    // The fourth exit exhausts the budget, so `entry()` hands back the pinned state.
    connectionAt(harness, 4).exit(EXIT_REASON);
    expect(outcome(await pending)).toEqual({ content: PINNED, isError: true });
    expect(harness.configs).toHaveLength(1 + MCP_MAX_RECONNECTS);
  });
});
